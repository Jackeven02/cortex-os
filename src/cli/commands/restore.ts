/**
 * cortex CLI — `cortex restore`
 *
 * BACKLOG #035: *"checkpoint / restore."*
 *
 * Boots a kernel, restores a process from a `.csnap` checkpoint, runs it,
 * and writes the new process's meta to disk.
 *
 * Usage:
 *   cortex restore --tag <tag>
 *   cortex restore --chain <chainId>
 *
 * @module cli/commands/restore
 */

import { parseArgs } from 'node:util';
import { bootCliKernel, defaultKernelDir, writeProcessView, heldCapabilities, unbrand, type ProcessMeta } from '../index.js';
import { asProcessId, asChainId, type ChainId } from '../../kernel/types.js';
import { KERNEL_ABI_VERSION } from '../../index.js';
import { findCheckpointByTag, listCheckpoints, readExitRecord } from '../process_store.js';
import { processOutcome, formatOutcomeCode } from '../process_outcome.js';
import { KernelCommandError, probeKernel, type KernelProbe } from '../kernel_client.js';

export async function cmdRestore(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      tag: { type: 'string' },
      chain: { type: 'string' },
      driver: { type: 'string' },
      model: { type: 'string' },
      timeout: { type: 'string', short: 't' },
      live: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  if (values.help || (values.tag === undefined && values.chain === undefined)) {
    console.log(`cortex restore — restore a process from a checkpoint

USAGE
  cortex restore --chain <chainId>
  cortex restore --tag <tag>     (finds the checkpoint with that tag)

OPTIONS
  --chain <string>   Checkpoint chain ID to restore from
  --tag <string>     Tag name to resolve (finds the latest matching checkpoint)
  --driver <name>    Force a built-in LLM driver (deepseek | openai | mock) to
                     load and become the default for the restored process. Use
                     this when the original process ran with a specific driver,
                     otherwise the restored process may silently fall back to the
                     mock driver (issue C4).
  --model <name>     Advisory model name (accepted for symmetry with spawn).
  --live             Restore into the live kernel (one started by
                     'cortex daemon run') instead of a kernel of this command's
                     own, so the restored agent keeps running after this
                     command exits. Its output goes to the daemon's stdout.
  -t, --timeout <ms>  Max wall time for the restored process (default 30000)
  -h, --help         Show this help

EXAMPLES
  cortex restore --chain "a1b2c3d4-..."
  cortex restore --tag "before risky edit"
  cortex restore --tag "before risky edit" --driver deepseek
  cortex restore --tag "before risky edit" --live
`);
    return values.help ? 0 : 1;
  }

  if (values.driver !== undefined && !['deepseek', 'openai', 'mock'].includes(values.driver)) {
    console.error(
      `cortex restore: invalid --driver '${values.driver}' (expected one of deepseek, openai, mock)`,
    );
    return 1;
  }

  const dir = defaultKernelDir();
  if (values.timeout !== undefined) {
    const parsedTimeout = parseInt(values.timeout, 10);
    if (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0) {
      console.error(`cortex restore: invalid --timeout: '${values.timeout}' (expected a positive integer of milliseconds)`);
      return 1;
    }
  }
  const timeoutMs = values.timeout !== undefined ? parseInt(values.timeout, 10) : 30_000;

  // `--live` restores into the kernel that is already running, so the restored
  // agent keeps working after this command exits. Without it the command
  // restores into a kernel of its own, runs the agent to completion (or up to
  // the timeout), and exits — the restored agent's life is bounded by the
  // command, which is the right shape for a one-shot restore and the wrong one
  // for "come back and keep working".
  //
  // The live kernel is probed *before* the tag is resolved: if there is
  // nothing to restore into, that is the thing to say — not "no checkpoint
  // with that tag".
  let live: KernelProbe | undefined;
  if (values.live) {
    if (values.driver !== undefined) {
      console.error(
        `cortex restore --live: --driver ${values.driver} is ignored — the restored agent ` +
          `runs in the daemon's kernel, so it uses the drivers (and the API keys) the daemon ` +
          `was started with.`,
      );
    }
    live = await probeKernel(dir);
    if (live.kind !== 'live') {
      if (live.kind === 'stale') {
        console.error(
          `cortex restore --live: the kernel that published ${live.endpoint.host}:${live.endpoint.port} ` +
          `is not reachable (${live.reason})`,
        );
      }
      console.error('cortex restore --live: no live kernel is reachable in this directory.');
      console.error("  (start one with 'cortex daemon run', or drop --live to restore into");
      console.error('   a kernel of its own)');
      return 1;
    }
  }

  // Resolve the chain ID.
  let chainId = values.chain !== undefined ? asChainId(values.chain) : undefined;

  if (chainId === undefined && values.tag !== undefined) {
    const found = await findCheckpointByTag(dir, values.tag);
    if (found === undefined) {
      console.error(`cortex restore: no checkpoint found with tag '${values.tag}'`);
      // Show available checkpoints.
      const cps = listCheckpoints(dir);
      if (cps.length > 0) {
        console.error('available checkpoints:');
        for (const cp of cps) {
          console.error(`  ${cp.filename}`);
        }
      } else {
        console.error('  (no checkpoints found in this cortex home)');
      }
      return 1;
    }
    chainId = asChainId(found);
  }

  if (values.live) {
    return await restoreLive(live!, chainId!);
  }

  const kernel = await bootCliKernel(dir, {
    ...(values.driver !== undefined ? { forceLLM: values.driver } : {}),
  });

  try {
    // Restore through init (PID 1), which owns the spawn surface.
    const result = await kernel.dispatcher.invoke(asProcessId(1), 'restore', chainId!, {});
    const newPid = result.pid;

    // No stopgap here any more. `restore` used to hand back a NEW process that
    // nobody would ever dispatch (the scheduler only adopts READY), so this
    // command had to walk NEW → READY itself. As of 0.2.0 the dispatcher's
    // `restore` does the adoption, which is where it belongs: the kernel, not
    // its caller, decides that a restored process is runnable.

    // Snapshot the REAL agent spec + parent now. The restored entry can be
    // reaped during the poll loop below, after which `kernel.table.get(newPid)`
    // returns undefined and we would otherwise be forced to write a placeholder
    // meta — which the disk-backed restoreContext then reads back as the agent's
    // spec, silently corrupting any restore→checkpoint→restore chain (notably
    // `--module` agents). Capture it while it is definitely present.
    const restored = kernel.table.get(newPid);
    const restoredAgent = restored?.agent;
    const restoredMemory = restored?.memoryRegions;
    const restoredPpid = restored?.ppid !== undefined && restored.ppid !== null
      ? unbrand(restored.ppid)
      : 1;

    // Warn if the original agent declared a driver that is not actually loaded
    // in THIS environment. Without --driver (issue C4) the restored process
    // would silently fall back to the default driver (often the mock), so the
    // user thinks it is talking to a real model when it is getting deterministic
    // echoes. A custom (non built-in) driver can never be loaded by the CLI, so
    // we surface that explicitly rather than letting it fail quietly.
    const declaredDriver =
      restoredAgent !== undefined && 'driver' in restoredAgent
        ? (restoredAgent as { driver?: string }).driver
        : undefined;
    if (
      declaredDriver !== undefined &&
      declaredDriver !== 'mock' &&
      values.driver === undefined &&
      kernel.registry.tryResolveLLM(declaredDriver) === null
    ) {
      console.error(
        `cortex restore: warning: the restored agent declared driver '${declaredDriver}', ` +
          `which is not loaded here. It will use the default driver (likely mock) instead of ` +
          `the model it originally ran against. Pass --driver ${declaredDriver} to load it, ` +
          `or set the matching API key (e.g. DEEPSEEK_API_KEY / OPENAI_API_KEY).`,
      );
    }

    console.log(`restored as pid ${unbrand(newPid)} (chain ${chainId})`);

    // Let the restored agent run.
    const startTime = Date.now();
    let done = false;
    while (Date.now() - startTime < timeoutMs) {
      const e = kernel.table.get(newPid);
      if (e === undefined || e.state === 'zombie' || e.state === 'exiting') {
        done = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const e = kernel.table.get(newPid);
    const elapsed = Date.now() - startTime;
    // The same rule as `cortex spawn` and `cortex wrap`: an ending nobody
    // saw is unknown, and unknown is not success.
    const exitRec = e === undefined || e.exitCode === null ? await readExitRecord(dir, newPid) : undefined;
    const outcome = processOutcome(e, exitRec);
    if (done) {
      console.log(
        `process exited (code ${formatOutcomeCode(outcome.exitCode)}: ${outcome.exitReason ?? 'unknown'})`,
      );
    } else if (e !== undefined) {
      console.log(`process still ${e.state} after ${elapsed}ms`);
    }

    // Write the record to disk — as the CLI's **view**, on top of whatever
    // the kernel recorded. The kernel's exit record is the account of how the
    // process ended, and the CLI's snapshot of a process that is already
    // gone is a guess; a guess must not overwrite a fact.
    const meta: ProcessMeta = {
      pid: unbrand(newPid),
      ppid: restoredPpid,
      pgid: unbrand(newPid),
      role: e?.role ?? 'restored',
      state: e?.state ?? 'zombie',
      exitCode: outcome.exitCode,
      exitReason: outcome.exitReason,
      startedAt: e?.startedAt ?? restored?.startedAt ?? new Date(startTime).toISOString(),
      lastTransitionAt: e?.lastTransitionAt ?? new Date().toISOString(),
      budgetsSpent: e?.budgetsSpent ?? restored?.budgetsSpent ?? { tokensIn: 0, tokensOut: 0, tokensCached: 0, usdSpent: 0, wallTimeMs: elapsed, syscallCount: 0 },
      budgetsRemaining: e?.budgetsRemaining ?? restored?.budgetsRemaining ?? { tokens: -1, usd: -1, wallTimeMs: -1 },
      agent: restoredAgent ?? e?.agent ?? { system: 'restored' },
      ...(restoredMemory !== undefined && restoredMemory.size > 0
        ? { memory: Object.fromEntries(restoredMemory) }
        : {}),
      ...(e?.blockedOn !== undefined ? { blockedOn: e.blockedOn } : {}),
      // What the restored process was allowed to do (docs/ABI.md §4.9).
      ...(e !== undefined ? { capabilities: heldCapabilities(e.capabilities) } : {}),
      kernelAbiVersion: KERNEL_ABI_VERSION,
    };
    writeProcessView(dir, meta);

    await kernel.shutdown();
    return done ? (outcome.exitCode ?? 1) : 0;
  } catch (err) {
    await kernel.shutdown();
    throw err;
  }
}

/**
 * Restore into the kernel that is already running.
 *
 * The local path restores into a kernel of this command's own, runs the
 * restored agent to completion, and exits — so the agent's life is bounded by
 * the command. That is the right shape for a one-shot restore and the wrong
 * one for the promise the checkpoint makes: *pause, and come back to work*.
 *
 * With `--live` the snapshot is restored by the daemon's kernel instead. The
 * `.csnap` is found on disk by chain id (the checkpoint manager searches
 * `processes/<pid>/checkpoints/`), so a snapshot taken by an earlier kernel
 * loads here too, and the restored process stays in the live kernel — where
 * every other transport command can reach it.
 *
 * The restored agent's output goes to the daemon's stdout, and it runs with
 * the daemon's drivers: the API key is the one the daemon was started with.
 */
async function restoreLive(probe: KernelProbe, chainId: ChainId): Promise<number> {
  if (probe.kind !== 'live') {
    console.error('cortex restore --live: no live kernel is reachable in this directory.');
    return 1;
  }
  const client = probe.client;
  try {
    const result = await client.request<{ pid: number; chainId: string }>('restore', {
      chainId: unbrand(chainId),
    });
    console.log(`[pid ${result.pid}]`);
    console.log('  restored into the live kernel — it keeps running after this command');
    console.log(
      `  (its output goes to the daemon's stdout; 'cortex trace ${result.pid}' follows its syscalls)`,
    );
    return 0;
  } catch (err) {
    if (err instanceof KernelCommandError) {
      console.error(`cortex restore --live: ${err.errno}: ${err.message}`);
      return 1;
    }
    throw err;
  } finally {
    client.close();
  }
}
