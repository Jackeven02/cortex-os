import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { KERNEL_ABI_VERSION } from '../index.js';
import { Recorder, type SyscallRecordInput } from '../kernel/recorder.js';
import {
  asProcessId,
  type ProcessId,
  type Reversibility,
  type Timestamp,
} from '../kernel/types.js';

export interface LangChainEvent {
  readonly type: string;
  readonly at: string;
  readonly runId: string;
  readonly parentRunId?: string;
  readonly pid?: number;
  readonly name?: string;
  readonly durationMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly error?: string;
}

/**
 * Where the handler writes. `jsonl` is the historical default and stays the
 * fallback; `crec` is what makes an external agent visible to `cortex trace`,
 * `cortex audit` and the dashboard.
 *
 * See docs/INTEGRATIONS.md §"LangChain callbacks".
 */
export type LangChainSink = 'jsonl' | 'crec';

export interface LangChainCallbackOptions {
  readonly dir?: string;
  readonly pid?: number;
  readonly onEvent?: (event: LangChainEvent) => void | Promise<void>;
  /**
   * `crec` (recommended) appends the same events to a real `.crec` syscall
   * log, using `pid` as the owning process. The dashboard and `cortex trace`
   * then show this agent alongside kernel-spawned ones.
   *
   * Defaults to `crec` when `pid` is set, `jsonl` otherwise — an event stream
   * with no process to attach to has nothing to be traced against.
   */
  readonly sink?: LangChainSink;
  /**
   * Tag written as the record's `syscall` name. Distinguishes these records
   * from real kernel syscalls in `cortex trace` output. Default `langchain`.
   */
  readonly syscallName?: string;
}

type RunState = { readonly startedAt: number; readonly name?: string; readonly parentRunId?: string; readonly pid?: number };

const defaultEventPath = (dir: string): string => join(dir, 'integrations', 'langchain', 'events.jsonl');

/**
 * LangChain callback types mapped onto the nearest cortex syscall, so a trace
 * reads in the vocabulary an operator already knows. `chain.*` and
 * `agent.*` are not syscalls; they are recorded as `llm_call`-adjacent frames
 * under a distinct name so nothing pretends to be a kernel call it is not.
 */
const SYSCALL_FOR_TYPE: Readonly<Record<string, string>> = {
  'llm.start': 'langchain',
  'llm.end': 'langchain',
  'llm.error': 'langchain',
  'chain.start': 'langchain',
  'chain.end': 'langchain',
  'chain.error': 'langchain',
  'tool.start': 'tool_call',
  'tool.end': 'tool_call',
  'tool.error': 'tool_call',
  'retriever.start': 'langchain',
  'retriever.end': 'langchain',
  'retriever.error': 'langchain',
  'agent.action': 'langchain',
  'agent.finish': 'langchain',
};

/** Reads are as safe to repeat as a retrieval; a tool call is not. */
const REVERSIBILITY_FOR_TYPE: Readonly<Record<string, Reversibility>> = {
  'tool.start': 'irreversible',
  'tool.end': 'irreversible',
  'tool.error': 'irreversible',
  'retriever.start': 'reversible',
  'retriever.end': 'reversible',
};

/** By recorded syscall name, so a closing frame inherits its enter's tag. */
const REVERSIBILITY_FOR_SYSCALL: Readonly<Record<string, Reversibility>> = {
  tool_call: 'irreversible',
};

const usageFrom = (value: unknown): { inputTokens?: number; outputTokens?: number } => {
  if (typeof value !== 'object' || value === null) return {};
  const obj = value as Record<string, unknown>;
  const llmOutput = obj['llmOutput'] as Record<string, unknown> | undefined;
  const usage = (obj.usage_metadata ?? obj.token_usage ?? obj.usage ?? llmOutput?.['tokenUsage']) as Record<string, unknown> | undefined;
  if (usage === undefined || usage === null) return {};
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? usage.promptTokens);
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? usage.completionTokens);
  return {
    ...(Number.isFinite(inputTokens) ? { inputTokens } : {}),
    ...(Number.isFinite(outputTokens) ? { outputTokens } : {}),
  };
};

