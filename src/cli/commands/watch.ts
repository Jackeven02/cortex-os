/**
 * cortex CLI — `cortex watch`
 *
 * ## The question this answers
 *
 * *"What is the kernel doing right now?"*
 *
 * `cortex ps` tells you where things stand, `cortex logs` tells you what a
 * process printed, `cortex memory` tells you what it knows. None of them
 * tells you what is happening *as it happens* — to see that, the operator had
 * to poll, and a polling loop is a latency tax and a race.
 *
 * `cortex watch` subscribes to the kernel's event stream and prints what
 * arrives, the instant it arrives.
 *
 * ## Why this is a different shape from `attach`
 *
 * `cortex attach` follows a `.crec` **file**: it works without a kernel, it
 * shows the log of one process, and it discovers new frames by polling the
 * file every 250 ms. That is the right tool for looking at a process's past.
 *
 * `cortex watch` follows the **kernel**: it needs a live one, it can show
 * every process at once, and the frames reach it by push — the kernel writes
 * a frame and the subscriber sees it, with no polling in between. That is the
 * difference the transport used to lack: it carried commands, not streams.
 *
 * ## What arrives
 *
 * - **`record`** — a syscall frame was appended to a process's `.crec` log.
 *   This is the live equivalent of `cortex trace`, printed in the same
 *   column layout, at the same `byteOffset` the file now holds.
 * - **`process-start`** — a process was born.
 * - **`process-exit`** — a process ended, with its **real** exit code.
 * - **`output`** — a line a process printed. It is *not* shown by default:
 *   an agent that prints a lot would drown the syscall frames, and this
 *   command is about what the kernel *did*. Ask for it with
 *   `--events output` when that is what you are watching for.
 *
 * Usage:
 *   cortex watch                          everything the kernel reports
 *   cortex watch --pid 2                  one process only
 *   cortex watch --events record          only the syscall frames
 *   cortex watch --timeout-ms 5000        stop after five seconds (headless)
 *
 * @module cli/commands/watch
 */

import { parseArgs } from 'node:util';

import { defaultKernelDir } from '../index.js';
import { explainKernelGone, KernelCommandError, probeKernel } from '../kernel_client.js';
import { formatRecordLine } from './trace.js';
import type { SyscallRecord } from '../../kernel/types.js';

/** The shape of an event frame's payload, as it arrives over the wire. */
interface WireEvent {
  readonly kind: string;
  readonly pid: number;
  readonly record?: unknown;
  readonly line?: { readonly at: string; readonly stream: string; readonly text: string };
  readonly exitCode?: number | null;
  readonly exitReason?: string | null;
  readonly ppid?: number | null;
  readonly role?: string;
}

/** The event kinds a subscriber may ask for, in the order we document them. */
const EVENT_KINDS = ['record', 'process-start', 'process-exit', 'output'] as const;

/**
 * The kinds this command shows when the operator does not say.
 *
 * `output` is deliberately not among them: an agent that prints a lot would
 * drown the syscall frames, and `cortex watch` is about what the kernel
 * *did*. `--events output` asks for it explicitly.
 */
const DEFAULT_EVENT_KINDS = ['record', 'process-start', 'process-exit'] as const;

