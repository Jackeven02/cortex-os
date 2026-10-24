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
 * A live agent is still printing. `--follow` shows what it prints as it
 * prints it, so you can watch an agent work without attaching a debugger to
 * it. Ctrl-C (SIGINT / SIGTERM) detaches cleanly.
 *
 * **With a live kernel that still holds the process, the lines come by
 * push.** The kernel relays every line the moment it is printed, so there
 * is no poll interval between the agent and the terminal — and the follow
 * ends **by itself** when the process ends, because the kernel says when a
 * process ends and how it ended. Without a live kernel (or for a process the
 * kernel does not hold) the file is polled, as it always was.
 *
 * The two are stitched the way `cortex attach` stitches the syscall log and
 * its stream: the subscription opens **before** the history is read, and the
 * lines are joined by their byte offset in the file — so a line is never
 * shown twice, and never lost.
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
import { formatOutputEntry, outputPath } from '../process_store.js';
import { explainKernelGone, probeKernel } from '../kernel_client.js';
import { asProcessId } from '../../kernel/types.js';

/** How often follow-mode re-reads the log file, in ms. */
const DEFAULT_POLL_INTERVAL_MS = 250;

/** The shape of an event frame's payload, as it arrives over the wire. */
interface WireEvent {
  readonly kind: string;
  readonly pid: number;
  /** Where a pushed line sits in the process's captured output. */
  readonly byteOffset?: number;
  readonly line?: { readonly at: string; readonly stream: string; readonly text: string };
  readonly exitCode?: number | null;
  readonly exitReason?: string | null;
}

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

  --follow streams the new lines as they land. With a live kernel that still
  holds the process, they arrive by push (no polling in between) and the
  follow ends by itself when the process ends. Without one, the file is
  polled every 250 ms.

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
  const hasFile = existsSync(file);

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

  // ---- follow mode -------------------------------------------------------
  let fallback: string | undefined;
  if (values.follow === true) {
    // With a live kernel that still holds this process, the lines come by
    // **push**: the kernel relays every line the moment it is printed, so
    // there is no poll interval between the agent and the terminal. Without
    // one — or for a process the kernel does not hold — the file is polled,
    // exactly as it always was.
    //
    // The push path does not need the file to exist: a process that has not
    // printed anything yet has no output log, and following it is exactly
    // what the operator asked for.
    const outcome = await followByPush(dir, pid, file, tail, timeoutMs);
    if (outcome.kind === 'pushed') return outcome.code;
    // There was nothing to push from. The file still has the lines — but the
    // operator is now watching a *poller*, not a live stream, and that
    // difference is the whole point of the push path. So it is said out loud.
    fallback = outcome.why;
  }

  // The file is the only source left, and there is nothing in it.
  if (!hasFile) {
    console.error(`cortex logs: no captured output for pid ${pid}`);
    console.error(`  (nothing was written to '${file}')`);
    console.error(
      fallback === undefined
        ? '  (did the process run here? capture started with the 1.3.0 live kernel)'
        : `  (${fallback})`,
    );
    return 1;
  }

  if (fallback !== undefined) {
    console.error(
      `# following pid ${pid} (${fallback} — reading the file every ${DEFAULT_POLL_INTERVAL_MS} ms)`,
    );
  }

  // Read what is there now. With `--tail N`, only the last N lines are
  // printed — but the follow offset still starts at the end of the file, so
  // `--tail` and `--follow` compose the way `tail -n 20 -f` does.
  let offset = printHistory(file, tail);

  if (values.follow !== true) return 0;

  return await followByPolling(file, offset, timeoutMs);
}

/**
 * Print the captured history and return the file offset it ends at.
 *
 * With `--tail N` only the last N lines are printed, but the offset returned
 * is still the end of the file: the lines before the tail are not part of
 * this follow, exactly as `tail -n 20 -f` does not show them either.
 */
function printHistory(file: string, tail: number | undefined): number {
  const initial = readFrom(file, 0);
  if (tail === undefined) {
    printLines(initial.text);
    return initial.offset;
  }
  const lines = initial.text.split('\n');
  // A trailing newline yields an empty last element; drop it.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const start = Math.max(0, lines.length - tail);
  const kept = lines.slice(start);
  const offset = fileSize(file);
  if (kept.length > 0) printLines(`${kept.join('\n')}\n`);
  return offset;
}

/**
 * Whether a pushed line was already shown by the history read.
 *
 * The history read covers the file up to `printedUpTo`; a line that starts
 * before that was in the file when it was read, and printing it again would
 * show the operator the same line twice. A line that starts *at* or after
 * it was written after the read, and is new.
 *
 * Exported because the rule is worth pinning on its own: the window where
 * the file and the stream overlap is narrow by nature, so an end-to-end test
 * cannot be relied on to land in it every time.
 */
export function alreadyShown(offset: number, printedUpTo: number): boolean {
  return offset >= 0 && offset < printedUpTo;
}

/**
 * What the follow ended up doing.
 *
 * `pushed` means the live kernel relayed the lines and the follow is over.
 * `fallback` means there was nothing to push from — and it carries the reason,
 * because a follow that quietly changes its behaviour is a follow the operator
 * cannot trust: the lines still arrive, but now they arrive up to a quarter
 * of a second late, and nobody would know.
 */
type FollowOutcome =
  | { readonly kind: 'pushed'; readonly code: number }
  | { readonly kind: 'fallback'; readonly why: string };

/**
 * Follow the output by push, through a live kernel.
 *
 * Returns `fallback` when there is no live kernel to push from — the caller
 * then falls back to the file follower, and says why.
 *
 * The two are stitched the way `cortex attach` stitches the syscall log and
 * its stream: the subscription opens **before** the history is read, and the
 * lines are joined by their byte offset in the file. A line the file read
 * already printed is not printed again, and a line printed while the history
 * was being read is printed once, from the stream.
 */
