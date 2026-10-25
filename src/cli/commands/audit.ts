/**
 * cortex CLI — `cortex audit`
 *
 * BACKLOG #040: *"surface tools that are untagged for reversibility."*
 *
 * Boots a kernel just long enough to list all registered drivers and their
 * tools. This is the one command that always boots a kernel (it needs the
 * driver registry to be populated).
 *
 * The facts it prints live in `src/cli/audit_view.ts`, because the dashboard's
 * tool surface asks the same question of the same kernel — and the two views
 * must not be able to disagree about which tools exist, what tag they carry,
 * and which of them nobody ever declared. The words about an undeclared tool
 * live there too, so the terminal and the window say the same thing.
 *
 * @module cli/commands/audit
 */

import { parseArgs } from 'node:util';
import { bootCliKernel, defaultKernelDir } from '../index.js';
import {
  describeDriverSurface,
  formatDeclaration,
  formatUndeclaredSummary,
  type DriverSurface,
} from '../audit_view.js';

/**
 * Print the report for one kernel's surface.
 *
 * Separate from {@link cmdAudit} on purpose: *gathering* the facts needs a
 * kernel, but *printing* them does not — so the words can be exercised
 * against a surface with an undeclared tool in it, which is the half the
 * dashboard has to agree with.
 */
export function printDriverSurface(surface: DriverSurface): void {
  console.log('Tool drivers:');
  console.log('-'.repeat(80));

  if (surface.toolDrivers.length === 0) {
    console.log('  (no tool drivers registered)');
  } else {
    for (const driver of surface.toolDrivers) {
      console.log(`  ${driver.name} v${driver.version} (forkable=${driver.forkable}, twoPhase=${driver.twoPhase})`);
      for (const tool of driver.tools) {
        // A defaulted tag is the thing the operator has to act on, so it
        // says so on the line — with the same marker the window prints.
        const suffix = tool.declared === false ? `   <- ${formatDeclaration(tool.declared)}` : '';
        console.log(`    - ${tool.name.padEnd(30)}${tool.reversibility}${suffix}`);
      }
    }
  }

  console.log('');
  console.log('LLM drivers:');
  console.log('-'.repeat(80));

  if (surface.llmDrivers.length === 0) {
    console.log('  (no LLM drivers registered)');
  } else {
    for (const llm of surface.llmDrivers) {
      const models = llm.supportedModels.join(', ');
      const def = llm.isDefault ? ' (default)' : '';
      console.log(`  ${llm.name.padEnd(24)} v${llm.version}${def}  models: ${models}`);
    }
  }

  console.log('');
  console.log('Memory drivers:');
  console.log('-'.repeat(80));

  if (surface.memoryDrivers.length === 0) {
    console.log('  (no memory drivers registered)');
  } else {
    for (const mem of surface.memoryDrivers) {
      const def = mem.isDefault ? ' (default)' : '';
      console.log(`  ${mem.name.padEnd(24)} v${mem.version}${def}`);
    }
  }

  console.log('');
  console.log(`${surface.toolCount} tool(s) across ${surface.toolDrivers.length} driver(s)`);
  const summary = formatUndeclaredSummary(surface);
  if (summary !== null) {
    console.log(summary);
  }
}

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
    printDriverSurface(
      describeDriverSurface(
        kernel.registry.listAll(),
        (toolName) => kernel.registry.resolveTool(toolName),
      ),
    );

    await kernel.shutdown();
    return 0;
  } catch (err) {
    await kernel.shutdown();
    throw err;
  }
}
