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
import { mcpTool } from '../drivers/tool/mcp.js';
import { inmemMemory } from '../drivers/memory/inmem.js';
import { asProcessId, unbrand, type ProcessId, type BudgetCounters, type BudgetLimits, type AgentSpec, type MemoryRegionPolicy } from '../kernel/types.js';
import { isCortexError } from '../kernel/errors.js';
import { crecPath } from '../kernel/recorder.js';
import { readAllMetas, readMeta, writeMeta, maxPidOnDisk, readExitRecord, type ProcessMeta } from './process_store.js';

import { cmdSpawn } from './commands/spawn.js';
import { cmdPs } from './commands/ps.js';
import { cmdKill } from './commands/kill.js';
import { cmdTrace } from './commands/trace.js';
import { cmdAttach } from './commands/attach.js';
import { cmdCheckpoint } from './commands/checkpoint.js';
import { cmdRestore } from './commands/restore.js';
import { cmdFork } from './commands/fork.js';
import { cmdDiff } from './commands/diff.js';
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
      case 'attach':
        return await cmdAttach(rest);
      case 'checkpoint':
      case 'ckpt':
        return await cmdCheckpoint(rest);
      case 'restore':
        return await cmdRestore(rest);
      case 'fork':
        return await cmdFork(rest);
      case 'diff':
        return await cmdDiff(rest);
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
 * Environment variables that mount an MCP server as a tool namespace (#025).
 *
 *   CORTEX_MCP_COMMAND    the server executable, e.g. `npx`
 *   CORTEX_MCP_ARGS       whitespace-separated arguments, e.g. `-y @modelcontextprotocol/server-filesystem .`
 *   CORTEX_MCP_NAMESPACE  tool-name prefix; default `mcp`
 *
 * Opt-in, not on by default: a kernel that spawns subprocesses the operator
 * did not ask for is not a kernel you want running on your laptop.
 */
export const MCP_ENV = {
  command: 'CORTEX_MCP_COMMAND',
  args: 'CORTEX_MCP_ARGS',
  namespace: 'CORTEX_MCP_NAMESPACE',
} as const;

/**
 * Build the default driver-loading hook for the kernel. Registers built-in
 * LLM, tool, and memory drivers. LLM driver selection is env-driven:
 * `DEEPSEEK_API_KEY` → deepseek, `OPENAI_API_KEY` → openai, else mock.
 *
 * MCP is opt-in via `CORTEX_MCP_COMMAND` (see `MCP_ENV`).
 */
export async function defaultLoadDrivers(registry: import('../kernel/driver_registry.js').DriverRegistry): Promise<void> {
  if (process.env['DEEPSEEK_API_KEY'] !== undefined) {
    registry.registerLLM(deepseekLLM());
  }
  if (process.env['OPENAI_API_KEY'] !== undefined) {
    registry.registerLLM(openaiLLM());
  }
  // Always register the mock so tests and `--driver mock` work.
  registry.registerLLM(mockLLM());

  // Tool: filesystem.
  await registry.registerTool(fsTool({ root: process.cwd() }));

  // Tool: MCP (#025). Mount the configured server under a namespace.
  const mcpCommand = process.env[MCP_ENV.command];
  if (mcpCommand !== undefined && mcpCommand.trim().length > 0) {
    const args = (process.env[MCP_ENV.args] ?? '')
      .split(/\s+/)
      .filter((s) => s.length > 0);
    const namespace = process.env[MCP_ENV.namespace] ?? 'mcp';
    try {
      await registry.registerTool(
        mcpTool({ name: 'mcp', namespace, command: mcpCommand.trim(), args }),
      );
    } catch (err) {
      // A dead MCP server must not brick unrelated commands (`ps`, `trace`).
      // Warn and continue without it — the driver has already closed its own
      // subprocess by this point.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `cortex: warning: MCP server '${mcpCommand}' did not start: ${msg}\n` +
          `cortex: continuing without MCP tools.\n`,
      );
    }
  }

  // Memory: inmem for v0 (sqlite is available but experimental).
  registry.registerMemory(inmemMemory());
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
/** Memory driver every CLI-spawned region is backed by. */
export const DEFAULT_MEMORY_BACKING = 'inmem';

/**
 * The three standard memory regions every spawned/restored agent gets, with
 * their documented default copy semantics (docs/STATE.md §2.3): episodic=cow,
 * semantic=shared, procedural=private. Shared by `spawn` (declares them on the
 * new process) and by the disk-backed `restoreContext` below (re-declares them
 * on a restored process so memory_write does not trap ENOENT/EDRIVER).
 */
export const DEFAULT_MEMORY_REGIONS: Readonly<Record<string, MemoryRegionPolicy>> = {
  episodic: { kind: 'cow', backing: DEFAULT_MEMORY_BACKING },
  semantic: { kind: 'shared', backing: DEFAULT_MEMORY_BACKING },
  procedural: { kind: 'private', backing: DEFAULT_MEMORY_BACKING },
};

export async function bootCliKernel(dir: string): Promise<Kernel> {
  ensureKernelDirs(dir);
  const kernel = await bootKernel({
    kernelAbiVersion: KERNEL_ABI_VERSION,
    dir,
    loadDrivers: defaultLoadDrivers,
    defaultLLM: defaultLLMName(),
    defaultMemory: DEFAULT_MEMORY_BACKING,
    defaultMemoryBacking: DEFAULT_MEMORY_BACKING,
    autoStart: true,
    // The kernel's default restoreContext reads an in-memory per-PID map that
    // is empty in a fresh CLI invocation, so cross-invocation `cortex restore`
    // would trap EINVAL ("no agent metadata"). The `.csnap` body deliberately
    // does not carry role/agent — but the CLI persists them in <pid>.meta.json.
    // Rebuild the RestoreContext from disk, keyed on the checkpoint's pid.
    restoreContext: (cp) => {
      const meta = readMeta(dir, cp.pid);
      if (meta === undefined) {
        throw new Error(
          `cortex restore: no on-disk meta for pid ${unbrand(cp.pid)} — ` +
          `cannot rebuild the agent spec (was it spawned in this cortex home?)`,
        );
      }
      return {
        role: meta.role,
        agent: meta.agent,
        memory: DEFAULT_MEMORY_REGIONS,
        ppid: cp.parentPid,
      };
    },
  });
  // Seed the PID counter past anything already persisted, so this invocation
  // never reuses a PID (which would collide on <pid>.crec / <pid>.meta.json —
  // most visibly when `restore` re-mints the suspended original's PID).
  kernel.table.advancePidCounterTo(maxPidOnDisk(dir) + 1);
  return kernel;
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
export { readAllMetas, readMeta, writeMeta, maxPidOnDisk, readExitRecord, type ProcessMeta };
export { crecPath };

// =============================================================================
// Module entry
// =============================================================================

// Check if this is the main module. pathToFileURL() normalizes Windows
// backslashes to forward slashes, so entryUrl is isomorphic to import.meta.url
// and a strict === comparison is reliable. Do NOT add endsWith() fallbacks:
// they match this module's own URL unconditionally, which would auto-run
// main() + process.exit() whenever cli/index.ts is imported as a library
// (e.g. by the smoke suite or a future daemon).
const entryUrl = pathToFileURL(process.argv[1] ?? '').href;
const isMain = import.meta.url === entryUrl;

if (isMain) {
  main(process.argv).then((code) => {
    process.exit(code);
  });
}
