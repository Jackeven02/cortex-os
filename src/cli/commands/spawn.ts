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

import { resolveModule } from '../../module_spec.js';

import {
  bootCliKernel,
  defaultKernelDir,
  ensureKernelDirs,
  writeProcessView,
  readMeta,
  readExitRecord,
  heldCapabilities,
  unbrand,
  DEFAULT_MEMORY_REGIONS,
} from '../index.js';
import type { ProcessMeta } from '../index.js';
import { parseMemoryArg, mergeRegionPolicies, MemoryArgError } from '../regions.js';
import { rewriteNegativeValues } from '../negative_args.js';
import { processOutcome, formatOutcomeCode } from '../process_outcome.js';
import { KernelCommandError, probeKernel } from '../kernel_client.js';
import type { AgentSpec, Capability, ProcessState, MemoryRegionPolicy } from '../../kernel/types.js';
import { parseCapabilities } from '../../kernel/types.js';
import { KERNEL_ABI_VERSION } from '../../index.js';
import { formatTokenBudget } from '../process_budget.js';

/** Default time to let an agent run before giving up (ms). */
const DEFAULT_TIMEOUT_MS = 30_000;

export async function cmdSpawn(args: string[]): Promise<number> {
  const { values } = parseArgs({
    // `--nice -7` is a negative number, and Node's parser reads a value that
    // starts with a dash as another option. The priority is negative more
    // often than not, so the spelling has to work.
    args: rewriteNegativeValues(args, ['--nice']),
    options: {
      role: { type: 'string' },
      task: { type: 'string' },
      system: { type: 'string' },
      module: { type: 'string' },
      driver: { type: 'string' },
      model: { type: 'string' },
      'max-tokens': { type: 'string' },
      'token-budget': { type: 'string' },
      nice: { type: 'string' },
      'max-region-entries': { type: 'string' },
      memory: { type: 'string' },
      cap: { type: 'string' },
      grantable: { type: 'string' },
      args: { type: 'string' },
      timeout: { type: 'string', short: 't' },
      live: { type: 'boolean', default: false },
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

  let maxRegionEntries: number | undefined;
  if (values['max-region-entries'] !== undefined) {
    const parsed = parseInt(values['max-region-entries'], 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(
        `cortex spawn: invalid --max-region-entries: '${values['max-region-entries']}' ` +
        `(expected a positive integer; omit the flag for unlimited)`,
      );
      return 1;
    }
    maxRegionEntries = parsed;
  }

  let regionPolicies: Record<string, MemoryRegionPolicy> = DEFAULT_MEMORY_REGIONS;
  if (values.memory !== undefined) {
    let overrides: Record<string, MemoryRegionPolicy>;
    try {
      overrides = parseMemoryArg(values.memory);
    } catch (err) {
      if (err instanceof MemoryArgError) {
        console.error(`cortex spawn: invalid --memory: ${err.message}`);
        return 1;
      }
      throw err;
    }
    regionPolicies = mergeRegionPolicies(DEFAULT_MEMORY_REGIONS, overrides);
  }

  // Least privilege (docs/ABI.md §4.9). Omitting both flags leaves the
  // process fully privileged, which is what every pre-1.0 agent expects.
  let capabilities: readonly Capability[] | undefined;
  if (values.cap !== undefined) {
    try {
      capabilities = parseCapabilities(String(values.cap).split(',').map((s) => s.trim()).filter((s) => s !== ''));
    } catch (err) {
      console.error(`cortex spawn: invalid --cap: ${(err as Error).message}`);
      return 1;
    }
  }
  let grantable: readonly Capability[] | undefined;
  if (values.grantable !== undefined) {
    try {
      grantable = parseCapabilities(String(values.grantable).split(',').map((s) => s.trim()).filter((s) => s !== ''));
    } catch (err) {
      console.error(`cortex spawn: invalid --grantable: ${(err as Error).message}`);
      return 1;
    }
  }

  // Wire the LLM flags into the agent spec (they used to be parsed but
  // ignored). --driver/--model/--max-tokens flow to the prompt agent's
  // llm_call; --token-budget becomes a real spawn budget.
  //
  // This is computed *before* the kernel boots: the live path (`--live`)
  // needs the spec and no kernel of its own, because the agent is spawned
  // into the kernel that is already running.
  const model = values.model;
  const driver = values.driver;
  let maxTokens: number | undefined;
  if (values['max-tokens'] !== undefined) {
    maxTokens = parseInt(values['max-tokens'], 10);
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
      console.error(`cortex spawn: invalid --max-tokens: '${values['max-tokens']}'`);
      return 1;
    }
  }
  let tokenBudget: number | undefined;
  if (values['token-budget'] !== undefined) {
    tokenBudget = parseInt(values['token-budget'], 10);
    if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) {
      console.error(`cortex spawn: invalid --token-budget: '${values['token-budget']}'`);
      return 1;
    }
  }

  // The priority the process runs at: the kernel's `nice`, -20..19, and
  // **lower runs first** (docs/PROCESS.md section 8.1). The range is the
  // kernel's own, and it is checked here rather than left to the kernel --
  // which would accept a number outside it and rank the process against
  // values it never promised. A flag that quietly did something else is
  // worse than a flag that refuses.
  let nice: number | undefined;
  if (values.nice !== undefined) {
    const raw = values.nice.trim();
    const parsed = /^[+-]?\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < -20 || parsed > 19) {
      console.error(
        `cortex spawn: invalid --nice: '${values.nice}' (expected an integer from -20 to 19)`,
      );
      return 1;
    }
    nice = parsed;
  }

  // --args hands a JSON object to the agent as `AgentSpec.args`, so one agent
  // module can be reused for different work without editing it. It is the only
  // channel: `parseArgs` runs with `allowPositionals: false`, so an ad-hoc
  // `--topic mcp` is rejected as an unknown option.
  let agentArgs: Record<string, unknown> | undefined;
  if (values.args !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(values.args);
    } catch {
      console.error(
        `cortex spawn: invalid --args: '${values.args}' is not valid JSON`,
      );
      console.error(`(expected an object, e.g. --args '{"topic":"mcp","depth":2}')`);
      return 1;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(`cortex spawn: --args must be a JSON object, got ${Array.isArray(parsed) ? 'an array' : typeof parsed}`);
      return 1;
    }
    agentArgs = parsed as Record<string, unknown>;
  }

  // --module spawns a user agent module (it drives its own llm_call, so the
  // LLM flags below do not apply to it). Otherwise use the built-in prompt
  // agent, forwarding --driver/--model/--max-tokens as request defaults.
  const agentSpec: AgentSpec =
    values.module !== undefined
      ? {
          module: resolveModule(values.module, process.cwd()).specifier,
          ...(agentArgs !== undefined ? { args: agentArgs } : {}),
        }
      : {
          system,
          ...(driver !== undefined ? { driver } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
        };

  const dir = defaultKernelDir();
  ensureKernelDirs(dir);

  if (values.live) {
    return await spawnLive({
      dir,
      role: values.role,
      agent: agentSpec,
      memory: regionPolicies,
      ...(tokenBudget !== undefined ? { tokenBudget } : {}),
      ...(nice !== undefined ? { nice } : {}),
      ...(capabilities !== undefined ? { capabilities } : {}),
      ...(grantable !== undefined ? { grantable } : {}),
    });
  }

  const kernel = await bootCliKernel(
    dir,
    maxRegionEntries !== undefined ? { maxRegionEntries } : {},
  );

  try {
    const pid = await kernel.spawn({
      role: values.role,
      agent: agentSpec,
      memory: regionPolicies,
      ...(tokenBudget !== undefined ? { budgets: { tokens: tokenBudget } } : {}),
      ...(nice !== undefined ? { nice } : {}),
      ...(capabilities !== undefined ? { capabilities } : {}),
      ...(grantable !== undefined ? { grantable } : {}),
    });
    console.log(`[pid ${unbrand(pid)}]`);
    // The priority, when the operator asked for one: the knob has to say
    // that it did what it was told, and "lower runs first" is the half of
    // it that is not obvious.
    //
    // **Read back from the kernel**, not from the flag: the number printed
    // is the number the process is actually running at. A command that
    // reports what it *intended* is a command that can report a thing that
    // did not happen.
    if (nice !== undefined) {
      const running = kernel.table.get(pid)?.nice;
      console.log(`  nice: ${String(running)} (lower runs first)`);
    }

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
    const persistedMeta = entry === undefined ? readMeta(dir, pid) : undefined;
    const elapsed = Date.now() - startTime;

    let state: ProcessState;
    let exitCode: number | null;
    let exitReason: string | null;

    if (entry === undefined || entry.state === 'zombie' || entry.state === 'exiting') {
      // What the table knows, and — when the table cannot answer — what the
      // log knows. The rule that **an unknown ending is never a success**
      // lives in one place (`processOutcome`), so this command cannot tell
      // the operator a different story from `cortex wrap` or `cortex
      // restore` about the same run.
      //
      // It used to. A process is EXITING for a moment before its exit code
      // is readable, and this command read that moment as "no code" and
      // defaulted it to zero — so an agent that threw a TypeError sometimes
      // printed `code 0: completed` and exited 0.
      const exitRec =
        entry === undefined || entry.exitCode === null ? await readExitRecord(dir, pid) : undefined;
      const outcome = processOutcome(entry, exitRec);
      // A process that is still walking out is over as far as the operator
      // is concerned, and the meta is written once — so it says "zombie".
      state = outcome.state === 'exiting' ? 'zombie' : outcome.state;
      exitCode = outcome.exitCode;
      exitReason = outcome.exitReason;
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
      console.log(`process exited (code ${formatOutcomeCode(exitCode)}: ${exitReason ?? 'unknown'})`);
    } else {
      console.log(`process still ${state} after ${elapsed}ms — consider increasing --timeout`);
    }

    const spent = entry?.budgetsSpent ?? persistedMeta?.budgetsSpent ?? {
      tokensIn: 0, tokensOut: 0, tokensCached: 0, usdSpent: 0,
      wallTimeMs: elapsed, syscallCount: 0,
    };
    const remaining = entry?.budgetsRemaining ?? persistedMeta?.budgetsRemaining ?? { tokens: -1, usd: -1, wallTimeMs: -1 };
    console.log(
      `tokens: ${formatTokenBudget({ spent, remaining }, (n) => String(n))} — in ${spent.tokensIn}, out ${spent.tokensOut}`,
    );

    // Write the record so ps/trace can see this process later.
    //
    // As the CLI's **view**, not as a replacement: the kernel has already
    // written its own account of how this process ended (the exit record),
    // and that account is the one that counts. The CLI contributes what only
    // it knows — the memory policies it declared, what the process was
    // blocked on — and the fact that the kernel holds: what the process was
    // allowed to do. It used to write a record of its own from scratch, and
    // that record had no `capabilities` in it at all, so a process that held
    // every capability was recorded as holding none.
    const meta: ProcessMeta = {
      pid: unbrand(pid),
      ppid: 1,
      pgid: unbrand(pid),
      role: values.role,
      state,
      exitCode,
      exitReason,
      startedAt: entry?.startedAt ?? persistedMeta?.startedAt ?? new Date(startTime).toISOString(),
      lastTransitionAt: entry?.lastTransitionAt ?? persistedMeta?.lastTransitionAt ?? new Date().toISOString(),
      budgetsSpent: { ...spent, wallTimeMs: elapsed },
      budgetsRemaining: remaining,
      agent: agentSpec,
      ...(values.memory !== undefined ? { memory: regionPolicies } : {}),
      // Recorded so `top` can say what a still-blocked process is waiting on.
      ...(entry?.blockedOn !== undefined ? { blockedOn: entry.blockedOn } : {}),
      // What the process was allowed to do (docs/ABI.md §4.9). The kernel
      // knows this while the process is alive; the exit record keeps it
      // afterwards. This view does not copy it back out of the record: the
      // CLI does not get to answer for a process it can no longer see.
      ...(entry !== undefined ? { capabilities: heldCapabilities(entry.capabilities) } : {}),
      // The rank it ran at. The kernel's exit record has it too; this fills
      // in a record written by a build that did not keep it.
      ...(entry?.nice !== undefined ? { nice: entry.nice } : {}),
      kernelAbiVersion: KERNEL_ABI_VERSION,
    };
    writeProcessView(dir, meta);

    await kernel.shutdown();
    // An ending nobody saw is not a success: the command's own exit code
    // must say so, or a shell would carry on as if the agent had worked.
    return done ? (exitCode ?? 1) : 0;
  } catch (err) {
    await kernel.shutdown();
    throw err;
  }
}

