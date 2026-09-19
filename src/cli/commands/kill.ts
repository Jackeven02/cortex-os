/**
 * cortex CLI — `cortex kill`
 *
 * BACKLOG #032: *"send signals."*
 *
 * v0 model: since the kernel is not long-running, `kill` cannot signal a
 * live process. Instead it:
 *   - Reads the process's `.meta.json` from disk.
 *   - If the process is already terminal (zombie/exited), prints that.
 *   - Otherwise, marks it as killed in the meta (state → zombie, exitCode
 *     set from the signal's default exit code).
 *
 * When the long-running daemon model lands, this command will connect to
 * the live kernel and send a real signal.
 *
 * Usage:
 *   cortex kill <pid> [--signal SIGTERM]
 *
 * @module cli/commands/kill
 */

import { parseArgs } from 'node:util';
import { defaultKernelDir, parsePid, readMeta, writeMeta, type ProcessMeta } from '../index.js';
import { type Signal } from '../../kernel/types.js';

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

NOTE
  v0 does not have a long-running daemon. 'kill' marks the process as
  terminated in the on-disk metadata. When the daemon model lands, this
  will send a real signal to a live process.

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
  return 0;
}
