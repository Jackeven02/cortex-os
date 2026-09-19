/**
 * cortex built-in driver — filesystem tools (`drivers/tool/fs.ts`).
 *
 * BACKLOG #026: *"file system tools (read, write, list, glob)."* The first
 * `IToolDriver`. It exposes four tools to the agent:
 *
 *   - `fs_read`   — read a file's text content (reversible)
 *   - `fs_write`  — write text to a file (irreversible — overwrites without backup)
 *   - `fs_list`   — list directory entries (idempotent)
 *   - `fs_glob`   — glob-pattern file search (idempotent)
 *
 * The driver is the error boundary for tool invocations: exceptions are
 * translated into `CortexError` with stable errnos (`ENOENT`, `EPERM`,
 * `EACCES`→`EPERM`, `ENOMEM` for oversized reads).
 *
 * See: docs/ABI.md §7.2 (IToolDriver), §4.3 (tool_call);
 *      BACKLOG #026
 *
 * @module drivers/tool/fs
 */

import { promises as fs, constants as fsConstants } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { glob } from 'node:fs/promises';

import {
  type IToolDriver,
  type ToolDescriptor,
  type ToolInvokeContext,
  type ToolResult,
  type ToolCallOptions,
  type StagedAction,
  type JSONSchema,
  type Reversibility,
} from '../../kernel/types.js';
import { CortexError, wrapDriverError } from '../../kernel/errors.js';

// =============================================================================
// §1. Tool descriptors
// =============================================================================

const IRREVERSIBLE: Reversibility = 'irreversible';
const IDEMPOTENT: Reversibility = 'idempotent';

const TOOLS: readonly ToolDescriptor[] = [
  {
    name: 'fs_read',
    description:
      'Read the text content of a file at the given path. Returns the file contents as a string.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the file.' },
        maxBytes: {
          type: 'number',
          description: 'Maximum bytes to read. Default 1MB (1048576).',
        },
      },
      required: ['path'],
    } as JSONSchema,
    reversibility: IDEMPOTENT,
  },
  {
    name: 'fs_write',
    description:
      'Write text content to a file. Creates the file if it does not exist, or overwrites it. ' +
      'Returns the number of bytes written.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the file.' },
        content: { type: 'string', description: 'The text content to write.' },
        append: {
          type: 'boolean',
          description: 'If true, append instead of overwrite. Default false.',
        },
      },
      required: ['path', 'content'],
    } as JSONSchema,
    reversibility: IRREVERSIBLE,
  },
  {
    name: 'fs_list',
    description:
      'List entries in a directory. Returns an array of { name, isDirectory, size } objects.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the directory.' },
      },
      required: ['path'],
    } as JSONSchema,
    reversibility: IDEMPOTENT,
  },
  {
    name: 'fs_glob',
    description:
      'Search for files matching a glob pattern. Returns an array of matching file paths.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern, e.g. "**/*.ts" or "src/**/*.js".',
        },
        cwd: {
          type: 'string',
          description: 'Base directory for the search. Default process.cwd().',
        },
      },
      required: ['pattern'],
    } as JSONSchema,
    reversibility: IDEMPOTENT,
  },
];

// =============================================================================
// §2. Options
// =============================================================================

export interface FsToolOptions {
  readonly name?: string;
  readonly version?: string;
  readonly abiCompat?: string;
  /**
   * Root directory that constrains all operations. If set, any path that
   * resolves outside this root traps with `EPERM`. If unset, the driver does
   * not enforce a sandbox (the agent can access the full filesystem).
   */
  readonly root?: string;
  /**
   * Maximum file size for `fs_read`. Default 1MB (1048576 bytes).
   */
  readonly maxReadBytes?: number;
}

export const FS_DEFAULTS = {
  name: 'fs',
  version: '1.0.0',
  abiCompat: '^1.0.0',
  maxReadBytes: 1_048_576,
} as const;

// =============================================================================
// §3. FsToolDriver
// =============================================================================

export class FsToolDriver implements IToolDriver {
  readonly name: string;
  readonly version: string;
  readonly abiCompat: string;
  readonly forkable = true;

