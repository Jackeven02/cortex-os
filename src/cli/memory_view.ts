/**
 * cortex CLI — what a memory region is, and how the views say it.
 *
 * ## The rule
 *
 * **A region has three kinds of fact, and they are not the same kind.**
 *
 * - **What it is**: its name, its kind (`private` / `shared` / `cow`), where
 *   it is stored, and whether *this* process may write to it (`readOnly`).
 * - **What is in it**: how many distinct keys it holds, and how many writes
 *   it has had — the write count is the number the ceiling is measured
 *   against, and it is not the same number as the entry count.
 * - **What it may hold**: the resolved write-count ceiling (`ENOMEM`), and
 *   who else is bound to the same physical region.
 *
 * A view that prints one of them without the others asks the reader to
 * compare two numbers the kernel never compares. A cap printed beside an
 * entry count, with no write count in between, invites a comparison that
 * does not exist; a read-only region printed as an ordinary one invites the
 * reader to think the next write will land.
 *
 * ## Why it lives here
 *
 * Two views answer "what does this process know, and what may it do with
 * it" — the CLI's `cortex memory` and the dashboard's memory panel — and
 * they must not be able to disagree about a region's access mode, its
 * ceiling, or which of its peers may write to it. So the *words* live here,
 * and each view supplies only **how it prints a number**: the CLI shortens
 * (`1.2k`), the dashboard spells it out (`1,234`).
 *
 * @module cli/memory_view
 */

/**
 * A region's access mode, as it is printed.
 *
 * `read-write` when the process may write to it, `read-only` when its own
 * binding refuses writes (the write traps `EPERM`, ABI.md §4.4), and `?`
 * when the kernel did not report one — an access mode nobody reported is
 * not a writable one, and printing `read-write` there would be a claim
 * about a permission that was never stated.
 */
export function formatAccess(readOnly: boolean | undefined): string {
  if (readOnly === undefined) return '?';
  return readOnly ? 'read-only' : 'read-write';
}

/**
 * A region's write-count ceiling, as it is printed.
 *
 * `∞` when the region is unbounded, the number when it is bounded, and `?`
 * when the kernel did not report one — a ceiling nobody reported is not an
 * unbounded region, and printing `∞` there would be a claim about a limit
 * that was never stated.
 */
export function formatLimit(effectiveMaxEntries: number | undefined): string {
  if (effectiveMaxEntries === undefined) return '?';
  if (effectiveMaxEntries < 0) return '∞';
  return String(effectiveMaxEntries);
}

/**
 * The peers bound to the same physical region, each with the access mode it
 * holds the region under.
 *
 * A peer that may only read the region sees everything in it and cannot add a
 * byte to it — the same `EPERM` a read-only binding traps. The list says who
 * can *see* the region; the marker says which of them may *write* to it, and
 * a peer whose mode nobody reported is marked `?` rather than assumed
 * writable.
 */
export function formatPeers(
  sharedWith: readonly number[],
  readOnlyPeers: readonly number[] | undefined,
): string {
  if (sharedWith.length === 0) return '-';
  const readOnly = readOnlyPeers === undefined ? undefined : new Set(readOnlyPeers);
  return sharedWith
    .map((pid) =>
      readOnly === undefined
        ? `${pid} (?)`
        : `${pid} (${readOnly.has(pid) ? 'read-only' : 'read-write'})`,
    )
    .join(', ');
}
