/**
 * cortex kernel — error model.
 *
 * Every syscall can fail. Failures are signalled by throwing `CortexError`,
 * which carries an `errno`, the name of the syscall that trapped, and
 * optional structured `details`.
 *
 * The errno table is defined in docs/ABI.md §3.2. Modeled on POSIX where
 * possible; cortex-specific codes (`EBUDGET`, `EREVERSIBLE`, `EDRIVER`,
 * `ESTATE`, `ERECORD`) are documented there.
 *
 * **Trap vs return.** A *trap* is a synchronous error that aborts the
 * syscall before any side effect occurs (e.g. `kill(999999, ...)` traps
 * with `ESRCH`). A *return-with-error* is an asynchronous failure after
 * partial work (e.g. `llm_call` timing out after the request was sent).
 * Traps are deterministic and replay-safe; return-with-errors may not be.
 * Both surface as `CortexError` to the agent — the distinction is recorded
 * in the `.crec` log via the `phase` field (`trap` vs `exit` with error).
 *
 * See: docs/ABI.md §3
 *
 * @module kernel/errors
 */

// =============================================================================
// §1. Errno
// =============================================================================

/**
 * The fifteen errnos cortex v0 defines. Ten are POSIX-shaped, five are
 * cortex-specific.
 *
 * POSIX-shaped (semantics intentionally close to the C equivalents):
 *   - `EINVAL`     invalid argument
 *   - `ESRCH`      no such process
 *   - `ENOENT`     no such entity (memory region, channel, snapshot, tool)
 *   - `EAGAIN`     resource temporarily unavailable; retry
 *   - `EINTR`      syscall interrupted by signal
 *   - `EPERM`      permission denied
 *   - `ETIMEDOUT`  driver or kernel timeout
 *   - `ENOMEM`     memory region full or budget exhausted
 *   - `EBADF`      bad channel / file descriptor
 *   - `ECHILD`     no child processes
 *
 * Cortex-specific:
 *   - `EBUDGET`     token / USD / wall-time budget exhausted
 *   - `EREVERSIBLE` irreversible syscall attempted inside a `forkable` region
 *   - `EDRIVER`     driver returned a non-conforming response, or refused
 *   - `ESTATE`      syscall not allowed in the current process state
 *   - `ERECORD`     recording subsystem failure (disk full, etc.)
 *
 * See: docs/ABI.md §3.2
 */
export type Errno =
  | 'EINVAL'
  | 'ESRCH'
  | 'ENOENT'
  | 'EAGAIN'
  | 'EINTR'
  | 'EPERM'
  | 'ETIMEDOUT'
  | 'ENOMEM'
  | 'EBADF'
  | 'ECHILD'
  | 'EBUDGET'
  | 'EREVERSIBLE'
  | 'EDRIVER'
  | 'ESTATE'
  | 'ERECORD';

/**
 * Numeric codes for each errno. Stable; recorded in `.crec` files. Changing
 * a code is a breaking ABI change and requires a major version bump.
 *
 * The numbering starts at 1000 to leave headroom for future POSIX-aligned
 * additions in the 1-999 range without colliding with libc conventions.
 */
export const ErrnoCode = {
  EINVAL: 1001,
  ESRCH: 1002,
  ENOENT: 1003,
  EAGAIN: 1004,
  EINTR: 1005,
  EPERM: 1006,
  ETIMEDOUT: 1007,
  ENOMEM: 1008,
  EBADF: 1009,
  ECHILD: 1010,
  EBUDGET: 1101,
  EREVERSIBLE: 1102,
  EDRIVER: 1103,
  ESTATE: 1104,
  ERECORD: 1105,
} as const satisfies Record<Errno, number>;

/**
 * Reverse lookup: numeric code → errno string. Built once at module load.
 *
 * Used by the recorder when reading legacy `.crec` files, and by the CLI
 * when formatting errors for humans.
 */
export const ErrnoFromCode: Readonly<Record<number, Errno>> = Object.freeze(
  Object.fromEntries(
    (Object.entries(ErrnoCode) as [Errno, number][]).map(([name, code]) => [
      code,
      name,
    ]),
  ) as Record<number, Errno>,
);

/**
 * Default human-readable message for each errno. Callers may override by
 * passing a `message` to `CortexError`; this table is the fallback so error
 * messages stay consistent across the kernel.
 */
export const ErrnoMessage: Readonly<Record<Errno, string>> = Object.freeze({
  EINVAL: 'invalid argument',
  ESRCH: 'no such process',
  ENOENT: 'no such entity',
  EAGAIN: 'resource temporarily unavailable',
  EINTR: 'syscall interrupted by signal',
  EPERM: 'permission denied',
  ETIMEDOUT: 'operation timed out',
  ENOMEM: 'out of memory or region full',
  EBADF: 'bad channel or file descriptor',
  ECHILD: 'no child processes',
  EBUDGET: 'budget exhausted',
  EREVERSIBLE: 'irreversible syscall in forkable region',
  EDRIVER: 'driver returned non-conforming response',
  ESTATE: 'syscall not allowed in current process state',
  ERECORD: 'recording subsystem failure',
});

// =============================================================================
// §2. CortexError
// =============================================================================

