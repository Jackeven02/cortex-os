/**
 * cortex CLI — `cortex checkpoint`
 *
 * BACKLOG #035: *"checkpoint / restore."*
 *
 * ## A checkpoint needs a running process
 *
 * A snapshot captures a *live* process — its memory regions, its budgets, its
 * cognitive state, where it is in its `.crec` log. There is nothing to
 * capture of a process that is not running, and the short-lived CLI model
 * cannot provide one: `cortex checkpoint` boots a fresh kernel whose process
 * table holds exactly one entry (init), so the PID it was asked about is
 * never there. The old implementation could only ever answer "no such
 * process".
 *
 * So the command asks the kernel that *does* have the process. With a live
 * kernel (`cortex daemon run`, which publishes its endpoint in
 * `<CORTEX_HOME>/kernel.json`) the snapshot is real: the target goes through
 * CHECKPOINTING, a `.csnap` is written, and the `checkpoint` frames land in
 * the target's own log. Without one, the command says so plainly instead of
 * pretending.
 *
 * The other way to reach the same snapshot is the signal: `SIGUSR2` means
 * "checkpoint now" (docs/PROCESS.md §7), so `cortex kill <pid> --signal
 * SIGUSR2` asks the running agent to snapshot itself. That path is recorded
 * as a signal delivery; this one is recorded as a checkpoint syscall.
 *
 * Usage:
 *   cortex checkpoint <pid> [--tag <tag>] [--detach]
 *
 * @module cli/commands/checkpoint
 */

import { parseArgs } from 'node:util';
import { defaultKernelDir, parsePid } from '../index.js';
import { KernelCommandError, probeKernel } from '../kernel_client.js';

export async function cmdCheckpoint(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      tag: { type: 'string' },
      detach: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`cortex checkpoint — snapshot a running process to disk

USAGE
  cortex checkpoint <pid> [options]

OPTIONS
  --tag <string>     Human-readable tag for the checkpoint
  --detach            Transition the process to SUSPENDED after checkpointing
  -h, --help          Show this help

NOTES
  A checkpoint captures a live process, so this command needs a kernel that
  still has it: start one with 'cortex daemon run'. Without a live kernel
  the process is not in memory any more and there is nothing to snapshot.

  The agent can also be asked to snapshot itself: 'cortex kill <pid>
  --signal SIGUSR2' means "checkpoint now" (docs/PROCESS.md §7).

EXAMPLES
  cortex checkpoint 2 --tag "before risky edit"
  cortex checkpoint 2 --detach
`);
    return values.help ? 0 : 1;
  }

  const pid = parsePid(positionals[0]!);
  const dir = defaultKernelDir();
  const probe = await probeKernel(dir);

  if (probe.kind === 'live') {
    const client = probe.client;
    try {
      const result = await client.request<{
        chainId: string;
        path: string | null;
        pid: number;
        detach: boolean;
        state: string | null;
      }>('checkpoint', {
        pid,
        detach: values.detach,
        ...(values.tag !== undefined ? { tag: values.tag } : {}),
      });
      console.log(`checkpointed pid ${pid} → chain ${result.chainId}`);
      if (result.path !== null) console.log(`  file: ${result.path}`);
      if (result.detach) {
        console.log(`  pid ${pid} is SUSPENDED — 'cortex restore --chain ${result.chainId}' brings it back`);
      }
      return 0;
    } catch (err) {
      if (err instanceof KernelCommandError) {
        console.error(`cortex checkpoint: ${err.errno}: ${err.message}`);
        return 1;
      }
      throw err;
    } finally {
      client.close();
    }
  }

  // ---- no live kernel ----------------------------------------------------
  if (probe.kind === 'stale') {
    console.error(
      `cortex checkpoint: the kernel that published ${probe.endpoint.host}:${probe.endpoint.port} ` +
      `is not reachable (${probe.reason})`,
    );
  }

  console.error('cortex checkpoint: no live kernel is reachable in this directory.');
  console.error('  A checkpoint captures a running process, and this CLI boots a');
  console.error('  kernel whose process table holds only init — there is nothing');
  console.error('  here to snapshot.');
  console.error("  (start one with 'cortex daemon run', or let the agent take its");
  console.error('   own checkpoint with ctx.checkpoint())');
  return 1;
}
