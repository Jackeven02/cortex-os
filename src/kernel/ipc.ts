/**
 * cortex kernel — inter-process communication.
 *
 * Implements `send` and `recv` per docs/ABI.md §4.5 and the channel model
 * sketched in docs/ARCHITECTURE.md §4.4. Channels are content-agnostic
 * FIFO queues with a waiters list; processes block on `recv` and are woken
 * by `send`.
 *
 * ## Channel model
 *
 * v0 follows ABI.md §9.3: channels are created **implicitly** on first
 * reference. Both `send` and `recv` will materialize an unknown channel.
 * This is convenient and known messy — a typo'd channel name silently
 * forks the universe. v0.2 will add explicit `channel_open()` (predicted
 * in ABI.md §10). For now we lean into the simplification and document it.
 *
 * Two flavors of channel ID coexist:
 *
 *   - **Named** — any `ChannelId` string the agent picks (`'planner-inbox'`).
 *   - **PID inbox** — `pid:<n>`, derived from a `ProcessId` target. When
 *     `send(to: ProcessId, ...)` is called, the manager routes to that
 *     PID's inbox channel. This is how process-to-process messaging works
 *     without agents having to negotiate channel names.
 *
 * Both flavors are the same underlying `Channel` object; the only
 * difference is how the ID is computed.
 *
 * ## Blocking semantics
 *
 * `recv` is blocking by default (ABI.md §4.5). When the queue is empty:
 *
 *   1. A waiter is registered on the channel.
 *   2. The process is transitioned RUNNING → BLOCKED with
 *      `blockedOn = { kind: 'recv', channel }`.
 *   3. The returned promise parks.
 *
 * When a `send` arrives:
 *
 *   1. If waiters exist, the message is handed directly to the first
 *      (FIFO). The queue stays empty.
 *   2. The waiter's process transitions BLOCKED → READY.
 *   3. The promise resolves with the message.
 *
 * The process is *not* automatically dispatched back to RUNNING — that is
 * the scheduler's job (#013). v0 callers (smoke tests, eventually the
 * dispatcher) walk READY → RUNNING themselves before issuing the next
 * syscall.
 *
 * `send` is non-blocking by default. v0 queues are unbounded
 * (ARCHITECTURE.md §4.4 "v0 simplification"); `queueLimit` is honored if
 * specified, with `EAGAIN` on overflow when `blocking: false`. Blocking
 * sends are not yet implemented — they require a sender-side waiters list
 * which v0 does not need.
 *
 * ## Signals
 *
 *   - Sending to a closed channel raises `SIGPIPE` on the sender
 *     (PROCESS.md §7). Default disposition is ignore.
 *   - `SIGKILL` on a blocked receiver cancels its waiter via the
 *     `cancelWaitersFor` hook; the kernel wires this through
 *     `SignalManager.onZombie`. Without the hook, a killed receiver would
 *     leave its promise pending forever.
 *
 * ## Closing
 *
 * `closeChannel(id)` is destructive in v0:
 *
 *   - Pending messages in the queue are dropped.
 *   - All waiters are rejected with `EBADF`.
 *   - Subsequent `send` traps `EBADF` and raises `SIGPIPE`.
 *   - Subsequent `recv` traps `EBADF`.
 *
 * POSIX pipes have richer semantics (readers see EOF after writers close,
 * etc.). v0 doesn't model refcounts or direction; v0.2 will revisit.
 *
 * ## Recording
 *
 * Every `send` and `recv` writes a record to the *caller's* `.crec` log:
 *
 *   - `send`: `syscall: 'send'`, args = `{ target, targetKind, body,
 *     queueDepth }`, reversibility = `'idempotent'` (until consumed).
 *   - `recv`: `syscall: 'recv'`, args = `{ source, sourceKind }`,
 *     result = the message, reversibility = `'irreversible'` (the message
 *     is gone from the queue).
 *   - Errors: `phase: 'trap'` with the errno/message/details.
 *
 * The receiver does NOT write a record on `send` (only the sender does).
 * The receiver's record is the `recv` it eventually issues. This avoids
 * double-counting and matches the "syscall log = caller's log" invariant
 * from ARCHITECTURE.md §2.
 *
 * See: docs/ABI.md §4.5, docs/ARCHITECTURE.md §4.4, docs/PROCESS.md §7
 *
 * @module kernel/ipc
 */

