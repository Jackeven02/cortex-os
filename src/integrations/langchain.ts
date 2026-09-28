import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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

export interface LangChainCallbackOptions {
  readonly dir?: string;
  readonly pid?: number;
  readonly onEvent?: (event: LangChainEvent) => void | Promise<void>;
}

type RunState = { readonly startedAt: number; readonly name?: string; readonly parentRunId?: string; readonly pid?: number };

const defaultEventPath = (dir: string): string => join(dir, 'integrations', 'langchain', 'events.jsonl');

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
  #writes: Promise<void> = Promise.resolve();

  constructor(options: LangChainCallbackOptions = {}) {
    this.#dir = options.dir ?? '.cortex';
    if (options.pid !== undefined) this.#pid = options.pid;
    if (options.onEvent !== undefined) this.#onEvent = options.onEvent;
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

  async #emit(event: LangChainEvent): Promise<void> {
    await this.#onEvent?.(event);
    const path = defaultEventPath(this.#dir);
    this.#writes = this.#writes.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8');
    });
    await this.#writes;
  }
}

function objectName(value: unknown, fallback: string): string {
  if (typeof value !== 'object' || value === null) return fallback;
  const name = (value as Record<string, unknown>)['name'];
  return typeof name === 'string' ? name : fallback;
}
