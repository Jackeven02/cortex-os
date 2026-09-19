/**
 * cortex kernel — driver registry.
 *
 * The "+1" in docs/ARCHITECTURE.md §4: *"Ten kernel modules + one driver
 * registry. That is the whole v0 kernel."* This module loads, version-checks,
 * and routes to the three driver types (docs/ABI.md §7):
 *
 *   - `ILLMDriver`   — backs `llm_call`
 *   - `IToolDriver`  — backs `tool_call`
 *   - `IMemoryDriver`— backs `memory_read` / `memory_write`
 *
 * It is the piece that turns the syscall dispatcher's two injected resolver
 * hooks (`ResolveLLMHook`, `ResolveToolHook`) from placeholders into real
 * lookups. Until a registry is wired in, `llm_call` / `tool_call` trap
 * `EDRIVER` ("no resolver configured"); once it is, they resolve against
 * whatever drivers were registered at boot.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DESIGN NOTES (read before changing this file)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 1. NOT a syscall, NOT recorded. Driver registration happens at kernel boot
 *    (docs/ARCHITECTURE.md §6.1) and via the CLI at runtime — there is no
 *    calling process, hence no PID and no `.crec` context. Failures here throw
 *    a `CortexError` straight to the caller (boot / CLI), which decides how to
 *    surface them. This mirrors `MemoryManager.registerDriver`, which is also
 *    a non-recording configuration primitive. Recording driver load/unload as
 *    kernel-internal `__driver` events is a possible follow-up; v0 does not.
 *
 * 2. `registerTool` is async — a deliberate deviation from the synchronous
 *    `registerTool(driver): void` sketched in docs/ARCHITECTURE.md §4.11.
 *    §4.11 also says *"collisions trap EINVAL at registration time,"* and the
 *    only way to know a tool driver's tool names at registration is to call
 *    its async `listTools()`. So registration pre-fetches and caches the
 *    descriptors. That cache is what lets `resolveTool` stay SYNCHRONOUS, which
 *    the dispatcher's `ResolveToolHook` type requires. (doc-fix candidate:
 *    ARCHITECTURE §4.11 signature should read `Promise<void>`.)
 *
 * 3. Version check (docs/ABI.md §9.7). Every driver declares `abiCompat`
 *    (e.g. `'^1.0.0'`). On registration it is matched against the kernel's ABI
 *    version with a dependency-free semver subset (`satisfiesAbi` below). A
 *    mismatch — or an unparseable range — refuses registration with `EDRIVER`.
 *
 * 4. Collisions. Two drivers of the same type may not share a `name` (`EINVAL`).
 *    Two tool drivers may not both expose a tool of the same `name` (`EINVAL`),
 *    detected eagerly during `registerTool` via the descriptor cache.
 *    docs/ARCHITECTURE.md §11 predicted this would bite; we detect it at
 *    registration instead of letting load order silently decide.
 *
 * 5. Memory drivers are held here for version-checking, `listAll()`, and
 *    `closeAll()`. The `MemoryManager` keeps its OWN backing→driver map
 *    (it resolves by region `policy.backing`, not by a registry lookup), so at
 *    boot the runner copies registry memory drivers into the manager via
 *    `memoryDrivers()` + `MemoryManager.registerDriver`. That duplication is a
 *    documented v0 seam; unifying it is a follow-up. This module intentionally
 *    does NOT import `MemoryManager` — it stays dependency-light (types +
 *    errors only) so it can be unit-tested in isolation.
 *
 * 6. closeAll (docs/ARCHITECTURE.md §6.2): *"Drivers that throw during close
 *    are logged but do not block kernel shutdown."* Every driver's `close()` is
 *    awaited; a rejection is captured (and optionally forwarded to an
 *    `onCloseError` hook) but never rethrown. `closeAll` is idempotent and
 *    leaves the registry empty.
 *
 * Concurrency: single-threaded JS like every kernel module. `registerTool`
 * awaits `listTools()`; concurrent registrations of DIFFERENT tool drivers
 * could in principle interleave, so the collision check re-reads the cache
 * after the await and the cache write is the single commit point.
 *
 * See: docs/ARCHITECTURE.md §4.11, §6; docs/ABI.md §7, §9.7
 *
 * @module kernel/driver_registry
 */

