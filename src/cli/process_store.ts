/**
 * cortex CLI — disk-backed process store.
 *
 * This is the "disk as source of truth" bridge that lets CLI commands see
 * processes spawned by previous CLI invocations. Each `cortex spawn` writes a
 * per-process directory `<dir>/processes/<pid>/{log.crec, meta.json,
 * checkpoints/}` (ARCHITECTURE §7). The `.meta.json` index sits next to the
 * syscall log. Read-only commands (`ps`, `trace`, `kill`, `limit`) load these
 * to reconstruct the process table from disk instead of starting with an empty
 * in-memory kernel. Pre-`0.2.1` flat files (`processes/<pid>.crec` /
 * `<pid>.meta.json`) are still read, so an older home upgrades transparently.
 *
 * The `.meta.json` file carries a subset of `ProcessInfo` — enough for `ps`
 * and `kill` to be useful without booting a full kernel. It is NOT a
 * checkpoint; it does not carry cognitive state. It is an index.
 *
 * Format:
 * {
 *   "pid": 2,
 *   "ppid": 1,
 *   "pgid": 2,
 *   "role": "coder",
 *   "state": "zombie",
 *   "exitCode": 0,
 *   "exitReason": "completed",
 *   "startedAt": "2026-09-18T...",
 *   "lastTransitionAt": "2026-09-18T...",
 *   "budgetsSpent": { ... },
 *   "budgetsRemaining": { ... },
 *   "agent": { "system": "You are a coder..." },
 *   "kernelAbiVersion": "1.0.0"
 * }
 *
 * @module cli/process_store
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, unlinkSync, mkdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

import { unbrand, asProcessId, type ProcessId, type BudgetCounters, type BudgetLimits, type AgentSpec, type SyscallRecord, type ProcessState, type MemoryRegionPolicy, type BlockedReason, type Capability, type PersistedProcessMeta, CAPABILITIES, DEFAULT_CAPABILITIES } from '../kernel/types.js';
import { readRecords, existingCrecPath } from '../kernel/recorder.js';

// =============================================================================
// Types
// =============================================================================

/**
 * How a process was **born**: the role, the agent spec, and the memory
 * region policies it was declared with.
 *
 * The `.csnap` body deliberately omits all of this (docs/STATE.md §4), so a
 * restore has to be told what to materialise. `meta.json` carries the same
 * facts — but it is written when a process *exits*, so a process that was
 * still running when its kernel went away had its spec nowhere on disk, and
 * a snapshot of it could not be restored in a later session.
 *
 * This document is written when the process is created, for exactly that
 * reason: before the process can ever be snapshotted.
 */
export interface ProcessSpec {
  readonly pid: number;
  readonly ppid: number | null;
  readonly role: string;
  readonly agent: AgentSpec;
  readonly memory?: Readonly<Record<string, MemoryRegionPolicy>>;
  /**
   * The capabilities the process was born holding (docs/ABI.md §4.9).
   *
   * `null` means **unnarrowed** — the spawner said nothing, so the process
   * holds everything. Persisted so a *replacement* is the same process and
   * not a stronger one: the supervisor's `--restart` rebuilds the agent from
   * this spec, and a spec without the capabilities would rebuild it fully
   * privileged.
   */
  readonly capabilities?: readonly Capability[] | null;
  /** The capabilities it may raise later with `acquire()`. */
  readonly grantable?: readonly Capability[];
  /** The budget limits it was born with. */
  readonly budgets?: BudgetLimits;
  readonly startedAt: string;
  readonly kernelAbiVersion: string;
}

