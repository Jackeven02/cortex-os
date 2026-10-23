/**
 * cortex CLI — `cortex attach`
 *
 * BACKLOG #031: "interactive session with a running agent".
 *
 * `cortex attach` is the operator's seat in front of **one** agent: what it is
 * doing, right now, frame by frame.
 *
 * ## Two ways to get the frames
 *
 * The frames live in the process's `.crec` log, and there are two ways to
 * learn about a new one:
 *
 *   - **from the file** — read the log and see what is new. That needs no
 *     kernel, so it works for a process whose kernel is gone, and it is how
 *     `attach` worked for a long time. But it is a *poll*: the frame arrives
 *     up to a poll interval after the kernel wrote it, and every poll reads
 *     the whole file again.
 *   - **from the kernel** — subscribe to the event stream and be handed the
 *     frame the moment it is written. No polling, no re-reading, no lag.
 *
 * The transport carries streams now (docs/ARCHITECTURE.md §12.1), so `attach`
 * takes the second way whenever it can: if there is a live kernel and it
 * still holds the process, the frames arrive **by push**. The history still
 * comes from the file — the kernel's stream only carries what happens from
 * now on — and the two are stitched together by the frame's `byteOffset`, so
 * no frame is printed twice and none is missed.
 *
 * Without a live kernel (or when the kernel does not hold this process), the
 * file path is used, exactly as before. The header says which one is running,
 * because "it is following something" and "it is following something *now*"
 * are different promises.
 *
 * ## The interactive half (`--interactive`)
 *
 * The missing half was deferred to the daemon (#039). Now that `cortex
 * daemon run` keeps a kernel alive and publishes its endpoint
 * (docs/ARCHITECTURE.md §12.1), `attach --interactive` can do the thing
 * #031 actually asked for: every line you type is delivered into the
 * running agent's inbox through the live kernel, while the trace keeps
 * scrolling underneath. Ctrl-D (EOF) detaches.
 *
 * The trace surface is unchanged by this — `--interactive` adds the send
 * half, it does not replace the read half.
 *
 * Usage:
 *   cortex attach <pid>                    follow the syscall stream (default)
 *   cortex attach <pid> --once             dump the current log and exit
 *   cortex attach <pid> --interactive      type messages into the live agent
 *   cortex attach <file.crec>              follow a specific .crec file
 *
 * @module cli/commands/attach
 */

import { parseArgs } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Buffer } from 'node:buffer';

import { defaultKernelDir, existingCrecPath } from '../index.js';
import {
  CREC_HEADER_SIZE,
  CREC_FRAME_PREFIX_SIZE,
  CREC_MAGIC,
} from '../../kernel/recorder.js';
import { decode } from 'cborg';
import { unbrand, asProcessId, type SyscallRecord } from '../../kernel/types.js';
import { CortexError, isCortexError } from '../../kernel/errors.js';
import { formatRecordLine } from './trace.js';
import { KernelCommandError, probeKernel, type KernelClient } from '../kernel_client.js';

/** How often follow-mode re-reads the log file, in ms. */
const DEFAULT_POLL_INTERVAL_MS = 250;

/** The shape of an event frame's payload, as it arrives over the wire. */
interface WireEvent {
  readonly kind: string;
  readonly pid: number;
  readonly record?: unknown;
  readonly exitCode?: number | null;
  readonly exitReason?: string | null;
}

/**
 * Decode and print every *complete* frame in `path` starting at `fromByte`.
 *
 * Stops at a torn frame at EOF (the writer is mid-write) and returns the byte
 * offset of that torn frame's start, so the next poll re-reads from there once
 * the frame completes. A CBOR decode error mid-file is real corruption and is
 * thrown as ERECORD — matching `readRecords`.
 *
 * @param skipAtOrBelow Frames whose `byteOffset` is at or below this are
 *   consumed but **not printed** — they were already shown. This is how the
 *   pushed stream and the on-disk log are stitched: the file may hold frames
 *   the subscriber has already been handed.
 * @returns the byte offset just past the last complete frame, and the
 *   `byteOffset` of the last frame printed.
 */
