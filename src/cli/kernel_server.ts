/**
 * cortex CLI — the live-kernel server.
 *
 * The other half of {@link module:cli/kernel_endpoint}: a TCP server on
 * 127.0.0.1 that lets a separate `cortex` invocation act on a *running*
 * kernel instead of on the files it left behind.
 *
 * ## Why this matters
 *
 * Without a transport, `cortex send <pid> <msg>` is a recording, not a
 * delivery. The short-lived CLI model boots a kernel whose process table
 * holds exactly one entry (init), so a message addressed to a real agent has
 * nobody to land in, and `cortex kill <pid>` cannot signal a process that is
 * still running because there is no process to signal — it rewrites the
 * on-disk metadata and calls it a day. The daemon (`cortex daemon run`) is
 * the one command that keeps a kernel alive, and until now nothing could
 * reach inside it.
 *
 * ## The one rule
 *
 * **Every command here is answered by an existing kernel API, through the
 * ordinary dispatcher path.** A remote `cortex kill` is therefore recorded in
 * the kernel's `.crec` exactly like a local one — enter frame, exit frame,
 * the `__signal` record in the target's log — and a remote `cortex send` goes
 * through the same prepare/commit transaction that protects the message from
 * being half-delivered. The transport adds reachability; it does not add a
 * side door around the kernel's guarantees.
 *
 * The two exceptions are `ping` and `shutdown`, which are transport-level
 * housekeeping and deliberately leave no trace in the syscall log.
 *
 * ## The kernel stays transport-agnostic
 *
 * Nothing in `src/kernel/` knows this file exists. The server is a *client*
 * of the kernel — it calls `dispatcher.invoke` exactly as an agent's
 * `CortexContext` does — so the kernel never grows a networking dependency
 * and the CLI never grows a privileged back door into it.
 *
 * @module cli/kernel_server
 */

