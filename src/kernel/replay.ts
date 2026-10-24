/**
 * cortex kernel — replaying a recorded run.
 *
 * ## The promise
 *
 * STATE.md §5.5: *"You can always replay an agent's reasoning
 * deterministically."* The recording is what makes that possible: every
 * syscall is written down with its arguments and its result, and the two
 * calls that would otherwise differ between two runs — the clock and the RNG
 * — are recorded too, with the exact value that was handed back.
 *
 * What was missing was the engine. Nothing read a recording back and served
 * it: `replayMode` existed in the types, `syscallLogOffset` existed in the
 * checkpoint, the mock driver was written to be replay-safe — and no code
 * path ever used any of it.
 *
 * ## What a replay is
 *
 * A replay re-runs an agent with the **world frozen**: the model responses,
 * the tool results, the clock and the RNG all come from the recording instead
 * of from the world. The agent's own code runs again, for real, and what it
 * does is compared with what was recorded. If the two agree, the agent still
 * behaves the way it did; if they do not, the first divergence is the answer
 * to "what changed?".
 *
 * ## The modes
 *
 * - `live` — the recording is not consulted. The ordinary run.
 * - `cached` — the recording answers where it can; a call it does not have
 *   goes to the real world.
 * - `strict` — the recording answers everything, and a call it does not have
 *   is an error. A replay that silently goes live is not a replay: it looks
 *   like a faithful reproduction and is not one. **This is the default.**
 *
 * ## Why the recording is consulted by name
 *
 * The recorded frames are in causal order, and a replay walks them in the
 * same order — but a replay only asks for the calls it is about to make, so
 * the recording is indexed by syscall name and each name's frames keep their
 * order. The Nth `llm_call` of the replay gets the Nth recorded `llm_call`.
 *
 * ## Why the driver *resolver* is what gets wrapped
 *
 * The syscall dispatcher asks a resolver for a driver and then calls it. If
 * the recording is consulted inside the driver, the dispatcher needs no
 * change at all — and that is what this module does. The wrapper changes
 * *where the answer comes from* and nothing else.
 *
 * The resolver is wrapped rather than the driver for one more reason, and it
 * is the reason a replay is worth running at all: **a replay does not need
 * the model provider the original run used.** A run recorded against
 * `deepseek` can be replayed on a machine that has never heard of a
 * DeepSeek API key, because the recorded response *is* the answer. The
 * resolver answers with a recording-backed driver even when no such driver
 * is registered here.
 *
 * ## What a replay does NOT do
 *
 * It does not rewind the world. A tool that already ran did not run again:
 * the recorded result is served, so a side effect is not repeated. That is
 * the whole point (STATE.md §5), and it is also the honest boundary — a
 * replay shows you what the agent *would* do now, not what the world would
 * answer now.
 *
 * @module kernel/replay
 */

import { CortexError, type Errno } from './errors.js';
import { readRecords } from './recorder.js';
import type {
  DriverContext,
  ILLMDriver,
  IToolDriver,
  LLMRequest,
  LLMResponse,
  SyscallRecord,
  ToolDescriptor,
  ToolInvokeContext,
  ToolResult,
} from './types.js';

/** How a replay treats a call the recording does not have. */
export type ReplayMode = 'live' | 'cached' | 'strict';

/**
 * One recorded call: what the process was handed back.
 *
 * A trapped call is recorded too — the error *is* the outcome, and a replay
 * that served a success for a recorded failure would be a different run.
 */