async function dumpFrom(
  path: string,
  fromByte: number,
  options: { readonly skipAtOrBelow?: number } = {},
): Promise<{ cursor: number; lastOffset: number }> {
  const buf = Buffer.from(await readFile(path));

  // Validate the magic once, on the very first read (fromByte === header).
  if (fromByte === CREC_HEADER_SIZE) {
    if (buf.byteLength < CREC_HEADER_SIZE) {
      // Empty / too-short file: nothing to print yet.
      return { cursor: CREC_HEADER_SIZE, lastOffset: -1 };
    }
    const magic = buf.subarray(0, CREC_HEADER_SIZE);
    if (!magic.equals(Buffer.from(CREC_MAGIC))) {
      throw new CortexError('EINVAL', 'attach', {
        message: 'not a .crec file (magic mismatch)',
        details: { path },
      });
    }
  }

  let cursor = fromByte;
  let lastOffset = -1;
  while (cursor < buf.byteLength) {
    // Need at least the length prefix to proceed.
    if (buf.byteLength - cursor < CREC_FRAME_PREFIX_SIZE) break; // torn header

    const declaredLength = buf.readUInt32BE(cursor);
    const payloadStart = cursor + CREC_FRAME_PREFIX_SIZE;
    const payloadEnd = payloadStart + declaredLength;
    if (payloadEnd > buf.byteLength) break; // torn payload

    const payload = buf.subarray(payloadStart, payloadEnd);
    let decoded: unknown;
    try {
      decoded = decode(payload);
    } catch (err) {
      throw new CortexError('ERECORD', 'attach', {
        message: 'CBOR decode failed mid-file (corruption?)',
        details: { path, frameStart: cursor, declaredLength },
        cause: err,
      });
    }

    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      !('syscall' in decoded) ||
      !('phase' in decoded)
    ) {
      throw new CortexError('ERECORD', 'attach', {
        message: 'decoded frame is not a SyscallRecord',
        details: { path, frameStart: cursor },
      });
    }

    const record = decoded as SyscallRecord;
    const offset = typeof record.byteOffset === 'number' ? record.byteOffset : -1;
    const alreadyShown = options.skipAtOrBelow !== undefined && offset >= 0 && offset <= options.skipAtOrBelow;
    if (!alreadyShown) {
      console.log(formatRecordLine(record));
      if (offset >= 0) lastOffset = offset;
    }
    cursor = payloadEnd;
  }

  return { cursor, lastOffset };
}

/**
 * Does the live kernel still hold this process?
 *
 * The answer decides how the frames are obtained: a process the kernel holds
 * can be watched by push; a process it does not hold (it exited, or another
 * kernel owns it) can only be read from its log.
 */
async function kernelHasProcess(client: KernelClient, pid: number): Promise<boolean> {
  try {
    const result = (await client.request('ps')) as {
      readonly processes?: readonly { readonly pid: number }[];
    };
    return (result.processes ?? []).some((p) => p.pid === pid);
  } catch {
    return false;
  }
}