import {
  type ILLMDriver,
  type IToolDriver,
  type IMemoryDriver,
  type ToolDescriptor,
} from './types.js';
import { isCortexError, trap } from './errors.js';
import {
  type ResolveLLMHook,
  type ResolveToolHook,
} from './syscall_dispatcher.js';

// =============================================================================
// §1. Semver subset (dependency-free)
// =============================================================================

/** A parsed release version. Prerelease/build metadata are ignored in v0. */
interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * Parse the numeric core of a semver string. Missing minor/patch default to 0
 * (`'1'` → `1.0.0`, `'1.2'` → `1.2.0`). Anything after `-` or `+` is dropped —
 * v0 does not implement prerelease precedence (docs/ABI.md §9.6 only promises
 * compatibility *within* a major version, and the kernel ABI has no prerelease
 * tags yet). Returns null if the string has no leading numeric component.
 */
export function parseSemver(version: string): SemVer | null {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version);
  if (m === null) return null;
  return {
    major: Number(m[1]),
    minor: m[2] === undefined ? 0 : Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
  };
}

/** Total order on release versions: -1 (a<b), 0 (a==b), 1 (a>b). */
function compareSemver(a: SemVer, b: SemVer): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

function gte(v: SemVer, floor: SemVer): boolean {
  return compareSemver(v, floor) >= 0;
}
function lt(v: SemVer, ceil: SemVer): boolean {
  return compareSemver(v, ceil) < 0;
}

/** One comparator: an operator applied to a parsed version. */
type Comparator = (v: SemVer) => boolean;

/**
 * Build the comparator for a single token like `^1.2.3`, `~1.2`, `>=1.0.0`,
 * `<2`, `=1.0.0`, or a bare `1.2.3`. Returns null if the token is unparseable.
 *
 * Caret (`^`) — compatible-within-major (npm semantics):
 *   `^1.2.3` → `>=1.2.3 <2.0.0`
 *   `^0.2.3` → `>=0.2.3 <0.3.0`   (0.x: minor is the breaking axis)
 *   `^0.0.3` → `>=0.0.3 <0.0.4`   (0.0.x: patch is the breaking axis)
 * Tilde (`~`) — compatible-within-minor:
 *   `~1.2.3` → `>=1.2.3 <1.3.0`
 */
function parseComparator(token: string): Comparator | null {
  const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token);
  if (m === null) return null;
  const op = m[1] ?? '=';
  const base = parseSemver(m[2] ?? '');
  if (base === null) return null;

  switch (op) {
    case '>=':
      return (v) => gte(v, base);
    case '>':
      return (v) => compareSemver(v, base) > 0;
    case '<=':
      return (v) => compareSemver(v, base) <= 0;
    case '<':
      return (v) => lt(v, base);
    case '=':
      return (v) => compareSemver(v, base) === 0;
    case '~':
      return (v) => gte(v, base) && lt(v, { major: base.major, minor: base.minor + 1, patch: 0 });
    case '^': {
      const ceil: SemVer =
        base.major > 0
          ? { major: base.major + 1, minor: 0, patch: 0 }
          : base.minor > 0
            ? { major: 0, minor: base.minor + 1, patch: 0 }
            : { major: 0, minor: 0, patch: base.patch + 1 };
      return (v) => gte(v, base) && lt(v, ceil);
    }
    default:
      return null;
  }
}

/**
 * Does `version` satisfy `range`?
 *
 * A minimal, dependency-free subset of node-semver sufficient for driver
 * `abiCompat` strings (docs/ABI.md §9.7):
 *   - `*`, `x`, `X`, or empty → matches anything
 *   - `||` → union (OR) of range sets
 *   - whitespace-separated comparators within a set → intersection (AND)
 *   - comparators: `^ ~ >= > <= < =` and bare versions
 *
 * Hyphen ranges (`1.0.0 - 2.0.0`) and prerelease tags are NOT supported in v0.
 * An unparseable range returns false (the caller turns that into `EDRIVER`).
 */
