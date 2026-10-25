/**
 * cortex CLI — the kernel wire protocol.
 *
 * The framing and the message shapes shared by {@link module:cli/kernel_server}
 * and {@link module:cli/kernel_client}.
 *
 * ## Wire format
 *
 * Newline-delimited JSON over TCP. One JSON object per line, `\n`-terminated.
 * NDJSON is chosen over a length-prefixed binary frame because the whole
 * point of the transport is that a human can look at it: `nc 127.0.0.1 4242`
 * and type `{"v":1,"id":"1","cmd":"ps","token":"…"}` is a legitimate way to
 * ask the kernel what it is doing.
 *
 * ## What this protocol is *not*
 *
 * It is **not** part of the syscall ABI (docs/ABI.md, frozen at 1.0.0). It
 * carries no new syscalls and changes no errno contract: every command here
 * is answered by an existing kernel API, and every one of them lands in the
 * kernel's `.crec` log through the ordinary dispatcher path, so a remote
 * `cortex kill` is recorded exactly like a local one. The protocol has its
 * own version (`v`) because it is a separate surface with a separate
 * compatibility story.
 *
 * ## Requests
 *
 * ```json
 * {"v":1,"id":"7","cmd":"send","token":"…","args":{"pid":2,"message":"hi"}}
 * ```
 *
 * `id` correlates a response with its request. `token` is the per-kernel
 * shared secret (see `cli/kernel_endpoint`). `args` carries the command's
 * parameters and is absent for commands that take none.
 *
 * ## Responses
 *
 * ```json
 * {"v":1,"id":"7","ok":true,"result":{…}}
 * {"v":1,"id":"7","ok":false,"error":{"errno":"ESRCH","message":"…","details":{…}}}
 * ```
 *
 * A failed command is *not* a dropped connection: the error travels back as a
 * normal frame so the client can print the kernel's own errno instead of
 * guessing. `errno` is one of the kernel's errnos (docs/ABI.md §3.2) when the
 * failure came from the kernel, and `EFAULT` when it came from the transport.
 *
 * ## Events (the transport carries streams too)
 *
 * A client that asks to `subscribe` gets an ordinary acknowledgement, and
 * then the kernel *pushes* frames on the same socket:
 *
 * ```json
 * {"v":1,"id":"9","event":{"kind":"record","pid":2,"record":{…}}}
 * ```
 *
 * The `id` is the id of the `subscribe` request, so a client multiplexing
 * several subscriptions on one connection can tell them apart. An event frame
 * is the only frame without an `ok` field — that is what distinguishes it
 * from a response, and `parseFrame` is what tells them apart safely.
 *
 * The event payload is whatever the kernel reports (see `KernelEvent` in
 * `kernel/boot.ts`). The transport does not interpret it and does not get to
 * decide what a subscriber may see: the kernel filters, the transport carries.
 *
 * @module cli/kernel_protocol
 */

/** Version of the wire protocol. Bumped only on a breaking frame change. */
export const KERNEL_PROTOCOL_VERSION = 1;

/**
 * The commands a client may issue.
 *
 * `ping` and `shutdown` are transport-level: they are *not* syscalls and are
 * deliberately not recorded in the `.crec` log. `ps` and `memory` are the
 * operator *looking* at the kernel's state rather than acting through it, so
 * they are not recorded either — a monitoring loop that polls every second
 * would otherwise grow the log without doing any work. `wait` is the same
 * shape: an operator waiting for a process to end is not something the
 * process did.
 *
 * `subscribe` is the odd one: it is the only command that makes the kernel
 * *push* rather than answer. It opens a stream on the same socket and is not
 * recorded either — watching is not doing.
 *
 * `openCalls` is a read like `ps`: "which call is this process inside" is a
 * fact the kernel already has, and the host's alternative — reading the
 * whole log to pair the frames — costs O(bytes) for a fact the kernel has in
 * O(processes).
 *
 * `drivers` is a read of the same shape: "what can this kernel call, and
 * which of those calls never said whether they can be undone" is a fact the
 * *registry* already has, and the host's alternative — booting a second
 * kernel to ask — answers about a different kernel than the one running the
 * agents. It is a read, so it is not recorded either.
 *
 * `limit` is a read *and* a write, and it is the operator's own verb on a
 * process's budget: read it, or change the ceiling. It is not a syscall —
 * the ABI has no `set_budget` — so it is answered by the kernel's own
 * accounting rather than through the dispatcher, and it is not recorded. The
 * budget a *process* sees is still read through the `budget()` syscall
 * (ABI.md §4.8), which the ABI leaves unrecorded on purpose.
 *
 * `renice` is the operator's verb on a process's **rank**, and it is the same
 * shape: not a syscall (the ABI has no `renice`), answered by the kernel's
 * own scheduler. It is not recorded as a *syscall* either — the process did
 * not do it — but it is recorded as a `__sched` frame, because the rank
 * already has a history in that log (the scheduler writes the rank on every
 * yield) and a change to it belongs beside that history. A budget ceiling is
 * the opposite case: the ABI leaves budgets out of the log on purpose, so a
 * change to one starts no history and leaves none.
 *
 * Everything else is answered by the ordinary dispatcher path and therefore
 * is recorded.
 */
