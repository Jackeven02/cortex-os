/**
 * Which checkpoint files `cortex gc` keeps.
 *
 * One directory is one process's checkpoints. The newest file stays.
 * The rest are the ones a long-running agent no longer needs in order to
 * restore the latest snapshot. Logs are not in this choice: a replay still
 * reads them.
 */

export interface GcFile {
  readonly path: string;
  readonly mtimeMs: number;
}

export function chooseCheckpointKeep(files: readonly GcFile[]): {
  readonly keep: GcFile | null;
  readonly drop: readonly GcFile[];
} {
  if (files.length === 0) return { keep: null, drop: [] };
  const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  return { keep: sorted[0] ?? null, drop: sorted.slice(1) };
}
