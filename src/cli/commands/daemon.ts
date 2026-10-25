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
 * ## `run` is also the kernel's transport endpoint
 *
 * `run` is the one command whose kernel stays alive, so it is the one command
 * that can be *reached*. While it runs, the kernel serves a loopback control
 * port and publishes its endpoint in `<CORTEX_HOME>/kernel.json`
 * (docs/ARCHITECTURE.md §12.1). That is what turns `cortex send` from a
 * recording into a delivery: the message lands in a live agent's inbox
 * instead of in a kernel that exits a millisecond later. The transport is
 * implemented in `cli/kernel_server.ts` + `cli/kernel_client.ts` and never
 * touches the kernel's internals — it calls the same dispatcher an agent
 * calls.
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

import { resolveModule } from '../../module_spec.js';

import {
  bootCliKernel,
  defaultKernelDir,
  ensureKernelDirs,
  unbrand,
  DEFAULT_MEMORY_REGIONS,
} from '../index.js';
import { parseMemoryArg, mergeRegionPolicies, MemoryArgError } from '../regions.js';
import { formatOutcomeCode } from '../process_outcome.js';
import { agentOf, type DaemonSpec, type DaemonState } from '../../kernel/init.js';
import {
  describeDaemonDetails,
  describeDaemonNote,
  describeDaemonStatus,
  formatDaemonAgent,
  formatDaemonExit,
  formatDaemonPolicy,
  formatDaemonSummary,
  joinDaemons,
  readDaemonDecisions,
  type DaemonReceipt,
} from '../daemon_view.js';
import { type AgentSpec, type RestartPolicy, type MemoryRegionPolicy } from '../../kernel/types.js';
import { KERNEL_ABI_VERSION } from '../../index.js';
import {
  listDaemons,
  readDaemon,
  writeDaemon,
  deleteDaemon,
} from '../daemon_store.js';
import { startKernelServer } from '../kernel_server.js';
import { KernelCommandError, probeKernel } from '../kernel_client.js';
import { clearEndpoint, endpointPath, writeEndpoint } from '../kernel_endpoint.js';
import { renderHeader, renderRow, ruleUnder, sizeColumns } from '../table.js';

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
    case 'stop':
      return await cmdDaemonStop(rest);
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
      memory: { type: 'string' },
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

  // A daemon spec persists the module's specifier, and the daemon runs it
  // later — possibly after a reboot, possibly by a different user account. A
  // *path* that does not exist now will not exist then either, so refuse it
  // here rather than registering a daemon that can only ever fail. A package
  // name is not a path: `import()` resolves it when the daemon runs, and it
  // may well be installed by then.
  let moduleSpecifier: string | undefined;
  if (values.module !== undefined) {
    const resolved = resolveModule(values.module, process.cwd());
    if (resolved.isPath && resolved.path !== null && !existsSync(resolved.path)) {
      console.error(`cortex daemon install: --module '${values.module}' does not exist`);
      console.error(`(looked for ${resolved.path})`);
      console.error(
        `if you meant one of the bundled examples, use its name -- e.g. ./examples/checkpoint-agent.ts`,
      );
      return 1;
    }
    moduleSpecifier = resolved.specifier;
  }

  const agentSpec: AgentSpec =
    moduleSpecifier !== undefined
      ? { module: moduleSpecifier }
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

  let regionPolicies: Record<string, MemoryRegionPolicy> = DEFAULT_MEMORY_REGIONS;
  if (values.memory !== undefined) {
    let overrides: Record<string, MemoryRegionPolicy>;
    try {
      overrides = parseMemoryArg(values.memory);
    } catch (err) {
      if (err instanceof MemoryArgError) {
        console.error(`cortex daemon install: invalid --memory: ${err.message}`);
        return 1;
      }
      throw err;
    }
    regionPolicies = mergeRegionPolicies(DEFAULT_MEMORY_REGIONS, overrides);
  }

  const spec: DaemonSpec = {
    role: values.role,
    agent: agentSpec,
    restart,
    memory: regionPolicies,
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
  const receipts: DaemonReceipt[] = listDaemons(dir).map((d) => ({
    name: d.name,
    role: d.spec.role,
    restart: d.spec.restart?.kind ?? 'never',
    maxRestarts: d.spec.restart?.maxRestarts ?? null,
    agent: agentOf(d.spec.agent),
  }));
  if (receipts.length === 0) {
    console.log('no registered daemons (use `cortex daemon install <name> ...`)');
    return 0;
  }

  // The kernel is the only one who knows whether a daemon is running.
  //
  // The list above is the *install receipt* — it says the daemon was written
  // down. It used to be the whole answer, and it read like the truth: an
  // operator could not tell a running daemon from a flapping one, from one the
  // supervisor had already given up on, or from one that was never started.
  // So the kernel is asked what it is actually doing with them.
  const probe = await probeKernel(dir);
  const client = probe.kind === 'live' ? probe.client : undefined;
  let live: DaemonState[] | null = null;
  try {
    if (client !== undefined) {
      const reply = (await client.request('daemons')) as { daemons?: DaemonState[] };
      live = reply.daemons ?? [];
    }
  } catch (err) {
    // A kernel that cannot answer is a kernel that cannot say — and the
    // honest answer to "is it running?" is then *unknown*, not "no".
    console.error(
      `cortex daemon list: the live kernel did not answer (${err instanceof Error ? err.message : String(err)}); ` +
        `the live state of the daemons is unknown`,
    );
  } finally {
    client?.close();
  }

  const rows = joinDaemons(receipts, live);
  const cells = rows.map((row) => [
    row.name ?? '(unnamed)',
    row.role,
    describeDaemonStatus(row.status).label,
    row.pid === null ? '—' : String(row.pid),
    row.restarts === null ? '—' : String(row.restarts),
    formatDaemonExit(row.lastExitCode, row.lastExitReason) || '—',
    formatDaemonPolicy(row.restart, row.maxRestarts),
    formatDaemonAgent(row.agent),
  ]);
  const columns = sizeColumns(
    [
      { header: 'NAME', max: 20, gap: 2 },
      { header: 'ROLE', max: 20, gap: 2 },
      { header: 'STATE', max: 18, gap: 2 },
      { header: 'PID', max: 6, gap: 2 },
      { header: 'RESTARTS', max: 8, gap: 2 },
      { header: 'LAST EXIT', max: 28, gap: 2 },
      { header: 'RESTART', max: 18, gap: 2 },
      { header: 'AGENT', max: 28, gap: 2 },
    ],
    cells,
  );
  const header = renderHeader(columns);
  console.log(header);
  console.log(ruleUnder(header));
  for (const row of cells) {
    console.log(renderRow(columns, row));
  }
  console.log('');
  console.log(formatDaemonSummary(rows));
  // The notes, one line per **reason** — not per row. Two daemons with the
  // same reason (no kernel to ask) have one thing to say, and repeating the
  // same sentence under every row is noise that hides the rows that differ.
  const notes = new Map<string, string[]>();
  for (const row of rows) {
    const note = describeDaemonNote(row);
    if (note === null) continue;
    const bucket = notes.get(note);
    if (bucket === undefined) notes.set(note, [row.name ?? '(unnamed)']);
    else bucket.push(row.name ?? '(unnamed)');
  }
  for (const [note, names] of notes) {
    console.log(`  ${names.join(', ')}: ${note}`);
  }

  // The supervisor's own record of these daemons — the **journal** beside the
  // live state.
  //
  // The two answer different questions ("now" and "what was decided"), so they
  // are allowed to differ. What they are not allowed to do is differ
  // silently: a give-up the kernel remembers and the journal never recorded
  // is a decision nobody can read back.
  const journal = await readDaemonDecisions(dir);
  const details = describeDaemonDetails(rows, live, journal);
  const journalLines = details
    .filter((detail) => detail.decision !== null || detail.disagreement !== null)
    .map((detail) =>
      detail.disagreement !== null
        ? `  ${detail.who}: ${detail.disagreement}`
        : `  ${detail.who}: ${detail.decision}`,
    );
  if (journalLines.length > 0) {
    console.log('');
    console.log('supervisor decisions (the journal):');
    for (const line of journalLines) console.log(line);
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
      'max-region-entries': { type: 'string' },
      port: { type: 'string' },
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

  let maxRegionEntries: number | undefined;
  if (values['max-region-entries'] !== undefined) {
    const parsed = parseInt(values['max-region-entries'], 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(
        `cortex daemon run: invalid --max-region-entries: '${values['max-region-entries']}' ` +
        `(expected a positive integer; omit the flag for unlimited)`,
      );
      return 1;
    }
    maxRegionEntries = parsed;
  }

  let port: number | undefined;
  if (values.port !== undefined) {
    const parsed = parseInt(values.port, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
      console.error(
        `cortex daemon run: invalid --port: '${values.port}' ` +
        `(expected 0 for an ephemeral port, or 1-65535)`,
      );
      return 1;
    }
    port = parsed;
  }

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

  // The supervisor's decisions, printed as they are made.
  //
  // A daemon's stdout is its log — systemd's journal and launchd's log
  // collect it — so whatever the supervisor does has to be *there*. It used
  // to be nowhere: a daemon that crashed three times and was given up on
  // printed "running" and nothing else, and the terminal said so while the
  // agent was dead and never coming back.
  //
  // The daemon's name is known only after it is registered, so the map is
  // filled in below; the decisions themselves come later.
  const daemonNames = new Map<number, string>();
  const kernel = await bootCliKernel(dir, {
    ...(maxRegionEntries !== undefined ? { maxRegionEntries } : {}),
    onDaemonDecision: (decision) => {
      const name = daemonNames.get(decision.daemonId) ?? decision.role;
      const ended = `attempt ${decision.attempt} exited (code ${formatOutcomeCode(decision.previousExitCode)}: ${decision.previousExitReason})`;
      if (decision.kind === 'restart') {
        console.log(
          `[daemon ${name}] ${ended} — restarting as pid ${decision.pid} (attempt ${decision.attempt + 1})`,
        );
      } else {
        console.log(`[daemon ${name}] ${ended} — not restarting: ${decision.detail}`);
      }
    },
  });

  // The kernel is the only thing in the process that lives long enough to be
  // worth reaching into, so this is where the transport is published: the
  // endpoint descriptor goes next to the logs it protects, and every later
  // `cortex send` / `cortex kill` / `cortex attach --interactive` finds the
  // live kernel through it (docs/ARCHITECTURE.md §12.1).
  const stop = createStopSignal(maxRuntimeMs);
  const server = await startKernelServer(kernel, {
    ...(port !== undefined ? { port } : {}),
    onShutdown: () => stop.request(),
  });
  writeEndpoint(dir, server.endpoint);
  console.log(
    `[kernel] serving on ${server.endpoint.host}:${server.endpoint.port} (pid ${server.endpoint.pid})`,
  );
  console.log(`  endpoint published at ${endpointPath(dir)}`);
  console.log(`  other cortex invocations in this directory can now reach it`);

  try {
    for (const d of targets) {
      if (d === undefined) continue;
      // The name goes with the registration: it is the operator's name for
      // this daemon, and it is the **join key** between the registry and the
      // kernel (the role is not an identity — two daemons may share one).
      // Without it, the kernel could say "a daemon with role X died" and the
      // operator could not work out which of their daemons that was.
      const pid = await kernel.registerDaemon({ ...d.spec, name: d.name });
      daemonNames.set(unbrand(pid), d.name);
      console.log(`[daemon ${d.name} pid ${unbrand(pid)}] running (restart=${d.spec.restart?.kind ?? 'never'})`);
    }

    await stop.promise;

    console.log('# daemon stop requested');
    return 0;
  } finally {
    console.log('# shutting down kernel');
    await server.close();
    clearEndpoint(dir, server.endpoint);
    await kernel.shutdown();
  }
}

// =============================================================================
// stop
// =============================================================================

/**
 * Ask the running daemon to stop.
 *
 * The kernel serves a `shutdown` command; this is the CLI entry point for
 * it. The daemon answers the request first and stops afterwards, so the
 * reply is not lost to a closing socket.
 */
export async function cmdDaemonStop(_args: string[]): Promise<number> {
  const dir = defaultKernelDir();
  const probe = await probeKernel(dir);
  if (probe.kind === 'live') {
    const client = probe.client;
    try {
      await client.request('shutdown');
      console.log('daemon stop requested');
      return 0;
    } catch (err) {
      if (err instanceof KernelCommandError) {
        console.error(`cortex daemon stop: ${err.errno}: ${err.message}`);
        return 1;
      }
      throw err;
    } finally {
      client.close();
    }
  }

  if (probe.kind === 'stale') {
    console.error(
      `cortex daemon stop: the kernel that published ${probe.endpoint.host}:${probe.endpoint.port} ` +
      `is not reachable (${probe.reason})`,
    );
  }
  console.error('cortex daemon stop: no daemon is running in this directory.');
  return 1;
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

/**
 * The signal the daemon waits on before it shuts the kernel down.
 *
 * Three things can raise it: SIGINT / SIGTERM (the operator's Ctrl-C), the
 * `--max-runtime-ms` timeout (headless and test use), and a client of the
 * loopback transport asking the kernel to stop.
 */
interface StopSignal {
  /** Resolves when the daemon should stop. */
  readonly promise: Promise<void>;
  /** Raise the stop signal. Idempotent. */
  request(): void;
}

function createStopSignal(maxRuntimeMs = 0): StopSignal {
  let settle: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const onSignal = (): void => settle();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  if (maxRuntimeMs > 0) {
    const timer = setTimeout(settle, maxRuntimeMs);
    // Don't let the timer keep the event loop alive on its own.
    timer.unref?.();
  }

  return { promise, request: settle };
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
  cortex daemon stop

SUBCOMMANDS
  install     Persist a daemon spec and generate an OS service unit
  list        Show registered daemons and their restart policy
  uninstall   Remove a daemon spec (and best-effort its unit file)
  run         Boot a kernel, register the daemon(s), stay alive until SIGTERM
  stop        Ask the running kernel to shut down

The kernel supervises each daemon per its RestartPolicy (always / on-failure /
never) with exponential backoff and restart-storm detection — see
docs/PROCESS.md §9-§10. 'run' keeps the process alive; stopping it (Ctrl-C, 'stop',
or --max-runtime-ms for tests) shuts the kernel down.

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
  --module <path|package>  Run a user agent module instead of the prompt agent.
                        A bundled example may be named as ./examples/<name>.ts
                        and resolves inside the package, not the cwd. A relative
                        path is resolved against the current directory;
                        anything that is not a path is imported as a package
                        name.
  --driver/--model/--max-tokens   Prompt-agent LLM options
  --token-budget <n>    Total token budget
  --restart <kind>      always | on-failure | never (default: never)
  --max-restarts <n>    Cap restarts for always/on-failure
  --backoff-ms <n>      Base restart backoff in ms (default: 1000, exponential)
  --memory <json>       Per-region memory policy overrides (a JSON object keyed
                        by region name: kind, backing, optional readOnly,
                        optional maxEntries), merged over the standard
                        episodic/semantic/procedural defaults. Persisted into
                        the daemon spec (daemons.json) and applied every time
                        the daemon (re)spawns. maxEntries: -1 unlimited, 0+ hard
                        write cap, absent inherits the run's global
                        --max-region-entries (a 'daemon run' boot flag).
  -h, --help            Show this help

EXAMPLES
  cortex daemon install watcher --role inbox-watcher --module ./examples/checkpoint-agent.ts --restart on-failure
  cortex daemon install logger --role logger --task "log everything" --restart always --max-restarts 10
  cortex daemon install scribe --role scribe --task "note facts" \
    --memory '{"episodic":{"kind":"cow","backing":"inmem","maxEntries":100}}'
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
  --max-region-entries <n>  Cap writes per memory region for this supervisor
                        kernel; a region exceeding n writes traps ENOMEM (omit =
                        unlimited)
  --port <n>           Bind the control port to n (default: an ephemeral port
                        chosen by the OS)

TRANSPORT
  While it runs, the kernel publishes its endpoint in <CORTEX_HOME>/kernel.json
  and serves it on 127.0.0.1. Other 'cortex' invocations in the same directory
  use it to reach the *running* kernel: 'cortex send' delivers a message to a
  live agent's inbox, 'cortex kill' delivers a real signal, 'cortex attach
  --interactive' pipes stdin into it. Every one of those actions is recorded
  in the kernel's .crec log exactly as if it had been issued locally.

EXAMPLE
  cortex daemon run watcher
  cortex daemon run --max-runtime-ms 500   # headless smoke of the supervisor
`);
}

// Re-export so tests can exercise the pure generator without a real home dir.
export { generateServiceUnit, enableCommand, unitPathFor };