export interface ProcessMeta {
  readonly pid: number;
  readonly ppid: number | null;
  readonly pgid: number;
  readonly role: string;
  readonly state: ProcessState;
  readonly exitCode: number | null;
  readonly exitReason: string | null;
  readonly startedAt: string;
  readonly lastTransitionAt: string;
  readonly budgetsSpent: BudgetCounters;
  readonly budgetsRemaining: BudgetLimits;
  readonly agent: AgentSpec;
  /**
   * Resolved per-region memory policies, persisted so a later
   * `cortex restore` re-declares the SAME regions (including any per-region
   * `maxEntries` / `readOnly`) rather than silently reverting to the standard
   * defaults. Optional and additive — when absent, restore falls back to
   * `DEFAULT_MEMORY_REGIONS`.
   */
  readonly memory?: Readonly<Record<string, MemoryRegionPolicy>>;
  /**
   * Why the process is not running, when it is BLOCKED. Persisted so the
   * read-only views (`ps`, and especially `top`) can say *what a process is
   * waiting on* rather than only that it is waiting. Optional: absent means
   * "not blocked", or written by an older build that did not record it.
   */
  readonly blockedOn?: BlockedReason | null;
  /**
   * The capabilities this process held while it ran (docs/ABI.md §4.9).
   *
   * Persisted so the read-only views can say **what an agent was allowed to
   * do**, not only what it did: a process that ran with no capabilities and
   * one that ran with all of them leave the same syscall log. Optional:
   * absent means "written by a build that did not record it".
   */
  readonly capabilities?: readonly Capability[];
  /**
   * The priority this process ran at (docs/PROCESS.md §8.1) — the kernel's
   * `nice`, -20..19, lower runs first.
   *
   * Persisted so the read-only views can say **what rank the process ran at**,
   * not only what it did: an agent that never got a turn and one that ran
   * first leave the same syscall log. Optional: absent means "written by a
   * build that did not record it".
   */
  readonly nice?: number;
  readonly kernelAbiVersion: string;
}

// =============================================================================
// Path helpers
// =============================================================================

/**
 * `.cortex/processes/<pid>/meta.json` — one directory per process
 * (docs/ARCHITECTURE.md §7).
 */
export function metaPath(dir: string, pid: ProcessId): string {
  return join(procDir(dir, pid), 'meta.json');
}

/**
 * `.cortex/processes/<pid>/spec.json` — how the process was born.
 *
 * Written when the process is created; read when a snapshot of it has to be
 * restored in a session that never saw the process itself.
 */
export function specPath(dir: string, pid: ProcessId): string {
  return join(procDir(dir, pid), 'spec.json');
}

/** The pre-`0.2.1` flat form, `.cortex/processes/<pid>.meta.json`. */
export function legacyMetaPath(dir: string, pid: ProcessId): string {
  return join(dir, 'processes', `${unbrand(pid)}.meta.json`);
}

/**
 * `.cortex/processes/<pid>/output.log` — what the process *printed*.
 *
 * The `.crec` log records what a process **did** (syscalls, with arguments
 * and results). It says nothing about what the process said: an agent's
 * `console.log` was, until now, a handful of bytes on the daemon's stdout,
 * gone the moment the terminal scrolled or the daemon was restarted.
 *
 * So the output went nowhere it could be read back from. This file is where
 * it goes — one line per printed line, stamped, tagged with the stream it
 * came from:
 *
 *     2026-10-23T15:39:35.034Z | out | hello from the agent
 *     2026-10-23T15:39:36.118Z | err | something went wrong
 *
 * It is written by the CLI, not the kernel (the kernel does not know what a
 * process printed), and it is read back with `cortex logs <pid>`.
 */
export function outputPath(dir: string, pid: ProcessId): string {
  return join(procDir(dir, pid), 'output.log');
}

/** One captured line of a process's output. */
export interface OutputEntry {
  /** ISO-8601 timestamp of the moment the line was completed. */
  readonly at: string;
  /**
   * Which standard stream the line came from.
   *
   * The capture writes `'out'` or `'err'`. The type is wider than that
   * because a line may also arrive over the wire from a host that captured
   * it, and a reader keeps what it read rather than inventing a tag.
   */
  readonly stream: string;
  /** The line itself, without its trailing newline. */
  readonly text: string;
}

/** `.cortex/processes/<pid>/` — everything one process ever wrote. */
export function procDir(dir: string, pid: ProcessId): string {
  return join(dir, 'processes', String(unbrand(pid)));
}

export function processesDir(dir: string): string {
  return join(dir, 'processes');
}

