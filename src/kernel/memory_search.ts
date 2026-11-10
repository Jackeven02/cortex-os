/**
 * Rank a memory scan.
 *
 * A key lookup stays exact. A scan may ask for words, or for a vector the
 * caller already computed. The kernel does not call an embedding model.
 * Words score by how many of them appear in the value. A vector scores by
 * cosine against `value.vector`, when the stored value has one. Entries
 * that score nothing are left out.
 */

import type { MemoryEntry, MemoryQuery } from './types.js';

export function rankMemory(
  entries: readonly MemoryEntry[],
  query: MemoryQuery,
): readonly MemoryEntry[] {
  const text = textOf(query);
  const vector = vectorOf(query);
  if (text === null && vector === null) {
    const limit = query.limit ?? 0;
    return limit > 0 ? entries.slice(0, limit) : entries;
  }
  const words = text === null ? [] : tokens(text);
  const scored = entries
    .map((entry) => ({ entry, score: scoreEntry(entry.value, words, vector) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.key.localeCompare(b.entry.key));
  const limit = query.limit ?? 0;
  const picked = limit > 0 ? scored.slice(0, limit) : scored;
  return picked.map((row) => row.entry);
}

function scoreEntry(value: unknown, words: readonly string[], vector: readonly number[] | null): number {
  if (vector !== null) {
    const stored = storedVector(value);
    if (stored !== null) return cosine(vector, stored);
  }
  if (words.length === 0) return 0;
  const have = new Set(tokens(flatten(value)));
  let hit = 0;
  for (const word of words) if (have.has(word)) hit += 1;
  return hit / words.length;
}

function textOf(query: MemoryQuery): string | null {
  const text = query.extra?.['text'];
  return typeof text === 'string' && text.trim() !== '' ? text : null;
}

function vectorOf(query: MemoryQuery): number[] | null {
  const raw = query.extra?.['vector'];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (!raw.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return raw;
}

function storedVector(value: unknown): number[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = (value as { vector?: unknown }).vector;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (!raw.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return raw;
}

function flatten(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter((word) => word.length > 0);
}

function cosine(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
