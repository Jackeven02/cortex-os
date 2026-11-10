/**
 * cortex — an operating system for AI agents.
 *
 * Public entry point. Re-exports the kernel ABI surface.
 *
 * What lives here:
 *   - All TypeScript types from docs/STATE.md, docs/PROCESS.md, docs/ABI.md
 *   - The error model (CortexError + 15 errnos)
 *   - VERSION and KERNEL_ABI_VERSION constants
 *
 * The kernel runtime, drivers, and CLI are implemented in their respective
 * modules. This entry point re-exports the kernel's public surface so
 * consumers can `import { bootKernel } from 'cortex-agent-os'`.
 *
 * See:
 *   - MANIFESTO.md         — why this project exists
 *   - docs/STATE.md        — agent state, fork taxonomy, irreversible-action doctrine
 *   - docs/PROCESS.md      — agent lifecycle, 8 states, 12 transitions
 *   - docs/ABI.md          — the syscall contract (18 syscalls, 3 driver interfaces)
 *   - docs/ARCHITECTURE.md — kernel modules and data flow
 *   - BACKLOG.md           — first 50 issues
 *
 * @module cortex-agent-os
 */

import { readFileSync } from 'node:fs';

/**
 * Package version, read from the manifest at load time.
 *
 * Deliberately *not* a literal. A hand-maintained version string drifts the
 * moment someone bumps `package.json` and forgets this line — which is exactly
 * what shipped in `0.1.0`: npm served `cortex-agent-os@0.1.0` while the CLI
 * reported itself as `v0.0.1`. Reading the manifest makes that desync
 * structurally impossible.
 *
 * Resolved against `import.meta.url`, so it is correct from both `src/index.ts`
 * and `dist/index.js` — both sit one level below the package root. Careful:
 * this is URL resolution, not path joining, so the filename segment is consumed
 * first and `../package.json` (not `../../`) is the right spelling.
 *
 * The manifest always ships in a published tarball, so the fallback exists only
 * to report a wrong version rather than crash the CLI.
 */
function readPackageVersion(): string {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    const version = (manifest as { version?: unknown }).version;
    return typeof version === 'string' ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = readPackageVersion();

/**
 * Kernel Abi version, recorded in every `.crec` file. Replay engines use
 * this to negotiate backward compatibility (see docs/ABI.md §9.6).
 *
 * Bumped on every ABI change. Within a major version, recordings are
 * forward-compatible: a kernel of version `1.x.y` can replay any `.crec`
 * written by `1.0.0` or later.
 *
 * `1.1.0` added the `renice` syscall and the `renice` capability
 * (docs/ABI.md §4.10, §4.9). Nothing was removed, renamed or redefined, so
 * an agent written against `1.0.0` still runs — it just does not know it can
 * move a rank.
 *
 * `1.2.0` closes the authority hole around birth. A narrowed parent that
 * does not hold `admin` can no longer mint a child with more authority than
 * it holds, a fork keeps the parent's capabilities, and a checkpoint carries
 * them. An agent that relied on the hole now gets `EPERM`. Drivers that
 * declare `abiCompat: '^1.0.0'` still match.
 *
 * `1.3.0` adds `set_intent`, names the sender of a queued signal on the
 * process record, and caps a model or tool call at the kernel ceiling.
 * Nothing was removed. Drivers that declare `abiCompat: '^1.0.0'` still match.
 *
 * `1.4.0` adds a shadow fork and a memory scan that ranks by words or by a
 * vector the caller supplies. Drivers that declare `abiCompat: '^1.0.0'`
 * still match.
 */
export const KERNEL_ABI_VERSION = '1.4.0' as const;

// Re-export the kernel public surface (types + errors + boot).
export * from './kernel/index.js';
export * from './integrations/index.js';
export * from './dashboard/index.js';
