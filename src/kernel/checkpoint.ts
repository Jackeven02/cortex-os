/**
 * cortex kernel — checkpoint / restore.
 *
 * Implements the `.csnap` snapshot format per docs/STATE.md §4 and the
 * manager surface in docs/ARCHITECTURE.md §4.6. A checkpoint is a single
 * binary file: CBOR-encoded body, SHA-256 signed, content laid out exactly
 * as the `Checkpoint` type in docs/STATE.md §7.
 *
 * ## File layout
 *
 * ```
 * <createdAt>_<chainId>.csnap
 *   [0..4)     magic "CRTX"            (file-level sniff, like CREC_MAGIC)
 *   [4..N-32)  CBOR-encoded body       (Checkpoint minus `signature`)
 *   [N-32..N)  SHA-256(body bytes)     (integrity signature)
 * ```
 *
 * The signature covers the CBOR body bytes exactly as written, so load()
 * re-hashes the slice and compares — any tampering or truncation fails with
 * `EINVAL`. The body itself carries `magic: 'CRTX'` and `version` fields too
 * (the typed contract from STATE.md §7); the file-level magic is just a fast
 * sniff so tooling can tell `.csnap` from `.crec` without decoding.
 *
 * `<createdAt>` is the ISO8601 timestamp with `:` and `.` replaced by `-`,
 * because colons are illegal in Windows filenames (ARCHITECTURE.md §7's
 * example predates that constraint). The `chainId` suffix keeps names unique
 * and lets load() find a checkpoint by scanning when the in-memory index is
 * cold (e.g. after a kernel restart).
 *
 * ## What a checkpoint captures (STATE.md §4)
 *
 *   - header: pid, parentPid, createdAt, chainId, prevInChain
 *   - cognitive snapshot (messages / intent / pendingCalls)
 *   - memoryDelta: in v0 a FULL snapshot — every entry of every region, with
 *     `baseChainId: null`. True incremental deltas (writes-since-base) are
 *     post-v0; capturing everything is correct, just not yet minimal.
 *   - budgets: the process's spent counters (preserved across restore per
 *     PROCESS.md §8)
 *   - syscallLogOffset: the recorder's current EOF at snapshot time, so a
 *     replay engine knows where the shared causal past ends
 *   - driverStates: opaque per-driver blobs (empty in v0 — driver state
 *     serialization is an open question, STATE.md §8.6)
 *
 * ## State machine (PROCESS.md §3.5, §10)
 *
 * `take()` drives RUNNING|BLOCKED → CHECKPOINTING → RUNNING (or → SUSPENDED
 * with `detach: true`). Those are the only legal edges into CHECKPOINTING;
 * a checkpoint from STOPPED or any other state traps `EINVAL`, because
 * `take()` defers to `ProcessTable.setState` and the transition table is the
 * single source of truth for legality (`assertState`/`ESTATE` is the
 * dispatcher's job, #014). Note the ABI §4.2 "allowed states" list mentions
 * STOPPED but the v0 transition table has no `stopped->checkpointing` edge —
 * a known doc/impl gap tracked in BACKLOG #011. If anything fails after
 * entering CHECKPOINTING, take() best-effort returns the process to the state
 * a successful checkpoint would have produced, so it is never stranded; an
 * illegal *source* state never enters CHECKPOINTING and is therefore left
 * exactly as it was.
 *
 * `restoreAs()` creates a NEW process with a NEW PID in state NEW
 * (PROCESS.md §3.6, §11.3 — "restore is morally a fork from the past"). It
 * does not transition the new process out of NEW; the scheduler (#013) or
 * init (#021) dispatches it. The old PID is never reanimated.
 *
 * ## Dependencies / injection
 *
 * The checkpoint format does not carry the agent spec, role, or memory
 * region policies, so a faithful restore needs that context from elsewhere.
 * `restoreAs` therefore requires a `restoreContext` provider (injected); the
 * dispatcher/init supply it from the spawn record or daemon registry. This
 * mirrors the codebase's injection style (RecorderFactory, HandlerInvoker,
 * drivers). Cognitive state likewise flows through injected
 * `cognitiveSource` / `cognitiveSink` hooks — process_table does not store
 * messages yet (that lands with the runtime, #014/#021).
 *
 * See: docs/STATE.md §4, §7; docs/ABI.md §4.2; docs/ARCHITECTURE.md §4.6, §7;
 *      docs/PROCESS.md §3.5, §3.6, §11.3
 *
 * @module kernel/checkpoint
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encode, decode } from 'cborg';
import {
  type AgentSpec,
  type ChainId,
  type Checkpoint,
  type CheckpointOptions,
  type CognitiveSnapshot,
  type MemoryDelta,
  type MemoryEntry,
  type MemoryRegionPolicy,
  type ProcessId,
  type RestoreOptions,
  type SyscallOffset,
  type Timestamp,
  asChainId,
  asProcessId,
  asSyscallOffset,
  unbrand,
} from './types.js';
import { CortexError, isCortexError, trap } from './errors.js';
import type { ProcessTable } from './process_table.js';
import type { MemoryManager } from './memory.js';
import type { SyscallRecordInput } from './recorder.js';

// =============================================================================
// §1. Constants
// =============================================================================

/** File-level magic for `.csnap`, the 4 ASCII bytes "CRTX" (STATE.md §4). */
export const CSNAP_MAGIC = new Uint8Array([0x43, 0x52, 0x54, 0x58]);
export const CSNAP_MAGIC_STR = 'CRTX';
export const CSNAP_HEADER_SIZE = CSNAP_MAGIC.length;

