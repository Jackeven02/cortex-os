/**
 * cortex CLI — `cortex audit`
 *
 * BACKLOG #040: *"surface tools that are untagged for reversibility."*
 *
 * Boots a kernel just long enough to list all registered drivers and their
 * tools. This is the one command that always boots a kernel (it needs the
 * driver registry to be populated).
 *
 * @module cli/commands/audit
 */

import { parseArgs } from 'node:util';
import { bootCliKernel, defaultKernelDir } from '../index.js';

export async function cmdAudit(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`cortex audit — surface tools that are untagged for reversibility

USAGE
  cortex audit

OPTIONS
  -h, --help   Show this help
`);
    return 0;
  }

  const dir = defaultKernelDir();
  const kernel = await bootCliKernel(dir);

  try {
    const manifest = kernel.registry.listAll();
    let totalTools = 0;

    console.log('Tool drivers:');
    console.log('-'.repeat(80));

    if (manifest.tools.length === 0) {
      console.log('  (no tool drivers registered)');
    } else {
      for (const driver of manifest.tools) {
        console.log(`  ${driver.name} v${driver.version} (forkable=${driver.forkable}, twoPhase=${driver.twoPhase})`);
        for (const toolName of driver.tools) {
          totalTools++;
          console.log(`    - ${toolName}`);
        }
      }
    }

    console.log('');
    console.log('LLM drivers:');
    console.log('-'.repeat(80));

    if (manifest.llm.length === 0) {
      console.log('  (no LLM drivers registered)');
    } else {
      for (const llm of manifest.llm) {
        const models = llm.supportedModels.join(', ');
        const def = llm.isDefault ? ' (default)' : '';
        console.log(`  ${llm.name.padEnd(24)} v${llm.version}${def}  models: ${models}`);
      }
    }

    console.log('');
    console.log('Memory drivers:');
    console.log('-'.repeat(80));

    if (manifest.memory.length === 0) {
      console.log('  (no memory drivers registered)');
    } else {
      for (const mem of manifest.memory) {
        const def = mem.isDefault ? ' (default)' : '';
        console.log(`  ${mem.name.padEnd(24)} v${mem.version}${def}`);
      }
    }

    console.log('');
    console.log(`${totalTools} tool(s) across ${manifest.tools.length} driver(s)`);

    await kernel.shutdown();
    return 0;
  } catch (err) {
    await kernel.shutdown();
    throw err;
  }
}
