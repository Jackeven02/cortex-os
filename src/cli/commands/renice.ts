/**
 * cortex CLI — `cortex renice`
 *
 * BACKLOG #125: *"A running process cannot be moved up or down the queue."*
 *
 * ## What it does
 *
 * The kernel ranks the processes it dispatches by the kernel's `nice` (-20..19,
 * **lower runs first**) and reads that number *live* — the scheduler compares
 * it at the moment it chooses, so a changed rank takes effect at the next
 * dispatch and the run queue never has to be rebuilt.
 *
 * But the rank was fixed at birth: `cortex spawn --nice` and
 * `cortex daemon install --nice` set it before the process existed, and after
 * that there was no way to move a running process at all. An agent that had
 * been running for an hour at the default could not be promoted, and one that
 * was hogging the queue could not be pushed back — the only way to change a
 * running process's rank was to kill it and start it again.
 *
 * ## Why it needs a live kernel
 *
 * A rank is a thing a **running** process has. A process that has finished
 * keeps the rank it ran at — that is in its exit record, and `cortex ps`
 * prints it — but there is nothing left to move, and rewriting a finished
 * process's record would be rewriting history.
 *
 * ## What it reports
 *
 * The rank the process runs at **now**, read back from the kernel — not the
 * number the command asked for. The two are the same thing unless something
 * in between said otherwise, and a command that printed its own intention
 * would be a command that could report a lie.
 *
 * @module cli/commands/renice
 */

import { parseArgs } from 'node:util';
import { defaultKernelDir, parsePid } from '../index.js';
import { KernelCommandError, probeKernel } from '../kernel_client.js';
import { rewriteNegativeValues } from '../negative_args.js';
import { unbrand, NICE_MAX, NICE_MIN, isValidNice } from '../../kernel/types.js';

export async function cmdRenice(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    // `--nice -7` is a negative number, and Node's parser reads a value that
    // starts with a dash as another option.
    args: rewriteNegativeValues(args, ['--nice']),
    options: {
      nice: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0 || values.nice === undefined) {
    console.log(`cortex renice — move a process up or down the queue

USAGE
  cortex renice <pid> --nice <n>

OPTIONS
  --nice <n>          The rank to move it to: -20..19, and LOWER RUNS FIRST
  -h, --help         Show this help

EXAMPLES
  cortex renice 2 --nice -7     # pid 2 runs before everything at the default
  cortex renice 2 --nice 19     # …and behind everything else

NOTES
  The rank is the kernel's 'nice': -20 is the most urgent, 19 the least, and
  LOWER RUNS FIRST. Among the processes that are ready to run, the one with the
  lowest rank goes first — so promoting an agent that is being starved, or
  pushing back one that is hogging the queue, is one number.

  The rank a process is BORN at is set with 'cortex spawn --nice <n>' (or
  'cortex daemon install --nice <n>'). This command moves one that is already
  running, and the change shows in the NICE column of 'cortex ps' and
  'cortex top' — and in the window's 优先级 column.

  Moving a process needs a live kernel ('cortex daemon run'): a rank is a
  thing a running process has. A process that has finished keeps the rank it
  ran at, and 'cortex ps' still prints it, but there is nothing left to move.

  The kernel records the change in the process's own log, so the history of a
  process's rank is readable afterwards.
`);
    return values.help ? 0 : 1;
  }

  const pid = parsePid(positionals[0]!);

  const raw = values.nice.trim();
  const parsed = /^[+-]?\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!isValidNice(parsed)) {
    console.error(
      `cortex renice: invalid --nice: '${values.nice}' (expected an integer from ${NICE_MIN} to ${NICE_MAX})`,
    );
    return 1;
  }

  const dir = defaultKernelDir();
  const probe = await probeKernel(dir);
  if (probe.kind !== 'live') {
    // The reason matters, and it is not the same reason every time. "There is
    // no kernel here" and "the kernel here crashed" are different facts, and
    // both are different from "the kernel does not know that pid" — which
    // the kernel itself says, in its own errno.
    if (probe.kind === 'stale') {
      console.error(
        `cortex renice: the kernel that published ${probe.endpoint.host}:${probe.endpoint.port} ` +
          `is not reachable (${probe.reason})`,
      );
    } else {
      console.error(`cortex renice: no live kernel in this directory.`);
    }
    console.error(
      `  (a rank is a thing a running process has — start a kernel with 'cortex daemon run', ` +
        `then 'cortex renice ${unbrand(pid)} --nice ${parsed}')`,
    );
    return 1;
  }

  const client = probe.client;
  try {
    const reply = await client.request<{
      pid: number;
      role: string;
      nice: number;
      from: number;
    }>('renice', { pid: unbrand(pid), nice: parsed });

    // What the kernel did, not what this command asked for.
    if (reply.from === reply.nice) {
      console.log(`pid ${reply.pid} (${reply.role}): nice ${reply.nice} (unchanged)`);
    } else {
      console.log(`pid ${reply.pid} (${reply.role}): nice ${reply.from} -> ${reply.nice}`);
    }
    return 0;
  } catch (err) {
    if (err instanceof KernelCommandError) {
      console.error(`cortex renice: ${err.errno}: ${err.message}`);
      return 1;
    }
    throw err;
  } finally {
    client.close();
  }
}
