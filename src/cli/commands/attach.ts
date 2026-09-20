/**
 * cortex CLI — `cortex attach`
 *
 * BACKLOG #031: "interactive session with a running agent".
 *
 * v0 reality check: the CLI is a *short-lived process model* — each `cortex`
 * command boots a temp kernel, does its work, persists to `.cortex/`, and
 * exits. There is no long-lived kernel holding a live agent that another
 * `cortex` invocation can pipe stdin into. So the honest v0 surface of
 * `attach` is:
 *
 *   **A read-only, disk-based follow-mode syscall trace** — `tail -f` on the
 *   process's `.crec` log. It dumps every syscall the agent has made so far
 *   and, in `--follow` mode, polls the file and prints new frames as another
 *   `cortex` invocation (a `spawn`/`restore`/`fork` in the future daemon model)
 *   appends them. SIGINT / SIGTERM detaches cleanly.
 *
 * This works *because* the on-disk log is the source of truth across CLI
 * invocations. Once #039 lands a real daemon, the interactive IPC half (pipe
 * stdin → `send` to the live process) can be layered on top without changing
 * this command's trace surface. We do NOT promise an interactive prompt in v0.
 *
 * Usage:
 *   cortex attach <pid>            follow the syscall stream (default)
 *   cortex attach <pid> --once     dump the current log and exit
 *   cortex attach <file.crec>      follow a specific .crec file
 *
 * @module cli/commands/attach
 */

import { parseArgs } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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

/** How often follow-mode re-reads the log file, in ms. */
const DEFAULT_POLL_INTERVAL_MS = 250;

/**
 * Decode and print every *complete* frame in `path` starting at `fromByte`.
 *
 * Stops at a torn frame at EOF (the writer is mid-write) and returns the byte
 * offset of that torn frame's start, so the next poll re-reads from there once
 * the frame completes. A CBOR decode error mid-file is real corruption and is
 * thrown as ERECORD — matching `readRecords`.
 *
 * @returns the byte offset just past the last complete frame printed.
 */
async function dumpFrom(path: string, fromByte: number): Promise<number> {
  const buf = Buffer.from(await readFile(path));

  // Validate the magic once, on the very first read (fromByte === header).
  if (fromByte === CREC_HEADER_SIZE) {
    if (buf.byteLength < CREC_HEADER_SIZE) {
      // Empty / too-short file: nothing to print yet.
      return CREC_HEADER_SIZE;
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

    console.log(formatRecordLine(decoded as SyscallRecord));
    cursor = payloadEnd;
  }

  return cursor;
}

export async function cmdAttach(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      once: { type: 'boolean', default: false },
      follow: { type: 'boolean', short: 'f', default: false },
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
  --timeout-ms N   Auto-detach after N ms (test/headless use; default 0 = wait
                  for Ctrl-C / SIGTERM)
  -h, --help       Show this help

NOTES
  v0 attaches to the on-disk .crec log, not a live in-memory process — the CLI
  is a short-lived process model (see BACKLOG #031). New frames appear when
  another cortex invocation appends to the same log (e.g. a restored agent, or
  a future daemon). The interactive send-half (pipe stdin -> IPC) is deferred
  to #039 (cortex daemon install).

EXAMPLES
  cortex attach 1234
  cortex attach 1234 --once
  cortex attach .cortex/processes/2.crec --once
`);
    return values.help ? 0 : 1;
  }

  const target = positionals[0]!;

  // Resolve the .crec file path: either a direct file, or a PID.
  let crecFile: string;
  if (existsSync(target) && target.endsWith('.crec')) {
    crecFile = target;
  } else {
    const pid = Number(target);
    if (!Number.isInteger(pid) || pid < 0) {
      console.error(`cortex attach: invalid PID or file: '${target}'`);
      return 1;
    }
    const dir = defaultKernelDir();
    crecFile = existingCrecPath(dir, asProcessId(pid));
    if (!existsSync(crecFile)) {
      console.error(`cortex attach: no .crec file at '${crecFile}'`);
      console.error(`  (did you 'cortex spawn' this PID?)`);
      return 1;
    }
  }

  // `--follow` is the default when attached (so `attach <pid>` streams);
  // `--once` is the only switch that turns polling off. The `-f/--follow`
  // flag is accepted for symmetry but is the default behavior.
  const follow = values.once !== true;
  const timeoutRaw = values['timeout-ms'];
  const timeoutMs =
    typeof timeoutRaw === 'string' && timeoutRaw.trim().length > 0
      ? Number.parseInt(timeoutRaw, 10) || 0
      : 0;

  console.log(`# attach ${crecFile}${follow ? ' (follow-mode)' : ' (once)'}`);
  console.log('time                  pid    syscall           phase   duration  reversibility');
  console.log('-'.repeat(85));

  let offset = CREC_HEADER_SIZE;
  try {
    offset = await dumpFrom(crecFile, offset);
  } catch (err) {
    if (isCortexError(err)) {
      console.error(`cortex attach: ${err.errno}: ${err.message}`);
      return 1;
    }
    throw err;
  }

  if (!follow) {
    console.log('# detached (once)');
    return 0;
  }

  // ---- follow mode -------------------------------------------------------
  let stopped = false;
  const onSignal = (): void => {
    stopped = true;
  };
  const onTimeout = (): void => {
    stopped = true;
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const timer = timeoutMs > 0 ? setTimeout(onTimeout, timeoutMs) : undefined;
  if (timer !== undefined) {
    // Don't let the timer keep the event loop alive on its own.
    timer.unref?.();
  }

  try {
    while (!stopped) {
      await new Promise<void>((resolve) => setTimeout(resolve, DEFAULT_POLL_INTERVAL_MS));

      let size: number;
      try {
        size = statSync(crecFile).size;
      } catch {
        // Log file disappeared (e.g. `cortex kill` reaped and pruned it).
        console.log('# log file removed; detaching');
        break;
      }

      if (size < offset) {
        // File was truncated/rewritten underneath us. Re-read from the top;
        // a duplicate dump here is acceptable and rare in v0 (no rotation yet).
        offset = CREC_HEADER_SIZE;
      }
      if (size <= offset) continue;

      try {
        offset = await dumpFrom(crecFile, offset);
      } catch (err) {
        if (isCortexError(err)) {
          console.error(`cortex attach: ${err.errno}: ${err.message}`);
          break;
        }
        throw err;
      }
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (timer !== undefined) clearTimeout(timer);
  }

  console.log('# detached');
  return 0;
}
