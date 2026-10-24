/**
 * cortex CLI — `cortex replay`
 *
 * BACKLOG #072: *"deterministic replay."* STATE.md §5.5 promises it: *"You
 * can always replay an agent's reasoning deterministically."* The recording
 * was always written; nothing ever read it back.
 *
 * Re-runs a recorded agent with the **world frozen** — the model responses,
 * the tool results, the clock and the RNG all come from the recording — and
 * then compares what happened with what was recorded. The point is the
 * comparison: a replay that reproduces the recording says the agent still
 * behaves the way it did, and a replay that does not says **where** it first
 * stopped behaving that way.
 *
 * Usage:
 *   cortex replay <pid>
 *   cortex replay <pid> --mode cached
 *
 * @module cli/commands/replay
 */

import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  bootCliKernel,
  defaultKernelDir,
  ensureKernelDirs,
  parsePid,
  readSpec,
  existingCrecPath,
  unbrand,
} from '../index.js';
import { LogRecording, RECORDING_EXHAUSTED_MARKER, type ReplayMode } from '../../kernel/replay.js';
import { readRecords } from '../../kernel/recorder.js';
import type { SyscallRecord } from '../../kernel/types.js';
import { compareCalls, extractCalls, formatDivergence, type ComparedCall } from '../replay_core.js';

/** Default time to let the replay run before giving up (ms). */
const DEFAULT_TIMEOUT_MS = 30_000;

