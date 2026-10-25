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
 *   cortex checkpoint --inspect <chainId>
 *
 * @module cli/commands/checkpoint
 */

import { parseArgs } from 'node:util';
import { defaultKernelDir, parsePid } from '../index.js';
import { KernelCommandError, probeKernel } from '../kernel_client.js';
import { findCheckpointFile, listCheckpoints } from '../process_store.js';
import { readCheckpointFile } from '../../kernel/checkpoint.js';
import {
  describeCheckpoint,
  describeCheckpointPark,
  formatCheckpointTokenBudget,
  formatCheckpointUsdBudget,
  type CheckpointFacts,
} from '../checkpoint_view.js';

/**
 * How many memory entries `cortex checkpoint --inspect` prints.
 *
 * A snapshot's memory is a **full** dump in v0, so it can hold thousands of
 * entries. The report prints the last N of them and says how many there were
 * in all — a list showing 20 entries must not look like a snapshot that held
 * 20.
 */
const INSPECT_MEMORY_LIMIT = 20;

/**
 * Say what a snapshot holds.
 *
 * The facts come from one module (`src/cli/checkpoint_view.ts`), so the
 * terminal and the dashboard's checkpoint panel cannot disagree about what a
 * snapshot carried.
 */
function printCheckpoint(facts: CheckpointFacts): void {
  console.log(`checkpoint ${facts.chainId}`);
  console.log(`  process:    pid ${facts.pid}${facts.parentPid === null ? '' : ` (child of ${facts.parentPid})`}`);
  console.log(`  taken:      ${facts.createdAt}`);
  console.log(`  chain:      ${facts.prevInChain === null ? 'first in its chain' : `follows ${facts.prevInChain}`}`);
  // The conversation is counted, not quoted: the prompts and the model
  // answers are the snapshot's most private part, and no view in this project
  // returns them.
  console.log(`  messages:   ${facts.messageCount}`);
  if (facts.intent !== null) console.log(`  intent:     ${facts.intent}`);
  if (facts.pendingCalls.length > 0) {
    console.log(`  waiting on: ${facts.pendingCalls.map((call) => call.tool).join(', ')}`);
  }
  const shown = facts.memoryEntries.slice(
    Math.max(0, facts.memoryEntries.length - INSPECT_MEMORY_LIMIT),
  );
  const memoryLine = facts.memoryWriteCount === 1 ? '1 entry' : `${facts.memoryWriteCount} entries`;
  console.log(
    `  memory:     ${memoryLine}${facts.memoryWriteCount > shown.length ? ` (showing the last ${shown.length})` : ''}`,
  );
  for (const entry of shown) {
    const value = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
    console.log(`    ${entry.region}/${entry.key} = ${value}`);
  }
  console.log(`  tokens:     ${formatCheckpointTokenBudget(facts)}`);
  console.log(`  usd:        ${formatCheckpointUsdBudget(facts)}`);
  console.log(`  wall time:  ${facts.budgets.wallTimeMs}ms`);
  console.log(`  log:        byte ${facts.logOffset.byteOffset}`);
  console.log(
    `  drivers:    ${facts.driverStates.length === 0 ? '(no driver state)' : facts.driverStates.join(', ')}`,
  );
}

export async function cmdCheckpoint(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      tag: { type: 'string' },
      detach: { type: 'boolean', default: false },
      inspect: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  // ---- inspect: what does a snapshot hold? ---------------------------------
  //
  // A checkpoint is the one thing in this system you can **restore** but never
  // **look at**. This is the way to look: it reads the file, checks it the
  // way the kernel checks it, and says what is inside — before anybody
  // restores it.
  //
  // It needs no kernel: the snapshot is a file on disk, and the file is the
  // truth.
  if (values.inspect !== undefined) {
    const dir = defaultKernelDir();
    const chainId = values.inspect.trim();
    const path = findCheckpointFile(dir, chainId);
    if (path === undefined) {
      console.error(`cortex checkpoint: no checkpoint with chain ${chainId}`);
      const known = listCheckpoints(dir);
      if (known.length > 0) {
        console.error('  the checkpoints in this directory:');
        for (const cp of known) console.error(`    ${cp.chainId}`);
      } else {
        console.error('  (there are none in this directory)');
      }
      return 1;
    }
    try {
      printCheckpoint(describeCheckpoint(await readCheckpointFile(path)));
      return 0;
    } catch (err) {
      console.error(
        `cortex checkpoint: cannot read checkpoint ${chainId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
  }

  if (values.help || positionals.length === 0) {
    console.log(`cortex checkpoint — snapshot a running process to disk, or look inside one

USAGE
  cortex checkpoint <pid> [options]
  cortex checkpoint --inspect <chainId>

OPTIONS
  --tag <string>     Human-readable tag for the checkpoint
  --detach            Transition the process to SUSPENDED after checkpointing
  --inspect <chain>   Say what a checkpoint holds (no kernel needed)
  -h, --help          Show this help

NOTES
  A checkpoint captures a live process, so taking one needs a kernel that
  still has it: start one with 'cortex daemon run'. Without a live kernel
  the process is not in memory any more and there is nothing to snapshot.

  Looking inside one does not: the snapshot is a file, and --inspect reads it
  with the same checks the kernel uses. It says who the snapshot was of, how
  long its conversation had been, what it was waiting on, the memory it
  carried, what it had spent (next to the ceiling that spend was measured
  against), and where in the syscall log it was cut.

  The agent can also be asked to snapshot itself: 'cortex kill <pid>
  --signal SIGUSR2' means "checkpoint now" (docs/PROCESS.md §7).

EXAMPLES
  cortex checkpoint 2 --tag "before risky edit"
  cortex checkpoint 2 --detach
  cortex checkpoint --inspect 550e8400-e29b-41d4-a716-446655440000
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
        // The same words the process table prints for a parked process — one
        // rule, so the sentence the operator reads here and the one they read
        // in the table cannot differ.
        console.log(`  ${describeCheckpointPark({ state: 'suspended', checkpointChain: [result.chainId] })}`);
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
