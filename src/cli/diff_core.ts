/**
 * cortex CLI — `cortex diff` core (no I/O).
 *
 * BACKLOG #038: *"compare two forked branches' syscall logs and outputs."*
 *
 * This file is deliberately I/O-free so the interesting parts — the alignment
 * algorithm and the divergence search — are pure functions the smoke suite can
 * hammer without touching disk. `commands/diff.ts` owns reading `.crec` files
 * and printing.
 *
 * ## What "diff" means for two syscalls logs
 *
 * A fork gives two processes a **shared causal past** and then lets them
 * diverge (docs/STATE.md §4). Comparing them is therefore not a generic
 * file diff: there is a known common prefix, and everything after it is what
 * one branch decided to do that the other did not.
 *
 * We align with an LCS (longest common subsequence) over record *signatures*,
 * which is more honest than a line-by-line positional compare: if branch B
 * inserts one call early, a positional compare reports every subsequent line as
 * changed, while LCS reports exactly one insertion. For agent search — spawn N
 * branches, keep the best — that difference is the whole product.
 *
 * ## Why LCS and not just "skip the shared prefix"
 *
 * Two branches can re-converge: both may call `llm_call` with an identical
 * prompt after diverging, or both may exit with the same code. LCS finds those
 * re-convergences; a prefix skip would report them as differences. Cost is
 * O(n·m), which is fine for the tens-to-hundreds of syscalls a fork actually
 * produces — with a documented fallback when a log is pathologically long.
 *
 * See: docs/STATE.md §4 (sharedCausalPast), §5.4 (irreversible in past);
 *      docs/ABI.md §6 (recording format);
 *      BACKLOG #038
 *
 * @module cli/diff_core
 */

import { unbrand, type SyscallRecord } from '../kernel/types.js';

// =============================================================================
// §1. Signatures
// =============================================================================

/**
 * Recursively reorder object keys so two structurally identical values
 * serialize identically. `JSON.stringify` is key-order sensitive, and the
 * recorder does not guarantee insertion order across processes.
 */
export function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      out[key] = stableJson(src[key]);
    }
    return out;
  }
  return value;
}

/**
 * The identity of a record for comparison purposes.
 *
 * Deliberately excludes `timestamp`, `durationMs`, `callId`, and `byteOffset`:
 * two branches that made the same call at different times, taking different
 * durations, are still the same call. Including them would make every line a
 * difference and the diff useless.
 */
export function recordSignature(r: SyscallRecord): string {
  return JSON.stringify([
    r.syscall,
    r.phase,
    r.args === undefined ? null : stableJson(r.args),
    r.result === undefined ? null : stableJson(r.result),
    r.error === undefined ? null : stableJson(r.error),
  ]);
}

// =============================================================================
// §2. Alignment
// =============================================================================

export type DiffKind = 'same' | 'a-only' | 'b-only';

export interface DiffLine {
  readonly kind: DiffKind;
  readonly a: SyscallRecord | null;
  readonly b: SyscallRecord | null;
}

/**
 * Beyond this many DP cells we stop pretending: an LCS table is O(n·m) memory
 * and a runaway agent can emit hundreds of thousands of records. 4M cells is
 * 16MB of Uint32, which is an acceptable ceiling for a CLI.
 */
export const MAX_LCS_CELLS = 4_000_000;

/**
 * Align two record sequences with an LCS.
 *
 * `degenerate` is true when the input was too large for the DP table and we
 * fell back to a prefix comparison — callers should say so out loud rather than
 * present a subtly wrong alignment as authoritative.
 */
export function diffRecords(
  a: readonly SyscallRecord[],
  b: readonly SyscallRecord[],
): { readonly lines: readonly DiffLine[]; readonly degenerate: boolean } {
  if (a.length * b.length > MAX_LCS_CELLS) {
    return { lines: prefixDiff(a, b), degenerate: true };
  }
  const sa = a.map(recordSignature);
  const sb = b.map(recordSignature);
  const table = buildLcsTable(sa, sb);
  const m = sb.length;
  const lines: DiffLine[] = [];

  let i = 0;
  let j = 0;
  while (i < sa.length && j < sb.length) {
    if (sa[i] === sb[j]) {
      lines.push({ kind: 'same', a: a[i] ?? null, b: b[j] ?? null });
      i++;
      j++;
    } else if (table[(i + 1) * (m + 1) + j]! >= table[i * (m + 1) + (j + 1)]!) {
      lines.push({ kind: 'a-only', a: a[i] ?? null, b: null });
      i++;
    } else {
      lines.push({ kind: 'b-only', a: null, b: b[j] ?? null });
      j++;
    }
  }
  while (i < sa.length) {
    lines.push({ kind: 'a-only', a: a[i] ?? null, b: null });
    i++;
  }
  while (j < sb.length) {
    lines.push({ kind: 'b-only', a: null, b: b[j] ?? null });
    j++;
  }
  return { lines, degenerate: false };
}

