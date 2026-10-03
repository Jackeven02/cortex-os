/**
 * cortex CLI — `cortex wrap`
 *
 * Run somebody else's command as a supervised cortex process.
 *
 * ## Why this command exists
 *
 * The integrations (`integrations/langchain`, `integrations/llm-tap`) make an
 * existing agent *observable*. They deliberately do not make it *supervisable*,
 * because supervision needs a kernel-owned process and a callback cannot
 * conjure one. The honest next step is a subprocess: the project is not
 * modified, not reimplemented, and not asked to speak cortex. It is run as a
 * child of a kernel process, which gives it a PID, a parent, a state, a budget
 * and a signal disposition — so `cortex kill`, `cortex ps`, `cortex trace` and
 * a restart policy all work on code that has never heard of cortex.
 *
 *   cortex wrap --role research --restart on-failure -- python research.py
 *   cortex wrap --role api -- node dist/server.js
 *   cortex wrap --role demo --tap -- npx tsx my-agent.ts
 *
 * ## What checkpoint means here
 *
 * A snapshot captures the *wrapper's* state, not the child's. The child is a
 * separate OS process with its own heap; no snapshot can reach into it. So
 * `restore` re-runs the command from the start rather than resuming it
 * mid-flight. That is not a limitation we papered over — it is why the natural
 * checkpoint boundary for a wrapped project is "the run ended", which is the
 * one boundary that is actually true. The `wrap:result` entry in the `episodic`
 * region records what the run produced, so a later `restore` knows what it is
 * replacing.
 *
 * ## What this is not
 *
 * It is not a supervisor for a service that is already running. It supervises
 * a *run*. For a long-lived process that should restart across reboots, see
 * `cortex daemon install`, which uses the same restart machinery with a
 * persisted DaemonSpec.
 *
 * @module cli/commands/wrap
 */

import { parseArgs } from 'node:util';
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
import { parseMemoryArg, mergeRegionPolicies, MemoryArgError } from '../regions.js';
import type { AgentSpec, MemoryRegionPolicy, ProcessState, RestartPolicy } from '../../kernel/types.js';
import { PID_INIT } from '../../kernel/process_table.js';
import { KERNEL_ABI_VERSION } from '../../index.js';

/** Default time to let a wrapped run finish before the CLI gives up (ms). */
const DEFAULT_TIMEOUT_MS = 120_000;

