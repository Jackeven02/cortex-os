#!/usr/bin/env node
/**
 * cortex CLI — the user-facing surface.
 *
 * BACKLOG Phase 3 (#029–#040): `cortex spawn`, `ps`, `kill`, `trace`, `fork`,
 * `checkpoint`, `restore`, `send`, `recv`, `limit`, `diff`, `audit`, `daemon`.
 *
 * v0 model: **disk as source of truth.** Each command boots a short-lived
 * in-process kernel, does its work, persists state to `.cortex/`, and exits.
 * Read-only commands (`ps`, `trace`, `audit`) read from disk directly without
 * booting a kernel. Write commands (`spawn`, `checkpoint`, `fork`, `kill`,
 * `send`, `limit`) boot a kernel, execute, persist updated `.meta.json`, exit.
 *
 * This is NOT a long-running daemon model. It cannot send signals to a
 * process that is currently executing in another kernel invocation. What it
 * CAN do:
 *   - `spawn` runs an agent to completion (or timeout), then writes its
 *     `.meta.json` and `.crec` to disk.
 *   - `ps` reads all `.meta.json` files from disk.
 *   - `trace <pid>` reads the `.crec` file from disk.
 *   - `checkpoint <pid>` boots a kernel, loads the process, snapshots it.
 *   - `restore --tag` boots a kernel, restores from `.csnap`, runs the agent.
 *   - `audit` boots a kernel just long enough to list registered drivers.
 *
 * The long-running daemon + IPC model is a future phase (see ARCHITECTURE.md
 * §12.1). For now, this matches the checkpoint-centric design: a process's
 * identity survives across invocations via its `ChainId` and on-disk state.
 *
 * @module cli
 */

import { parseArgs } from 'node:util';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { KERNEL_ABI_VERSION } from '../index.js';
import { bootKernel, type Kernel } from '../kernel/boot.js';
import { mockLLM } from '../drivers/llm/mock.js';
import { deepseekLLM } from '../drivers/llm/deepseek.js';
import { openaiLLM } from '../drivers/llm/openai.js';
import { fsTool } from '../drivers/tool/fs.js';
import { inmemMemory } from '../drivers/memory/inmem.js';
import { asProcessId, unbrand, type ProcessId, type BudgetCounters, type BudgetLimits, type AgentSpec } from '../kernel/types.js';
import { isCortexError } from '../kernel/errors.js';
import { crecPath } from '../kernel/recorder.js';
import { readAllMetas, readMeta, writeMeta, maxPidOnDisk, type ProcessMeta } from './process_store.js';

import { cmdSpawn } from './commands/spawn.js';
import { cmdPs } from './commands/ps.js';
import { cmdKill } from './commands/kill.js';
import { cmdTrace } from './commands/trace.js';
import { cmdCheckpoint } from './commands/checkpoint.js';
import { cmdRestore } from './commands/restore.js';
import { cmdFork } from './commands/fork.js';
import { cmdSend } from './commands/send.js';
import { cmdLimit } from './commands/limit.js';
import { cmdAudit } from './commands/audit.js';
import { cmdHelp } from './commands/help.js';

// =============================================================================
// CLI entry
// =============================================================================

export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2); // strip node + script path

  if (args.length === 0) {
    cmdHelp();
    return 0;
  }

  const command = args[0];
  const rest = args.slice(1);

  try {
    switch (command) {
      case 'spawn':
        return await cmdSpawn(rest);
      case 'ps':
        return await cmdPs(rest);
      case 'kill':
        return await cmdKill(rest);
      case 'trace':
        return await cmdTrace(rest);
      case 'checkpoint':
      case 'ckpt':
        return await cmdCheckpoint(rest);
      case 'restore':
        return await cmdRestore(rest);
      case 'fork':
        return await cmdFork(rest);
      case 'send':
        return await cmdSend(rest);
      case 'limit':
        return await cmdLimit(rest);
      case 'audit':
        return await cmdAudit(rest);
      case 'help':
      case '--help':
      case '-h':
        cmdHelp();
        return 0;
      case '--version':
      case '-v':
        console.log(`cortex v0.0.1 (ABI ${KERNEL_ABI_VERSION})`);
        return 0;
      default:
        console.error(`unknown command: ${command}`);
        console.error('run `cortex help` for usage.');
        return 1;
    }
  } catch (err) {
    if (isCortexError(err)) {
      console.error(`cortex: ${err.errno}: ${err.message}`);
      if (err.details !== undefined) {
        console.error(`  details: ${JSON.stringify(err.details)}`);
      }
    } else if (err instanceof Error) {
      console.error(`cortex: ${err.message}`);
    } else {
      console.error(`cortex: ${String(err)}`);
    }
    return 1;
  }
}