/** `.cortex/processes/<pid>/checkpoints/`. */
export function procCheckpointsDir(dir: string, pid: ProcessId): string {
  return join(procDir(dir, pid), 'checkpoints');
}

/**
 * Every process directory on disk, as `{ pid, dir }`. Covers the current
 * per-process layout; the flat legacy files are read by `readAllMetas` /
 * `maxPidOnDisk` directly.
 */
export function listProcDirs(dir: string): readonly { pid: number; dir: string }[] {
  const root = processesDir(dir);
  if (!existsSync(root)) return [];
  const out: { pid: number; dir: string }[] = [];
  for (const name of readdirSync(root)) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (!statSync(join(root, name)).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push({ pid: Number(name), dir: join(root, name) });
  }
  return out.sort((a, b) => a.pid - b.pid);
}

// =============================================================================
// Write
// =============================================================================

export function writeMeta(dir: string, meta: ProcessMeta): void {
  const path = metaPath(dir, asProcessId(meta.pid));
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // Best-effort: the write below reports the real failure if the directory
    // could not be created.
  }
  writeFileSync(path, JSON.stringify(meta, null, 2), 'utf8');
}

/**
 * Write the **exit record** — the kernel's own account of how a process ended.
 *
 * The kernel is the only writer that was there. It knows the process's
 * identity, the state it ended in, the code it ended with, what it spent and
 * what it was allowed to do (docs/ABI.md §4.2). Its account wins, because it
 * is the account of what actually happened.
 *
 * The CLI owns the process's *declaration* — the memory policies it was given
 * and what it was blocked on — and the kernel's record says nothing about
 * either, so that part of the record is kept.
 *
 * This is a merge, not a replace, and it has to be: `meta.json` has two
 * authors, and a plain overwrite makes the last one erase the first one's
 * facts. Which one wrote last was a race — and the race was won by the
 * *thinner* record. A `cortex spawn` that finished replaced the kernel's exit
 * record with its own, and the capabilities the process held (the one thing
 * the kernel persists that the syscall log cannot show) went with it: a
 * process that held every capability was recorded as holding none, and
 * `cortex ps` printed `-` for it — not "everything", the *absence* of an
 * answer.
 */
export function writeExitRecord(dir: string, meta: PersistedProcessMeta): void {
  const recorded = readMeta(dir, asProcessId(meta.pid));
  if (recorded === undefined) {
    writeMeta(dir, meta);
    return;
  }
  writeMeta(dir, {
    ...recorded,
    ...meta,
    // Money only grows: the CLI may know about spend the kernel could not
    // see (`cortex wrap`'s tap), and nobody may make a process look like it
    // spent less than the kernel recorded.
    budgetsSpent: maxSpend(recorded.budgetsSpent, meta.budgetsSpent),
  });
}

/**
 * How the CLI's view of a process is written.
 */
export interface ProcessViewOptions {
  /**
   * Whether the **CLI** is the author of this ending.
   *
   * Normally the process ended itself, and the kernel's exit record is the
   * account of how — the CLI is only reporting it. But when the CLI stops a
   * run for overrunning, the CLI is the one who decided, and the kernel only
   * saw a signal: the record would say "the wrapper process exited 1" where
   * the truth is "we killed it, because it overran".
   *
   * So the CLI says so, and its account of the ending becomes the record's.
   */
  readonly ownsEnding?: boolean;
}

/**
 * Write the **CLI's view** of a process, on top of what is already recorded.
 *
 * The record on disk is the kernel's — it is the writer that was there — so
 * the kernel's facts are kept. The CLI contributes the declaration (the
 * memory policies, what the process was blocked on) and fills in a fact the
 * record does not have yet: a `meta.json` written by a build that did not
 * record capabilities, for instance, gets them from the view.
 *
 * The CLI's snapshot of the *life* — its state, its exit code, its identity
 * — is deliberately not allowed to overwrite the record. The CLI reads the
 * process table at the end of a command, which is *after* the process is gone
 * and reaped: at that point it is guessing, and a guess that overwrites a
 * fact is worse than no fact at all. The one exception is the ending the CLI
 * decided itself (`ownsEnding`).
 */
