/**
 * cortex CLI — `cortex diff`
 *
 * BACKLOG #038: *"compare two forked branches' syscall logs and outputs."*
 *
 * This is the payoff command for Demo C (`fork` → run two branches → pick a
 * winner) and for agent search. It reads two `.crec` files from disk, aligns
 * their syscalls with an LCS, and reports where the branches diverged and what
 * each one did afterwards.
 *
 * Does NOT boot a kernel — like `trace`, it is a pure reader of on-disk state.
 *
 * Usage:
 *   cortex diff <pidA> <pidB>
 *   cortex diff <fileA.crec> <fileB.crec>
 *
 * @module cli/commands/diff
 */

import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';

import { defaultKernelDir, crecPath, readMeta } from '../index.js';
import { readRecords } from '../../kernel/recorder.js';
import { unbrand, asProcessId, type SyscallRecord } from '../../kernel/types.js';
import {
  diffRecords,
  findDivergence,
  splitAtOffset,
  summarize,
  filterStateRecords,
  recordDetail,
  formatMs,
  clockOf,
  type DiffLine,
  type BranchSummary,
} from '../diff_core.js';

const DEFAULT_MAX_LINES = 200;

export async function cmdDiff(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      all: { type: 'boolean', default: false },
      'max-lines': { type: 'string', default: String(DEFAULT_MAX_LINES) },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length < 2) {
    console.log(`cortex diff — compare two forked branches' syscall logs

USAGE
  cortex diff <pidA> <pidB>          Compare two processes' .crec logs
  cortex diff <a.crec> <b.crec>      Compare two specific .crec files

OPTIONS
  -h, --help            Show this help
  --all                 Include the kernel's __state transition records
  --max-lines <n>       Truncate the trace listing (default ${DEFAULT_MAX_LINES}, 0 = no limit)

EXAMPLES
  cortex diff 3 4
  cortex diff 3 4 --all
`);
    return values.help ? 0 : 1;
  }

  const maxLines = Number(values['max-lines'] ?? String(DEFAULT_MAX_LINES));
  if (!Number.isInteger(maxLines) || maxLines < 0) {
    console.error(`cortex diff: --max-lines must be a non-negative integer`);
    return 1;
  }

  const dir = defaultKernelDir();

  const aTarget = resolveTarget(positionals[0]!, dir);
  const bTarget = resolveTarget(positionals[1]!, dir);
  if (aTarget === null) {
    console.error(`cortex diff: no .crec file for '${positionals[0]!}'`);
    return 1;
  }
  if (bTarget === null) {
    console.error(`cortex diff: no .crec file for '${positionals[1]!}'`);
    return 1;
  }

  const aRaw = await collect(aTarget.file);
  const bRaw = await collect(bTarget.file);

  // A PID is only known up front when the user gave one; for a bare file path
  // we recover it from the records themselves, so fork-record matching still
  // works.
  const aPid = aTarget.pid ?? pidOf(aRaw);
  const bPid = bTarget.pid ?? pidOf(bRaw);

  const a = values.all === true ? aRaw : filterStateRecords(aRaw);
  const b = values.all === true ? bRaw : filterStateRecords(bRaw);

  // --- find the split, then cut the shared past out of the parent's log ----
  // The child's log never contained the shared history (it inherits state, not
  // records), so a head-to-head align would report all of it as "A only".
  let divergence = findDivergence(aPid, aRaw, bPid, bRaw, 0);
  let lines: readonly DiffLine[];
  let degenerate: boolean;

  if (divergence.source === 'fork-record' && divergence.byteOffset !== null) {
    let aPart = a;
    let bPart = b;
    if (divergence.forkFromPid === aPid) {
      const split = splitAtOffset(a, divergence.byteOffset);
      aPart = split.tail;
      divergence = { ...divergence, sharedSyscalls: split.shared.length };
    } else if (divergence.forkFromPid === bPid) {
      const split = splitAtOffset(b, divergence.byteOffset);
      bPart = split.tail;
      divergence = { ...divergence, sharedSyscalls: split.shared.length };
    }
    const aligned = diffRecords(aPart, bPart);
    lines = aligned.lines;
    degenerate = aligned.degenerate;
  } else {
    const aligned = diffRecords(a, b);
    lines = aligned.lines;
    degenerate = aligned.degenerate;
    divergence = {
      ...divergence,
      sharedSyscalls: lines.filter((l) => l.kind === 'same').length,
    };
  }
  const shared = divergence.sharedSyscalls;

  const aMeta = aPid !== null ? readMeta(dir, asProcessId(aPid)) : undefined;
  const bMeta = bPid !== null ? readMeta(dir, asProcessId(bPid)) : undefined;
  const aSum = summarize(aRaw);
  const bSum = summarize(bRaw);

  // --- header --------------------------------------------------------------
  console.log('');
  console.log(`  A  ${branchLabel(aPid, aMeta?.role, aMeta?.state, aSum)}`);
  console.log(`  B  ${branchLabel(bPid, bMeta?.role, bMeta?.state, bSum)}`);
  if ((aPid !== null && aMeta === undefined) || (bPid !== null && bMeta === undefined)) {
    // Honest gap: `cortex spawn` writes .meta.json for the process it spawned,
    // not for processes the agent forks at runtime. The .crec logs — which is
    // what diff actually reads — are complete for both.
    console.log(
      `  note: no .meta.json for one branch (spawn persists meta only for the process it` +
        ` started); role/state shown as '-'. Syscall logs are unaffected.`,
    );
  }
  console.log('');

  // --- divergence ----------------------------------------------------------
  if (divergence.source === 'fork-record') {
    console.log(
      `  diverged after ${divergence.sharedSyscalls} shared syscall(s)` +
        ` — fork recorded in pid ${divergence.forkFromPid}` +
        (divergence.byteOffset !== null ? ` at byte offset ${divergence.byteOffset}` : ''),
    );
  } else {
    // No fork record links these two logs. The LCS length is a decent proxy for
    // "how much they share", but it is NOT the kernel's sharedCausalPast — say
    // so rather than dress an inference up as a fact.
    console.log(
      `  no fork record links these two logs — ${divergence.sharedSyscalls} syscall(s) ` +
        `are common to both (inferred, not the kernel's sharedCausalPast)`,
    );
  }
  if (divergence.irreversibleInPast.length > 0) {
    // STATE.md §5.4: both branches inherit the *memory* of these; the actions
    // happened exactly once in reality. Whoever wins, they already happened.
    console.log(
      `  already irreversible before the fork (happened once, inherited by both): ` +
        divergence.irreversibleInPast.join(', '),
    );
  }
  if (degenerate) {
    console.log(
      `  note: logs too large for full LCS alignment — fell back to a common-prefix compare`,
    );
  }
  console.log('');

  // --- aligned trace -------------------------------------------------------
  const aOnly = lines.filter((l) => l.kind === 'a-only').length;
  const bOnly = lines.filter((l) => l.kind === 'b-only').length;
  console.log(`  syscall diff   (${shared} shared, - ${aOnly} A-only, + ${bOnly} B-only)`);
  console.log('  ' + '-'.repeat(92));

  const limit = maxLines === 0 ? lines.length : maxLines;
  for (const line of lines.slice(0, limit)) {
    console.log(formatLine(line));
  }
  if (lines.length > limit) {
    console.log(`  ... ${lines.length - limit} more line(s); raise --max-lines to see them`);
  }
  console.log('');

  // --- summary -------------------------------------------------------------
  console.log('  summary');
  console.log('  ' + '-'.repeat(92));
  const rows: Array<[string, string, string]> = [
    ['records', String(aSum.records), String(bSum.records)],
    ['syscalls', String(aSum.syscalls), String(bSum.syscalls)],
    ['traps', String(aSum.traps), String(bSum.traps)],
    ['wall', formatMs(aSum.wallMs), formatMs(bSum.wallMs)],
    [
      'exit',
      aSum.exitCode === null ? '-' : `${aSum.exitCode} ${aSum.exitReason ?? ''}`.trim(),
      bSum.exitCode === null ? '-' : `${bSum.exitCode} ${bSum.exitReason ?? ''}`.trim(),
    ],
  ];
  for (const [label, av, bv] of rows) {
    console.log(`    ${label.padEnd(10)}${av.padEnd(24)}${bv}`);
  }

  // --- what each branch actually said --------------------------------------
  if (aSum.lastText !== null || bSum.lastText !== null) {
    console.log('');
    console.log('  last llm_call output');
    console.log('  ' + '-'.repeat(92));
    if (aSum.lastText !== null) console.log(`    A: ${truncate(aSum.lastText, 88)}`);
    if (bSum.lastText !== null) console.log(`    B: ${truncate(bSum.lastText, 88)}`);
  }

  console.log('');
  return 0;
}

