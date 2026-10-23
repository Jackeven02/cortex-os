/**
 * cortex CLI — `cortex fork`
 *
 * BACKLOG #034: *"clone a running process at its current state."*
 *
 * A fork snapshots a **running** process: its state, its memory, its budgets,
 * its lineage. The short-lived CLI kernel holds exactly one process (init), so
 * there was never a running process in it to clone — which made this command
 * unable to succeed, in any scenario. It booted a kernel of its own, looked
 * the PID up in that kernel's table, and answered "no such process" for a PID
 * that was very much alive somewhere else.
 *
 * Usage:
 *   cortex fork <pid> [--tag <tag>] [--budgets reset|inherit|split]
 *
 * @module cli/commands/fork
 */

import { parseArgs } from 'node:util';

import { defaultKernelDir, parsePid, unbrand } from '../index.js';
import { KernelCommandError, probeKernel } from '../kernel_client.js';

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

NOTES
  Forking needs the process to be running somewhere: a fork snapshots a live
  process, so the command asks the kernel that has it (one started by
  'cortex daemon run'). The child stays in that kernel and keeps running, and
  'cortex diff <pid> <child>' compares the two branches.

EXAMPLES
  cortex fork 2
  cortex fork 2 --tag "try dynamic programming" --budgets split
`);
    return values.help ? 0 : 1;
  }

  const pid = parsePid(positionals[0]!);
  const dir = defaultKernelDir();

  // There is no local fallback: a fork needs a *live* parent, and a kernel
  // of this command's own holds only init. So the command says plainly what
  // is missing instead of reporting "no such process" for a process that is
  // running somewhere else.
  const probe = await probeKernel(dir);
  if (probe.kind !== 'live') {
    if (probe.kind === 'stale') {
      console.error(
        `cortex fork: the kernel that published ${probe.endpoint.host}:${probe.endpoint.port} ` +
        `is not reachable (${probe.reason})`,
      );
    }
    console.error('cortex fork: forking needs a live kernel — the process has to be running somewhere.');
    console.error("  (start one with 'cortex daemon run', then fork the agent inside it)");
    return 1;
  }

  const client = probe.client;
  try {
    const result = await client.request<{
      childPid: number;
      childChainId: string;
      sharedCausalPast: number;
      irreversibleInPast: readonly string[];
    }>('fork', {
      pid: unbrand(pid),
      ...(values.tag !== undefined ? { tag: values.tag } : {}),
      ...(values.budgets !== undefined ? { budgets: values.budgets } : {}),
    });
    console.log(`forked pid ${unbrand(pid)} → child pid ${result.childPid}`);
    console.log(`  chain: ${result.childChainId}`);
    console.log(`  shared causal past at offset: ${result.sharedCausalPast}`);
    if (result.irreversibleInPast.length > 0) {
      console.log(`  irreversible actions in past: ${result.irreversibleInPast.join(', ')}`);
    }
    console.log(
      `  (the child keeps running in the live kernel — 'cortex send ${result.childPid} "..."' reaches it, ` +
        `and 'cortex diff ${unbrand(pid)} ${result.childPid}' compares the branches)`,
    );
    return 0;
  } catch (err) {
    if (err instanceof KernelCommandError) {
      console.error(`cortex fork: ${err.errno}: ${err.message}`);
      return 1;
    }
    throw err;
  } finally {
    client.close();
  }
}
