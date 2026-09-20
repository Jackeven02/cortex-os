/**
 * cortex CLI — `cortex trace`
 *
 * BACKLOG #033: *"strace-style syscall log, live or from .crec file."*
 *
 * Reads a `.crec` file from disk. Does NOT boot a kernel.
 *
 * Usage:
 *   cortex trace <pid>            — read the .crec file for <pid>
 *   cortex trace <file.crec>      — read a specific .crec file
 *
 * @module cli/commands/trace
 */

import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { defaultKernelDir, existingCrecPath } from '../index.js';
import { readRecords } from '../../kernel/recorder.js';
import { unbrand, asProcessId, type SyscallRecord } from '../../kernel/types.js';

/**
 * Render one syscall record as a fixed-width `trace`/`attach` line.
 *
 * Shared by `cortex trace` and `cortex attach` so both commands print an
 * identical column layout for the same `.crec` file. Keep this the single
 * source of truth for the on-disk log's human-readable shape.
 */
export function formatRecordLine(rec: SyscallRecord): string {
  const time = rec.timestamp.substring(11, 23); // HH:MM:SS.mmm
  const pidStr = String(unbrand(rec.pid)).padEnd(6);
  const syscallStr = rec.syscall.padEnd(16);
  const phaseStr = rec.phase.padEnd(7);
  const durStr = rec.durationMs !== undefined ? `${rec.durationMs}ms`.padEnd(9) : '-'.padEnd(9);
  const revStr = rec.reversibility;
  return `${time}  ${pidStr} ${syscallStr} ${phaseStr} ${durStr} ${revStr}`;
}

export async function cmdTrace(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`cortex trace — strace-style syscall log

USAGE
  cortex trace <pid>           Read the .crec log for the given PID
  cortex trace <file.crec>     Read a specific .crec file

OPTIONS
  -h, --help   Show this help

EXAMPLES
  cortex trace 2
  cortex trace .cortex/processes/2.crec
`);
    return values.help ? 0 : 1;
  }

  const target = positionals[0]!;

  // Determine the .crec file path.
  let crecFile: string;
  if (existsSync(target) && target.endsWith('.crec')) {
    crecFile = target;
  } else {
    // Treat as PID.
    const pid = Number(target);
    if (!Number.isInteger(pid) || pid < 0) {
      console.error(`cortex trace: invalid PID or file: '${target}'`);
      return 1;
    }
    const dir = defaultKernelDir();
    crecFile = existingCrecPath(dir, asProcessId(pid));
    if (!existsSync(crecFile)) {
      console.error(`cortex trace: no .crec file at '${crecFile}'`);
      console.error(`  (did you 'cortex spawn' this PID?)`);
      return 1;
    }
  }

  // Read and print records.
  console.log(`# tracing ${crecFile}`);
  console.log('time                  pid    syscall           phase   duration  reversibility');
  console.log('-'.repeat(85));

  let count = 0;
  for await (const rec of readRecords(crecFile) as AsyncGenerator<SyscallRecord>) {
    console.log(formatRecordLine(rec));
    count++;
  }

  console.log(`# ${count} record(s)`);
  return 0;
}