// =============================================================================
// Helpers
// =============================================================================

interface ResolvedTarget {
  readonly file: string;
  readonly pid: number | null;
}

function resolveTarget(target: string, dir: string): ResolvedTarget | null {
  if (existsSync(target) && target.endsWith('.crec')) {
    return { file: target, pid: null };
  }
  const pid = Number(target);
  if (!Number.isInteger(pid) || pid < 0) return null;
  const file = crecPath(dir, asProcessId(pid));
  if (!existsSync(file)) return null;
  return { file, pid };
}

async function collect(file: string): Promise<readonly SyscallRecord[]> {
  const out: SyscallRecord[] = [];
  for await (const rec of readRecords(file) as AsyncGenerator<SyscallRecord>) {
    out.push(rec);
  }
  return out;
}

function pidOf(records: readonly SyscallRecord[]): number | null {
  const first = records[0];
  return first === undefined ? null : unbrand(first.pid);
}

function branchLabel(
  pid: number | null,
  role: string | undefined,
  state: string | undefined,
  sum: BranchSummary,
): string {
  const pidStr = pid === null ? '?' : String(pid);
  const roleStr = role ?? '-';
  const stateStr = state ?? '-';
  const exit =
    sum.exitCode === null ? '(no exit record)' : `exit=${sum.exitCode} (${sum.exitReason ?? ''})`;
  return `pid ${pidStr.padEnd(5)} role=${roleStr.padEnd(12)} state=${stateStr.padEnd(12)} ${exit}`;
}

function formatLine(line: DiffLine): string {
  const rec = line.a ?? line.b;
  if (rec === null) return '';
  const marker = line.kind === 'same' ? ' ' : line.kind === 'a-only' ? '-' : '+';
  const time = clockOf(rec.timestamp).padEnd(13);
  const name = rec.syscall.padEnd(14);
  return `  ${marker} ${time} ${name} ${recordDetail(rec)}`;
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 3)}...` : flat;
}