import {
  type ChannelId,
  type IpcMessage,
  type ProcessId,
  type ProcessState,
  type RecvOptions,
  type SendOptions,
  type Timestamp,
  asChannelId,
  unbrand,
} from './types.js';
import { CortexError, isCortexError, trap } from './errors.js';
import type { ProcessTable } from './process_table.js';
import type { SignalManager } from './signals.js';
import type { WakeGate } from './wake_gate.js';
import type { SyscallRecordInput } from './recorder.js';

// =============================================================================
// §1. Constants and channel ID helpers
// =============================================================================

/**
 * Default queue limit. `-1` means unbounded (v0 simplification per
 * ARCHITECTURE.md §4.4). Override per-channel via `IpcManagerOptions` or
 * per-send via `SendOptions.queueLimit`.
 */
export const DEFAULT_QUEUE_LIMIT = -1;

/**
 * Default `recv` timeout when `blocking: true` and no `timeoutMs` is given.
 * `-1` means wait forever. v0 keeps this conservative; supervisors that
 * care about hung agents use SIGXCPU on wall-time budgets instead.
 */
export const DEFAULT_RECV_TIMEOUT_MS = -1;

/**
 * Compute the inbox channel ID for a process. Process-to-process `send`
 * routes through this channel; agents can also `recv` from it explicitly
 * if they want to inspect their own inbox.
 */
export function pidInboxChannel(pid: ProcessId): ChannelId {
  return asChannelId(`pid:${unbrand(pid)}`);
}

/**
 * Whether a `send`/`recv` target is a `ProcessId` (number-backed brand)
 * rather than a `ChannelId` (string-backed brand). At runtime the brands
 * are erased; we discriminate by `typeof`.
 */
export function isProcessTarget(t: ProcessId | ChannelId): t is ProcessId {
  return typeof t === 'number';
}

/**
 * Resolve a `send` target to its underlying channel ID.
 */
export function resolveChannel(target: ProcessId | ChannelId): ChannelId {
  return isProcessTarget(target) ? pidInboxChannel(target) : target;
}

// =============================================================================
// §2. Channel
// =============================================================================

/**
 * Internal mutable channel record. Not exported as part of the public ABI;
 * external code sees `ChannelInfo` snapshots via `IpcManager.describe()`.
 */
interface Channel {
  readonly id: ChannelId;
  readonly createdAt: Timestamp;
  readonly createdBy: ProcessId | null;
  closed: boolean;
  closedAt: Timestamp | null;
  queue: IpcMessage[];
  waiters: RecvWaiter[];
  queueLimit: number;
  /** Total messages ever enqueued (diagnostic). */
  totalSent: number;
  /** Total messages ever dequeued (diagnostic). */
  totalRecv: number;
}

/**
 * Immutable snapshot of a channel for diagnostics and `cortex channels`.
 */
export interface ChannelInfo {
  readonly id: ChannelId;
  readonly createdAt: Timestamp;
  readonly createdBy: ProcessId | null;
  readonly closed: boolean;
  readonly closedAt: Timestamp | null;
  readonly queueDepth: number;
  readonly waiterCount: number;
  readonly queueLimit: number;
  readonly totalSent: number;
  readonly totalRecv: number;
}

// =============================================================================
// §3. Waiters
// =============================================================================

/**
 * A parked `recv` call. Holds the promise callbacks plus enough metadata
 * to cancel cleanly on timeout / close / SIGKILL.
 */
interface RecvWaiter {
  readonly pid: ProcessId;
  readonly callId: string;
  readonly channel: ChannelId;
  readonly registeredAt: Timestamp;
  resolve: (msg: IpcMessage) => void;
  reject: (err: unknown) => void;
  /** setTimeout handle, if a timeout was requested. */
  timer: NodeJS.Timeout | null;
  /** Set once the waiter has been settled (resolved or rejected). */
  settled: boolean;
}

// =============================================================================
// §4. Options
// =============================================================================

/**
 * Options for constructing an `IpcManager`.
 */
