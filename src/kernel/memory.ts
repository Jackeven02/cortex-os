/**
 * cortex kernel — virtual memory regions.
 *
 * Implements `memory_read` / `memory_write` per docs/ABI.md §4.4 and the
 * region model in docs/STATE.md §2.3 / docs/ARCHITECTURE.md §4.5. The
 * kernel does not store memory itself; it routes every read and write to
 * the configured `IMemoryDriver` and records what came back.
 *
 * ## Regions, bindings, and physical keys
 *
 * Each process has a set of *logical* regions (`'episodic'`, `'semantic'`,
 * `'procedural'`, …) declared at `spawn` (STATE.md §2.3). A logical region
 * is bound to a *physical* region key inside a driver. The physical key is
 * what actually determines sharing and isolation:
 *
 *   - `shared`  → deterministic key `sh:<backing>:<logical>`. Every process
 *     that attaches the same shared region on the same backing converges on
 *     the same physical key, so writes are visible to all of them. This is
 *     the whole point of `shared` (STATE.md §2.3, §8.1).
 *   - `private` → unique key `pr:<backing>:<uid>`. Owned by one process;
 *     `fork` deep-copies it (see below).
 *   - `cow`     → unique key at first attach, but `fork` makes the child
 *     point at the *parent's* physical key and bumps a refcount. The copy
 *     is deferred until the first write.
 *
 * The agent only ever names the logical region; the physical key is an
 * internal detail (exposed read-only via `MemoryRegionInfo.bindingKey` for
 * introspection and tests, explicitly unstable).
 *
 * ## Copy-on-write
 *
 * ARCHITECTURE.md §4.5: COW is implemented at the *region* granularity, not
 * per key. When a `cow` binding whose physical key has refcount > 1 is
 * written, the entire region is duplicated first:
 *
 *   1. `snapshotRegion(oldPhysical)` → blob
 *   2. `restoreRegion(newPhysical, blob)`
 *   3. refcount(old) -= 1; refcount(new) = 1
 *   4. rebind this process's logical region → newPhysical
 *   5. perform the write against newPhysical
 *
 * This is *symmetric*: whichever branch (parent or child) writes first pays
 * the copy and diverges; the other keeps the original. After the split both
 * have refcount 1, so subsequent writes go straight through.
 *
 * v0 simplification: while a `cow` region is still shared (refcount > 1),
 * reads see the *live* shared region. If branch A writes (triggering A's
 * divergence) branch B still reads the original — correct. But before any
 * write, both read the same live data. True page-level COW with freeze-at-
 * fork semantics is post-v0 (ARCHITECTURE.md §4.5 "Performance").
 *
 * ## fork
 *
 * `forkCopy(parent, child, overrides?)` materializes the child's bindings
 * from the parent's per STATE.md §2.3:
 *
 *   - `private` → deep copy (snapshot parent → restore into a fresh key).
 *   - `shared`  → same deterministic key; no copy. (If the parent's binding
 *                 was not already that shared key — e.g. an override changed
 *                 the kind — the parent's content is copied in once.)
 *   - `cow`     → child shares the parent's key, refcount += 1, copy
 *                 deferred to first write.
 *
 * `memoryOverrides` (ForkOptions.memoryOverrides, STATE.md §7) may change a
 * region's policy for the child. When an override changes the kind or
 * backing such that the child's physical key differs from the parent's and
 * the result is not a cow-share, the parent's content is deep-copied so the
 * child starts from the same data. Override semantics are best-effort in v0.
 *
 * ## Errors (docs/ABI.md §4.4)
 *
 *   - `ENOENT`  — no such region attached to this process.
 *   - `EPERM`   — `memory_write` on a `readOnly` region.
 *   - `ENOMEM`  — region entry-count limit exceeded (`maxRegionEntries`).
 *   - `EDRIVER` — backing driver missing, or the driver threw.
 *   - `ERECORD` — the `.crec` append itself failed.
 *
 * ## Recording
 *
 *   - `memory_read`:  args `{ region, query }`, result `{ count, valuesHash }`
 *     (full values would bloat the log — ABI.md §4.4), reversibility
 *     `idempotent`.
 *   - `memory_write`: args `{ region, key, policyKind, value | valueHash }`,
 *     reversibility `reversible` (every write is logged and can be undone
 *     from the log — ABI.md §4.4). Large values, or writes with
 *     `recordHashOnly`, log a hash + byte count instead of the value.
 *   - Errors: `phase: 'trap'` with errno/message/details.
 *
 * ## State enforcement
 *
 * memory.ts does NOT enforce the RUNNING-state requirement itself; that is
 * the syscall dispatcher's job (#014, ARCHITECTURE.md §4.10 step 3). Unlike
 * `recv`, a memory op has no structural need to park the process, so the
 * manager stays a pure pass-through and is testable without a state machine.
 *
 * See: docs/ABI.md §4.4, §7.3; docs/STATE.md §2.3, §5.2; docs/ARCHITECTURE.md §4.5
 *
 * @module kernel/memory
 */