/**
 * Structured details attached to an error. Optional; shape depends on the
 * errno. Examples:
 *
 *   - `EBUDGET`: `{ kind: 'tokens' | 'usd' | 'wallTime', spent, limit }`
 *   - `EREVERSIBLE`: `{ tool: string, reversibility: 'irreversible' }`
 *   - `ESTATE`: `{ currentState: ProcessState, allowedStates: ProcessState[] }`
 *   - `EDRIVER`: `{ driver: string, version: string, reason: string }`
 *   - `ETIMEDOUT`: `{ timeoutMs: number, phase: 'request' | 'response' }`
 *
 * The kernel does not enforce a schema; this is a documentation hint for
 * driver and agent authors.
 */
export type CortexErrorDetails = Readonly<Record<string, unknown>>;

/**
 * The single error type thrown by every cortex syscall.
 *
 * Extends `Error` so it works with `try/catch`, `instanceof Error`, and
 * Node's unhandled-rejection machinery. The `errno` field is the canonical
 * machine-readable discriminator; `message` is for humans; `details` is
 * structured context.
 *
 * Usage from agent code:
 *
 * ```ts
 * try {
 *   await ctx.tool_call('send_email', { to, body });
 * } catch (err) {
 *   if (err instanceof CortexError && err.errno === 'EREVERSIBLE') {
 *     // We are inside a forkable region. Stage instead, or exit the region.
 *   } else {
 *     throw err;
 *   }
 * }
 * ```
 *
 * Usage from kernel code (preferred — see `trap` helper below):
 *
 * ```ts
 * trap('ESRCH', 'kill', { pid });
 * ```
 */
export class CortexError extends Error {
  readonly errno: Errno;
  readonly errnoCode: number;
  readonly syscall: string;
  readonly details: CortexErrorDetails | undefined;

  // `cause` is inherited from Error (ES2022). We pass it through `super()`
  // below; no need to redeclare. Set when the error wraps an underlying
  // driver exception, so the original stack is not lost during debugging.

  constructor(
    errno: Errno,
    syscall: string,
    options: {
      readonly message?: string;
      readonly details?: CortexErrorDetails;
      readonly cause?: unknown;
    } = {},
  ) {
    super(options.message ?? ErrnoMessage[errno], { cause: options.cause });
    this.name = 'CortexError';
    this.errno = errno;
    this.errnoCode = ErrnoCode[errno];
    this.syscall = syscall;
    this.details = options.details;

    // Restore prototype chain when targeting ES5 / older runtimes. Not
    // strictly needed for ES2022, but harmless and protects against
    // down-level compilation in consumer projects.
    Object.setPrototypeOf(this, CortexError.prototype);
  }

  /**
   * Stable serialization for the `.crec` recording format. The recorder
   * writes exactly this shape into the `error` field of a `trap` record.
   *
   * See: docs/ABI.md §6
   */
  toJSON(): {
    readonly errno: Errno;
    readonly errnoCode: number;
    readonly syscall: string;
    readonly message: string;
    readonly details?: CortexErrorDetails;
  } {
    return {
      errno: this.errno,
      errnoCode: this.errnoCode,
      syscall: this.syscall,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

// =============================================================================
// §3. Helpers
// =============================================================================

/**
 * Type guard. Distinguishes `CortexError` from any other thrown value.
 *
 * Robust against the classic "instanceof fails across module copies" pitfall
 * by also checking the `errno` shape. Use this instead of `instanceof` in
 * library code that may be loaded twice.
 */
export function isCortexError(err: unknown): err is CortexError {
  if (err instanceof CortexError) return true;
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as { name?: unknown; errno?: unknown };
  return candidate.name === 'CortexError' && typeof candidate.errno === 'string';
}

/**
 * Throw a `CortexError`. Returns `never` so it can be used in expression
 * position to satisfy the type checker:
 *
 * ```ts
 * const proc = table.get(pid) ?? trap('ESRCH', 'kill', { pid });
 * ```
 *
 * This is the canonical way for kernel modules to signal failures. Direct
 * `throw new CortexError(...)` is also fine but more verbose.
 */
export function trap(
  errno: Errno,
  syscall: string,
  details?: CortexErrorDetails,
  message?: string,
): never {
  throw new CortexError(errno, syscall, {
    ...(details !== undefined ? { details } : {}),
    ...(message !== undefined ? { message } : {}),
  });
}

/**
 * Wrap an unknown thrown value (typically a driver exception) into a
 * `CortexError` with errno `EDRIVER`. Preserves the original via `cause`.
 *
 * Used at the kernel ↔ driver boundary so agent code never sees a raw
 * vendor exception.
 */
export function wrapDriverError(
  syscall: string,
  driverName: string,
  err: unknown,
): CortexError {
  if (isCortexError(err)) return err;
  return new CortexError(err === undefined || err === null ? 'EDRIVER' : 'EDRIVER', syscall, {
    message: err instanceof Error ? err.message : String(err),
    details: { driver: driverName },
    cause: err,
  });
}

/**
 * Assert that a state is one of the allowed states for a syscall. Traps
 * with `ESTATE` if not. Called by the syscall dispatcher on every
 * invocation; see docs/ARCHITECTURE.md §4.10 step 3.
 *
 * Kept here (rather than in `process_table.ts`) because it produces an
 * error and is therefore part of the error model.
 */
export function assertState(
  current: string,
  allowed: readonly string[],
  syscall: string,
): void {
  if (!allowed.includes(current)) {
    trap('ESTATE', syscall, {
      currentState: current,
      allowedStates: [...allowed],
    });
  }
}