export async function cmdReplay(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      mode: { type: 'string' },
      timeout: { type: 'string', short: 't' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`cortex replay — re-run a recorded agent and compare it with what was recorded

USAGE
  cortex replay <pid> [options]

OPTIONS
  --mode <strict|cached|live>  What to do with a call the recording does not
                               have:
                                 strict (default) fail loudly — a replay that
                                   quietly reaches the real world is not a
                                   replay
                                 cached  let the real world answer it
                                 live    ignore the recording entirely
  -t, --timeout <ms>           Max wall time for the replay (default 30000)
  -h, --help                   Show this help

NOTES
  The replay runs in a directory of its own (<cortex home>/replays/<pid>-<n>),
  so the recording it is replaying is never written over. Its log is left
  there for inspection.

  The replay is given the SAME pid as the original run, so its children get
  the same pids too — the replay is the same run, not a similar one.

  Exit code: 0 when the replay reproduced the recording, 1 when it did not
  (or when the replay could not be run at all).

EXAMPLES
  cortex replay 7
  cortex replay 7 --mode cached
`);
    return values.help ? 0 : 1;
  }

  const mode = (values.mode ?? 'strict') as ReplayMode;
  if (!['strict', 'cached', 'live'].includes(mode)) {
    console.error(
      `cortex replay: invalid --mode '${values.mode}' (expected one of strict, cached, live)`,
    );
    return 1;
  }

  let pid;
  try {
    pid = parsePid(positionals[0]!);
  } catch (err) {
    console.error(`cortex replay: ${(err as Error).message}`);
    return 1;
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (values.timeout !== undefined) {
    const parsed = parseInt(values.timeout, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(
        `cortex replay: invalid --timeout: '${values.timeout}' (expected a positive integer of milliseconds)`,
      );
      return 1;
    }
    timeoutMs = parsed;
  }

  const dir = defaultKernelDir();

  // --- the recording -------------------------------------------------------
  const crec = existingCrecPath(dir, pid);
  if (!existsSync(crec)) {
    console.error(`cortex replay: no recording for pid ${unbrand(pid)} in ${dir}`);
    console.error('  (a process has to have run here before it can be replayed)');
    return 1;
  }

  // --- how the process was born --------------------------------------------
  //
  // A replay re-runs the agent, so it needs the agent: its module, its
  // arguments, its role, the capabilities it held. `spec.json` is written
  // when a process is created, so it is there even for a process that has
  // already exited.
  const spec = readSpec(dir, pid);
  if (spec === undefined) {
    console.error(`cortex replay: no spec for pid ${unbrand(pid)} — cannot rebuild the agent`);
    console.error('  (the process was not spawned in this cortex home, or was spawned by a build');
    console.error('   that did not persist specs)');
    return 1;
  }

  const recording = await LogRecording.fromFile(crec);
  if (recording.size === 0) {
    console.error(`cortex replay: the recording for pid ${unbrand(pid)} holds no calls to replay`);
    return 1;
  }

  // --- the replay's own directory ------------------------------------------
  //
  // The recording is the replay's *input*. The replay must not write over it,
  // so it gets a directory of its own. Every replay is kept: its log is the
  // evidence of what the replay actually did.
  const replayDir = join(dir, 'replays', `${unbrand(pid)}-${Date.now()}`);
  ensureKernelDirs(replayDir);

  console.log(
    `replaying pid ${unbrand(pid)} (role: ${spec.role}) from ${crec}`,
  );
  console.log(`  mode: ${mode}`);
  console.log(`  recording: ${recording.size} recorded outcomes`);
  console.log(`  replay home: ${replayDir}`);

  const kernel = await bootCliKernel(replayDir, {
    replay: { source: recording, mode },
  });

  try {
    // The same pid as the original run. The replay is the same run, so its
    // children get the same pids too — and a pid that differs would show up
    // as a divergence that is really only an artefact of where the replay
    // happened to be stored.
    kernel.table.advancePidCounterTo(unbrand(pid));

    const spawned = await kernel.spawn({
      role: spec.role,
      agent: spec.agent,
      ...(spec.memory !== undefined ? { memory: spec.memory } : {}),
      ...(spec.capabilities !== undefined && spec.capabilities !== null
        ? { capabilities: spec.capabilities }
        : {}),
      ...(spec.grantable !== undefined ? { grantable: spec.grantable } : {}),
      ...(spec.budgets !== undefined ? { budgets: spec.budgets } : {}),
    });

    // Let the replay run.
    const startTime = Date.now();
    let finished = false;
    while (Date.now() - startTime < timeoutMs) {
      const entry = kernel.table.get(spawned);
      if (
        entry === undefined ||
        entry.state === 'zombie' ||
        entry.state === 'exiting' ||
        entry.state === 'suspended'
      ) {
        finished = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const elapsed = Date.now() - startTime;

    const replayCreC = existingCrecPath(replayDir, spawned);
    if (!existsSync(replayCreC)) {
      console.error(
        `cortex replay: the replay of pid ${unbrand(pid)} produced no log — it never got as ` +
          `far as making a syscall`,
      );
      console.error(`  replay home: ${replayDir}`);
      return 1;
    }
    const originalCalls = extractCalls(await readAll(crec));
    const replayCalls = extractCalls(await readAll(replayCreC));

    const exhausted = findExhausted(replayCalls);
    if (exhausted !== undefined) {
      console.error('');
      console.error(
        `  the recording ran out at call #${exhausted.index + 1} (${exhausted.syscall})`,
      );
      console.error(`  ${exhausted.message}`);
      console.error('');
      console.error(
        mode === 'strict'
          ? '  (strict mode refuses to answer from the real world — try --mode cached)'
          : '  (the call fell through to the real world)',
      );
      console.error(`  replay log: ${replayCreC}`);
      return 1;
    }

    const comparison = compareCalls(originalCalls, replayCalls);

    console.log('');
    console.log(`  recording: ${comparison.originalCalls} calls`);
    console.log(`  replay:    ${comparison.replayCalls} calls`);
    if (!finished) {
      console.log(`  the replay was still running after ${elapsed}ms — the comparison is partial`);
    }

    if (comparison.reproduced) {
      console.log('');
      console.log('  REPRODUCED — the replay made the same calls, in the same order,');
      console.log('  with the same outcomes.');
      console.log(`  replay log: ${replayCreC}`);
      return 0;
    }

    console.log('');
    console.log('  DIVERGED — the replay did not reproduce the recording.');
    console.log(formatDivergence(comparison.divergence!));
    console.log(`  replay log: ${replayCreC}`);
    return 1;
  } finally {
    await kernel.shutdown();
  }
}

/** Read every record of a `.crec` file. */
async function readAll(path: string): Promise<SyscallRecord[]> {
  const records: SyscallRecord[] = [];
  for await (const record of readRecords(path)) records.push(record);
  return records;
}

/**
 * The call where the recording ran out, if it did.
 *
 * A strict replay that has nothing left to say fails in one of two ways:
 * inside a syscall, where the dispatcher records the trap and the errno is
 * `ERECORD`; or in one of the *synchronous* syscalls the agent calls
 * directly — `now()`, `random()` — where there is no dispatcher to record a
 * trap and the failure becomes the process's exit reason instead. Both are
 * the same event, and the user is told what actually happened instead of
 * being shown a divergence that reads like the agent changed its mind.
 */
function findExhausted(
  calls: readonly ComparedCall[],
): { readonly index: number; readonly syscall: string; readonly message: string } | undefined {
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!;
    if (call.error !== undefined) {
      if (call.error.errno === 'ERECORD') {
        return { index: i, syscall: call.syscall, message: call.error.message };
      }
      continue;
    }
    // The exit reason carries the failure of a synchronous syscall.
    const reason = (call.result as { reason?: unknown } | undefined)?.reason;
    if (typeof reason === 'string' && reason.includes(RECORDING_EXHAUSTED_MARKER)) {
      return { index: i, syscall: 'exit', message: reason };
    }
  }
  return undefined;
}
