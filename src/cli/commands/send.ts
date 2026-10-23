/**
 * cortex CLI — `cortex send`
 *
 * BACKLOG #036: *"IPC from the shell."*
 *
 * ## What this command means
 *
 * A message is only a message if somebody receives it. In the short-lived
 * CLI model there is nobody to receive it: `cortex send` boots a kernel whose
 * process table holds exactly one entry (init), so a message addressed to a
 * real agent has no inbox to land in, and the kernel exits a millisecond
 * later taking the message with it. The syscall was *recorded*; nothing was
 * delivered.
 *
 * The live kernel changes that. `cortex daemon run` keeps a kernel alive and
 * publishes its endpoint in `<CORTEX_HOME>/kernel.json`
 * (docs/ARCHITECTURE.md §12.1), so `cortex send` can reach it and hand the
 * message to a process that is actually running:
 *
 *   - **live kernel** → the message is delivered through the dispatcher, into
 *     the target's inbox, and the `send` syscall is recorded in the kernel's
 *     `.crec` log exactly like any other.
 *   - **no live kernel** → the command says so, plainly, instead of
 *     pretending it delivered something. The attempt is still recorded
 *     (a `send` syscall appears in init's log) because "someone asked to
 *     send this" is a fact worth keeping — but the operator is told it did
 *     not arrive.
 *
 * Usage:
 *   cortex send <pid> <message>
 *   cortex send --channel <channel> <message>
 *
 * @module cli/commands/send
 */

import { parseArgs } from 'node:util';
import { bootCliKernel, defaultKernelDir, parsePid, unbrand } from '../index.js';
import { asProcessId, asChannelId } from '../../kernel/types.js';
import { KernelCommandError, probeKernel } from '../kernel_client.js';

export async function cmdSend(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      channel: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length < 1) {
    console.log(`cortex send — send a message to a process or channel

USAGE
  cortex send <pid> <message>
  cortex send --channel <channel> <message>

OPTIONS
  --channel <string>   IPC channel to send to
  -h, --help           Show this help

NOTES
  A message needs a live kernel to arrive in. 'cortex daemon run' keeps one
  alive and publishes its endpoint in <CORTEX_HOME>/kernel.json; when one is
  running, this command delivers into it. Without a live kernel the attempt
  is recorded but nothing receives the message, and the command says so.

EXAMPLES
  cortex send 2 "try dynamic programming instead"
  cortex send --channel cortex/init "reload"
`);
    return values.help ? 0 : 1;
  }

  const dir = defaultKernelDir();

  // Resolve the target before touching anything, so both paths report the
  // same errors for the same bad input.
  let targetPid: number | undefined;
  let message: string;
  if (values.channel !== undefined) {
    message = positionals.join(' ');
  } else {
    if (positionals.length < 2) {
      console.error('cortex send: need a PID and a message (or --channel and a message)');
      return 1;
    }
    targetPid = unbrand(parsePid(positionals[0]!));
    message = positionals.slice(1).join(' ');
  }

  const probe = await probeKernel(dir);

  if (probe.kind === 'live') {
    const client = probe.client;
    try {
      const payload =
        targetPid !== undefined
          ? { pid: targetPid, message }
          : { channel: values.channel!, message };
      await client.request('send', payload);
      console.log(
        targetPid !== undefined
          ? `sent to pid ${targetPid}`
          : `sent to channel '${values.channel}'`,
      );
      return 0;
    } catch (err) {
      if (err instanceof KernelCommandError) {
        console.error(`cortex send: ${err.errno}: ${err.message}`);
        return 1;
      }
      throw err;
    } finally {
      client.close();
    }
  }

  // ---- no live kernel ----------------------------------------------------
  if (probe.kind === 'stale') {
    console.error(
      `cortex send: the kernel that published ${probe.endpoint.host}:${probe.endpoint.port} ` +
      `is not reachable (${probe.reason})`,
    );
    console.error('  it may have crashed — restart it with `cortex daemon run`');
  } else {
    console.error('cortex send: no live kernel is running in this directory');
    console.error('  start one with `cortex daemon run` — a message cannot arrive without one');
  }

  // Record the attempt anyway: "someone asked to send this" is a fact, and
  // the `.crec` log is where facts go. What it is *not* is a delivery.
  const kernel = await bootCliKernel(dir);
  try {
    if (targetPid !== undefined) {
      const entry = kernel.table.get(asProcessId(targetPid));
      if (entry === undefined) {
        console.error(`cortex send: no such process: ${targetPid}`);
        return 1;
      }
      await kernel.dispatcher.invoke(asProcessId(1), 'send', asProcessId(targetPid), message);
    } else {
      await kernel.dispatcher.invoke(asProcessId(1), 'send', asChannelId(values.channel!), message);
    }
    console.error('  recorded the attempt, but nothing received it');
    return 1;
  } finally {
    await kernel.shutdown();
  }
}
