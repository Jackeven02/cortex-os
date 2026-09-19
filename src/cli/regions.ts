/**
 * cortex CLI — memory-region policy parsing.
 *
 * Backs the `--memory <json>` surface on `cortex spawn` / `cortex daemon
 * install`. A user declares per-region policy overrides as a JSON object
 * keyed by region name; we validate it into well-formed
 * {@link MemoryRegionPolicy} values and MERGE them over the standard
 * `episodic`/`semantic`/`procedural` defaults (override-by-name, add-new,
 * keep-untouched) so a caller only has to spell out what they want to change.
 *
 * This module is pure and dependency-light so both the CLI commands and the
 * smoke suite can import it directly.
 *
 * A `MemoryRegionPolicy.maxEntries` sets a per-region write-count ceiling:
 *   - absent   — inherit the kernel-wide cap (`--max-region-entries`).
 *   - `-1`     — explicitly unlimited for THIS region.
 *   - `>= 0`   — a hard cap; `memory_write` past it traps ENOMEM.
 *
 * @module cli/regions
 */

import type { MemoryRegionPolicy, MemoryRegionKind } from '../kernel/types.js';

const VALID_KINDS: readonly string[] = ['private', 'shared', 'cow'];
const KNOWN_KEYS: readonly string[] = ['kind', 'backing', 'readOnly', 'maxEntries'];

/** Thrown for any malformed `--memory` value; carries a user-facing reason. */
export class MemoryArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryArgError';
  }
}

/**
 * Validate ONE region policy object (already JSON-decoded) into a
 * {@link MemoryRegionPolicy}. Rejects unknown keys, a missing/invalid `kind`,
 * a missing/empty `backing`, a non-boolean `readOnly`, and a non-integer or
 * `< -1` `maxEntries`. Never emits `undefined` fields (exactOptionalPropertyTypes).
 */
export function validateRegionPolicy(name: string, raw: unknown): MemoryRegionPolicy {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MemoryArgError(`region '${name}': expected an object, got ${describe(raw)}`);
  }
  const obj = raw as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.includes(key)) {
      throw new MemoryArgError(`region '${name}': unknown field '${key}' (allowed: ${KNOWN_KEYS.join(', ')})`);
    }
  }

  const kind = obj['kind'];
  if (typeof kind !== 'string' || !VALID_KINDS.includes(kind)) {
    throw new MemoryArgError(
      `region '${name}': 'kind' must be one of ${VALID_KINDS.map((k) => `'${k}'`).join(', ')}, got ${describe(kind)}`,
    );
  }

  const backing = obj['backing'];
  if (typeof backing !== 'string' || backing.trim().length === 0) {
    throw new MemoryArgError(`region '${name}': 'backing' must be a non-empty string, got ${describe(backing)}`);
  }

  const readOnly = obj['readOnly'];
  if (readOnly !== undefined && typeof readOnly !== 'boolean') {
    throw new MemoryArgError(`region '${name}': 'readOnly' must be a boolean when present, got ${describe(readOnly)}`);
  }

  const maxEntries = obj['maxEntries'];
  if (maxEntries !== undefined) {
    if (typeof maxEntries !== 'number' || !Number.isInteger(maxEntries) || maxEntries < -1) {
      throw new MemoryArgError(
        `region '${name}': 'maxEntries' must be an integer >= -1 (-1 = unlimited, 0+ = a hard write cap), got ${describe(maxEntries)}`,
      );
    }
  }

  return {
    kind: kind as MemoryRegionKind,
    backing: backing.trim(),
    ...(readOnly !== undefined ? { readOnly } : {}),
    ...(maxEntries !== undefined ? { maxEntries } : {}),
  };
}

/**
 * Parse a raw `--memory` JSON string into a map of validated per-region
 * policy OVERRIDES (NOT yet merged with defaults). Rejects non-object JSON
 * and per-region shape errors. Empty object `{}` is allowed (a no-op).
 */
export function parseMemoryArg(raw: string): Record<string, MemoryRegionPolicy> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new MemoryArgError(`not valid JSON: ${msg}`);
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new MemoryArgError(`expected a JSON object of region → policy, got ${describe(decoded)}`);
  }
  const out: Record<string, MemoryRegionPolicy> = {};
  for (const [name, value] of Object.entries(decoded as Record<string, unknown>)) {
    out[name] = validateRegionPolicy(name, value);
  }
  return out;
}

/**
 * Merge per-region overrides ONTO a base policy map, keyed by region name:
 * an override replaces a same-named base region wholesale, adds a brand-new
 * region, and leaves untouched regions as they were. Returns a fresh object;
 * neither input is mutated.
 */
export function mergeRegionPolicies(
  base: Readonly<Record<string, MemoryRegionPolicy>>,
  overrides: Readonly<Record<string, MemoryRegionPolicy>>,
): Record<string, MemoryRegionPolicy> {
  return { ...base, ...overrides };
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v === 'object' ? 'an object' : `${typeof v} (${JSON.stringify(v)})`;
}