/**
 * LCS table, built back-to-front so `table[i][j]` is the LCS length of the
 * suffixes starting at i and j. Width is `m+1`.
 */
export function buildLcsTable(
  a: readonly string[],
  b: readonly string[],
): Uint32Array {
  const n = a.length;
  const m = b.length;
  const table = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * (m + 1) + j] =
        a[i] === b[j]
          ? table[(i + 1) * (m + 1) + (j + 1)]! + 1
          : Math.max(table[(i + 1) * (m + 1) + j]!, table[i * (m + 1) + (j + 1)]!);
    }
  }
  return table;
}

/**
 * Fallback: walk the common prefix, then emit both tails. Cheap, and wrong in
 * a predictable direction (it over-reports differences).
 */
function prefixDiff(
  a: readonly SyscallRecord[],
  b: readonly SyscallRecord[],
): DiffLine[] {
  const lines: DiffLine[] = [];
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && recordSignature(a[i]!) === recordSignature(b[i]!)) {
    lines.push({ kind: 'same', a: a[i] ?? null, b: b[i] ?? null });
    i++;
  }
  for (let k = i; k < a.length; k++) {
    lines.push({ kind: 'a-only', a: a[k] ?? null, b: null });
  }
  for (let k = i; k < b.length; k++) {
    lines.push({ kind: 'b-only', a: null, b: b[k] ?? null });
  }
  return lines;
}

// =============================================================================
// §3. Divergence
// =============================================================================

export interface Divergence {
  /**
   * How many syscalls the two branches genuinely share.
   *
   * With a fork record this is counted from the parent's log up to
   * `byteOffset`; without one it is the LCS length, which is a weaker claim.
   */
  readonly sharedSyscalls: number;
  /** `sharedCausalPast` byte offset, when a fork record supplies it. */
  readonly byteOffset: number | null;
  /** Where the split came from. 'inferred' means "we guessed, roughly". */
  readonly source: 'fork-record' | 'inferred';
  /**
   * The parent: the PID whose log contains the fork record. Its log holds the
   * shared history; the child's log starts empty and only ever holds what the
   * child itself did.
   */
  readonly forkFromPid: number | null;
  readonly forkChildPid: number | null;
  /** Tools that had already run irreversibly before the fork (STATE.md §5.4). */
  readonly irreversibleInPast: readonly string[];
}

/**
 * Split a log at a byte offset: everything written before the fork belongs to
 * the shared causal past, everything from here on belongs to this branch alone.
 *
 * This is the crux of why "diff two `.crec` files" is not a text diff. The
 * child's log does **not** contain a copy of the shared history — a forked
 * child inherits the parent's *state*, not its *log*. So the shared part exists
 * only in the parent's file, and comparing the two files head-to-head would
 * report the entire shared history as "A only". We cut it out first.
 */
export function splitAtOffset(
  records: readonly SyscallRecord[],
  offset: number,
): { readonly shared: readonly SyscallRecord[]; readonly tail: readonly SyscallRecord[] } {
  let i = 0;
  while (i < records.length && unbrand(records[i]!.byteOffset) < offset) i++;
  return { shared: records.slice(0, i), tail: records.slice(i) };
}

function countBeforeOffset(records: readonly SyscallRecord[], offset: number): number {
  return splitAtOffset(records, offset).shared.length;
}

/**
 * Find where two branches split.
 *
 * The authoritative answer is the `sharedCausalPast` the kernel stamped into the
 * parent's `fork` record (docs/STATE.md §4) — that is a byte offset into the
 * parent's `.crec` at the moment of the fork, and it is exactly what
 * `ForkResult.sharedCausalPast` returns at runtime. We recover it from disk
 * because the CLI is a different process from the one that forked.
 *
 * If neither log contains a fork record for the other (e.g. you are diffing two
 * hand-picked `.crec` files, or the fork happened in an older kernel), we say so
 * and fall back to the LCS length as a rough measure.
 */
export function findDivergence(
  aPid: number | null,
  aRecords: readonly SyscallRecord[],
  bPid: number | null,
  bRecords: readonly SyscallRecord[],
  fallbackShared: number,
): Divergence {
  // A's log names B as its fork child → A is the parent.
  const forward = findForkRecord(aPid, aRecords, bPid);
  if (forward !== null) {
    return {
      source: 'fork-record',
      forkFromPid: aPid,
      forkChildPid: bPid,
      byteOffset: forward.sharedCausalPast,
      sharedSyscalls: countBeforeOffset(aRecords, forward.sharedCausalPast),
      irreversibleInPast: forward.irreversibleInPast,
    };
  }
  // Or the other way round — the user may have listed the child first.
  const reverse = findForkRecord(bPid, bRecords, aPid);
  if (reverse !== null) {
    return {
      source: 'fork-record',
      forkFromPid: bPid,
      forkChildPid: aPid,
      byteOffset: reverse.sharedCausalPast,
      sharedSyscalls: countBeforeOffset(bRecords, reverse.sharedCausalPast),
      irreversibleInPast: reverse.irreversibleInPast,
    };
  }
  return {
    source: 'inferred',
    forkFromPid: null,
    forkChildPid: null,
    byteOffset: null,
    sharedSyscalls: fallbackShared,
    irreversibleInPast: [],
  };
}

