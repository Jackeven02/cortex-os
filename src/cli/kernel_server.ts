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
 * The exceptions are the four commands that are **not actions by an agent**,
 * and they are exceptions for that reason alone.
 *
 * - `ping` and `shutdown` are transport-level housekeeping.
 * - `ps` is the operator *looking* at the process table. The transport reads
 *   the table directly instead of making init call the `ps` syscall on the
 *   operator's behalf, because a monitoring loop that polls every second
 *   would otherwise write a frame into init's log for every poll — and a
 *   read is not something the kernel's causal history should record. (An
 *   agent's own `ctx.ps()` is still a syscall and is still recorded, per
 *   ABI.md §4.1. Only the transport's view of the table is not.)
 * - `memory` is the operator looking at what a process wrote down. Same
 *   reasoning: it is a read of the process's memory regions, not something
 *   the process did. (An agent's own `ctx.memory_read()` is still a syscall,
 *   and still recorded — ABI.md §4.4.)
 *
 * Everything that *acts* — `send`, `kill`, `checkpoint`, `restore`, `spawn` —
 * goes through the dispatcher, and is recorded exactly like the local
 * equivalent.
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

import {
  asChannelId,
  asChainId,
  asProcessId,
  unbrand,
  type AgentSpec,
  type BudgetLimits,
  type Capability,
  type MemoryRegionPolicy,
  type MemoryQuery,
  type ProcessFilter,
  type ProcessId,
  type Signal,
  type SpawnOptions,
} from '../kernel/types.js';
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

  // A long-running command (a `wait`) must not outlive the client that asked
  // for it: when the socket closes, the pending wait is cancelled so the
  // kernel does not hold a waiter for a process nobody is watching.
  const abort = new AbortController();

  const cleanup = (): void => {
    socket.removeAllListeners();
    abort.abort();
  };
  socket.on('close', cleanup);
  socket.on('error', (err: Error) => {
    log(`[kernel] connection error: ${err.message}`);
    cleanup();
  });

  socket.on('data', (chunk: string) => {
    for (const line of decoder.push(chunk)) {
      void handleLine(kernel, socket, line, token, opts, log, abort.signal);
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
  signal: AbortSignal,
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
    const result = await dispatch(kernel, request, opts, log, signal, socket);
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

/** The event kinds a subscriber may ask for. */
const KNOWN_EVENT_KINDS: ReadonlySet<string> = new Set([
  'process-start',
  'process-exit',
  'record',
  'output',
]);

/**
 * Parse the `kinds` filter of a `subscribe` request.
 *
 * Absent (or empty) means "everything". An unknown kind is **refused** rather
 * than ignored: a subscriber that asked for a kind that does not exist would
 * otherwise sit there waiting for something that can never arrive, and would
 * never find out why.
 */
function parseEventKinds(raw: unknown): Set<string> | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    throw new WireError('EINVAL', 'kinds must be an array of event kinds');
  }
  const kinds = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw new WireError('EINVAL', 'kinds must be an array of event kinds');
    }
    if (!KNOWN_EVENT_KINDS.has(item)) {
      throw new WireError(
        'EINVAL',
        `unknown event kind: ${item} (known: ${[...KNOWN_EVENT_KINDS].join(', ')})`,
      );
    }
    kinds.add(item);
  }
  return kinds.size === 0 ? null : kinds;
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

/**
 * States a snapshot may be taken from right now.
 *
 * `checkpoint` is legal from RUNNING and BLOCKED (docs/ABI.md §4.2) — the
 * states in which a process can take a syscall at all.
 */
const CHECKPOINTABLE: ReadonlySet<string> = new Set(['running', 'blocked']);

/**
 * How many entries of a region are read to answer "how much is in there?".
 *
 * The region *list* is a shape, not a dump: the operator wants to know that
 * an agent has 400 notes in `semantic`, not to read 400 notes to find out.
 * Past the cap the count is reported as a lower bound rather than growing
 * without limit.
 */
const REGION_COUNT_CAP = 1000;

/**
 * States that are worth waiting through.
 *
 * A process that has just been created or scheduled (`NEW` / `READY`) reaches
 * a checkpointable state within a tick, and one that is mid-snapshot
 * (`CHECKPOINTING`) leaves it as soon as the snapshot lands. Everything else
 * — stopped, suspended, exiting, zombie — is a state the operator has to
 * resolve first.
 */
const WORTH_WAITING: ReadonlySet<string> = new Set(['new', 'ready', 'checkpointing']);

