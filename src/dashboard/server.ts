import { createReadStream, existsSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { format } from 'node:util';
import { asProcessId } from '../kernel/types.js';
import type { BlockedReason, ProcessInfo, Signal, SyscallRecord } from '../kernel/types.js';
import { existingCrecPath, readRecords } from '../kernel/recorder.js';
import { readAllMetas, listProcDirs } from '../cli/process_store.js';
import { formatCaps, describePendingSignals, readProcessView } from '../cli/process_view.js';
import { formatOpenCall, readOpenCallsFromKernel } from '../cli/open_call.js';
import {
  ActivityStore,
  safeErrorMessage,
  toActivityEvent,
  type ActivityEvent,
} from './event_store.js';
import type { KernelCommand } from '../cli/kernel_protocol.js';
import type { Capability } from '../kernel/types.js';

/**
 * The live kernel the dashboard watches, if there is one.
 *
 * A `KernelClient` satisfies this. It is an interface rather than a concrete
 * client so the dashboard can be driven by anything that can answer a
 * command and push events — the CLI hands it the transport client, and a
 * test hands it a fake.
 */
export interface DashboardKernel {
  /** Ask the kernel a question (`ps`). */
  request(cmd: KernelCommand, args?: Record<string, unknown>): Promise<unknown>;
  /** Subscribe to the kernel's event stream. Returns an unsubscribe. */
  subscribe(handler: (event: unknown) => void): Promise<() => void>;
}

export interface DashboardOptions {
  readonly dir?: string;
  readonly host?: string;
  readonly port?: number;
  readonly processes?: () => readonly ProcessInfo[];
  /**
   * The live kernel to watch.
   *
   * With one, the dashboard shows the processes that are **running** — a
   * process that has not exited has no `meta.json` yet, so the disk alone
   * shows a directory of corpses and omits the agent that is actually
   * working — and the event stream arrives by push instead of by re-reading
   * every log on every filesystem change.
   */
  readonly kernel?: DashboardKernel;
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
  /**
   * The activity feed the dashboard shows, and how much it has read.
   *
   * It is here to be asked, not to be admired: a dashboard that is falling
   * behind is a dashboard that is paying for the whole history on every
   * change, and `bytesRead` is the number that says so.
   */
  readonly activity: ActivityStore;
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

/**
 * How long the live path waits before it re-reads the process table.
 *
 * The kernel says what happens; a burst of frames says it all at once, and
 * the table does not need a re-read per frame. A quarter of a second is
 * short enough that the table is never more than a quarter of a second
 * behind, and long enough that a busy kernel does not turn into a busy
 * dashboard.
 *
 * It is a **throttle**, not a debounce: the wait starts with the first
 * thing that happens and is not pushed back by the things that follow.
 */
const PROCESS_REFRESH_DEBOUNCE_MS = 250;

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

/**
 * One event in the dashboard's activity panel.
 *
 * Derived from a syscall frame — the same frame the `.crec` log holds.
 *
 * The conversion itself lives in `./event_store.ts`, because the disk path
 * and the push path both use it, and two places that turn a frame into an
 * event will turn it into two different events.
 */
type DashboardEvent = ActivityEvent;

/**
 * Turn a syscall frame into a dashboard event — or `undefined` when the
 * frame is not one the dashboard shows.
 */
const toDashboardEvent = toActivityEvent;

async function readSyscallEvents(dir: string, range: TimeRange): Promise<unknown[]> {
  const events: DashboardEvent[] = [];
  const filtering = range.from !== undefined || range.to !== undefined;
  // Every process that has a log — running or finished.
  //
  // Scanning the metas alone would show a directory of corpses: a running
  // process has no `meta.json` yet (the kernel writes it when the process
  // exits), so its log — which is on disk all the same, and is being
  // appended to right now — would never be read. The agent that is working
  // is the one whose history the operator wants.
  const pids = new Set<number>([
    ...listProcDirs(dir).map((p) => p.pid),
    ...readAllMetas(dir).map((m) => m.pid),
  ]);
  for (const pid of [...pids].sort((a, b) => a - b)) {
    const path = existingCrecPath(dir, asProcessId(pid));
    if (!existsSync(path)) continue;
    try {
      for await (const record of readRecords(path)) {
        if (filtering && !inRange(Date.parse(record.timestamp), range)) continue;
        const event = toDashboardEvent(record, pid);
        if (event !== undefined) events.push(event);
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

/**
 * The processes the dashboard shows.
 *
 * The same view `cortex ps` shows: a live kernel's own process table for
 * the processes it still holds, the disk's records for the ones it has
 * finished. Without a kernel it is the disk alone — which is a directory of
 * *finished* processes, because a process that has not exited has no
 * `meta.json` yet. That is why the dashboard needs a kernel to show the
 * agent that is actually working.
 */
async function listProcesses(dir: string, options: DashboardOptions): Promise<unknown[]> {
  // **What each agent is inside**, which the kernel knows and the log would
  // have to be read to find out. The log grows for as long as the agent
  // runs, and this table is re-read several times a second, so asking is
  // the only affordable way.
  //
  // The wording is the *same* wording `cortex top` prints, from the same
  // function: an operator who reads "waiting on a model call" in the tree
  // and something else in the table has to work out whether those are the
  // same thing.
  const calls = await readOpenCallsFromKernel(options.kernel);
  const now = Date.now();
  const withInside = <T extends { pid: number; blockedOn?: BlockedReason | null }>(
    row: T,
  ): T & { insideLabel?: string } => {
    // No answer from the kernel means **no field at all**, not an empty
    // one: the page shows the column only when the information is there,
    // and a column of blanks would claim that nothing is inside a call.
    if (calls === undefined) return row;
    const call = calls.get(row.pid);
    return {
      ...row,
      insideLabel: call === undefined ? '' : formatOpenCall(call, row.blockedOn, now),
    };
  };

  if (options.processes !== undefined) {
    return [...options.processes()].map((row) => withCapsLabel(withInside(withPendingLabel(row))));
  }
  const view = await readProcessView(dir, options.kernel);
  return [...view.rows].map((row) => withCapsLabel(withInside(withPendingLabel(row))));
}

/**
 * Put the queued signals on the row, in the same words `cortex ps` prints.
 *
 * A signal aimed at a process that is not running waits in its queue until
 * the process runs again — so a row that says "blocked" and nothing else
 * hides the fact that the operator already asked this one to die, and that
 * the request is sitting in a queue waiting for a wake-up that may never come.
 *
 * The label travels with the row so the page never has to re-implement the
 * rule. Two views of the same fact must not be able to disagree: `cortex ps`
 * prints it in its WAITING column, `cortex top` in its NOTE, and the page
 * prints it here — all from the same function.
 */
function withPendingLabel<T extends { pendingSignals?: readonly Signal[] }>(
  row: T,
): T & { pendingLabel: string } {
  return { ...row, pendingLabel: describePendingSignals('', row.pendingSignals) };
}

/**
 * Put the capability column on the row, in the same words `cortex ps` uses.
 *
 * The label travels with the row so the page never has to re-implement the
 * rule. Two views of the same fact must not be able to disagree: `cortex ps`
 * prints `all` / `none` / `-` / the list, and so does the dashboard, because
 * both call the same function.
 */
function withCapsLabel<T extends { capabilities?: readonly Capability[] }>(
  row: T,
): T & { capsLabel: string } {
  return { ...row, capsLabel: formatCaps(row.capabilities) };
}

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
  // One store for the whole dashboard: the activity feed is read once and
  // then followed, and every path that shows it — the JSON API, the disk
  // stream, the live stream's seed — reads it from here.
  const store = new ActivityStore();
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
        json(response, 200, await listProcesses(dir, options));
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
        // The feed is read once and then followed, so this is the cost of
        // what is *new*, not of the whole history.
        await store.refresh(dir);
        let merged: readonly unknown[];
        if (store.covers(range)) {
          merged = store.read(range).events;
        } else {
          // The window reaches back past what the store kept. The disk still
          // has it, so the disk is asked — a shorter answer than the disk
          // gives would be a truncation nobody can see.
          const [callbacks, syscalls] = await Promise.all([
            readEvents(dir, range),
            readSyscallEvents(dir, range),
          ]);
          merged = [...callbacks, ...syscalls].sort(byNewest);
        }
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
        let unsubscribe: (() => void) | undefined;
        const send = (event: string, data: unknown): void => {
          if (!closed) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        // --- the live path: the kernel pushes ------------------------------
        // Nothing is re-read. The frames arrive as the kernel writes them,
        // and the process list comes from the kernel's own table. This is
        // the difference between watching a kernel and watching a
        // directory: the disk path re-reads *every* log on *every* change.
        if (options.kernel !== undefined) {
          // Frames that arrive while the history is being read are held, so
          // that nothing is lost and nothing is shown twice.
          const held: unknown[] = [];
          let ready = false;
          let recent: unknown[] = [];
          const seeded = new Set<string>();

          // --- the process table has to hear what happened ------------------
          //
          // The table used to be re-read only when a process *started* or
          // *ended*, which meant a working agent was shown as it was when it
          // started: its state frozen, its spend frozen, for as long as it
          // stayed alive. The page said "live connection" while showing a
          // snapshot. The kernel says what happens (every syscall, every
          // state transition), so the table is re-read when the kernel says
          // something.
          //
          // The re-read is **throttled, not debounced**: a busy kernel says
          // something every few milliseconds, and a debounce that waits for
          // the silence would never see any — the table would sit frozen
          // through exactly the busy period it exists for. So the first
          // thing that happens schedules a re-read a quarter of a second
          // later, and everything that happens in the meantime rides along
          // with it.
          let processRefresh: ReturnType<typeof setTimeout> | undefined;
          let refreshSeq = 0;
          const refreshProcesses = (immediate: boolean): void => {
            const run = (): void => {
              const seq = ++refreshSeq;
              void listProcesses(dir, options)
                .then((rows) => {
                  // Only the newest read may speak: an older one that
                  // arrives late would put an older table back on the screen.
                  if (seq !== refreshSeq) return;
                  send('processes', rows);
                })
                .catch(() => undefined);
            };
            if (immediate) {
              if (processRefresh !== undefined) {
                clearTimeout(processRefresh);
                processRefresh = undefined;
              }
              run();
              return;
            }
            // Already scheduled: let it fire. Resetting the timer on every
            // event would starve it.
            if (processRefresh !== undefined) return;
            processRefresh = setTimeout(() => {
              processRefresh = undefined;
              run();
            }, PROCESS_REFRESH_DEBOUNCE_MS);
          };

          const handle = (raw: unknown): void => {
            const event = raw as { kind?: string; pid?: number; record?: unknown };
            if (event.kind === 'record') {
              // Something happened to a process: its state may have
              // changed, its spend may have moved. The table has to hear
              // it — including for the frames the activity panel does not
              // show, because `__state` is how the kernel says a process
              // changed state.
              refreshProcesses(false);
              const converted = toDashboardEvent(event.record as SyscallRecord, event.pid ?? 0);
              if (converted === undefined) return;
              // A frame that was already in the history is not new.
              if (seeded.has(converted.runId)) return;
              recent = [converted, ...recent].slice(0, limit);
              send('events', recent);
              return;
            }
            if (event.kind === 'process-start' || event.kind === 'process-exit') {
              refreshProcesses(true);
            }
          };

          try {
            unsubscribe = await options.kernel.subscribe((raw) => {
              if (!ready) {
                held.push(raw);
                return;
              }
              handle(raw);
            });
          } catch {
            unsubscribe = undefined;
          }

          if (unsubscribe !== undefined) {
            // Seed the panel from the disk, so it is not empty when the
            // dashboard opens: the kernel only carries what happens from
            // now on.
            //
            // The seed comes from the store, which has already read the logs
            // once and follows them from there — so a page that reconnects
            // does not re-read the whole history of every process.
            await store.refresh(dir);
            recent = [...store.read({}).events].slice(0, limit);
            for (const event of recent) {
              const runId = (event as { runId?: string }).runId;
              if (runId !== undefined) seeded.add(runId);
            }
            send('processes', await listProcesses(dir, options));
            send('events', recent);
            ready = true;
            for (const raw of held) handle(raw);

            heartbeat = setInterval(() => { if (!closed) response.write(': ping\n\n'); }, 15000);
            request.on('close', () => {
              closed = true;
              if (heartbeat !== undefined) clearInterval(heartbeat);
              if (processRefresh !== undefined) clearTimeout(processRefresh);
              unsubscribe?.();
            });
            return;
          }
          // No live stream after all: fall through to the disk path.
        }

        // --- the disk path: watch the directory and follow the logs -------
        const push = async (): Promise<void> => {
          try {
            // Only what is new since the last time. The old path re-read
            // every log from byte 0 on every change, which is the history of
            // every agent — paid again, and again, for the operator's window.
            await store.refresh(dir);
            send('processes', await listProcesses(dir, options));
            send('events', [...store.read({}).events].slice(0, limit));
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
          const result = record.syscall === 'llm_call' ? record.result as {
            model?: string;
            usage?: { inputTokens?: number; outputTokens?: number; usd?: number };
          } | undefined : undefined;
          records.push({
            timestamp: record.timestamp, pid: Number(record.pid), syscall: record.syscall,
            callId: record.callId, phase: record.phase, durationMs: record.durationMs,
            stateBefore: record.stateBefore, stateAfter: record.stateAfter,
            reversibility: record.reversibility, error: record.error?.errno,
            ...(record.error !== undefined ? { errorMessage: safeErrorMessage(record.error.message) } : {}),
            ...(result?.model !== undefined ? { model: result.model } : {}),
            ...(result?.usage?.inputTokens !== undefined ? { tokensIn: result.usage.inputTokens } : {}),
            ...(result?.usage?.outputTokens !== undefined ? { tokensOut: result.usage.outputTokens } : {}),
            ...(result?.usage?.usd !== undefined ? { usd: result.usage.usd } : {}),
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
  // Closing twice is not an error: a dashboard that has already been closed
  // is closed.
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve) => {
      // An open event stream is a connection that never ends by itself, and
      // `server.close` waits for it. The dashboard's own UI holds one open
      // from the moment it loads, so without this Ctrl+C would hang the
      // dashboard instead of stopping it. The stream belongs to the
      // viewer, not to the server — drop it.
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closing;
  };
  return {
    server,
    url: `http://${host}:${actualPort}`,
    activity: store,
    close,
  };
}
