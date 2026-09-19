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
import { bootCliKernel, defaultKernelDir, writeMeta, unbrand, type ProcessMeta } from '../index.js';
import { asProcessId, asChainId } from '../../kernel/types.js';
import { KERNEL_ABI_VERSION } from '../../index.js';
import { findCheckpointByTag, listCheckpoints } from '../process_store.js';

export async function cmdRestore(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      tag: { type: 'string' },
      chain: { type: 'string' },
      timeout: { type: 'string', short: 't' },
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
  -t, --timeout <ms>  Max wall time for the restored process (default 30000)
  -h, --help         Show this help

EXAMPLES
  cortex restore --chain "a1b2c3d4-..."
  cortex restore --tag "before risky edit"
  cortex restore --tag "before risky edit" -t 60000
`);
    return values.help ? 0 : 1;
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

  const kernel = await bootCliKernel(dir);

  try {
    // Restore through init (PID 1), which owns the spawn surface.
    const result = await kernel.dispatcher.invoke(asProcessId(1), 'restore', chainId!, {});
    const newPid = result.pid;

    // v0 known gap: restored processes start in NEW and need to be walked
    // to READY. The scheduler only dispatches READY. We patch this here
    // until the kernel fix lands (BACKLOG known gap #1).
    const entry = kernel.table.get(newPid);
    if (entry !== undefined && entry.state === 'new') {
      await kernel.table.setState(newPid, 'ready', { trigger: 'restore-cli' });
      kernel.scheduler.enqueue(newPid);
    }

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
    if (done) {
      console.log(`process exited (code ${e?.exitCode ?? 0}: ${e?.exitReason ?? 'completed'})`);
    } else if (e !== undefined) {
      console.log(`process still ${e.state} after ${elapsed}ms`);
    }

    // Write meta to disk.
    const meta: ProcessMeta = {
      pid: unbrand(newPid),
      ppid: restoredPpid,
      pgid: unbrand(newPid),
      role: e?.role ?? 'restored',
      state: e?.state ?? 'zombie',
      exitCode: e?.exitCode ?? null,
      exitReason: e?.exitReason ?? null,
      startedAt: e?.startedAt ?? restored?.startedAt ?? new Date(startTime).toISOString(),
      lastTransitionAt: e?.lastTransitionAt ?? new Date().toISOString(),
      budgetsSpent: e?.budgetsSpent ?? restored?.budgetsSpent ?? { tokensIn: 0, tokensOut: 0, tokensCached: 0, usdSpent: 0, wallTimeMs: elapsed, syscallCount: 0 },
      budgetsRemaining: e?.budgetsRemaining ?? restored?.budgetsRemaining ?? { tokens: -1, usd: -1, wallTimeMs: -1 },
      agent: restoredAgent ?? e?.agent ?? { system: 'restored' },
      ...(restoredMemory !== undefined && restoredMemory.size > 0
        ? { memory: Object.fromEntries(restoredMemory) }
        : {}),
      kernelAbiVersion: KERNEL_ABI_VERSION,
    };
    writeMeta(dir, meta);

    await kernel.shutdown();
    return done ? (e?.exitCode ?? 0) : 0;
  } catch (err) {
    await kernel.shutdown();
    throw err;
  }
}