export interface IpcManagerOptions {
  readonly table: ProcessTable;
  /** Value written into every record's `kernelAbiVersion` field. */
  readonly kernelAbiVersion: string;
  /** Wall-clock source. Injectable for tests. */
  readonly now?: () => Timestamp;
  /** Monotonic counter for call IDs. Injectable for tests. */
  readonly nextCallId?: () => string;
  /**
   * Optional signal manager. When provided, `send` to a closed channel
   * raises `SIGPIPE` on the sender. When absent, SIGPIPE is silently
   * skipped (useful for unit tests that don't need the dependency).
   */
  readonly signals?: SignalManager;
  /** Default queue limit applied to channels without an explicit one. */
  readonly defaultQueueLimit?: number;
  /** setTimeout injection point so tests can run without real timers. */
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
  /**
   * The kernel's wake gate. When present, a `recv()` that is woken (by a
   * message, a close, or a timeout) does not resolve the instant the message is
   * in hand — the resolution is deferred until the scheduler next dispatches the
   * receiver, so the agent's next syscall sees RUNNING instead of the transient
   * READY left behind by the wake. See `wake_gate.ts`. Absent ⇒ resolve inline.
   */
  readonly wakeGate?: WakeGate;
}

/**
 * Options for `IpcManager.closeChannel`.
 */
export interface CloseChannelOptions {
  /**
   * If true, drain remaining messages to nowhere (default) — i.e. drop
   * them. v0 only supports drop; the flag exists so v0.2 can add
   * `'deliver'` (hand to waiters before closing) without an ABI break.
   */
  readonly drop?: boolean;
}

// =============================================================================
// §5. IpcManager
// =============================================================================

/**
 * The IPC engine. One per kernel.
 *
 * Concurrency model: single-threaded JS. Async work is limited to
 * recorder writes (serialized per process by the recorder's promise chain)
 * and waiter resolution (synchronous from the manager's POV — the awaiter
 * resumes on a later microtask).
 */
export class IpcManager {
  readonly kernelAbiVersion: string;

  #table: ProcessTable;
  #signals: SignalManager | null;
  #now: () => Timestamp;
  #nextCallId: () => string;
  #wakeGate: WakeGate | null;
  #defaultQueueLimit: number;
  #setTimeout: typeof setTimeout;
  #clearTimeout: typeof clearTimeout;

  #channels = new Map<string, Channel>();
  /** Per-PID set of channels the process has touched (sent or received). */
  #memberships = new Map<number, Set<string>>();
  #callCounter = 0;

  constructor(opts: IpcManagerOptions) {
    this.#table = opts.table;
    this.kernelAbiVersion = opts.kernelAbiVersion;
    this.#signals = opts.signals ?? null;
    this.#now = opts.now ?? (() => new Date().toISOString());
    this.#defaultQueueLimit = opts.defaultQueueLimit ?? DEFAULT_QUEUE_LIMIT;
    this.#setTimeout = opts.setTimeoutFn ?? setTimeout;
    this.#clearTimeout = opts.clearTimeoutFn ?? clearTimeout;
    this.#wakeGate = opts.wakeGate ?? null;
    this.#nextCallId =
      opts.nextCallId ??
      (() => {
        this.#callCounter++;
        return `ipc-${this.#callCounter}`;
      });
  }

  // ---------------------------------------------------------------------------
  // §5.1 Channel lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Get or create a channel by ID. Idempotent. Newly-created channels are
   * timestamped and attributed to `createdBy` (which may be null for
   * system-created channels).
   */
  ensureChannel(id: ChannelId, createdBy: ProcessId | null = null): ChannelInfo {
    const channel = this.#ensureChannelInternal(id, createdBy);
    return channelToInfo(channel);
  }

  /**
   * Look up a channel without creating it. Returns undefined if absent.
   */
  getChannel(id: ChannelId): ChannelInfo | undefined {
    const channel = this.#channels.get(unbrand(id));
    return channel === undefined ? undefined : channelToInfo(channel);
  }

  /**
   * Whether a channel exists (created and not yet forgotten). Closed
   * channels still exist — they trap EBADF on use rather than vanishing.
   */
  hasChannel(id: ChannelId): boolean {
    return this.#channels.has(unbrand(id));
  }

