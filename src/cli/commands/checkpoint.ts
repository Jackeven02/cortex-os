/**
 * cortex CLI — `cortex checkpoint`
 *
 * BACKLOG #035: *"checkpoint / restore."*
 *
 * v0 model: checkpoint boots a kernel, but the process to checkpoint must
 * exist in this kernel's memory (it was spawned in this invocation). If you
 * need to checkpoint a process from a previous invocation, use `restore`
 * first to bring it back, then checkpoint it again.
 *
 * Usage:
 *   cortex checkpoint <pid> [--tag <tag>] [--detach]
 *
 * @module cli/commands/checkpoint
 */

import { parseArgs } from 'node:util';
import { bootCliKernel, defaultKernelDir, parsePid, unbrand } from '../index.js';

export async function cmdCheckpoint(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      tag: { type: 'string' },
      detach: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`cortex checkpoint — snapshot a process to disk

USAGE
  cortex checkpoint <pid> [options]

OPTIONS
  --tag <string>     Human-readable tag for the checkpoint
  --detach            Transition the process to SUSPENDED after checkpointing
  -h, --help          Show this help

EXAMPLES
  cortex checkpoint 2 --tag "before risky edit"
  cortex checkpoint 2 --detach
`);
    return values.help ? 0 : 1;
  }

  const pid = parsePid(positionals[0]!);
  const dir = defaultKernelDir();
  const kernel = await bootCliKernel(dir);

  try {
    const entry = kernel.table.get(pid);
    if (entry === undefined) {
      console.error(`cortex checkpoint: no such process: ${unbrand(pid)}`);
      console.error(`  (the process must exist in this kernel invocation;`);
      console.error(`   spawn it first, or 'cortex restore' a previous checkpoint)`);
      await kernel.shutdown();
      return 1;
    }

    const result = await kernel.dispatcher.invoke(pid, 'checkpoint', {
      ...(values.tag !== undefined ? { tag: values.tag } : {}),
      detach: values.detach,
    });
    console.log(`checkpointed pid ${unbrand(pid)} → chain ${result.chainId}`);
    console.log(`  file: ${dir}/checkpoints/`);
    await kernel.shutdown();
    return 0;
  } catch (err) {
    await kernel.shutdown();
    throw err;
  }
}