export function writeProcessView(
  dir: string,
  meta: ProcessMeta,
  options?: ProcessViewOptions,
): void {
  const recorded = readMeta(dir, asProcessId(meta.pid));
  if (recorded === undefined) {
    writeMeta(dir, meta);
    return;
  }
  writeMeta(dir, {
    ...recorded,
    // The declaration is the CLI's to set: the kernel never sees it.
    ...(meta.memory !== undefined ? { memory: meta.memory } : {}),
    ...(meta.blockedOn !== undefined ? { blockedOn: meta.blockedOn } : {}),
    // A fact the record does not carry is filled in from the view.
    ...(recorded.capabilities === undefined && meta.capabilities !== undefined
      ? { capabilities: meta.capabilities }
      : {}),
    // The same for the priority it ran at: the kernel's record is the one
    // that has it, and a record written before the kernel kept it gets it
    // from the view.
    ...(recorded.nice === undefined && meta.nice !== undefined ? { nice: meta.nice } : {}),
    // The ending belongs to whoever decided it: the process, in which case
    // the record already has it, or the CLI — which only happens when the
    // CLI stopped the run itself.
    ...(options?.ownsEnding === true
      ? { exitCode: meta.exitCode, exitReason: meta.exitReason }
      : {}),
    budgetsSpent: maxSpend(recorded.budgetsSpent, meta.budgetsSpent),
  });
}

/**
 * The larger of two spend counters, field by field.
 *
 * "Money only grows" — the rule that lets two writers share one file. A
 * writer that can see spend the other could not (`cortex wrap` reads the
 * tapped child's LLM calls back off the log) adds to the counters; nobody
 * may make a process look like it spent less than was already recorded.
 */
function maxSpend(a: BudgetCounters, b: BudgetCounters): BudgetCounters {
  return {
    tokensIn: Math.max(a.tokensIn, b.tokensIn),
    tokensOut: Math.max(a.tokensOut, b.tokensOut),
    tokensCached: Math.max(a.tokensCached, b.tokensCached),
    usdSpent: Math.max(a.usdSpent, b.usdSpent),
    wallTimeMs: Math.max(a.wallTimeMs, b.wallTimeMs),
    syscallCount: Math.max(a.syscallCount, b.syscallCount),
  };
}

/**
 * The capabilities a process holds, as a record should say them.
 *
 * `null` on the entry means **unnarrowed** — the process holds everything
 * (docs/ABI.md §4.9) — and that is *not* the same as holding the full set
 * explicitly: an unnarrowed process can `release()` a capability and take it
 * back, while a process holding an explicit set cannot. The record says what
 * the process could do; the spec says whether it was narrowed.
 */
export function heldCapabilities(held: Set<Capability> | null): readonly Capability[] {
  return held === null ? DEFAULT_CAPABILITIES : [...held];
}

/**
 * Write a process's spec — how it was born.
 *
 * Written when the process is created, not when it ends: a snapshot of a
 * process that was still running has to be restorable after its kernel is
 * gone, and by then nothing else would know what the process was.
 */
export function writeSpec(dir: string, spec: ProcessSpec): void {
  const path = specPath(dir, asProcessId(spec.pid));
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // Best-effort: the write below reports the real failure if the directory
    // could not be created.
  }
  writeFileSync(path, JSON.stringify(spec, null, 2), 'utf8');
}

/**
 * Read a persisted capability list back.
 *
 * Three outcomes, and the middle one matters:
 *
 *   - `null` — the file says the process was **unnarrowed** (it holds
 *     everything). Distinct from "not recorded", because an unnarrowed
 *     process can `release()` a capability and take it back, while a process
 *     holding an explicit set cannot (docs/ABI.md §4.9).
 *   - `undefined` — the file cannot say: the field is absent (a spec written
 *     by a build that did not record capabilities) **or** it is malformed.
 *     Both mean the same thing to a caller, and turning a corrupt list into
 *     "everything" would be the one answer that is always wrong.
 */
