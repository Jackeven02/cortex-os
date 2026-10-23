/**
 * cortex CLI — `cortex wait <pid>`
 *
 * ## The question this answers
 *
 * *"Is it done, and how did it end?"*
 *
 * `cortex spawn --live` starts an agent inside a running kernel and returns
 * immediately — the agent keeps working after the command exits. That is the
 * point of the live kernel, but it leaves the operator with a process they
 * cannot synchronously wait for: `cortex ps` shows it is still running, and
 * polling it is the only thing on offer.
 *
 * `cortex wait <pid>` blocks until the process ends and reports the real exit
 * code and reason. It is the shell's `wait(1)`.
 *
 * ## Why it is not the `wait` syscall
 *
 * The ABI's `wait` is a **parent-child** operation: only a process's own
 * parent may wait for it, and the wake-up is enqueued into the parent's run
 * queue. An operator standing outside the kernel is not in the process tree —
 * the processes it spawned are children of init — so the syscall cannot be
 * addressed to it. The kernel therefore exposes the same thing as a
 * *host-facing* primitive (`Kernel.awaitExit`), which resolves at the ZOMBIE
 * transition: before init reaps the entry, so the exit code is still there to
 * be read.
 *
 * That distinction is the whole reason this command exists. A host that tried
 * `dispatcher.invoke(initPid, 'wait', pid)` would hang forever, and the way
 * out — poll the table, capture the exit code in an `onProcessExit` hook, and
 * be careful not to default a missing exit code to `0` — is twenty lines
 * every host has to write, and every one of them gets the race wrong at
 * least once.
 *
 * ## Without a live kernel
 *
 * A process that already ended still has an exit code, on disk: the kernel
 * persisted a `meta.json` for it on the way out. So `cortex wait` on a pid
 * that finished in an earlier session answers from that file. A pid with
 * neither a live process nor a recorded exit is reported as such — it is not
 * quietly reported as "exited 0".
 *
 * Usage:
 *   cortex wait <pid>                 wait for the process to end
 *   cortex wait <pid> --timeout-ms N  give up after N ms
 *
 * @module cli/commands/wait
 */

import { parseArgs } from 'node:util';

import { defaultKernelDir } from '../index.js';
import { readMeta } from '../process_store.js';
import { explainKernelGone, probeKernel, KernelCommandError } from '../kernel_client.js';
import { asProcessId } from '../../kernel/types.js';

interface WaitResult {
  readonly exited: boolean;
  readonly pid: number;
  readonly exitCode?: number | null;
  readonly exitReason?: string | null;
}

export async function cmdWait(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      'timeout-ms': { type: 'string', default: '0' },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`cortex wait — wait for a process to end

USAGE
  cortex wait <pid>                 Wait for the process to end
  cortex wait <pid> --timeout-ms N  Give up after N ms (0 = wait forever)

OPTIONS
  --timeout-ms N   Give up after N ms (default 0 = wait indefinitely)
  -h, --help       Show this help

NOTES
  This is the shell's wait(1) for a live kernel: it blocks until the process
  ends and reports the real exit code and reason. The exit code is also this
  command's exit code, so 'cortex wait 2 || echo failed' works.

  A process that already ended still has its exit code on disk (the kernel
  persisted a meta.json for it), so waiting on a finished process answers
  immediately. A pid with neither a live process nor a recorded exit is
  reported as such — never as "exited 0".

  If the kernel goes away while you are waiting, this says so and exits 1: no
  exit was seen, and none is invented.

EXAMPLES
  cortex wait 2
  cortex wait 2 --timeout-ms 5000
`);
    return values.help ? 0 : 1;
  }

  const raw = positionals[0]!;
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid < 0) {
    console.error(`cortex wait: invalid PID: '${raw}'`);
    return 1;
  }

  const timeoutRaw = values['timeout-ms'];
  const timeoutMs =
    typeof timeoutRaw === 'string' && timeoutRaw.trim().length > 0
      ? Number.parseInt(timeoutRaw, 10) || 0
      : 0;

  const dir = defaultKernelDir();
  const probe = await probeKernel(dir);

  if (probe.kind === 'live') {
    const client = probe.client;
    let interrupted = false;
    const onSignal = (): void => {
      interrupted = true;
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    try {
      const result = await client.request<WaitResult>('wait', {
        pid,
        ...(timeoutMs > 0 ? { timeoutMs } : {}),
      });
      if (interrupted) {
        console.error('cortex wait: interrupted');
        return 1;
      }
      if (!result.exited) {
        console.error(`cortex wait: pid ${pid} did not exit within ${timeoutMs}ms`);
        return 1;
      }
      return report(result.exitCode ?? null, result.exitReason ?? null, pid);
    } catch (err) {
      if (err instanceof KernelCommandError) {
        console.error(`cortex wait: ${err.errno}: ${err.message}`);
        return 1;
      }
      // The kernel went away mid-wait. The raw socket error ("read
      // ECONNRESET") says nothing an operator can act on; the directory can
      // say whether the kernel shut down or died.
      if (client.closed) {
        const why = await explainKernelGone(dir);
        console.error(`cortex wait: ${why}`);
        console.error(`  pid ${pid} did not report an exit — nobody is waiting on it now.`);
        return 1;
      }
      throw err;
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      client.close();
    }
  }

  if (probe.kind === 'stale') {
    console.error(
      `cortex wait: the kernel that published ${probe.endpoint.host}:${probe.endpoint.port} ` +
      `is not reachable (${probe.reason})`,
    );
  }

  // No live kernel: the process may still have ended, and its exit code is on
  // disk. The kernel wrote a `meta.json` for every process on the way out.
  const meta = readMeta(dir, asProcessId(pid));
  if (meta !== undefined && meta.exitCode !== null) {
    return report(meta.exitCode, meta.exitReason, pid);
  }

  console.error(`cortex wait: no live kernel is running in this directory.`);
  if (meta !== undefined) {
    console.error(`  pid ${pid} is recorded but has not exited (state: ${meta.state}).`);
  } else {
    console.error(`  (no record of pid ${pid} in ${dir})`);
  }
  console.error("  start one with `cortex daemon run`.");
  return 1;
}

/**
 * Report an exit, and return the exit code the command should return.
 *
 * The child's code becomes this command's code, the way `cortex spawn` does
 * it — so `cortex wait 2 || echo failed` works. A process that died without
 * recording an exit is reported as a failure, never as a success: the whole
 * point of waiting is to learn how it ended.
 */
function report(exitCode: number | null, exitReason: string | null, pid: number): number {
  if (exitCode === null) {
    console.log(`pid ${pid} exited abnormally${exitReason === null ? '' : `: ${exitReason}`}`);
    return 1;
  }
  console.log(`pid ${pid} exited with code ${exitCode}${exitReason === null ? '' : ` (${exitReason})`}`);
  return exitCode;
}
