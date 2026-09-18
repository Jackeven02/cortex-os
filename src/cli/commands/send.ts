/**
 * cortex CLI — `cortex send`
 *
 * BACKLOG #036: *"IPC from the shell."*
 *
 * v0 model: send requires a live process in this kernel invocation. Since
 * there is no long-running daemon, this is mainly useful within a scripted
 * pipeline. The message is delivered to the target process's inbox.
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

EXAMPLES
  cortex send 2 "try dynamic programming instead"
  cortex send --channel cortex/init "reload"
`);
    return values.help ? 0 : 1;
  }

  const dir = defaultKernelDir();
  const kernel = await bootCliKernel(dir);

  try {
    if (values.channel !== undefined) {
      const message = positionals.join(' ');
      await kernel.dispatcher.invoke(asProcessId(1), 'send', asChannelId(values.channel), message);
      console.log(`sent to channel '${values.channel}'`);
    } else {
      if (positionals.length < 2) {
        console.error('cortex send: need a PID and a message (or --channel and a message)');
        await kernel.shutdown();
        return 1;
      }
      const pid = parsePid(positionals[0]!);
      const message = positionals.slice(1).join(' ');

      const entry = kernel.table.get(pid);
      if (entry === undefined) {
        console.error(`cortex send: no such process: ${unbrand(pid)}`);
        await kernel.shutdown();
        return 1;
      }

      await kernel.dispatcher.invoke(asProcessId(1), 'send', pid, message);
      console.log(`sent to pid ${unbrand(pid)}`);
    }

    await kernel.shutdown();
    return 0;
  } catch (err) {
    await kernel.shutdown();
    throw err;
  }
}
