/**
 * cortex CLI — the shape of a table.
 *
 * ## The rule
 *
 * **A cell that is wider than its column must not push the columns after it.**
 *
 * A table makes a promise: *the thing under STATE is the state*. Break that
 * promise and the table is not a table any more — it is a string with some
 * spaces in it, and the reader has to count characters to find out what they
 * are looking at.
 *
 * The way it broke was not subtle, and it was not rare. Every command built
 * its cells with `String(value).padEnd(width)`, and **`padEnd` does not cut**:
 * a value longer than the column simply runs on into the next one. So:
 *
 * ```console
 * $ cortex ps
 * PID     PPID    ROLE          STATE         TOKENS    CAPS              AGE       WAITING
 * -----------------------------------------------------------------------------------------
 * 2       1       researcher:deep-dive-agentzombie        15.0k     spawn,kill,fork,tool:dangerous,ipc:any7113.8h
 * ```
 *
 * Two fields have been glued together. `researcher:deep-dive-agent` and
 * `zombie` are now one string; so are the capability list and the age. And
 * this was not an edge case: a role name is the operator's own text and a
 * narrowed capability set is wider than any sensible column, so it was the
 * *first* thing that happened.
 *
 * ## The rule, then
 *
 * - **A column is as wide as its widest value in this table**, up to a stated
 *   maximum — so the table is compact when the data is compact, and wide
 *   enough to say everything when the data is wide.
 * - **A value that does not fit is cut, and marked** — `…` says "there was
 *   more here". Silently dropping the tail would be the same lie the whole
 *   table exists to avoid.
 * - **Columns are separated by a gap**, so a cut cell is still visibly a cell
 *   and not the first half of a word glued to the second half of another.
 * - **The heading and the rows come from one column list**, so they cannot
 *   drift apart. The rule under the heading is generated from it too.
 *
 * ## Where the widths come from
 *
 * A column's **maximum** is derived from the value domain it holds whenever
 * that domain is knowable — the process states, the capability vocabulary, the
 * token format — and is a stated constant where it is not. A role is
 * whatever the operator typed, so no domain can be derived for it and it gets
 * a maximum instead.
 *
 * @module cli/table
 */

/**
 * One column of a table: its heading, the width of its cell, and the gap that
 * follows it.
 */
export interface Column {
  /** The heading, as it is printed. */
  readonly header: string;
  /** How wide the cell is. `Infinity` for a column that is never cut. */
  readonly width: number;
  /** The spaces between this column and the next. */
  readonly gap: number;
}

/**
 * A column before it has been sized: the heading, and the widest the cell is
 * allowed to be.
 */
export interface ColumnSpec {
  /** The heading, as it is printed. */
  readonly header: string;
  /**
   * The widest the cell may be.
   *
   * A value longer than this is cut and marked — so this is also the point
   * where information is deliberately lost, and it wants to be as large as the
   * value domain allows.
   */
  readonly max: number;
  /** The spaces between this column and the next. */
  readonly gap: number;
}

/**
 * Fit a cell to its column.
 *
 * A cell that is too long is **cut, and marked**: a name that does not fit is
 * a fact that does not fit, and silently dropping its tail would be the same
 * lie this whole table exists to avoid. The `…` says there was more here.
 */
export function fit(cell: string, width: number): string {
  if (!Number.isFinite(width)) return cell;
  if (cell.length <= width) return cell.padEnd(width);
  if (width <= 1) return cell.slice(0, width);
  return `${cell.slice(0, width - 1)}…`;
}

/**
 * Size the columns to the data in front of us.
 *
 * Each column is as wide as the widest value **in this table**, up to its
 * maximum — and never narrower than its own heading, because a heading that
 * does not fit in its column would be cut, which is a worse thing than a
 * little whitespace.
 *
 * Sizing to the data is what keeps a table honest on both sides: a column
 * that is always `all` does not cost 39 characters of table, and a column
 * that holds a long capability list gets the room it needs.
 */
export function sizeColumns(
  specs: readonly ColumnSpec[],
  rows: readonly (readonly string[])[],
): Column[] {
  return specs.map((spec, index) => {
    let widest = spec.header.length;
    for (const row of rows) {
      const cell = row[index];
      if (cell !== undefined && cell.length > widest) widest = cell.length;
    }
    return { header: spec.header, width: Math.min(widest, spec.max), gap: spec.gap };
  });
}

/** Render the cells of one row in the shared layout. */
export function renderRow(columns: readonly Column[], cells: readonly string[]): string {
  const parts = cells.map((cell, index) => {
    const column = columns[index];
    if (column === undefined) return cell;
    return `${fit(cell, column.width)}${' '.repeat(column.gap)}`;
  });
  return parts.join('').trimEnd();
}

/**
 * The heading that goes with the rows.
 *
 * Generated from the same column list the rows use, so the two cannot drift
 * apart — which is exactly what they used to do.
 */
export function renderHeader(columns: readonly Column[]): string {
  return renderRow(
    columns,
    columns.map((column) => column.header),
  );
}

/** The rule under a heading. */
export function ruleUnder(header: string): string {
  return '-'.repeat(header.length);
}
