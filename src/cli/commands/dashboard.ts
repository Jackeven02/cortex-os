import { parseArgs } from 'node:util';
import { defaultKernelDir } from '../index.js';
import { startDashboard } from '../../dashboard/server.js';

export async function cmdDashboard(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '4173' },
      dir: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log('cortex dashboard [--host 127.0.0.1] [--port 4173] [--dir .cortex]');
    return 0;
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('cortex dashboard: --port must be between 0 and 65535');
    return 1;
  }
  const dashboard = await startDashboard({
    dir: values.dir ?? defaultKernelDir(),
    host: values.host,
    port,
  });
  console.log(`Cortex dashboard listening at ${dashboard.url}`);
  console.log('Press Ctrl+C to stop.');
  await new Promise<void>((resolve) => {
    const stop = (): void => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await dashboard.close();
  return 0;
}
