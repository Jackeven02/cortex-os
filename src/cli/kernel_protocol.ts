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
 * would otherwise grow the log without doing any work. Everything else is
 * answered by the ordinary dispatcher path and therefore is recorded.
 */
export type KernelCommand =
  | 'ping'
  | 'ps'
  | 'memory'
  | 'send'
  | 'kill'
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
