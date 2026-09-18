/**
 * cortex built-in driver — in-memory store (`drivers/memory/inmem.ts`).
 *
 * BACKLOG #027: *"in-memory store for tests."* The simplest `IMemoryDriver`:
 * a `Map<string, Map<string, { value, at }>>` per region. No persistence;
 * state is lost on `close()`. Useful for tests, CI, and ephemeral agents.
 *
 * `snapshotRegion` serializes the region's entries to a CBOR-compatible JSON
 * `Uint8Array`; `restoreRegion` replaces the region entirely from such a blob.
 * Fork's COW semantics are handled by `memory.ts` at the kernel level — the
 * driver just stores and snapshots.
 *
 * See: docs/ABI.md §7.3 (IMemoryDriver);
 *      BACKLOG #027
 *
 * @module drivers/memory/inmem
 */

import {
  type IMemoryDriver,
  type MemoryEntry,
  type MemoryQuery,
  type MemoryWriteOptions,
} from '../../kernel/types.js';
import { CortexError } from '../../kernel/errors.js';

// =============================================================================
// §1. Internal storage
// =============================================================================

interface Entry {
  readonly value: unknown;
  readonly at: string;
  readonly expiresAt: number | null;
}

/**
 * One region is a `Map<string, Entry>`. The driver keeps a `Map<string, Map<string, Entry>>`.
 * A missing region on access is created lazily (v0 simplification per ABI.md §9.3
 * — implicit creation applies to memory regions too).
 */
type RegionMap = Map<string, Entry>;

// =============================================================================
// §2. Options + defaults
// =============================================================================

export interface InMemMemoryOptions {
  readonly name?: string;
  readonly version?: string;
  readonly abiCompat?: string;
  /** Maximum entries per region before `ENOMEM`. Default unlimited (0). */
  readonly maxEntriesPerRegion?: number;
  /** Default TTL in ms applied to writes that omit `ttlMs`. Default 0 (no TTL). */
  readonly defaultTtlMs?: number;
}

export const INMEM_DEFAULTS = {
  name: 'inmem',
  version: '1.0.0',
  abiCompat: '^1.0.0',
  maxEntriesPerRegion: 0,
  defaultTtlMs: 0,
} as const;

// =============================================================================
// §3. InMemMemoryDriver
// =============================================================================

export class InMemMemoryDriver implements IMemoryDriver {
  readonly name: string;
  readonly version: string;
  readonly abiCompat: string;

  #regions = new Map<string, RegionMap>();
  #maxEntries: number;
  #defaultTtl: number;
  #closed = false;