export function satisfiesAbi(version: string, range: string): boolean {
  const v = parseSemver(version);
  if (v === null) return false;

  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*' || trimmed.toLowerCase() === 'x') return true;

  for (const orGroup of trimmed.split('||')) {
    // Collapse a space that sits between a comparator operator and its
    // version (`>= 1.0.0` → `>=1.0.0`) BEFORE splitting on whitespace, so an
    // operator and its operand stay a single token. Without this, the standard
    // npm spelling `>= 1.0.0` would split into ['>=','1.0.0'] and be rejected.
    const normalized = orGroup.replace(/([<>~^]=?)\s+/g, '$1');
    const tokens = normalized.trim().split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) {
      // An empty OR group (`* || ...` edge) matches anything.
      return true;
    }
    let allMatch = true;
    for (const token of tokens) {
      if (token === '*' || token.toLowerCase() === 'x') continue;
      const cmp = parseComparator(token);
      if (cmp === null || !cmp(v)) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) return true;
  }
  return false;
}

// =============================================================================
// §2. Manifest shapes (listAll)
// =============================================================================

/** Summary of one registered LLM driver. */
export interface LLMDriverInfo {
  readonly name: string;
  readonly version: string;
  readonly abiCompat: string;
  readonly supportedModels: readonly string[];
  readonly isDefault: boolean;
  readonly streams: boolean;
  readonly countsTokens: boolean;
}

/** Summary of one registered tool driver and the tools it exposes. */
export interface ToolDriverInfo {
  readonly name: string;
  readonly version: string;
  readonly abiCompat: string;
  readonly tools: readonly string[];
  readonly forkable: boolean;
  readonly twoPhase: boolean;
}

/** Summary of one registered memory driver. */
export interface MemoryDriverInfo {
  readonly name: string;
  readonly version: string;
  readonly abiCompat: string;
  readonly isDefault: boolean;
}

/**
 * The full registry snapshot returned by `listAll()`. Used by `cortex drivers`
 * (BACKLOG #037) and by boot-time logging.
 */
export interface DriverManifest {
  readonly llm: readonly LLMDriverInfo[];
  readonly tools: readonly ToolDriverInfo[];
  readonly memory: readonly MemoryDriverInfo[];
}

// =============================================================================
// §3. Options
// =============================================================================

export interface DriverRegistryOptions {
  /**
   * The kernel ABI version every driver's `abiCompat` is matched against.
   * Required — normally `KERNEL_ABI_VERSION` from src/index.ts.
   */
  readonly kernelAbiVersion: string;

  /**
   * Name of the LLM driver used when a request omits `driver`. If absent, the
   * first LLM driver registered becomes the default (see `registerLLM`).
   */
  readonly defaultLLM?: string;

  /**
   * Optional name of a default memory driver. Memory resolution is normally by
   * explicit backing name, so this is informational unless a caller opts into
   * `resolveMemory(undefined)`.
   */
  readonly defaultMemory?: string;

  /**
   * Invoked for each driver whose `close()` rejects during `closeAll()` /
   * `unregister*()`. Per docs/ARCHITECTURE.md §6.2 these errors never abort
   * shutdown; the hook exists so the runner can log them.
   */
  readonly onCloseError?: (driverName: string, err: unknown) => void;
}

// =============================================================================
// §4. DriverRegistry
// =============================================================================

/**
 * Load, version-check, and route to drivers (docs/ARCHITECTURE.md §4.11).
 * One instance per kernel.
 */
export class DriverRegistry {
  readonly kernelAbiVersion: string;

  #llm = new Map<string, ILLMDriver>();
  #toolDrivers = new Map<string, IToolDriver>();
  #memory = new Map<string, IMemoryDriver>();

  /** tool name → owning driver name + cached descriptor. Filled by registerTool. */
  #tools = new Map<string, { readonly driverName: string; readonly descriptor: ToolDescriptor }>();

