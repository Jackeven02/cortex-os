/**
 * cortex CLI — `cortex spawn`
 *
 * BACKLOG #029: *"start an agent, print PID."*
 *
 * Boots a kernel, spawns the agent, runs it to completion (or timeout),
 * then writes a `.meta.json` to disk so `ps`/`trace` can see it later.
 *
 * @module cli/commands/spawn
 */

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';

import {
  bootCliKernel,
  defaultKernelDir,
  ensureKernelDirs,
  writeMeta,
  readExitRecord,
  unbrand,
  DEFAULT_MEMORY_REGIONS,
} from '../index.js';
import type { ProcessMeta } from '../index.js';
import type { AgentSpec, ProcessState } from '../../kernel/types.js';
import { KERNEL_ABI_VERSION } from '../../index.js';

/** Default time to let an agent run before giving up (ms). */
const DEFAULT_TIMEOUT_MS = 30_000;

export async function cmdSpawn(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      role: { type: 'string' },
      task: { type: 'string' },
      system: { type: 'string' },
      module: { type: 'string' },
      driver: { type: 'string' },
      model: { type: 'string' },
      'max-tokens': { type: 'string' },
      'token-budget': { type: 'string' },
      timeout: { type: 'string', short: 't' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    printSpawnHelp();
    return 0;
  }

  if (values.role === undefined) {
    console.error('cortex spawn: --role is required');
    console.error('run `cortex spawn --help` for usage.');
    return 1;
  }

  const system = values.system ?? `You are a ${values.role}. Your task: ${values.task ?? '(no task specified)'}`;
  if (values.timeout !== undefined) {
    const parsed = parseInt(values.timeout, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(`cortex spawn: invalid --timeout: '${values.timeout}' (expected a positive integer of milliseconds)`);
      return 1;
    }
  }
  const timeoutMs = values.timeout !== undefined ? parseInt(values.timeout, 10) : DEFAULT_TIMEOUT_MS;

  const dir = defaultKernelDir();
  ensureKernelDirs(dir);
  const kernel = await bootCliKernel(dir);

  try {
    // Wire the LLM flags into the agent spec (they used to be parsed but
    // ignored). --driver/--model/--max-tokens flow to the prompt agent's
    // llm_call; --token-budget becomes a real spawn budget.
    const model = values.model;
    const driver = values.driver;
    let maxTokens: number | undefined;
    if (values['max-tokens'] !== undefined) {
      maxTokens = parseInt(values['max-tokens'], 10);
      if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
        console.error(`cortex spawn: invalid --max-tokens: '${values['max-tokens']}'`);
        await kernel.shutdown();
        return 1;
      }
    }
    let tokenBudget: number | undefined;
    if (values['token-budget'] !== undefined) {
      tokenBudget = parseInt(values['token-budget'], 10);
      if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) {
        console.error(`cortex spawn: invalid --token-budget: '${values['token-budget']}'`);
        await kernel.shutdown();
        return 1;
      }
    }

    // --module spawns a user agent module (it drives its own llm_call, so the
    // LLM flags below do not apply to it). Otherwise use the built-in prompt
    // agent, forwarding --driver/--model/--max-tokens as request defaults.
    const agentSpec: AgentSpec =
      values.module !== undefined
        ? { module: pathToFileURL(resolvePath(values.module)).href }
        : {
            system,
            ...(driver !== undefined ? { driver } : {}),
            ...(model !== undefined ? { model } : {}),
            ...(maxTokens !== undefined ? { maxTokens } : {}),
          };

    const pid = await kernel.spawn({
      role: values.role,
      agent: agentSpec,
      memory: DEFAULT_MEMORY_REGIONS,
      ...(tokenBudget !== undefined ? { budgets: { tokens: tokenBudget } } : {}),
    });
    console.log(`[pid ${unbrand(pid)}]`);

    // Let the agent run. v0: wait for completion or timeout.
    const startTime = Date.now();
    let done = false;

    // Poll the process state until it's terminal, suspended (self-checkpoint),
    // or we time out.
    while (Date.now() - startTime < timeoutMs) {
      const entry = kernel.table.get(pid);
      if (
        entry === undefined ||
        entry.state === 'zombie' ||
        entry.state === 'exiting' ||
        entry.state === 'suspended'
      ) {
        done = true;
        break;
      }
      // Yield to the event loop so the scheduler can run.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Collect final state.
    const entry = kernel.table.get(pid);
    const elapsed = Date.now() - startTime;

    let state: ProcessState;
    let exitCode: number | null;
    let exitReason: string | null;

    if (entry === undefined) {
      // Already reaped: the in-memory exitCode is gone. Recover the REAL
      // status from the .crec exit record instead of assuming success — a
      // crashed/trapped run must not be reported as "code 0: completed".
      const exitRec = await readExitRecord(dir, pid);
      state = 'zombie';
      if (exitRec !== undefined) {
        exitCode = exitRec.code;
        exitReason = exitRec.reason;
      } else {
        exitCode = 1;
        exitReason = 'reaped with no exit record (crashed or killed before recording)';
      }
      done = true;
    } else if (entry.state === 'zombie' || entry.state === 'exiting') {
      state = 'zombie';
      exitCode = entry.exitCode ?? 0;
      exitReason = entry.exitReason ?? 'completed';
      done = true;
    } else if (entry.state === 'suspended') {
      // The agent checkpointed itself with detach:true. This is a clean
      // pause, not a timeout — a .csnap is now on disk and restorable.
      state = 'suspended';
      exitCode = 0;
      exitReason = 'checkpointed (suspended)';
      done = true;
    } else {
      // Still running — timed out.
      state = entry.state;
      exitCode = null;
      exitReason = `timed out after ${elapsed}ms`;
    }

    if (state === 'suspended') {
      const chain = entry?.checkpointChain;
      const lastChain = chain !== undefined && chain.length > 0 ? unbrand(chain[chain.length - 1]!) : undefined;
      console.log(`process suspended at checkpoint after ${elapsed}ms`);
      if (lastChain !== undefined) {
        console.log(`  chain: ${lastChain}`);
      }
      console.log(`  resume with: cortex restore --chain ${lastChain ?? '<chainId>'}`);
    } else if (done) {
      console.log(`process exited (code ${exitCode}: ${exitReason})`);
    } else {
      console.log(`process still ${state} after ${elapsed}ms — consider increasing --timeout`);
    }

    const spent = entry?.budgetsSpent ?? {
      tokensIn: 0, tokensOut: 0, tokensCached: 0, usdSpent: 0,
      wallTimeMs: elapsed, syscallCount: 0,
    };
    const remaining = entry?.budgetsRemaining ?? { tokens: -1, usd: -1, wallTimeMs: -1 };
    console.log(`tokens: ${spent.tokensIn + spent.tokensOut} (in ${spent.tokensIn}, out ${spent.tokensOut})`);

    // Write the meta.json so ps/trace can see this process later.
    const meta: ProcessMeta = {
      pid: unbrand(pid),
      ppid: 1,
      pgid: unbrand(pid),
      role: values.role,
      state,
      exitCode,
      exitReason,
      startedAt: entry?.startedAt ?? new Date(startTime).toISOString(),
      lastTransitionAt: entry?.lastTransitionAt ?? new Date().toISOString(),
      budgetsSpent: { ...spent, wallTimeMs: elapsed },
      budgetsRemaining: remaining,
      agent: agentSpec,
      kernelAbiVersion: KERNEL_ABI_VERSION,
    };
    writeMeta(dir, meta);

    await kernel.shutdown();
    return done ? (exitCode ?? 0) : 0;
  } catch (err) {
    await kernel.shutdown();
    throw err;
  }
}