export type KernelCommand =
  | 'ping'
  | 'ps'
  | 'openCalls'
  | 'drivers'
  | 'daemons'
  | 'memory'
  | 'send'
  | 'kill'
  | 'limit'
  | 'renice'
  | 'wait'
  | 'subscribe'
  | 'checkpoint'
  | 'restore'
  | 'spawn'
  | 'fork'
  | 'shutdown';

/** A request frame. */
export interface KernelRequest {
  readonly v: number;
  readonly id: string;
  readonly cmd: KernelCommand;
  readonly token: string;
  readonly args?: Record<string, unknown>;
}

/** A successful response frame. */
export interface KernelResponseOk {
  readonly v: number;
  readonly id: string;
  readonly ok: true;
  readonly result: unknown;
}

/** A failed response frame. */
export interface KernelResponseErr {
  readonly v: number;
  readonly id: string;
  readonly ok: false;
  readonly error: {
    readonly errno: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

/** Either response frame. */
export type KernelResponse = KernelResponseOk | KernelResponseErr;

/**
 * A pushed event frame.
 *
 * The kernel tells a subscriber that something happened. The `id` is the id of
 * the `subscribe` request that opened the stream, so one connection can carry
 * several subscriptions.
 */
export interface KernelEventFrame {
  readonly v: number;
  readonly id: string;
  readonly event: unknown;
}

/** Either kind of frame a client can receive. */
export type KernelFrame =
  | { readonly kind: 'response'; readonly response: KernelResponse }
  | { readonly kind: 'event'; readonly id: string; readonly event: unknown };

/** Encode one frame as a wire line (including its terminator). */
export function encodeFrame(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * Parse one wire line into a response frame.
 *
 * @throws Error when the line is not a well-formed response. Callers turn
 *         this into `EFAULT` rather than letting a malformed frame look like
 *         a kernel failure.
 */
export function decodeResponse(line: string): KernelResponse {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('response is not an object');
  }
  const r = parsed as {
    id?: unknown;
    ok?: unknown;
    result?: unknown;
    error?: { errno?: unknown; message?: unknown; details?: unknown };
  };
  if (typeof r.id !== 'string') throw new Error('response has no id');
  if (r.ok !== true && r.ok !== false) throw new Error('response has no ok flag');
  if (r.ok === false) {
    const e = r.error;
    if (typeof e !== 'object' || e === null) throw new Error('error response has no error');
    return {
      v: KERNEL_PROTOCOL_VERSION,
      id: r.id,
      ok: false,
      error: {
        errno: typeof e.errno === 'string' ? e.errno : 'EFAULT',
        message: typeof e.message === 'string' ? e.message : 'unknown error',
        ...(e.details !== undefined ? { details: e.details } : {}),
      },
    };
  }
  return { v: KERNEL_PROTOCOL_VERSION, id: r.id, ok: true, result: r.result };
}

/**
 * Parse one wire line into a frame — a response, or a pushed event.
 *
 * The two are told apart by the `event` field: a response always has an `ok`
 * flag, an event never does. Deciding this *before* trying to decode a
 * response is what keeps a pushed event from being reported as a malformed
 * response (and from failing every pending request on the connection).
 *
 * @throws Error when the line is not a well-formed frame. Callers turn this
 *         into `EFAULT` rather than letting a malformed frame look like a
 *         kernel failure.
 */
export function parseFrame(line: string): KernelFrame {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('frame is not an object');
  }
  const id = (parsed as { id?: unknown }).id;
  if (typeof id !== 'string') throw new Error('frame has no id');
  if ('event' in (parsed as Record<string, unknown>)) {
    return { kind: 'event', id, event: (parsed as { event: unknown }).event };
  }
  return { kind: 'response', response: decodeResponse(line) };
}

/**
 * Splits a byte stream into complete lines.
 *
 * TCP hands us arbitrary chunks — a frame can arrive in three pieces, or
 * three frames can arrive in one — so the framing has to be buffered rather
 * than assumed. A trailing partial line stays in the buffer until the rest of
 * it arrives.
 */
export class LineDecoder {
  #buffer = '';

  /** Feed a chunk of decoded text; return whatever complete lines it produced. */
  push(chunk: string): string[] {
    this.#buffer += chunk;
    const lines: string[] = [];
    let index = this.#buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.#buffer.slice(0, index).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.length > 0) lines.push(line);
      index = this.#buffer.indexOf('\n');
    }
    return lines;
  }

  /** The bytes buffered so far that have not yet formed a complete line. */
  get pending(): string {
    return this.#buffer;
  }
}