  #defaultLLM: string | null;
  #defaultMemory: string | null;
  #onCloseError: ((driverName: string, err: unknown) => void) | null;
  #closed = false;

  constructor(opts: DriverRegistryOptions) {
    if (typeof opts.kernelAbiVersion !== 'string' || opts.kernelAbiVersion.length === 0) {
      trap('EINVAL', 'driver_registry', {
        reason: 'kernelAbiVersion is required and must be a non-empty string',
      });
    }
    this.kernelAbiVersion = opts.kernelAbiVersion;
    this.#defaultLLM = opts.defaultLLM ?? null;
    this.#defaultMemory = opts.defaultMemory ?? null;
    this.#onCloseError = opts.onCloseError ?? null;
  }

  // ---------------------------------------------------------------------------
  // §4.1 Version gate
  // ---------------------------------------------------------------------------

  /**
   * Assert a driver's `abiCompat` range admits the kernel ABI version. Traps
   * `EDRIVER` on mismatch or an unparseable range (docs/ABI.md §9.7).
   */
  #checkAbi(kind: string, name: string, abiCompat: unknown): void {
    if (typeof abiCompat !== 'string' || abiCompat.length === 0) {
      trap('EDRIVER', 'driver_registry', {
        kind,
        driver: name,
        reason: 'driver declares no abiCompat range',
        kernelAbiVersion: this.kernelAbiVersion,
      });
    }
    if (!satisfiesAbi(this.kernelAbiVersion, abiCompat)) {
      trap('EDRIVER', 'driver_registry', {
        kind,
        driver: name,
        abiCompat,
        kernelAbiVersion: this.kernelAbiVersion,
        reason: 'driver abiCompat does not admit the kernel ABI version',
      });
    }
  }

  #assertOpen(syscall: string): void {
    if (this.#closed) {
      trap('EDRIVER', syscall, {
        reason: 'registry is closed; cannot register after closeAll()',
      });
    }
  }

  // ---------------------------------------------------------------------------
  // §4.2 Registration
  // ---------------------------------------------------------------------------

  /**
   * Register an LLM driver. Refuses a duplicate name (`EINVAL`) or an
   * incompatible `abiCompat` (`EDRIVER`). The first LLM driver registered
   * becomes the default when none was configured, so a single-driver kernel
   * needs no explicit default.
   */
  registerLLM(driver: ILLMDriver): void {
    this.#assertOpen('driver_registry.registerLLM');
    this.#checkAbi('llm', driver.name, driver.abiCompat);
    if (this.#llm.has(driver.name)) {
      trap('EINVAL', 'driver_registry.registerLLM', {
        driver: driver.name,
        reason: 'an LLM driver with this name is already registered',
      });
    }
    this.#llm.set(driver.name, driver);
    if (this.#defaultLLM === null) this.#defaultLLM = driver.name;
  }

  /**
   * Register a memory driver. Refuses a duplicate name (`EINVAL`) or an
   * incompatible `abiCompat` (`EDRIVER`). The first memory driver registered
   * becomes the default when none was configured.
   */
  registerMemory(driver: IMemoryDriver): void {
    this.#assertOpen('driver_registry.registerMemory');
    this.#checkAbi('memory', driver.name, driver.abiCompat);
    if (this.#memory.has(driver.name)) {
      trap('EINVAL', 'driver_registry.registerMemory', {
        driver: driver.name,
        reason: 'a memory driver with this name is already registered',
      });
    }
    this.#memory.set(driver.name, driver);
    if (this.#defaultMemory === null) this.#defaultMemory = driver.name;
  }

  /**
   * Register a tool driver: version-check, then pre-fetch and cache its tool
   * descriptors so `resolveTool` can stay synchronous. Refuses a duplicate
   * driver name (`EINVAL`), a tool name already provided by another driver
   * (`EINVAL`), a `listTools()` failure (`EDRIVER`), or an incompatible
   * `abiCompat` (`EDRIVER`).
   *
   * Async by necessity — see DESIGN NOTE 2.
   */
  async registerTool(driver: IToolDriver): Promise<void> {
    this.#assertOpen('driver_registry.registerTool');
    this.#checkAbi('tool', driver.name, driver.abiCompat);
    if (this.#toolDrivers.has(driver.name)) {
      trap('EINVAL', 'driver_registry.registerTool', {
        driver: driver.name,
        reason: 'a tool driver with this name is already registered',
      });
    }

    let descriptors: readonly ToolDescriptor[];
    try {
      descriptors = await driver.listTools();
    } catch (err) {
      if (isCortexError(err)) throw err;
      trap('EDRIVER', 'driver_registry.registerTool', {
        driver: driver.name,
        reason: 'listTools() failed during registration',
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    if (!Array.isArray(descriptors)) {
      trap('EDRIVER', 'driver_registry.registerTool', {
        driver: driver.name,
        reason: 'listTools() did not return an array of ToolDescriptor',
      });
    }

    // Validate + collision-check every descriptor BEFORE mutating any state, so
    // a partial failure leaves the registry unchanged (atomic registration).
    const staged: Array<[string, ToolDescriptor]> = [];
    for (const descriptor of descriptors) {
      if (
        descriptor === null ||
        typeof descriptor !== 'object' ||
        typeof descriptor.name !== 'string' ||
        descriptor.name.length === 0
      ) {
        trap('EDRIVER', 'driver_registry.registerTool', {
          driver: driver.name,
          reason: 'listTools() returned a malformed descriptor',
        });
      }
      if (this.#tools.has(descriptor.name)) {
        const owner = this.#tools.get(descriptor.name)?.driverName;
        trap('EINVAL', 'driver_registry.registerTool', {
          driver: driver.name,
          tool: descriptor.name,
          registeredBy: owner,
          reason: 'tool name is already provided by another registered driver',
        });
      }
      // Same driver listing the same tool twice is also a collision.
      if (staged.some(([n]) => n === descriptor.name)) {
        trap('EINVAL', 'driver_registry.registerTool', {
          driver: driver.name,
          tool: descriptor.name,
          reason: 'driver lists the same tool name twice',
        });
      }
      staged.push([descriptor.name, descriptor]);
    }

    // Commit point.
    this.#toolDrivers.set(driver.name, driver);
    for (const [toolName, descriptor] of staged) {
      this.#tools.set(toolName, { driverName: driver.name, descriptor });
    }
  }

  // ---------------------------------------------------------------------------
  // §4.3 Resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolve an LLM driver by name, or the default when `name` is undefined.
   * Traps `EDRIVER` if there is no such driver / no default. Synchronous, so it
   * satisfies the dispatcher's `ResolveLLMHook`.
   */
  resolveLLM(name?: string): ILLMDriver {
    const key = name ?? this.#defaultLLM;
    if (key === null || key === undefined) {
      trap('EDRIVER', 'llm_call', {
        reason: 'no LLM driver requested and no default registered',
      });
    }
    const driver = this.#llm.get(key);
    if (driver === undefined) {
      trap('EDRIVER', 'llm_call', {
        driver: key,
        reason: 'no such LLM driver registered',
        registered: [...this.#llm.keys()],
      });
    }
    return driver;
  }

  /** Non-throwing variant of `resolveLLM`. */
  tryResolveLLM(name?: string): ILLMDriver | undefined {
    const key = name ?? this.#defaultLLM;
    if (key === null || key === undefined) return undefined;
    return this.#llm.get(key);
  }

  /**
   * Resolve a tool by name to its owning driver + cached descriptor. Returns
   * undefined when no registered driver provides it (the dispatcher then traps
   * `ENOENT`). Synchronous, so it satisfies `ResolveToolHook`.
   */
  resolveTool(name: string): { readonly driver: IToolDriver; readonly descriptor: ToolDescriptor } | undefined {
    const entry = this.#tools.get(name);
    if (entry === undefined) return undefined;
    const driver = this.#toolDrivers.get(entry.driverName);
    if (driver === undefined) return undefined;
    return { driver, descriptor: entry.descriptor };
  }

  /**
   * Resolve a memory driver by backing name (or the default when omitted).
   * Traps `EDRIVER` if absent. The `MemoryManager` normally resolves backing
   * drivers from its own map; this is the registry-side view used at boot and
   * by `cortex drivers`.
   */
  resolveMemory(name?: string): IMemoryDriver {
    const key = name ?? this.#defaultMemory;
    if (key === null || key === undefined) {
      trap('EDRIVER', 'memory_read', {
        reason: 'no memory driver requested and no default registered',
      });
    }
    const driver = this.#memory.get(key);
    if (driver === undefined) {
      trap('EDRIVER', 'memory_read', {
        driver: key,
        reason: 'no such memory driver registered',
        registered: [...this.#memory.keys()],
      });
    }
    return driver;
  }

  /** Non-throwing variant of `resolveMemory`. */
  tryResolveMemory(name?: string): IMemoryDriver | undefined {
    const key = name ?? this.#defaultMemory;
    if (key === null || key === undefined) return undefined;
    return this.#memory.get(key);
  }

  // ---------------------------------------------------------------------------
  // §4.4 Resolver hooks (wire straight into SyscallDispatcher)
  // ---------------------------------------------------------------------------

  /** A `ResolveLLMHook` bound to this registry. */
  llmResolver(): ResolveLLMHook {
    return (name) => this.resolveLLM(name);
  }

  /** A `ResolveToolHook` bound to this registry. */
  toolResolver(): ResolveToolHook {
    return (name) => this.resolveTool(name);
  }

  // ---------------------------------------------------------------------------
  // §4.5 Defaults
  // ---------------------------------------------------------------------------

  /** Set (or clear, with null) the default LLM driver name. Traps `EINVAL` if the name is not registered. */
  setDefaultLLM(name: string | null): void {
    if (name !== null && !this.#llm.has(name)) {
      trap('EINVAL', 'driver_registry.setDefaultLLM', {
        driver: name,
        reason: 'cannot default to an unregistered LLM driver',
      });
    }
    this.#defaultLLM = name;
  }

  /** Set (or clear, with null) the default memory driver name. Traps `EINVAL` if the name is not registered. */
  setDefaultMemory(name: string | null): void {
    if (name !== null && !this.#memory.has(name)) {
      trap('EINVAL', 'driver_registry.setDefaultMemory', {
        driver: name,
        reason: 'cannot default to an unregistered memory driver',
      });
    }
    this.#defaultMemory = name;
  }

  /** The current default LLM driver name, or null. */
  get defaultLLM(): string | null {
    return this.#defaultLLM;
  }

  /** The current default memory driver name, or null. */
  get defaultMemory(): string | null {
    return this.#defaultMemory;
  }

  // ---------------------------------------------------------------------------
  // §4.6 Introspection
  // ---------------------------------------------------------------------------

  hasLLM(name: string): boolean {
    return this.#llm.has(name);
  }
  hasMemory(name: string): boolean {
    return this.#memory.has(name);
  }
  hasToolDriver(name: string): boolean {
    return this.#toolDrivers.has(name);
  }
  hasTool(toolName: string): boolean {
    return this.#tools.has(toolName);
  }

  llmNames(): readonly string[] {
    return [...this.#llm.keys()];
  }
  memoryNames(): readonly string[] {
    return [...this.#memory.keys()];
  }
  toolDriverNames(): readonly string[] {
    return [...this.#toolDrivers.keys()];
  }
  toolNames(): readonly string[] {
    return [...this.#tools.keys()];
  }

  /** All registered memory drivers, for copying into a `MemoryManager` at boot. */
  memoryDrivers(): readonly IMemoryDriver[] {
    return [...this.#memory.values()];
  }

  /** Build the manifest snapshot (docs/ARCHITECTURE.md §4.11 `listAll`). */
  listAll(): DriverManifest {
    const llm: LLMDriverInfo[] = [...this.#llm.values()].map((d) => ({
      name: d.name,
      version: d.version,
      abiCompat: d.abiCompat,
      supportedModels: [...d.supportedModels],
      isDefault: this.#defaultLLM === d.name,
      streams: typeof d.stream === 'function',
      countsTokens: typeof d.countTokens === 'function',
    }));
    const tools: ToolDriverInfo[] = [...this.#toolDrivers.values()].map((d) => ({
      name: d.name,
      version: d.version,
      abiCompat: d.abiCompat,
      tools: [...this.#tools.entries()]
        .filter(([, e]) => e.driverName === d.name)
        .map(([toolName]) => toolName),
      forkable: d.forkable === true,
      twoPhase: typeof d.stage === 'function' && typeof d.commit === 'function',
    }));
    const memory: MemoryDriverInfo[] = [...this.#memory.values()].map((d) => ({
      name: d.name,
      version: d.version,
      abiCompat: d.abiCompat,
      isDefault: this.#defaultMemory === d.name,
    }));
    return { llm, tools, memory };
  }

  // ---------------------------------------------------------------------------
  // §4.7 Unload + shutdown
  // ---------------------------------------------------------------------------

  /**
   * Close one driver, swallowing (but reporting) a rejection per
   * docs/ARCHITECTURE.md §6.2. Returns true if `close()` succeeded.
   */
  async #closeDriver(name: string, close: () => Promise<void>): Promise<boolean> {
    try {
      await close();
      return true;
    } catch (err) {
      if (this.#onCloseError !== null) this.#onCloseError(name, err);
      return false;
    }
  }

  /** Unregister + close a single LLM driver. Returns false if it was not registered. */
  async unregisterLLM(name: string): Promise<boolean> {
    const driver = this.#llm.get(name);
    if (driver === undefined) return false;
    this.#llm.delete(name);
    if (this.#defaultLLM === name) this.#defaultLLM = this.#llm.keys().next().value ?? null;
    await this.#closeDriver(name, () => driver.close());
    return true;
  }

  /** Unregister + close a single memory driver. Returns false if it was not registered. */
  async unregisterMemory(name: string): Promise<boolean> {
    const driver = this.#memory.get(name);
    if (driver === undefined) return false;
    this.#memory.delete(name);
    if (this.#defaultMemory === name) {
      this.#defaultMemory = this.#memory.keys().next().value ?? null;
    }
    await this.#closeDriver(name, () => driver.close());
    return true;
  }

  /**
   * Unregister + close a single tool driver, dropping its cached tool
   * descriptors. Returns false if it was not registered.
   */
  async unregisterTool(name: string): Promise<boolean> {
    const driver = this.#toolDrivers.get(name);
    if (driver === undefined) return false;
    this.#toolDrivers.delete(name);
    for (const [toolName, entry] of [...this.#tools.entries()]) {
      if (entry.driverName === name) this.#tools.delete(toolName);
    }
    await this.#closeDriver(name, () => driver.close());
    return true;
  }

  /**
   * Close every registered driver and empty the registry. Errors during close
   * are reported via `onCloseError` but never rethrown (docs/ARCHITECTURE.md
   * §6.2). Idempotent: a second call is a no-op. After this the registry is
   * closed — further `register*` calls trap `EDRIVER`.
   */
  async closeAll(): Promise<void> {
    if (this.#closed) return;
    const llm = [...this.#llm.values()];
    const tools = [...this.#toolDrivers.values()];
    const memory = [...this.#memory.values()];

    this.#llm.clear();
    this.#toolDrivers.clear();
    this.#memory.clear();
    this.#tools.clear();
    this.#defaultLLM = null;
    this.#defaultMemory = null;
    this.#closed = true;

    // Close sequentially so a misbehaving driver cannot interleave shutdown
    // logs; each is independently guarded by #closeDriver.
    for (const d of llm) await this.#closeDriver(d.name, () => d.close());
    for (const d of tools) await this.#closeDriver(d.name, () => d.close());
    for (const d of memory) await this.#closeDriver(d.name, () => d.close());
  }

  /** Whether `closeAll()` has run. */
  get closed(): boolean {
    return this.#closed;
  }
}
