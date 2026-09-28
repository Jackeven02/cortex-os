import { createReadStream, existsSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { format } from 'node:util';
import { asProcessId } from '../kernel/types.js';
import type { ProcessInfo } from '../kernel/types.js';
import { existingCrecPath, readRecords } from '../kernel/recorder.js';
import { readAllMetas } from '../cli/process_store.js';

export interface DashboardOptions {
  readonly dir?: string;
  readonly host?: string;
  readonly port?: number;
  readonly processes?: () => readonly ProcessInfo[];
  /**
   * Opt-in write operations. Off by default.
   * `true` enables every op (`spawn`, `kill`, `restore`); an array enables
   * exactly the listed ops, so a dashboard can expose, say, only `restore`.
   */
  readonly allowOps?: boolean | readonly string[];
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

interface TimeRange {
  from?: number;
  to?: number;
}

const inRange = (atMs: number, range: TimeRange): boolean =>
  (range.from === undefined || atMs >= range.from) && (range.to === undefined || atMs <= range.to);

const MAX_SCAN = 5000;

async function readEvents(dir: string, range: TimeRange): Promise<unknown[]> {
  const path = join(dir, 'integrations', 'langchain', 'events.jsonl');
  if (!existsSync(path)) return [];
  const rows: unknown[] = [];
  const input = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  const filtering = range.from !== undefined || range.to !== undefined;
  for await (const line of input) {
    if (line.length === 0) continue;
    try {
      const event = JSON.parse(line) as { at?: string };
      if (filtering && !(typeof event.at === 'string' && inRange(Date.parse(event.at), range))) continue;
      rows.push(event);
      if (rows.length > MAX_SCAN) rows.shift();
    } catch {
      continue;
    }
  }
  return rows.reverse();
}

async function readSyscallEvents(dir: string, range: TimeRange): Promise<unknown[]> {
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
  const filtering = range.from !== undefined || range.to !== undefined;
  for (const meta of readAllMetas(dir)) {
    const path = existingCrecPath(dir, asProcessId(meta.pid));
    if (!existsSync(path)) continue;
    try {
      for await (const record of readRecords(path)) {
        if (record.phase === 'enter' || record.syscall.startsWith('__')) continue;
        if (filtering && !inRange(Date.parse(record.timestamp), range)) continue;
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
    .slice(0, MAX_SCAN);
}

const byNewest = (a: unknown, b: unknown): number =>
  Date.parse(String((b as { at?: string }).at ?? '')) - Date.parse(String((a as { at?: string }).at ?? ''));

/** Every write operation the dashboard knows how to perform. */
const DASHBOARD_OPS = ['spawn', 'kill', 'restore'] as const;

const allowedOps = (option: DashboardOptions['allowOps']): readonly string[] =>
  option === true ? DASHBOARD_OPS : Array.isArray(option) ? DASHBOARD_OPS.filter((op) => option.includes(op)) : [];

async function readBody(request: IncomingMessage): Promise<string> {
  request.setEncoding('utf8');
  let body = '';
  for await (const chunk of request) body += chunk;
  return body;
}

/**
 * Run a CLI command in-process against the dashboard's own state directory
 * (the CLI reads CORTEX_HOME), capturing its console output. The CLI's own
 * validation still applies to every attempt — the dashboard adds no
 * permission model of its own beyond the ops gate at the route.
 */
async function runCliCommand(dir: string, run: () => Promise<number>): Promise<{ ok: boolean; exitCode: number; output: string }> {
  const prevHome = process.env['CORTEX_HOME'];
  process.env['CORTEX_HOME'] = dir;
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => { logs.push(format(...args)); };
  console.error = (...args: unknown[]) => { logs.push(format(...args)); };
  let code: number;
  try {
    code = await run();
  } catch (error) {
    logs.push(error instanceof Error ? error.stack ?? error.message : String(error));
    code = 1;
  } finally {
    console.log = origLog;
    console.error = origError;
    if (prevHome === undefined) delete process.env['CORTEX_HOME'];
    else process.env['CORTEX_HOME'] = prevHome;
  }
  return { ok: code === 0, exitCode: code, output: logs.join('\n') };
}

/**
 * Run `cortex restore --chain <chainId>` in-process for the dashboard's own
 * state directory. Only reachable when the dashboard was started with
 * --allow-ops; the CLI's own validation (invalid chain, undecodable snapshot,
 * illegal state) still applies to every attempt.
 */
async function handleRestore(request: IncomingMessage, response: ServerResponse, dir: string): Promise<void> {
  let chain = '';
  try {
    chain = String((JSON.parse(await readBody(request) || '{}') as { chain?: unknown }).chain ?? '');
  } catch {
    chain = '';
  }
  if (chain.length === 0) {
    json(response, 400, { error: 'missing "chain" in request body' });
    return;
  }
  const { cmdRestore } = await import('../cli/commands/restore.js');
  json(response, 200, await runCliCommand(dir, () => cmdRestore(['--chain', chain])));
}

/**
 * Run `cortex kill <pid> [--signal <signal>]` in-process. In the v0
 * short-lived-kernel model this marks the process as zombie in its on-disk
 * meta — no live kernel required, exactly like the CLI command.
 */
async function handleKill(request: IncomingMessage, response: ServerResponse, dir: string): Promise<void> {
  let body: { pid?: unknown; signal?: unknown } = {};
  try {
    body = JSON.parse(await readBody(request) || '{}') as { pid?: unknown; signal?: unknown };
  } catch {
    body = {};
  }
  const pid = Number(body.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    json(response, 400, { error: 'missing or invalid "pid" in request body' });
    return;
  }
  const signal = body.signal === undefined ? undefined : String(body.signal);
  const { cmdKill } = await import('../cli/commands/kill.js');
  json(response, 200, await runCliCommand(dir, () => cmdKill(signal === undefined ? [String(pid)] : [String(pid), '--signal', signal])));
}

/**
 * Run `cortex spawn --role <role> [flags]` in-process. Like the CLI, this
 * waits until the agent reaches a terminal state, self-checkpoints, or times
 * out — so the default timeout keeps the HTTP request bounded.
 */
const SPAWN_DEFAULT_TIMEOUT_MS = 30_000;

async function handleSpawn(request: IncomingMessage, response: ServerResponse, dir: string): Promise<void> {
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(await readBody(request) || '{}') as Record<string, unknown>;
  } catch {
    body = {};
  }
  const role = body['role'] === undefined ? '' : String(body['role']).trim();
  if (role.length === 0) {
    json(response, 400, { error: 'missing "role" in request body' });
    return;
  }
  const argv: string[] = ['--role', role];
  if (body['module'] !== undefined) argv.push('--module', String(body['module']));
  if (body['task'] !== undefined) argv.push('--task', String(body['task']));
  if (body['system'] !== undefined) argv.push('--system', String(body['system']));
  if (body['driver'] !== undefined) argv.push('--driver', String(body['driver']));
  if (body['model'] !== undefined) argv.push('--model', String(body['model']));
  if (body['args'] !== undefined) argv.push('--args', JSON.stringify(body['args']));
  if (body['tokenBudget'] !== undefined) argv.push('--token-budget', String(Number(body['tokenBudget'])));
  const timeoutMs = Number(body['timeoutMs'] ?? SPAWN_DEFAULT_TIMEOUT_MS);
  argv.push('--timeout', String(Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : SPAWN_DEFAULT_TIMEOUT_MS));
  const { cmdSpawn } = await import('../cli/commands/spawn.js');
  json(response, 200, await runCliCommand(dir, () => cmdSpawn(argv)));
}

async function listCheckpoints(dir: string): Promise<unknown[]> {
  const out: Array<{
    pid: number;
    file: string;
    createdAt?: string;
    chainId?: string;
    sizeBytes: number;
    modifiedAt: string;
  }> = [];
  const processesDir = join(dir, 'processes');
  if (!existsSync(processesDir)) return out;
  for (const entry of readdirSync(processesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pid = Number(entry.name);
    if (!Number.isInteger(pid)) continue;
    const checkpointDir = join(processesDir, entry.name, 'checkpoints');
    if (!existsSync(checkpointDir)) continue;
    for (const file of readdirSync(checkpointDir)) {
      if (!file.endsWith('.csnap')) continue;
      const stat = statSync(join(checkpointDir, file));
      // .csnap filenames are `<safeTimestamp>_<chainId>.csnap` (checkpoint.ts);
      // both parts are recoverable without decoding the snapshot body.
      const match = /^(.+?)_(.+)\.csnap$/.exec(file);
      out.push({
        pid,
        file,
        ...(match ? { createdAt: match[1], chainId: match[2] } : {}),
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    }
  }
  return out
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

/** Start the read-only Cortex monitoring UI and JSON API. Defaults to loopback. */
export async function startDashboard(options: DashboardOptions = {}): Promise<RunningDashboard> {
  const dir = options.dir ?? '.cortex';
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 4173;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'POST' && url.pathname.startsWith('/api/ops/')) {
        const op = url.pathname.slice('/api/ops/'.length);
        if (!allowedOps(options.allowOps).includes(op)) {
          json(response, 403, { error: 'ops disabled: start the dashboard with --allow-ops (or --ops spawn,kill,restore)' });
          return;
        }
        if (op === 'restore') await handleRestore(request, response, dir);
        else if (op === 'kill') await handleKill(request, response, dir);
        else if (op === 'spawn') await handleSpawn(request, response, dir);
        else json(response, 404, { error: `unknown op: ${op}` });
        return;
      }
      if (request.method !== 'GET') {
        json(response, 405, { error: 'read-only dashboard' });
        return;
      }
      if (url.pathname === '/api/ops') {
        const ops = allowedOps(options.allowOps);
        json(response, 200, { allowOps: ops.length > 0, ops: [...ops] });
        return;
      }
      if (url.pathname === '/api/processes') {
        const live = options.processes?.();
        json(response, 200, live ?? readAllMetas(dir));
        return;
      }
      if (url.pathname === '/api/events') {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        const fromMs = Date.parse(url.searchParams.get('from') ?? '');
        const toMs = Date.parse(url.searchParams.get('to') ?? '');
        const range: TimeRange = {
          ...(Number.isFinite(fromMs) ? { from: fromMs } : {}),
          ...(Number.isFinite(toMs) ? { to: toMs } : {}),
        };
        const [callbacks, syscalls] = await Promise.all([
          readEvents(dir, range),
          readSyscallEvents(dir, range),
        ]);
        const merged = [...callbacks, ...syscalls].sort(byNewest);
        response.setHeader('x-total-count', String(merged.length));
        json(response, 200, merged.slice(offset, offset + limit));
        return;
      }
      if (url.pathname === '/api/checkpoints') {
        json(response, 200, await listCheckpoints(dir));
        return;
      }
      if (url.pathname === '/api/stream') {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        let closed = false;
        let watcher: FSWatcher | undefined;
        let debounce: ReturnType<typeof setTimeout> | undefined;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const send = (event: string, data: unknown): void => {
          if (!closed) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        const push = async (): Promise<void> => {
          try {
            const [callbacks, syscalls] = await Promise.all([
              readEvents(dir, {}),
              readSyscallEvents(dir, {}),
            ]);
            send('processes', options.processes?.() ?? readAllMetas(dir));
            send('events', [...callbacks, ...syscalls].sort(byNewest).slice(0, limit));
          } catch {
            // Transient read failure: keep the stream alive.
          }
        };
        void push();
        try {
          watcher = watch(dir, { recursive: true }, () => {
            if (debounce !== undefined) clearTimeout(debounce);
            debounce = setTimeout(() => { void push(); }, 250);
          });
          watcher.on('error', () => {
            // Keep going: the heartbeat keeps the connection warm and the
            // client's safety poll covers missed filesystem events.
          });
        } catch {
          // fs.watch (recursive) unsupported on this platform — client falls back.
        }
        heartbeat = setInterval(() => { if (!closed) response.write(': ping\n\n'); }, 15000);
        request.on('close', () => {
          closed = true;
          if (heartbeat !== undefined) clearInterval(heartbeat);
          if (debounce !== undefined) clearTimeout(debounce);
          watcher?.close();
        });
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
