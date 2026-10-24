/**
 * Module specifiers: what `AgentSpec.module` names, and how it becomes
 * something `import()` can load.
 *
 * ## Why this exists
 *
 * `AgentSpec.module` is documented as a **path or an import specifier**
 * (`src/kernel/types.ts` §9; docs/ABI.md §4.1 shows
 * `agent: { module: './agents/researcher.js' }`). The CLI has always taken a
 * path — `cortex spawn --module ./agent.js` works everywhere. The kernel,
 * though, handed the string straight to `import()`:
 *
 * ```ts
 * const mod = await this.#importModule(spec.module);
 * ```
 *
 * which only works for a *specifier*. On POSIX a relative path happens to
 * survive — Node resolves `./x.js` against the importing module — but on
 * Windows an absolute path does not:
 *
 * ```
 * Only URLs with a scheme in: file, data, and node are supported by the
 * default ESM loader. On Windows, absolute paths must be valid file:// URLs.
 * Received protocol 'f:'
 * ```
 *
 * So the two entry points disagreed, and the loser was the one the ABI
 * documents: an agent that spawned a child with
 * `ctx.spawn({ role: 'child', agent: { module: './child.js' } })` got a child
 * that died with "agent load failed" — and on Windows, a child it could not
 * even name.
 *
 * ## The rule
 *
 * One rule, one place, every entry point:
 *
 *  1. **A URL is used as it is** — `file:`, `node:`, `data:`, `https:`.
 *  2. **A path is resolved against the working directory** and becomes a
 *     `file://` URL. Something is a path when it *looks* like one (`./x`,
 *     `../x`, `/x`, `C:\x`) or when it names a file that is really there.
 *  3. **Anything else is an import specifier** — a package name — and goes to
 *     `import()` untouched.
 *
 * The order matters twice over. A file next to you beats a package of the
 * same name, because a person writing `agent.js` means the file next to them.
 * And a URL is never re-resolved, because `file:///F:/x.js` is already the
 * exact thing `import()` wants.
 *
 * ## Which working directory
 *
 * `KernelOptions.cwd` says, and the kernel captures it when it is
 * constructed. A kernel that resolved paths against a directory that moved
 * underneath it would load child agents from somewhere nobody asked for — and
 * the loader would have no way to say so.
 *
 * ## Why it is its own module
 *
 * Three layers need this rule: the kernel's default loader, the CLI's
 * `--module` flag, and the daemon registry that persists one. A rule only the
 * CLI can reach is a rule the kernel will reinvent — and it did, in the shape
 * of "hand the string to `import()` and hope".
 *
 * @module module_spec
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** A Windows drive letter — `C:\…` or `C:/…`. A path, never a URL scheme. */
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

/** A URL scheme — `file:`, `node:`, `data:`, `https:` … */
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * A spec that names one of the package's own examples:
 * `examples/<stem>.<ext>`, with or without a leading `./`.
 */
const BUNDLED_EXAMPLE = /^examples[/\\]([^/\\]+)\.(?:ts|js|mjs)$/;

/**
 * What a module spec turned out to name.
 */
export interface ResolvedModule {
  /**
   * The specifier `import()` should be handed. A `file://` URL when the spec
   * named a file; the spec unchanged when it named a URL or a package.
   */
  readonly specifier: string;
  /**
   * The file the spec names, resolved against the working directory.
   * `null` when the spec named a URL or a package — neither is a file the
   * kernel can look for on disk.
   */
  readonly path: string | null;
  /**
   * True when the spec named a file — whether or not that file exists.
   *
   * This is the difference between "a path that is not there" (which the
   * caller should complain about *now*) and "a package" (which the loader
   * resolves when it imports, and which may be installed later).
   */
  readonly isPath: boolean;
}

/**
 * The root of the package, whichever layout this is running from:
 *
 *   dist/module_spec.js  ->  <pkg>   (the published layout)
 *   src/module_spec.ts   ->  <repo>  (running from source, via tsx)
 *
 * Found by walking up to the nearest `package.json`, not by counting `..`:
 * a rule that breaks when the file moves one directory is a rule waiting for
 * the next person to move the file.
 */
function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // No package.json anywhere above: fall back to the layout's own parent.
  return join(here, '..');
}

/**
 * Does this spec *look* like a path?
 *
 * A Windows drive letter counts, and is explicitly not a URL scheme: `C:` is
 * a drive, and reading it as a scheme is how `import('C:\\x.js')` ends up
 * asking Node for a protocol it has never heard of.
 */
function isPathLike(spec: string): boolean {
  if (spec === '') return false;
  if (WINDOWS_DRIVE.test(spec)) return true;
  if (spec === '.' || spec === '..') return true;
  if (/^\.\.?([\\/]|$)/.test(spec)) return true;
  if (spec.startsWith('/') || spec.startsWith('\\')) return true;
  return false;
}

/** Does this spec carry a URL scheme (`file:`, `node:`, `data:`, `https:` …)? */
function hasUrlScheme(spec: string): boolean {
  if (WINDOWS_DRIVE.test(spec)) return false;
  return URL_SCHEME.test(spec);
}

/**
 * The file a spec names, resolved against the working directory.
 *
 * The order is the CLI's, and it is the order a person expects:
 *
 *  1. **The path as given, relative to the working directory** — the normal
 *     case for someone's own agent module. It always wins if the file is
 *     there.
 *  2. **The same name inside the package** — for a spec that looks like
 *     `examples/<name>.ts`, the compiled `dist/examples/<name>.js` (what
 *     ships) or the `examples/<name>.ts` sources (what a clone has).
 *  3. **The path as given anyway** — so a wrong path still fails the way it
 *     always did, rather than failing differently just because this module
 *     exists.
 */
function resolveModulePath(spec: string, cwd: string): string {
  const fromCwd = resolve(cwd, spec);
  if (existsSync(fromCwd)) return fromCwd;

  const rel = spec.replace(/^\.[/\\]/, '');
  const match = BUNDLED_EXAMPLE.exec(rel);
  if (match !== null) {
    const stem = match[1]!;
    const root = packageRoot();
    const candidates = [
      join(root, 'dist', 'examples', `${stem}.js`), // what the package ships
      join(root, 'examples', `${stem}.ts`), // what a clone has
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }

  return fromCwd;
}

/**
 * Resolve an agent module spec.
 *
 * @param spec  What the caller wrote: a path, a URL, or a package name.
 * @param cwd   The working directory relative paths are resolved against.
 */
export function resolveModule(spec: string, cwd: string): ResolvedModule {
  // 1. A URL is already what `import()` wants.
  if (hasUrlScheme(spec)) {
    return { specifier: spec, path: null, isPath: false };
  }

  // 2. A path — by shape, or because the file is really there.
  const asPath = resolveModulePath(spec, cwd);
  if (isPathLike(spec) || existsSync(asPath)) {
    return { specifier: pathToFileURL(asPath).href, path: asPath, isPath: true };
  }

  // 3. A package name. `import()` knows how to find it; we do not.
  return { specifier: spec, path: null, isPath: false };
}
