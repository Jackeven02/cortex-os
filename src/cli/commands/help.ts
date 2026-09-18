/**
 * cortex CLI — `cortex help`
 *
 * Prints the top-level usage.
 *
 * @module cli/commands/help
 */

import { KERNEL_ABI_VERSION, VERSION } from '../../index.js';

export function cmdHelp(): void {
  console.log(`cortex v${VERSION} (ABI ${KERNEL_ABI_VERSION}) — an operating system for AI agents

USAGE
  cortex <command> [options]

COMMANDS
  spawn        Start an agent as a background process
  ps           List processes with state, tokens, age
  kill         Send a signal to a process
  trace        strace-style syscall log
  checkpoint   Snapshot a process to disk
  restore      Restore a process from a checkpoint
  fork         Clone a running process at its current state
  diff         Compare two forked branches' syscall logs
  attach       Follow a process's syscall stream (tail -f on .crec)
  send         Send an IPC message to a process or channel
  limit        Set or show resource budgets per process
  audit        Surface tools untagged for reversibility
  daemon       Register/run long-lived supervised agents (install/list/uninstall/run)
  help         Show this help

GLOBAL OPTIONS
  -h, --help     Show command-specific help
  -v, --version  Print cortex version

EXAMPLES
  cortex spawn --role coder --task "fix issue #42"
  cortex ps
  cortex kill 1234 --signal SIGTERM
  cortex trace 1234
  cortex checkpoint 1234 --tag "before risky edit"
  cortex restore --tag "before risky edit"
  cortex fork 1234
  cortex diff 1234 1240
  cortex attach 1234
  cortex limit 1234 --tokens 10000
  cortex audit

ENVIRONMENT
  CORTEX_HOME          Kernel state directory (default: ./.cortex)
  DEEPSEEK_API_KEY     If set, the deepseek LLM driver is registered
  OPENAI_API_KEY       If set, the openai LLM driver is registered
  CORTEX_MCP_COMMAND   Mount an MCP server as a tool namespace, e.g. npx
  CORTEX_MCP_ARGS      Whitespace-separated args for that server
  CORTEX_MCP_NAMESPACE Tool-name prefix for MCP tools (default: mcp)

DOCUMENTATION
  MANIFESTO.md         Why cortex exists
  docs/STATE.md        Agent state, fork, checkpoint semantics
  docs/PROCESS.md      Agent lifecycle
  docs/ABI.md          The syscall contract
  docs/ARCHITECTURE.md Kernel modules and data flow
  BACKLOG.md           First issues, prioritized
`);
}