/**
 * Wait until `pid` can be snapshotted.
 *
 * Returns false when the process is gone, or when it is in a state no
 * snapshot can be taken from and is not about to leave it.
 */
async function awaitCheckpointable(
  kernel: Kernel,
  pid: ProcessId,
  timeoutMs = 2000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entry = kernel.table.get(pid);
    if (entry === undefined) return false;
    if (CHECKPOINTABLE.has(entry.state)) return true;
    if (!WORTH_WAITING.has(entry.state)) return false;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function dispatch(
  kernel: Kernel,
  request: KernelRequest,
  opts: KernelServerOptions,
  log: (message: string) => void,
  signal: AbortSignal,
  socket: Socket,
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
      // A read, not an action: the transport asks the kernel what its process
      // table looks like, and that question is not the kernel's business to
      // record. Going through `dispatcher.invoke` here would make init call
      // the `ps` syscall on the operator's behalf and write a frame into
      // init's log for every poll — a monitoring loop would grow the log
      // without doing anything. An agent's own `ctx.ps()` is unaffected: that
      // is still a syscall, and still recorded (ABI.md §4.1).
      const processes = kernel.table.list(filter);
      return { processes };
    }

    case 'openCalls': {
      // A read, like `ps`: the operator asking which call an agent is in is
      // not something the agent did, so it is not recorded. The kernel's own
      // bookkeeping answers it — the same pairing the log shows, kept as it
      // happens — so the host does not have to read a log that grows for as
      // long as the agent runs.
      const calls = [...kernel.openCalls().entries()].map(([pid, call]) => ({
        pid,
        syscall: call.syscall,
        callId: call.callId,
        since: call.since,
        // The arguments travel with the call, because they are what say a
        // `wait` is a *declared* wait — one that carries its own deadline.
        ...(call.args !== undefined ? { args: call.args } : {}),
      }));
      return { calls };
    }

    case 'memory': {
      const pid = Number(args['pid']);
      if (!Number.isInteger(pid)) {
        throw new WireError('EINVAL', `invalid pid: ${String(args['pid'])}`);
      }
      const target = asProcessId(pid);
      const entry = kernel.table.get(target);
      if (entry === undefined) {
        throw new WireError('ESRCH', `pid ${pid} is not in this kernel's process table`);
      }

      const region = args['region'];
      if (typeof region === 'string') {
        // Dump one region. A read, like `ps`: the operator is *looking* at
        // what the process wrote down, and that question is not part of the
        // process's causal history. (An agent's own `ctx.memory_read()` is
        // unaffected — that is a syscall, and still recorded, ABI.md §4.4.)
        const query: MemoryQuery = {
          ...(typeof args['key'] === 'string' ? { key: args['key'] } : {}),
          ...(typeof args['prefix'] === 'string' ? { prefix: args['prefix'] } : {}),
          ...(typeof args['limit'] === 'number' ? { limit: args['limit'] } : {}),
        };
        const entries = await kernel.memory.read(target, region, query);
        return {
          pid,
          role: entry.role,
          region,
          entries: entries.map((e) => ({ key: e.key, value: e.value, at: e.at })),
        };
      }

      // List the regions: what this process knows where it keeps it.
      //
      // `entryCount` on a region is the *write* count (it is what the ENOMEM
      // ceiling is measured against), not the number of entries, so the real
      // count is read from the driver — capped, because a region can be large
      // and the operator asked for a shape, not a dump.
      const regions = kernel.memory.regionsOf(target);
      const all = kernel.table.list();
      const described = [];
      for (const info of regions) {
        const entries = await kernel.memory.read(target, info.region, { limit: REGION_COUNT_CAP });
        // Who else is bound to the same physical key? For a `shared` region
        // that is every process that declared it — and for a `cow` region it
        // is a forked child that has not written yet. Either way it is the
        // answer to "who else can see this?".
        const sharedWith: number[] = [];
        for (const other of all) {
          if (unbrand(other.pid) === pid) continue;
          for (const otherRegion of kernel.memory.regionsOf(other.pid)) {
            if (otherRegion.bindingKey === info.bindingKey) {
              sharedWith.push(unbrand(other.pid));
              break;
            }
          }
        }
        described.push({
          region: info.region,
          kind: info.kind,
          backing: info.backing,
          readOnly: info.readOnly,
          refCount: info.refCount,
          writes: info.entryCount,
          entries: entries.length,
          truncated: entries.length >= REGION_COUNT_CAP,
          sharedWith,
        });
      }
      return { pid, role: entry.role, regions: described };
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
      // The checkpoint chain grows when a snapshot is taken. SIGUSR2 is the
      // signal whose effect is a snapshot, and a snapshot leaves the process
      // in the state it started in — so the chain is the only observable
      // evidence that the signal did anything.
      const beforeChain = kernel.table.get(target)?.checkpointChain.length ?? 0;

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
      const afterChain = after?.checkpointChain.length ?? 0;
      const outcome =
        after === undefined
          ? 'delivered'
          : after.pendingSignals.includes(signal as Signal)
            ? 'queued'
            : after.state !== before
              ? 'delivered'
              : afterChain > beforeChain
                ? 'delivered'
                : 'dropped';
      return { outcome, pid, signal, state: after?.state ?? null };
    }

    case 'wait': {
      // Block until the process ends, and report how it ended.
      //
      // The `wait` *syscall* cannot be used here: it is a parent-child
      // operation, and the process an operator is waiting for is a child of
      // init, not of the operator. The kernel's host-facing `awaitExit` is
      // the supported way to do this — it resolves at the ZOMBIE transition,
      // before init reaps the entry, so the exit code is still there.
      const pid = Number(args['pid']);
      if (!Number.isInteger(pid)) {
        throw new WireError('EINVAL', `invalid pid: ${String(args['pid'])}`);
      }
      const target = asProcessId(pid);
      const timeoutRaw = args['timeoutMs'];
      const timeoutMs = typeof timeoutRaw === 'number' ? timeoutRaw : 0;
      const exit = await kernel.awaitExit(target, {
        ...(timeoutMs > 0 ? { timeoutMs } : {}),
        signal,
      });
      if (exit === undefined) {
        return { exited: false, pid };
      }
      return {
        exited: true,
        pid,
        exitCode: exit.exitCode,
        exitReason: exit.exitReason,
      };
    }

    case 'subscribe': {
      // Open a stream on this connection.
      //
      // This is the one command that makes the kernel *push* instead of
      // answer: the acknowledgement comes back like any other response, and
      // then every event the kernel reports arrives on this same socket as an
      // `{event: …}` frame carrying the subscribe request's id.
      //
      // It is a read, like `ps` and `memory`: watching a kernel is not
      // something the kernel did, so nothing is recorded. (A subscriber that
      // wanted to *act* on what it sees acts through the ordinary commands —
      // `kill`, `send`, `checkpoint` — and those are recorded as usual.)
      const pidRaw = args['pid'];
      let pid: number | null = null;
      if (pidRaw !== undefined && pidRaw !== null) {
        const parsed = Number(pidRaw);
        if (!Number.isInteger(parsed)) {
          throw new WireError('EINVAL', `invalid pid: ${String(pidRaw)}`);
        }
        pid = parsed;
      }
      const kinds = parseEventKinds(args['kinds']);

      const unsubscribe = kernel.subscribe((event) => {
        if (pid !== null && event.pid !== pid) return;
        if (kinds !== null && !kinds.has(event.kind)) return;
        writeFrame(socket, { v: KERNEL_PROTOCOL_VERSION, id: request.id, event });
      });
      // The subscription dies with the connection. A client that goes away
      // must not leave the kernel pushing frames into a closed socket — and
      // the connection's abort signal is exactly that moment.
      signal.addEventListener('abort', unsubscribe, { once: true });

      return {
        subscribed: true,
        pid,
        kinds: kinds === null ? 'all' : [...kinds].join(','),
      };
    }

    case 'checkpoint': {
      const pid = Number(args['pid']);
      if (!Number.isInteger(pid)) {
        throw new WireError('EINVAL', `invalid pid: ${String(args['pid'])}`);
      }
      const target = asProcessId(pid);
      if (kernel.table.get(target) === undefined) {
        throw new WireError('ESRCH', `no such process: ${pid}`);
      }
      // A snapshot may only be taken from a process that can take a syscall —
      // RUNNING or BLOCKED (docs/ABI.md §4.2). A process that is momentarily
      // READY (scheduled, not yet dispatched) is not one, and the operator did
      // nothing wrong: the scheduler dispatches it within a tick. So wait for
      // the window rather than refusing.
      if (!(await awaitCheckpointable(kernel, target))) {
        const state = kernel.table.get(target)?.state ?? 'gone';
        throw new WireError(
          'ESTATE',
          `pid ${pid} is ${state}; a checkpoint needs it running or blocked`,
        );
      }
      const detach = args['detach'] === true;
      const tag = typeof args['tag'] === 'string' ? args['tag'] : undefined;

      // Through the dispatcher, so the `checkpoint` frames land in the
      // target's own log exactly like an agent-initiated checkpoint — and so
      // the state gate applies to a remote checkpoint exactly as it does to a
      // local one. `checkpoint` is a *self* syscall (the ABI gives it no
      // target argument), so the target is both the caller and the subject
      // here; the snapshot lands in the target's own log, and the operator's
      // request is answered by this command's reply.
      const result = await kernel.dispatcher.invoke(target, 'checkpoint', {
        ...(tag !== undefined ? { tag } : {}),
        detach,
      });
      const after = kernel.table.get(target);
      return {
        chainId: result.chainId,
        path: kernel.checkpoint.pathOf(result.chainId) ?? null,
        pid,
        detach,
        state: after?.state ?? null,
      };
    }

    case 'restore': {
      const chainId = args['chainId'];
      if (typeof chainId !== 'string' || chainId.length === 0) {
        throw new WireError('EINVAL', 'restore requires a chainId');
      }
      // The same call the local `cortex restore` makes. Init owns the spawn
      // surface, so it is the caller that owns the restore too (docs/ABI.md
      // §4.2) — and the new process is adopted by the dispatcher, exactly like
      // a locally restored one.
      //
      // The snapshot is found on disk by chainId: the checkpoint manager
      // searches `processes/<pid>/checkpoints/`, so a `.csnap` taken by an
      // *earlier* kernel (or by an earlier boot of this one) loads here.
      const result = await kernel.dispatcher.invoke(
        asProcessId(1),
        'restore',
        asChainId(chainId),
        {},
      );
      return { pid: unbrand(result.pid), chainId };
    }

    case 'spawn': {
      const role = args['role'];
      if (typeof role !== 'string' || role.length === 0) {
        throw new WireError('EINVAL', 'spawn requires a role');
      }
      const agent = args['agent'];
      if (typeof agent !== 'object' || agent === null || Array.isArray(agent)) {
        throw new WireError('EINVAL', 'spawn requires an agent spec');
      }
      const opts: SpawnOptions = {
        role,
        agent: agent as AgentSpec,
        ...(args['budgets'] !== undefined
          ? { budgets: args['budgets'] as Partial<BudgetLimits> }
          : {}),
        ...(args['memory'] !== undefined
          ? { memory: args['memory'] as Record<string, MemoryRegionPolicy> }
          : {}),
        ...(args['capabilities'] !== undefined
          ? { capabilities: args['capabilities'] as Capability[] }
          : {}),
        ...(args['grantable'] !== undefined
          ? { grantable: args['grantable'] as Capability[] }
          : {}),
      };
      // Through the kernel's own spawn entry point, which runs the real
      // `spawn` syscall with init as the caller: the process is allocated,
      // recorded on init's log, readied and enqueued exactly as an in-agent
      // `ctx.spawn` would be. The agent keeps running after this request
      // answers — that is the whole point of asking a live kernel.
      const pid = await kernel.spawn(opts);
      return { pid: unbrand(pid), role };
    }

    case 'fork': {
      const pid = Number(args['pid']);
      if (!Number.isInteger(pid)) {
        throw new WireError('EINVAL', `invalid pid: ${String(args['pid'])}`);
      }
      const target = asProcessId(pid);
      if (kernel.table.get(target) === undefined) {
        throw new WireError('ESRCH', `no such process: ${pid}`);
      }
      const tag = typeof args['tag'] === 'string' ? args['tag'] : undefined;
      const budgets = args['budgets'];
      // The target is the *caller* of the fork, exactly as in the local path:
      // the fork frame lands in the target's log, and the shared causal past
      // it records is what `cortex diff` cuts the two branches at.
      const result = await kernel.dispatcher.invoke(target, 'fork', {
        ...(tag !== undefined ? { tag } : {}),
        ...(budgets === 'reset' || budgets === 'inherit' || budgets === 'split' ? { budgets } : {}),
      });
      return {
        childPid: unbrand(result.childPid),
        childChainId: unbrand(result.childChainId),
        sharedCausalPast: unbrand(result.sharedCausalPast),
        irreversibleInPast: [...result.irreversibleInPast],
      };
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
