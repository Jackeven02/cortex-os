/**
 * cortex CLI — the live-kernel client.
 *
 * The other half of {@link module:cli/kernel_server}: finds the kernel that
 * published itself in this directory's `kernel.json`, connects to it, and
 * issues commands.
 *
 * ## Probing before trusting
 *
 * {@link probeKernel} distinguishes three situations that look alike from the
 * outside and must not be confused:
 *
 *   - **absent** — no kernel ever published itself here. The CLI is in the
 *     short-lived disk model; it can read files but not reach a live agent.
 *   - **stale** — a descriptor exists but nothing is listening. The kernel
 *     crashed, or was killed with `SIGKILL`. The files are still there; the
 *     live one is not.
 *   - **live** — the kernel answered a `ping`.
 *
 * The distinction is the whole point of the probe. A CLI that cannot tell
 * "stale" from "absent" will report "no such process" for a kernel that is
 * merely unreachable, and the operator will go looking for a bug that is
 * actually a crashed daemon.
 *
 * @module cli/kernel_client
 */

import { connect, type Socket } from 'node:net';

import { readEndpoint, type KernelEndpoint } from './kernel_endpoint.js';
import {
  encodeFrame,
  LineDecoder,
  parseFrame,
  KERNEL_PROTOCOL_VERSION,
  type KernelCommand,
  type KernelResponseErr,
} from './kernel_protocol.js';

/**
 * A connection to a live kernel.
 *
 * One socket, many requests: the client multiplexes them by `id`, so an
 * interactive session can keep one connection open and issue a `send` per
 * keystroke-line without reconnecting.
 */
export class KernelClient {
  readonly endpoint: KernelEndpoint;

  #socket: Socket;
  #decoder = new LineDecoder();
  #nextId = 0;
  #pending = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  /** Subscribe request id → the handler that wants its events. */
  #events = new Map<string, (event: unknown) => void>();
  #closed = false;
  /** Set when *we* closed the connection, as opposed to it ending. */
  #closedByUs = false;
  /** Why the connection ended, once it has. */
  #closeReason: Error | undefined;
  #closeHandlers = new Set<(reason: Error) => void>();

