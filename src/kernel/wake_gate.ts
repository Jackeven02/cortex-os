/**
 * cortex kernel — the wake gate.
 *
 * A tiny barrier that answers one question: **when is a parked agent
 * continuation allowed to resume?**
 *
 * ## Why this exists
 *
 * Since the cooperative-continuation rework (see boot.ts, "The execution
 * model"), an agent body is *not* run to completion inside the quantum that
 * dispatched it. It is started, and it then runs on Node's microtask/event
 * loop, independently of the scheduler. When the body awaits a kernel event —
 * `wait()` on a child, `recv()` on a channel — the syscall parks the process
 * (RUNNING → BLOCKED) and returns a pending Promise. The body is suspended at
 * that `await`.
 *
 * When the event arrives, two things must happen, and they must happen in this
 * order:
 *
 *   1. the process becomes schedulable again (BLOCKED → READY, adopted by
 *      `Scheduler.reconcile()`), and
 *   2. the body's Promise resolves, so its `await` returns.
 *
 * Doing (2) immediately — which is what a plain `resolve()` does — races (1).
 * The resolution is a microtask; the state transition behind it is an `await`
 * on the `.crec` recorder. So the body routinely resumes while the process is
 * still BLOCKED (or merely READY), and its very next syscall trips the uniform
 * state gate with `ESTATE`: `llm_call`, `tool_call`, `send`, `wait` and friends
 * are all `['running']`-only (docs/ABI.md §4).
 *
 * The gate makes the ordering explicit: a waker *defers* the resolution, and
 * the kernel *releases* it on the next dispatch — that is, at the moment the
 * scheduler has put the process back in RUNNING. This is the kernel-side
 * equivalent of a Unix wake-up: the sleeper is made runnable, and it actually
 * executes its next instruction only once it has been given the CPU.
 *
 * ## Ownership
 *
 * One instance per kernel, created by `boot.ts` and shared by the modules that
 * park continuations (`syscall_dispatcher` for `wait`, `ipc` for `recv`). The
 * release side is owned by the agent runner: `#runQuantum` calls `release()`
 * for a process whose body is already live, which is exactly "this process has
 * just been dispatched again."
 *
 * A process with nothing deferred is unaffected — `release()` is a no-op, which
 * is the common case (a body parked on a driver or timer, not on a kernel
 * event).
 *
 * See: docs/PROCESS.md §8.2; docs/ARCHITECTURE.md §4.8; boot.ts "The execution
 * model".
 *
 * @module kernel/wake_gate
 */

import type { ProcessId } from './types.js';
import { unbrand } from './types.js';

/** The deferred half of a wake: "let the parked continuation proceed." */
export type WakeFn = () => void;

/**
 * Per-process queue of deferred wake callbacks.
 *
 * Deliberately synchronous: deferring and releasing must not interleave with
 * the state machine's own `await`s, or we would reintroduce the race this class
 * exists to remove. `WakeFn`s themselves may start async work — that is fine,
 * it happens after the gate has opened.
 */
export class WakeGate {
  #pending = new Map<number, WakeFn[]>();

  /**
   * Park `fn` until `pid` is next dispatched. Used by the wakers
   * (`Dispatcher.#unpark`, `IpcEngine`'s recv wake) *instead of* resolving the
   * continuation directly.
   *
   * Callers are expected to have already made the process schedulable (BLOCKED
   * → READY); the gate only decides *when* the body resumes, never *whether*
   * the process is runnable.
   */
  defer(pid: ProcessId, fn: WakeFn): void {
    const key = unbrand(pid);
    const list = this.#pending.get(key);
    if (list === undefined) {
      this.#pending.set(key, [fn]);
    } else {
      list.push(fn);
    }
  }

  /**
   * Release every deferred wake for `pid`. Called by the agent runner on a
   * re-dispatch, when the process is back in RUNNING.
   *
   * A callback that throws would otherwise be swallowed by the `void`
   * continuation, so each is invoked in isolation: one bad wake cannot strand
   * the others. Errors propagate to the Node unhandled-rejection surface rather
   * than being silently lost.
   *
   * @returns the number of wakes released.
   */
  release(pid: ProcessId): number {
    const key = unbrand(pid);
    const list = this.#pending.get(key);
    if (list === undefined || list.length === 0) {
      this.#pending.delete(key);
      return 0;
    }
    this.#pending.delete(key);
    for (const fn of list) fn();
    return list.length;
  }

  /** Whether `pid` has a wake waiting to be released. */
  isPending(pid: ProcessId): boolean {
    const list = this.#pending.get(unbrand(pid));
    return list !== undefined && list.length > 0;
  }

  /**
   * Forget any deferred wake for `pid` without running it. Used on teardown
   * (a process reaped or killed while parked) so a dead process's gate cannot
   * leak a callback into a later dispatch of a recycled PID.
   */
  clear(pid: ProcessId): void {
    this.#pending.delete(unbrand(pid));
  }
}
