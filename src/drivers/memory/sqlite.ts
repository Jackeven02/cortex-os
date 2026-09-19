/**
 * cortex built-in driver — SQLite-backed memory store (`drivers/memory/sqlite.ts`).
 *
 * BACKLOG #028: *"SQLite-backed memory store."* A persistent `IMemoryDriver`
 * backed by a single SQLite database file. Each region is a table; entries are
 * key-value rows with JSON-serialized values and an `at` timestamp column.
 *
 * Uses `node:sqlite` (Node 22+, experimental). The driver is the error
 * boundary: SQLite exceptions are wrapped into `CortexError(EDRIVER)`.
 *
 * `snapshotRegion` exports the region as a JSON `Uint8Array` (same wire format
 * as `inmem.ts` — the kernel's checkpoint/fork code does not care which driver
 * produced the blob). `restoreRegion` replaces the region entirely from such a
 * blob.
 *
 * See: docs/ABI.md §7.3 (IMemoryDriver);
 *      BACKLOG #028
 *
 * @module drivers/memory/sqlite
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  type IMemoryDriver,
  type MemoryEntry,
  type MemoryQuery,
  type MemoryWriteOptions,
} from '../../kernel/types.js';
import { CortexError, wrapDriverError } from '../../kernel/errors.js';

// =============================================================================
// §1. Lazy import of node:sqlite (experimental in Node 22)
// =============================================================================

/**
 * The driver uses `node:sqlite` which is still flagged experimental. We import
 * it lazily so the module loads even if the runtime does not expose it (the
 * driver will trap EDRIVER on the first call instead of crashing at import
 * time).
 */
interface DatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): StatementLike;
  close(): void;
}

interface StatementLike {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): Iterable<unknown>;
  finalize(): void;
}

async function loadSqlite(): Promise<
  new (path: string, opts?: unknown) => DatabaseLike
> {
  // Dynamic import so the module does not crash at load time on older Node.
  // node:sqlite exposes `DatabaseSync` (not `Database`); using the wrong
  // name would yield `undefined` and crash on `new undefined(...)`.
  const mod = await import('node:sqlite');
  return (mod as unknown as { DatabaseSync: new (path: string, opts?: unknown) => DatabaseLike }).DatabaseSync;
}

// =============================================================================
// §2. Options + defaults
// =============================================================================

export interface SqliteMemoryOptions {
  readonly name?: string;
  readonly version?: string;
  readonly abiCompat?: string;
  /**
   * Path to the SQLite database file. If omitted, a default path is computed
   * from `dir` + `'cortex-memory.db'`. The directory is created if missing.
   */
  readonly dbPath?: string;
  /** Directory for the database file (used when `dbPath` is omitted). */
  readonly dir?: string;
}

export const SQLITE_DEFAULTS = {
  name: 'sqlite',
  version: '1.0.0',
  abiCompat: '^1.0.0',
  dbName: 'cortex-memory.db',
} as const;

// =============================================================================
// §3. SqliteMemoryDriver
// =============================================================================

export class SqliteMemoryDriver implements IMemoryDriver {
  readonly name: string;
  readonly version: string;
  readonly abiCompat: string;

  #dbPath: string;
  #db: DatabaseLike | undefined;
  #closed = false;
  #initError: string | undefined;

