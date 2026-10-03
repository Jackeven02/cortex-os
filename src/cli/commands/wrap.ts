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
import { readTapSpend } from '../../integrations/llm_tap.js';

/** Default time to let a wrapped run finish before the CLI gives up (ms). */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * What `cortex wrap` returns when it stopped the run itself.
 *
 * 128 + SIGKILL(9) = 137, the shell's own convention for "killed by a signal"
 * (see `wrap_agent.ts`'s `signalNumber`, which reports 128 + N the same way).
 * It is non-zero so CI fails, and distinct from a code the child could have
 * returned on its own, so a log tells "we killed it" from "it failed".
 */
const TIMEOUT_EXIT_CODE = 137;

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
      'tap-token-budget': { type: 'string' },
      'tap-abort-on-budget': { type: 'boolean', default: false },
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

  let tapTokenBudget: number | undefined;
  if (values['tap-token-budget'] !== undefined) {
    tapTokenBudget = parseInt(values['tap-token-budget'], 10);
    if (!Number.isFinite(tapTokenBudget) || tapTokenBudget <= 0) {
      console.error(`cortex wrap: invalid --tap-token-budget: '${values['tap-token-budget']}'`);
      return 1;
    }
  }
  if (values['tap-token-budget'] !== undefined && values.tap !== true) {
    console.error('cortex wrap: --tap-token-budget requires --tap');
    return 1;
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
      ...(values.tap
        ? {
            // The wrapper reads the child's spend back off this log after the
            // child is gone, so it needs the directory too — it kept no counter
            // of its own and must not guess where the log lives.
            tapDir: dir,
            env: {
              CORTEX_TAP_DIR: dir,
              // The wrapper learns its own PID at runtime and substitutes the
              // placeholder; the parent cannot know it before `spawn` allocates
              // one, and guessing would be right only until the first reap.
              CORTEX_TAP_PID: '@PID@',
              CORTEX_TAP_REQUIRED: '1',
              ...(tapTokenBudget !== undefined ? { CORTEX_TAP_TOKEN_BUDGET: String(tapTokenBudget) } : {}),
              ...(values['tap-abort-on-budget'] === true
                ? { CORTEX_TAP_BUDGET_ACTION: 'throw' }
                : {}),
            },
          }
        : {}),
    };

    const agentSpec: AgentSpec = { module: wrapperUrl, args: agentArgs };

    // A restart policy needs the *supervisor*, not just a policy field.
    //
    // `kernel.spawn` stores `restart` on the process entry and nothing reads it
    // there — the whole restart mechanism (exponential backoff, sliding-window
    // storm detection, the `maxRestarts` cap, `restart` records in init's log)
    // lives in `InitProcess` and is reached only through `registerDaemon`. So
    // passing `restart` to `spawn` looked like it configured supervision and
    // silently did nothing: `--restart on-failure` ran the command exactly
    // once, which a test that only checked the flag was accepted never saw.
    //
    // Registering as a daemon gets the real machinery instead of a second copy
    // of it. Two behaviour changes come with that, both correct:
    //   - init reaps its own daemons, so the poll loop below sees the exit
    //     through init rather than holding a zombie.
    //   - each restart mints a FRESH pid, so every attempt gets its own
    //     directory and its own `.crec`. Attempt 2's spend cannot be confused
    //     with attempt 1's, and `cortex trace <pid>` shows one attempt's calls.
    const supervised = restart.kind !== 'never';
    const pid = supervised
      ? await kernel.registerDaemon({
          role: values.role,
          agent: agentSpec,
          restart,
          ...(tokenBudget !== undefined ? { budgets: { tokens: tokenBudget } } : {}),
          ...(values.memory !== undefined ? { memory: regionPolicies } : {}),
        })
      : await kernel.spawn({
          role: values.role,
          agent: agentSpec,
          memory: regionPolicies,
          ...(tokenBudget !== undefined ? { budgets: { tokens: tokenBudget } } : {}),
        });

    const shownPid = unbrand(pid);
    console.log(`[pid ${shownPid}] ${command.join(' ')}`);
    if (supervised) {
      const cap = restart.maxRestarts === undefined ? 'unlimited' : `${restart.maxRestarts} run${restart.maxRestarts === 1 ? '' : 's'}`;
      console.log(`[pid ${shownPid}] restart policy: ${restart.kind} (cap: ${cap})`);
    }
    if (values.tap) {
      console.log(`[pid ${shownPid}] tap enabled — the child must call installTapFromEnv() to activate it`);
      console.log('[pid] add this near the top of the child\'s entry point:');
      console.log("[pid]   import { installTapFromEnv } from 'cortex-agent-os/integrations/llm-tap'");
      console.log('[pid]   await installTapFromEnv()');
    }

    // Let the run finish. Same poll shape as `cortex spawn`: yield to the
    // event loop so the scheduler can make progress.
    //
    // Under a restart policy the pid moves: every attempt is a fresh process
    // with its own directory and its own `.crec`. So the loop asks init which
    // pid is current rather than watching the one it was handed. Polling the
    // original would see it reaped, conclude "finished", and report the first
    // attempt's exit code as the run's result — while attempts 2..N were still
    // going to happen.
    const startTime = Date.now();
    let done = false;
    let current = pid;
    // The cap the user set, resolved once. Infinity when they set none.
    const maxRestarts = restart.maxRestarts ?? Infinity;
    while (Date.now() - startTime < timeoutMs) {
      if (supervised) {
        const next = kernel.init.currentPidOf(pid);
        if (unbrand(next) !== unbrand(current)) {
          console.log(
            `[pid ${unbrand(current)}] restarting as pid ${unbrand(next)} (attempt ${kernel.init.restartCountOf(pid) + 1})`,
          );
          current = next;
        }
      }
      const entry = kernel.table.get(current);
      if (
        entry === undefined ||
        entry.state === 'zombie' ||
        entry.state === 'exiting' ||
        entry.state === 'suspended'
      ) {
        // A finished attempt is not a finished run. Init restarts on a
        // *deferred* backoff timer (1s by default), so at this instant the
        // replacement may not exist yet and `currentPidOf` still names the dead
        // pid. Treating that as "done" is how a supervisor declares victory one
        // attempt before the retry — and, with a 1s backoff, it declared
        // victory on *every* retry.
        //
        // The honest test is whether init has given up, not whether a new pid
        // has appeared: it stops when `restartCount` reaches the cap. Until
        // then this loop waits, which is also what gives the backoff timer room
        // to fire. The timeout above remains the backstop for a wedged run.
        if (supervised && kernel.init.restartCountOf(pid) < maxRestarts) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        }
        done = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const entry = kernel.table.get(current);
    const elapsed = Date.now() - startTime;

    let state: ProcessState;
    let exitCode: number | null;
    let exitReason: string | null;

    if (entry === undefined) {
      // Reaped: recover the REAL status from the .crec exit record rather than
      // assuming success, or a killed run would print "code 0: completed".
      const exitRec = await readExitRecord(dir, current);
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
      console.error(`[pid ${unbrand(current)}] still ${state} after ${elapsed}ms — stopping it`);
      console.error('[pid] raise --timeout, or use `cortex daemon install` for a long-lived run');
      // Same escalation init.ts uses for a daemon that overran: SIGTERM, then
      // SIGKILL after the grace period.
      //
      // `settle()` and not a plain sleep: the wrapper's SIGTERM handler is
      // agent code, and agent code only runs when the scheduler dispatches it.
      // Sleeping on the event loop would deliver the signal to the kernel and
      // then shut down before the handler ever got a turn, leaving the child
      // process orphaned. settle() drives the ticks that run the handler.
      await kernel.signals.send(current, 'SIGTERM', PID_INIT).catch(() => undefined);
      await kernel.settle(2000, () => new Promise((resolve) => setTimeout(resolve, 10)));
      const stillLive = kernel.table.get(current);
      if (stillLive !== undefined && stillLive.state !== 'zombie') {
        console.error(`[pid ${unbrand(current)}] ignored SIGTERM — sending SIGKILL`);
        await kernel.signals.send(current, 'SIGKILL', PID_INIT).catch(() => undefined);
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
      // Say the code we are about to return, rather than leaving the reader to
      // infer it. `cortex wrap --timeout 60 -- pytest` in CI should be able to
      // see "137" here and know the run was killed rather than finished.
      console.log(`process still ${state} after ${elapsed}ms — returning ${TIMEOUT_EXIT_CODE}`);
    }

    let spent = entry?.budgetsSpent ?? {
      tokensIn: 0,
      tokensOut: 0,
      tokensCached: 0,
      usdSpent: 0,
      syscallCount: 0,
      wallTimeMs: elapsed,
    };

    // The kernel's own counters only see syscalls that went through the
    // dispatcher. A tapped child's LLM calls did not — they were metered by the
    // tap and appended to the same `.crec` — so `budgetsSpent` reads zero for a
    // run that spent real money. Read them back off the log and add them in.
    //
    // Two things this fixes that would otherwise be quietly wrong: the summary
    // line printed `tokens: 0` for a run that spent 150, and `meta.json` stored
    // those zeros, so `cortex ps`, the dashboard and `cortex audit` all reported
    // a spending run as free. A number that looks measured but is not is worse
    // than no number, so this is a correctness fix, not a feature.
    let tapCalls = 0;
    let tapFailedCalls = 0;
    if (values.tap) {
      const spend = await readTapSpend(dir, unbrand(current));
      tapCalls = spend.calls + spend.failedCalls;
      tapFailedCalls = spend.failedCalls;
      spent = {
        tokensIn: spent.tokensIn + spend.inputTokens,
        tokensOut: spent.tokensOut + spend.outputTokens,
        tokensCached: spent.tokensCached + spend.cachedTokens,
        usdSpent: spent.usdSpent + spend.usd,
        syscallCount: spent.syscallCount,
        wallTimeMs: spent.wallTimeMs,
      };
    }

    const remaining = entry?.budgetsRemaining ?? { tokens: -1, usd: -1, wallTimeMs: -1 };
    if (supervised) {
      // Say plainly which attempt the numbers below belong to. Under a restart
      // policy each attempt is its own process with its own log, so "tokens: X"
      // is the final attempt's spend, not the run's total — and a reader who
      // assumes otherwise will think the retries were free.
      const attempts = kernel.init.restartCountOf(pid) + 1;
      console.log(
        attempts > 1
          ? `attempt ${attempts} of ${command.join(' ')} — earlier attempts ran as their own pids and are still on record`
          : command.join(' '),
      );
    }
    console.log(`tokens: ${spent.tokensIn + spent.tokensOut} (in ${spent.tokensIn}, out ${spent.tokensOut})`);
    // Only worth a line when the tap actually saw something. A wrapped command
    // that made no LLM calls should not get a misleading "0 calls" summary.
    if (tapCalls > 0) {
      const plural = tapCalls === 1 ? '' : 's';
      const failed = tapFailedCalls > 0 ? `, ${tapFailedCalls} failed` : '';
      console.log(`tap: ${tapCalls} llm call${plural} ($${spent.usdSpent.toFixed(6)}${failed})`);
    }

    // Persist so `cortex ps` / `trace` / the dashboard see this run after the
    // CLI exits. Same shape `cortex spawn` writes.
    //
    // Under a restart policy the persisted pid is the LAST attempt, not the
    // original. Those differ, and the difference decides what a reader sees:
    // the final attempt's `budgetsSpent` and `log.crec` live under the pid that
    // actually produced them, so persisting the original would point `cortex ps`
    // at attempt 1's numbers and hide every retry. Each attempt's own directory
    // and log stay on disk, so the earlier spends are still readable by pid.
    const finalPid = unbrand(current);
    const meta: ProcessMeta = {
      pid: finalPid,
      ppid: 1,
      pgid: finalPid,
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

    // A timed-out run must not report success.
    //
    // `exitCode` is null on the timeout path, and `null ?? 0` turned "we killed
    // it because it overran" into exit 0. In CI that is the worst possible
    // failure: `cortex wrap --timeout 60 -- pytest` passes when the suite hung
    // and was killed. A supervisor that reports success for a run it terminated
    // is not a supervisor, so the timeout gets the shell's own convention for
    // "killed by a signal" — 128 + SIGKILL — which is non-zero, and is
    // distinguishable from the child's own failures in a log.
    if (exitCode !== null) return exitCode;
    return TIMEOUT_EXIT_CODE;
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
  --max-restarts <n>     Cap on RUNS (n=2 means the command runs twice, once
                         initially and once retried), despite the name. Retries
                         wait 1s, then 2s, 4s... The kernel also detects
                         restart storms and gives up on its own.
  --kill-grace-ms <n>    SIGTERM to SIGKILL grace period (default 5000)
  --token-budget <n>     Token ceiling for this run
  --tap                  Tell the child it is being tapped, by setting
                         CORTEX_TAP_DIR / CORTEX_TAP_PID. The child activates
                         it with one line at its entry point:
                           import { installTapFromEnv } from
                             'cortex-agent-os/integrations/llm-tap';
                           await installTapFromEnv();
                         Without that call the flag does nothing — an env
                         var cannot make a process import anything.
  --tap-token-budget <n> Token ceiling for the child's own LLM calls
                         (requires --tap)
  --tap-abort-on-budget  Abort the call when that ceiling is crossed, after
                         recording it. Default is to record and continue.
  --memory <spec>        Memory region overrides, same syntax as \`cortex spawn\`
  --timeout <ms>         How long to let the run finish (default 120000)

EXAMPLES
  cortex wrap --role demo -- echo hello
  cortex wrap --role research --restart on-failure -- python research.py
  cortex wrap --role api --cwd ./service -- node dist/server.js
  cortex wrap --role agent --tap --tap-token-budget 500000 -- npx tsx my-agent.ts

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