function readCapabilities(raw: unknown): readonly Capability[] | null | undefined {
  if (raw === null) return null;
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const out: Capability[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return undefined;
    if (!(CAPABILITIES as readonly string[]).includes(item)) return undefined;
    const cap = item as Capability;
    if (!out.includes(cap)) out.push(cap);
  }
  return out;
}

/**
 * Read persisted budget limits back, with the same rule: a file that cannot
 * be read exactly is a file that says nothing.
 */
function readBudgets(raw: unknown): BudgetLimits | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const tokens = r['tokens'];
  const usd = r['usd'];
  const wallTimeMs = r['wallTimeMs'];
  if (
    typeof tokens !== 'number' ||
    typeof usd !== 'number' ||
    typeof wallTimeMs !== 'number' ||
    !Number.isFinite(tokens) ||
    !Number.isFinite(usd) ||
    !Number.isFinite(wallTimeMs)
  ) {
    return undefined;
  }
  return { tokens, usd, wallTimeMs };
}

/**
 * Read a process's spec back.
 *
 * Returns `undefined` when there is none — an older home, a process created
 * by a kernel that did not persist specs, or a truncated file. The caller
 * falls back to whatever else it can find.
 */
export function readSpec(dir: string, pid: ProcessId): ProcessSpec | undefined {
  const path = specPath(dir, pid);
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Partial<ProcessSpec>;
  if (typeof r.role !== 'string' || typeof r.agent !== 'object' || r.agent === null) {
    return undefined;
  }
  // The authority the process was born with. It has to survive the round
  // trip: a supervisor that rebuilds the agent from this spec must not hand
  // it more power than the one it replaces (docs/ABI.md §4.9).
  const capabilities = readCapabilities(r.capabilities);
  // `grantable` is only meaningful next to a capability list — a process
  // that is unnarrowed has no escalation pool to speak of.
  const grantable = readCapabilities(r.grantable);
  const budgets = readBudgets(r.budgets);
  return {
    pid: unbrand(pid),
    ppid: typeof r.ppid === 'number' ? r.ppid : null,
    role: r.role,
    agent: r.agent as AgentSpec,
    ...(r.memory !== undefined ? { memory: r.memory } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(grantable !== null && grantable !== undefined ? { grantable } : {}),
    ...(budgets !== undefined ? { budgets } : {}),
    startedAt: typeof r.startedAt === 'string' ? r.startedAt : '',
    kernelAbiVersion: typeof r.kernelAbiVersion === 'string' ? r.kernelAbiVersion : '',
  };
}

/**
 * The on-disk form of one captured line.
 *
 * One format, two users: the file that holds the line, and the follower
 * that prints it while it streams. If the two formatted it differently, the
 * same line would look like two lines — so they share this.
 *
 * The stream tag is typed loosely on purpose: the file's own entries are
 * `'out' | 'err'`, but a line that arrives over the wire carries whatever
 * the host that captured it said, and printing it is better than dropping
 * it.
 */
export function formatOutputEntry(entry: {
  readonly at: string;
  readonly stream: string;
  readonly text: string;
}): string {
  return `${entry.at} | ${entry.stream} | ${entry.text}\n`;
}

/**
 * Take one captured line apart again.
 *
 * The format and its inverse live together, so a line the writer wrote is a
 * line a reader can take apart — and every reader takes it apart the same
 * way.
 *
 * Only the **first** two separators are separators: the text may hold the
 * separator itself, and everything after them is the line. A line that is
 * not in the format is not a captured line, and says so by being absent — a
 * reader must not invent a timestamp for it.
 */
export function parseOutputEntry(line: string): OutputEntry | undefined {
  const first = line.indexOf(' | ');
  if (first <= 0) return undefined;
  const second = line.indexOf(' | ', first + 3);
  if (second < 0) return undefined;
  const stream = line.slice(first + 3, second);
  if (stream.length === 0) return undefined;
  return {
    at: line.slice(0, first),
    stream,
    text: line.slice(second + 3),
  };
}

/**
 * Read a process's captured output.
 *
 * The lines come back in the order they were printed, and `tail` keeps only
 * the last N of them: an agent that has printed a hundred thousand lines
 * should not cost the operator's window a hundred thousand lines of JSON.
 * `total` says how many there were, so a view can say that it is showing the
 * end of a longer history instead of pretending the history is that short.
 *
 * A process that has printed nothing has no output log. That is not an
 * error — it is a process that printed nothing — so the answer is an empty
 * list, and the caller says so in its own words.
 */
export async function readOutputEntries(
  dir: string,
  pid: ProcessId,
  options: { readonly tail?: number } = {},
): Promise<{ readonly entries: OutputEntry[]; readonly total: number }> {
  let text: string;
  try {
    text = await readFile(outputPath(dir, pid), 'utf8');
  } catch {
    return { entries: [], total: 0 };
  }
  const lines = text.split('\n');
  // A trailing newline yields an empty last element; drop it.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const entries: OutputEntry[] = [];
  for (const line of lines) {
    const entry = parseOutputEntry(line);
    if (entry !== undefined) entries.push(entry);
  }
  const tail = options.tail;
  if (tail !== undefined && tail >= 0 && entries.length > tail) {
    return { entries: entries.slice(entries.length - tail), total: entries.length };
  }
  return { entries, total: entries.length };
}

/**
 * Append one captured line to a process's `output.log`.
 *
 * Appends are synchronous on purpose: the daemon that owns the live agent can
 * be killed at any moment, and an asynchronous write would lose exactly the
 * lines that were printed just before it died — which is when you want them
 * most.
 *
 * Returns the **byte offset the line was written at**. That is what lets a
 * follower stitch the file and the live stream together: a line that is
 * already behind the follower's read position was printed by the file read,
 * and must not be printed twice.
 */
export function appendOutput(dir: string, pid: ProcessId, entry: OutputEntry): number {
  const path = outputPath(dir, pid);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // Best-effort: the append below reports the real failure.
  }
  // The offset is the file's size before the append. One process writes one
  // file, so nothing else can move it in between.
  let offset = 0;
  try {
    offset = statSync(path).size;
  } catch {
    offset = 0;
  }
  appendFileSync(path, formatOutputEntry(entry), 'utf8');
  return offset;
}