function printSpawnHelp(): void {
  console.log(`cortex spawn — start an agent as a background process

USAGE
  cortex spawn --role <role> --task <task> [options]
  cortex spawn --role <role> --system <prompt>
  cortex spawn --role <role> --module <path>

OPTIONS
  --role <string>      Agent role name (required)
  --task <string>       Task description (becomes the system prompt)
  --system <string>     Full system prompt (overrides --task)
  --module <path>       Run a user agent module (default-exported function)
                        instead of the built-in prompt agent
  --driver <string>     LLM driver name (prompt agent only; default: auto from env)
  --model <string>      Model name to pass to the driver (prompt agent only)
  --max-tokens <n>      Max output tokens per LLM call (prompt agent only)
  --token-budget <n>    Total token budget for the process
  -t, --timeout <ms>    Max wall time (default 30000)
  -h, --help            Show this help

EXAMPLES
  cortex spawn --role coder --task "fix issue #42"
  cortex spawn --role reviewer --system "You review code for bugs."
  cortex spawn --role coder --task "analyze" --model gpt-4o-mini -t 60000

  # Demo B — pause an agent at a checkpoint, resume it in a later invocation:
  cortex spawn --role demo --module ./examples/checkpoint-agent.ts
  cortex restore --tag demo-pause
`);
}
