/**
 * cortex CLI — disk-backed daemon registry.
 *
 * The on-disk source of truth for `cortex daemon install/uninstall/list/run`.
 * Mirrors `process_store.ts` but for *long-running* agents: each entry is a
 * `DaemonSpec` (role + agent + restart policy) that `cortex daemon run` boots
 * and lets the kernel's init supervise.
 *
 * Persistence layout (docs/ARCHITECTURE.md §7):
 *
 *   .cortex/daemons.json   { version: 1, daemons: { <name>: StoredDaemon } }
 *
 * One file, not one-per-daemon, because the registry is small and we want a
 * single thing to round-trip. Removing a daemon is a key delete, not an `rm -rf`.
 *
 * @module cli/daemon_store
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type DaemonSpec } from '../kernel/init.js';

// =============================================================================
// Types
// =============================================================================

export interface StoredDaemon {
  /** Logical name (stable identity; PIDs change on every restart). */
  readonly name: string;
  readonly spec: DaemonSpec;
  /** ISO timestamp of the last `install`. */
  readonly installedAt: string;
  /** Platform the service unit was generated for, if any. */
  readonly unitPlatform?: NodeJS.Platform;
}

export interface DaemonRegistry {
  readonly version: 1;
  readonly daemons: Record<string, StoredDaemon>;
}

// =============================================================================
// Path helpers
// =============================================================================

export function daemonsPath(dir: string): string {
  return join(dir, 'daemons.json');
}

// =============================================================================
// Read
// =============================================================================

export function readRegistry(dir: string): DaemonRegistry {
  const path = daemonsPath(dir);
  if (!existsSync(path)) return { version: 1, daemons: {} };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<DaemonRegistry>;
    if (raw.version !== 1 || typeof raw.daemons !== 'object' || raw.daemons === null) {
      return { version: 1, daemons: {} };
    }
    return { version: 1, daemons: raw.daemons as Record<string, StoredDaemon> };
  } catch {
    // Corrupt registry: treat as empty rather than crashing the command.
    return { version: 1, daemons: {} };
  }
}

export function listDaemons(dir: string): readonly StoredDaemon[] {
  return Object.values(readRegistry(dir).daemons).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

export function readDaemon(dir: string, name: string): StoredDaemon | undefined {
  return readRegistry(dir).daemons[name];
}

// =============================================================================
// Write
// =============================================================================

export function writeDaemon(dir: string, daemon: StoredDaemon): void {
  const reg = readRegistry(dir);
  reg.daemons[daemon.name] = daemon;
  mkdirSync(dir, { recursive: true });
  writeFileSync(daemonsPath(dir), JSON.stringify(reg, null, 2), 'utf8');
}

export function deleteDaemon(dir: string, name: string): boolean {
  const reg = readRegistry(dir);
  if (!(name in reg.daemons)) return false;
  delete reg.daemons[name];
  writeFileSync(daemonsPath(dir), JSON.stringify(reg, null, 2), 'utf8');
  return true;
}
