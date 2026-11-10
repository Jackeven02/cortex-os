/**
 * cortex kernel — cognitive fork.
 *
 * Implements `fork()` per docs/STATE.md §3.1 (cognitive fork), docs/ABI.md
 * §4.2 (`fork` syscall), and docs/ARCHITECTURE.md §4.7. Fork is the hardest
 * kernel operation because it has to decide, category by category, what part
 * of a running agent is even *meaningful* to duplicate. STATE.md §2 enumerates
 * the seven categories; a cognitive fork copies 1–4 and 7, closes 5, and
 * acknowledges 6 as immutable shared past:
 *
 *   1. Identity        → fresh PID, `ppid` points at the forker, new chainId
 *   2. Cognitive       → deep copy (messages / intent / pendingCalls)
 *   3. Memory          → per-region policy via MemoryManager.forkCopy
 *                        (private = deep copy, shared = same backing,
 *                         cow = share-until-first-write)
 *   4. Budgets         → policy-driven (reset | inherit | split)
 *   5. Driver state    → CLOSED in both parent and child (STATE.md §2.5);
 *                        two processes cannot share a socket / session / txn
 *   6. World side      → UNCOPYABLE; both branches remember the irreversible
 *     effects           actions already in the shared past (surfaced via
 *                        `irreversibleInPast`)
 *   7. Lineage         → branched: both share the causal past up to
 *                        `sharedCausalPast`, each appends its own suffix
 *
 * ## What fork does NOT do
 *
 * - It does not transition the parent. ABI.md §4.2: "caller unchanged." The
 *   one exception is the `split` budget policy, which moves remaining budget
 *   from parent to child (documented below) — that is a budget mutation, not
 *   a state-machine transition.
 * - It does not run the child. The child lands in READY; the scheduler (#013)
 *   or init (#021) dispatches it.
 * - Sandbox fork (§3.2) and shadow process (§3.4): shadow is `kind: 'shadow'`.
 *   Sandbox stays out until file and network tools share one gate. Only
 *   `kind: 'cognitive'` and `kind: 'shadow'` are accepted.
 *
 * ## Dependencies / injection
 *
 * Like checkpoint.ts, fork needs the cognitive snapshot, which the process
 * table does not store yet (that lands with the runtime, #014/#021). It is
 * read/written through injected `cognitiveSource` / `cognitiveSink` hooks.
 * Driver-state close is likewise an injected `closeDriverState` hook — in v0
 * there are no stateful drivers, so it is usually absent, but the seam exists
 * so the §2.5 "close on fork" policy is wired from day one.
 *
 * See: docs/STATE.md §2, §3.1; docs/ABI.md §4.2, §9.5;
 *      docs/ARCHITECTURE.md §4.7
 *
 * @module kernel/fork
 */

import { randomUUID } from 'node:crypto';
import {
  type BudgetCounters,
  type BudgetLimits,
  type ChainId,
  type CognitiveSnapshot,
  type ForkKind,
  type ForkOptions,
  type ForkResult,
  type MemoryRegionPolicy,
  type Message,
  type ProcessId,
  type SyscallOffset,
  type Timestamp,
  asChainId,
  asSyscallOffset,
  unbrand,
} from './types.js';
import { CortexError, assertState, isCortexError, trap } from './errors.js';
import type { ProcessTable } from './process_table.js';
import type { MemoryManager } from './memory.js';
import { readRecords, type SyscallRecordInput } from './recorder.js';

// =============================================================================
// §1. Constants
// =============================================================================

/** States a process may be in to fork (ABI.md §4.2). */
export const FORK_ALLOWED_STATES = ['running', 'blocked', 'stopped', 'suspended'] as const;

/** Cognitive fork is the default. Shadow is the other accepted kind. */
export const DEFAULT_FORK_KIND: ForkKind = 'cognitive';

/** Default budget policy: the fork is a fresh attempt (STATE.md §2.4). */
export const DEFAULT_BUDGET_POLICY = 'reset' as const;

// =============================================================================
// §2. Options
// =============================================================================

