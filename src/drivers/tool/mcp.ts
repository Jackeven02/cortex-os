/**
 * cortex built-in driver — MCP (Model Context Protocol) tool driver.
 *
 * BACKLOG #025: *"MCP client, mounts any MCP server as a tool namespace."*
 *
 * This is the driver that makes the "small kernel, big userland" claim
 * (MANIFESTO §II.3) non-decorative: MCP is today's de-facto tool protocol, and
 * it plugs in here as ~600 lines of user-space code. **No kernel code knows
 * MCP exists.** The kernel sees an `IToolDriver`; MCP is a transport detail.
 *
 * ## What it does
 *
 * Spawns an MCP server as a child process, speaks JSON-RPC 2.0 over its
 * stdin/stdout (newline-delimited), performs the `initialize` handshake, and
 * maps MCP's `tools/list` + `tools/call` onto cortex's `IToolDriver`:
 *
 *   MCP server                 cortex
 *   -------------------------  -----------------------------------------
 *   `initialize`               lazy, on first `listTools()` / `invoke()`
 *   `tools/list`               `listTools(): ToolDescriptor[]`
 *   `tools/call`               `invoke(name, args, ctx): ToolResult`
 *   `content: [{type,text}]`   `output: { text, content, structured }`
 *   `isError: true`            `error: { code: 'MCP_TOOL_ERROR', ... }`
 *
 * ## Three v0 decisions worth arguing about
 *
 * ### 1. MCP has no reversibility tag. Cortex requires one.
 *
 * Every cortex tool carries a `Reversibility` tag ('reversible' / 'idempotent'
 * / 'irreversible'). It drives `forkable` region enforcement (EREVERSIBLE),
 * recording verbosity, and `cortex audit`. MCP's `Tool` schema has **no such
 * field** — a third-party server cannot declare whether its tools mutate the
 * world.
 *
 * We resolve this conservatively: **unknown defaults to 'irreversible'.** An
 * untagged tool therefore *refuses to run inside a `forkable()` region* rather
 * than silently corrupting a fork. Wrong-but-safe beats wrong-but-fast.
 *
 * Operators override per tool name via the `reversibility` option. Which names
 * were declared (vs defaulted) is exposed as `declaredReversibility` so
 * `cortex audit` can surface them — that is the feedback loop that makes the
 * default temporary rather than permanent.
 *
 * ### 2. `forkable = false`.
 *
 * The driver owns a live child process with arbitrary server-side state
 * (database handles, cursors, auth). A cognitive fork copies JSON, not
 * processes — there is no way to duplicate this. STATE.md §8.6 says the kernel
 * should not trust a driver's fork-safety claim without tests; we simply do not
 * make the claim.
 *
 * ### 3. Server→client requests are ignored, not answered.
 *
 * MCP lets a server call back into the client (`sampling/createMessage`,
 * `roots/list`, `elicitation/create`). Implementing them means the driver
 * reaching back into the kernel for an LLM — a layering violation and a
 * determinism hole (an unrecorded nested `llm_call`). v0 drops any inbound
 * JSON-RPC request that carries an `id`. A server that *requires* sampling will
 * hang until the call timeout fires; that is a loud failure, which is the
 * honest outcome.
 *
 * See: docs/ABI.md §7.2 (IToolDriver), §4.3 (tool_call), §3.2 (errnos);
 *      docs/STATE.md §5.1 (reversibility), §8.6 (driver fork-safety);
 *      BACKLOG #025
 *
 * @module drivers/tool/mcp
 */

import { spawn, type ChildProcess } from 'node:child_process';

import {
  type IToolDriver,
  type ToolDescriptor,
  type ToolInvokeContext,
  type ToolResult,
  type JSONSchema,
  type Reversibility,
} from '../../kernel/types.js';
import { CortexError, wrapDriverError } from '../../kernel/errors.js';