export async function cmdWatch(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      pid: { type: 'string' },
      events: { type: 'string' },
      'timeout-ms': { type: 'string', default: '0' },
    },
    allowPositionals: false,
  });

  if (values.help === true) {
    printHelp();
    return 0;
  }

  let pid: number | undefined;
  if (values.pid !== undefined) {
    const parsed = Number(values.pid);
    if (!Number.isInteger(parsed) || parsed < 0) {
      console.error(`cortex watch: invalid PID: '${values.pid}'`);
      return 1;
    }
    pid = parsed;
  }

  let kinds: string[] | undefined;
  if (values.events !== undefined) {
    kinds = values.events
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
    for (const kind of kinds) {
      if (!(EVENT_KINDS as readonly string[]).includes(kind)) {
        console.error(
          `cortex watch: unknown event kind '${kind}' (known: ${EVENT_KINDS.join(', ')})`,
        );
        return 1;
      }
    }
    if (kinds.length === 0) kinds = undefined;
  }

  const timeoutRaw = values['timeout-ms'];
  const timeoutMs =
    typeof timeoutRaw === 'string' && timeoutRaw.trim().length > 0
      ? Number.parseInt(timeoutRaw, 10) || 0
      : 0;

  const dir = defaultKernelDir();
  const probe = await probeKernel(dir);
  if (probe.kind !== 'live') {
    if (probe.kind === 'stale') {
      console.error(
        `cortex watch: the kernel that published ${probe.endpoint.host}:${probe.endpoint.port} ` +
          `is not reachable (${probe.reason})`,
      );
    } else {
      console.error('cortex watch: no live kernel is running in this directory');
      console.error('  start one with `cortex daemon run` — a live stream needs a running kernel');
    }
    return 1;
  }

  const client = probe.client;
  console.log('# watching the kernel event stream (Ctrl-C to stop)');

  // The kernel can go away while we are watching — it can be stopped, or it
  // can die. Without this, the watch used to end *silently*, and because
  // nothing was holding the event loop open any more, the process simply
  // exited — with a success code, as if the watch had finished its work.
  // A watch that lost its kernel has not succeeded at anything.
  let kernelGone = false;
  let finish: (() => void) | undefined;
  client.onClose(() => {
    kernelGone = true;
    finish?.();
  });

  let headerPrinted = false;
  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = await client.subscribe(
      (raw) => {
        const event = raw as WireEvent;
        if (event.kind === 'record') {
          if (!headerPrinted) {
            headerPrinted = true;
            console.log('time                  pid    syscall           phase   duration  reversibility');
            console.log('-'.repeat(85));
          }
          if (event.record !== undefined) {
            console.log(formatRecordLine(event.record as SyscallRecord));
          }
          return;
        }
        console.log(formatEventLine(event));
      },
      {
        ...(pid !== undefined ? { pid } : {}),
        // The default is spelled out rather than left to "everything the
        // kernel reports": the kernel also reports what a process *printed*,
        // and this command is about what it did.
        kinds: kinds !== undefined ? kinds : [...DEFAULT_EVENT_KINDS],
      },
    );
  } catch (err) {
    if (err instanceof KernelCommandError) {
      console.error(`cortex watch: ${err.errno}: ${err.message}`);
      client.close();
      return 1;
    }
    // The kernel may have died *while* we were subscribing. That is the same
    // ending as losing it a moment later, and it deserves the same words —
    // not a stack trace out of the transport.
    if (client.closed) {
      const why = await explainKernelGone(dir);
      console.error(`cortex watch: ${why}`);
      console.error('  the watch did not finish — it lost the kernel it was watching.');
      client.close();
      return 1;
    }
    client.close();
    throw err;
  }

  // Wait until the operator interrupts, the timeout elapses, or the kernel
  // goes away.
  await new Promise<void>((resolve) => {
    finish = (): void => {
      resolve();
    };
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
    if (timeoutMs > 0) {
      const timer = setTimeout(finish, timeoutMs);
      // The open socket keeps the process alive; the timer must not.
      timer.unref?.();
    }
    // The kernel may already be gone by the time we got here.
    if (kernelGone) finish();
  });

  unsubscribe?.();
  client.close();

  if (kernelGone) {
    const why = await explainKernelGone(dir);
    console.error(`cortex watch: ${why}`);
    console.error('  the watch did not finish — it lost the kernel it was watching.');
    return 1;
  }

  console.log('# detached');
  return 0;
}

/** Render a process-lifecycle event as one readable line. */
function formatEventLine(event: WireEvent): string {
  if (event.kind === 'process-start') {
    const parent = event.ppid === null || event.ppid === undefined ? '-' : String(event.ppid);
    return `# pid ${event.pid} started (role=${event.role ?? '?'}, ppid=${parent})`;
  }
  if (event.kind === 'process-exit') {
    const code = event.exitCode === null || event.exitCode === undefined ? null : event.exitCode;
    const reason = event.exitReason === null || event.exitReason === undefined ? '' : ` (${event.exitReason})`;
    if (code === null) return `# pid ${event.pid} exited abnormally${reason}`;
    return `# pid ${event.pid} exited with code ${code}${reason}`;
  }
  if (event.kind === 'output') {
    const line = event.line;
    const stream = line?.stream ?? 'out';
    const text = line?.text ?? '';
    return `# pid ${event.pid} printed (${stream}): ${text}`;
  }
  return `# ${event.kind} (pid ${event.pid})`;
}

function printHelp(): void {
  console.log(`cortex watch — watch the kernel's event stream, live

USAGE
  cortex watch                       Watch everything the kernel reports
  cortex watch --pid 2               Watch one process
  cortex watch --events record       Watch only the syscall frames

OPTIONS
  --pid N            Only events for this process
  --events LIST      Comma-separated kinds: ${EVENT_KINDS.join(', ')}
                     (default: ${DEFAULT_EVENT_KINDS.join(', ')})
  --timeout-ms N     Stop after N ms (default 0 = wait for Ctrl-C)
  -h, --help         Show this help

NOTES
  This needs a live kernel — 'cortex daemon run' publishes its endpoint in
  <CORTEX_HOME>/kernel.json. The frames arrive by push: the kernel writes a
  record and this command sees it, with no polling in between.

  'record' lines are printed in the same layout as 'cortex trace', so the two
  can be read side by side.

  If the kernel goes away while you are watching, this says so and exits 1.
  It never pretends the watch finished.

EXAMPLES
  cortex watch
  cortex watch --pid 2
  cortex watch --events record --timeout-ms 5000
`);
}
