/**
 * The crash log.
 *
 * A kernel that is asked to stop writes a checkpoint and then a "gone" line
 * for each process. A kernel that dies does neither of the last step, so the
 * last "live" line for that process is still here. The next boot reads the
 * log and brings those processes back.
 *
 * Coming back is a new PID. If that process had a checkpoint, the boot
 * restores it. If it did not, the boot starts the same agent again from the
 * top. The call that was in flight is gone either way.
 */

import { appendFile, readFile } from 'node:fs/promises';
import type { AgentSpec } from './types.js';

export interface RecoveryLive {
  readonly op: 'live';
  readonly pid: number;
  readonly role: string;
  readonly agent: AgentSpec;
  readonly at: string;
}

export interface RecoveryGone {
  readonly op: 'gone';
  readonly pid: number;
  readonly at: string;
}

export type RecoveryRecord = RecoveryLive | RecoveryGone;

export function foldRecovery(records: readonly RecoveryRecord[]): RecoveryLive[] {
  const live = new Map<number, RecoveryLive>();
  for (const record of records) {
    if (record.op === 'gone') live.delete(record.pid);
    else live.set(record.pid, record);
  }
  return [...live.values()];
}

export function parseRecovery(text: string): RecoveryRecord[] {
  const out: RecoveryRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) out.push(parsed);
    } catch {
      // A crash can tear the last line. Skip it.
    }
  }
  return out;
}

export class RecoveryLog {
  constructor(private readonly path: string) {}

  async read(): Promise<RecoveryRecord[]> {
    try {
      return parseRecovery(await readFile(this.path, 'utf8'));
    } catch {
      return [];
    }
  }

  async survivors(): Promise<RecoveryLive[]> {
    return foldRecovery(await this.read());
  }

  async live(pid: number, role: string, agent: AgentSpec, at: string): Promise<void> {
    await this.#append({ op: 'live', pid, role, agent, at });
  }

  async gone(pid: number, at: string): Promise<void> {
    await this.#append({ op: 'gone', pid, at });
  }

  async #append(record: RecoveryRecord): Promise<void> {
    await appendFile(this.path, `${JSON.stringify(record)}\n`, 'utf8');
  }
}

function isRecord(value: unknown): value is RecoveryRecord {
  if (typeof value !== 'object' || value === null) return false;
  const op = (value as { op?: unknown }).op;
  const pid = (value as { pid?: unknown }).pid;
  if (typeof pid !== 'number') return false;
  if (op === 'gone') return true;
  if (op !== 'live') return false;
  const role = (value as { role?: unknown }).role;
  const agent = (value as { agent?: unknown }).agent;
  return typeof role === 'string' && typeof agent === 'object' && agent !== null;
}