async function followByPush(
  dir: string,
  pid: number,
  file: string,
  tail: number | undefined,
  timeoutMs: number,
): Promise<FollowOutcome> {
  const probe = await probeKernel(dir);
  if (probe.kind !== 'live') {
    const why =
      probe.kind === 'absent'
        ? 'no live kernel'
        : `the kernel is not answering (${probe.reason})`;
    return { kind: 'fallback', why };
  }
  const client = probe.client;

  // Does the kernel still hold this process? A process that has already
  // ended has nothing left to push — every line it printed is in the file.
  try {
    const listing = await client.request<{ processes: { pid: number }[] }>('ps');
    if (!listing.processes.some((p) => p.pid === pid)) {
      client.close();
      return { kind: 'fallback', why: `the kernel no longer holds pid ${pid}` };
    }
  } catch (err) {
    client.close();
    return {
      kind: 'fallback',
      why: `the kernel did not answer the process list (${(err as Error).message})`,
    };
  }

  /** Lines that arrive before the history has been read. */
  const held: WireEvent[] = [];
  let ready = false;
  /** The file offset up to which the operator has been shown the output. */
  let printedUpTo = 0;
  let exited = false;
  let exitCode: number | null = null;
  let exitReason: string | null = null;
  let kernelGone = false;
  /** Called when the follow should stop — by the process ending, or by us. */
  let stop: (() => void) | undefined;

  const handle = (event: WireEvent): void => {
    if (event.kind === 'output') {
      if (event.line === undefined) return;
      const offset = event.byteOffset ?? -1;
      // A line that starts behind the read position was printed by the file
      // read — printing it again would show the operator two of them.
      if (alreadyShown(offset, printedUpTo)) return;
      printedUpTo = offset + Buffer.byteLength(formatOutputEntry(event.line));
      printLines(formatOutputEntry(event.line));
      return;
    }
    if (event.kind === 'process-exit') {
      exited = true;
      exitCode = event.exitCode ?? null;
      exitReason = event.exitReason ?? null;
      stop?.();
    }
  };

  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = await client.subscribe((raw) => {
      const event = raw as WireEvent;
      if (!ready) {
        held.push(event);
        return;
      }
      handle(event);
    }, { pid, kinds: ['output', 'process-exit'] });
  } catch (err) {
    // The kernel went away between the probe and the subscription. The file
    // still has everything, so the file follower takes over.
    client.close();
    return {
      kind: 'fallback',
      why: `the kernel refused the subscription (${(err as Error).message})`,
    };
  }

  client.onClose(() => {
    kernelGone = true;
    stop?.();
  });

  console.error(`# following pid ${pid} (live — lines by push from the kernel)`);

  // The history, read **after** the subscription opened: nothing printed in
  // between is lost, and the offset says which lines the file already gave.
  printedUpTo = printHistory(file, tail);
  ready = true;
  for (const event of held) handle(event);
  held.length = 0;

  // Wait until the process ends, the operator interrupts, the timeout
  // elapses, or the kernel goes away.
  const onInterrupt = (): void => {
    stop?.();
  };
  await new Promise<void>((resolve) => {
    stop = (): void => {
      resolve();
    };
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onInterrupt);
    if (timeoutMs > 0) {
      const timer = setTimeout(() => stop?.(), timeoutMs);
      // The open socket keeps the process alive; the timer must not.
      timer.unref?.();
    }
    // The process may already have ended while the history was being read.
    if (exited || kernelGone) stop();
  });

  unsubscribe?.();
  client.close();
  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onInterrupt);

  if (kernelGone) {
    const why = await explainKernelGone(dir);
    console.error(`cortex logs: ${why}`);
    console.error('  the follow did not finish — it lost the kernel it was following.');
    return { kind: 'pushed', code: 1 };
  }
  if (exited) {
    const codeText = exitCode === null ? 'abnormally' : `with code ${exitCode}`;
    const reasonText = exitReason === null ? '' : ` (${exitReason})`;
    console.error(`# pid ${pid} exited ${codeText}${reasonText}`);
    return { kind: 'pushed', code: 0 };
  }
  console.error('# detached');
  return { kind: 'pushed', code: 0 };
}

/**
 * Follow the output by polling the file.
 *
 * The fallback for when there is no live kernel to push from. It is the
 * shape the command always had: read the file, wait, read again.
 */
async function followByPolling(file: string, offset: number, timeoutMs: number): Promise<number> {
  let stopped = false;
  const onSignal = (): void => {
    stopped = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const timer = timeoutMs > 0 ? setTimeout(onSignal, timeoutMs) : undefined;
  if (timer !== undefined) timer.unref?.();

  try {
    let seenFile = false;
    while (!stopped) {
      await new Promise<void>((resolve) => setTimeout(resolve, DEFAULT_POLL_INTERVAL_MS));

      if (!existsSync(file)) {
        // The file may not exist *yet* — a process that has not printed
        // anything has no output log. It may also have been removed.
        if (seenFile) {
          console.error('# log file removed; detaching');
          break;
        }
        continue;
      }
      seenFile = true;

      const size = fileSize(file);
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
 *
 * A file that is not there yet is not an error: a process that has not
 * printed anything has no output log, and a follower must be able to wait
 * for one.
 */
function readFrom(path: string, offset: number): { text: string; offset: number } {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return { text: '', offset: 0 };
  }
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

/** The current size of the file, in bytes. Zero when it is not there yet. */
function fileSize(path: string): number {
  try {
    const fd = openSync(path, 'r');
    try {
      return fstatSync(fd).size;
    } finally {
      closeSync(fd);
    }
  } catch {
    return 0;
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