export interface RecordedCall {
  /** The syscall the recording holds. */
  readonly syscall: string;
  /** The result, when the call succeeded. */
  readonly result?: unknown;
  /** The error, when the call trapped. */
  readonly error?: {
    readonly errno: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

/**
 * Where a replay gets its answers.
 *
 * It is an interface so that a replay is not tied to a file: a host can
 * replay from a recording on disk, from one it kept in memory, or from
 * somewhere else entirely.
 */
export interface ReplaySource {
  /**
   * The next recorded call of this kind, or `undefined` when the recording
   * has nothing more for it.
   */
  take(syscall: string): RecordedCall | undefined;
}

/**
 * A recording of one process's log.
 *
 * The frames that carry an outcome — the `exit` and `trap` frames — are the
 * ones a replay answers from. The `enter` frames are not outcomes (they
 * record the *request*), and the kernel's own `__`-prefixed bookkeeping
 * frames are not the agent's work at all: a replay produces its own.
 */
export class LogRecording implements ReplaySource {
  /** syscall name → the recorded outcomes, in order. */
  readonly #calls = new Map<string, RecordedCall[]>();

  /** How far through each list we are. */
  readonly #cursor = new Map<string, number>();

  /** Every recorded outcome, in the order the log has them. */
  readonly #ordered: RecordedCall[] = [];

  private constructor(records: readonly SyscallRecord[]) {
    for (const record of records) {
      // An `enter` frame is the request, not the outcome; a kernel-internal
      // frame is not the agent's work.
      if (record.phase === 'enter') continue;
      if (record.syscall.startsWith('__')) continue;
      const call: RecordedCall =
        record.error !== undefined
          ? {
              syscall: record.syscall,
              error: {
                errno: record.error.errno,
                message: record.error.message,
                ...(record.error.details !== undefined ? { details: record.error.details } : {}),
              },
            }
          : { syscall: record.syscall, result: record.result };
      const bucket = this.#calls.get(record.syscall);
      if (bucket === undefined) this.#calls.set(record.syscall, [call]);
      else bucket.push(call);
      this.#ordered.push(call);
    }
  }

  /** Read a recording from a `.crec` file. */
  static async fromFile(path: string): Promise<LogRecording> {
    const records: SyscallRecord[] = [];
    for await (const record of readRecords(path)) records.push(record);
    return new LogRecording(records);
  }

  /** Build a recording from frames already in memory. */
  static fromRecords(records: readonly SyscallRecord[]): LogRecording {
    return new LogRecording(records);
  }

  /** How many outcomes the recording holds, in total. */
  get size(): number {
    return this.#ordered.length;
  }

  /**
   * Rewind every cursor, so the recording can be replayed again.
   *
   * A recording is consumed as it is served: the Nth `llm_call` of a replay
   * gets the Nth recorded `llm_call`, and the cursor never goes back. A host
   * that wants to replay the same recording twice — two modes, two variants,
   * a test that runs the same case again — rewinds it here rather than
   * reading the file twice.
   */
  reset(): void {
    this.#cursor.clear();
  }

  /** The recorded outcomes, in the order the log has them. */
  get ordered(): readonly RecordedCall[] {
    return this.#ordered;
  }

  /**
   * The next recorded call of this kind.
   *
   * Each kind is consumed in its own order: the Nth `llm_call` of the replay
   * gets the Nth recorded `llm_call`, and the same for every other name.
   */
  take(syscall: string): RecordedCall | undefined {
    const bucket = this.#calls.get(syscall);
    if (bucket === undefined) return undefined;
    const at = this.#cursor.get(syscall) ?? 0;
    if (at >= bucket.length) return undefined;
    this.#cursor.set(syscall, at + 1);
    return bucket[at];
  }
}

/**
 * The marker every "the recording ran out" message starts with.
 *
 * A strict replay that cannot answer fails in one of two ways: inside a
 * syscall (where the dispatcher records the trap and the errno is
 * `ERECORD`), or in one of the *synchronous* syscalls the agent calls
 * directly — `now()`, `random()` — where there is no dispatcher to record a
 * trap and the failure surfaces as the process's exit reason instead. A host
 * that wants to say "the recording ran out" rather than "the replay
 * diverged" looks for this marker in either place.
 */
export const RECORDING_EXHAUSTED_MARKER = 'the recording has no ';

/**
 * The error a strict replay raises when the recording runs out.
 *
 * It is `ERECORD` because that is what it is: the recording does not cover
 * this point of the run.
 */
function recordingExhausted(syscall: string): CortexError {
  return new CortexError('ERECORD', 'replay', {
    message: `${RECORDING_EXHAUSTED_MARKER}${syscall} for this point of the run`,
    details: { syscall },
  });
}

/** The kernel's errno names, for validating a recorded error. */
const ERRNO_SET = new Set<string>([
  'EINVAL', 'ESRCH', 'ENOENT', 'EAGAIN', 'EINTR', 'EPERM', 'ETIMEDOUT',
  'ENOMEM', 'EBADF', 'ECHILD', 'EBUDGET', 'EREVERSIBLE', 'EDRIVER', 'ESTATE',
  'ERECORD',
]);

/**
 * Reproduce a recorded failure.
 *
 * The errno, the message and the details are all the original's, because a
 * replay that failed *differently* is a different run — and the agent's
 * reaction to the failure is exactly what the replay is measuring.
 */
function replayError(
  error: { readonly errno: string; readonly message: string; readonly details?: unknown },
  syscall: string,
): CortexError {
  const errno = ERRNO_SET.has(error.errno) ? (error.errno as Errno) : 'ERECORD';
  return new CortexError(errno, syscall, {
    message: error.message,
    ...(error.details !== undefined
      ? { details: error.details as Readonly<Record<string, unknown>> }
      : {}),
  });
}

/**
 * Wrap an LLM driver so that it answers from the recording.
 *
 * The wrapper is deliberately thin: it changes *where the answer comes from*
 * and nothing else. The recorded response is handed back verbatim, because a
 * replay that "improved" the model's answer would not be a replay.
 */
export function recordedLLMDriver(
  driver: ILLMDriver,
  source: ReplaySource,
  mode: ReplayMode,
): ILLMDriver {
  return {
    name: driver.name,
    version: driver.version,
    abiCompat: driver.abiCompat,
    supportedModels: driver.supportedModels,
    call: async (req: LLMRequest, ctx: DriverContext): Promise<LLMResponse> => {
      if (mode === 'live') return driver.call(req, ctx);
      const recorded = source.take('llm_call');
      if (recorded === undefined) {
        if (mode === 'strict') throw recordingExhausted('llm_call');
        return driver.call(req, ctx);
      }
      if (recorded.error !== undefined) throw replayError(recorded.error, 'llm_call');
      return recorded.result as LLMResponse;
    },
    close: () => driver.close(),
  };
}

/**
 * Wrap a tool driver so that it answers from the recording.
 *
 * A tool is the agent's *action*, so this is where a replay's ethics live:
 * the recorded result is what the world said last time, and serving it means
 * the world is not asked again. A side effect that already happened is not
 * repeated by a replay — which is the whole point (STATE.md §5).
 */
export function recordedToolDriver(
  driver: IToolDriver,
  source: ReplaySource,
  mode: ReplayMode,
): IToolDriver {
  return {
    name: driver.name,
    version: driver.version,
    abiCompat: driver.abiCompat,
    ...(driver.forkable !== undefined ? { forkable: driver.forkable } : {}),
    listTools: () => driver.listTools(),
    invoke: async (name: string, args: unknown, ctx: ToolInvokeContext): Promise<ToolResult> => {
      if (mode === 'live') return driver.invoke(name, args, ctx);
      const recorded = source.take('tool_call');
      if (recorded === undefined) {
        if (mode === 'strict') throw recordingExhausted('tool_call');
        return driver.invoke(name, args, ctx);
      }
      if (recorded.error !== undefined) throw replayError(recorded.error, 'tool_call');
      return recorded.result as ToolResult;
    },
    close: () => driver.close(),
  };
}

/**
 * A driver that exists only to carry a recording.
 *
 * When the original run used a driver this host does not have — a custom
 * LLM driver, an MCP tool server — the recording still has the answer, so
 * the resolver hands back one of these instead of trapping `EDRIVER`. It is
 * only ever *called* when the recording has nothing left to say, and then it
 * fails loudly rather than quietly reaching for the world.
 */
function placeholderLLM(name: string | undefined): ILLMDriver {
  return {
    name: name ?? 'replay',
    version: '0.0.0+replay',
    abiCompat: '*',
    supportedModels: [],
    call: async (): Promise<LLMResponse> => {
      throw new CortexError('EDRIVER', 'llm_call', {
        message:
          `no LLM driver '${name ?? 'default'}' is registered here, and the recording ` +
          `has no llm_call left for it`,
        details: { driver: name ?? 'default', replay: true },
      });
    },
    close: async () => {},
  };
}

/**
 * A tool driver that exists only to carry a recording.
 *
 * The descriptor it is paired with says `reversible`, and that is a real
 * (small) loss of fidelity: the kernel's capability gate for an irreversible
 * tool is evaluated against a placeholder because the real descriptor is not
 * knowable here. In practice it cannot change the outcome — a tool that was
 * irreversible could only have been called by a process that held
 * `tool:dangerous`, and the replay is given that same capability.
 */
function placeholderTool(name: string): { driver: IToolDriver; descriptor: ToolDescriptor } {
  return {
    driver: {
      name: 'replay',
      version: '0.0.0+replay',
      abiCompat: '*',
      listTools: async () => [],
      invoke: async (): Promise<ToolResult> => {
        throw new CortexError('ENOENT', 'tool_call', {
          message: `no tool '${name}' is registered here, and the recording has no tool_call left for it`,
          details: { tool: name, replay: true },
        });
      },
      close: async () => {},
    },
    descriptor: {
      name,
      description: `replayed tool '${name}' (no local driver)`,
      inputSchema: { type: 'object' },
      reversibility: 'reversible',
    },
  };
}

/**
 * The replay engine: the recording, the mode, and the rules about them.
 *
 * The kernel owns one of these when `KernelOptions.replay` is set, and the
 * CLI owns one when it is building a replay kernel. Everything that consults
 * a recording goes through here, so the mode is enforced in exactly one
 * place.
 */
export class ReplayEngine {
  /** Where the answers come from. */
  readonly source: ReplaySource;

  /** What to do with a call the recording does not have. */
  readonly mode: ReplayMode;

  constructor(source: ReplaySource, mode: ReplayMode = 'strict') {
    this.source = source;
    this.mode = mode;
  }

  /**
   * The recorded value of a synchronous call — the clock, the RNG.
   *
   * These are recorded with the exact value that was handed back, so serving
   * them is what makes two runs of the same code comparable at all.
   *
   * Returns `undefined` when the recording has nothing for this call and the
   * mode allows the world to answer instead. In `strict` mode that is an
   * error: a replay that quietly reads the real clock is not a replay.
   */
  syncValue(syscall: string): unknown | undefined {
    if (this.mode === 'live') return undefined;
    const recorded = this.source.take(syscall);
    if (recorded === undefined) {
      if (this.mode === 'strict') throw recordingExhausted(syscall);
      return undefined;
    }
    if (recorded.error !== undefined) throw replayError(recorded.error, syscall);
    return recorded.result;
  }

  /**
   * The LLM driver to hand the dispatcher for a request.
   *
   * `real` is the driver this host has, or `undefined` when it has none —
   * and a replay does not need one.
   */
  llmDriver(real: ILLMDriver | undefined, name: string | undefined): ILLMDriver {
    if (this.mode === 'live') {
      // A live replay ignores the recording completely — including the fact
      // that it could have answered. A driver this host does not have is the
      // same error it always is.
      if (real === undefined) {
        throw new CortexError('EDRIVER', 'llm_call', {
          message: `no LLM driver '${name ?? 'default'}' is registered`,
          details: { driver: name ?? 'default' },
        });
      }
      return real;
    }
    // The wrapper is built per resolution rather than cached. A host may
    // unregister and re-register a driver while the kernel runs, and a cache
    // would keep handing out the driver that was there before — a stale
    // answer to a question that no longer has the same answer.
    return recordedLLMDriver(real ?? placeholderLLM(name), this.source, this.mode);
  }

  /**
   * The tool driver and descriptor to hand the dispatcher for a tool.
   *
   * `real` is what this host has for that tool, or `undefined`.
   */
  toolDriver(
    real: { readonly driver: IToolDriver; readonly descriptor: ToolDescriptor } | undefined,
    name: string,
  ): { readonly driver: IToolDriver; readonly descriptor: ToolDescriptor } | undefined {
    if (this.mode === 'live') return real;
    // Built per resolution, for the same reason as the LLM one above: a
    // driver can be unregistered and re-registered under the same name while
    // the kernel runs, and a cached wrapper would keep the old one.
    const base = real ?? placeholderTool(name);
    return {
      driver: recordedToolDriver(base.driver, this.source, this.mode),
      descriptor: base.descriptor,
    };
  }
}
