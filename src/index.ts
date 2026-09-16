/**
 * cortex — an operating system for AI agents.
 *
 * Public entry point. Re-exports the kernel and driver interfaces.
 *
 * @module
 */

export const VERSION = '0.0.1' as const;

export const CODENAME = 'design-phase' as const;

/**
 * Placeholder. The real surface lands with Phase 1 (kernel skeleton).
 *
 * See:
 *   - MANIFESTO.md       — why this project exists
 *   - docs/ABI.md        — the syscall contract (drafting)
 *   - docs/PROCESS.md    — agent lifecycle (drafting)
 *   - docs/ARCHITECTURE.md — kernel modules (drafting)
 *   - BACKLOG.md         — first 30 issues
 */
export function hello(): string {
  return `cortex v${VERSION} (${CODENAME}) — nothing works yet, everything is the point.`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(hello());
}
