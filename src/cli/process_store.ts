/**
 * cortex CLI — disk-backed process store.
 *
 * This is the "disk as source of truth" bridge that lets CLI commands see
 * processes spawned by previous CLI invocations. Each `cortex spawn` writes
 * a `<dir>/processes/<pid>.meta.json` next to the `.crec` log. Read-only
 * commands (`ps`, `trace`, `kill`, `limit`) load these to reconstruct the
 * process table from disk instead of starting with an empty in-memory kernel.
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

import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { unbrand, asProcessId, type ProcessId, type BudgetCounters, type BudgetLimits, type AgentSpec, type SyscallRecord, type ProcessState, type MemoryRegionPolicy, type BlockedReason } from '../kernel/types.js';
import { readRecords, crecPath } from '../kernel/recorder.js';

// =============================================================================
// Types
// =============================================================================

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
  readonly kernelAbiVersion: string;
}

// =============================================================================
// Path helpers
// =============================================================================

export function metaPath(dir: string, pid: ProcessId): string {
  return join(dir, 'processes', `${unbrand(pid)}.meta.json`);
}

export function processesDir(dir: string): string {
  return join(dir, 'processes');
}

// =============================================================================
// Write
// =============================================================================

export function writeMeta(dir: string, meta: ProcessMeta): void {
  const path = metaPath(dir, asProcessId(meta.pid));
  writeFileSync(path, JSON.stringify(meta, null, 2), 'utf8');
}

export function deleteMeta(dir: string, pid: ProcessId): void {
  const path = metaPath(dir, pid);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Best-effort.
  }
}

// =============================================================================
// Read
// =============================================================================

export function readMeta(dir: string, pid: ProcessId): ProcessMeta | undefined {
  const path = metaPath(dir, pid);
  if (!existsSync(path)) return undefined;
  try {
    const text = readFileSync(path, 'utf8');
    return JSON.parse(text) as ProcessMeta;
  } catch {
    return undefined;
  }
}

export function readAllMetas(dir: string): readonly ProcessMeta[] {
  const procDir = processesDir(dir);
  if (!existsSync(procDir)) return [];
  const results: ProcessMeta[] = [];
  for (const file of readdirSync(procDir)) {
    if (!file.endsWith('.meta.json')) continue;
    try {
      const text = readFileSync(join(procDir, file), 'utf8');
      const meta = JSON.parse(text) as ProcessMeta;
      results.push(meta);
    } catch {
      // Skip corrupt files.
    }
  }
  // Sort by PID for stable output.
  return results.sort((a, b) => a.pid - b.pid);
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
  const procDir = processesDir(dir);
  if (!existsSync(procDir)) return 1; // init (PID 1) always exists conceptually
  let max = 1;
  for (const file of readdirSync(procDir)) {
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
  const file = crecPath(dir, pid);
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
 * checkpointing process's `.crec` (`syscall: 'checkpoint'`, `args.tag`,
 * `result.chainId`). So we scan every process log and return the chain ID of
 * the most recent checkpoint whose tag matches. Returns `undefined` if none.
 */
export async function findCheckpointByTag(dir: string, tag: string): Promise<string | undefined> {
  const procDir = processesDir(dir);
  if (!existsSync(procDir)) return undefined;
  let latest: { chainId: string; at: string } | undefined;
  for (const file of readdirSync(procDir)) {
    if (!file.endsWith('.crec')) continue;
    try {
      for await (const rec of readRecords(join(procDir, file))) {
        if (rec.syscall !== 'checkpoint' || rec.phase !== 'exit') continue;
        const args = rec.args as { tag?: unknown } | undefined;
        const result = rec.result as { chainId?: unknown } | undefined;
        if (args?.tag === tag && typeof result?.chainId === 'string') {
          if (latest === undefined || rec.timestamp > latest.at) {
            latest = { chainId: result.chainId, at: rec.timestamp };
          }
        }
      }
    } catch {
      // Skip unreadable / torn logs.
    }
  }
  return latest?.chainId;
}

/**
 * List all checkpoint files in the directory. Returns [{chainId, filename, createdAt}].
 */
export function listCheckpoints(dir: string): readonly { chainId: string; filename: string; createdAt: string }[] {
  const cpDir = join(dir, 'checkpoints');
  if (!existsSync(cpDir)) return [];
  const results: { chainId: string; filename: string; createdAt: string }[] = [];
  for (const file of readdirSync(cpDir)) {
    if (!file.endsWith('.csnap')) continue;
    const match = file.match(/^(.+)_([0-9a-f-]{36})\.csnap$/);
    if (match) {
      results.push({
        createdAt: match[1]!,
        chainId: match[2]!,
        filename: file,
      });
    }
  }
  return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
