/**
 * What an agent is trying to do.
 *
 * The checkpoint still stores this as a string, so an old snapshot keeps
 * loading. A new one stores a JSON object with `goal` and `doneWhen`. A
 * string that is not that object is read as a goal with no done-when.
 */

export interface Intent {
  readonly goal: string;
  readonly doneWhen: string | null;
}

export function encodeIntent(intent: Intent | null): string | null {
  if (intent === null) return null;
  return JSON.stringify({ goal: intent.goal, doneWhen: intent.doneWhen });
}

export function decodeIntent(raw: string | null | undefined): Intent | null {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isIntent(parsed)) return { goal: parsed.goal, doneWhen: parsed.doneWhen };
  } catch {
    // A free-form note from an older kernel. The goal is the note.
  }
  return { goal: raw, doneWhen: null };
}

function isIntent(value: unknown): value is { goal: string; doneWhen: string | null } {
  if (typeof value !== 'object' || value === null) return false;
  const goal = (value as { goal?: unknown }).goal;
  const doneWhen = (value as { doneWhen?: unknown }).doneWhen;
  return typeof goal === 'string' && (doneWhen === null || typeof doneWhen === 'string');
}