/** A dependency-free LangChain callback handler that records metadata only. */
export class CortexLangChainCallbackHandler {
  readonly name = 'CortexLangChainCallbackHandler';
  readonly raiseError = false;
  readonly ignoreAgent = false;
  readonly ignoreChain = false;
  readonly ignoreLLM = false;
  readonly ignoreTool = false;
  readonly ignoreRetriever = false;

  #dir: string;
  #pid?: number;
  #onEvent?: (event: LangChainEvent) => void | Promise<void>;
  #runs = new Map<string, RunState>();
  /** RunIds with an open `enter` frame, so a close can be paired or promoted. */
  #open = new Set<string>();
  /**
   * The syscall name each open `enter` frame was recorded under. A closing
   * frame must repeat it: `cortex trace` pairs by `callId`, and a pair whose
   * two halves disagree on the name reads as two different calls.
   */
  #openName = new Map<string, string>();
  #writes: Promise<void> = Promise.resolve();
  #sink: LangChainSink;
  #syscallName: string;
  #recorder: Recorder | undefined;
  #recorderFor: ProcessId | undefined;
  #openRecorder: Promise<Recorder> | undefined;

  constructor(options: LangChainCallbackOptions = {}) {
    this.#dir = options.dir ?? '.cortex';
    if (options.pid !== undefined) this.#pid = options.pid;
    if (options.onEvent !== undefined) this.#onEvent = options.onEvent;
    this.#sink = options.sink ?? (options.pid !== undefined ? 'crec' : 'jsonl');
    this.#syscallName = options.syscallName ?? 'langchain';
  }

  /**
   * The process directory a `crec` sink writes to, per
   * docs/ARCHITECTURE.md §7. Exported so a host that creates the directory
   * (or points `--dir` at an existing one) agrees with this layout.
   */
  crecProcessDir(): string {
    const pid = this.#pid;
    if (pid === undefined) throw new Error('crec sink requires a pid; construct the handler with { pid }');
    return join(this.#dir, 'processes', String(pid));
  }

  handleLLMStart(_llm: unknown, _prompts: readonly string[], runId: string, parentRunId?: string, _extra?: unknown, _tags?: readonly string[], metadata?: Record<string, unknown>, runName?: string): Promise<void> {
    return this.#start('llm.start', runId, parentRunId, metadata, runName);
  }

  handleChatModelStart(_llm: unknown, _messages: readonly unknown[], runId: string, parentRunId?: string, _extra?: unknown, _tags?: readonly string[], metadata?: Record<string, unknown>, runName?: string): Promise<void> {
    return this.#start('llm.start', runId, parentRunId, metadata, runName);
  }

  handleLLMEnd(output: unknown, runId: string, _parentRunId?: string, _tags?: readonly string[], _kwargs?: unknown): Promise<void> {
    return this.#finish('llm.end', runId, usageFrom(output));
  }

  handleLLMError(error: Error, runId: string, _parentRunId?: string, _tags?: readonly string[], _kwargs?: unknown): Promise<void> {
    return this.#finish('llm.error', runId, { error: error.name });
  }

  handleChainStart(serialized: unknown, _inputs: unknown, runId: string, parentRunId?: string, _tags?: readonly string[], metadata?: Record<string, unknown>, runName?: string): Promise<void> {
    return this.#start('chain.start', runId, parentRunId, metadata, runName ?? objectName(serialized, 'chain'));
  }

  handleChainEnd(_outputs: unknown, runId: string): Promise<void> {
    return this.#finish('chain.end', runId);
  }

  handleChainError(error: Error, runId: string): Promise<void> {
    return this.#finish('chain.error', runId, { error: error.name });
  }

  handleToolStart(serialized: unknown, _input: string, runId: string, parentRunId?: string, _tags?: readonly string[], metadata?: Record<string, unknown>, runName?: string): Promise<void> {
    return this.#start('tool.start', runId, parentRunId, metadata, runName ?? objectName(serialized, 'tool'));
  }

  handleToolEnd(_output: string, runId: string): Promise<void> {
    return this.#finish('tool.end', runId);
  }

  handleToolError(error: Error, runId: string): Promise<void> {
    return this.#finish('tool.error', runId, { error: error.name });
  }

  handleRetrieverStart(serialized: unknown, _query: string, runId: string, parentRunId?: string, _tags?: readonly string[], metadata?: Record<string, unknown>, runName?: string): Promise<void> {
    return this.#start('retriever.start', runId, parentRunId, metadata, runName ?? objectName(serialized, 'retriever'));
  }

  handleRetrieverEnd(_documents: readonly unknown[], runId: string): Promise<void> {
    return this.#finish('retriever.end', runId);
  }

  handleRetrieverError(error: Error, runId: string): Promise<void> {
    return this.#finish('retriever.error', runId, { error: error.name });
  }

  async handleAgentAction(action: { tool?: string }, runId: string, parentRunId?: string): Promise<void> {
    await this.#emit({
      type: 'agent.action', at: new Date().toISOString(), runId,
      ...(parentRunId !== undefined ? { parentRunId } : {}),
      ...(this.#pid !== undefined ? { pid: this.#pid } : {}),
      ...(action.tool !== undefined ? { name: action.tool } : {}),
    });
  }

