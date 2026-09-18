/**
 * cortex CLI — `cortex daemon`
 *
 * BACKLOG #039: *"register a long-running agent to start on boot."*
 *
 * v0 shape (honest given the short-lived CLI model): `cortex` is normally a
 * one-shot command, but a *daemon* is a genuinely long-lived supervised
 * process. The kernel already implements the hard part — `init` registers a
 * `DaemonSpec` and supervises it per its `RestartPolicy` (always / on-failure /
 * never) with exponential backoff and restart-storm detection
 * (docs/PROCESS.md §9, §10; `src/kernel/init.ts`). This command is a thin,
 * honest shell over that machinery:
 *
 *   install <name> ...   persist a DaemonSpec to .cortex/daemons.json and
 *                       generate an OS service unit (best-effort) so the agent
 *                       starts on boot
 *   list                show registered daemons + their restart policy
 *   uninstall <name>    remove the spec (and best-effort remove the unit)
 *   run [name]          boot a kernel, register the daemon(s), and stay alive
 *                       until SIGTERM/SIGINT (or --max-runtime-ms, for tests)
 *
 * What `install` does NOT do: it does not itself `enable` the unit (that needs
 * the operator's session / root and is OS-specific), but it writes the unit
 * file where one is expected and prints the exact `enable` command. On Windows
 * it prints an `schtasks` command instead of writing a file.
 *
 * @module cli/commands/daemon
 */

import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { platform as osPlatform } from 'node:os';
import { pathToFileURL } from 'node:url';

import {
  bootCliKernel,
  defaultKernelDir,
  ensureKernelDirs,
  unbrand,
  DEFAULT_MEMORY_REGIONS,
} from '../index.js';
import { type DaemonSpec } from '../../kernel/init.js';
import { type AgentSpec, type RestartPolicy } from '../../kernel/types.js';
import { KERNEL_ABI_VERSION } from '../../index.js';
import {
  listDaemons,
  readDaemon,
  writeDaemon,
  deleteDaemon,
} from '../daemon_store.js';

// =============================================================================
// Subcommand dispatch
// =============================================================================

export async function cmdDaemon(args: string[]): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'install':
      return await cmdDaemonInstall(rest);
    case 'list':
      return await cmdDaemonList(rest);
    case 'uninstall':
    case 'remove':
      return await cmdDaemonUninstall(rest);
    case 'run':
    case 'start':
      return await cmdDaemonRun(rest);
    case undefined:
    case '--help':
    case '-h':
      printDaemonHelp();
      return sub === undefined ? 0 : 1;
    default:
      console.error(`cortex daemon: unknown subcommand '${sub}'`);
      printDaemonHelp();
      return 1;
  }
}

// =============================================================================
// install
// =============================================================================

