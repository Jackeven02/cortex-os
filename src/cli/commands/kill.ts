/**
 * cortex CLI — `cortex kill`
 *
 * BACKLOG #032: *"send signals."*
 *
 * ## Two kinds of kill
 *
 * A signal only means something to a process that is alive. There are two
 * situations, and they are genuinely different:
 *
 *   - **A live kernel is running.** `cortex daemon run` keeps one alive and
 *     publishes its endpoint in `<CORTEX_HOME>/kernel.json`
 *     (docs/ARCHITECTURE.md §12.1). This command then delivers the signal
 *     *for real*, through the kernel's own signal engine: the target's
 *     disposition is honoured (a `handler` runs, `ignore` drops it), the
 *     signal is queued when the target is not running yet, and the whole
 *     thing is recorded — the `kill` syscall in the caller's log, the
 *     `__signal` record in the target's.
 *   - **No live kernel.** There is nobody to signal. This command then does
 *     what it has always done: mark the process as terminated in the
 *     on-disk metadata, so `cortex ps` stops showing it as running. That is
 *     bookkeeping, not a signal, and the command says which one it did.
 *
 * Usage:
 *   cortex kill <pid> [--signal SIGTERM]
 *
 * @module cli/commands/kill
 */

import { parseArgs } from 'node:util';
import { defaultKernelDir, parsePid, readMeta, writeMeta, type ProcessMeta } from '../index.js';
import { type Signal } from '../../kernel/types.js';
import { KernelCommandError, probeKernel } from '../kernel_client.js';

const VALID_SIGNALS = new Set([
  'SIGHUP', 'SIGINT', 'SIGTERM', 'SIGKILL', 'SIGSTOP', 'SIGCONT',
  'SIGUSR1', 'SIGUSR2', 'SIGCHLD', 'SIGXCPU', 'SIGXFSZ', 'SIGSYS', 'SIGPIPE',
]);

/** Default exit codes per signal (POSIX convention). */
const SIGNAL_EXIT_CODES: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 130,
  SIGTERM: 143,
  SIGKILL: 137,
  SIGSTOP: 0,   // SIGSTOP doesn't kill; it stops. But in v0, we can't stop.
  SIGCONT: 0,
  SIGUSR1: 0,
  SIGUSR2: 0,
  SIGCHLD: 0,
  SIGXCPU: 0,
  SIGXFSZ: 0,
  SIGSYS: 0,
  SIGPIPE: 0,
};

export async function cmdKill(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      signal: { type: 'string', default: 'SIGTERM' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`cortex kill — send a signal to a process

USAGE
  cortex kill <pid> [--signal <signal>]

OPTIONS
  --signal <signal>   Signal to send (default: SIGTERM)
                      Valid: SIGHUP, SIGINT, SIGTERM, SIGKILL, SIGSTOP,
                             SIGCONT, SIGUSR1, SIGUSR2, SIGXCPU, SIGSYS
  -h, --help          Show this help

NOTES
  With a live kernel ('cortex daemon run'), the signal is delivered for
  real: the target's disposition is honoured, and the delivery is recorded
  in the kernel's .crec log. Without one, there is no process to signal, so
  the command marks the process terminated in the on-disk metadata instead
  and says so.

EXAMPLES
  cortex kill 2
  cortex kill 2 --signal SIGKILL
`);
    return values.help ? 0 : 1;
  }

  const pid = parsePid(positionals[0]!);
  const signal = values.signal as Signal;

  if (!VALID_SIGNALS.has(signal)) {
    console.error(`cortex kill: invalid signal '${signal}'`);
    console.error(`valid signals: ${[...VALID_SIGNALS].join(', ')}`);
    return 1;
  }

  const dir = defaultKernelDir();
  const probe = await probeKernel(dir);

  if (probe.kind === 'live') {
    const client = probe.client;
    try {
      const result = await client.request<{ outcome: string; pid: number; signal: string }>(
        'kill',
        { pid, signal },
      );
      console.log(`sent ${signal} to pid ${pid} → ${result.outcome}`);
      return 0;
    } catch (err) {
      if (err instanceof KernelCommandError) {
        console.error(`cortex kill: ${err.errno}: ${err.message}`);
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
      `cortex kill: the kernel that published ${probe.endpoint.host}:${probe.endpoint.port} ` +
      `is not reachable (${probe.reason})`,
    );
  }

  const meta = readMeta(dir, pid);

  if (meta === undefined) {
    console.error(`cortex kill: no such process: ${pid} (no .meta.json found)`);
    console.error(`  (did you 'cortex spawn' this PID?)`);
    return 1;
  }

  if (meta.state === 'zombie' || meta.state === 'exiting') {
    console.log(`pid ${pid} already exited (code ${meta.exitCode}: ${meta.exitReason})`);
    return 0;
  }

  // Mark as killed.
  const exitCode = SIGNAL_EXIT_CODES[signal] ?? 1;
  const updatedMeta: ProcessMeta = {
    ...meta,
    state: 'zombie',
    exitCode,
    exitReason: `killed by ${signal}`,
    lastTransitionAt: new Date().toISOString(),
    // It is dead, so it is not waiting on anything any more.
    blockedOn: null,
  };
  writeMeta(dir, updatedMeta);

  console.log(`sent ${signal} to pid ${pid} → marked as zombie (exit ${exitCode})`);
  console.log('  (no live kernel was reachable, so this is bookkeeping — nothing was signalled)');
  return 0;
}