  /**
   * Close a channel. Drops queued messages, rejects all waiters with
   * EBADF, and marks the channel closed. Subsequent send/recv trap.
   *
   * Idempotent: closing an already-closed channel is a no-op.
   */
  closeChannel(id: ChannelId, _opts: CloseChannelOptions = {}): void {
    const channel = this.#channels.get(unbrand(id));
    if (channel === undefined) return; // never existed; nothing to close
    if (channel.closed) return; // already closed

    channel.closed = true;
    channel.closedAt = this.#now();

    // Reject all parked waiters.
    const waiters = channel.waiters.splice(0);
    for (const w of waiters) {
      this.#settleWaiterReject(
        w,
        new CortexError('EBADF', 'recv', {
          message: `channel ${unbrand(id)} closed while waiting`,
          details: { channel: unbrand(id) },
        }),
      );
    }

    // Drop the queue. v0 does not attempt redelivery.
    channel.queue.length = 0;
  }

  /**
   * Channels a process has interacted with (sent to or received from),
   * in first-touch order. Used by `cortex channels <pid>` and by the
   * supervisor when cleaning up after a dead process.
   */
  channelsOf(pid: ProcessId): readonly ChannelId[] {
    const set = this.#memberships.get(unbrand(pid));
    if (set === undefined) return [];
    return [...set].map((s) => asChannelId(s));
  }

  /**
   * All known channels, in creation order. Diagnostic.
   */
  listChannels(): readonly ChannelInfo[] {
    return [...this.#channels.values()].map(channelToInfo);
  }

  // ---------------------------------------------------------------------------
  // §5.2 send
  // ---------------------------------------------------------------------------

  /**
   * Send a message. Non-blocking by default. Implicitly creates the
   * channel if absent (ABI.md §9.3).
   *
   * @param from    Sender (ProcessId for agent sends, ChannelId for
   *                system-originated messages).
   * @param to      Recipient (ProcessId routes to `pid:<n>` inbox;
   *                ChannelId routes directly).
   * @param body    Arbitrary payload. Must be CBOR-serializable since it
   *                lands in the .crec log.
   * @param opts    `blocking` (v0: only false honored), `queueLimit`.
   *
   * @throws CortexError EBADF if the channel is closed, EAGAIN if the
   *         queue is full and `blocking: false`, ESRCH if `to` is a
   *         ProcessId not in the table.
   */
  async send(
    from: ProcessId | ChannelId,
    to: ProcessId | ChannelId,
    body: unknown,
    opts: SendOptions = {},
  ): Promise<void> {
    const callId = this.#nextCallId();
    const channel = this.#resolveForSend(from, to);

    // ESRCH for ProcessId targets that don't exist.
    if (isProcessTarget(to) && !this.#table.has(to)) {
      const err = new CortexError('ESRCH', 'send', {
        message: `target process ${unbrand(to)} not in table`,
        details: { target: unbrand(to) },
      });
      await this.#recordTrap(from, 'send', callId, err, { target: unbrand(to) });
      throw err;
    }

    // Closed channel: EBADF + SIGPIPE on the sender.
    if (channel.closed) {
      const err = new CortexError('EBADF', 'send', {
        message: `channel ${unbrand(channel.id)} is closed`,
        details: { channel: unbrand(channel.id) },
      });
      await this.#recordTrap(from, 'send', callId, err, {
        target: unbrand(channel.id),
        closed: true,
      });
      if (this.#signals !== null && isProcessTarget(from) && this.#table.has(from)) {
        // Best-effort SIGPIPE; if delivery fails, the original EBADF still
        // propagates so the caller sees a single coherent error.
        try {
          await this.#signals.send(from, 'SIGPIPE');
        } catch {
          /* swallow */
        }
      }
      throw err;
    }

    // Queue limit check.
    const limit = opts.queueLimit ?? channel.queueLimit;
    if (limit >= 0 && channel.queue.length >= limit) {
      // v0 does not implement blocking sends. Honor `blocking: true` as
      // EAGAIN with a clear message rather than parking the sender on a
      // waiters list we don't yet have.
      const err = new CortexError('EAGAIN', 'send', {
        message: `channel ${unbrand(channel.id)} queue full (limit ${limit})`,
        details: { channel: unbrand(channel.id), queueDepth: channel.queue.length, limit },
      });
      await this.#recordTrap(from, 'send', callId, err, {
        target: unbrand(channel.id),
        queueDepth: channel.queue.length,
      });
      throw err;
    }

    const msg: IpcMessage = {
      from,
      to,
      body,
      sentAt: this.#now(),
      callId,
    };

    // Direct handoff if a waiter is parked.
    const waiter = channel.waiters.shift();
    if (waiter !== undefined) {
      const queueDepthBefore = channel.queue.length;
      channel.totalSent++;
      channel.totalRecv++;
      this.#trackMembership(from, channel.id);
      this.#trackMembership(waiter.pid, channel.id);
      try {
        await this.#recordSend(from, channel, msg, /* handedOff */ true, queueDepthBefore);
      } catch (err) {
        // Recording failed: the send did not take effect. Undo the handoff so
        // the waiter stays parked (a later send or the next recv can still be
        // served) and the counters reflect reality, then surface the error.
        // Channel-membership bookkeeping is diagnostic and left in place.
        channel.waiters.unshift(waiter);
        channel.totalSent--;
        channel.totalRecv--;
        throw err;
      }
      this.#settleWaiterResolve(waiter, msg);
      return;
    }

    // Otherwise enqueue.
    const queueDepthBefore = channel.queue.length;
    channel.queue.push(msg);
    channel.totalSent++;
    this.#trackMembership(from, channel.id);
    try {
      await this.#recordSend(from, channel, msg, /* handedOff */ false, queueDepthBefore);
    } catch (err) {
      // Roll back the enqueue: a failed send must leave no committed message.
      channel.queue.pop();
      channel.totalSent--;
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // §5.3 recv
  // ---------------------------------------------------------------------------

  /**
   * Receive a message. Blocking by default (ABI.md §4.5).
   *
   * @param pid     Calling process. Must be RUNNING.
   * @param source  Channel to read from. Defaults to the process's inbox
   *                (`pid:<n>`), which is the natural target for
   *                process-to-process messaging.
   * @param opts    `blocking` (default true), `timeoutMs` (-1 = forever).
   *
   * @returns The next message in FIFO order.
   *
   * @throws CortexError EBADF if the channel is closed, EAGAIN if
   *         non-blocking and the queue is empty, ETIMEDOUT if the timeout
   *         elapses, ESTATE if the caller is not RUNNING.
   */
  async recv(
    pid: ProcessId,
    source?: ChannelId,
    opts: RecvOptions = {},
  ): Promise<IpcMessage> {
    const callId = this.#nextCallId();
    const channelId = source ?? pidInboxChannel(pid);
    const blocking = opts.blocking ?? true;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_RECV_TIMEOUT_MS;

    const entry = this.#table.mustGet(pid, 'recv');
    if (entry.state !== 'running') {
      const err = new CortexError('ESTATE', 'recv', {
        message: `recv requires RUNNING state, got ${entry.state}`,
        details: { pid: unbrand(pid), state: entry.state },
      });
      await this.#recordTrap(pid, 'recv', callId, err, { source: unbrand(channelId) });
      throw err;
    }

    const channel = this.#ensureChannelInternal(channelId, pid);

    if (channel.closed) {
      const err = new CortexError('EBADF', 'recv', {
        message: `channel ${unbrand(channelId)} is closed`,
        details: { channel: unbrand(channelId) },
      });
      await this.#recordTrap(pid, 'recv', callId, err, { source: unbrand(channelId) });
      throw err;
    }

    this.#trackMembership(pid, channel.id);

    // Fast path: a message is already queued.
    const queued = channel.queue.shift();
    if (queued !== undefined) {
      channel.totalRecv++;
      await this.#recordRecv(pid, channel, queued, /* waitDurationMs */ 0);
      return queued;
    }

    // Empty queue + non-blocking → EAGAIN.
    if (!blocking) {
      const err = new CortexError('EAGAIN', 'recv', {
        message: `channel ${unbrand(channelId)} is empty`,
        details: { channel: unbrand(channelId) },
      });
      await this.#recordTrap(pid, 'recv', callId, err, {
        source: unbrand(channelId),
        nonBlocking: true,
      });
      throw err;
    }

    // Blocking path: park as a waiter, transition to BLOCKED.
    return await this.#parkRecvWaiter(pid, channel, callId, timeoutMs);
  }

  // ---------------------------------------------------------------------------
  // §5.4 Cancellation hook
  // ---------------------------------------------------------------------------

  /**
   * Cancel all waiters belonging to a process. Called by the kernel when
   * a process is killed (SIGKILL on a BLOCKED receiver) or otherwise
   * pulled out of BLOCKED state without a message arriving.
   *
   * The rejected error is EINTR with details explaining the cancellation
   * reason. The promise the agent is awaiting will throw.
   *
   * Idempotent: a process with no waiters is a no-op.
   */
  cancelWaitersFor(pid: ProcessId, reason = 'process-died'): number {
    const target = unbrand(pid);
    let cancelled = 0;
    for (const channel of this.#channels.values()) {
      const remaining: RecvWaiter[] = [];
      for (const w of channel.waiters) {
        if (unbrand(w.pid) === target) {
          this.#settleWaiterReject(
            w,
            new CortexError('EINTR', 'recv', {
              message: `recv cancelled: ${reason}`,
              details: { channel: unbrand(channel.id), reason },
            }),
          );
          cancelled++;
        } else {
          remaining.push(w);
        }
      }
      channel.waiters = remaining;
    }
    return cancelled;
  }

  // ---------------------------------------------------------------------------
  // §5.5 Internal: channel resolution
  // ---------------------------------------------------------------------------

  #ensureChannelInternal(id: ChannelId, createdBy: ProcessId | null): Channel {
    const key = unbrand(id);
    const existing = this.#channels.get(key);
    if (existing !== undefined) return existing;

    const channel: Channel = {
      id,
      createdAt: this.#now(),
      createdBy,
      closed: false,
      closedAt: null,
      queue: [],
      waiters: [],
      queueLimit: this.#defaultQueueLimit,
      totalSent: 0,
      totalRecv: 0,
    };
    this.#channels.set(key, channel);
    return channel;
  }

  /**
   * Resolve the channel for a `send` call. Verifies the sender exists if
   * it's a ProcessId.
   */
  #resolveForSend(from: ProcessId | ChannelId, to: ProcessId | ChannelId): Channel {
    if (isProcessTarget(from) && !this.#table.has(from)) {
      trap('ESRCH', 'send', {
        pid: unbrand(from),
        reason: 'sender not in table',
      });
    }
    const id = resolveChannel(to);
    const createdBy = isProcessTarget(from) ? from : null;
    return this.#ensureChannelInternal(id, createdBy);
  }

  // ---------------------------------------------------------------------------
  // §5.6 Internal: blocking recv
  // ---------------------------------------------------------------------------

  async #parkRecvWaiter(
    pid: ProcessId,
    channel: Channel,
    callId: string,
    timeoutMs: number,
  ): Promise<IpcMessage> {
    const startedAt = this.#now();

    // Transition the process to BLOCKED *before* registering the waiter.
    // This is async (the recorder write awaits), which opens a race window:
    // a `send()` arriving during the await sees no waiter and enqueues the
    // message instead of handing off. We close the window below by
    // re-checking the queue synchronously after registration — if a message
    // landed during the await, we settle immediately rather than parking.
    this.#table.setBlockedOn(pid, { kind: 'recv', channel: channel.id });
    await this.#table.setState(pid, 'blocked', {
      trigger: 'recv',
      channel: unbrand(channel.id),
      callId,
    });

    return await new Promise<IpcMessage>((resolve, reject) => {
      const waiter: RecvWaiter = {
        pid,
        callId,
        channel: channel.id,
        registeredAt: startedAt,
        resolve: (msg) => {
          // Wrap resolution so we can transition state and record before
          // handing the message back to the agent.
          void (async () => {
            try {
              const waitMs = durationMs(waiter.registeredAt, this.#now());
              await this.#recordRecv(pid, channel, msg, waitMs);
              // BLOCKED → READY. The scheduler dispatches READY → RUNNING
              // later; the promise resolves now so the agent's `await`
              // unblocks the moment the message is in hand.
              const cur = this.#table.get(pid);
              if (cur !== undefined && cur.state === 'blocked') {
                await this.#table.setState(pid, 'ready', {
                  trigger: 'recv-wake',
                  channel: unbrand(channel.id),
                  callId,
                });
              }
              // The message is in hand, but the body may only resume once the
              // scheduler has put the process back in RUNNING — otherwise its
              // next syscall runs against the transient READY above and traps
              // ESTATE. See wake_gate.ts.
              this.#settleWake(pid, () => resolve(msg));
            } catch (err) {
              // Recording or state-transition failure. Surface to the
              // awaiter; the message is still consumed (it was handed off
              // by send()).
              reject(err);
            }
          })();
        },
        reject: (err) => {
          void (async () => {
            try {
              const cur = this.#table.get(pid);
              if (cur !== undefined && cur.state === 'blocked') {
                // Pull out of BLOCKED so the process can be reaped or
                // rescheduled. READY is the safe landing spot.
                await this.#table.setState(pid, 'ready', {
                  trigger: 'recv-cancel',
                  channel: unbrand(channel.id),
                  callId,
                });
              }
              if (isCortexError(err)) {
                await this.#recordTrap(pid, 'recv', callId, err, {
                  source: unbrand(channel.id),
                });
              }
            } finally {
              // Same reasoning as the resolve path: hand the rejection to the
              // agent on its next dispatch, not mid-wake.
              this.#settleWake(pid, () => reject(err));
            }
          })();
        },
        timer: null,
        settled: false,
      };

      if (timeoutMs >= 0) {
        waiter.timer = this.#setTimeout(() => {
          if (waiter.settled) return;
          // Remove from the channel's waiters list.
          const idx = channel.waiters.indexOf(waiter);
          if (idx >= 0) channel.waiters.splice(idx, 1);
          waiter.reject(
            new CortexError('ETIMEDOUT', 'recv', {
              message: `recv timed out after ${timeoutMs}ms`,
              details: { channel: unbrand(channel.id), timeoutMs },
            }),
          );
        }, timeoutMs);
        // Don't keep the event loop alive just for this timer.
        if (typeof waiter.timer === 'object' && waiter.timer !== null && 'unref' in waiter.timer) {
          (waiter.timer as { unref?: () => void }).unref?.();
        }
      }

      channel.waiters.push(waiter);

      // Race-window close: a send() that arrived during the setState await
      // above enqueued a message without finding a waiter. Now that we are
      // registered, drain it immediately so we don't park forever. This
      // runs synchronously after the push, so no further send can interleave
      // between registration and this check.
      const late = channel.queue.shift();
      if (late !== undefined) {
        const idx = channel.waiters.indexOf(waiter);
        if (idx >= 0) channel.waiters.splice(idx, 1);
        channel.totalRecv++;
        this.#settleWaiterResolve(waiter, late);
      }
    });
  }

  /**
   * Settle a parked `recv()`: either run `fn` now (no gate configured — the
   * host's continuations run to completion and never race the state machine) or
   * defer it to the receiver's next dispatch. See `wake_gate.ts`.
   */
  #settleWake(pid: ProcessId, fn: () => void): void {
    if (this.#wakeGate === null) {
      fn();
      return;
    }
    this.#wakeGate.defer(pid, fn);
  }

  // ---------------------------------------------------------------------------
  // §5.7 Internal: waiter settlement
  // ---------------------------------------------------------------------------

  #settleWaiterResolve(w: RecvWaiter, msg: IpcMessage): void {
    if (w.settled) return;
    w.settled = true;
    if (w.timer !== null) {
      this.#clearTimeout(w.timer);
      w.timer = null;
    }
    w.resolve(msg);
  }

  #settleWaiterReject(w: RecvWaiter, err: unknown): void {
    if (w.settled) return;
    w.settled = true;
    if (w.timer !== null) {
      this.#clearTimeout(w.timer);
      w.timer = null;
    }
    w.reject(err);
  }

  // ---------------------------------------------------------------------------
  // §5.8 Internal: membership tracking
  // ---------------------------------------------------------------------------

  #trackMembership(who: ProcessId | ChannelId, channel: ChannelId): void {
    if (!isProcessTarget(who)) return;
    const key = unbrand(who);
    let set = this.#memberships.get(key);
    if (set === undefined) {
      set = new Set();
      this.#memberships.set(key, set);
    }
    set.add(unbrand(channel));
  }

  // ---------------------------------------------------------------------------
  // §5.9 Internal: recording
  // ---------------------------------------------------------------------------

  /**
   * Append a `send` exit record to the sender's .crec log. Best-effort:
   * a missing recorder (null factory) is a silent no-op so smoke tests
   * can run without disk I/O.
   */
  async #recordSend(
    from: ProcessId | ChannelId,
    channel: Channel,
    msg: IpcMessage,
    handedOff: boolean,
    queueDepthBefore: number,
  ): Promise<void> {
    if (!isProcessTarget(from)) return; // system-originated; no log to write to
    const recorder = this.#table.recorderFor(from);
    if (recorder === null) return;

    const entry = this.#table.get(from);
    const state: ProcessState = entry?.state ?? 'running';

    const record: SyscallRecordInput = {
      timestamp: msg.sentAt,
      pid: from,
      syscall: 'send',
      callId: msg.callId ?? `send-${unbrand(from)}-${Date.now()}`,
      phase: 'exit',
      args: {
        target: unbrand(channel.id),
        targetKind: 'channel',
        body: msg.body,
        toPid: isProcessTarget(msg.to) ? unbrand(msg.to) : null,
        queueDepth: queueDepthBefore,
        handedOff,
      },
      stateBefore: state,
      stateAfter: state,
      // Idempotent until consumed; we record the ambiguity honestly per
      // ABI.md §4.5. Once a recv pulls it, the recv record marks the
      // irreversible consumption.
      reversibility: 'idempotent',
      kernelAbiVersion: this.kernelAbiVersion,
    };

    try {
      await recorder.append(record);
    } catch (err) {
      if (isCortexError(err)) throw err;
      throw new CortexError('ERECORD', 'send', {
        message: `failed to record send to ${unbrand(channel.id)}`,
        cause: err,
      });
    }
  }

  async #recordRecv(
    pid: ProcessId,
    channel: Channel,
    msg: IpcMessage,
    waitDurationMs: number,
  ): Promise<void> {
    const recorder = this.#table.recorderFor(pid);
    if (recorder === null) return;

    const entry = this.#table.get(pid);
    const state: ProcessState = entry?.state ?? 'running';

    const record: SyscallRecordInput = {
      timestamp: this.#now(),
      pid,
      syscall: 'recv',
      callId: msg.callId ?? `recv-${unbrand(pid)}-${Date.now()}`,
      phase: 'exit',
      args: {
        source: unbrand(channel.id),
        sourceKind: 'channel',
        waitDurationMs,
      },
      result: { from: msg.from, to: msg.to, body: msg.body, sentAt: msg.sentAt },
      stateBefore: state,
      stateAfter: state,
      // The message is gone from the queue; consumption is irreversible.
      reversibility: 'irreversible',
      kernelAbiVersion: this.kernelAbiVersion,
      ...(waitDurationMs > 0 ? { durationMs: waitDurationMs } : {}),
    };

    try {
      await recorder.append(record);
    } catch (err) {
      if (isCortexError(err)) throw err;
      throw new CortexError('ERECORD', 'recv', {
        message: `failed to record recv from ${unbrand(channel.id)}`,
        cause: err,
      });
    }
  }

  async #recordTrap(
    who: ProcessId | ChannelId,
    syscall: 'send' | 'recv',
    callId: string,
    err: CortexError,
    extraArgs: Record<string, unknown>,
  ): Promise<void> {
    if (!isProcessTarget(who)) return;
    const recorder = this.#table.recorderFor(who);
    if (recorder === null) return;

    const entry = this.#table.get(who);
    const state: ProcessState = entry?.state ?? 'running';

    const record: SyscallRecordInput = {
      timestamp: this.#now(),
      pid: who,
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

    try {
      await recorder.append(record);
    } catch (recordErr) {
      // Recording failure during a trap path is doubly unfortunate, but
      // the original error is more important to surface. Swallow.
      void recordErr;
    }
  }
}

// =============================================================================
// §6. Helpers
// =============================================================================

function channelToInfo(c: Channel): ChannelInfo {
  return {
    id: c.id,
    createdAt: c.createdAt,
    createdBy: c.createdBy,
    closed: c.closed,
    closedAt: c.closedAt,
    queueDepth: c.queue.length,
    waiterCount: c.waiters.length,
    queueLimit: c.queueLimit,
    totalSent: c.totalSent,
    totalRecv: c.totalRecv,
  };
}

/**
 * Compute the millisecond duration between two ISO timestamps. Returns 0
 * if either is unparseable (defensive — should not happen with our
 * controlled clock).
 */
function durationMs(startIso: Timestamp, endIso: Timestamp): number {
  const a = Date.parse(startIso);
  const b = Date.parse(endIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, b - a);
}