export async function cmdAttach(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      once: { type: 'boolean', default: false },
      follow: { type: 'boolean', short: 'f', default: false },
      interactive: { type: 'boolean', default: false },
      'timeout-ms': { type: 'string', default: '0' },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`cortex attach — follow a process's syscall stream

USAGE
  cortex attach <pid>         Follow the syscall stream (default)
  cortex attach <pid> --once  Dump the current log and exit
  cortex attach <file.crec>   Follow a specific .crec file

OPTIONS
  -f, --follow     Stream new frames as the log grows (default when attached)
  --once           Print the current log and exit (no polling)
  --interactive    Deliver each line of stdin to the live agent, through the
                   running kernel. Needs one: 'cortex daemon run' publishes
                   its endpoint in <CORTEX_HOME>/kernel.json. Ctrl-D detaches.
  --timeout-ms N   Auto-detach after N ms (test/headless use; default 0 = wait
                   for Ctrl-C / SIGTERM)
  -h, --help       Show this help

NOTES
  With a live kernel that still holds the process, the frames arrive **by
  push**: the kernel hands over each one as it is written, so there is no poll
  interval and nothing is re-read. Without one — or for a process the kernel
  does not hold — the log file is followed instead, which works even when the
  kernel is gone. The header says which of the two is running.

  The interactive half needs a live kernel: a message has to land in a process
  that is still running, and only a running kernel has one.

EXAMPLES
  cortex attach 1234
  cortex attach 1234 --once
  cortex attach 1234 --interactive
  cortex attach .cortex/processes/2.crec --once
`);
    return values.help ? 0 : 1;
  }

  const target = positionals[0]!;
  const interactive = values.interactive === true;
  const dir = defaultKernelDir();

  // Resolve the .crec file path: either a direct file, or a PID.
  let crecFile: string;
  let targetPid: number | undefined;
  if (existsSync(target) && target.endsWith('.crec')) {
    if (interactive) {
      console.error('cortex attach --interactive: needs a PID, not a .crec file');
      console.error('  (the interactive half addresses a live process)');
      return 1;
    }
    crecFile = target;
  } else {
    const pid = Number(target);
    if (!Number.isInteger(pid) || pid < 0) {
      console.error(`cortex attach: invalid PID or file: '${target}'`);
      return 1;
    }
    crecFile = existingCrecPath(dir, asProcessId(pid));
    if (!existsSync(crecFile)) {
      console.error(`cortex attach: no .crec file at '${crecFile}'`);
      console.error(`  (did you 'cortex spawn' this PID?)`);
      return 1;
    }
    targetPid = pid;
  }

  // One probe for both halves: the interactive half needs a live kernel to
  // deliver into, and the follow half can take its frames *from* one.
  const probe = await probeKernel(dir);
  const client = probe.kind === 'live' ? probe.client : undefined;

  if (interactive && client === undefined) {
    if (probe.kind === 'stale') {
      console.error(
        `cortex attach: the kernel that published ${probe.endpoint.host}:${probe.endpoint.port} ` +
        `is not reachable (${probe.reason})`,
      );
    } else {
      console.error('cortex attach --interactive: no live kernel is running in this directory');
      console.error("  start one with `cortex daemon run` — a message needs a running process");
    }
    return 1;
  }

  // `--follow` is the default when attached (so `attach <pid>` streams);
  // `--once` is the only switch that turns streaming off. The `-f/--follow`
  // flag is accepted for symmetry but is the default behavior.
  const follow = values.once !== true;
  const timeoutRaw = values['timeout-ms'];
  const timeoutMs =
    typeof timeoutRaw === 'string' && timeoutRaw.trim().length > 0
      ? Number.parseInt(timeoutRaw, 10) || 0
      : 0;

  // Is this process the live kernel's? If it is, its frames can come by
  // push; if it is not, the log file is the only place they can come from.
  let kernelHasIt = false;
  if (client !== undefined && targetPid !== undefined) {
    kernelHasIt = await kernelHasProcess(client, targetPid);
  }
  const live = follow && client !== undefined && kernelHasIt;

  console.log(`# attach ${crecFile}${live ? ' (live — frames by push from the kernel)' : follow ? ' (follow-mode)' : ' (once)'}`);
  console.log('time                  pid    syscall           phase   duration  reversibility');
  console.log('-'.repeat(85));

  if (!follow) {
    try {
      await dumpFrom(crecFile, CREC_HEADER_SIZE);
    } catch (err) {
      if (isCortexError(err)) {
        console.error(`cortex attach: ${err.errno}: ${err.message}`);
        client?.close();
        return 1;
      }
      throw err;
    }
    console.log('# detached (once)');
    client?.close();
    return 0;
  }

  // ---- follow mode -------------------------------------------------------
  // One stop signal for the whole command: Ctrl-C, SIGTERM, the timeout, or
  // EOF on stdin (which is the interactive half saying "I am done talking").
  // The pushed path waits on it; the file path polls it.
  let stopped = false;
  let resolveStop: (() => void) | undefined;
  const stopPromise = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
  const onSignal = (): void => {
    stopped = true;
    resolveStop?.();
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const timer = timeoutMs > 0 ? setTimeout(onSignal, timeoutMs) : undefined;
  if (timer !== undefined) {
    // Don't let the timer keep the event loop alive on its own.
    timer.unref?.();
  }

  // The interactive half: every line typed here is delivered into the live
  // agent's inbox through the running kernel. It runs beside the trace
  // follower, so the two halves of `attach` — read and write — are live at the
  // same time.
  let kernelGone = false;
  const reader =
    interactive && client !== undefined && targetPid !== undefined
      ? startInteractiveReader(
          client,
          targetPid,
          onSignal,
          () => {
            kernelGone = true;
          },
        )
      : undefined;

  try {
    if (live && client !== undefined && targetPid !== undefined) {
      const result = await followByPush({
        client,
        pid: targetPid,
        crecFile,
        stopPromise,
      });
      if (result.exited) {
        console.log(`# pid ${targetPid} exited with code ${result.exitCode ?? '?'}${result.exitReason ? ` (${result.exitReason})` : ''}`);
      }
      if (result.kernelGone) kernelGone = true;
    } else {
      // The file path: read the history, then watch the log for what is new.
      let cursor = CREC_HEADER_SIZE;
      let historyFailed = false;
      try {
        ({ cursor } = await dumpFrom(crecFile, cursor));
      } catch (err) {
        if (isCortexError(err)) {
          console.error(`cortex attach: ${err.errno}: ${err.message}`);
          historyFailed = true;
        } else {
          throw err;
        }
      }

      while (!stopped && !historyFailed) {
        await new Promise<void>((resolve) => setTimeout(resolve, DEFAULT_POLL_INTERVAL_MS));

        let size: number;
        try {
          size = statSync(crecFile).size;
        } catch {
          // Log file disappeared (e.g. `cortex kill` reaped and pruned it).
          console.log('# log file removed; detaching');
          break;
        }

        if (size < cursor) {
          // File was truncated/rewritten underneath us. Re-read from the top;
          // a duplicate dump here is acceptable and rare in v0 (no rotation yet).
          cursor = CREC_HEADER_SIZE;
        }
        if (size <= cursor) continue;

        try {
          ({ cursor } = await dumpFrom(crecFile, cursor));
        } catch (err) {
          if (isCortexError(err)) {
            console.error(`cortex attach: ${err.errno}: ${err.message}`);
            break;
          }
          throw err;
        }
      }
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (timer !== undefined) clearTimeout(timer);
    await reader?.stop();
    client?.close();
  }

  if (kernelGone) {
    if (live) {
      // The frames came from the kernel, so the kernel going away ends the
      // follow. The process went with it, and nothing says how it ended.
      console.error('cortex attach: the kernel went away — the follow did not finish; the process\'s fate is unknown');
    } else {
      // The follow kept working — the log is on disk — but the delivery half
      // of this command is over, and it did not end the way it was asked to.
      console.error('cortex attach: the kernel went away — the log was followed, but nothing was delivered');
    }
    return 1;
  }

  console.log('# detached');
  return 0;
}

// =============================================================================
// The pushed path
// =============================================================================

interface PushResult {
  /** Where the file cursor is, for a final catch-up. */
  readonly cursor: number;
  /** The `byteOffset` of the last frame printed. */
  readonly lastOffset: number;
  /** The process ended while we were following it. */
  readonly exited: boolean;
  readonly exitCode: number | null | undefined;
  readonly exitReason: string | null | undefined;
  /** The kernel went away before the process ended. */
  readonly kernelGone: boolean;
}

/**
 * Follow a process by push: the kernel hands over each frame as it writes it.
 *
 * The history comes from the file (the kernel's stream only carries what
 * happens from now on), and the two are stitched by the frame's `byteOffset`:
 * a frame that is already in the history is not printed twice, and a frame
 * that arrives while the history is being read is held and printed after it.
 *
 * The follow ends three ways, and each is reported honestly:
 *
 *   - the **process exits** — the kernel says so, with the real exit code,
 *     and the follow is complete;
 *   - the **operator detaches** (Ctrl-C, or `--timeout-ms`);
 *   - the **kernel goes away** — nothing more can arrive, and the operator is
 *     told that the follow did not finish.
 */
async function followByPush(options: {
  readonly client: KernelClient;
  readonly pid: number;
  readonly crecFile: string;
  readonly stopPromise: Promise<void>;
}): Promise<PushResult> {
  const { client, pid, crecFile } = options;

  let cursor = CREC_HEADER_SIZE;
  let lastOffset = -1;
  let kernelGone = false;
  let exited = false;
  let exitCode: number | null | undefined;
  let exitReason: string | null | undefined;

  // Frames that arrive while the history is being read are held, so that
  // nothing is lost and nothing is shown twice.
  const held: WireEvent[] = [];
  let ready = false;

  const print = (event: WireEvent): void => {
    if (event.kind !== 'record' || event.record === undefined) return;
    const record = event.record as SyscallRecord;
    const offset = typeof record.byteOffset === 'number' ? record.byteOffset : -1;
    // A frame the history already showed.
    if (offset >= 0 && lastOffset >= 0 && offset <= lastOffset) return;
    console.log(formatRecordLine(record));
    if (offset >= 0) lastOffset = offset;
  };

  // The follow ends when the process exits, when the kernel goes away, or
  // when the operator detaches. The first two are the kernel's news; the
  // third is the caller's stop signal.
  let finish: (() => void) | undefined;
  const endPromise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  client.onClose(() => {
    kernelGone = true;
    finish?.();
  });

  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = await client.subscribe(
      (raw) => {
        const event = raw as WireEvent;
        if (event.kind === 'record') {
          if (!ready) {
            held.push(event);
            return;
          }
          print(event);
          return;
        }
        if (event.kind === 'process-exit' && event.pid === pid) {
          exited = true;
          exitCode = event.exitCode ?? null;
          exitReason = event.exitReason ?? null;
          finish?.();
        }
      },
      { pid, kinds: ['record', 'process-exit'] },
    );
  } catch (err) {
    if (err instanceof KernelCommandError) {
      console.error(`cortex attach: ${err.errno}: ${err.message}`);
    } else if (client.closed) {
      console.error('cortex attach: the kernel went away while attaching');
    } else {
      throw err;
    }
    return { cursor, lastOffset, exited, exitCode, exitReason, kernelGone: client.closed };
  }

  // The subscription is open *before* the history is read, so a frame written
  // while the history is being read is not lost: it is held, and the
  // byteOffset check below drops the ones the history already showed.
  try {
    ({ cursor, lastOffset } = await dumpFrom(crecFile, cursor));
  } catch (err) {
    if (isCortexError(err)) {
      console.error(`cortex attach: ${err.errno}: ${err.message}`);
      unsubscribe?.();
      return { cursor, lastOffset, exited, exitCode, exitReason, kernelGone };
    }
    throw err;
  }

  ready = true;
  for (const event of held) print(event);
  held.length = 0;

  await Promise.race([options.stopPromise, endPromise]);

  unsubscribe?.();

  // A last catch-up from the file: the kernel may have written frames that
  // the stream did not carry (the ones written as it shut down).
  try {
    const dumped = await dumpFrom(crecFile, cursor, { skipAtOrBelow: lastOffset });
    cursor = dumped.cursor;
  } catch {
    // A missing or unreadable log at this point is not worth failing over:
    // the frames that mattered have already been printed.
  }

  return { cursor, lastOffset, exited, exitCode, exitReason, kernelGone };
}

