/**
 * cortex CLI — resolving an agent module path.
 *
 * ## Why this exists
 *
 * `--module` is documented as `--module ./examples/checkpoint-agent.ts` in
 * the README, in `cortex spawn --help`, and in `cortex daemon install
 * --help`. That path is resolved against the **current working directory**,
 * and an installed package does not drop an `examples/` folder into the
 * user's cwd — so for `npm i -g cortex-agent-os`, the documented command
 * pointed at a file that was never there.
 *
 * `cortex example` exists for the same reason (it resolves the *compiled*
 * `dist/examples/*.js` relative to the package itself), but it only covers
 * the examples the command knows by name. This module is the general form:
 * any `--module` argument that names a bundled example resolves inside the
 * package, whether or not the user knows the command's catalogue.
 *
 * ## The order
 *
 * 1. **The path as given, relative to the cwd** — the normal case for a
 *    user's own agent module. It always wins if the file is there.
 * 2. **The same name inside the package** — for a spec that looks like
 *    `examples/<name>.ts`, the compiled `dist/examples/<name>.js` (what
 *    ships) or the `examples/<name>.ts` sources (what a clone has).
 * 3. **The path as given anyway** — so a wrong path still fails the way it
 *    always did, with the same "agent load failed" message, rather than
 *    failing differently just because this module exists.
 *
 * @module cli/module_path
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A spec that names a bundled example: `examples/<stem>.<ext>`, with or
 * without a leading `./`.
 */
const BUNDLED_EXAMPLE = /^examples[/\\]([^/\\]+)\.(?:ts|js|mjs)$/;

/**
 * The root of the package, whichever layout the CLI is running from:
 *
 *   dist/cli/module_path.js  ->  <pkg>   (the published layout)
 *   src/cli/module_path.ts   ->  <repo>  (running from source, via tsx)
 */
function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..');
}

/**
 * Resolve an agent module path.
 *
 * @param spec  The `--module` argument, as the user typed it.
 * @returns An absolute path to the module. Never null: an unresolvable
 *          spec is returned as-is (resolved against the cwd) so the caller
 *          reports it the way it always has.
 */
export function resolveModulePath(spec: string): string {
  const fromCwd = resolve(spec);
  if (existsSync(fromCwd)) return fromCwd;

  // Not in the cwd — maybe it is one of the package's own examples.
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

  // Nothing found: hand back the cwd-relative resolution so the error names
  // the path the user actually typed.
  return fromCwd;
}
