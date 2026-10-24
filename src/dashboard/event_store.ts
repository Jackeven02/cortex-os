/**
 * cortex dashboard — the activity feed, read once and then followed.
 *
 * ## The problem it solves
 *
 * The activity panel used to be rebuilt from the disk on **every** change:
 * every `.crec` of every process was read from byte 0, every frame decoded,
 * and the newest few kept. That is O(the whole history) per change — and the
 * history of a long-lived agent is the thing that grows.
 *
 * Measured on a real directory with a real kernel's log: a 3 MB log cost
 * **154 ms** per read, and a 6 MB one cost **301 ms**. The dashboard read it
 * again every time the filesystem changed, which during a busy agent is
 * several times a second — so the operator's window got slower exactly as
 * the operator needed it.
 *
 * So the feed is **read once and then followed**: every process's log gets a
 * cursor, and every refresh reads only what has been written since. The
 * events are the same events the full scan produced — same frames, same
 * order, same conversion — and the difference is only how much of the file
 * was read to get them.
 *
 * ## What it keeps, and what it does not
 *
 * The store keeps the newest {@link MAX_EVENTS} events of each kind, the same
 * cap the API has always had. When something falls off the end, the store can
 * no longer answer for that window — and it says so
 * ({@link ActivityStore.covers}), so the caller falls back to the disk rather
 * than answering with a shorter history than the disk holds.
 *
 * ## Why the wording lives here
 *
 * The conversion from a syscall frame to an activity event is here, not in the
 * server, because two places that convert frames will convert them
 * differently, and the disk path and the push path must not be able to
 * disagree about what a frame means.
 */

import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import { existingCrecPath, LogTail } from '../kernel/recorder.js';
import { asProcessId, type SyscallRecord } from '../kernel/types.js';
import { listProcDirs, readAllMetas } from '../cli/process_store.js';

/**
 * How many events of each kind the store keeps.
 *
 * The same cap the API has always had: the newest few thousand, not all of
 * them. An activity panel is a window, not an archive.
 */
export const MAX_EVENTS = 5000;

/** A time window. */
export interface TimeRange {
  from?: number;
  to?: number;
}

/**
 * One event in the dashboard's activity panel.
 *
 * Derived from a syscall frame — the same frame the `.crec` log holds.
 */
export interface ActivityEvent {
  type: string;
  at: string;
  runId: string;
  pid: number;
  name: string;
  durationMs?: number;
  error?: string;
  errorMessage?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  usd?: number;
  audit?: Record<string, unknown>;
}

/**
 * Make an error message safe to show.
 *
 * An error message can carry a credential — an API key that failed, a token
 * that was rejected — and the dashboard is a page that can be screenshotted,
 * copied and pasted into a bug report. The raw message must never leave the
 * API; the shape of it is what the operator needs.
 */