export interface ForkManagerOptions {
  readonly table: ProcessTable;
  readonly kernelAbiVersion: string;
  /** Wall-clock source. Injectable for tests. */
  readonly now?: () => Timestamp;
  /** Chain-id source for the child's lineage branch. Injectable for tests. */
  readonly nextChainId?: () => ChainId;
  /** Call-id source for syscall records. Injectable for tests. */
  readonly nextCallId?: () => string;
  /** Memory engine; when present, regions are duplicated per policy. */
  readonly memory?: MemoryManager;
  /** Reads the parent's cognitive snapshot at fork time. */
  readonly cognitiveSource?: (pid: ProcessId) => CognitiveSnapshot | Promise<CognitiveSnapshot>;
  /** Writes the copied cognitive snapshot onto the child. */
  readonly cognitiveSink?: (pid: ProcessId, snap: CognitiveSnapshot) => void | Promise<void>;
  /**
   * Closes driver/tool state for a process (STATE.md §2.5). Called for BOTH
   * parent and child after the fork. A throw is wrapped as `EDRIVER`.
   */
  readonly closeDriverState?: (pid: ProcessId) => void | Promise<void>;
}

// =============================================================================
// §3. Budget policy helpers
// =============================================================================

/** Halve a finite budget component; unlimited (-1) stays unlimited. */
function halve(n: number): number {
  return n < 0 ? -1 : Math.floor(n / 2);
}

/**
 * A child budget envelope is unusable if any finite component is already
 * exhausted (0). Unlimited (-1) and positive values are fine.
 */
function isExhausted(limits: BudgetLimits): boolean {
  return limits.tokens === 0 || limits.usd === 0 || limits.wallTimeMs === 0;
}

// =============================================================================
// §3. Call context
// =============================================================================

/**
 * What the syscall dispatcher knows about the fork it is routing.
 *
 * The fork's *caller's* record is the dispatcher's (docs/ABI.md §9), so the
 * dispatcher writes the `enter` frame before the fork runs. That frame's
 * position in the parent's log is the fork's dividing line: the shared
 * causal past is everything before it. The module cannot see that offset
 * from the inside — by the time it runs, the frame has already landed — so
 * the dispatcher hands it over.
 */
export interface ForkContext {
  /**
   * Byte offset in the parent's `.crec` where this fork's `enter` frame
   * landed — the start of the fork call, and therefore the end of the
   * shared causal past.
   */
  readonly sharedCausalPastOffset?: SyscallOffset;
  /** The call id the dispatcher records the fork under. */
  readonly callId?: string;
}

// =============================================================================
// §4. ForkManager
// =============================================================================

export class ForkManager {
  readonly kernelAbiVersion: string;

  #table: ProcessTable;
  #now: () => Timestamp;
  #nextChainId: () => ChainId;
  #nextCallId: () => string;
  #memory: MemoryManager | null;
  #cognitiveSource: ForkManagerOptions['cognitiveSource'];
  #cognitiveSink: ForkManagerOptions['cognitiveSink'];
  #closeDriverState: ForkManagerOptions['closeDriverState'];
  #callCounter = 0;

  constructor(opts: ForkManagerOptions) {
    this.#table = opts.table;
    this.kernelAbiVersion = opts.kernelAbiVersion;
    this.#now = opts.now ?? (() => new Date().toISOString());
    this.#nextChainId = opts.nextChainId ?? (() => asChainId(randomUUID()));
    this.#memory = opts.memory ?? null;
    this.#cognitiveSource = opts.cognitiveSource;
    this.#cognitiveSink = opts.cognitiveSink;
    this.#closeDriverState = opts.closeDriverState;
    const explicitCallId = opts.nextCallId;
    this.#nextCallId =
      explicitCallId ??
      (() => {
        this.#callCounter += 1;
        return `fork-${this.#callCounter}`;
      });
  }

  // ---------------------------------------------------------------------------
  // §4.1 fork
  // ---------------------------------------------------------------------------