export async function cmdDaemonInstall(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      role: { type: 'string' },
      task: { type: 'string' },
      system: { type: 'string' },
      module: { type: 'string' },
      driver: { type: 'string' },
      model: { type: 'string' },
      'max-tokens': { type: 'string' },
      'token-budget': { type: 'string' },
      restart: { type: 'string', default: 'never' },
      'max-restarts': { type: 'string' },
      'backoff-ms': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    printDaemonInstallHelp();
    return 0;
  }

  const name = positionals[0];
  if (name === undefined || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    console.error('cortex daemon install: <name> is required and must match [a-zA-Z0-9_-]+');
    console.error('run `cortex daemon install --help` for usage.');
    return 1;
  }
  if (values.role === undefined) {
    console.error('cortex daemon install: --role is required');
    return 1;
  }

  const restartKind = values.restart;
  if (restartKind !== 'always' && restartKind !== 'on-failure' && restartKind !== 'never') {
    console.error(`cortex daemon install: --restart must be always|on-failure|never, got '${restartKind}'`);
    return 1;
  }

  let maxRestarts: number | undefined;
  if (values['max-restarts'] !== undefined) {
    maxRestarts = parseInt(values['max-restarts'], 10);
    if (!Number.isFinite(maxRestarts) || maxRestarts < 0) {
      console.error(`cortex daemon install: invalid --max-restarts: '${values['max-restarts']}'`);
      return 1;
    }
  }

  let backoffMs: number | undefined;
  if (values['backoff-ms'] !== undefined) {
    backoffMs = parseInt(values['backoff-ms'], 10);
    if (!Number.isFinite(backoffMs) || backoffMs < 0) {
      console.error(`cortex daemon install: invalid --backoff-ms: '${values['backoff-ms']}'`);
      return 1;
    }
  }

  const system = values.system ?? `You are a ${values.role}. Your task: ${values.task ?? '(no task specified)'}`;
  const agentSpec: AgentSpec =
    values.module !== undefined
      ? { module: pathToFileURL(resolve(values.module)).href }
      : {
          system,
          ...(values.driver !== undefined ? { driver: values.driver } : {}),
          ...(values.model !== undefined ? { model: values.model } : {}),
          ...(values['max-tokens'] !== undefined ? { maxTokens: parseInt(values['max-tokens'], 10) } : {}),
        };

  const restart: RestartPolicy = {
    kind: restartKind,
    ...(maxRestarts !== undefined ? { maxRestarts } : {}),
    ...(backoffMs !== undefined ? { backoffMs } : {}),
  };

  const spec: DaemonSpec = {
    role: values.role,
    agent: agentSpec,
    restart,
    memory: DEFAULT_MEMORY_REGIONS,
    ...(values['token-budget'] !== undefined
      ? { budgets: { tokens: parseInt(values['token-budget'], 10) } }
      : {}),
  };

  const dir = defaultKernelDir();
  ensureKernelDirs(dir);
  writeDaemon(dir, {
    name,
    spec,
    installedAt: new Date().toISOString(),
    unitPlatform: osPlatform(),
  });

  console.log(`[daemon ${name}] installed (role=${values.role}, restart=${restartKind}${maxRestarts !== undefined ? `, max-restarts=${maxRestarts}` : ''})`);
  console.log(`  spec persisted at ${join(dir, 'daemons.json')}`);

  // Generate + (best-effort) install the OS service unit.
  const home = process.env['CORTEX_HOME'] ?? join(process.cwd(), '.cortex');
  const invocation = cortexInvocation();
  emitServiceUnit(name, invocation, home, restartKind);
  return 0;
}

// =============================================================================
// list
// =============================================================================

export async function cmdDaemonList(_args: string[]): Promise<number> {
  const dir = defaultKernelDir();
  const daemons = listDaemons(dir);
  if (daemons.length === 0) {
    console.log('no registered daemons (use `cortex daemon install <name> ...`)');
    return 0;
  }
  console.log('NAME                ROLE                RESTART     AGENT');
  console.log('-'.repeat(72));
  for (const d of daemons) {
    const agent = d.spec.agent;
    const agentDesc = 'module' in agent
      ? `module:${agent.module.replace(/^file:\/\//, '')}`
      : `system:${(agent.system ?? '').slice(0, 24)}${(agent.system ?? '').length > 24 ? '…' : ''}`;
    console.log(
      `${d.name.padEnd(19)} ${d.spec.role.padEnd(19)} ${(d.spec.restart?.kind ?? 'never').padEnd(11)} ${agentDesc}`,
    );
  }
  return 0;
}

// =============================================================================
// uninstall
// =============================================================================

export async function cmdDaemonUninstall(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    printDaemonUninstallHelp();
    return 0;
  }

  const name = positionals[0];
  if (name === undefined || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    console.error('cortex daemon uninstall: <name> is required and must match [a-zA-Z0-9_-]+');
    return 1;
  }

  const dir = defaultKernelDir();
  const removed = deleteDaemon(dir, name);
  if (!removed) {
    console.error(`cortex daemon uninstall: no daemon registered as '${name}'`);
    return 1;
  }
  console.log(`[daemon ${name}] unregistered`);

  // Best-effort remove the generated unit file.
  const unit = unitPathFor(osPlatform(), name, dir);
  if (unit !== undefined && existsSync(unit)) {
    try {
      unlinkSync(unit);
      console.log(`  removed unit: ${unit}`);
    } catch (err) {
      console.error(`  could not remove unit ${unit}: ${(err as Error).message}`);
    }
  }
  return 0;
}

// =============================================================================
// run
// =============================================================================