import { createHash } from 'node:crypto';
import {
  type IMemoryDriver,
  type MemoryEntry,
  type MemoryQuery,
  type MemoryRegionPolicy,
  type MemoryWriteOptions,
  type ProcessId,
  type ProcessState,
  type Timestamp,
  unbrand,
} from './types.js';
import { CortexError, isCortexError, trap, wrapDriverError } from './errors.js';
import type { ProcessTable } from './process_table.js';
import type { SyscallRecordInput } from './recorder.js';

// =============================================================================
// §1. Constants
// =============================================================================

/**
 * Values whose UTF-8 serialization exceeds this many bytes are recorded as a
 * hash + byte count instead of inline (ABI.md §4.4 "or value hash if
 * large"). Override via `MemoryManagerOptions.largeValueBytes`.
 */
export const DEFAULT_LARGE_VALUE_BYTES = 1024;

/**
 * Default per-region entry-count ceiling. `-1` means unbounded. This is a
 * coarse v0 proxy for the `ENOMEM` "region size limit" in ABI.md §4.4 — we
 * count write operations against a physical region rather than tracking true
 * byte size, because the driver owns the actual storage layout.
 */
export const DEFAULT_MAX_REGION_ENTRIES = -1;

// =============================================================================
// §2. Physical key helpers
// =============================================================================

/** Deterministic physical key for a `shared` region. */
export function sharedPhysicalKey(backing: string, region: string): string {
  return `sh:${backing}:${region}`;
}

/** Prefix for owned (private / cow) physical keys. */
function ownedPhysicalPrefix(backing: string): string {
  return `pr:${backing}:`;
}

// =============================================================================
// §3. Value serialization / hashing
// =============================================================================

/**
 * Stable-ish JSON serialization for hashing and size accounting. Falls back
 * to `String(value)` for circular or otherwise unserializable values so a
 * weird payload can never crash a write.
 */
export function serializeValue(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? 'undefined' : s;
  } catch {
    return String(value);
  }
}

/** SHA-256 hex digest of a value's serialization. */
export function hashValue(value: unknown): string {
  return createHash('sha256').update(serializeValue(value), 'utf8').digest('hex');
}

/** UTF-8 byte length of a value's serialization. */
export function valueByteSize(value: unknown): number {
  return Buffer.byteLength(serializeValue(value), 'utf8');
}

// =============================================================================
// §4. Public introspection types
// =============================================================================

/**
 * Read-only snapshot of one region binding. `bindingKey` is the internal
 * physical key — exposed for introspection and tests, NOT a stable ABI
 * surface. Two processes "share" a region iff their `bindingKey` matches.
 */
export interface MemoryRegionInfo {
  readonly region: string;
  readonly kind: MemoryRegionPolicy['kind'];
  readonly backing: string;
  readonly readOnly: boolean;
  readonly bindingKey: string;
  /** Number of bindings currently pointing at this physical key. */
  readonly refCount: number;
  /** Approximate write count against this physical key (see §1). */
  readonly entryCount: number;
}

// =============================================================================
// §5. Internal binding
// =============================================================================

