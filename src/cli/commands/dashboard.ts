/**
 * cortex CLI — `cortex dashboard`
 *
 * The dashboard is the operator's window: processes, the supervision tree,
 * the activity feed, the budget rollup. It serves what is on disk, and —
 * when a kernel is running — what that kernel is doing *right now*.
 *
 * The difference matters more than it sounds. A process that has not exited
 * has no `meta.json` yet (the kernel writes it when the process ends), so a
 * dashboard that reads only the disk shows a directory of corpses and omits
 * the agent that is actually working. With a live kernel, the dashboard
 * reads that kernel's own process table and takes its events by push — no
 * polling, and no re-reading every log on every filesystem change.
 *
 * @module cli/commands/dashboard
 */

import { parseArgs } from 'node:util';
import { defaultKernelDir } from '../index.js';
import { probeKernel } from '../kernel_client.js';
import { describeKernel, formatKernelLine, type KernelFacts } from '../kernel_view.js';
import { startDashboard } from '../../dashboard/server.js';

export async function cmdDashboard(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '4173' },
      dir: { type: 'string' },
      'allow-ops': { type: 'boolean', default: false },
      ops: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(`cortex dashboard [--host 127.0.0.1] [--port 4173] [--dir .cortex] [--allow-ops | --ops <list>]

OPS
  Write operations are disabled unless opted in:
    --allow-ops               enable every op (spawn, kill, restore)
    --ops spawn,kill          enable exactly the listed ops
  Ops are served as POST /api/ops/<op> from the same origin.

NOTES
  With a live kernel in this directory ('cortex daemon run'), the dashboard
  shows the processes that are RUNNING and takes the event stream by push.
  Without one the process list can only show finished processes — a process
  that has not exited has no meta.json yet — but its log is on disk all the
  same, and is shown.`);
    return 0;
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('cortex dashboard: --port must be between 0 and 65535');
    return 1;
  }
  const dir = values.dir ?? defaultKernelDir();

  // A live kernel, if there is one. The dashboard holds this connection for
  // its whole life: the process table comes from it, and the event stream
  // is pushed on it.
  const probe = await probeKernel(dir);
  const kernel = probe.kind === 'live' ? probe.client : undefined;

  const dashboard = await startDashboard({
    dir,
    host: values.host,
    port,
    allowOps: values['allow-ops']
      ? true
      : values.ops !== undefined
        ? String(values.ops).split(',').map((op) => op.trim()).filter((op) => op.length > 0)
        : false,
    ...(kernel !== undefined ? { kernel } : {}),
  });
  console.log(`Cortex dashboard listening at ${dashboard.url}`);
  if (kernel !== undefined) {
    // Which kernel is this? There is one per project directory, so "the live
    // kernel" is not enough to tell an operator which one the window is
    // watching. The facts come from the same module the window's sidebar
    // reads, so the two cannot disagree about it.
    let facts: KernelFacts;
    try {
      facts = describeKernel(
        (await kernel.request('ping')) as {
          abiVersion?: unknown;
          kernelPid?: unknown;
          startedAt?: unknown;
          daemons?: unknown;
        },
      );
    } catch (error) {
      facts = describeKernel(undefined, error);
    }
    console.log(formatKernelLine(facts));
    if (facts.state !== 'live') {
      console.log('  finished processes, and the logs of everything that ran');
      console.log("  start one with 'cortex daemon run' to watch agents as they work");
    }
  } else {
    console.log('No live kernel in this directory — showing what is on disk:');
    console.log('  finished processes, and the logs of everything that ran');
    console.log("  start one with 'cortex daemon run' to watch agents as they work");
  }
  console.log('Press Ctrl+C to stop.');
  await new Promise<void>((resolve) => {
    const stop = (): void => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await dashboard.close();
  kernel?.close();
  return 0;
}
