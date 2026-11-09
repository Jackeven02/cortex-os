/**
 * cortex CLI — `cortex doctor`
 *
 * A driver that says it can survive a fork is making a promise the kernel
 * trusts. Doctor says whether that promise has the two methods it would
 * take to show the state, and it says so without calling them.
 *
 * Shared memory is named too: two writers to one key, the later write
 * stands. Doctor does not merge them.
 */

import { parseArgs } from 'node:util';
import { bootCliKernel, defaultKernelDir } from '../index.js';
import { judgeForkClaim } from '../doctor_view.js';

export async function cmdDoctor(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`cortex doctor — check fork claims the kernel would trust

USAGE
  cortex doctor

OPTIONS
  -h, --help   Show this help

NOTES
  A tool driver with forkable=true and both serializeState and restoreState
  is reported as round-trip-declared. Doctor does not call those methods.
  A forkable driver missing either method is unprovable, and the command
  exits 1. Shared memory stays last-write-wins.
`);
    return 0;
  }

  const dir = defaultKernelDir();
  const kernel = await bootCliKernel(dir);
  try {
    console.log('shared memory: last-write-wins. doctor does not merge writes.');
    console.log('');
    const claims = kernel.registry.forkClaims();
    if (claims.length === 0) {
      console.log('(no tool drivers registered)');
      return 0;
    }
    let unprovable = 0;
    for (const claim of claims) {
      const judged = judgeForkClaim(claim);
      if (judged.verdict === 'unprovable') unprovable += 1;
      console.log(`  ${claim.name}: ${judged.verdict} — ${judged.note}`);
    }
    return unprovable === 0 ? 0 : 1;
  } finally {
    await kernel.shutdown();
  }
}