interface RegionBinding {
  policy: MemoryRegionPolicy;
  physical: string;
}

// =============================================================================
// §6. Manager options
// =============================================================================

export interface MemoryManagerOptions {
  readonly table: ProcessTable;
  /** Value written into every record's `kernelAbiVersion` field. */
  readonly kernelAbiVersion: string;
  /**
   * Backing drivers, keyed by driver name (`policy.backing`). May be a
   * `Record` or a `Map`. More drivers can be added later via
   * `registerDriver`.
   */
  readonly drivers?: Readonly<Record<string, IMemoryDriver>> | ReadonlyMap<string, IMemoryDriver>;
  /** Wall-clock source. Injectable for tests. */
  readonly now?: () => Timestamp;
  /** Monotonic counter for call IDs. Injectable for tests. */
  readonly nextCallId?: () => string;
  /** Per-region entry-count ceiling for `ENOMEM`. `-1` = unbounded. */
  readonly maxRegionEntries?: number;
  /** Values larger than this (bytes) are recorded as a hash. */
  readonly largeValueBytes?: number;
}

// =============================================================================
// §7. MemoryManager
// =============================================================================

/**
 * The virtual-memory engine. One per kernel.
 *
 * Concurrency model: single-threaded JS (ARCHITECTURE.md §9.1). The only
 * async work is driver I/O and recorder writes; both are awaited inline.
 * There is no internal locking — the dispatcher serializes syscalls.
 */
export class MemoryManager {
  readonly kernelAbiVersion: string;

  #table: ProcessTable;
  #now: () => Timestamp;
  #nextCallId: () => string;
  #maxRegionEntries: number;
  #largeValueBytes: number;

  #drivers = new Map<string, IMemoryDriver>();
  /** pid → (logical region → binding). */
  #bindings = new Map<number, Map<string, RegionBinding>>();
  /** physical key → number of bindings pointing at it. */
  #refCounts = new Map<string, number>();
  /** physical key → approximate write count (for ENOMEM). */
  #sizes = new Map<string, number>();
  #uid = 0;
  #callCounter = 0;