export function deleteMeta(dir: string, pid: ProcessId): void {
  for (const path of [metaPath(dir, pid), legacyMetaPath(dir, pid)]) {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // Best-effort.
    }
  }
}

// =============================================================================
// Read
// =============================================================================

export function readMeta(dir: string, pid: ProcessId): ProcessMeta | undefined {
  // Current layout first; a meta written by a pre-0.2.1 build is still readable.
  for (const path of [metaPath(dir, pid), legacyMetaPath(dir, pid)]) {
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as ProcessMeta;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Read a process's captured output back.
 *
 * Returns `undefined` when the process never printed anything that was
 * captured — an older home, a process that has not run yet, or one that said
 * nothing at all.
 */
export function readOutput(dir: string, pid: ProcessId): string | undefined {
  const path = outputPath(dir, pid);
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Every process index on disk, both layouts: `processes/<pid>/meta.json`
 * (current) and `processes/<pid>.meta.json` (pre-0.2.1).
 */
export function readAllMetas(dir: string): readonly ProcessMeta[] {
  const root = processesDir(dir);
  if (!existsSync(root)) return [];
  const results = new Map<number, ProcessMeta>();

  for (const p of listProcDirs(dir)) {
    const meta = readMeta(dir, asProcessId(p.pid));
    if (meta !== undefined) results.set(p.pid, meta);
  }
  // Legacy flat files, for a home written before 0.2.1.
  for (const file of readdirSync(root)) {
    if (!file.endsWith('.meta.json')) continue;
    try {
      const meta = JSON.parse(readFileSync(join(root, file), 'utf8')) as ProcessMeta;
      // The newer layout wins if both exist.
      if (!results.has(meta.pid)) results.set(meta.pid, meta);
    } catch {
      // Skip corrupt files.
    }
  }
  // Sort by PID for stable output.
  return [...results.values()].sort((a, b) => a.pid - b.pid);
}

// =============================================================================
// High-level helpers
// =============================================================================

/**
 * Find the highest PID that exists on disk. Used by `spawn`/`restore` to seed
 * the PID counter so a new process doesn't collide with a previous one.
 *
 * CRUCIAL: this scans BOTH `*.meta.json` AND `*.crec`. A forked child gets a
 * `.crec` (its own recorder) but NO `.meta.json` — `spawn` only writes a meta
 * for the single top-level PID it started. If seeding looked at metas alone, a
 * forked child's PID would be invisible, the counter would re-seed below it,
 * and the next invocation would allocate that same PID again. Because
 * `Recorder.open` uses `'a+'` (append), the new process's syscalls would be
 * appended onto the *old* child's `.crec`, silently merging two unrelated
 * processes and corrupting `trace`/`diff`/`readExitRecord`. Counting the raw
 * `.crec` files too closes that collision.
 */
export function maxPidOnDisk(dir: string): number {
  const root = processesDir(dir);
  if (!existsSync(root)) return 1; // init (PID 1) always exists conceptually
  let max = 1;
  // Current layout: one directory per process.
  for (const p of listProcDirs(dir)) if (p.pid > max) max = p.pid;
  // Legacy flat files.
  for (const file of readdirSync(root)) {
    const m = file.match(/^(\d+)\.(?:meta\.json|crec)$/);
    if (m === null) continue;
    const pid = Number(m[1]);
    if (Number.isInteger(pid) && pid > max) max = pid;
  }
  return max;
}

/**
 * Recover a reaped process's REAL exit status from its `.crec` log.
 *
 * Once the process table reaps an entry, the in-memory `exitCode` is gone.
 * The `exit` syscall record (`phase: 'exit'`, `result: { code, reason }`) is
 * the durable source of truth. `spawn` uses this so it never reports a
 * failed/crashed run as `code 0: completed`.
 *
 * Returns `undefined` when the log is missing or carries no exit record —
 * e.g. the agent crashed before recording, or was killed by a signal that
 * never routed through the dispatcher's `exit` path. Callers should treat
 * `undefined` as "unknown / abnormal", NOT as success.
 */
export async function readExitRecord(
  dir: string,
  pid: ProcessId,
): Promise<{ code: number; reason: string } | undefined> {
  const file = existingCrecPath(dir, pid);
  if (!existsSync(file)) return undefined;
  let found: { code: number; reason: string } | undefined;
  try {
    for await (const rec of readRecords(file)) {
      if (rec.syscall === 'exit' && rec.phase === 'exit' && rec.result !== undefined) {
        const r = rec.result as { code?: unknown; reason?: unknown };
        found = {
          code: typeof r.code === 'number' ? r.code : 0,
          reason: typeof r.reason === 'string' ? r.reason : 'exit',
        };
      }
    }
  } catch {
    // A torn trailing frame is silently dropped by readRecords; any other read
    // error still yields whatever exit record we already saw (possibly none).
    return found;
  }
  return found;
}

/**
 * Resolve a checkpoint tag to its chain ID.
 *
 * The tag is NOT in the `.csnap` filename or body — it is recorded in the
 * checkpointing process's `.crec`. So we scan every process log and return the
 * chain ID of the most recent checkpoint whose tag matches. Returns
 * `undefined` if none.
 *
 * ## The tag and the chain id live in different frames
 *
 * Since the `checkpoint` syscall moved onto the dispatcher's recording path,
 * one call writes an `enter` frame and an `exit` frame, and the two facts
 * fell into different ones: the `enter` frame carries the *arguments*
 * (`{tag, detach}`) and the `exit` frame carries the *result*
 * (`{chainId, byteSize, syscallLogOffset}`). So the two are paired by their
 * call id.
 *
 * This used to work by accident: before the move, the checkpoint module wrote
 * a single frame carrying both, and a reader that looked for one frame with
 * `args.tag` *and* `result.chainId` found it. When the frames split, that
 * reader quietly stopped finding anything — and `cortex restore --tag` began
 * to answer "no checkpoint found with tag X" for a checkpoint that was right
 * there on disk. A log written before the move still holds both in one
 * frame, so both shapes are read.
 */
export async function findCheckpointByTag(dir: string, tag: string): Promise<string | undefined> {
  const root = processesDir(dir);
  if (!existsSync(root)) return undefined;
  let latest: { chainId: string; at: string } | undefined;

  // Every log we can find, in either layout. `existingCrecPath` covers the
  // per-process directory; the flat scan below covers pre-0.2.1 homes.
  const logs: string[] = [];
  for (const p of listProcDirs(dir)) {
    const candidate = join(p.dir, 'log.crec');
    if (existsSync(candidate)) logs.push(candidate);
  }
  for (const file of readdirSync(root)) {
    if (file.endsWith('.crec')) logs.push(join(root, file));
  }

  for (const logPath of logs) {
    // callId → tag, for the `enter` frames seen so far in this log. The
    // matching `exit` frame carries the chain id.
    const tagByCallId = new Map<string, string>();
    try {
      for await (const rec of readRecords(logPath)) {
        if (rec.syscall !== 'checkpoint') continue;
        const args = rec.args as { tag?: unknown } | undefined;
        const result = rec.result as { chainId?: unknown } | undefined;

        if (rec.phase === 'enter') {
          if (typeof args?.tag === 'string') tagByCallId.set(rec.callId, args.tag);
          continue;
        }
        if (rec.phase !== 'exit') continue;
        if (typeof result?.chainId !== 'string') continue;

        // The tag is either on this frame (the pre-dispatcher shape) or on the
        // `enter` frame of the same call.
        const frameTag =
          typeof args?.tag === 'string' ? args.tag : tagByCallId.get(rec.callId);
        if (frameTag !== tag) continue;

        if (latest === undefined || rec.timestamp > latest.at) {
          latest = { chainId: result.chainId, at: rec.timestamp };
        }
      }
    } catch {
      // Skip unreadable / torn logs.
    }
  }
  return latest?.chainId;
}

/**
 * Every directory that may hold a checkpoint: the shared `<dir>/checkpoints/`
 * (pre-0.2.1) and each `processes/<pid>/checkpoints/`.
 */
function checkpointDirs(dir: string): string[] {
  const dirs = [join(dir, 'checkpoints')];
  for (const p of listProcDirs(dir)) dirs.push(procCheckpointsDir(dir, asProcessId(p.pid)));
  return dirs;
}

/**
 * List every checkpoint on disk. Scans both layouts: the shared
 * `<dir>/checkpoints/` (pre-0.2.1) and each `processes/<pid>/checkpoints/`.
 */
export function listCheckpoints(dir: string): readonly { chainId: string; filename: string; createdAt: string }[] {
  const results = new Map<string, { chainId: string; filename: string; createdAt: string }>();

  for (const cpDir of checkpointDirs(dir)) {
    if (!existsSync(cpDir)) continue;
    for (const file of readdirSync(cpDir)) {
      if (!file.endsWith('.csnap')) continue;
      const match = file.match(/^(.+)_([0-9a-f-]{36})\.csnap$/);
      if (match === null) continue;
      const chainId = match[2]!;
      // Shared and per-process dirs can both hold it after an upgrade; keep one.
      if (!results.has(chainId)) {
        results.set(chainId, { createdAt: match[1]!, chainId, filename: file });
      }
    }
  }
  return [...results.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Find the file of one checkpoint, by its chain id.
 *
 * The chain id is the file name's suffix (`<createdAt>_<chainId>.csnap`), so
 * the file is found by scanning — the same scan the kernel does after a
 * restart, and the same one the dashboard's checkpoint list uses. A chain id
 * that is not on disk has no file, and says so by being absent.
 */
export function findCheckpointFile(dir: string, chainId: string): string | undefined {
  for (const cpDir of checkpointDirs(dir)) {
    if (!existsSync(cpDir)) continue;
    for (const file of readdirSync(cpDir)) {
      if (!file.endsWith('.csnap')) continue;
      if (!file.endsWith(`_${chainId}.csnap`)) continue;
      return join(cpDir, file);
    }
  }
  return undefined;
}