export async function cmdWrap(args: string[]): Promise<number> {
  // Everything after `--` is the command to run. parseArgs would try to read
  // its own flags out of that, so the split is done first and by hand.
  const separator = args.indexOf('--');
  const ownArgs = separator === -1 ? args : args.slice(0, separator);
  const command = separator === -1 ? [] : args.slice(separator + 1);

  const { values } = parseArgs({
    args: ownArgs,
    options: {
      role: { type: 'string' },
      cwd: { type: 'string' },
      restart: { type: 'string' },
      'max-restarts': { type: 'string' },
      'kill-grace-ms': { type: 'string' },
      'token-budget': { type: 'string' },
      'max-region-entries': { type: 'string' },
      memory: { type: 'string' },
      tap: { type: 'boolean', default: false },
      timeout: { type: 'string', short: 't' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    printWrapHelp();
    return 0;
  }

  if (values.role === undefined) {
    console.error('cortex wrap: --role is required');
    console.error("run `cortex wrap --help` for usage, or try: cortex wrap --role demo -- echo hi");
    return 1;
  }
  if (command.length === 0) {
    console.error('cortex wrap: no command given');
    console.error('put the command after `--`, e.g. cortex wrap --role demo -- echo hi');
    return 1;
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (values.timeout !== undefined) {
    const parsed = parseInt(values.timeout, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(`cortex wrap: invalid --timeout: '${values.timeout}' (expected a positive integer of milliseconds)`);
      return 1;
    }
    timeoutMs = parsed;
  }

  let tokenBudget: number | undefined;
  if (values['token-budget'] !== undefined) {
    tokenBudget = parseInt(values['token-budget'], 10);
    if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) {
      console.error(`cortex wrap: invalid --token-budget: '${values['token-budget']}'`);
      return 1;
    }
  }

  let killGraceMs: number | undefined;
  if (values['kill-grace-ms'] !== undefined) {
    killGraceMs = parseInt(values['kill-grace-ms'], 10);
    if (!Number.isFinite(killGraceMs) || killGraceMs < 0) {
      console.error(`cortex wrap: invalid --kill-grace-ms: '${values['kill-grace-ms']}' (expected >= 0)`);
      return 1;
    }
  }

  const restart = parseRestart(values.restart, values['max-restarts']);
  if (restart === undefined) {
    console.error("cortex wrap: invalid --restart (expected 'never', 'on-failure', or 'always')");
    return 1;
  }

  let maxRegionEntries: number | undefined;
  if (values['max-region-entries'] !== undefined) {
    maxRegionEntries = parseInt(values['max-region-entries'], 10);
    if (!Number.isFinite(maxRegionEntries) || maxRegionEntries <= 0) {
      console.error(`cortex wrap: invalid --max-region-entries: '${values['max-region-entries']}'`);
      return 1;
    }
  }

  let regionPolicies: Record<string, MemoryRegionPolicy> = DEFAULT_MEMORY_REGIONS;
  if (values.memory !== undefined) {
    try {
      regionPolicies = mergeRegionPolicies(DEFAULT_MEMORY_REGIONS, parseMemoryArg(values.memory));
      if (maxRegionEntries !== undefined) {
        for (const policy of Object.values(regionPolicies)) {
          (policy as { maxEntries?: number }).maxEntries = maxRegionEntries;
        }
      }
    } catch (err) {
      if (err instanceof MemoryArgError) {
        console.error(`cortex wrap: ${err.message}`);
        return 1;
      }
      throw err;
    }
  }

  const dir = defaultKernelDir();
  await ensureKernelDirs(dir);

  // The wrapper module ships with the CLI, so it resolves relative to this
  // file rather than the caller's cwd. `cortex wrap` therefore works from any
  // directory, and from an npm install where no `examples/` folder exists.
  const wrapperUrl = new URL('../wrap_agent.js', import.meta.url).href;

  const kernel = await bootCliKernel(dir);
  try {
    const agentArgs: Record<string, unknown> = {
      argv: command,
      ...(values.cwd !== undefined ? { cwd: resolvePath(values.cwd) } : {}),
      ...(killGraceMs !== undefined ? { killGraceMs } : {}),
      // Tell the child where its own LLM calls should be recorded, so a
      // wrapped project gets both process-level supervision and call-level
      // accounting without knowing cortex exists. It only has to cooperate by
      // reading one env var — and `integrations/llm-tap` does that for it.
      ...(values.tap ? { env: { CORTEX_TAP_DIR: dir, CORTEX_TAP_REQUIRED: '1' } } : {}),
    };

    const agentSpec: AgentSpec = { module: wrapperUrl, args: agentArgs };

    const pid = await kernel.spawn({
      role: values.role,
      agent: agentSpec,
      memory: regionPolicies,
      ...(tokenBudget !== undefined ? { budgets: { tokens: tokenBudget } } : {}),
      // A wrapped command is arbitrary user code that may run indefinitely,
      // so a restart policy is opt-in rather than inherited. `never` is the
      // honest default: re-running someone's script because it failed is a
      // decision the operator should make, not a side effect of wrapping it.
      ...(restart.kind !== 'never' ? { restart } : {}),
    });

    const shownPid = unbrand(pid);
    console.log(`[pid ${shownPid}] ${command.join(' ')}`);
    if (values.tap) {
      console.log(`[pid ${shownPid}] tap requested: CORTEX_TAP_DIR=${dir}`);
      console.log('[pid] note: the child records its own LLM calls only if it calls tapFetch()');
    }

    // Let the run finish. Same poll shape as `cortex spawn`: yield to the
    // event loop so the scheduler can make progress.
    const startTime = Date.now();
    let done = false;
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
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const entry = kernel.table.get(pid);
    const elapsed = Date.now() - startTime;

    let state: ProcessState;
    let exitCode: number | null;
    let exitReason: string | null;

    if (entry === undefined) {
      // Reaped: recover the REAL status from the .crec exit record rather than
      // assuming success, or a killed run would print "code 0: completed".
      const exitRec = await readExitRecord(dir, pid);
      state = 'zombie';
      exitCode = exitRec?.code ?? 1;
      exitReason =
        exitRec?.reason ?? 'reaped with no exit record (crashed or killed before recording)';
      done = true;
    } else if (entry.state === 'zombie' || entry.state === 'exiting') {
      state = 'zombie';
      exitCode = entry.exitCode ?? 0;
      exitReason = entry.exitReason ?? 'completed';
      done = true;
    } else if (entry.state === 'suspended') {
      state = 'suspended';
      exitCode = 0;
      exitReason = 'checkpointed (suspended)';
      done = true;
    } else {
      // Timed out. Stop it explicitly: the CLI is about to exit and take the
      // kernel with it, which would tear the run down mid-flight and leave no
      // record of what it had done.
      state = entry.state;
      exitCode = null;
      exitReason = `timed out after ${elapsed}ms`;
      console.error(`[pid ${shownPid}] still ${state} after ${elapsed}ms — stopping it`);
      console.error('[pid] raise --timeout, or use `cortex daemon install` for a long-lived run');
      // Same escalation init.ts uses for a daemon that overran: SIGTERM, then
      // SIGKILL after the grace period.
      //
      // `settle()` and not a plain sleep: the wrapper's SIGTERM handler is
      // agent code, and agent code only runs when the scheduler dispatches it.
      // Sleeping on the event loop would deliver the signal to the kernel and
      // then shut down before the handler ever got a turn, leaving the child
      // process orphaned. settle() drives the ticks that run the handler.
      await kernel.signals.send(pid, 'SIGTERM', PID_INIT).catch(() => undefined);
      await kernel.settle(2000, () => new Promise((resolve) => setTimeout(resolve, 10)));
      const stillLive = kernel.table.get(pid);
      if (stillLive !== undefined && stillLive.state !== 'zombie') {
        console.error(`[pid ${shownPid}] ignored SIGTERM — sending SIGKILL`);
        await kernel.signals.send(pid, 'SIGKILL', PID_INIT).catch(() => undefined);
        await kernel.settle(2000, () => new Promise((resolve) => setTimeout(resolve, 10)));
      }
    }

    if (state === 'suspended') {
      const chain = entry?.checkpointChain;
      const lastChain = chain !== undefined && chain.length > 0 ? unbrand(chain[chain.length - 1]!) : undefined;
      console.log(`process suspended at checkpoint after ${elapsed}ms`);
      if (lastChain !== undefined) {
        console.log(`  chain: ${lastChain}`);
        console.log(`  resume with: cortex restore --chain ${lastChain}`);
      }
    } else if (exitCode !== null) {
      console.log(`process exited (code ${exitCode}: ${exitReason})`);
    } else {
      console.log(`process still ${state} after ${elapsed}ms`);
    }

    const spent = entry?.budgetsSpent ?? {
      tokensIn: 0,
      tokensOut: 0,
      tokensCached: 0,
      usdSpent: 0,
      syscallCount: 0,
      wallTimeMs: elapsed,
    };
    const remaining = entry?.budgetsRemaining ?? { tokens: -1, usd: -1, wallTimeMs: -1 };
    console.log(`tokens: ${spent.tokensIn + spent.tokensOut} (in ${spent.tokensIn}, out ${spent.tokensOut})`);

    // Persist so `cortex ps` / `trace` / the dashboard see this run after the
    // CLI exits. Same shape `cortex spawn` writes.
    const meta: ProcessMeta = {
      pid: shownPid,
      ppid: 1,
      pgid: shownPid,
      role: values.role,
      state,
      exitCode,
      exitReason,
      startedAt: entry?.startedAt ?? new Date(startTime).toISOString(),
      lastTransitionAt: entry?.lastTransitionAt ?? new Date().toISOString(),
      budgetsSpent: { ...spent, wallTimeMs: elapsed },
      budgetsRemaining: remaining,
      agent: agentSpec,
      ...(values.memory !== undefined ? { memory: regionPolicies } : {}),
      ...(entry?.blockedOn !== undefined ? { blockedOn: entry.blockedOn } : {}),
      kernelAbiVersion: KERNEL_ABI_VERSION,
    };
    writeMeta(dir, meta);

    return exitCode ?? 0;
  } catch (err) {
    await kernel.shutdown();
    throw err;
  } finally {
    await kernel.shutdown();
  }
}

/**
 * Parse `--restart` into a policy. `undefined` means the input was invalid,
 * which is a different thing from `{ kind: 'never' }` and must not be folded
 * into it — a typo should not silently disable supervision.
 */
function parseRestart(kind: string | undefined, maxRestarts: string | undefined): RestartPolicy | undefined {
  const value = kind ?? 'never';
  if (value !== 'never' && value !== 'on-failure' && value !== 'always') return undefined;
  const policy: { kind: RestartPolicy['kind']; maxRestarts?: number } = { kind: value };
  if (maxRestarts !== undefined) {
    const parsed = parseInt(maxRestarts, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return undefined;
    policy.maxRestarts = parsed;
  }
  return policy as RestartPolicy;
}

function printWrapHelp(): void {
  console.log(`cortex wrap — run a command as a supervised cortex process

USAGE
  cortex wrap --role <role> [options] -- <command> [args...]

  Everything after \`--\` is the command. It runs as a child of a kernel
  process, so it gets a PID, a parent, a state, a budget, a signal
  disposition and a restart policy — without being modified to know any of it.

OPTIONS
  --role <name>          Label shown in \`cortex ps\` and the dashboard (required)
  --cwd <path>           Working directory for the child
  --restart <policy>     never (default) | on-failure | always
  --max-restarts <n>     Cap restarts; the kernel also detects restart storms
  --kill-grace-ms <n>    SIGTERM to SIGKILL grace period (default 5000)
  --token-budget <n>     Token ceiling for this run
  --tap                  Pass CORTEX_TAP_DIR so a project that calls
                         tapFetch() reports its LLM calls into this run's log
  --memory <spec>        Memory region overrides, same syntax as \`cortex spawn\`
  --timeout <ms>         How long to let the run finish (default 120000)

EXAMPLES
  cortex wrap --role demo -- echo hello
  cortex wrap --role research --restart on-failure -- python research.py
  cortex wrap --role api --cwd ./service -- node dist/server.js
  cortex wrap --role agent --tap -- npx tsx my-agent.ts

WHAT CHECKPOINT MEANS HERE
  A snapshot captures the wrapper's state, not the child's — the child is a
  separate OS process and no snapshot can reach into it. \`cortex restore\` on a
  wrapped run therefore re-runs the command from the start instead of resuming
  it mid-flight. The run's outcome is recorded in the \`episodic\` region under
  \`wrap:result\`, so a restore knows what it is replacing.

SEE ALSO
  cortex daemon install    long-lived process that restarts across reboots
  cortex spawn --module   full syscall-level integration (fork, real
                           checkpointing, capabilities) — more work, more power
  cortex trace <pid>      read the syscall log of a wrapped run
`);
}
