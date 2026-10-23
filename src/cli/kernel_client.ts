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
  decodeResponse,
  encodeFrame,
  LineDecoder,
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
  #closed = false;

  constructor(endpoint: KernelEndpoint, socket: Socket) {
    this.endpoint = endpoint;
    this.#socket = socket;

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      for (const line of this.#decoder.push(chunk)) {
        this.#resolveLine(line);
      }
    });
    socket.on('close', () => this.#failAll(new Error('connection closed')));
    socket.on('error', (err: Error) => this.#failAll(err));
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
    this.#failAll(new Error('connection closed'));
    this.#socket.destroy();
  }

  #resolveLine(line: string): void {
    let response;
    try {
      response = decodeResponse(line);
    } catch (err) {
      this.#failAll(new Error(`malformed response from the kernel: ${(err as Error).message}`));
      return;
    }
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
    await client.request('ping');
  } catch (err) {
    client.close();
    return { kind: 'stale', endpoint, reason: (err as Error).message };
  }
  return { kind: 'live', client };
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
