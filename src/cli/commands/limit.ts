/**
 * cortex CLI — `cortex limit`
 *
 * BACKLOG #037: *"set token / cost / time budgets per process."*
 *
 * v0 model: `limit` with no budget flags reads the process's `.meta.json`
 * from disk and shows its budgets (no kernel boot needed). `limit` with
 * budget flags requires the process to be live in a kernel invocation.
 *
 * Usage:
 *   cortex limit <pid> --tokens <n>
 *   cortex limit <pid> --usd <n>
 *   cortex limit <pid> --wall-time <ms>
 *   cortex limit <pid>   (show current budgets from disk)
 *
 * @module cli/commands/limit
 */

import { parseArgs } from 'node:util';
import { defaultKernelDir, parsePid, readMeta } from '../index.js';
import { unbrand } from '../../kernel/types.js';

export async function cmdLimit(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      tokens: { type: 'string' },
      usd: { type: 'string' },
      'wall-time': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`cortex limit — set or show resource budgets per process

USAGE
  cortex limit <pid> [options]

OPTIONS
  --tokens <n>       Total token budget (input + output)
  --usd <n>          Total USD budget (microdollars)
  --wall-time <ms>   Total wall-clock time budget in milliseconds
  -h, --help         Show this help

EXAMPLES
  cortex limit 2 --tokens 10000
  cortex limit 2 --usd 0.50 --tokens 50000
  cortex limit 2   (show current budgets from disk)
`);
    return values.help ? 0 : 1;
  }

  const pid = parsePid(positionals[0]!);
  const tokens = values.tokens !== undefined ? parseInt(values.tokens, 10) : undefined;
  const usd = values.usd !== undefined ? parseFloat(values.usd) : undefined;
  const wallTime = values['wall-time'] !== undefined ? parseInt(values['wall-time'], 10) : undefined;

  // If no budget flags, show the current state from disk.
  if (tokens === undefined && usd === undefined && wallTime === undefined) {
    const dir = defaultKernelDir();
    const meta = readMeta(dir, pid);
    if (meta === undefined) {
      console.error(`cortex limit: no such process: ${unbrand(pid)} (no .meta.json found)`);
      return 1;
    }

    const spent = meta.budgetsSpent;
    const remaining = meta.budgetsRemaining;
    console.log(`pid ${meta.pid} (${meta.role}):`);
    console.log(
      `  tokens:     spent ${spent.tokensIn + spent.tokensOut} / limit ${remaining.tokens === -1 ? '∞' : remaining.tokens}`,
    );
    console.log(
      `  usd:        spent ${spent.usdSpent / 1_000_000} / limit ${remaining.usd === -1 ? '∞' : remaining.usd}`,
    );
    console.log(
      `  wall time:  spent ${spent.wallTimeMs}ms / limit ${remaining.wallTimeMs === -1 ? '∞' : `${remaining.wallTimeMs}ms`}`,
    );
    return 0;
  }

  // Budget-setting requires a live kernel.
  const { bootCliKernel } = await import('../index.js');
  const dir = defaultKernelDir();
  const kernel = await bootCliKernel(dir);

  try {
    const entry = kernel.table.get(pid);
    if (entry === undefined) {
      console.error(`cortex limit: no such process: ${unbrand(pid)}`);
      console.error(`  (the process must be live in this kernel invocation)`);
      await kernel.shutdown();
      return 1;
    }

    const newLimits = {
      tokens: tokens ?? entry.budgetsRemaining.tokens,
      usd: usd !== undefined ? Math.round(usd * 1_000_000) : entry.budgetsRemaining.usd,
      wallTimeMs: wallTime ?? entry.budgetsRemaining.wallTimeMs,
    };
    kernel.scheduler.setBudget(pid, newLimits);
    console.log(
      `set limits for pid ${unbrand(pid)}: tokens=${newLimits.tokens} usd=${newLimits.usd} wallTime=${newLimits.wallTimeMs}ms`,
    );
    await kernel.shutdown();
    return 0;
  } catch (err) {
    await kernel.shutdown();
    throw err;
  }
}