// =============================================================================
// §1. JSON-RPC 2.0 wire types
// =============================================================================

/**
 * A request that expects a response. `id` is a monotonic integer we allocate.
 */
export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

/** A fire-and-forget message (`notifications/initialized`). */
export interface JsonRpcNotification {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly result?: unknown;
  readonly error?: JsonRpcErrorObject;
}

/**
 * Anything that can arrive on the wire. A message is a *response* iff it carries
 * both an `id` and one of `result` / `error`; otherwise it is a request or a
 * notification from the server, which v0 ignores (see decision 3 above).
 */
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

// =============================================================================
// §2. Transport
// =============================================================================

/**
 * The MCP wire, abstracted. Exists for the same reason `fetchFn` is injectable
 * in the LLM drivers: the smoke suite must exercise the full protocol without
 * spawning real subprocesses or touching the network.
 */
export interface McpTransport {
  /** Write one message. Must be newline-terminated by the implementation. */
  send(msg: JsonRpcRequest | JsonRpcNotification): void;
  /** Register the single inbound handler. Later calls replace earlier ones. */
  onMessage(handler: (msg: JsonRpcMessage) => void): void;
  /**
   * Optional: register a handler for "the peer went away" (subprocess exit).
   * Absent on in-memory transports. The driver uses it to fail in-flight calls
   * **immediately** rather than waiting for the timeout — a server that crashes
   * on startup should not cost the operator 10 seconds of wall clock.
   */
  onClose?(handler: () => void): void;
  /** Tear down. Idempotent. */
  close(): Promise<void>;
}

export interface StdioTransportOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
}

/**
 * Spawn `command` as a child process and speak newline-delimited JSON over its
 * stdio. This is THE MCP stdio transport: no `Content-Length` framing (that is
 * LSP/DAP), one JSON object per line.
 *
 * stderr is drained and kept (bounded) purely so a crashed server's last words
 * can be attached to the `EDRIVER` we throw. If we did not read it, a chatty
 * server could block forever once the pipe filled.
 */
export class StdioMcpTransport implements McpTransport {
  readonly #child: ChildProcess;
  #handler: ((msg: JsonRpcMessage) => void) | null = null;
  #closeHandler: (() => void) | null = null;
  #buf = '';
  #stderr = '';
  #closed = false;

  constructor(child: ChildProcess) {
    this.#child = child;
    this.#attach();
  }

  static spawn(opts: StdioTransportOptions): StdioMcpTransport {
    const child = spawn(opts.command, opts.args !== undefined ? [...opts.args] : [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.env !== undefined
        ? { env: { ...process.env, ...stripUndefined(opts.env) } }
        : {}),
    });
    return new StdioMcpTransport(child);
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Last 2KB of the server's stderr, for error messages. */
  get stderrTail(): string {
    return this.#stderr.slice(-2048);
  }

  #attach(): void {
    const out = this.#child.stdout;
    if (out !== null) {
      out.setEncoding('utf8');
      out.on('data', (chunk: string) => this.#onChunk(chunk));
    }
    const err = this.#child.stderr;
    if (err !== null) {
      err.setEncoding('utf8');
      err.on('data', (chunk: string) => {
        this.#stderr = (this.#stderr + chunk).slice(-2048);
      });
    }
    // A server that dies mid-call must not leave `invoke()` hanging until the
    // timeout fires. Surface it immediately (see `onClose`).
    this.#child.on('exit', () => this.#markClosed());
    this.#child.on('error', () => this.#markClosed());
  }

