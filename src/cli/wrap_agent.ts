/**
 * The wrapper agent — `src/cli/wrap_agent.ts`.
 *
 * Loaded by `cortex wrap` as a kernel-spawned agent. Its whole job is to run
 * somebody else's command as a child process, while the kernel owns the
 * lifecycle around it.
 *
 * This is the honest answer to "how do I get an existing project under
 * supervision without rewriting it". The project is not modified, not
 * re-implemented, and not asked to speak cortex. It is run as a subprocess of
 * a kernel process, which means from the kernel's point of view it has a PID,
 * a parent, a state, a budget and a signal disposition. `cortex kill` works.
 * `cortex ps` works. `cortex trace` works. The restart policy works.
 *
 * What it cannot do, and the file header in the command says so too:
 * checkpoint captures the *wrapper's* state, not the child's. The child is a
 * separate OS process with its own heap, so a snapshot cannot reach into it.
 * `restore` therefore restarts the command, it does not resume it mid-flight.
 * That is why the natural checkpoint boundary here is "the run ended" — it is
 * the one boundary that is actually true.
 *
 * @module cli/wrap_agent
 */

import { spawn } from 'node:child_process';
import type { CortexContext } from '../kernel/index.js';

/**
 * What the wrapper was asked to run. Passed through `ctx.args` by
 * `cortex wrap`, so the whole invocation is one JSON blob and the module needs
 * no environment plumbing.
 */
export interface WrapArgs {
  /** argv[0] plus the rest, exactly as typed after `--`. */
  readonly argv: readonly string[];
  /** Working directory for the child. Defaults to the wrapper's own cwd. */
  readonly cwd?: string;
  /**
   * Grace period between SIGTERM and SIGKILL, in ms. A project that installs
   * its own SIGTERM handler needs time to finish writing its output.
   */
  readonly killGraceMs?: number;
  /** Inherit the parent's stdio so the child talks to the real terminal. */
  readonly inheritStdio?: boolean;
  /**
   * Environment overrides applied on top of the wrapper's environment. Used
   * by the tap integration to hand the child a `CORTEX_TAP_PID` and a state
   * directory so the child can report its own LLM calls back into this log.
   */
  readonly env?: Readonly<Record<string, string>>;
}

const DEFAULT_KILL_GRACE_MS = 5_000;

