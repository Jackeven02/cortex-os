/**
 * cortex CLI — `cortex fork`
 *
 * BACKLOG #034: *"clone a running process at its current state."*
 *
 * v0 model: fork requires a live process in this kernel invocation. The
 * process must be spawned or restored in the same `cortex fork` call chain.
 * For cross-invocation forking, `cortex restore` first, then fork.
 *
 * Usage:
 *   cortex fork <pid> [--tag <tag>] [--budgets reset|inherit|split]
 *
 * @module cli/commands/fork
 */

import { parseArgs } from 'node:util';
import { bootCliKernel, defaultKernelDir, parsePid, unbrand } from '../index.js';

export async function cmdFork(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      tag: { type: 'string' },
      budgets: { type: 'string', default: 'reset' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`cortex fork — clone a running process at its current state

USAGE
  cortex fork <pid> [options]

OPTIONS
  --tag <string>          Human-readable label for the fork
  --budgets <policy>     Budget policy: reset (default), inherit, or split
  -h, --help              Show this help

EXAMPLES
  cortex fork 2
  cortex fork 2 --tag "try dynamic programming" --budgets split
`);
    return values.help ? 0 : 1;
  }

  const pid = parsePid(positionals[0]!);
  const dir = defaultKernelDir();
  const kernel = await bootCliKernel(dir);

  try {
    const entry = kernel.table.get(pid);
    if (entry === undefined) {
      console.error(`cortex fork: no such process: ${unbrand(pid)}`);
      console.error(`  (the process must exist in this kernel invocation)`);
      await kernel.shutdown();
      return 1;
    }

    const result = await kernel.dispatcher.invoke(pid, 'fork', {
      ...(values.tag !== undefined ? { tag: values.tag } : {}),
      ...(values.budgets !== undefined ? { budgets: values.budgets as 'reset' | 'inherit' | 'split' } : {}),
    });
    console.log(`forked pid ${unbrand(pid)} → child pid ${unbrand(result.childPid)}`);
    console.log(`  chain: ${result.childChainId}`);
    console.log(`  shared causal past at offset: ${result.sharedCausalPast}`);
    if (result.irreversibleInPast.length > 0) {
      console.log(`  irreversible actions in past: ${result.irreversibleInPast.join(', ')}`);
    }
    await kernel.shutdown();
    return 0;
  } catch (err) {
    await kernel.shutdown();
    throw err;
  }
}