import { createServer, type Server, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';

import { asChannelId, asProcessId, type ProcessFilter, type Signal } from '../kernel/types.js';
import { isCortexError } from '../kernel/errors.js';
import { ALL_SIGNALS } from '../kernel/signals.js';
import type { Kernel } from '../kernel/boot.js';
import { type KernelEndpoint } from './kernel_endpoint.js';
import {
  encodeFrame,
  LineDecoder,
  KERNEL_PROTOCOL_VERSION,
  type KernelCommand,
  type KernelRequest,
} from './kernel_protocol.js';

/** Options for {@link startKernelServer}. */
export interface KernelServerOptions {
  /**
   * The interface to bind. Defaults to `127.0.0.1`.
   *
   * There is no supported way to bind a public interface: this endpoint can
   * signal processes and inject messages into running agents, and the token
   * is a bearer secret read from a file in the user's own directory.
   */
  readonly host?: string;
  /** The port to bind. Defaults to `0` — let the OS pick a free one. */
  readonly port?: number;
  /** The shared secret clients must present. Defaults to 32 random bytes. */
  readonly token?: string;
  /** ISO timestamp of when the kernel started. Defaults to now. */
  readonly startedAt?: string;
  /** Called when a client asks the kernel to shut down. */
  readonly onShutdown?: () => void | Promise<void>;
  /** Sink for one-line server diagnostics. Defaults to stderr. */
  readonly log?: (message: string) => void;
}

/** The default bind address. Loopback only, always. */
export const DEFAULT_KERNEL_HOST = '127.0.0.1';

/**
 * A running kernel server.
 *
 * Lifecycle: `startKernelServer()` binds the port and returns; `close()`
 * stops listening and drops the open connections. Closing is idempotent.
 */
export class LiveKernelServer {
  /** How clients reach this kernel. */
  readonly endpoint: KernelEndpoint;

  #server: Server;
  #sockets: Set<Socket>;
  #closed = false;

  constructor(endpoint: KernelEndpoint, server: Server, sockets: Set<Socket>) {
    this.endpoint = endpoint;
    this.#server = server;
    this.#sockets = sockets;
  }

  /** Stop serving. Idempotent; waits for the socket to close. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    // The open connections have to go first: `server.close()` waits for
    // them, so leaving a client connected would hang the shutdown instead
    // of ending it.
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
    });
  }
}

/**
 * Start serving a kernel over the loopback transport.
 *
 * The returned server is already listening: the endpoint's port is the one
 * the OS assigned, so the caller can publish it immediately.
 */
export async function startKernelServer(
  kernel: Kernel,
  opts: KernelServerOptions = {},
): Promise<LiveKernelServer> {
  const host = opts.host ?? DEFAULT_KERNEL_HOST;
  const token = opts.token ?? randomBytes(32).toString('hex');
  const startedAt = opts.startedAt ?? new Date().toISOString();
  const log = opts.log ?? ((message: string) => process.stderr.write(`${message}\n`));

  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    attachConnection(kernel, socket, token, opts, log);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(opts.port ?? 0, host);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('kernel server did not bind a TCP port');
  }

  const endpoint: KernelEndpoint = {
    host,
    port: address.port,
    pid: process.pid,
    token,
    startedAt,
    abiVersion: kernel.kernelAbiVersion,
    dir: kernel.dir,
  };

  return new LiveKernelServer(endpoint, server, sockets);
}

// =============================================================================
// Connection handling
// =============================================================================

function attachConnection(
  kernel: Kernel,
  socket: Socket,
  token: string,
  opts: KernelServerOptions,
  log: (message: string) => void,
): void {
  const decoder = new LineDecoder();
  socket.setEncoding('utf8');

  const cleanup = (): void => {
    socket.removeAllListeners();
  };
  socket.on('close', cleanup);
  socket.on('error', (err: Error) => {
    log(`[kernel] connection error: ${err.message}`);
    cleanup();
  });

  socket.on('data', (chunk: string) => {
    for (const line of decoder.push(chunk)) {
      void handleLine(kernel, socket, line, token, opts, log);
    }
  });
}

async function handleLine(
  kernel: Kernel,
  socket: Socket,
  line: string,
  token: string,
  opts: KernelServerOptions,
  log: (message: string) => void,
): Promise<void> {
  let request: KernelRequest;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    request = parsed as KernelRequest;
  } catch (err) {
    writeFrame(socket, {
      v: KERNEL_PROTOCOL_VERSION,
      id: '',
      ok: false,
      error: {
        errno: 'EPROTO',
        message: `malformed request: ${(err as Error).message}`,
      },
    });
    return;
  }

  const id = typeof request.id === 'string' ? request.id : '';
  if (request.v !== KERNEL_PROTOCOL_VERSION) {
    writeFrame(socket, {
      v: KERNEL_PROTOCOL_VERSION,
      id,
      ok: false,
      error: {
        errno: 'EPROTO',
        message: `unsupported protocol version ${String(request.v)} (this kernel speaks ${KERNEL_PROTOCOL_VERSION})`,
      },
    });
    return;
  }

  // The token check comes before the command dispatch and before anything
  // touches the kernel: an unauthenticated caller must not be able to probe
  // which commands exist.
  if (!tokensMatch(request.token, token)) {
    log('[kernel] rejected a request with a bad token');
    writeFrame(socket, {
      v: KERNEL_PROTOCOL_VERSION,
      id,
      ok: false,
      error: { errno: 'EPERM', message: 'bad token' },
    });
    return;
  }

  try {
    const result = await dispatch(kernel, request, opts, log);
    writeFrame(socket, { v: KERNEL_PROTOCOL_VERSION, id, ok: true, result });
  } catch (err) {
    writeFrame(socket, { v: KERNEL_PROTOCOL_VERSION, id, ok: false, error: toWireError(err) });
  }
}

/**
 * Compare two tokens without leaking their length through an early return.
 *
 * Not a defence against a determined local attacker with a debugger — it is
 * simply the habit that keeps a token comparison from being accidentally
 * short-circuited.
 */
