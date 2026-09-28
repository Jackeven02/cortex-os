import { createReadStream, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { asProcessId } from '../kernel/types.js';
import type { ProcessInfo } from '../kernel/types.js';
import { existingCrecPath, readRecords } from '../kernel/recorder.js';
import { readAllMetas } from '../cli/process_store.js';

export interface DashboardOptions {
  readonly dir?: string;
  readonly host?: string;
  readonly port?: number;
  readonly processes?: () => readonly ProcessInfo[];
}

export interface RunningDashboard {
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
}

const publicDir = fileURLToPath(new URL('../../assets/dashboard/', import.meta.url));
const json = (response: import('node:http').ServerResponse, status: number, data: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(data));
};

async function readEvents(dir: string, limit: number): Promise<unknown[]> {
  const path = join(dir, 'integrations', 'langchain', 'events.jsonl');
  if (!existsSync(path)) return [];
  const rows: unknown[] = [];
  const input = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of input) {
    if (line.length === 0) continue;
    try {
      rows.push(JSON.parse(line) as unknown);
      if (rows.length > limit) rows.shift();
    } catch {
      continue;
    }
  }
  return rows.reverse();
}

async function readSyscallEvents(dir: string, limit: number): Promise<unknown[]> {
  const events: Array<{
    type: string;
    at: string;
    runId: string;
    pid: number;
    name: string;
    durationMs?: number;
    error?: string;
    audit?: Record<string, unknown>;
  }> = [];
  for (const meta of readAllMetas(dir)) {
    const path = existingCrecPath(dir, asProcessId(meta.pid));
    if (!existsSync(path)) continue;
    try {
      for await (const record of readRecords(path)) {
        if (record.phase === 'enter' || record.syscall.startsWith('__')) continue;
        const type = record.syscall === 'llm_call'
          ? 'llm.call'
          : record.syscall === 'tool_call'
            ? 'tool.call'
            : `kernel.${record.syscall}`;
        // Tools may attach a generic `audit` object to their structured
        // output. It is passed through verbatim — the dashboard does not
        // know (or care) what domains put inside it.
        const toolResult = record.result as { output?: { structured?: { audit?: Record<string, unknown> } } } | undefined;
        const audit = record.syscall === 'tool_call' ? toolResult?.output?.structured?.audit : undefined;
        events.push({
          type,
          at: record.timestamp,
          runId: record.callId,
          pid: meta.pid,
          name: record.syscall,
          ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
          ...(record.error !== undefined ? { error: record.error.errno } : {}),
          ...(audit !== undefined ? { audit } : {}),
        });
      }
    } catch {
      continue;
    }
  }
  return events
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit);
}

/** Start the read-only Cortex monitoring UI and JSON API. Defaults to loopback. */
export async function startDashboard(options: DashboardOptions = {}): Promise<RunningDashboard> {
  const dir = options.dir ?? '.cortex';
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 4173;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method !== 'GET') {
        json(response, 405, { error: 'read-only dashboard' });
        return;
      }
      if (url.pathname === '/api/processes') {
        const live = options.processes?.();
        json(response, 200, live ?? readAllMetas(dir));
        return;
      }
      if (url.pathname === '/api/events') {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
        const [callbacks, syscalls] = await Promise.all([
          readEvents(dir, limit),
          readSyscallEvents(dir, limit),
        ]);
        json(response, 200, [...callbacks, ...syscalls]
          .sort((a, b) => Date.parse(String((b as { at?: string }).at ?? '')) - Date.parse(String((a as { at?: string }).at ?? '')))
          .slice(0, limit));
        return;
      }
      const match = /^\/api\/trace\/(\d+)$/.exec(url.pathname);
      if (match !== null) {
        const pid = asProcessId(Number(match[1]));
        const path = existingCrecPath(dir, pid);
        if (!existsSync(path)) {
          json(response, 404, { error: 'process recording not found' });
          return;
        }
        const records = [];
        for await (const record of readRecords(path)) {
          records.push({
            timestamp: record.timestamp, pid: Number(record.pid), syscall: record.syscall,
            callId: record.callId, phase: record.phase, durationMs: record.durationMs,
            stateBefore: record.stateBefore, stateAfter: record.stateAfter,
            reversibility: record.reversibility, error: record.error?.errno,
          });
          if (records.length > 1000) records.shift();
        }
        json(response, 200, records.reverse());
        return;
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
        response.end(await readFile(join(publicDir, 'index.html')));
        return;
      }
      json(response, 404, { error: 'not found' });
    } catch (error) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = address !== null && typeof address !== 'string' ? address.port : port;
  return {
    server,
    url: `http://${host}:${actualPort}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