  #markClosed(): void {
    const was = this.#closed;
    this.#closed = true;
    if (!was) this.#closeHandler?.();
  }

  #onChunk(chunk: string): void {
    this.#buf += chunk;
    let idx = this.#buf.indexOf('\n');
    while (idx >= 0) {
      const line = this.#buf.slice(0, idx).trim();
      this.#buf = this.#buf.slice(idx + 1);
      idx = this.#buf.indexOf('\n');
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Not JSON: a stray log line on stdout. Skip it rather than crashing —
        // real servers do this, and it is not worth failing a call over.
        continue;
      }
      if (typeof parsed === 'object' && parsed !== null) {
        this.#handler?.(parsed as JsonRpcMessage);
      }
    }
  }

  send(msg: JsonRpcRequest | JsonRpcNotification): void {
    if (this.#closed) return;
    try {
      this.#child.stdin?.write(`${JSON.stringify(msg)}\n`);
    } catch {
      // Pipe already gone. The in-flight request will time out or be failed by
      // the 'exit' handler; swallowing here keeps close() races harmless.
    }
  }

  onMessage(handler: (msg: JsonRpcMessage) => void): void {
    this.#handler = handler;
  }

  onClose(handler: () => void): void {
    this.#closeHandler = handler;
    // A server that already died before the driver attached: fire now so the
    // pending `initialize` does not sit around until it times out.
    if (this.#closed) handler();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#child.stdin?.end();
    } catch {
      // Already torn down.
    }
    this.#child.kill();
  }
}

// =============================================================================
// §3. MCP protocol shapes (subset we consume)
// =============================================================================

/** One entry of an MCP `tools/list` result. */
export interface McpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: JSONSchema;
  readonly title?: string;
}

export interface McpContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly [key: string]: unknown;
}

