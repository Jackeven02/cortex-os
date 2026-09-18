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
 * consumers can `import { bootKernel } from 'cortex-os'`.
 *
 * See:
 *   - MANIFESTO.md         — why this project exists
 *   - docs/STATE.md        — agent state, fork taxonomy, irreversible-action doctrine
 *   - docs/PROCESS.md      — agent lifecycle, 8 states, 12 transitions
 *   - docs/ABI.md          — the syscall contract (18 syscalls, 3 driver interfaces)
 *   - docs/ARCHITECTURE.md — kernel modules and data flow
 *   - BACKLOG.md           — first 50 issues
 *
 * @module cortex-os
 */

export const VERSION = '0.0.1' as const;

/**
 * Kernel Abi version, recorded in every `.crec` file. Replay engines use
 * this to negotiate backward compatibility (see docs/ABI.md §9.6).
 *
 * Bumped on every ABI change. Within a major version, recordings are
 * forward-compatible: a kernel of version `1.x.y` can replay any `.crec`
 * written by `1.0.0` or later.
 */
export const KERNEL_ABI_VERSION = '1.0.0' as const;

// Re-export the kernel public surface (types + errors + boot).
export * from './kernel/index.js';