export async function cmdDaemonRun(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      'max-runtime-ms': { type: 'string', default: '0' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    printDaemonRunHelp();
    return 0;
  }

  const name = positionals[0];
  const maxRuntimeMs =
    typeof values['max-runtime-ms'] === 'string' && values['max-runtime-ms']!.trim().length > 0
      ? parseInt(values['max-runtime-ms']!, 10) || 0
      : 0;

  const dir = defaultKernelDir();
  ensureKernelDirs(dir);

  const targets = name !== undefined
    ? [readDaemon(dir, name)]
    : listDaemons(dir);

  if (name !== undefined && targets[0] === undefined) {
    console.error(`cortex daemon run: no daemon registered as '${name}'`);
    return 1;
  }
  if (targets.length === 0) {
    console.log('no registered daemons to run (use `cortex daemon install <name> ...`)');
    return 0;
  }

  const kernel = await bootCliKernel(dir);
  try {
    for (const d of targets) {
      if (d === undefined) continue;
      const pid = await kernel.registerDaemon(d.spec);
      console.log(`[daemon ${d.name} pid ${unbrand(pid)}] running (restart=${d.spec.restart?.kind ?? 'never'})`);
    }

    await waitForStop(maxRuntimeMs);

    console.log('# daemon stop requested');
    return 0;
  } finally {
    console.log('# shutting down kernel');
    await kernel.shutdown();
  }
}

// =============================================================================
// OS service-unit generation
// =============================================================================

/**
 * The command that re-invokes cortex for the service unit. In a dev checkout
 * this is `<node> <absolute entry>`; on an installed box it is whatever the
 * operator's `cortex` binary resolves to (they may edit the generated unit).
 */
function cortexInvocation(): string {
  const entry = process.argv[1] ?? '';
  if (entry.length === 0) return 'cortex';
  return `${process.execPath} ${resolve(entry)}`;
}

interface ServiceUnit {
  readonly path: string;
  readonly contents: string;
}

/**
 * Where the unit file is generated. We write it under `CORTEX_HOME/units/`
 * rather than the OS system dir: it keeps `install` side-effect-free and
 * testable (no touching `~/.config/systemd/user` or LaunchAgents), and the
 * operator still enables it by absolute path. Windows has no file — it gets
 * an `schtasks` command instead.
 */
function unitPathFor(platform: NodeJS.Platform, name: string, cortexHome: string): string | undefined {
  if (platform === 'linux') {
    return join(cortexHome, 'units', `cortex-${name}.service`);
  }
  if (platform === 'darwin') {
    return join(cortexHome, 'units', `sh.cortex.daemon.${name}.plist`);
  }
  return undefined;
}

function generateServiceUnit(platform: NodeJS.Platform, name: string, invocation: string, cortexHome: string, restart: RestartPolicy['kind']): ServiceUnit {
  const path = unitPathFor(platform, name, cortexHome);
  if (path === undefined) {
    throw new Error('windows units are emitted as an schtasks command, not a file');
  }
  if (platform === 'linux') {
    const systemdRestart = restart === 'always' ? 'always' : restart === 'on-failure' ? 'on-failure' : 'no';
    const contents = `[Unit]
Description=Cortex daemon: ${name}
After=network.target

[Service]
Type=simple
Environment=CORTEX_HOME=${cortexHome}
ExecStart=${invocation} daemon run ${name}
Restart=${systemdRestart}
RestartSec=2

[Install]
WantedBy=default.target
`;
    return { path, contents };
  }
  // darwin (launchd)
  const argv = invocation.split(/\s+/).concat(['daemon', 'run', name]);
  const programArgs = argv.map((a) => `    <string>${a}</string>`).join('\n');
  const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.cortex.daemon.${name}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CORTEX_HOME</key>
    <string>${cortexHome}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
  return { path, contents };
}

/**
 * Generate the platform unit and either write it (linux/darwin) or print the
 * equivalent `schtasks` command (windows). Enabling is left to the operator —
 * it needs their session/root and is OS-specific — but we print the exact
 * command.
 */
function emitServiceUnit(name: string, invocation: string, cortexHome: string, restart: RestartPolicy['kind']): void {
  const platform = osPlatform();
  if (platform === 'win32') {
    const tr = `${invocation} daemon run ${name}`;
    console.log('  (windows) install on logon with:');
    console.log(`    schtasks /Create /TN "cortex-${name}" /TR "${tr}" /SC ONLOGON /F`);
    return;
  }

  try {
    const unit = generateServiceUnit(platform, name, invocation, cortexHome, restart);
    mkdirSync(dirnameOf(unit.path), { recursive: true });
    writeFileSync(unit.path, unit.contents, 'utf8');
    console.log(`  unit written: ${unit.path}`);
    console.log(`  enable on boot: ${enableCommand(platform, name, unit.path)}`);
  } catch (err) {
    // Could not write (e.g. no homedir dir). Print the unit as instructions.
    console.error(`  could not write unit file: ${(err as Error).message}`);
    console.error('  create the following unit yourself, then enable it:');
    try {
      const unit = generateServiceUnit(platform, name, invocation, cortexHome, restart);
      for (const line of unit.contents.split('\n')) console.error(`    ${line}`);
      console.error(`  enable on boot: ${enableCommand(platform, name, unit.path)}`);
    } catch {
      /* ignore nested failure */
    }
  }
}

