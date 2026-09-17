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
 * What does NOT live here (yet):
 *   - The kernel implementation (lands across Phase 1, see BACKLOG.md)
 *   - Driver implementations (Phase 2)
 *   - CLI (Phase 3)
 *
 * Until Phase 1 lands the runtime modules, this entry point is essentially
 * types-only plus the version constants. That is intentional: the ABI is
 * the contract, and the contract is what ships first.
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

export const CODENAME = 'design-phase' as const;

/**
 * Kernel ABI version, recorded in every `.crec` file. Replay engines use
 * this to negotiate backward compatibility (see docs/ABI.md §9.6).
 *
 * Bumped on every ABI change. Within a major version, recordings are
 * forward-compatible: a kernel of version `1.x.y` can replay any `.crec`
 * written by `1.0.0` or later.
 */
export const KERNEL_ABI_VERSION = '1.0.0' as const;

// Re-export the kernel public surface (types + errors).
export * from './kernel/index.js';

/**
 * Placeholder. Removed once Phase 1 lands the kernel runtime.
 *
 * @deprecated Will be removed in v0.1.0.
 */
export function hello(): string {
  return `cortex v${VERSION} (${CODENAME}) — ABI shipped, kernel pending.`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(hello());
}