/** Bumped whenever the on-disk body shape changes (ABI.md §9.6). */
export const CHECKPOINT_VERSION = 1;

/** SHA-256 digest length, appended after the CBOR body. */
export const SIGNATURE_SIZE = 32;

/** Empty cognitive snapshot, used when no `cognitiveSource` is injected. */
export const EMPTY_COGNITIVE: CognitiveSnapshot = {
  messages: [],
  intent: null,
  pendingCalls: [],
};

// =============================================================================
// §2. Supporting types
// =============================================================================

/** Index entry mapping a chainId to its on-disk location and lineage links. */
export interface CheckpointRef {
  readonly chainId: ChainId;
  readonly pid: ProcessId;
  readonly parentPid: ProcessId | null;
  readonly prevInChain: ChainId | null;
  readonly createdAt: Timestamp;
  readonly path: string;
}

/**
 * Context needed to materialize a process from a checkpoint. The agent spec,
 * role, and memory region policies are NOT in the `.csnap` body, so the
 * kernel must be told how to rebuild them (see the module header).
 */
export interface RestoreContext {
  readonly role: string;
  readonly agent: AgentSpec;
  readonly memory?: Readonly<Record<string, MemoryRegionPolicy>>;
  readonly ppid?: ProcessId | null;
}

export interface CheckpointManagerOptions {
  readonly table: ProcessTable;
  readonly kernelAbiVersion: string;
  /** Directory where `.csnap` files are written. Created on demand. */
  readonly dir: string;
  /**
   * Per-process checkpoint directory. When supplied, a checkpoint is written
   * next to the process that took it — `<processesRoot>/<pid>/checkpoints/`
   * (docs/ARCHITECTURE.md §7) — instead of into the single shared `dir`.
   *
   * Omit it and every process writes into `dir`, which is the pre-`0.2.1`
   * behaviour and is still supported.
   */
  readonly dirFor?: (pid: ProcessId) => string | Promise<string>;
  /**
   * Root to search when a chainId is not in the in-memory index. Needed
   * because `load()` knows only the chainId, not the PID, so with per-process
   * directories resolving it means looking through the tree. When omitted,
   * only `dir` is scanned.
   */
  readonly processesRoot?: string;
  /** Wall-clock source. Injectable for tests. */
  readonly now?: () => Timestamp;
  /** Chain-id source. Injectable for deterministic tests. */
  readonly nextChainId?: () => ChainId;
  /** Memory engine; when present, region entries are captured/restored. */
  readonly memory?: MemoryManager;
  /** Reads the cognitive snapshot at `take` time. */
  readonly cognitiveSource?: (pid: ProcessId) => CognitiveSnapshot | Promise<CognitiveSnapshot>;
  /** Writes the cognitive snapshot onto a restored process. */
  readonly cognitiveSink?: (pid: ProcessId, snap: CognitiveSnapshot) => void | Promise<void>;
  /** Collects opaque driver-state blobs at `take` time. */
  readonly driverStateSource?: () =>
    | Readonly<Record<string, Uint8Array | null>>
    | Promise<Readonly<Record<string, Uint8Array | null>>>;
  /** Supplies the agent/role/memory context needed by `restoreAs`. */
  readonly restoreContext?: (cp: Checkpoint) => RestoreContext | Promise<RestoreContext>;
  /** Fallback backing for restored regions with no explicit policy. */
  readonly defaultMemoryBacking?: string;
}

