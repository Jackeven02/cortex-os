/**
 * How two writes to the same shared memory key become one value.
 *
 * A shared region has more than one writer. Replacing the cell with
 * whichever write arrived last throws the other one away. This keeps both
 * when it can, and when it cannot it keeps both sides under one value the
 * next reader can see.
 */

export interface MergedValue {
  readonly value: unknown;
  /** True when the two writes disagreed and neither could absorb the other. */
  readonly conflict: boolean;
}

export function mergeValues(current: unknown, incoming: unknown): MergedValue {
  if (sameJson(current, incoming)) return { value: current, conflict: false };
  if (typeof current === 'string' && typeof incoming === 'string') {
    return { value: mergeLines(current, incoming), conflict: false };
  }
  if (isPlain(current) && isPlain(incoming)) {
    return mergeObjects(current, incoming);
  }
  if (Array.isArray(current) && Array.isArray(incoming)) {
    return { value: mergeLists(current, incoming), conflict: false };
  }
  return { value: { kept: current, also: incoming }, conflict: true };
}

function mergeLines(current: string, incoming: string): string {
  const lines = current.split('\n');
  const have = new Set(lines);
  for (const line of incoming.split('\n')) {
    if (have.has(line)) continue;
    have.add(line);
    lines.push(line);
  }
  return lines.join('\n');
}

function mergeObjects(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): MergedValue {
  const out: Record<string, unknown> = { ...current };
  let conflict = false;
  for (const [key, value] of Object.entries(incoming)) {
    if (!Object.prototype.hasOwnProperty.call(current, key)) {
      out[key] = value;
      continue;
    }
    const merged = mergeValues(current[key], value);
    out[key] = merged.value;
    if (merged.conflict) conflict = true;
  }
  return { value: out, conflict };
}

function mergeLists(current: readonly unknown[], incoming: readonly unknown[]): unknown[] {
  const out = [...current];
  const seen = new Set(current.map((item) => JSON.stringify(item)));
  for (const item of incoming) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