/**
 * Spawn into the kernel that is already running.
 *
 * `cortex spawn` normally boots a kernel of its own, runs the agent to
 * completion, and exits — the agent's life is bounded by the command, and
 * every other `cortex` invocation finds only the files it left behind. With
 * `--live` the agent is spawned into the live kernel instead, so it keeps
 * running after this command returns, and everything the transport can do
 * (`cortex send`, `cortex checkpoint`, `cortex kill`, `cortex attach
 * --interactive`) applies to it.
 *
 * Two things move with the agent, and the operator should know about both:
 * its output goes to the daemon's stdout (it is the daemon's child now, not
 * this shell's), and its LLM drivers come from the daemon's environment —
 * the API key the daemon was started with, not the one in this shell.
 */
async function spawnLive(opts: {
  readonly dir: string;
  readonly role: string;
  readonly agent: AgentSpec;
  readonly memory: Record<string, MemoryRegionPolicy>;
  readonly tokenBudget?: number;
  readonly nice?: number;
  readonly capabilities?: readonly Capability[];
  readonly grantable?: readonly Capability[];
}): Promise<number> {
  const probe = await probeKernel(opts.dir);
  if (probe.kind !== 'live') {
    if (probe.kind === 'stale') {
      console.error(
        `cortex spawn --live: the kernel that published ${probe.endpoint.host}:${probe.endpoint.port} ` +
        `is not reachable (${probe.reason})`,
      );
    }
    console.error('cortex spawn --live: no live kernel is reachable in this directory.');
    console.error("  (start one with 'cortex daemon run', or drop --live to run the");
    console.error('   agent in a kernel of its own)');
    return 1;
  }

  const client = probe.client;
  try {
    const result = await client.request<{ pid: number; role: string; nice?: number }>('spawn', {
      role: opts.role,
      agent: opts.agent,
      memory: opts.memory,
      ...(opts.tokenBudget !== undefined ? { budgets: { tokens: opts.tokenBudget } } : {}),
      ...(opts.nice !== undefined ? { nice: opts.nice } : {}),
      ...(opts.capabilities !== undefined ? { capabilities: opts.capabilities } : {}),
      ...(opts.grantable !== undefined ? { grantable: opts.grantable } : {}),
    });
    console.log(`[pid ${result.pid}]`);
    if (opts.nice !== undefined) {
      // The kernel's own answer, not the flag: the number printed is the
      // number the process is actually running at.
      console.log(`  nice: ${String(result.nice ?? opts.nice)} (lower runs first)`);
    }
    console.log('  spawned into the live kernel — it keeps running after this command');
    console.log(`  (its output goes to the daemon's stdout; 'cortex trace ${result.pid}' follows its syscalls)`);
    return 0;
  } catch (err) {
    if (err instanceof KernelCommandError) {
      console.error(`cortex spawn --live: ${err.errno}: ${err.message}`);
      return 1;
    }
    throw err;
  } finally {
    client.close();
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
  --module <path|package>  Run a user agent module (default-exported function)
                        instead of the built-in prompt agent. A bundled example
                        may be named as ./examples/<name>.ts and resolves
                        inside the package, not the cwd. A relative path is
                        resolved against the current directory; anything that
                        is not a path is imported as a package name.
  --driver <string>     LLM driver name (prompt agent only; default: auto from env)
  --model <string>      Model name to pass to the driver (prompt agent only)
  --max-tokens <n>      Max output tokens per LLM call (prompt agent only)
  --token-budget <n>    Total token budget for the process
  --nice <n>            Scheduling priority: -20..19, and LOWER RUNS FIRST.
                        The kernel's own number -- the same one the NICE
                        column of 'cortex ps' prints. Two ready processes
                        are dispatched by it, lowest first, so a lower
                        number means the process runs sooner.
  --max-region-entries <n>  Cap writes per memory region; a region that would
                        exceed n writes traps ENOMEM. Omit for unlimited.
  --memory <json>       Per-region memory policy overrides, a JSON object
                        keyed by region name, merged over the standard
                        episodic/semantic/procedural defaults. Each value:
                          kind: 'private'|'shared'|'cow'   (required)
                          backing: "<driver>"              (required)
                          readOnly: <bool>                 (optional)
                          maxEntries: <int>                (optional;
                             -1 = unlimited, 0+ = hard write cap,
                             absent = inherit --max-region-entries)
  --cap <list>          Capabilities the agent holds from birth: a
                        comma-separated subset of
                        spawn,kill,fork,tool:dangerous,ipc:any,admin.
                        OMIT FOR FULL PRIVILEGE — omitting both --cap and
                        --grantable leaves the agent holding everything,
                        which is what pre-1.0 agents expect.
  --grantable <list>    Capabilities the agent may raise later with
                        ctx.acquire() but does not hold yet.
  --args <json>         A JSON object handed to the agent as its "args", so one
                        module can be reused for different work. Only applies
                        with --module. e.g. --args '{"topic":"mcp","depth":2}'
  --live                Spawn into the live kernel (one started by
                        'cortex daemon run') instead of a kernel of this
                        command's own, so the agent keeps running after this
                        command exits. Its output goes to the daemon's stdout
                        and its LLM drivers come from the daemon's
                        environment.
  -t, --timeout <ms>    Max wall time (default 30000)
  -h, --help            Show this help

EXAMPLES
  cortex spawn --role coder --task "fix issue #42"

  # Least privilege: may read and think, structurally unable to touch
  # the outside world (no irreversible tools) or fork its world:
  cortex spawn --role coder --task "analyze" --cap tool:dangerous,spawn

  # Run unprivileged, escalate for the one call that needs it:
  cortex spawn --role coder --task "ship it" --cap spawn --grantable kill
  cortex spawn --role reviewer --system "You review code for bugs."
  cortex spawn --role coder --task "analyze" --model gpt-4o-mini -t 60000

  # Cap one region tighter than the global ceiling, leave another unlimited:
  cortex spawn --role coder --task "analyze" --max-region-entries 500 \
    --memory '{"episodic":{"kind":"cow","backing":"inmem","maxEntries":50},"semantic":{"kind":"shared","backing":"inmem","maxEntries":-1}}'

  # Demo B — pause an agent at a checkpoint, resume it in a later invocation:
  cortex spawn --role demo --module ./examples/checkpoint-agent.ts
  cortex restore --tag demo-pause

  # Start a long-lived agent in the running daemon and keep talking to it:
  cortex spawn --live --role worker --module ./examples/listener-agent.ts
  cortex send 3 "what is the weather?"
`);
}