function tokensMatch(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function writeFrame(socket: Socket, value: unknown): void {
  if (socket.destroyed) return;
  socket.write(encodeFrame(value));
}

/** Map a thrown error onto the wire's error shape. */
function toWireError(err: unknown): { errno: string; message: string; details?: unknown } {
  if (err instanceof WireError) {
    return { errno: err.errno, message: err.message };
  }
  if (isCortexError(err)) {
    return {
      errno: err.errno,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { errno: 'EFAULT', message };
}

// =============================================================================
// Command dispatch
// =============================================================================

async function dispatch(
  kernel: Kernel,
  request: KernelRequest,
  opts: KernelServerOptions,
  log: (message: string) => void,
): Promise<unknown> {
  const cmd: KernelCommand = request.cmd;
  const args = request.args ?? {};

  switch (cmd) {
    case 'ping':
      // Transport-level: deliberately not recorded in the syscall log.
      return {
        abiVersion: kernel.kernelAbiVersion,
        kernelPid: process.pid,
        startedAt: opts.startedAt ?? new Date().toISOString(),
        daemons: kernel.init.daemonCount,
      };

    case 'ps': {
      const filter = args['filter'] as ProcessFilter | undefined;
      const processes = await kernel.dispatcher.invoke(asProcessId(1), 'ps', filter);
      return { processes };
    }

    case 'send': {
      const message = args['message'];
      if (message === undefined) {
        throw new WireError('EINVAL', 'send requires a message');
      }
      const pid = args['pid'];
      const channel = args['channel'];

      if (pid !== undefined) {
        const target = asProcessId(Number(pid));
        if (!Number.isInteger(Number(pid))) {
          throw new WireError('EINVAL', `invalid pid: ${String(pid)}`);
        }
        if (kernel.table.get(target) === undefined) {
          throw new WireError('ESRCH', `no such process: ${Number(pid)}`);
        }
        await kernel.dispatcher.invoke(asProcessId(1), 'send', target, message);
        return { delivered: true, target: 'pid', pid: Number(pid) };
      }

      if (typeof channel === 'string' && channel.length > 0) {
        await kernel.dispatcher.invoke(asProcessId(1), 'send', asChannelId(channel), message);
        return { delivered: true, target: 'channel', channel };
      }

      throw new WireError('EINVAL', 'send requires a pid or a channel');
    }

    case 'kill': {
      const pid = Number(args['pid']);
      if (!Number.isInteger(pid)) {
        throw new WireError('EINVAL', `invalid pid: ${String(args['pid'])}`);
      }
      const signal = args['signal'];
      if (typeof signal !== 'string' || !ALL_SIGNALS.includes(signal as Signal)) {
        throw new WireError('EINVAL', `invalid signal: ${String(signal)}`);
      }
      const target = asProcessId(pid);
      const before = kernel.table.get(target)?.state;

      // Through the dispatcher, so the kill is recorded like any other
      // syscall — and so the capability gate applies to remote kills exactly
      // as it does to local ones.
      await kernel.dispatcher.invoke(asProcessId(1), 'kill', target, signal as Signal);

      // `kill` returns void (the ABI froze it that way), so the outcome is
      // read back off the table: a state that moved means the signal was
      // delivered, a signal now sitting in the pending queue means it was
      // queued, and neither means it was dropped (an `ignore` disposition,
      // or a no-op like SIGCONT from a process that is not stopped). A
      // process that is *gone* after the call died of the signal and was
      // reaped by init — the strongest evidence of delivery there is.
      const after = kernel.table.get(target);
      const outcome =
        after === undefined
          ? 'delivered'
          : after.pendingSignals.includes(signal as Signal)
            ? 'queued'
            : after.state !== before
              ? 'delivered'
              : 'dropped';
      return { outcome, pid, signal, state: after?.state ?? null };
    }

    case 'shutdown': {
      log('[kernel] shutdown requested by a client');
      // Answer first, then stop: the client is waiting on this frame.
      const done = opts.onShutdown;
      if (done !== undefined) {
        setTimeout(() => {
          void done();
        }, 0);
      }
      return { stopping: true };
    }

    default:
      throw new WireError('EPROTO', `unknown command: ${String(cmd)}`);
  }
}

/**
 * An error raised by the transport layer rather than by the kernel.
 *
 * `EINVAL` / `EPERM` / `EPROTO` are kernel errnos; `EFAULT` is the
 * transport's own "something broke that was not the caller's fault". None of
 * this extends the syscall ABI (docs/ABI.md §3.2) — a failed command is a
 * failed *request*, and the kernel's errno contract is untouched.
 */
class WireError extends Error {
  readonly errno: string;

  constructor(errno: string, message: string) {
    super(message);
    this.errno = errno;
  }
}