// =============================================================================
// §3. Filename / crypto helpers
// =============================================================================

/** Make an ISO8601 timestamp safe for use as a filename on every OS. */
export function safeTimestamp(ts: Timestamp): string {
  return ts.replace(/[:.]/g, '-');
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(bytes).digest());
}

function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** The CBOR-encodable body: a `Checkpoint` without its `signature`. */
type CheckpointBody = Omit<Checkpoint, 'signature'>;

// =============================================================================
// §4. CheckpointManager
// =============================================================================

export class CheckpointManager {
  readonly kernelAbiVersion: string;
  readonly dir: string;

  #table: ProcessTable;
  #now: () => Timestamp;
  #nextChainId: () => ChainId;
  #memory: MemoryManager | null;
  #cognitiveSource: CheckpointManagerOptions['cognitiveSource'];
  #cognitiveSink: CheckpointManagerOptions['cognitiveSink'];
  #driverStateSource: CheckpointManagerOptions['driverStateSource'];
  #restoreContext: CheckpointManagerOptions['restoreContext'];
  #defaultMemoryBacking: string;
  #dirFor: CheckpointManagerOptions['dirFor'];
  #processesRoot: string | undefined;

  /** chainId → ref, for O(1) load within a session. */
  #index = new Map<string, CheckpointRef>();

  constructor(opts: CheckpointManagerOptions) {
    this.#table = opts.table;
    this.kernelAbiVersion = opts.kernelAbiVersion;
    this.dir = opts.dir;
    this.#dirFor = opts.dirFor;
    this.#processesRoot = opts.processesRoot;
    this.#now = opts.now ?? (() => new Date().toISOString());
    this.#nextChainId = opts.nextChainId ?? (() => asChainId(randomUUID()));
    this.#memory = opts.memory ?? null;
    this.#cognitiveSource = opts.cognitiveSource;
    this.#cognitiveSink = opts.cognitiveSink;
    this.#driverStateSource = opts.driverStateSource;
    this.#restoreContext = opts.restoreContext;
    this.#defaultMemoryBacking = opts.defaultMemoryBacking ?? 'inmem';
  }

  // ---------------------------------------------------------------------------
  // §4.1 take
  // ---------------------------------------------------------------------------