// =============================================================================
// The interactive half
// =============================================================================

/**
 * Read stdin and deliver each line into the live agent.
 *
 * The reader is deliberately *not* the thing that ends the session: EOF
 * (Ctrl-D) ends it, because that is what "I am done talking" looks like on a
 * terminal. The trace follower keeps running until then, so the operator
 * sees both the frames their message produced and the ones it did not.
 */
interface InteractiveReader {
  /** Stop reading and release stdin. */
  stop(): Promise<void>;
}

function startInteractiveReader(
  client: KernelClient,
  pid: number,
  onEof: () => void,
  onKernelGone: () => void,
): InteractiveReader {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  /** True once the kernel left and delivery became impossible. */
  let deliveryGone = false;

  const loop = (async (): Promise<void> => {
    try {
      for await (const line of rl) {
        const message = line.trim();
        if (message.length === 0) continue;
        try {
          await client.request('send', { pid, message });
          console.log(`> delivered to pid ${pid}: ${message}`);
        } catch (err) {
          if (client.closed) {
            // The kernel went away. Nothing can be *delivered* any more, and
            // saying "read ECONNRESET" for every keystroke would be noise.
            // The trace half follows the file and does not need a kernel, so
            // it keeps going — but the operator is told, once, that half of
            // this command is over.
            console.error(
              'cortex attach: the kernel went away — messages can no longer be delivered',
            );
            console.error('  the log is still on disk, so this keeps following it; Ctrl-C to detach');
            deliveryGone = true;
            onKernelGone();
            rl.close();
            break;
          }
          if (err instanceof KernelCommandError) {
            console.error(`cortex attach: ${err.errno}: ${err.message}`);
          } else {
            console.error(`cortex attach: ${(err as Error).message}`);
          }
        }
      }
    } catch {
      // stdin closed underneath us — treat it like EOF.
    } finally {
      // Only a real EOF ends the session. The kernel leaving ends the
      // *delivery*, not the follow.
      if (!deliveryGone) onEof();
    }
  })();

  return {
    async stop(): Promise<void> {
      rl.close();
      // The loop ends when readline stops emitting; closing the interface
      // is what makes that happen.
      await loop.catch(() => undefined);
    },
  };
}