  constructor(opts: InMemMemoryOptions = {}) {
    this.name = opts.name ?? INMEM_DEFAULTS.name;
    this.version = opts.version ?? INMEM_DEFAULTS.version;
    this.abiCompat = opts.abiCompat ?? INMEM_DEFAULTS.abiCompat;
    this.#maxEntries = opts.maxEntriesPerRegion ?? INMEM_DEFAULTS.maxEntriesPerRegion;
    this.#defaultTtl = opts.defaultTtlMs ?? INMEM_DEFAULTS.defaultTtlMs;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Number of regions currently stored. */
  get regionCount(): number {
    return this.#regions.size;
  }

  /** Total entries across all regions. */
  get entryCount(): number {
    let total = 0;
    for (const region of this.#regions.values()) {
      total += region.size;
    }
    return total;
  }

  // ---------------------------------------------------------------------------
  // IMemoryDriver
  // ---------------------------------------------------------------------------

  async read(region: string, query: MemoryQuery): Promise<readonly MemoryEntry[]> {
    this.#assertOpen();
    const map = this.#region(region);
    this.#purgeExpired(map);
    const results: MemoryEntry[] = [];

    if (query.key !== undefined) {
      const entry = map.get(query.key);
      if (entry !== undefined && !this.#isExpired(entry)) {
        results.push(this.#toMemoryEntry(region, query.key, entry));
      }
      return results;
    }

    // Prefix scan or full scan.
    const prefix = query.prefix;
    const limit = query.limit ?? 0;
    let count = 0;
    for (const [key, entry] of map) {
      if (this.#isExpired(entry)) continue;
      if (prefix !== undefined && !key.startsWith(prefix)) continue;
      results.push(this.#toMemoryEntry(region, key, entry));
      count++;
      if (limit > 0 && count >= limit) break;
    }
    return results;
  }

  async write(
    region: string,
    key: string,
    value: unknown,
    opts?: MemoryWriteOptions,
  ): Promise<void> {
    this.#assertOpen();
    const map = this.#region(region);

    if (this.#maxEntries > 0 && !map.has(key) && map.size >= this.#maxEntries) {
      throw new CortexError('ENOMEM', 'memory_write', {
        message: `region '${region}' is full (${this.#maxEntries} entries)`,
        details: { region, limit: this.#maxEntries },
      });
    }

    const now = Date.now();
    const ttl = opts?.ttlMs ?? this.#defaultTtl;
    const expiresAt = ttl > 0 ? now + ttl : null;

    map.set(key, {
      value,
      at: new Date(now).toISOString(),
      expiresAt,
    });
  }

  async delete(region: string, key: string): Promise<void> {
    this.#assertOpen();
    const map = this.#regions.get(region);
    if (map !== undefined) {
      map.delete(key);
    }
  }

  async listRegions(): Promise<readonly string[]> {
    this.#assertOpen();
    return [...this.#regions.keys()];
  }

  async snapshotRegion(region: string): Promise<Uint8Array> {
    this.#assertOpen();
    const map = this.#regions.get(region) ?? new Map<string, Entry>();
    const entries: Array<{ key: string; value: unknown; at: string }> = [];
    for (const [key, entry] of map) {
      if (this.#isExpired(entry)) continue;
      entries.push({ key, value: entry.value, at: entry.at });
    }
    // Serialize as JSON (v0; CBOR is the kernel's job for .csnap).
    const json = JSON.stringify({ region, entries });
    return new TextEncoder().encode(json);
  }

  async restoreRegion(region: string, blob: Uint8Array): Promise<void> {
    this.#assertOpen();
    const text = new TextDecoder().decode(blob);
    const data = JSON.parse(text) as { region: string; entries: Array<{ key: string; value: unknown; at: string }> };
    const map: RegionMap = new Map();
    for (const entry of data.entries) {
      map.set(entry.key, {
        value: entry.value,
        at: entry.at,
        expiresAt: null,
      });
    }
    this.#regions.set(region, map);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#regions.clear();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  #assertOpen(): void {
    if (this.#closed) {
      throw new CortexError('EDRIVER', 'memory', {
        message: `inmem memory driver '${this.name}' is closed`,
        details: { driver: this.name },
      });
    }
  }

  #region(name: string): RegionMap {
    let r = this.#regions.get(name);
    if (r === undefined) {
      r = new Map();
      this.#regions.set(name, r);
    }
    return r;
  }

  #isExpired(entry: Entry): boolean {
    if (entry.expiresAt === null) return false;
    return Date.now() >= entry.expiresAt;
  }

  #purgeExpired(map: RegionMap): void {
    const now = Date.now();
    for (const [key, entry] of map) {
      if (entry.expiresAt !== null && now >= entry.expiresAt) {
        map.delete(key);
      }
    }
  }

  #toMemoryEntry(region: string, key: string, entry: Entry): MemoryEntry {
    return {
      region,
      key,
      value: entry.value,
      at: entry.at,
    };
  }
}

/**
 * Convenience factory. `inmemMemory()` returns a ready-to-register driver;
 * `DriverRegistry.registerMemory(inmemMemory())` is the whole wiring.
 */
export function inmemMemory(opts: InMemMemoryOptions = {}): InMemMemoryDriver {
  return new InMemMemoryDriver(opts);
}