export interface McpCallResult {
  readonly content?: readonly McpContentBlock[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

// =============================================================================
// §4. Options
// =============================================================================

export interface McpToolOptions {
  readonly name?: string;

  /**
   * Prefix prepended to every MCP tool name, separated by `/`.
   *
   * MCP tool names are server-local (`read_file`, `query`), but cortex tool
   * names are global — the registry rejects two drivers exposing the same name.
   * Namespacing is what lets five MCP servers coexist with the built-in `fs`
   * driver. Pass `''` to expose raw names and accept the collision risk.
   */
  readonly namespace?: string;

  readonly version?: string;
  readonly abiCompat?: string;

  /** MCP protocol version to request in `initialize`. */
  readonly protocolVersion?: string;

  /**
   * Per-call timeout. Also capped by `ctx.deadline` when the kernel supplies a
   * real one. Default 30s.
   */
  readonly timeoutMs?: number;

  /** Timeout for the `initialize` handshake. Default 10s. */
  readonly handshakeTimeoutMs?: number;

  /**
   * Reversibility tag for tools the server did not declare (which is all of
   * them — MCP has no such field). Default `'irreversible'`. See decision 1.
   */
  readonly defaultReversibility?: Reversibility;

  /**
   * Explicit overrides, keyed by the **server's** (un-namespaced) tool name.
   * This is how an operator says "my `read_file` is idempotent."
   */
  readonly reversibility?: Readonly<Record<string, Reversibility>>;

  /**
   * Pre-built transport. When supplied, `command` / `args` are ignored and no
   * subprocess is spawned — this is the test seam.
   */
  readonly transport?: McpTransport;

  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
}

export const MCP_DEFAULTS = {
  name: 'mcp',
  version: '1.0.0',
  abiCompat: '^1.0.0',
  protocolVersion: '2025-06-18',
  timeoutMs: 30_000,
  handshakeTimeoutMs: 10_000,
  defaultReversibility: 'irreversible' as Reversibility,
} as const;

// =============================================================================
// §5. McpToolDriver
// =============================================================================

export class McpToolDriver implements IToolDriver {
  readonly name: string;
  readonly version: string;
  readonly abiCompat: string;

  /** See decision 2: a live subprocess cannot survive a cognitive fork. */
  readonly forkable = false;

  /**
   * Non-ABI. Maps the **exposed** tool name → whether its reversibility was
   * explicitly declared by the operator rather than defaulted. `cortex audit`
   * reads this to surface untagged tools (STATE.md §8.7).
   */
  readonly declaredReversibility: Readonly<Record<string, boolean>>;

  readonly #namespace: string;
  readonly #protocolVersion: string;
  readonly #timeoutMs: number;
  readonly #handshakeTimeoutMs: number;
  readonly #defaultReversibility: Reversibility;
  readonly #reversibility: Readonly<Record<string, Reversibility>>;
  readonly #ownsTransport: boolean;

  #transport: McpTransport;
  #spawnOpts: StdioTransportOptions | undefined;
  #pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  #nextId = 1;
  #handshake: Promise<void> | null = null;
  #serverProtocolVersion: string | null = null;
  #tools: readonly ToolDescriptor[] | null = null;
  #byExposed = new Map<string, { raw: string; descriptor: ToolDescriptor }>();
  #closed = false;

  constructor(opts: McpToolOptions = {}) {
    this.name = opts.name ?? MCP_DEFAULTS.name;
    this.version = opts.version ?? MCP_DEFAULTS.version;
    this.abiCompat = opts.abiCompat ?? MCP_DEFAULTS.abiCompat;
    this.#namespace = opts.namespace ?? this.name;
    this.#protocolVersion = opts.protocolVersion ?? MCP_DEFAULTS.protocolVersion;
    this.#timeoutMs = opts.timeoutMs ?? MCP_DEFAULTS.timeoutMs;
    this.#handshakeTimeoutMs = opts.handshakeTimeoutMs ?? MCP_DEFAULTS.handshakeTimeoutMs;
    this.#defaultReversibility =
      opts.defaultReversibility ?? MCP_DEFAULTS.defaultReversibility;
    this.#reversibility = opts.reversibility ?? {};
    this.declaredReversibility = {};

    if (opts.transport !== undefined) {
      this.#transport = opts.transport;
      this.#ownsTransport = false;
    } else {
      if (opts.command === undefined || opts.command.length === 0) {
        throw new CortexError('EINVAL', 'tool_call', {
          message: "mcpTool() requires either 'command' (subprocess) or 'transport' (injected)",
          details: { driver: this.name },
        });
      }
      this.#spawnOpts = {
        command: opts.command,
        ...(opts.args !== undefined ? { args: opts.args } : {}),
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      };
      this.#ownsTransport = true;
      // Placeholder; the real transport is created lazily on first use so that
      // constructing a driver never spawns a process. `close()` before any use
      // must therefore be a no-op, which the flag below tracks.
      this.#transport = closedTransport();
    }

    this.#transport.onMessage((msg) => this.#onMessage(msg));
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** The namespace prefix in force, or `''` if raw names are exposed. */
  get namespace(): string {
    return this.#namespace;
  }

  /** The protocol version the server negotiated, once the handshake has run. */
  get serverProtocolVersion(): string | null {
    return this.#serverProtocolVersion;
  }

  // ---------------------------------------------------------------------------
  // IToolDriver
  // ---------------------------------------------------------------------------

  async listTools(): Promise<readonly ToolDescriptor[]> {
    if (this.#closed) throw this.#closedError('listTools');
    try {
      return await this.#listTools();
    } catch (err) {
      // `registerTool` calls this during boot. If it throws, the driver is
      // rejected and nothing will ever call `close()` on it — so we close
      // ourselves rather than leak the subprocess for the kernel's lifetime.
      await this.close().catch(() => {});
      throw err;
    }
  }

  async #listTools(): Promise<readonly ToolDescriptor[]> {
    await this.#ensureHandshake();
    if (this.#tools !== null) return this.#tools;

    const result = await this.#request('tools/list', {}, this.#timeoutMs);
    const raw = Array.isArray((result as { tools?: unknown })?.tools)
      ? ((result as { tools: unknown[] }).tools)
      : [];

    const descriptors: ToolDescriptor[] = [];
    const declared: Record<string, boolean> = {};
    for (const entry of raw) {
      const tool = entry as McpTool;
      if (typeof tool?.name !== 'string' || tool.name.length === 0) {
        throw new CortexError('EDRIVER', 'tool_call', {
          message: 'MCP server returned a tool without a name',
          details: { driver: this.name },
        });
      }
      const descriptor = this.#toDescriptor(tool);
      descriptors.push(descriptor);
      declared[descriptor.name] = this.#reversibility[tool.name] !== undefined;
      this.#byExposed.set(descriptor.name, { raw: tool.name, descriptor });
    }
    Object.assign(this.declaredReversibility as Record<string, boolean>, declared);
    this.#tools = descriptors;
    return descriptors;
  }

  async invoke(
    name: string,
    args: unknown,
    ctx: ToolInvokeContext,
  ): Promise<ToolResult> {
    const syscall = 'tool_call';
    if (this.#closed) throw this.#closedError('invoke');

    // Resolve through the cache, falling back to a live `tools/list` so an
    // agent can call a tool the driver has not enumerated yet.
    let entry = this.#byExposed.get(name);
    if (entry === undefined) {
      await this.listTools();
      entry = this.#byExposed.get(name);
    }
    if (entry === undefined) {
      throw new CortexError('ENOENT', syscall, {
        message: `mcp driver '${this.name}' has no tool '${name}'`,
        details: { driver: this.name, tool: name },
      });
    }

    const start = Date.now();
    try {
      const timeoutMs = this.#effectiveTimeout(ctx);
      const result = await this.#request(
        'tools/call',
        { name: entry.raw, arguments: args ?? {} },
        timeoutMs,
        ctx.abortSignal,
      );
      const mapped = mapCallResult(result);
      return {
        output: mapped.output,
        error: mapped.error,
        durationMs: Date.now() - start,
        reversibility: entry.descriptor.reversibility,
      };
    } catch (err) {
      if (err instanceof CortexError) throw err;
      throw wrapDriverError(syscall, this.name, err);
    }
  }

  async serializeState(): Promise<Uint8Array | null> {
    // A subprocess's state is not ours to serialize. `forkable = false` is the
    // load-bearing signal here; returning null is the honest answer.
    return null;
  }

  async restoreState(_blob: Uint8Array): Promise<void> {
    // Nothing to restore — see serializeState().
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    // Reject anything still waiting so callers do not hang on a dead driver.
    for (const [, entry] of this.#pending) {
      entry.reject(
        new CortexError('EDRIVER', 'tool_call', {
          message: `mcp driver '${this.name}' was closed with a call in flight`,
          details: { driver: this.name },
        }),
      );
    }
    this.#pending.clear();
    if (this.#ownsTransport) await this.#transport.close();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  #toDescriptor(tool: McpTool): ToolDescriptor {
    const override = this.#reversibility[tool.name];
    return {
      name: this.#expose(tool.name),
      description: tool.description ?? tool.title ?? tool.name,
      inputSchema: (tool.inputSchema ?? { type: 'object' }) as JSONSchema,
      reversibility: override ?? this.#defaultReversibility,
    };
  }

  #expose(raw: string): string {
    return this.#namespace.length > 0 ? `${this.#namespace}/${raw}` : raw;
  }

  #closedError(op: string): CortexError {
    return new CortexError('EDRIVER', 'tool_call', {
      message: `mcp tool driver '${this.name}' is closed (${op})`,
      details: { driver: this.name },
    });
  }

  async #ensureHandshake(): Promise<void> {
    if (this.#handshake !== null) return this.#handshake;
    this.#handshake = (async () => {
      // Spawn only here, on first use: constructing a driver must never start a
      // process. Injected transports are already "connected" but still perform
      // the handshake, so tests exercise the same wire sequence as production.
      if (this.#ownsTransport) {
        this.#transport = StdioMcpTransport.spawn(this.#spawnOpts!);
        this.#transport.onMessage((msg) => this.#onMessage(msg));
        this.#transport.onClose?.(() => this.#onPeerClose());
      }

      const result = await this.#request('initialize', {
        protocolVersion: this.#protocolVersion,
        capabilities: {},
        clientInfo: { name: 'cortex', version: this.version },
      }, this.#handshakeTimeoutMs);
      if (typeof result !== 'object' || result === null) {
        throw new CortexError('EDRIVER', 'tool_call', {
          message: `MCP server '${this.name}' returned a malformed initialize result`,
          details: { driver: this.name },
        });
      }
      // MCP says the client MUST disconnect if it cannot speak the server's
      // version. v0 accepts any version and merely records it: being strict
      // here would break against the long tail of servers pinned to older
      // drafts, and everything we consume (`tools/list`, `tools/call`) has been
      // stable across every published revision. Non-fatal by design.
      const negotiated = (result as { protocolVersion?: unknown }).protocolVersion;
      this.#serverProtocolVersion =
        typeof negotiated === 'string' ? negotiated : null;
      this.#send({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });
    })();
    return this.#handshake;
  }

  #send(msg: JsonRpcRequest | JsonRpcNotification): void {
    this.#transport.send(msg);
  }

  /**
   * The server process went away. Fail everything in flight at once rather than
   * letting each caller burn its own timeout, and mark the driver dead — a
   * respawn is a new driver, not a resurrection of this one.
   */
  #onPeerClose(): void {
    this.#closed = true;
    for (const [, entry] of this.#pending) {
      entry.reject(
        new CortexError('EDRIVER', 'tool_call', {
          message: `MCP server '${this.name}' exited with calls in flight`,
          details: { driver: this.name },
        }),
      );
    }
    this.#pending.clear();
  }

  #request(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.#closed) return Promise.reject(this.#closedError(method));
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => {
        cleanup();
        reject(
          new CortexError('EINTR', 'tool_call', {
            message: `MCP call '${method}' interrupted by signal`,
            details: { driver: this.name, method },
          }),
        );
      };
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        this.#pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
      };

      this.#pending.set(id, {
        resolve: (v) => {
          cleanup();
          resolve(v);
        },
        reject: (e) => {
          cleanup();
          reject(e);
        },
      });

      timer = setTimeout(() => {
        cleanup();
        reject(
          new CortexError('ETIMEDOUT', 'tool_call', {
            message: `MCP call '${method}' timed out after ${timeoutMs}ms`,
            details: { driver: this.name, method, timeoutMs },
          }),
        );
      }, timeoutMs);
      // Deliberately NOT unref'd: an in-flight request must keep the event loop
      // alive until it is answered, times out, or is aborted. Unref'ing here
      // makes Node exit (with an unsettled await) instead of firing the timeout.

      if (signal !== undefined) {
        if (signal.aborted) {
          cleanup();
          reject(
            new CortexError('EINTR', 'tool_call', {
              message: `MCP call '${method}' interrupted by signal`,
              details: { driver: this.name, method },
            }),
          );
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.#send({ jsonrpc: '2.0', id, method, params });
    });
  }

  #onMessage(msg: JsonRpcMessage): void {
    // A *response* is what we wait on. Anything with an `id` but no result/error
    // is a server→client request (sampling, roots, elicitation) — see decision
    // 3: v0 ignores those rather than answering them.
    const candidate = msg as Partial<JsonRpcResponse>;
    if (typeof candidate.id !== 'number') return;
    const entry = this.#pending.get(candidate.id);
    if (entry === undefined) return;

    if (candidate.error !== undefined) {
      const errno = errnoForRpcError(candidate.error.code);
      entry.reject(
        new CortexError(errno, 'tool_call', {
          message: `MCP error ${candidate.error.code}: ${candidate.error.message}`,
          details: {
            driver: this.name,
            rpcCode: candidate.error.code,
            rpcData: candidate.error.data,
          },
        }),
      );
      return;
    }
    entry.resolve(candidate.result);
  }

  /**
   * Per-call timeout, capped by the kernel-supplied deadline when it is a real
   * timestamp. `ToolInvokeContext.deadline` is an ISO string; the smoke suite
   * and some kernel paths pass `''`, in which case we ignore it.
   */
  #effectiveTimeout(ctx: ToolInvokeContext): number {
    const parsed = Date.parse(ctx.deadline);
    if (!Number.isFinite(parsed)) return this.#timeoutMs;
    const remaining = parsed - Date.now();
    if (remaining <= 0) return 1;
    return Math.min(this.#timeoutMs, remaining);
  }
}