  constructor(opts: MemoryManagerOptions) {
    this.#table = opts.table;
    this.kernelAbiVersion = opts.kernelAbiVersion;
    this.#now = opts.now ?? (() => new Date().toISOString());
    this.#maxRegionEntries = opts.maxRegionEntries ?? DEFAULT_MAX_REGION_ENTRIES;
    this.#largeValueBytes = opts.largeValueBytes ?? DEFAULT_LARGE_VALUE_BYTES;
    this.#nextCallId =
      opts.nextCallId ??
      (() => {
        this.#callCounter++;
        return `mem-${this.#callCounter}`;
      });

    if (opts.drivers !== undefined) {
      const entries =
        opts.drivers instanceof Map
          ? opts.drivers.entries()
          : Object.entries(opts.drivers);
      for (const [name, driver] of entries) {
        this.#drivers.set(name, driver);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // §7.1 Driver registry
  // ---------------------------------------------------------------------------

  /** Register (or replace) a backing driver. */
  registerDriver(driver: IMemoryDriver): void {
    this.#drivers.set(driver.name, driver);
  }

  /** Whether a driver name is registered. */
  hasDriver(name: string): boolean {
    return this.#drivers.has(name);
  }

  /** Names of all registered drivers. */
  driverNames(): readonly string[] {
    return [...this.#drivers.keys()];
  }

  /**
   * The effective global per-region write-count ceiling (`-1` = unlimited).
   * Read-only introspection so a host or test can confirm a boot-configured
   * cap actually reached the manager.
   */
  get maxRegionEntries(): number {
    return this.#maxRegionEntries;
  }

  #driverFor(backing: string, syscall: string): IMemoryDriver {
    const driver = this.#drivers.get(backing);
    if (driver === undefined) {
      trap('EDRIVER', syscall, {
        driver: backing,
        reason: 'no such memory driver registered',
      });
    }
    return driver;
  }

  // ---------------------------------------------------------------------------
  // §7.2 Region lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Attach a logical region to a process. Idempotent on the logical name:
   * re-attaching replaces the binding (the old physical key's refcount is
   * released). The physical key is derived from the policy kind.
   */
  attachRegion(pid: ProcessId, region: string, policy: MemoryRegionPolicy): MemoryRegionInfo {
    const key = unbrand(pid);
    let map = this.#bindings.get(key);
    if (map === undefined) {
      map = new Map<string, RegionBinding>();
      this.#bindings.set(key, map);
    }

    // Release any prior binding for this logical name.
    const prev = map.get(region);
    if (prev !== undefined) this.#releaseRef(prev.physical);

    const physical =
      policy.kind === 'shared'
        ? sharedPhysicalKey(policy.backing, region)
        : this.#freshPhysical(policy.backing);

    map.set(region, { policy, physical });
    this.#bumpRef(physical);
    return this.#info(region, { policy, physical });
  }

  /**
   * Attach a whole policy map (e.g. the `memory` field of `SpawnOptions`).
   * Convenience for the dispatcher / init so spawn-time regions land in one
   * call.
   */
  attachAll(pid: ProcessId, policies: Readonly<Record<string, MemoryRegionPolicy>>): void {
    for (const [region, policy] of Object.entries(policies)) {
      this.attachRegion(pid, region, policy);
    }
  }

  /**
   * Pull the declared regions from the process table entry and attach any
   * that are not yet bound. The dispatcher calls this once after spawn so
   * the table's `memoryRegions` (set at allocate) becomes live bindings.
   */
  syncFromTable(pid: ProcessId): void {
    const entry = this.#table.get(pid);
    if (entry === undefined) return;
    for (const [region, policy] of entry.memoryRegions) {
      if (!this.hasRegion(pid, region)) this.attachRegion(pid, region, policy);
    }
  }

  /**
   * Detach a region. Releases the physical key's refcount; when it hits zero
   * the key's bookkeeping is dropped. v0 does NOT delete the underlying
   * driver data (a private region's bytes are simply orphaned) — driver-side
   * GC is post-v0. Idempotent: detaching an absent region is a no-op.
   */
  detachRegion(pid: ProcessId, region: string): void {
    const map = this.#bindings.get(unbrand(pid));
    if (map === undefined) return;
    const binding = map.get(region);
    if (binding === undefined) return;
    map.delete(region);
    this.#releaseRef(binding.physical);
  }

  /**
   * Release every region bound to a process. Called when a process is reaped or
   * killed so its bindings — and any COW/private physical keys it pinned — do
   * not leak for the life of the kernel (the intended long-running case).
   * Idempotent; safe for an unknown PID.
   */
  releaseProcess(pid: ProcessId): void {
    const map = this.#bindings.get(unbrand(pid));
    if (map === undefined) return;
    // Copy the names first: detachRegion mutates the map as it goes.
    for (const region of [...map.keys()]) {
      this.detachRegion(pid, region);
    }
    this.#bindings.delete(unbrand(pid));
  }

  /** Whether a logical region is attached to this process. */
  hasRegion(pid: ProcessId, region: string): boolean {
    return this.#bindings.get(unbrand(pid))?.has(region) ?? false;
  }

  /** Introspection snapshot of one region, or undefined if not attached. */
  regionInfo(pid: ProcessId, region: string): MemoryRegionInfo | undefined {
    const binding = this.#bindings.get(unbrand(pid))?.get(region);
    return binding === undefined ? undefined : this.#info(region, binding);
  }

  /** All regions attached to a process, in attach order. */
  regionsOf(pid: ProcessId): readonly MemoryRegionInfo[] {
    const map = this.#bindings.get(unbrand(pid));
    if (map === undefined) return [];
    return [...map.entries()].map(([region, binding]) => this.#info(region, binding));
  }

  #info(region: string, binding: RegionBinding): MemoryRegionInfo {
    return {
      region,
      kind: binding.policy.kind,
      backing: binding.policy.backing,
      readOnly: binding.policy.readOnly === true,
      bindingKey: binding.physical,
      refCount: this.#refCounts.get(binding.physical) ?? 0,
      entryCount: this.#sizes.get(binding.physical) ?? 0,
    };
  }

  #freshPhysical(backing: string): string {
    this.#uid++;
    return `${ownedPhysicalPrefix(backing)}${this.#uid}`;
  }

  #bumpRef(physical: string): void {
    this.#refCounts.set(physical, (this.#refCounts.get(physical) ?? 0) + 1);
  }

  #releaseRef(physical: string): void {
    const n = (this.#refCounts.get(physical) ?? 0) - 1;
    if (n <= 0) {
      this.#refCounts.delete(physical);
      this.#sizes.delete(physical);
    } else {
      this.#refCounts.set(physical, n);
    }
  }

  // ---------------------------------------------------------------------------
  // §7.3 read
  // ---------------------------------------------------------------------------

  /**
   * Read entries from a logical region. The driver is addressed by the
   * binding's physical key; returned entries have their `region` field
   * remapped to the logical name so agents never see internal keys.
   *
   * Traps `ENOENT` (no such region) or `EDRIVER` (missing/failing driver).
   */
  async read(
    pid: ProcessId,
    region: string,
    query: MemoryQuery,
  ): Promise<readonly MemoryEntry[]> {
    const callId = this.#nextCallId();

    let binding: RegionBinding;
    let driver: IMemoryDriver;
    try {
      binding = this.#mustBind(pid, region, 'memory_read');
      driver = this.#driverFor(binding.policy.backing, 'memory_read');
    } catch (err) {
      if (isCortexError(err)) {
        await this.#recordTrap(pid, 'memory_read', callId, err, { region });
      }
      throw err;
    }

    let raw: readonly MemoryEntry[];
    try {
      raw = await driver.read(binding.physical, query);
    } catch (err) {
      const wrapped = wrapDriverError('memory_read', binding.policy.backing, err);
      await this.#recordTrap(pid, 'memory_read', callId, wrapped, { region });
      throw wrapped;
    }

    // Remap physical region names back to the logical name the agent used.
    const entries = raw.map((e) => ({ ...e, region }));

    await this.#recordRead(pid, region, query, entries, callId);
    return entries;
  }

  // ---------------------------------------------------------------------------
  // §7.4 write
  // ---------------------------------------------------------------------------

  /**
   * Write a value to a logical region. Honors read-only (`EPERM`), the
   * entry-count ceiling (`ENOMEM`), and copy-on-write divergence for shared
   * `cow` regions.
   *
   * Traps `ENOENT`, `EPERM`, `ENOMEM`, or `EDRIVER`.
   */
  async write(
    pid: ProcessId,
    region: string,
    key: string,
    value: unknown,
    opts?: MemoryWriteOptions,
  ): Promise<void> {
    const callId = this.#nextCallId();

    let binding: RegionBinding;
    try {
      binding = this.#mustBind(pid, region, 'memory_write');
    } catch (err) {
      if (isCortexError(err)) {
        await this.#recordTrap(pid, 'memory_write', callId, err, { region, key });
      }
      throw err;
    }

    if (binding.policy.readOnly === true) {
      const err = new CortexError('EPERM', 'memory_write', {
        message: `region '${region}' is read-only`,
        details: { region },
      });
      await this.#recordTrap(pid, 'memory_write', callId, err, { region, key });
      throw err;
    }

    let driver: IMemoryDriver;
    try {
      driver = this.#driverFor(binding.policy.backing, 'memory_write');
    } catch (err) {
      if (isCortexError(err)) {
        await this.#recordTrap(pid, 'memory_write', callId, err, { region, key });
      }
      throw err;
    }

    try {
      // ENOMEM check (coarse entry-count proxy — see §1) runs BEFORE copy-on-
      // write divergence: a write that is going to be rejected must not pay
      // for — or leave behind — the COW split. #maybeCowDuplicate mutates
      // `binding.physical`, releases the shared refcount, and migrates the
      // size to the fresh key; doing that and *then* failing would break the
      // parent/child share even though no write ever landed. The entry-count
      // decision is identical either way, because the divergence copies the
      // size forward to the new key rather than resetting it.
      if (
        this.#maxRegionEntries >= 0 &&
        (this.#sizes.get(binding.physical) ?? 0) >= this.#maxRegionEntries
      ) {
        const err = new CortexError('ENOMEM', 'memory_write', {
          message: `region '${region}' exceeded entry limit ${this.#maxRegionEntries}`,
          details: { region, limit: this.#maxRegionEntries },
        });
        await this.#recordTrap(pid, 'memory_write', callId, err, { region, key });
        throw err;
      }

      // Copy-on-write divergence: a shared cow region must be duplicated
      // before this branch's first write mutates it.
      await this.#maybeCowDuplicate(pid, region, binding, driver);

      await driver.write(
        binding.physical,
        key,
        value,
        // exactOptionalPropertyTypes: only forward opts when present.
        ...(opts !== undefined ? [opts] : []),
      );
      this.#sizes.set(binding.physical, (this.#sizes.get(binding.physical) ?? 0) + 1);
    } catch (err) {
      if (isCortexError(err)) throw err; // already recorded above
      const wrapped = wrapDriverError('memory_write', binding.policy.backing, err);
      await this.#recordTrap(pid, 'memory_write', callId, wrapped, { region, key });
      throw wrapped;
    }

    await this.#recordWrite(pid, region, key, value, binding.policy, opts, callId);
  }

  /**
   * If `binding` is a `cow` region shared with another branch (refcount > 1),
   * duplicate it into a fresh physical key and rebind, so this write does not
   * mutate the sibling. Symmetric: either branch's first write triggers it.
   */
  async #maybeCowDuplicate(
    pid: ProcessId,
    region: string,
    binding: RegionBinding,
    driver: IMemoryDriver,
  ): Promise<void> {
    if (binding.policy.kind !== 'cow') return;
    if ((this.#refCounts.get(binding.physical) ?? 0) <= 1) return;

    const oldPhysical = binding.physical;
    const newPhysical = this.#freshPhysical(binding.policy.backing);

    const blob = await driver.snapshotRegion(oldPhysical);
    await driver.restoreRegion(newPhysical, blob);

    // Move this binding to the fresh key; release the shared one.
    this.#releaseRef(oldPhysical);
    binding.physical = newPhysical;
    this.#bumpRef(newPhysical);
    // Carry the approximate size so the ENOMEM accounting survives the split.
    this.#sizes.set(newPhysical, this.#sizes.get(oldPhysical) ?? 0);

    const map = this.#bindings.get(unbrand(pid));
    if (map !== undefined) map.set(region, binding);
  }

  #mustBind(pid: ProcessId, region: string, syscall: string): RegionBinding {
    const binding = this.#bindings.get(unbrand(pid))?.get(region);
    if (binding === undefined) {
      trap('ENOENT', syscall, { region, pid: unbrand(pid) }, `no such memory region '${region}'`);
    }
    return binding;
  }

  // ---------------------------------------------------------------------------
  // §7.5 snapshot / restore (checkpoint support — ARCHITECTURE.md §4.6)
  // ---------------------------------------------------------------------------

  /**
   * Snapshot every region of a process into logical-name → blob. Used by
   * `checkpoint.ts` (#017). Each blob is the driver's own serialization of
   * that physical region; the kernel does not interpret it.
   */
  async snapshot(pid: ProcessId): Promise<Record<string, Uint8Array>> {
    const map = this.#bindings.get(unbrand(pid));
    const out: Record<string, Uint8Array> = {};
    if (map === undefined) return out;

    for (const [region, binding] of map) {
      const driver = this.#driverFor(binding.policy.backing, 'snapshot');
      out[region] = await driver.snapshotRegion(binding.physical);
    }
    return out;
  }

  /**
   * Restore region blobs onto a process. Bindings must already exist (the
   * restore path attaches policies first, then calls this — ARCHITECTURE.md
   * §4.6 "Restore path"). A blob with no matching binding traps `ENOENT`.
   */
  async restore(pid: ProcessId, blobs: Readonly<Record<string, Uint8Array>>): Promise<void> {
    for (const [region, blob] of Object.entries(blobs)) {
      const binding = this.#mustBind(pid, region, 'restore');
      const driver = this.#driverFor(binding.policy.backing, 'restore');
      await driver.restoreRegion(binding.physical, blob);
      // Restore overwrites content; reset the coarse size proxy to unknown.
      this.#sizes.delete(binding.physical);
    }
  }

  /**
   * Kernel-internal bulk read of every attached region, returned as flat
   * `MemoryEntry[]` with logical region names. Used by `checkpoint.ts` to
   * build a `MemoryDelta`.
   *
   * Unlike `read()`, this writes NO syscall records and does not advance the
   * `.crec` log — a checkpoint must capture the log offset as it stands, not
   * one perturbed by the act of snapshotting. Traps `EDRIVER` on failure.
   */
  async dumpEntries(pid: ProcessId): Promise<readonly MemoryEntry[]> {
    const map = this.#bindings.get(unbrand(pid));
    if (map === undefined) return [];
    const out: MemoryEntry[] = [];
    for (const [region, binding] of map) {
      const driver = this.#driverFor(binding.policy.backing, 'dumpEntries');
      const raw = await driver.read(binding.physical, {});
      for (const e of raw) out.push({ ...e, region });
    }
    return out;
  }

  /**
   * Kernel-internal bulk write of entries back into their regions. Used by
   * `checkpoint.ts` on the restore path. Regions must already be attached
   * (the restore path attaches policies first); an entry naming an unknown
   * region traps `ENOENT`.
   *
   * Like `dumpEntries`, this writes NO syscall records — the restored
   * process's fresh log should start clean, not pre-populated with the
   * replayed writes. Traps `ENOENT` / `EDRIVER` on failure.
   */
  async loadEntries(pid: ProcessId, entries: readonly MemoryEntry[]): Promise<void> {
    for (const entry of entries) {
      const binding = this.#mustBind(pid, entry.region, 'loadEntries');
      const driver = this.#driverFor(binding.policy.backing, 'loadEntries');
      await driver.write(binding.physical, entry.key, entry.value);
      this.#sizes.set(binding.physical, (this.#sizes.get(binding.physical) ?? 0) + 1);
    }
  }

  // ---------------------------------------------------------------------------
  // §7.6 fork (STATE.md §2.3, §3.1 — driven by fork.ts #020)
  // ---------------------------------------------------------------------------

  /**
   * Materialize the child's region bindings from the parent's, applying the
   * copy semantics of each region's kind. See the module header `## fork`
   * for the full rules. Returns the child's region infos.
   */
  async forkCopy(
    parentPid: ProcessId,
    childPid: ProcessId,
    overrides?: Partial<Record<string, MemoryRegionPolicy>>,
  ): Promise<readonly MemoryRegionInfo[]> {
    const parentMap = this.#bindings.get(unbrand(parentPid));
    const childKey = unbrand(childPid);
    let childMap = this.#bindings.get(childKey);
    if (childMap === undefined) {
      childMap = new Map<string, RegionBinding>();
      this.#bindings.set(childKey, childMap);
    }
    if (parentMap === undefined) return [];

    for (const [region, pb] of parentMap) {
      const policy = overrides?.[region] ?? pb.policy;
      const backing = policy.backing;
      const driver = this.#driverFor(backing, 'fork');

      let childPhysical: string;
      let copy: boolean;

      if (policy.kind === 'cow' && pb.policy.kind === 'cow' && backing === pb.policy.backing) {
        // True COW share: child points at the parent's key, copy deferred.
        childPhysical = pb.physical;
        copy = false;
        this.#bumpRef(childPhysical);
      } else if (policy.kind === 'shared') {
        childPhysical = sharedPhysicalKey(backing, region);
        // No copy if the parent already lived on this exact shared key;
        // otherwise seed the shared region from the parent's content once.
        copy = childPhysical !== pb.physical;
        this.#bumpRef(childPhysical);
      } else {
        // private, or an override changed kind/backing: deep copy into a
        // fresh, solely-owned key.
        childPhysical = this.#freshPhysical(backing);
        copy = true;
        this.#bumpRef(childPhysical);
      }

      if (copy) {
        const blob = await driver.snapshotRegion(pb.physical);
        await driver.restoreRegion(childPhysical, blob);
        this.#sizes.set(childPhysical, this.#sizes.get(pb.physical) ?? 0);
      }

      childMap.set(region, { policy, physical: childPhysical });
    }

    return this.regionsOf(childPid);
  }

  // ---------------------------------------------------------------------------
  // §7.7 Recording
  // ---------------------------------------------------------------------------

  async #recordRead(
    pid: ProcessId,
    region: string,
    query: MemoryQuery,
    entries: readonly MemoryEntry[],
    callId: string,
  ): Promise<void> {
    const recorder = this.#table.recorderFor(pid);
    if (recorder === null) return;
    const state = this.#stateOf(pid);

    const record: SyscallRecordInput = {
      timestamp: this.#now(),
      pid,
      syscall: 'memory_read',
      callId,
      phase: 'exit',
      args: { region, query },
      // Hash the returned values, not the values themselves (ABI.md §4.4).
      result: {
        count: entries.length,
        valuesHash: hashValue(entries.map((e) => e.value)),
      },
      stateBefore: state,
      stateAfter: state,
      reversibility: 'idempotent',
      kernelAbiVersion: this.kernelAbiVersion,
    };

    await this.#append(recorder, record, 'memory_read');
  }

  async #recordWrite(
    pid: ProcessId,
    region: string,
    key: string,
    value: unknown,
    policy: MemoryRegionPolicy,
    opts: MemoryWriteOptions | undefined,
    callId: string,
  ): Promise<void> {
    const recorder = this.#table.recorderFor(pid);
    if (recorder === null) return;
    const state = this.#stateOf(pid);

    const bytes = valueByteSize(value);
    const hashOnly = opts?.recordHashOnly === true || bytes > this.#largeValueBytes;
    const valueField: Record<string, unknown> = hashOnly
      ? { valueHash: hashValue(value), valueBytes: bytes }
      : { value };

    const record: SyscallRecordInput = {
      timestamp: this.#now(),
      pid,
      syscall: 'memory_write',
      callId,
      phase: 'exit',
      args: {
        region,
        key,
        policyKind: policy.kind,
        ...(opts?.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
        ...valueField,
      },
      stateBefore: state,
      stateAfter: state,
      // Every write is logged and can be undone from the log (ABI.md §4.4).
      reversibility: 'reversible',
      kernelAbiVersion: this.kernelAbiVersion,
    };

    await this.#append(recorder, record, 'memory_write');
  }

  async #recordTrap(
    pid: ProcessId,
    syscall: 'memory_read' | 'memory_write',
    callId: string,
    err: CortexError,
    extraArgs: Record<string, unknown>,
  ): Promise<void> {
    const recorder = this.#table.recorderFor(pid);
    if (recorder === null) return;
    const state = this.#stateOf(pid);

    const record: SyscallRecordInput = {
      timestamp: this.#now(),
      pid,
      syscall,
      callId,
      phase: 'trap',
      args: extraArgs,
      error: {
        errno: err.errno,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
      stateBefore: state,
      stateAfter: state,
      reversibility: 'idempotent',
      kernelAbiVersion: this.kernelAbiVersion,
    };

    await this.#append(recorder, record, syscall);
  }

  #stateOf(pid: ProcessId): ProcessState {
    return this.#table.get(pid)?.state ?? 'running';
  }

  async #append(
    recorder: NonNullable<ReturnType<ProcessTable['recorderFor']>>,
    record: SyscallRecordInput,
    syscall: string,
  ): Promise<void> {
    try {
      await recorder.append(record);
    } catch (err) {
      if (isCortexError(err)) throw err;
      throw new CortexError('ERECORD', syscall, {
        message: `failed to record ${syscall}`,
        cause: err,
      });
    }
  }
}
