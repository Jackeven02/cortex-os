/**
 * cortex CLI — per-process stdout capture.
 *
 * ## The problem
 *
 * A live agent prints. It prints progress, it prints warnings, it prints the
 * thing it just found. And until now, all of that went to the *daemon's*
 * stdout — a single anonymous stream shared by the daemon, `init`, and every
 * agent in the tree. There was no way to answer the only question that
 * matters when something looks wrong: **what did that process say?**
 *
 * The `.crec` log cannot answer it. It records what a process *did* — its
 * syscalls, with arguments and results. It never recorded what it *said*.
 * `console.log` is not a syscall; it is not in the ABI; it does not appear
 * in the log. So the one stream an operator actually reads was the one
 * stream the system did not keep.
 *
 * ## The seam
 *
 * The kernel knows *which* process a body belongs to, and nothing else. It
 * does not know what the caller wants to do with that knowledge — writing
 * files, formatting lines, deciding a directory layout are all caller
 * business. So the kernel exposes exactly one hook for it
 * (`KernelOptions.agentScope`): "run this agent body inside a scope you
 * define". The CLI defines that scope, and the scope is an
 * `AsyncLocalStorage` holding the PID.
 *
 * That is the whole trick. `AsyncLocalStorage` carries a value across every
 * `await` inside the body, so a `console.log` that happens three seconds
 * later, after the agent was parked on `recv()` and woken by another
 * process, still knows it is running inside PID 7.
 *
 * ## Why the tap is on `process.stdout.write`, not on `console.log`
 *
 * Patching `console.log` would mean re-implementing its formatting rules
 * (`util.format`, `%s`/`%o`/`%j` substitutions, `util.inspect` of objects)
 * to get the text we want to store — and re-implementing it wrong would
 * change what the operator sees. Patching `process.stdout.write` instead
 * takes the bytes *after* Node has formatted them, so the captured text is
 * exactly what was printed, and the original write still happens, unchanged.
 * The agent's output still goes to the daemon's stdout; it is now *also*
 * addressable.
 *
 * It also catches output that never went through `console` at all — an agent
 * that writes to `process.stdout` directly, or a wrapped child process whose
 * output is piped through.
 *
 * @module cli/output_capture
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { StringDecoder } from 'node:string_decoder';

import { asProcessId, unbrand, type ProcessId } from '../kernel/types.js';
import { appendOutput } from './process_store.js';

/** Which standard stream a captured line came from. */
export type OutputStream = 'out' | 'err';

/**
 * The state of one running agent body.
 *
 * Created per scope (that is, per agent body) and carried across every
 * `await` inside it by `AsyncLocalStorage`. `pending` holds the text of a
 * line that has been started but not yet terminated — `process.stdout.write`
 * is free to write half a line at a time, and a half-line is not a line.
 */
interface CaptureScope {
  readonly pid: number;
  readonly dir: string;
  readonly pending: Record<OutputStream, string>;
  readonly decoders: Record<OutputStream, StringDecoder>;
}

/**
 * The scope of the *currently executing* agent body.
 *
 * `undefined` outside an agent body — which is exactly right: the daemon's
 * own logging, `init`'s supervision notices, and the CLI's command output
 * are not any agent's output, and must never end up in an agent's log.
 */
const scopeStorage = new AsyncLocalStorage<CaptureScope>();

/** Whether the stream tap has been installed in this process. */
let tapInstalled = false;

/**
 * Capture what an agent body prints, attributing it to the process that
 * printed it.
 *
 * One instance per kernel (they all write into the same cortex home, and
 * the scope carries the destination, so several can coexist in one process).
 */
export class OutputCapture {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
    installTap();
  }

  /**
   * Run an agent body with its output attributed to `pid`.
   *
   * This is what `KernelOptions.agentScope` is called with: the kernel hands
   * over the body, the caller decides what "inside a scope" means, and here
   * it means "this body prints as PID N".
   */
  scope<T>(pid: ProcessId, body: () => Promise<T>): Promise<T> {
    const scope: CaptureScope = {
      pid: unbrand(pid),
      dir: this.#dir,
      pending: { out: '', err: '' },
      decoders: { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') },
    };
    return scopeStorage.run(scope, async () => {
      try {
        return await body();
      } finally {
        flush(scope);
      }
    });
  }
}

/**
 * Tap the two standard streams.
 *
 * The tap is installed once per process and dispatches on the *current*
 * scope, so it works no matter how many kernels the process runs.
 */
function installTap(): void {
  if (tapInstalled) return;
  tapInstalled = true;
  patchStream(process.stdout, 'out');
  patchStream(process.stderr, 'err');
}

/**
 * Wrap one stream's `write` so that anything written inside an agent body is
 * copied into that body's log.
 *
 * The original `write` is still called, with the original arguments, and its
 * return value is passed back untouched. The only difference is that the text
 * is also copied — so this changes where output *is*, never what it is.
 */
function patchStream(stream: NodeJS.WriteStream, tag: OutputStream): void {
  const original = stream.write;
  const patched = function (this: unknown, ...args: unknown[]): boolean {
    const scope = scopeStorage.getStore();
    if (scope !== undefined) {
      try {
        capture(scope, tag, args[0]);
      } catch {
        // A capture failure must never break the agent that printed. The
        // write still happens below.
      }
    }
    return (original as (...a: unknown[]) => boolean).apply(stream, args);
  };
  (stream as unknown as { write: unknown }).write = patched;
}

/**
 * Copy one written chunk into the scope's log.
 *
 * Chunks are text or bytes; bytes are decoded with a `StringDecoder` so a
 * multi-byte character split across two writes is not mangled. Anything else
 * (an object with a custom `toString`, say) is ignored — it is not text we
 * can honestly store.
 */
function capture(scope: CaptureScope, tag: OutputStream, chunk: unknown): void {
  let text: string;
  if (typeof chunk === 'string') {
    text = chunk;
  } else if (chunk instanceof Uint8Array) {
    text = scope.decoders[tag].write(chunk);
  } else {
    return;
  }
  if (text.length === 0) return;

  let buffer = scope.pending[tag] + text;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    let line = buffer.slice(0, index);
    // A CRLF stream leaves the carriage return on the line.
    if (line.endsWith('\r')) line = line.slice(0, -1);
    buffer = buffer.slice(index + 1);
    emit(scope, tag, line);
    index = buffer.indexOf('\n');
  }
  scope.pending[tag] = buffer;
}

/**
 * Store one completed line.
 *
 * The timestamp is taken when the line *ends*, not when it starts: a line
 * that took ten seconds to arrive is a line that arrived ten seconds late,
 * and the log should say so.
 */
function emit(scope: CaptureScope, tag: OutputStream, text: string): void {
  try {
    appendOutput(scope.dir, asProcessId(scope.pid), {
      at: new Date().toISOString(),
      stream: tag,
      text,
    });
  } catch {
    // Best-effort: the agent's output is still going to the real stdout, so
    // a failed capture costs the operator the log, not the run.
  }
}

/**
 * Flush a scope's pending partial line.
 *
 * Called when the agent body ends: a `process.stdout.write('done')` without
 * a trailing newline is still something the agent said, and dropping it
 * because it had no newline would be a lie about what was printed.
 */
function flush(scope: CaptureScope): void {
  for (const tag of ['out', 'err'] as const) {
    const rest = scope.pending[tag];
    if (rest.length === 0) continue;
    scope.pending[tag] = '';
    emit(scope, tag, rest);
  }
}