function enableCommand(platform: NodeJS.Platform, name: string, path: string): string {
  if (platform === 'linux') return `systemctl --user enable --now cortex-${name}.service`;
  if (platform === 'darwin') return `launchctl load "${path}"`;
  return `schtasks /Create /TN "cortex-${name}" /SC ONLOGON /F`;
}

/** Tiny dirname to avoid pulling path's dirname (shim noise on some shells). */
function dirnameOf(p: string): string {
  const i = p.lastIndexOf('/');
  const j = p.lastIndexOf('\\');
  const k = Math.max(i, j);
  return k <= 0 ? '.' : p.slice(0, k);
}

// =============================================================================
// Block until a stop signal (or optional timeout)
// =============================================================================

function waitForStop(maxRuntimeMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const onSignal = (): void => resolve();
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    if (maxRuntimeMs > 0) {
      const t = setTimeout(resolve, maxRuntimeMs);
      t.unref?.();
    }
  });
}

// =============================================================================
// Help
// =============================================================================

function printDaemonHelp(): void {
  console.log(`cortex daemon — register and run long-lived supervised agents

USAGE
  cortex daemon install <name> --role <role> [agent opts] [--restart <kind>]
  cortex daemon list
  cortex daemon uninstall <name>
  cortex daemon run [name]

SUBCOMMANDS
  install     Persist a daemon spec and generate an OS service unit
  list        Show registered daemons and their restart policy
  uninstall   Remove a daemon spec (and best-effort its unit file)
  run         Boot a kernel, register the daemon(s), stay alive until SIGTERM

The kernel supervises each daemon per its RestartPolicy (always / on-failure /
never) with exponential backoff and restart-storm detection — see
docs/PROCESS.md §9-§10. 'run' keeps the process alive; stopping it (Ctrl-C, or
--max-runtime-ms for tests) shuts the kernel down.

Run 'cortex daemon <subcommand> --help' for details.
`);
}

function printDaemonInstallHelp(): void {
  console.log(`cortex daemon install — register a long-lived agent

USAGE
  cortex daemon install <name> --role <role> [options]

OPTIONS
  --role <string>       Agent role (required)
  --task <string>       Task (becomes the system prompt)
  --system <string>     Full system prompt (overrides --task)
  --module <path>       Run a user agent module instead of the prompt agent
  --driver/--model/--max-tokens   Prompt-agent LLM options
  --token-budget <n>    Total token budget
  --restart <kind>      always | on-failure | never (default: never)
  --max-restarts <n>    Cap restarts for always/on-failure
  --backoff-ms <n>      Base restart backoff in ms (default: 1000, exponential)
  -h, --help            Show this help

EXAMPLES
  cortex daemon install watcher --role inbox-watcher --module ./examples/checkpoint-agent.ts --restart on-failure
  cortex daemon install logger --role logger --task "log everything" --restart always --max-restarts 10
`);
}

function printDaemonUninstallHelp(): void {
  console.log(`cortex daemon uninstall <name> — remove a registered daemon

EXAMPLE
  cortex daemon uninstall watcher
`);
}

function printDaemonRunHelp(): void {
  console.log(`cortex daemon run — run registered daemon(s) as a long-lived supervisor

USAGE
  cortex daemon run [name]

  With <name>: run that one daemon. Without: run every registered daemon.
  Stays alive until SIGTERM/SIGINT. For tests/headless use:

  --max-runtime-ms <n>  Auto-stop after n ms (then shut the kernel down)

EXAMPLE
  cortex daemon run watcher
  cortex daemon run --max-runtime-ms 500   # headless smoke of the supervisor
`);
}

// Re-export so tests can exercise the pure generator without a real home dir.
export { generateServiceUnit, enableCommand, unitPathFor };