  constructor(opts: SqliteMemoryOptions = {}) {
    this.name = opts.name ?? SQLITE_DEFAULTS.name;
    this.version = opts.version ?? SQLITE_DEFAULTS.version;
    this.abiCompat = opts.abiCompat ?? SQLITE_DEFAULTS.abiCompat;
    this.#dbPath = opts.dbPath ?? (opts.dir !== undefined ? join(opts.dir, SQLITE_DEFAULTS.dbName) : ':memory:');
    if (opts.dir !== undefined && opts.dbPath === undefined) {
      try {
        mkdirSync(opts.dir, { recursive: true });
      } catch {
        // Directory creation failure is deferred to open().
      }
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async #db_(): Promise<DatabaseLike> {
    if (this.#closed) {
      throw new CortexError('EDRIVER', 'memory', {
        message: `sqlite memory driver '${this.name}' is closed`,
        details: { driver: this.name },
      });
    }
    if (this.#db !== undefined) return this.#db;
    if (this.#initError !== undefined) {
      throw new CortexError('EDRIVER', 'memory', {
        message: `sqlite memory driver '${this.name}' failed to init: ${this.#initError}`,
        details: { driver: this.name },
      });
    }
    try {
      const Database = await loadSqlite();
      this.#db = new Database(this.#dbPath);
      // node:sqlite's DatabaseSync does not have a .pragma() method
      // (that's better-sqlite3's API). Use exec() with PRAGMA statements.
      this.#db.exec('PRAGMA journal_mode = WAL');
      this.#db.exec('PRAGMA synchronous = NORMAL');
      // Schema versioning for future migrations.
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS _meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT OR IGNORE INTO _meta(key, value) VALUES('schema_version', '1');
      `);
    } catch (err) {
      this.#initError = err instanceof Error ? err.message : String(err);
      throw wrapDriverError('memory', this.name, err);
    }
    return this.#db;
  }

  // ---------------------------------------------------------------------------
  // Region helpers
  // ---------------------------------------------------------------------------

  /** Sanitize a region name into a valid SQLite table identifier. */
  #tableName(region: string): string {
    // Region names are user-controlled; replace anything that isn't
    // alphanumeric + underscore to prevent SQL injection through table names.
    const clean = region.replace(/[^a-zA-Z0-9_]/g, '_');
    return `r_${clean}`;
  }

  /** Create the region's table if it does not exist. */
  async #ensureTable(region: string): Promise<DatabaseLike> {
    const db = await this.#db_();
    const table = this.#tableName(region);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${table} (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        at    TEXT NOT NULL,
        ttl_ms INTEGER DEFAULT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_${table}_at ON ${table}(at);
    `);
    return db;
  }

  // ---------------------------------------------------------------------------
  // IMemoryDriver
  // ---------------------------------------------------------------------------

  async read(region: string, query: MemoryQuery): Promise<readonly MemoryEntry[]> {
    const db = await this.#ensureTable(region);
    const table = this.#tableName(region);

    // Purge expired rows.
    db.exec(`DELETE FROM ${table} WHERE ttl_ms IS NOT NULL AND ttl_ms < ${Date.now()}`);

    if (query.key !== undefined) {
      const row = db.prepare(`SELECT key, value, at FROM ${table} WHERE key = ?`).get(query.key) as
        | { key: string; value: string; at: string }
        | undefined;
      if (row === undefined) return [];
      return [{ region, key: row.key, value: JSON.parse(row.value), at: row.at }];
    }

    const prefix = query.prefix;
    const limit =
      query.limit !== undefined && Number.isSafeInteger(query.limit) && query.limit > 0
        ? query.limit
        : undefined;
    const params: unknown[] = [];
    if (prefix !== undefined) params.push(escapeLike(prefix));
    if (limit !== undefined) params.push(limit);
    const sql = `SELECT key, value, at FROM ${table}` +
      (prefix !== undefined ? ` WHERE key LIKE ? ESCAPE '\\'` : '') +
      ` ORDER BY key` +
      (limit !== undefined ? ` LIMIT ?` : '');
    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as Array<{ key: string; value: string; at: string }>;
    return rows.map((r) => ({
      region,
      key: r.key,
      value: JSON.parse(r.value),
      at: r.at,
    }));
  }

  async write(
    region: string,
    key: string,
    value: unknown,
    opts?: MemoryWriteOptions,
  ): Promise<void> {
    const db = await this.#ensureTable(region);
    const table = this.#tableName(region);
    const now = new Date().toISOString();
    const json = JSON.stringify(value);
    const ttl = opts?.ttlMs !== undefined && opts.ttlMs > 0 ? Date.now() + opts.ttlMs : null;
    db.prepare(
      `INSERT INTO ${table} (key, value, at, ttl_ms) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at, ttl_ms = excluded.ttl_ms`,
    ).run(key, json, now, ttl);
  }

  async delete(region: string, key: string): Promise<void> {
    const db = await this.#ensureTable(region);
    const table = this.#tableName(region);
    db.prepare(`DELETE FROM ${table} WHERE key = ?`).run(key);
  }

  async listRegions(): Promise<readonly string[]> {
    const db = await this.#db_();
    const rows = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'r_%' ORDER BY name`,
    ).all() as Array<{ name: string }>;
    // Strip the 'r_' prefix.
    return rows.map((r) => r.name.slice(2));
  }

  async snapshotRegion(region: string): Promise<Uint8Array> {
    const db = await this.#ensureTable(region);
    const table = this.#tableName(region);
    db.exec(`DELETE FROM ${table} WHERE ttl_ms IS NOT NULL AND ttl_ms < ${Date.now()}`);
    const rows = db.prepare(`SELECT key, value, at FROM ${table} ORDER BY key`).all() as Array<{
      key: string;
      value: string;
      at: string;
    }>;
    const entries = rows.map((r) => ({ key: r.key, value: JSON.parse(r.value), at: r.at }));
    const json = JSON.stringify({ region, entries });
    return new TextEncoder().encode(json);
  }

  async restoreRegion(region: string, blob: Uint8Array): Promise<void> {
    const db = await this.#ensureTable(region);
    const table = this.#tableName(region);
    const text = new TextDecoder().decode(blob);
    const data = JSON.parse(text) as { region: string; entries: Array<{ key: string; value: unknown; at: string }> };

    // Replace the region entirely.
    db.exec(`DELETE FROM ${table}`);
    const stmt = db.prepare(
      `INSERT INTO ${table} (key, value, at, ttl_ms) VALUES (?, ?, ?, NULL)`,
    );
    for (const entry of data.entries) {
      stmt.run(entry.key, JSON.stringify(entry.value), entry.at);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#db !== undefined) {
      try {
        this.#db.close();
      } catch {
        // Best-effort close.
      }
      this.#db = undefined;
    }
  }
}

// =============================================================================
// §4. Helpers
// =============================================================================

/**
 * Escape a prefix for SQLite `LIKE`: underscores and percent signs in the
 * prefix are escaped with a backslash so they match literally.
 */
function escapeLike(prefix: string): string {
  return prefix.replace(/([\\%_])/g, '\\$1') + '%';
}

/**
 * Convenience factory. `sqliteMemory({ dir: '.cortex/memory' })` returns a
 * ready-to-register driver.
 */
export function sqliteMemory(opts: SqliteMemoryOptions = {}): SqliteMemoryDriver {
  return new SqliteMemoryDriver(opts);
}