  constructor(endpoint: KernelEndpoint, socket: Socket) {
    this.endpoint = endpoint;
    this.#socket = socket;

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      for (const line of this.#decoder.push(chunk)) {
        this.#resolveLine(line);
      }
    });
    socket.on('close', () => {
      const err = new Error('connection closed');
      // The connection is gone *now* — whether we asked for it or not. A
      // caller that checks `closed` to decide whether the kernel left must
      // not be told "still open" just because this end was not our doing.
      this.#closed = true;
      this.#failAll(err);
      // A close we asked for is not the kernel going away. Only an *un*
      // asked-for end is news, and only the news is worth reporting.
      if (!this.#closedByUs) this.#notifyClose(err);
    });
    socket.on('error', (err: Error) => {
      this.#closed = true;
      this.#failAll(err);
      if (!this.#closedByUs) this.#notifyClose(err);
    });
  }

  /**
   * Whether the connection to the kernel is gone.
   *
   * `close()` sets it too — but a command that closed the connection itself
   * knows why, and does not need the diagnosis.
   */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Be told when the connection to the kernel ends — for any reason other
   * than this client closing it.
   *
   * ## Why this exists
   *
   * A long-lived command (a `watch`, a `supervise`, a `wait`) can have the
   * kernel pulled out from under it. Without this, the command's fate
   * depends on what else its event loop happens to be holding: `cortex
   * watch` used to **exit silently with a success code** — which reads as
   * "the watch finished" — and `cortex supervise` used to **hang forever**,
   * leaving the process it was supervising unobserved.
   *
   * The handler is called once. If the connection has already ended, it is
   * called immediately, so a caller cannot miss the event by subscribing
   * late.
   */
  onClose(handler: (reason: Error) => void): void {
    if (this.#closeReason !== undefined) {
      handler(this.#closeReason);
      return;
    }
    this.#closeHandlers.add(handler);
  }

  /**
   * Issue a command and wait for its response.
   *
   * @throws Error with the kernel's own errno in the message when the
   *         command failed. Use {@link requestRaw} when the errno matters.
   */
  async request<T = unknown>(cmd: KernelCommand, args?: Record<string, unknown>): Promise<T> {
    const response = await this.requestRaw(cmd, args);
    if (response.ok) return response.result as T;
    throw new KernelCommandError(response.error.errno, response.error.message, response.error.details);
  }

  /**
   * Issue a command and return the raw response frame — success or failure.
   *
   * The failure path is a *response*, not a broken connection, so a caller
   * that wants the kernel's errno (`ESRCH`, `EINVAL`, `EPERM`) gets it
   * instead of a generic socket error.
   */
  async requestRaw(cmd: KernelCommand, args?: Record<string, unknown>): Promise<KernelCommandResult> {
    if (this.#closed) throw new Error('connection to the kernel is closed');
    const id = String(++this.#nextId);
    return await this.#send(id, cmd, args);
  }

  /**
   * Subscribe to the kernel's event stream.
   *
   * The kernel acknowledges the request like any other command, and then
   * *pushes* events on this same connection. The handler is registered
   **before** the request goes out, so an event the kernel emits while it is
   * still handling the request is not dropped on the floor — the ordering on
   * the wire can put an event ahead of the acknowledgement.
   *
   * @param handler Called for every event the kernel pushes.
   * @param args    Optional filter: `{ pid?: number, kinds?: string[] }`.
   * @returns A function that cancels the subscription.
   * @throws KernelCommandError when the kernel refuses the subscription.
   */
  async subscribe(
    handler: (event: unknown) => void,
    args?: Record<string, unknown>,
  ): Promise<() => void> {
    if (this.#closed) throw new Error('connection to the kernel is closed');
    const id = String(++this.#nextId);
    this.#events.set(id, handler);
    try {
      const response = await this.#send(id, 'subscribe', args);
      if (!response.ok) {
        this.#events.delete(id);
        throw new KernelCommandError(
          response.error.errno,
          response.error.message,
          response.error.details,
        );
      }
    } catch (err) {
      this.#events.delete(id);
      throw err;
    }
    return () => {
      this.#events.delete(id);
    };
  }

  /** Write one request frame and wait for the response with the same id. */
  async #send(
    id: string,
    cmd: KernelCommand,
    args?: Record<string, unknown>,
  ): Promise<KernelCommandResult> {
    const frame: Record<string, unknown> = {
      v: KERNEL_PROTOCOL_VERSION,
      id,
      cmd,
      token: this.endpoint.token,
    };
    if (args !== undefined) frame['args'] = args;

    const settled = new Promise<KernelCommandResult>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });

    this.#socket.write(encodeFrame(frame));
    return await settled;
  }

  /** Close the connection. Idempotent. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    // Our own close is not news: the `onClose` handlers exist to report the
    // kernel going away, and a command that closed the connection because
    // it was finished must not be told the kernel left.
    this.#closedByUs = true;
    this.#failAll(new Error('connection closed'));
    this.#socket.destroy();
  }

  #resolveLine(line: string): void {
    let frame;
    try {
      frame = parseFrame(line);
    } catch (err) {
      this.#failAll(new Error(`malformed frame from the kernel: ${(err as Error).message}`));
      return;
    }

    // A pushed event is not a response: it carries the id of the subscribe
    // request that opened the stream, and it must not be mistaken for a
    // malformed response (which would fail every pending request on this
    // connection).
    if (frame.kind === 'event') {
      const handler = this.#events.get(frame.id);
      if (handler === undefined) return; // the subscription was cancelled
      try {
        handler(frame.event);
      } catch {
        // The handler is the caller's code. It must not be able to take the
        // connection — or the kernel — down with it.
      }
      return;
    }

    const response = frame.response;
    const waiter = this.#pending.get(response.id);
    if (waiter === undefined) return;
    this.#pending.delete(response.id);
    if (response.ok) {
      waiter.resolve({ ok: true, result: response.result });
    } else {
      const err = response as KernelResponseErr;
      waiter.resolve({ ok: false, error: err.error });
    }
  }

  #failAll(err: Error): void {
    const waiters = [...this.#pending.values()];
    this.#pending.clear();
    for (const waiter of waiters) waiter.reject(err);
  }

  /** Tell everyone watching that the connection has ended. */
  #notifyClose(reason: Error): void {
    if (this.#closeReason !== undefined) return;
    this.#closeReason = reason;
    const handlers = [...this.#closeHandlers];
    this.#closeHandlers.clear();
    for (const handler of handlers) {
      try {
        handler(reason);
      } catch {
        // The handler is the caller's code. It must not be able to take the
        // process down on the way out.
      }
    }
  }
}

/**
 * Explain why the connection to the kernel ended.
 *
 * The client knows *that* the connection ended; it does not know *why*. The
 * directory can usually tell: a kernel that shut down cleanly removes its
 * descriptor, a kernel that died leaves the descriptor behind with nothing
 * listening, and a kernel that was replaced leaves one that answers.
 *
 * The distinction matters to whoever was watching. "The kernel shut down" is
 * an ending; "the kernel died" is a failure; and neither of them is the same
 * as "the watch finished" — which is what a command that cannot tell the
 * difference ends up claiming.
 */
export async function explainKernelGone(dir: string): Promise<string> {
  let probe: KernelProbe;
  try {
    probe = await probeKernel(dir, { timeoutMs: 1000 });
  } catch {
    return 'the connection to the kernel was lost';
  }
  if (probe.kind === 'absent') return 'the kernel shut down';
  if (probe.kind === 'stale') {
    return `the connection to the kernel was lost — it looks like the kernel died (${probe.reason})`;
  }
  // A live kernel answered, so it is a different one.
  probe.client.close();
  return 'the kernel went away, and another one is now serving this directory';
}

/** A command's outcome: the kernel's payload, or the kernel's refusal. */
export type KernelCommandResult =
  | { readonly ok: true; readonly result: unknown }
  | {
      readonly ok: false;
      readonly error: {
        readonly errno: string;
        readonly message: string;
        readonly details?: unknown;
      };
    };

/** A command the kernel refused, carrying the kernel's own errno. */
export class KernelCommandError extends Error {
  readonly errno: string;
  readonly details: unknown;

  constructor(errno: string, message: string, details?: unknown) {
    super(message);
    this.errno = errno;
    this.details = details;
  }
}

/** The outcome of looking for a live kernel in a directory. */
export type KernelProbe =
  | { readonly kind: 'live'; readonly client: KernelClient }
  | { readonly kind: 'absent' }
  | { readonly kind: 'stale'; readonly endpoint: KernelEndpoint; readonly reason: string };

/**
 * Look for a live kernel in `dir`.
 *
 * Never throws for the ordinary "there is not one" cases: a missing
 * descriptor and an unreachable one are both *answers*, not failures.
 */
export async function probeKernel(
  dir: string,
  opts: { readonly timeoutMs?: number } = {},
): Promise<KernelProbe> {
  const endpoint = readEndpoint(dir);
  if (endpoint === undefined) return { kind: 'absent' };

  const timeoutMs = opts.timeoutMs ?? 2000;
  let socket: Socket;
  try {
    socket = await openSocket(endpoint, timeoutMs);
  } catch (err) {
    return { kind: 'stale', endpoint, reason: (err as Error).message };
  }

  const client = new KernelClient(endpoint, socket);
  try {
    // A liveness probe must be **bounded**. A kernel that accepts the
    // connection and then never answers — wedged, busy, half-dead — would
    // otherwise hang the command that asked, with nothing on the screen to
    // say why. `openSocket` bounds the connect; this bounds the answer.
    await withTimeout(
      client.request('ping'),
      timeoutMs,
      `the kernel did not answer within ${timeoutMs} ms`,
    );
  } catch (err) {
    client.close();
    return { kind: 'stale', endpoint, reason: (err as Error).message };
  }
  return { kind: 'live', client };
}

/**
 * Wait for `work`, but not forever.
 *
 * The timer is unreferenced: a pending timeout must never be the reason a
 * process stays alive.
 */
async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Open a TCP socket to the endpoint, failing fast on refusal. */
function openSocket(endpoint: KernelEndpoint, timeoutMs: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = connect({ host: endpoint.host, port: endpoint.port });
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}