export function safeErrorMessage(message: string): string {
  return message
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/(authorization|api[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, 240);
}

/**
 * Turn a syscall frame into an activity event — or `undefined` when the frame
 * is not one the dashboard shows.
 *
 * Two rules, and they are the same rules the log view uses: a call's `enter`
 * frame is not an event (the `exit` frame is), and the kernel's own
 * `__`-prefixed bookkeeping frames are not the agent's work.
 */
export function toActivityEvent(record: SyscallRecord, pid: number): ActivityEvent | undefined {
  if (record.phase === 'enter' || record.syscall.startsWith('__')) return undefined;
  const type =
    record.syscall === 'llm_call'
      ? 'llm.call'
      : record.syscall === 'tool_call'
        ? 'tool.call'
        : `kernel.${record.syscall}`;
  // Tools may attach a generic `audit` object to their structured output. It
  // is passed through verbatim — the dashboard does not know (or care) what
  // domains put inside it.
  const toolResult = record.result as
    | { output?: { structured?: { audit?: Record<string, unknown> } } }
    | undefined;
  const audit = record.syscall === 'tool_call' ? toolResult?.output?.structured?.audit : undefined;
  const llmResult =
    record.syscall === 'llm_call'
      ? (record.result as
          | { model?: string; usage?: { inputTokens?: number; outputTokens?: number; usd?: number } }
          | undefined)
      : undefined;
  return {
    type,
    at: record.timestamp,
    runId: record.callId,
    pid,
    name: record.syscall,
    ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    ...(record.error !== undefined ? { error: record.error.errno } : {}),
    ...(record.error !== undefined ? { errorMessage: safeErrorMessage(record.error.message) } : {}),
    ...(llmResult?.model !== undefined ? { model: llmResult.model } : {}),
    ...(llmResult?.usage?.inputTokens !== undefined ? { tokensIn: llmResult.usage.inputTokens } : {}),
    ...(llmResult?.usage?.outputTokens !== undefined ? { tokensOut: llmResult.usage.outputTokens } : {}),
    ...(llmResult?.usage?.usd !== undefined ? { usd: llmResult.usage.usd } : {}),
    ...(audit !== undefined ? { audit } : {}),
  };
}

/**
 * The events the store holds, newest first, and what it can answer.
 */
export interface ActivityView {
  /** The events, newest first. */
  readonly events: readonly unknown[];
  /**
   * Whether the store holds everything the disk holds for this range.
   *
   * False means the window reaches back past what the store kept, and the
   * caller has to ask the disk — a shorter answer than the disk gives is not
   * an answer, it is a truncation the operator cannot see.
   */
  readonly covers: boolean;
}

/** How the store follows one JSONL file (the LangChain callback log). */
interface JsonlTail {
  /** The byte offset just past the last complete line. */
  offset: number;
  /** A line that was cut in half by the end of the file. */
  carry: string;
}

/**
 * An event with its moment already worked out.
 *
 * The timestamp is parsed **once**, when the event is read, because the
 * alternative is parsing it again for every comparison — and a request that
 * merges ten thousand events would then parse them ten thousand times, which
 * is more time than reading the file took.
 */
interface Timed<T> {
  readonly at: number;
  readonly value: T;
}

/**
 * Merge two newest-first lists into one newest-first list.
 *
 * Both lists are sorted by construction — new events are prepended in
 * timestamp order — so merging them is enough, and sorting the
 * concatenation is not. The difference is the difference between O(n) and
 * O(n log n) comparisons on every request.
 */
function mergeNewestFirst<T>(a: readonly Timed<T>[], b: readonly Timed<T>[]): Timed<T>[] {
  const out: Timed<T>[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    out.push(a[i]!.at >= b[j]!.at ? a[i++]! : b[j++]!);
  }
  while (i < a.length) out.push(a[i++]!);
  while (j < b.length) out.push(b[j++]!);
  return out;
}

/**
 * The activity feed, read incrementally.
 *
 * One store per dashboard. It is fed from the disk — every process's log gets
 * a {@link LogTail}, and the LangChain callback log gets a byte cursor — and
 * it answers with what it has read.
 */
export class ActivityStore {
  /** One tail per process, keyed by pid. */
  #tails = new Map<number, LogTail>();

  /** The syscall events, newest first. */
  #syscalls: Timed<ActivityEvent>[] = [];

  /** The LangChain callback events, newest first. */
  #callbacks: Timed<unknown>[] = [];

  /** The cursor into the LangChain callback log. */
  #callbacksTail: JsonlTail = { offset: 0, carry: '' };

  /**
   * The oldest event the store still holds, per kind.
   *
   * `undefined` means the store has never dropped anything, so it can answer
   * for any window. A number means everything older than it is gone.
   */
  #oldestSyscall: number | undefined;
  #oldestCallback: number | undefined;

  /** A refresh in flight, so two callers do not read the same bytes twice. */
  #pending: Promise<void> | undefined;

  /**
   * How many bytes the store has read from the logs, in total.
   *
   * It is here to be measured, not to be shown: "the dashboard does not
   * re-read what it already read" is a claim, and a claim about bytes needs
   * bytes.
   */
  #bytesRead = 0;

  /** How many bytes the store has read from the logs, in total. */
  get bytesRead(): number {
    return this.#bytesRead;
  }

  /** The events, newest first, filtered by the range. */
  read(range: TimeRange = {}): ActivityView {
    const filtering = range.from !== undefined || range.to !== undefined;
    const inRange = (at: number): boolean =>
      (range.from === undefined || at >= range.from) && (range.to === undefined || at <= range.to);
    const syscalls = filtering ? this.#syscalls.filter((e) => inRange(e.at)) : this.#syscalls;
    const callbacks = filtering ? this.#callbacks.filter((e) => inRange(e.at)) : this.#callbacks;
    const merged = mergeNewestFirst(callbacks, syscalls);
    return { events: merged.map((e) => e.value), covers: this.covers(range) };
  }

  /**
   * Whether the store holds everything the disk holds for this range.
   *
   * The store keeps the newest {@link MAX_EVENTS} of each kind. A window that
   * reaches back past the oldest one it kept is a window it cannot answer —
   * the caller has to ask the disk, because answering with a shorter history
   * than the disk holds would be a silent truncation.
   */
  covers(range: TimeRange = {}): boolean {
    if (range.from === undefined) return true;
    if (this.#oldestSyscall !== undefined && range.from <= this.#oldestSyscall) return false;
    if (this.#oldestCallback !== undefined && range.from <= this.#oldestCallback) return false;
    return true;
  }

  /**
   * Read whatever is new in every log, and remember it.
   *
   * Concurrent callers share one read: the second one waits for the first
   * rather than reading the same bytes again.
   */
  async refresh(dir: string): Promise<void> {
    this.#pending ??= this.#refresh(dir).finally(() => {
      this.#pending = undefined;
    });
    await this.#pending;
  }

  async #refresh(dir: string): Promise<void> {
    // Every process that has a log — running or finished.
    //
    // Scanning the metas alone would show a directory of corpses: a running
    // process has no `meta.json` yet (the kernel writes it when the process
    // exits), so its log — which is on disk all the same, and is being
    // appended to right now — would never be read. The agent that is working
    // is the one whose history the operator wants.
    const pids = new Set<number>([
      ...listProcDirs(dir).map((p) => p.pid),
      ...readAllMetas(dir).map((m) => m.pid),
    ]);

    // A process whose log is gone has no history any more, and neither have
    // we: keeping its events would be showing a past the disk has erased.
    for (const pid of [...this.#tails.keys()]) {
      if (!pids.has(pid)) {
        this.#tails.delete(pid);
        this.#syscalls = this.#syscalls.filter((e) => e.value.pid !== pid);
      }
    }

    const fresh: Timed<ActivityEvent>[] = [];
    for (const pid of [...pids].sort((a, b) => a - b)) {
      const path = existingCrecPath(dir, asProcessId(pid));
      if (!existsSync(path)) continue;
      let tail = this.#tails.get(pid);
      if (tail === undefined) {
        tail = new LogTail(path);
        this.#tails.set(pid, tail);
      }
      try {
        const result = await tail.read();
        this.#bytesRead += result.bytes;
        if (result.replaced) {
          // The log was replaced: what we derived from the old one is gone.
          this.#syscalls = this.#syscalls.filter((e) => e.value.pid !== pid);
        }
        for (const record of result.records) {
          const event = toActivityEvent(record, pid);
          if (event === undefined) continue;
          const at = Date.parse(event.at);
          if (!Number.isFinite(at)) continue;
          fresh.push({ at, value: event });
        }
      } catch {
        if (!existsSync(path)) {
          // The log is gone: the history it held is gone with it. Keeping the
          // events would be showing a past the disk has erased.
          this.#tails.delete(pid);
          this.#syscalls = this.#syscalls.filter((e) => e.value.pid !== pid);
        }
        // Otherwise the log is there and we could not read it — a log we
        // cannot read is a log we cannot learn from, and the rest of the feed
        // is still worth showing.
        continue;
      }
    }

    if (fresh.length > 0) {
      fresh.sort((a, b) => b.at - a.at);
      this.#syscalls = mergeNewestFirst(fresh, this.#syscalls);
      this.#trim();
    }

    await this.#refreshCallbacks(dir);
  }

  /** Read the LangChain callback log's new lines. */
  async #refreshCallbacks(dir: string): Promise<void> {
    const path = join(dir, 'integrations', 'langchain', 'events.jsonl');
    if (!existsSync(path)) return;
    let handle;
    try {
      handle = await open(path, 'r');
    } catch {
      return;
    }
    try {
      const { size } = await handle.stat();
      if (size < this.#callbacksTail.offset) {
        // Replaced: the lines we read are gone.
        this.#callbacks = [];
        this.#callbacksTail = { offset: 0, carry: '' };
      }
      const length = Math.max(0, size - this.#callbacksTail.offset);
      if (length === 0) return;
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, this.#callbacksTail.offset);
      this.#bytesRead += length;

      const previousCarry = this.#callbacksTail.carry;
      const text = previousCarry + buf.toString('utf8');
      const parts = text.split('\n');
      // The last piece is either an empty string (the file ended with a
      // newline) or a line the writer has not finished yet.
      const carry = parts.pop() ?? '';
      const fresh: Timed<unknown>[] = [];
      for (const line of parts) {
        if (line.length === 0) continue;
        try {
          const parsed = JSON.parse(line) as { at?: string };
          const at = Date.parse(String(parsed.at ?? ''));
          if (!Number.isFinite(at)) continue;
          fresh.push({ at, value: parsed });
        } catch {
          continue;
        }
      }
      // Only whole lines count: the bytes of a half-written line are not
      // consumed yet, so the next read starts where this one stopped.
      this.#callbacksTail.offset +=
        Buffer.byteLength(previousCarry, 'utf8') + length - Buffer.byteLength(carry, 'utf8');
      this.#callbacksTail.carry = carry;
      if (fresh.length > 0) {
        fresh.sort((a, b) => b.at - a.at);
        this.#callbacks = mergeNewestFirst(fresh, this.#callbacks);
        this.#trimCallbacks();
      }
    } catch {
      // A callback log we cannot read is not worth failing the feed over.
      return;
    } finally {
      await handle.close();
    }
  }

  /** Drop the oldest syscall events once there are too many. */
  #trim(): void {
    if (this.#syscalls.length <= MAX_EVENTS) return;
    this.#syscalls = this.#syscalls.slice(0, MAX_EVENTS);
    this.#oldestSyscall = this.#syscalls.at(-1)?.at;
  }

  /** Drop the oldest callback events once there are too many. */
  #trimCallbacks(): void {
    if (this.#callbacks.length <= MAX_EVENTS) return;
    this.#callbacks = this.#callbacks.slice(0, MAX_EVENTS);
    this.#oldestCallback = this.#callbacks.at(-1)?.at;
  }
}