interface ForkHit {
  readonly sharedCausalPast: number;
  readonly forkFromPid: number;
  readonly irreversibleInPast: readonly string[];
}

/** Look for a `fork` record in `records` whose result names `wantChildPid`. */
function findForkRecord(
  ownerPid: number | null,
  records: readonly SyscallRecord[],
  wantChildPid: number | null,
): ForkHit | null {
  if (ownerPid === null || wantChildPid === null) return null;
  for (const r of records) {
    if (r.syscall !== 'fork' || r.phase !== 'exit') continue;
    const result = r.result as
      | { childPid?: unknown; sharedCausalPast?: unknown; irreversibleInPast?: unknown }
      | undefined;
    if (result === undefined || typeof result !== 'object') continue;
    if (result.childPid !== wantChildPid) continue;
    return {
      sharedCausalPast:
        typeof result.sharedCausalPast === 'number' ? result.sharedCausalPast : 0,
      forkFromPid: ownerPid,
      irreversibleInPast: Array.isArray(result.irreversibleInPast)
        ? (result.irreversibleInPast as unknown[]).filter(
            (x): x is string => typeof x === 'string',
          )
        : [],
    };
  }
  return null;
}

// =============================================================================
// §4. Summaries
// =============================================================================

export interface BranchSummary {
  readonly records: number;
  /** Syscalls proper, excluding the kernel's `__state` transitions. */
  readonly syscalls: number;
  readonly traps: number;
  readonly firstAt: string | null;
  readonly lastAt: string | null;
  readonly wallMs: number | null;
  readonly exitCode: number | null;
  readonly exitReason: string | null;
  /** Text of the last completed `llm_call` — usually "what the branch decided". */
  readonly lastText: string | null;
}

export function summarize(records: readonly SyscallRecord[]): BranchSummary {
  let syscalls = 0;
  let traps = 0;
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  let exitCode: number | null = null;
  let exitReason: string | null = null;
  let lastText: string | null = null;

  for (const r of records) {
    if (firstAt === null) firstAt = r.timestamp;
    lastAt = r.timestamp;
    if (r.syscall !== '__state') syscalls++;
    if (r.phase === 'trap') traps++;

    if (r.syscall === 'exit' && r.phase === 'exit') {
      const res = r.result as { code?: unknown; reason?: unknown } | undefined;
      if (res !== undefined && typeof res === 'object') {
        if (typeof res.code === 'number') exitCode = res.code;
        if (typeof res.reason === 'string') exitReason = res.reason;
      }
    }
    if (r.syscall === 'llm_call' && r.phase === 'exit') {
      const res = r.result as { text?: unknown } | undefined;
      if (res !== undefined && typeof res === 'object' && typeof res.text === 'string') {
        lastText = res.text;
      }
    }
  }

  let wallMs: number | null = null;
  if (firstAt !== null && lastAt !== null) {
    const ms = Date.parse(lastAt) - Date.parse(firstAt);
    if (Number.isFinite(ms)) wallMs = ms;
  }

  return {
    records: records.length,
    syscalls,
    traps,
    firstAt,
    lastAt,
    wallMs,
    exitCode,
    exitReason,
    lastText,
  };
}

/**
 * Strip the kernel's `__state` transition records.
 *
 * Every syscall writes an extra `__state` record alongside its own
 * enter/exit/trap (see docs/ABI.md §6). They are noise in a diff: both branches
 * emit near-identical ones, and they drown the calls the agent actually made.
 */
export function filterStateRecords(
  records: readonly SyscallRecord[],
): readonly SyscallRecord[] {
  return records.filter((r) => r.syscall !== '__state');
}

// =============================================================================
// §5. Formatting helpers
// =============================================================================

/** Short, human-readable rendering of a record's payload. */
export function recordDetail(r: SyscallRecord): string {
  if (r.phase === 'trap' && r.error !== undefined) {
    const e = r.error as { errno?: unknown; message?: unknown };
    const errno = typeof e.errno === 'string' ? e.errno : 'ERROR';
    const msg = typeof e.message === 'string' ? e.message : '';
    return `trap ${errno}${msg.length > 0 ? `: ${msg}` : ''}`;
  }
  if (r.phase === 'enter' && r.args !== undefined) return `in  ${brief(r.args)}`;
  if (r.phase === 'exit' && r.result !== undefined) return `out ${brief(r.result)}`;
  return r.phase;
}

function brief(value: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(stableJson(value)) ?? String(value);
  } catch {
    s = String(value);
  }
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

export function formatMs(ms: number | null): string {
  if (ms === null) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** `HH:MM:SS.mmm` from an ISO timestamp — matches `cortex trace`. */
export function clockOf(iso: string): string {
  return iso.substring(11, 23);
}
