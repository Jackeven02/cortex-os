/**
 * cortex CLI — `cortex logs`
 *
 * ## Why this command exists
 *
 * The `.crec` log answers "what did this process *do*". It does not answer
 * "what did it *say*". An agent's `console.log` used to go to the daemon's
 * stdout — one anonymous stream shared by everything in the kernel — and
 * nowhere else. So the one thing an operator reaches for first, when an
 * agent is behaving strangely, was the one thing the system did not keep.
 *
 * Now every process's printed output is captured to
 * `<CORTEX_HOME>/processes/<pid>/output.log`, one stamped line per printed
 * line, tagged with the stream it came from:
 *
 *     2026-10-23T15:39:35.034Z | out | hello from the agent
 *     2026-10-23T15:39:36.118Z | err | something went wrong
 *
 * `cortex logs <pid>` reads that file back. It is a pure disk read — like
 * `cortex trace`, it does not need a live kernel, so it works for a process
 * that has already exited, and for one whose kernel is gone.
 *
 * ## `--follow`
 *
 * A live agent is still printing. `--follow` tails the file the way
 * `tail -f` does, so you can watch an agent work without attaching a
 * debugger to it. Ctrl-C (SIGINT / SIGTERM) detaches cleanly.
 *
 * Usage:
 *   cortex logs <pid>              print everything the process captured
 *   cortex logs <pid> --tail 20    print only the last 20 lines
 *   cortex logs <pid> --follow     print, then stream new lines as they land
 *
 * @module cli/commands/logs
 */

import { parseArgs } from 'node:util';
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { Buffer } from 'node:buffer';

import { defaultKernelDir } from '../index.js';
import { outputPath } from '../process_store.js';
import { asProcessId } from '../../kernel/types.js';

/** How often follow-mode re-reads the log file, in ms. */
const DEFAULT_POLL_INTERVAL_MS = 250;

export async function cmdLogs(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      follow: { type: 'boolean', short: 'f', default: false },
      tail: { type: 'string' },
      'timeout-ms': { type: 'string', default: '0' },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`cortex logs — what a process printed

USAGE
  cortex logs <pid>              Print everything the process captured
  cortex logs <pid> --tail 20    Print only the last 20 lines
  cortex logs <pid> --follow     Print, then stream new lines as they land

OPTIONS
  -f, --follow     Stream new lines as the process keeps printing
  --tail N         Show only the last N lines
  --timeout-ms N   Stop following after N ms (test/headless use; 0 = wait for
                   Ctrl-C / SIGTERM)
  -h, --help       Show this help

NOTES
  Reads <CORTEX_HOME>/processes/<pid>/output.log from disk — no live kernel
  needed, so it works for processes that already exited. Each line is
  "<timestamp> | <stream> | <text>", where <stream> is 'out' or 'err'.

EXAMPLES
  cortex logs 1234
  cortex logs 1234 --tail 20
  cortex logs 1234 --follow
`);
    return values.help ? 0 : 1;
  }

  const raw = positionals[0]!;
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid < 0) {
    console.error(`cortex logs: invalid PID: '${raw}'`);
    return 1;
  }

  const dir = defaultKernelDir();
  const file = outputPath(dir, asProcessId(pid));
  if (!existsSync(file)) {
    console.error(`cortex logs: no captured output for pid ${pid}`);
    console.error(`  (nothing was written to '${file}')`);
    console.error(`  (did the process run here? capture started with the 1.3.0 live kernel)`);
    return 1;
  }

  const tailRaw = values.tail;
  let tail: number | undefined;
  if (tailRaw !== undefined) {
    const parsed = Number.parseInt(tailRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      console.error(`cortex logs: invalid --tail: '${tailRaw}' (expected a non-negative integer)`);
      return 1;
    }
    tail = parsed;
  }

  const timeoutRaw = values['timeout-ms'];
  const timeoutMs =
    typeof timeoutRaw === 'string' && timeoutRaw.trim().length > 0
      ? Number.parseInt(timeoutRaw, 10) || 0
      : 0;

  // Read what is there now. With `--tail N`, only the last N lines are
  // printed — but the follow offset still starts at the end of the file, so
  // `--tail` and `--follow` compose the way `tail -n 20 -f` does.
  const initial = readFrom(file, 0);
  let offset = initial.offset;
  if (tail !== undefined) {
    const lines = initial.text.split('\n');
    // A trailing newline yields an empty last element; drop it.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const start = Math.max(0, lines.length - tail);
    const kept = lines.slice(start);
    // The follow phase starts at the end of the file, so the lines we just
    // printed are not printed again.
    offset = fileSize(file);
    if (kept.length > 0) printLines(`${kept.join('\n')}\n`);
  } else {
    printLines(initial.text);
  }

  if (values.follow !== true) return 0;

  // ---- follow mode -------------------------------------------------------
  let stopped = false;
  const onSignal = (): void => {
    stopped = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const timer = timeoutMs > 0 ? setTimeout(onSignal, timeoutMs) : undefined;
  if (timer !== undefined) timer.unref?.();

  try {
    while (!stopped) {
      await new Promise<void>((resolve) => setTimeout(resolve, DEFAULT_POLL_INTERVAL_MS));

      let size: number;
      try {
        size = fileSize(file);
      } catch {
        // The log file disappeared (e.g. the process directory was pruned).
        console.error('# log file removed; detaching');
        break;
      }

      if (size < offset) {
        // Truncated or rewritten underneath us — start over.
        offset = 0;
      }
      if (size === offset) continue;

      const chunk = readFrom(file, offset);
      offset = chunk.offset;
      printLines(chunk.text);
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (timer !== undefined) clearTimeout(timer);
  }

  console.error('# detached');
  return 0;
}

/**
 * Read the file from `offset` to its end.
 *
 * Returns the text and the offset just past the last byte read. If the file
 * shrank below `offset` it was rewritten underneath us, so the read starts
 * from the beginning again.
 */
function readFrom(path: string, offset: number): { text: string; offset: number } {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    let start = offset;
    if (size < start) start = 0;
    if (size === start) return { text: '', offset: start };
    const buffer = Buffer.alloc(size - start);
    const read = readSync(fd, buffer, 0, buffer.length, start);
    return { text: buffer.subarray(0, read).toString('utf8'), offset: start + read };
  } finally {
    closeSync(fd);
  }
}

/** The current size of the file, in bytes. */
function fileSize(path: string): number {
  const fd = openSync(path, 'r');
  try {
    return fstatSync(fd).size;
  } finally {
    closeSync(fd);
  }
}

/**
 * Print captured output verbatim.
 *
 * The stored lines already carry their timestamp and stream, so they are
 * printed as they are — the file and the terminal agree, which matters when
 * the operator is comparing them.
 */
function printLines(text: string): void {
  if (text.length === 0) return;
  process.stdout.write(text);
}