/**
 * Type guard so `cortex audit` (and anyone else) can read
 * `declaredReversibility` without importing this driver.
 */
export function isMcpToolDriver(d: unknown): d is McpToolDriver {
  return (
    typeof d === 'object' &&
    d !== null &&
    (d as { name?: unknown }).name !== undefined &&
    typeof (d as { declaredReversibility?: unknown }).declaredReversibility === 'object'
  );
}

/**
 * Convenience factory. `mcpTool({ command: 'npx', args: ['-y', '@x/server'] })`
 * returns a ready-to-register driver; `registry.registerTool(mcpTool(...))` is
 * the whole wiring.
 */
export function mcpTool(opts: McpToolOptions): McpToolDriver {
  return new McpToolDriver(opts);
}

// =============================================================================
// §6. Helpers
// =============================================================================

/**
 * Map an MCP `tools/call` result onto cortex's `ToolResult`.
 *
 * MCP returns `content: [{ type: 'text', text }, ...]` plus optional
 * `structuredContent` and an `isError` flag. We keep all three: `text` is the
 * ergonomic path for agents (`output.text`), `content` preserves blocks the
 * agent may need to inspect (images, resources), and `structuredContent` is
 * passed through untouched.
 *
 * `isError: true` becomes `error` — NOT a thrown trap. Per docs/ABI.md §3 this
 * is a *return-with-error*: the tool ran and reported failure, which is a
 * different thing from the syscall never reaching the server.
 */