// =============================================================================
// Kernel helpers (shared by all commands)
// =============================================================================

/**
 * Default kernel state directory. Uses `$CORTEX_HOME` if set, otherwise
 * `.cortex/` in the current working directory.
 */
export function defaultKernelDir(): string {
  const home = process.env['CORTEX_HOME'];
  if (home !== undefined && home.length > 0) return home;
  return join(process.cwd(), '.cortex');
}

/**
 * Build the default driver-loading hook for the kernel. Registers built-in
 * LLM, tool, and memory drivers. LLM driver selection is env-driven:
 * `DEEPSEEK_API_KEY` → deepseek, `OPENAI_API_KEY` → openai, else mock.
 */
export function defaultLoadDrivers(registry: import('../kernel/driver_registry.js').DriverRegistry): Promise<void> {
  if (process.env['DEEPSEEK_API_KEY'] !== undefined) {
    registry.registerLLM(deepseekLLM());
  }
  if (process.env['OPENAI_API_KEY'] !== undefined) {
    registry.registerLLM(openaiLLM());
  }
  // Always register the mock so tests and `--driver mock` work.
  registry.registerLLM(mockLLM());

  // Tool: filesystem.
  registry.registerTool(fsTool({ root: process.cwd() }));

  // Memory: inmem for v0 (sqlite is available but experimental).
  registry.registerMemory(inmemMemory());

  return Promise.resolve();
}

/**
 * Determine the default LLM driver name from environment.
 */
export function defaultLLMName(): string {
  return process.env['DEEPSEEK_API_KEY'] !== undefined
    ? 'deepseek'
    : process.env['OPENAI_API_KEY'] !== undefined
      ? 'openai'
      : 'mock';
}

/**
 * Ensure the kernel state directories exist before boot — the recorder opens
 * `<dir>/processes/<pid>.crec` and will trap ERECORD if the directory is
 * missing.
 */
export function ensureKernelDirs(dir: string): void {
  try {
    mkdirSync(join(dir, 'processes'), { recursive: true });
    mkdirSync(join(dir, 'checkpoints'), { recursive: true });
  } catch {
    // Best-effort; boot will trap if truly inaccessible.
  }
}

/**
 * Boot a kernel with default settings for CLI use. The caller is responsible
 * for shutting it down.
 */
export async function bootCliKernel(dir: string): Promise<Kernel> {
  ensureKernelDirs(dir);
  return bootKernel({
    kernelAbiVersion: KERNEL_ABI_VERSION,
    dir,
    loadDrivers: defaultLoadDrivers,
    defaultLLM: defaultLLMName(),
    defaultMemory: 'inmem',
    autoStart: true,
  });
}

/**
 * Parse a PID from a string. Throws a user-friendly error if invalid.
 */
export function parsePid(s: string): ProcessId {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`invalid PID: '${s}' (expected a non-negative integer)`);
  }
  return asProcessId(n);
}

// =============================================================================
// Re-exports for command modules
// =============================================================================

export { unbrand, asProcessId };
export { readAllMetas, readMeta, writeMeta, maxPidOnDisk, type ProcessMeta };
export { crecPath };

// =============================================================================
// Module entry
// =============================================================================

// Check if this is the main module. Use a robust check that works across
// node, tsx, and Windows/Unix path separators.
const entryUrl = pathToFileURL(process.argv[1] ?? '').href;
const isMain = import.meta.url === entryUrl
  || import.meta.url.endsWith('cli/index.js')
  || import.meta.url.endsWith('cli/index.ts');

if (isMain) {
  main(process.argv).then((code) => {
    process.exit(code);
  });
}