  /**
   * Duplicate the calling process per STATE.md §3.1. Returns the child's PID,
   * its lineage chainId, the shared-causal-past log offset, and the list of
   * irreversible syscalls already in that shared past.
   *
   * Traps `ESRCH` (no such parent), `ESTATE` (parent not in a forkable state),
   * `EINVAL` (unknown fork kind), `EBUDGET` (child would be born exhausted),
   * or `EDRIVER` (a driver refused to close, or memory duplication failed).
   *
   * @param ctx  Supplied by the syscall dispatcher: where this fork's
   *              `enter` frame landed in the parent's log, and the call id
   *              the dispatcher will record the fork under. Without it the
   *              module falls back to the parent's current log offset — which
   *              is *after* the `enter` frame, and would make the fork itself
   *              count as shared history.
   */
  async fork(
    parentPid: ProcessId,
    opts?: ForkOptions,
    ctx?: ForkContext,
  ): Promise<ForkResult> {
    const kind = opts?.kind ?? DEFAULT_FORK_KIND;
    if (kind !== 'cognitive' && kind !== 'shadow') {
      trap('EINVAL', 'fork', {
        kind,
        reason: `fork kind '${String(kind)}' is not supported`,
      });
    }
    if (kind === 'shadow' && !hasShadow(opts?.shadow)) {
      trap('EINVAL', 'fork', {
        kind,
        reason: 'a shadow fork names a driver, a model, a temperature, or a system prompt',
      });
    }
    if (kind !== 'shadow' && opts?.shadow !== undefined) {
      trap('EINVAL', 'fork', {
        kind,
        reason: 'shadow options belong on a shadow fork',
      });
    }

    const parent = this.#table.mustGet(parentPid, 'fork'); // traps ESRCH
    assertState(parent.state, FORK_ALLOWED_STATES, 'fork'); // traps ESTATE

    const budgetPolicy = opts?.budgets ?? DEFAULT_BUDGET_POLICY;
    const parentRemaining = parent.budgetsRemaining;
    const parentSpent = parent.budgetsSpent;

    // --- step 4: compute the child's budget envelope from the policy --------
    // reset   → child gets the parent's remaining envelope, spent zeroed.
    // inherit → child gets the parent's remaining envelope AND its spent
    //           counters (it "remembers" the cost), remaining unchanged.
    // split   → parent's remaining is halved; child gets the other half, spent
    //           zeroed. This is the one policy that mutates the parent.
    let childLimits: BudgetLimits;
    let childSpent: BudgetCounters | null = null;
    if (budgetPolicy === 'split') {
      childLimits = {
        tokens: halve(parentRemaining.tokens),
        usd: halve(parentRemaining.usd),
        wallTimeMs: halve(parentRemaining.wallTimeMs),
      };
    } else {
      childLimits = { ...parentRemaining };
      if (budgetPolicy === 'inherit') childSpent = { ...parentSpent };
    }

    if (isExhausted(childLimits)) {
      trap('EBUDGET', 'fork', {
        policy: budgetPolicy,
        childLimits,
        reason: 'child would be born with an exhausted budget',
      });
    }

    // --- step 3: allocate the child PID -------------------------------------
    // Region policies are inherited from the parent's declarations, with any
    // per-region overrides applied (STATE.md §2.3).
    const childPolicies: Record<string, MemoryRegionPolicy> = {};
    for (const [region, policy] of parent.memoryRegions) {
      childPolicies[region] = opts?.memoryOverrides?.[region] ?? policy;
    }

    const childPid = await this.#table.allocate({
      ppid: parentPid,
      role: parent.role,
      agent: parent.agent,
      nice: parent.nice,
      memory: childPolicies,
      budgets: childLimits,
      // A fork is the same agent. It keeps the parent's authority, including
      // "unnarrowed". Omitting the sets on a narrowed parent would mint a
      // fully privileged child (docs/ABI.md §4.9).
      ...(parent.capabilities === null
        ? {}
        : {
            capabilities: [...parent.capabilities],
            grantable: [...parent.grantable],
          }),
    });

    try {
      // --- step 4 (cont.): apply budget policy ------------------------------
      if (budgetPolicy === 'split') {
        // Move the other half out of the parent. floor() on the child means
        // the parent keeps the remainder, so no budget is lost to rounding.
        this.#table.setBudgets(parentPid, {
          remaining: {
            tokens: parentRemaining.tokens < 0 ? -1 : parentRemaining.tokens - childLimits.tokens,
            usd: parentRemaining.usd < 0 ? -1 : parentRemaining.usd - childLimits.usd,
            wallTimeMs:
              parentRemaining.wallTimeMs < 0
                ? -1
                : parentRemaining.wallTimeMs - childLimits.wallTimeMs,
          },
        });
      }
      if (childSpent !== null) {
        this.#table.setBudgets(childPid, { spent: childSpent });
      }

      // --- step 5: duplicate memory regions per policy ----------------------
      if (this.#memory !== null) {
        await this.#memory.forkCopy(parentPid, childPid, opts?.memoryOverrides);
      }

      // --- step 2: deep-copy the cognitive snapshot -------------------------
      // STATE.md §2.2: cognitive context is pure serializable JSON and is
      // deep-copied. We clone here (rather than trusting the hooks) so the
      // child's messages/intent/pendingCalls are fully independent of the
      // parent's — mutating one branch must never perturb the other.
      if (this.#cognitiveSource !== undefined && this.#cognitiveSink !== undefined) {
        const snap = await this.#cognitiveSource(parentPid);
        const copied = structuredClone(snap);
        const shadowed =
          kind === 'shadow' && opts?.shadow?.system !== undefined
            ? withSystem(copied, opts.shadow.system)
            : copied;
        await this.#cognitiveSink(childPid, shadowed);
      }
      if (kind === 'shadow' && opts?.shadow !== undefined) {
        this.#table.setLlmPin(childPid, opts.shadow);
      }

      // --- step 6: close driver state in BOTH processes (STATE.md §2.5) -----
      if (this.#closeDriverState !== undefined) {
        try {
          await this.#closeDriverState(parentPid);
          await this.#closeDriverState(childPid);
        } catch (err) {
          throw new CortexError('EDRIVER', 'fork', {
            message: `driver refused to close cleanly on fork: ${
              err instanceof Error ? err.message : String(err)
            }`,
            details: { phase: 'close-driver-state' },
            cause: err,
          });
        }
      }

      // --- steps 7 & 8: shared causal past + irreversible history -----------
      const recorder = this.#table.recorderFor(parentPid);
      // The shared causal past is everything in the parent's log *before* the
      // fork call. The dispatcher knows where the fork's `enter` frame
      // landed; without it we would have to guess from the current offset,
      // which is already past that frame.
      const sharedCausalPast: SyscallOffset =
        ctx?.sharedCausalPastOffset ??
        (recorder !== null ? recorder.currentOffset : asSyscallOffset(0));
      const irreversibleInPast =
        recorder !== null ? await this.#scanIrreversible(recorder.path) : [];

      // --- step 1 & 7: lineage ---------------------------------------------
      const childChainId = this.#nextChainId();

      // --- step 9: child NEW → READY ---------------------------------------
      await this.#table.setState(childPid, 'ready', { trigger: 'fork' });

      // --- step 10: record the fork in BOTH logs ---------------------------
      // The *caller's* frame is the dispatcher's (docs/ABI.md §9). This module
      // writes only the child's birth record — a frame about the child, in the
      // child's log, that no other process can write.
      const callId = ctx?.callId ?? this.#nextCallId();
      await this.#recordForkChild(childPid, parentPid, childChainId, callId, budgetPolicy);

      return {
        childPid,
        childChainId,
        sharedCausalPast,
        irreversibleInPast,
      };
    } catch (err) {
      // Best-effort cleanup: never leave a half-built child in the table. The
      // child is in NEW or READY; SIGKILL-equivalent reaping is the scheduler's
      // job, but we can at least mark it exiting→zombie so it is not runnable.
      await this.#abortChild(childPid);
      const cortexErr = isCortexError(err)
        ? err
        : new CortexError('EDRIVER', 'fork', {
            message: err instanceof Error ? err.message : String(err),
            details: { phase: 'fork' },
            cause: err,
          });
      // No trap record here: the dispatcher owns the `fork` record and writes
      // the matching trap frame under the same callId (docs/ABI.md §9).
      throw cortexErr;
    }
  }

  // ---------------------------------------------------------------------------
  // §4.2 Irreversible-past scan
  // ---------------------------------------------------------------------------

  /**
   * Scan a parent's `.crec` log for syscalls tagged `irreversible`, returning
   * their distinct names. These are the world side effects (STATE.md §2.6)
   * both branches will remember but neither can undo — e.g. `send_email`.
   *
   * A torn trailing frame is silently skipped by `readRecords`, so this never
   * throws on a partially-flushed log.
   */
  async #scanIrreversible(path: string): Promise<readonly string[]> {
    const seen = new Set<string>();
    for await (const r of readRecords(path)) {
      if (r.reversibility === 'irreversible') seen.add(r.syscall);
    }
    return [...seen];
  }

  // ---------------------------------------------------------------------------
  // §4.3 Cleanup
  // ---------------------------------------------------------------------------

  /**
   * Drive a half-built child out of the runnable set after a failed fork.
   * NEW cannot jump straight to ZOMBIE — the only legal path is
   * NEW→READY→RUNNING→EXITING→ZOMBIE — so we walk that sequence, swallowing
   * any step that is a no-op (already in that state) or illegal from the
   * current state. Best-effort: this runs on a failure path and must not
   * throw.
   */
  async #abortChild(childPid: ProcessId): Promise<void> {
    for (const next of ['ready', 'running', 'exiting', 'zombie'] as const) {
      if (this.#table.get(childPid)?.state === 'zombie') break;
      await this.#table.setState(childPid, next, { trigger: 'fork-abort' }).catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // §4.4 Recording
  // ---------------------------------------------------------------------------

  /**
   * Write the child's **birth record** into the child's own log: "I was
   * born from a fork of pid N", plus the branch's chain id and the budget
   * policy it inherited.
   *
   * This is the one frame the fork module still writes, and it is not a
   * syscall record — the *caller's* `fork` frames are the dispatcher's
   * (docs/ABI.md §9). This one describes the child, so it belongs in the
   * child's log, and no other process can write it.
   */
  async #recordForkChild(
    childPid: ProcessId,
    parentPid: ProcessId,
    childChainId: ChainId,
    callId: string,
    budgetPolicy: string,
  ): Promise<void> {
    const recorder = this.#table.recorderFor(childPid);
    if (recorder === null) return;

    const record: SyscallRecordInput = {
      timestamp: this.#now(),
      pid: childPid,
      syscall: 'fork',
      callId,
      phase: 'exit',
      args: { origin: 'child', parentPid: unbrand(parentPid), budgets: budgetPolicy },
      result: { childChainId: unbrand(childChainId) },
      stateBefore: 'new',
      stateAfter: 'ready',
      reversibility: 'reversible',
      kernelAbiVersion: this.kernelAbiVersion,
    };
    await this.#append(recorder, record, 'fork');
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

function hasShadow(shadow: ForkOptions['shadow']): boolean {
  if (shadow === undefined) return false;
  return (
    shadow.driver !== undefined ||
    shadow.model !== undefined ||
    shadow.temperature !== undefined ||
    (typeof shadow.system === 'string' && shadow.system.trim() !== '')
  );
}

function withSystem(snap: CognitiveSnapshot, system: string): CognitiveSnapshot {
  const messages: Message[] = snap.messages.map((message) => ({ ...message }));
  const index = messages.findIndex((message) => message.role === 'system');
  if (index >= 0) {
    const current = messages[index]!;
    messages[index] = { ...current, content: system };
  } else {
    messages.unshift({ role: 'system', content: system });
  }
  return { ...snap, messages };
}