export function mapCallResult(result: unknown): {
  output: unknown;
  error: ToolResult['error'];
} {
  const obj =
    typeof result === 'object' && result !== null
      ? (result as McpCallResult)
      : {};
  const blocks = Array.isArray(obj.content) ? obj.content : [];
  const texts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
    }
  }
  const output = {
    content: blocks,
    text: texts.length > 0 ? texts.join('\n') : null,
    ...(obj.structuredContent !== undefined
      ? { structured: obj.structuredContent }
      : {}),
  };
  if (obj.isError === true) {
    return {
      output,
      error: {
        code: 'MCP_TOOL_ERROR',
        message: output.text ?? 'MCP tool reported an error with no text content',
      },
    };
  }
  return { output, error: null };
}

/**
 * JSON-RPC error code → cortex errno.
 *
 * The mapping is deliberately coarse. `-32601` (method not found) is `ENOENT`
 * because from the agent's point of view the tool does not exist; `-32602`
 * (invalid params) is `EINVAL`; everything else is `EDRIVER`, since the only
 * useful thing an agent can do with a vendor-specific failure is surface it.
 */
export function errnoForRpcError(code: number): 'ENOENT' | 'EINVAL' | 'EDRIVER' {
  if (code === -32601) return 'ENOENT';
  if (code === -32602 || code === -32600) return 'EINVAL';
  return 'EDRIVER';
}

function stripUndefined(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * A transport that swallows writes and never emits. Used as the placeholder
 * before the subprocess is spawned lazily, so `close()` on a never-used driver
 * is a no-op rather than a spawn-then-kill.
 */
function closedTransport(): McpTransport {
  return {
    send: () => {},
    onMessage: () => {},
    close: () => Promise.resolve(),
  };
}
