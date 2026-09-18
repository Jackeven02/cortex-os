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

import {
  bootCliKernel,
  defaultKernelDir,
  ensureKernelDirs,
  writeMeta,
  unbrand,
} from '../index.js';
import type { ProcessMeta } from '../index.js';
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
  const timeoutMs = values.timeout !== undefined ? parseInt(values.timeout, 10) : DEFAULT_TIMEOUT_MS;

  const dir = defaultKernelDir();
  ensureKernelDirs(dir);
  const kernel = await bootCliKernel(dir);

  try {
    const pid = await kernel.spawn({
      role: values.role,
      agent: { system },
    });
    console.log(`[pid ${unbrand(pid)}]`);

    // Let the agent run. v0: wait for completion or timeout.
    const startTime = Date.now();
    let done = false;

    // Poll the process state until it's terminal or we time out.
    while (Date.now() - startTime < timeoutMs) {
      const entry = kernel.table.get(pid);
      if (entry === undefined || entry.state === 'zombie' || entry.state === 'exiting') {
        done = true;
        break;
      }
      // Yield to the event loop so the scheduler can run.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Collect final state.
    const entry = kernel.table.get(pid);
    const elapsed = Date.now() - startTime;

    let state: string;
    let exitCode: number | null;
    let exitReason: string | null;

    if (entry === undefined) {
      state = 'reaped';
      exitCode = 0;
      exitReason = 'completed';
    } else if (entry.state === 'zombie' || entry.state === 'exiting') {
      state = 'zombie';
      exitCode = entry.exitCode ?? 0;
      exitReason = entry.exitReason ?? 'completed';
      done = true;
    } else {
      // Still running — timed out.
      state = entry.state;
      exitCode = null;
      exitReason = `timed out after ${elapsed}ms`;
    }

    if (done) {
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
      agent: { system },
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

OPTIONS
  --role <string>      Agent role name (required)
  --task <string>       Task description (becomes the system prompt)
  --system <string>     Full system prompt (overrides --task)
  --driver <string>     LLM driver name (default: auto from env)
  --model <string>      Model name to pass to the driver
  --max-tokens <n>      Max output tokens per LLM call
  --token-budget <n>    Total token budget for the process
  -t, --timeout <ms>    Max wall time (default 30000)
  -h, --help            Show this help

EXAMPLES
  cortex spawn --role coder --task "fix issue #42"
  cortex spawn --role reviewer --system "You review code for bugs."
  cortex spawn --role coder --task "analyze" -t 60000
`);
}
