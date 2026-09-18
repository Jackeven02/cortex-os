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

import { unbrand, asProcessId, type ProcessId, type BudgetCounters, type BudgetLimits, type AgentSpec } from '../kernel/types.js';

// =============================================================================
// Types
// =============================================================================

export interface ProcessMeta {
  readonly pid: number;
  readonly ppid: number | null;
  readonly pgid: number;
  readonly role: string;
  readonly state: string;
  readonly exitCode: number | null;
  readonly exitReason: string | null;
  readonly startedAt: string;
  readonly lastTransitionAt: string;
  readonly budgetsSpent: BudgetCounters;
  readonly budgetsRemaining: BudgetLimits;
  readonly agent: AgentSpec;
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
 * Find the highest PID in the on-disk index. Used by `spawn` to seed the
 * PID counter so a new spawn doesn't collide with a previous one.
 */
export function maxPidOnDisk(dir: string): number {
  const metas = readAllMetas(dir);
  if (metas.length === 0) return 1; // init (PID 1) always exists conceptually
  return Math.max(...metas.map((m) => m.pid));
}

/**
 * Find a checkpoint by tag. Scans the checkpoints directory for a filename
 * containing the tag. Returns the chain ID if found.
 */
export function findCheckpointByTag(dir: string, tag: string): string | undefined {
  const cpDir = join(dir, 'checkpoints');
  if (!existsSync(cpDir)) return undefined;
  for (const file of readdirSync(cpDir)) {
    if (file.includes(tag) && file.endsWith('.csnap')) {
      const match = file.match(/_([0-9a-f-]{36})\.csnap$/);
      if (match) return match[1];
    }
  }
  return undefined;
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