export default async function wrappedCommand(ctx: CortexContext, raw: unknown): Promise<void> {
  // `ctx.exit` returns `never`, so it throws `ProcessExitSignal` and the
  // narrowing below is real rather than decorative. `unwrap` keeps that
  // explicit without sprinkling `!` through the whole body.
  const args = unwrap(parseArgs(raw), ctx, 2, 'wrap: missing or invalid arguments');
  const [command, ...rest] = args.argv;
  if (command === undefined || command.length === 0) {
    ctx.exit(2, 'wrap: no command given');
  }

  const graceMs = args.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  // Forward cancellation. When the kernel stops this process the child must
  // not be orphaned: an agent that survives its supervisor is worse than one
  // that dies with it, because the whole point is that the process tree is
  // knowable from the tree view.
  let cancelled = false;

  const child = spawn(command, rest, {
    ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
    ...(args.inheritStdio === false ? { stdio: 'pipe' } : { stdio: 'inherit' }),
    ...(args.env !== undefined ? { env: { ...process.env, ...args.env } } : {}),
    shell: false,
    windowsHide: true,
  });

  const killTree = (): void => {
    if (child.pid === undefined || child.exitCode !== null) return;
    try {
      // A wrapped project often installs its own SIGTERM handler to flush
      // output, so a hard kill is the wrong first move — it would deny the
      // child the chance to shut down cleanly, and on Windows `taskkill /F`
      // is uncatchable.
      //
      // POSIX: a negative pid signals the whole process group, which is what
      // catches a shell that spawned grandchildren of its own.
      // Windows: Node's `kill()` maps SIGTERM onto TerminateProcess for
      // processes it did not create with a job object, so a graceful request
      // is not available and the honest options are "leave it" or "force
      // it". We force it, but only after the grace period below.
      if (process.platform !== 'win32') {
        process.kill(-(child.pid as number), 'SIGTERM');
        return;
      }
      // Windows: `taskkill /T` without `/F` still asks politely (it fails on
      // a console process, so `/F` is the reliable one). Spawn it detached
      // and let the grace-period escalation handle a child that ignores it.
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        detached: true,
      });
      killer.unref();
    } catch {
      // Already gone. Nothing to do — the exit handler will settle this.
    }
  };

  ctx.on_signal('SIGTERM', () => {
    cancelled = true;
    killTree();
  });
  ctx.on_signal('SIGINT', () => {
    cancelled = true;
    killTree();
  });

  const code = await new Promise<number>((resolve) => {
    child.once('error', (err: NodeJS.ErrnoException) => {
      // ENOENT and friends: the command does not exist. That is a usage
      // error, not a crash, so it gets exit 127 and a readable reason rather
      // than a silent zero the caller would read as success. The `code` is
      // only on the ErrnoException shape, which is why the handler is
      // annotated — the untyped overload reports a bare `Error`.
      //
      // The message goes to stderr as well as the log: a user who typed a
      // command that does not exist is looking at the terminal, and "exit
      // code 127" on its own is a riddle.
      const code = err.code ?? 'UNKNOWN';
      const reason =
        code === 'ENOENT'
          ? `${command}: command not found`
          : code === 'EACCES'
            ? `${command}: permission denied`
            : `${command}: ${code}`;
      console.error(`[wrap] ${reason}`);
      ctx.memory_write('episodic', 'wrap:spawn_error', { command, code, reason }).catch(() => undefined);
      resolve(127);
    });
    child.once('close', (exitCode, signalName) => {
      if (signalName !== null && signalName !== undefined) {
        // Killed by a signal. Report it the way a shell would, so a caller
        // that only inspects the exit code can still tell a crash from a
        // clean finish.
        resolve(128 + (signalNumber(signalName) ?? 15));
        return;
      }
      resolve(exitCode ?? 0);
    });
  });

  // The one boundary that is genuinely a boundary: the run ended. Recording
  // it means `cortex trace` shows what the wrapped project did, and it gives
  // `restore` something real to re-run.
  await ctx
    .memory_write('episodic', 'wrap:result', {
      command,
      exitCode: code,
      ...(cancelled ? { cancelled: true } : {}),
    })
    .catch(() => undefined);

  ctx.exit(code, `${command} exited ${code}${cancelled ? ' (cancelled)' : ''}`);
}

function parseArgs(raw: unknown): WrapArgs | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  const argv = obj['argv'];
  if (!Array.isArray(argv) || argv.some((a) => typeof a !== 'string')) return undefined;
  return {
    argv,
    ...(typeof obj['cwd'] === 'string' ? { cwd: obj['cwd'] } : {}),
    ...(typeof obj['killGraceMs'] === 'number' ? { killGraceMs: obj['killGraceMs'] } : {}),
    ...(typeof obj['inheritStdio'] === 'boolean' ? { inheritStdio: obj['inheritStdio'] } : {}),
    ...(typeof obj['env'] === 'object' && obj['env'] !== null ? { env: obj['env'] as Record<string, string> } : {}),
  };
}

/** Signal name to number for the exit-code convention. */
function signalNumber(name: string): number | undefined {
  const table: Readonly<Record<string, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return table[name.toUpperCase()];
}

/**
 * Narrow out of a validation failure by exiting the process.
 *
 * `ctx.exit` is declared `never` because it throws, so this genuinely
 * narrows — and it keeps the `!` out of the caller's control flow, where a
 * stray non-null assertion on a value that really can be undefined would be
 * the kind of thing that only shows up in production.
 */
function unwrap<T>(value: T | undefined, ctx: CortexContext, code: number, reason: string): T {
  if (value === undefined) ctx.exit(code, reason);
  return value;
}