  async handleAgentFinish(_finish: unknown, runId: string, parentRunId?: string): Promise<void> {
    await this.#emit({ type: 'agent.finish', at: new Date().toISOString(), runId, ...(parentRunId !== undefined ? { parentRunId } : {}), ...(this.#pid !== undefined ? { pid: this.#pid } : {}) });
  }

  async flush(): Promise<void> {
    await this.#writes;
  }

  async #start(type: string, runId: string, parentRunId?: string, metadata?: Record<string, unknown>, name?: string): Promise<void> {
    const metadataPid = Number(metadata?.['cortexPid']);
    const pid = this.#pid ?? (Number.isInteger(metadataPid) && metadataPid > 0 ? metadataPid : undefined);
    this.#runs.set(runId, { startedAt: Date.now(), ...(name !== undefined ? { name } : {}), ...(parentRunId !== undefined ? { parentRunId } : {}), ...(pid !== undefined ? { pid } : {}) });
    await this.#emit({ type, at: new Date().toISOString(), runId, ...(parentRunId !== undefined ? { parentRunId } : {}), ...(pid !== undefined ? { pid } : {}), ...(name !== undefined ? { name } : {}) });
  }

  async #finish(type: string, runId: string, extra: { inputTokens?: number; outputTokens?: number; error?: string } = {}): Promise<void> {
    const run = this.#runs.get(runId);
    this.#runs.delete(runId);
    await this.#emit({
      type, at: new Date().toISOString(), runId,
      ...(run?.parentRunId !== undefined ? { parentRunId: run.parentRunId } : {}),
      ...(run?.name !== undefined ? { name: run.name } : {}),
      ...(run !== undefined ? { durationMs: Math.max(0, Date.now() - run.startedAt) } : {}),
      ...(run?.pid !== undefined ? { pid: run.pid } : this.#pid !== undefined ? { pid: this.#pid } : {}), ...extra,
    });
  }

  /**
   * Fan one event out to the configured sinks.
   *
   * Both sinks are always written when `crec` is active: the jsonl file is the
   * integration's own audit trail (it survives a `.cortex` reset, and it holds
   * the untruncated error name), while the `.crec` frame is what the rest of
   * cortex can read. Dropping jsonl would be a silent regression for anyone
   * already parsing it.
   */
  async #emit(event: LangChainEvent): Promise<void> {
    await this.#onEvent?.(event);
    const path = defaultEventPath(this.#dir);
    this.#writes = this.#writes.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8');
    });
    if (this.#sink === 'crec') {
      const crecWrite = this.#writeCrec(event);
      this.#writes = this.#writes.then(() => crecWrite);
    }
    await this.#writes;
  }

  /**
   * Append one `enter`/`exit` (or `enter`/`trap`) frame pair to the process's
   * `.crec`.
   *
   * The two-frame shape is not decoration: `cortex trace` reconstructs a call
   * by pairing an `enter` with its matching `exit` by `callId`, so a
   * single-frame record would render as a call that never returned. A
   * `.start` event opens the pair and the matching `.end` / `.error` closes
   * it, which is why the callId is derived from `runId` rather than minted.
   */
  async #writeCrec(event: LangChainEvent): Promise<void> {
    const pid = event.pid ?? this.#pid;
    if (pid === undefined) return; // no process to attach to; jsonl still got it
    const branded = asProcessId(pid);
    const recorder = await this.#recorderFor_(branded);

    const isEntry = event.type.endsWith('.start');
    const isError = event.type.endsWith('.error');
    // An `exit`/`trap` whose `enter` was never seen would render as a call
    // that returns from nowhere, so it is recorded as an `enter` of its own.
    const orphanClose = !isEntry && !isError && this.#open.has(event.runId) === false;
    const phase: 'enter' | 'exit' | 'trap' = isEntry || orphanClose ? 'enter' : isError ? 'trap' : 'exit';

    // A closing frame reuses the name its `enter` was recorded under, so the
    // pair reads as one call. `tool.start` opens as `tool_call`; its
    // `tool.end` must close as `tool_call` too, not as the generic default.
    const name = isEntry || orphanClose
      ? (SYSCALL_FOR_TYPE[event.type] ?? this.#syscallName)
      : (this.#openName.get(event.runId) ?? this.#syscallName);
    if (phase === 'enter') {
      this.#open.add(event.runId);
      this.#openName.set(event.runId, name);
    } else {
      this.#open.delete(event.runId);
      this.#openName.delete(event.runId);
    }

    const record: SyscallRecordInput = {
      timestamp: event.at as Timestamp,
      pid: branded,
      syscall: name,
      callId: event.runId,
      phase,
      ...(phase === 'enter'
        ? { args: { kind: event.type, ...(event.name !== undefined ? { name: event.name } : {}) } }
        : {}),
      ...(phase === 'exit'
        ? { result: { ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}), ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}) } }
        : {}),
      ...(isError ? { error: { errno: 'EDRIVER', message: event.error ?? 'langchain callback error' } } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      stateBefore: 'running',
      stateAfter: 'running',
      reversibility: REVERSIBILITY_FOR_TYPE[event.type] ?? REVERSIBILITY_FOR_SYSCALL[name] ?? 'idempotent',
      kernelAbiVersion: KERNEL_ABI_VERSION,
    };
    await recorder.append(record);
  }

  /** Open (once) the recorder for this handler's process. */
  async #recorderFor_(pid: ProcessId): Promise<Recorder> {
    if (this.#recorder !== undefined && this.#recorderFor === pid) return this.#recorder;
    if (this.#openRecorder !== undefined && this.#recorderFor === pid) return this.#openRecorder;
    this.#recorderFor = pid;
    this.#openRecorder = Recorder.open({ pid, dir: this.crecProcessDir() });
    this.#recorder = await this.#openRecorder;
    return this.#recorder;
  }

  /**
   * Flush pending writes and close the `.crec` handle. Call this before the
   * host process exits; `flush()` alone is enough if you only need the bytes
   * on disk, but the fd stays open until the handler is collected.
   */
  async close(): Promise<void> {
    await this.flush();
    const recorder = this.#recorder;
    this.#recorder = undefined;
    this.#openRecorder = undefined;
    this.#recorderFor = undefined;
    await recorder?.close();
  }
}

function objectName(value: unknown, fallback: string): string {
  if (typeof value !== 'object' || value === null) return fallback;
  const name = (value as Record<string, unknown>)['name'];
  return typeof name === 'string' ? name : fallback;
}