  /**
   * Snapshot a process to a `.csnap` file. Drives the CHECKPOINTING state
   * transition, captures cognitive + memory + budgets + log offset, signs,
   * writes, and records a `checkpoint` syscall.
   *
   * Traps `ESRCH` (no such process), `EINVAL` (illegal source state, from
   * `setState`), `ERECORD` (disk failure), or `EDRIVER` (memory/driver
   * serialization).
   */
  async take(
    pid: ProcessId,
    opts?: CheckpointOptions,
  ): Promise<{ chainId: ChainId; path: string }> {
    const entry = this.#table.mustGet(pid, 'checkpoint'); // traps ESRCH

    const detach = opts?.detach === true;
    // Where the process goes after a non-detach checkpoint.
    //
    // From RUNNING it returns to RUNNING, matching docs/ABI.md §4.2 ("State
    // briefly enters CHECKPOINTING then returns to RUNNING"). It used to be
    // READY, which contradicted the documented contract and stranded the
    // agent: the body is still live and `await ctx.checkpoint()` resolves
    // inline, so the very next statement issues a syscall — and spawn, sleep,
    // memory_write and llm_call all allow only RUNNING, so it trapped ESTATE
    // with no way back (even `sleep` requires RUNNING).
    //
    // From BLOCKED it still goes to READY, deliberately. A blocked body is
    // parked on something (recv/wait/sleep); only a signal reaches it here.
    // Returning it to RUNNING would resume a body that is supposed to be
    // waiting, and returning it to BLOCKED would need its `blockedOn` reason
    // restored, which this path does not carry. READY lets the scheduler
    // re-dispatch it, which is the pre-existing behaviour.
    const finalState = detach ? 'suspended' : entry.state === 'blocked' ? 'ready' : 'running';
    let enteredCheckpointing = false;

    try {
      // RUNNING|BLOCKED → CHECKPOINTING (setState traps EINVAL if illegal).
      // Only legal edges into CHECKPOINTING exist from those two states; e.g.
      // STOPPED has no `stopped->checkpointing` edge and traps here, leaving
      // the process exactly as it was (enteredCheckpointing stays false).
      await this.#table.setState(pid, 'checkpointing', { trigger: 'checkpoint' });
      enteredCheckpointing = true;

      const cognitive =
        this.#cognitiveSource !== undefined
          ? await this.#cognitiveSource(pid)
          : EMPTY_COGNITIVE;

      const writes: readonly MemoryEntry[] =
        this.#memory !== null ? await this.#memory.dumpEntries(pid) : [];
      const memoryDelta: MemoryDelta = { baseChainId: null, writes };

      const recorder = this.#table.recorderFor(pid);
      const syscallLogOffset: SyscallOffset =
        recorder !== null ? recorder.currentOffset : asSyscallOffset(0);

      const driverStates: Readonly<Record<string, Uint8Array | null>> =
        this.#driverStateSource !== undefined ? await this.#driverStateSource() : {};

      const chainId = this.#nextChainId();
      const chain = entry.checkpointChain;
      const prevInChain: ChainId | null = chain.length > 0 ? (chain[chain.length - 1] as ChainId) : null;
      const createdAt = this.#now();

      const body: CheckpointBody = {
        magic: 'CRTX',
        version: CHECKPOINT_VERSION,
        pid,
        parentPid: entry.ppid,
        createdAt,
        chainId,
        prevInChain,
        cognitive,
        memoryDelta,
        budgets: { ...entry.budgetsSpent },
        budgetsRemaining: { ...entry.budgetsRemaining },
        syscallLogOffset,
        driverStates,
      };

      const bodyBytes = encode(body);
      const signature = sha256(bodyBytes);
      const fileBytes = Buffer.concat([
        Buffer.from(CSNAP_MAGIC),
        Buffer.from(bodyBytes),
        Buffer.from(signature),
      ]);

      const outDir =
        this.#dirFor === undefined ? this.dir : await this.#dirFor(pid);
      const path = join(outDir, `${safeTimestamp(createdAt)}_${unbrand(chainId)}.csnap`);
      try {
        await mkdir(outDir, { recursive: true });
        await writeFile(path, fileBytes);
      } catch (err) {
        throw new CortexError('ERECORD', 'checkpoint', {
          message: `failed to write checkpoint to ${path}`,
          details: { path },
          cause: err,
        });
      }

      this.#index.set(unbrand(chainId), {
        chainId,
        pid,
        parentPid: entry.ppid,
        prevInChain,
        createdAt,
        path,
      });
      this.#table.pushCheckpoint(pid, chainId);

      await this.#recordCheckpoint(pid, chainId, opts, fileBytes.byteLength, syscallLogOffset, finalState);

      // CHECKPOINTING → RUNNING (or SUSPENDED with detach).
      await this.#table.setState(pid, finalState, { trigger: 'checkpoint' });