  #root: string | undefined;
  /**
   * `#root` after `realpath`. `undefined` = not yet computed, `null` = the
   * configured root does not exist yet (fall back to its lexical form). Cached
   * because it is needed on every containment check.
   */
  #resolvedRoot: string | null | undefined;
  #maxReadBytes: number;
  #closed = false;

  constructor(opts: FsToolOptions = {}) {
    this.name = opts.name ?? FS_DEFAULTS.name;
    this.version = opts.version ?? FS_DEFAULTS.version;
    this.abiCompat = opts.abiCompat ?? FS_DEFAULTS.abiCompat;
    this.#root = opts.root !== undefined ? resolve(opts.root) : undefined;
    this.#maxReadBytes = opts.maxReadBytes ?? FS_DEFAULTS.maxReadBytes;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async listTools(): Promise<readonly ToolDescriptor[]> {
    return TOOLS;
  }

  async invoke(
    name: string,
    args: unknown,
    ctx: ToolInvokeContext,
  ): Promise<ToolResult> {
    const syscall = 'tool_call';
    if (this.#closed) {
      throw new CortexError('EDRIVER', syscall, {
        message: `fs tool driver '${this.name}' is closed`,
        details: { driver: this.name },
      });
    }

    const start = Date.now();
    try {
      let output: unknown;
      let reversibility: Reversibility;

      switch (name) {
        case 'fs_read':
          ({ output, reversibility } = await this.#doRead(args));
          break;
        case 'fs_write':
          ({ output, reversibility } = await this.#doWrite(args));
          break;
        case 'fs_list':
          ({ output, reversibility } = await this.#doList(args));
          break;
        case 'fs_glob':
          ({ output, reversibility } = await this.#doGlob(args));
          break;
        default:
          throw new CortexError('ENOENT', syscall, {
            message: `fs tool driver has no tool '${name}'`,
            details: { driver: this.name, tool: name },
          });
      }

      return {
        output,
        error: null,
        durationMs: Date.now() - start,
        reversibility,
      };
    } catch (err) {
      if (err instanceof CortexError) throw err;
      throw wrapDriverError(syscall, this.name, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Tool implementations
  // ---------------------------------------------------------------------------

  async #doRead(
    args: unknown,
  ): Promise<{ output: unknown; reversibility: Reversibility }> {
    const { path, maxBytes } = parseReadArgs(args);
    const resolved = await this.#resolve(path);
    await this.#assertFile(resolved);

    const stat = await fs.stat(resolved);
    const limit = Math.min(maxBytes ?? this.#maxReadBytes, this.#maxReadBytes);
    if (stat.size > limit) {
      throw new CortexError('ENOMEM', 'tool_call', {
        message: `file is ${stat.size} bytes, exceeds limit of ${limit}`,
        details: { path: resolved, size: stat.size, limit },
      });
    }

    const content = await fs.readFile(resolved, 'utf8');
    return { output: { path: resolved, content, size: stat.size }, reversibility: IDEMPOTENT };
  }

  async #doWrite(
    args: unknown,
  ): Promise<{ output: unknown; reversibility: Reversibility }> {
    const { path, content, append } = parseWriteArgs(args);
    const resolved = await this.#resolve(path);

    const dir = dirname(resolved);
    await fs.mkdir(dir, { recursive: true });

    const flag = append === true ? 'a' : 'w';
    await fs.writeFile(resolved, content, { flag });
    const bytes = Buffer.byteLength(content, 'utf8');
    return { output: { path: resolved, bytes, appended: append === true }, reversibility: IRREVERSIBLE };
  }

  async #doList(
    args: unknown,
  ): Promise<{ output: unknown; reversibility: Reversibility }> {
    const { path } = parseListArgs(args);
    const resolved = await this.#resolve(path);

    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      let size = 0;
      try {
        if (entry.isFile()) {
          const stat = await fs.stat(join(resolved, entry.name));
          size = stat.size;
        }
      } catch {
        // Permission errors on individual entries are non-fatal.
      }
      result.push({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        size,
      });
    }
    return { output: { path: resolved, entries: result }, reversibility: IDEMPOTENT };
  }

  async #doGlob(
    args: unknown,
  ): Promise<{ output: unknown; reversibility: Reversibility }> {
    const { pattern, cwd } = parseGlobArgs(args);
    // #resolve canonicalises AND enforces containment for whatever base we use.
    const base = await this.#resolve(cwd ?? this.#root ?? process.cwd());

    const matches: string[] = [];
    try {
      const iter = glob(pattern, { cwd: base });
      for await (const match of iter) {
        // A pattern like `../*`, or a directory that is itself a junction/symlink,
        // can yield matches whose REAL target is outside the sandbox even though
        // `base` is inside it. Canonicalise the target, then drop any escape.
        const absolute = await this.#canonicalPath(resolve(base, match));
        if (!(await this.#assertContained(absolute))) continue;
        matches.push(match);
      }
    } catch (err) {
      throw wrapDriverError('tool_call', this.name, err);
    }
    return { output: { pattern, cwd: base, matches: matches.sort() }, reversibility: IDEMPOTENT };
  }

  // ---------------------------------------------------------------------------
  // Sandbox helpers
  // ---------------------------------------------------------------------------
  //
  // Containment is enforced against the CANONICAL path — every symlink and
  // junction resolved — not the lexical one. A purely lexical `resolve()` check
  // is trivially defeated by planting a link INSIDE the sandbox that points at
  // a file OUTSIDE it: the string looks contained, the real target is not. So
  // we `realpath` first and only then decide.

  /** The configured root, realpath-resolved (cached). Undefined when no root. */
  async #canonicalRoot(): Promise<string | undefined> {
    if (this.#root === undefined) return undefined;
    if (this.#resolvedRoot === undefined) {
      try {
        this.#resolvedRoot = await fs.realpath(this.#root);
      } catch {
        // The root does not exist yet (e.g. a fresh workspace). Fall back to
        // its lexical form; a caller cannot escape a directory that is absent.
        this.#resolvedRoot = null;
      }
    }
    return this.#resolvedRoot ?? this.#root;
  }

  /**
   * Is `target` the same as, or strictly under, `root`? Written via `relative`
   * so it is robust to separators, trailing slashes and (on Windows) case —
   * both operands are already canonical here.
   */
  #contained(target: string, root: string): boolean {
    const rel = relative(root, target);
    return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
  }

  /**
   * Lexically resolve `p`, canonicalise its reparse points, and enforce that the
   * result stayed inside the sandbox root. Throws EPERM on escape.
   */
  async #resolve(p: string): Promise<string> {
    const root = await this.#canonicalRoot();
    const canonical = await this.#canonicalPath(resolve(p));
    if (root !== undefined && !this.#contained(canonical, root)) {
      throw new CortexError('EPERM', 'tool_call', {
        message: `path '${p}' resolves to '${canonical}', outside the sandbox root '${root}'`,
        details: { path: canonical, root },
      });
    }
    return canonical;
  }

  /**
   * Resolve every symlink/junction in `target`. When the final component does
   * not exist yet (a write target), canonicalise the nearest existing ancestor
   * and re-join the lexical remainder — that is where a planted link lives, so
   * resolving the ancestors is exactly what is needed.
   */
  async #canonicalPath(target: string): Promise<string> {
    try {
      return await fs.realpath(target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      const parent = dirname(target);
      if (parent === target) return target; // reached the filesystem root
      const canonicalParent = await this.#canonicalPath(parent);
      return join(canonicalParent, basename(target));
    }
  }

  /**
   * Boolean containment probe for an already-absolute `path`. Compares against
   * the CANONICAL root so both `..` traversals and reparse-point escapes are
   * dropped. True when no root is configured.
   */
  async #assertContained(path: string): Promise<boolean> {
    const root = await this.#canonicalRoot();
    if (root === undefined) return true;
    return this.#contained(path, root);
  }

  async #assertFile(p: string): Promise<void> {
    try {
      const stat = await fs.stat(p);
      if (!stat.isFile()) {
        throw new CortexError('EINVAL', 'tool_call', {
          message: `path '${p}' is a directory, not a file`,
          details: { path: p },
        });
      }
    } catch (err: any) {
      if (err instanceof CortexError) throw err;
      if (err.code === 'ENOENT') {
        throw new CortexError('ENOENT', 'tool_call', {
          message: `no such file: '${p}'`,
          details: { path: p },
        });
      }
      if (err.code === 'EACCES') {
        throw new CortexError('EPERM', 'tool_call', {
          message: `permission denied: '${p}'`,
          details: { path: p },
        });
      }
      throw err;
    }
  }

  async serializeState(): Promise<Uint8Array | null> {
    return null;
  }

  async restoreState(_blob: Uint8Array): Promise<void> {
    // Stateless driver; nothing to restore.
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}

// =============================================================================
// §4. Argument parsers
// =============================================================================

interface ReadArgs {
  readonly path: string;
  readonly maxBytes?: number;
}

function parseReadArgs(args: unknown): ReadArgs {
  if (typeof args !== 'object' || args === null) {
    throw new CortexError('EINVAL', 'tool_call', { message: 'args must be an object' });
  }
  const obj = args as Record<string, unknown>;
  const path = obj['path'];
  if (typeof path !== 'string' || path.length === 0) {
    throw new CortexError('EINVAL', 'tool_call', { message: 'path is required and must be a string' });
  }
  const maxBytesRaw = obj['maxBytes'];
  return {
    path,
    ...(typeof maxBytesRaw === 'number' && maxBytesRaw > 0 ? { maxBytes: maxBytesRaw } : {}),
  };
}

interface WriteArgs {
  readonly path: string;
  readonly content: string;
  readonly append?: boolean;
}

function parseWriteArgs(args: unknown): WriteArgs {
  if (typeof args !== 'object' || args === null) {
    throw new CortexError('EINVAL', 'tool_call', { message: 'args must be an object' });
  }
  const obj = args as Record<string, unknown>;
  const path = obj['path'];
  const content = obj['content'];
  const append = obj['append'];
  if (typeof path !== 'string' || path.length === 0) {
    throw new CortexError('EINVAL', 'tool_call', { message: 'path is required and must be a string' });
  }
  if (typeof content !== 'string') {
    throw new CortexError('EINVAL', 'tool_call', { message: 'content is required and must be a string' });
  }
  return {
    path,
    content,
    ...(typeof append === 'boolean' ? { append } : {}),
  };
}

interface ListArgs {
  readonly path: string;
}

function parseListArgs(args: unknown): ListArgs {
  if (typeof args !== 'object' || args === null) {
    throw new CortexError('EINVAL', 'tool_call', { message: 'args must be an object' });
  }
  const obj = args as Record<string, unknown>;
  const path = obj['path'];
  if (typeof path !== 'string' || path.length === 0) {
    throw new CortexError('EINVAL', 'tool_call', { message: 'path is required and must be a string' });
  }
  return { path };
}

interface GlobArgs {
  readonly pattern: string;
  readonly cwd?: string;
}

function parseGlobArgs(args: unknown): GlobArgs {
  if (typeof args !== 'object' || args === null) {
    throw new CortexError('EINVAL', 'tool_call', { message: 'args must be an object' });
  }
  const obj = args as Record<string, unknown>;
  const pattern = obj['pattern'];
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new CortexError('EINVAL', 'tool_call', { message: 'pattern is required and must be a string' });
  }
  const cwd = obj['cwd'];
  return {
    pattern,
    ...(typeof cwd === 'string' && cwd.length > 0 ? { cwd } : {}),
  };
}

/**
 * Convenience factory. `fsTool({ root: '.' })` returns a ready-to-register
 * driver; `DriverRegistry.registerTool(fsTool())` is the whole wiring.
 */
export function fsTool(opts: FsToolOptions = {}): FsToolDriver {
  return new FsToolDriver(opts);
}