      return { chainId, path };
    } catch (err) {
      // Best-effort: never strand the process in CHECKPOINTING. Only recover
      // if we actually entered it — an ESTATE from the initial transition
      // means the process never moved and must be left alone.
      if (enteredCheckpointing) {
        // Return to the same state a successful checkpoint would have —
        // READY would strand the body on its very next syscall, which is a
        // worse outcome than the failure that got us here.
        await this.#table
          .setState(pid, finalState, { trigger: 'checkpoint-abort' })
          .catch(() => {});
      }
      // A raw throw from cognitiveSource / driverStateSource / memory dump is
      // a driver serialization failure (ABI.md §4.2 → EDRIVER).
      const cortexErr = isCortexError(err)
        ? err
        : new CortexError('EDRIVER', 'checkpoint', {
            message: err instanceof Error ? err.message : String(err),
            details: { phase: 'snapshot' },
            cause: err,
          });
      await this.#recordTrap(pid, 'checkpoint', cortexErr, {
        ...(opts?.tag !== undefined ? { tag: opts.tag } : {}),
      });
      throw cortexErr;
    }
  }

  // ---------------------------------------------------------------------------
  // §4.2 load
  // ---------------------------------------------------------------------------

  /**
   * Read and verify a checkpoint by chainId. Traps `ENOENT` (unknown chainId)
   * or `EINVAL` (bad magic, version mismatch, or signature failure).
   */
  async load(chainId: ChainId): Promise<Checkpoint> {
    const path = await this.#resolvePath(chainId);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (err) {
      throw new CortexError('ENOENT', 'load', {
        message: `cannot read checkpoint at ${path}`,
        details: { path, chainId: unbrand(chainId) },
        cause: err,
      });
    }

    if (
      bytes.byteLength < CSNAP_HEADER_SIZE + SIGNATURE_SIZE ||
      !Buffer.from(CSNAP_MAGIC).equals(bytes.subarray(0, CSNAP_HEADER_SIZE))
    ) {
      trap('EINVAL', 'load', { reason: 'bad magic or truncated file', path });
    }

    const bodyBytes = bytes.subarray(CSNAP_HEADER_SIZE, bytes.byteLength - SIGNATURE_SIZE);
    const signature = bytes.subarray(bytes.byteLength - SIGNATURE_SIZE);
    if (!constantTimeEquals(sha256(new Uint8Array(bodyBytes)), new Uint8Array(signature))) {
      trap('EINVAL', 'load', { reason: 'signature mismatch (corrupt or tampered)', path });
    }

    let raw: unknown;
    try {
      raw = decode(new Uint8Array(bodyBytes));
    } catch (err) {
      throw new CortexError('EINVAL', 'load', {
        message: 'checkpoint body is not valid CBOR',
        details: { path },
        cause: err,
      });
    }

    return this.#rebrand(raw, path, new Uint8Array(signature));
  }

  /**
   * Validate a decoded body and re-brand its primitives back into the typed
   * `Checkpoint` shape.
   */
  #rebrand(raw: unknown, path: string, signature: Uint8Array): Checkpoint {
    if (typeof raw !== 'object' || raw === null) {
      trap('EINVAL', 'load', { reason: 'body is not an object', path });
    }
    const b = raw as Record<string, unknown>;
    if (b.magic !== CSNAP_MAGIC_STR) {
      trap('EINVAL', 'load', { reason: `bad magic '${String(b.magic)}'`, path });
    }
    if (b.version !== CHECKPOINT_VERSION) {
      trap('EINVAL', 'load', {
        reason: `snapshot version ${String(b.version)} != kernel ${CHECKPOINT_VERSION}`,
        path,
      });
    }

    const parentPid = b.parentPid;
    const prevInChain = b.prevInChain;

    return {
      magic: 'CRTX',
      version: CHECKPOINT_VERSION,
      pid: asProcessId(Number(b.pid)),
      parentPid: parentPid === null || parentPid === undefined ? null : asProcessId(Number(parentPid)),
      createdAt: String(b.createdAt),
      chainId: asChainId(String(b.chainId)),
      prevInChain:
        prevInChain === null || prevInChain === undefined ? null : asChainId(String(prevInChain)),
      cognitive: (b.cognitive as CognitiveSnapshot) ?? EMPTY_COGNITIVE,
      memoryDelta: (b.memoryDelta as MemoryDelta) ?? { baseChainId: null, writes: [] },
      budgets: b.budgets as Checkpoint['budgets'],
      syscallLogOffset: asSyscallOffset(Number(b.syscallLogOffset)),
      driverStates: (b.driverStates as Record<string, Uint8Array | null>) ?? {},
      signature,
    };
  }

  /**
   * Find a checkpoint's path: in-memory index first, then a directory scan.
   *
   * `load()` is given a chainId and nothing else, so it cannot know which
   * process owns the checkpoint. With per-process directories (`dirFor`) that
   * turns resolution into a search:
   *
   *   1. the in-memory index (covers anything taken in this session),
   *   2. the shared `dir` (legacy flat layout, and the only place scanned when
   *      `dirFor` was never supplied),
   *   3. `<processesRoot>/<pid>/checkpoints/` for each process on disk.
   *
   * It is a scan rather than an index because a checkpoint has to be loadable
   * after a kernel restart, by chainId, with no side index to keep in sync.
   */
  async #resolvePath(chainId: ChainId): Promise<string> {
    const key = unbrand(chainId);
    const hit = this.#index.get(key);
    if (hit !== undefined) return hit.path;

    const suffix = `_${key}.csnap`;
    const found = await this.#findIn(this.dir, suffix);
    if (found !== undefined) return found;

    if (this.#processesRoot !== undefined) {
      let procNames: string[];
      try {
        procNames = await readdir(this.#processesRoot);
      } catch {
        procNames = [];
      }
      for (const name of procNames) {
        if (!/^\d+$/.test(name)) continue;
        const inProcess = await this.#findIn(
          join(this.#processesRoot, name, 'checkpoints'),
          suffix,
        );
        if (inProcess !== undefined) return inProcess;
      }
    }

    trap('ENOENT', 'load', { chainId: key, reason: 'no such checkpoint' });
  }

  /** Look for `*_<chainId>.csnap` in one directory. Returns undefined if absent. */
  async #findIn(dir: string, suffix: string): Promise<string | undefined> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return undefined;
    }
    const match = names.find((n) => n.endsWith(suffix));
    return match === undefined ? undefined : join(dir, match);
  }

  // ---------------------------------------------------------------------------
  // §4.3 lineage
  // ---------------------------------------------------------------------------

  /**
   * Walk the `prevInChain` links from the given checkpoint back to the root,
   * returning the lineage oldest → newest (the given chainId is last).
   */
  async listLineage(chainId: ChainId): Promise<readonly ChainId[]> {
    const lineage: ChainId[] = [];
    const seen = new Set<string>();
    let cursor: ChainId | null = chainId;
    while (cursor !== null) {
      const key = unbrand(cursor);
      if (seen.has(key)) break; // defensive: a cycle would otherwise hang
      seen.add(key);
      lineage.push(cursor);
      const cp = await this.load(cursor);
      cursor = cp.prevInChain;
    }
    lineage.reverse();
    return lineage;
  }

  // ---------------------------------------------------------------------------
  // §4.4 restoreAs
  // ---------------------------------------------------------------------------

  /**
   * Create a NEW process (new PID, state NEW) from a checkpoint. Attaches
   * memory regions and replays the captured entries, restores spent budgets,
   * and hands the cognitive snapshot to the sink. The caller is unaffected.
   *
   * Traps `ENOENT` (unknown chainId), `EINVAL` (corrupt/version mismatch, or
   * no `restoreContext` provider), or `EDRIVER` (memory re-hydration).
   */
  async restoreAs(chainId: ChainId, opts?: RestoreOptions): Promise<ProcessId> {
    const cp = await this.load(chainId);

    if (this.#restoreContext === undefined) {
      trap('EINVAL', 'restore', {
        reason: 'restoreAs requires a restoreContext provider (agent spec is not stored in the checkpoint)',
        chainId: unbrand(chainId),
      });
    }
    const ctx = await this.#restoreContext(cp);

    // Region policies: explicit context wins; otherwise infer one private
    // region per distinct name in the delta (v0 limitation — copy semantics
    // are not preserved across restore; see module header).
    const regionNames = new Set<string>();
    for (const w of cp.memoryDelta.writes) regionNames.add(w.region);
    const memoryPolicies: Record<string, MemoryRegionPolicy> = {};
    for (const name of regionNames) {
      memoryPolicies[name] =
        ctx.memory?.[name] ?? { kind: 'private', backing: this.#defaultMemoryBacking };
    }

    const newPid = await this.#table.allocate({
      ppid: opts?.parent ?? ctx.ppid ?? cp.parentPid,
      role: ctx.role,
      agent: ctx.agent,
      memory: memoryPolicies,
      initialLogOffset: cp.syscallLogOffset,
      ...(opts?.budgets !== undefined ? { budgets: opts.budgets } : {}),
    });

    // Re-hydrate memory (regions were declared at allocate; syncFromTable
    // turns those declarations into live bindings).
    if (this.#memory !== null) {
      this.#memory.syncFromTable(newPid);
      if (cp.memoryDelta.writes.length > 0) {
        await this.#memory.loadEntries(newPid, cp.memoryDelta.writes);
      }
    }

    // Budgets are preserved across checkpoint/restore (PROCESS.md §8). A
    // checkpoint stores the spent counters (`cp.budgets`) and — for anything
    // snapshotted by this build — the remaining envelope (`cp.budgetsRemaining`).
    // Restoring by `spend()` alone would re-apply the historical spend onto the
    // DEFAULT limits (allocate used `opts.budgets ?? defaults`), silently wiping
    // a process's custom ceiling — e.g. a `tokens: 1000` agent would wake up
    // unlimited. When no caller override was given and we captured the envelope,
    // set spent + remaining directly (setBudgets does not decrement). Older
    // checkpoints without the field fall back to the prior spend-onto-defaults.
    if (opts?.budgets === undefined && cp.budgetsRemaining !== undefined) {
      this.#table.setBudgets(newPid, {
        remaining: cp.budgetsRemaining,
        spent: cp.budgets,
      });
    } else {
      this.#table.spend(newPid, cp.budgets);
    }

    if (this.#cognitiveSink !== undefined) {
      await this.#cognitiveSink(newPid, cp.cognitive);
    }

    // Lineage: the new process continues the same chain.
    this.#table.pushCheckpoint(newPid, cp.chainId);

    await this.#recordRestore(newPid, cp, opts);

    return newPid;
  }

  // ---------------------------------------------------------------------------
  // §4.5 Recording
  // ---------------------------------------------------------------------------

  async #recordCheckpoint(
    pid: ProcessId,
    chainId: ChainId,
    opts: CheckpointOptions | undefined,
    byteSize: number,
    syscallLogOffset: SyscallOffset,
    finalState: 'running' | 'suspended' | 'ready',
  ): Promise<void> {
    const recorder = this.#table.recorderFor(pid);
    if (recorder === null) return;

    const record: SyscallRecordInput = {
      timestamp: this.#now(),
      pid,
      syscall: 'checkpoint',
      callId: `ckpt-${unbrand(chainId)}`,
      phase: 'exit',
      args: {
        ...(opts?.tag !== undefined ? { tag: opts.tag } : {}),
        detach: opts?.detach === true,
        includeDriverStates: opts?.includeDriverStates !== false,
      },
      result: { chainId: unbrand(chainId), byteSize, syscallLogOffset: unbrand(syscallLogOffset) },
      stateBefore: 'checkpointing',
      stateAfter: finalState,
      // Multiple checkpoints are fine (ABI.md §4.2).
      reversibility: 'idempotent',
      kernelAbiVersion: this.kernelAbiVersion,
    };
    await this.#append(recorder, record, 'checkpoint');
  }

  async #recordRestore(
    newPid: ProcessId,
    cp: Checkpoint,
    opts: RestoreOptions | undefined,
  ): Promise<void> {
    const recorder = this.#table.recorderFor(newPid);
    if (recorder === null) return;

    const record: SyscallRecordInput = {
      timestamp: this.#now(),
      pid: newPid,
      syscall: 'restore',
      callId: `restore-${unbrand(cp.chainId)}`,
      phase: 'exit',
      args: {
        chainId: unbrand(cp.chainId),
        sourcePid: unbrand(cp.pid),
        ...(opts?.replayMode !== undefined ? { replayMode: opts.replayMode } : {}),
      },
      result: { pid: unbrand(newPid) },
      stateBefore: 'new',
      stateAfter: 'new',
      // A restore can be undone by killing the new process (ABI.md §4.2).
      reversibility: 'reversible',
      kernelAbiVersion: this.kernelAbiVersion,
    };
    await this.#append(recorder, record, 'restore');
  }

  async #recordTrap(
    pid: ProcessId,
    syscall: 'checkpoint' | 'restore',
    err: CortexError,
    extraArgs: Record<string, unknown>,
  ): Promise<void> {
    const recorder = this.#table.recorderFor(pid);
    if (recorder === null) return;
    const state = this.#table.get(pid)?.state ?? 'running';

    const record: SyscallRecordInput = {
      timestamp: this.#now(),
      pid,
      syscall,
      callId: `${syscall}-trap-${unbrand(pid)}`,
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
