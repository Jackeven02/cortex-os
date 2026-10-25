import { createReadStream, existsSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, basename } from 'node:path';
import { format } from 'node:util';
import { asProcessId } from '../kernel/types.js';
import type { BlockedReason, BudgetLimits, ProcessInfo, ProcessState, Signal, SyscallRecord } from '../kernel/types.js';
import { existingCrecPath, readRecords } from '../kernel/recorder.js';
import { readCheckpointFile } from '../kernel/checkpoint.js';
import { readAllMetas, listProcDirs, readOutputEntries, findCheckpointFile } from '../cli/process_store.js';
import { formatCaps, describePendingSignals, readProcessView, formatAge, processAge, type AgeFacts } from '../cli/process_view.js';
import { describeOutcome } from '../cli/process_outcome.js';
import { describeBudget, formatTokenBudget, formatUsdBudget, type BudgetFacts } from '../cli/process_budget.js';
import { describeCheckpoint, formatCheckpointTokenBudget, formatCheckpointUsdBudget } from '../cli/checkpoint_view.js';
import {
  describeDriverSurface,
  formatDeclaration,
  formatUndeclaredSummary,
  type DriverSurface,
} from '../cli/audit_view.js';
import { describeKernel, type KernelFacts } from '../cli/kernel_view.js';
import { describeConnection } from './connection_view.js';
import { usdToDollars } from '../money.js';
import { formatTokenUsage, callUsage } from '../token_usage.js';
import { frameName } from '../cli/frame_name.js';
import { formatOpenCall, readOpenCallsFromKernel } from '../cli/open_call.js';
import { formatAccess, formatLimit, formatPeers } from '../cli/memory_view.js';
import {
  ActivityStore,
  safeErrorMessage,
  toActivityEvent,
  toCallbackEvent,
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
  /**
   * Be told when the connection to the kernel ends.
   *
   * Optional: a kernel that cannot report its own death is a kernel whose
   * loss shows up in the next read — and the window finds out either way.
   * But when it *can* report it, the window hears it at once instead of
   * holding a "live connection" claim for as long as the push stream stays
   * open over a dead socket.
   */
  onClose?(handler: (reason: Error) => void): void;
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
 * How many lines of a process's captured output the window asks for.
 *
 * An agent that has printed a hundred thousand lines should not cost the
 * operator's window a hundred thousand lines of JSON. The endpoint says how
 * many there were in total, so the view can say that it is showing the end
 * of a longer history instead of pretending the history is that short.
 */
const DEFAULT_OUTPUT_TAIL = 500;

/**
 * How many memory entries of a checkpoint the window shows.
 *
 * A snapshot's memory is a **full** dump in v0, so it can hold thousands of
 * entries. The window shows the last N of them and says how many there were
 * in all — a panel showing 20 entries must not look like a snapshot that held
 * 20.
 */
const DEFAULT_CHECKPOINT_MEMORY = 200;

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
      // The same conversion the store uses, so a callback line read from
      // disk and the same line read into the store are one event, not two.
      const event = toCallbackEvent(JSON.parse(line) as unknown);
      if (event === undefined) continue;
      if (filtering && !inRange(Date.parse(event.at), range)) continue;
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
    return [...options.processes()].map((row) =>
      withAgeLabel(
        withBudgetLabel(withOutcomeLabel(withCapsLabel(withUsdDollars(withUsdLabel(withTokenLabel(withInside(withPendingLabel(row)))))))),
        now,
      ),
    );
  }
  const view = await readProcessView(dir, options.kernel);
  return [...view.rows].map((row) =>
    withAgeLabel(
      withBudgetLabel(withOutcomeLabel(withCapsLabel(withUsdDollars(withUsdLabel(withTokenLabel(withInside(withPendingLabel(row)))))))),
      now,
    ),
  );
}

/**
 * Put the cost on the row, in **dollars**.
 *
 * `budgetsSpent.usdSpent` is in **microdollars** — an integer count, 1 USD =
 * 1_000_000 (docs/STATE.md §2.4). The page used to add those numbers up and
 * print them as dollars, so a process that had spent **$0.0034** was shown in
 * the operator's window as having spent **$3400.0000** — a thousand times the
 * money, which is the kind of number that gets a budget cut.
 *
 * The conversion happens here, once, and the page is handed dollars. The page
 * cannot get the scale wrong, because it never sees microdollars.
 */
function withUsdDollars<T extends { budgetsSpent?: { usdSpent?: number } }>(
  row: T,
): T & { usdSpentDollars: number } {
  return { ...row, usdSpentDollars: usdToDollars(row.budgetsSpent?.usdSpent ?? 0) };
}

/**
 * Put the token count on the row, in the same words `cortex ps` and `cortex top`
 * print.
 *
 * A token count has three parts, and the cached one is a *part* of the input:
 * the provider reports the whole prompt and says how much of it came out of
 * its cache. The page used to print the total alone, so a process that spent
 * 1,000 tokens for a fifth of the usual money looked like any other — and the
 * operator could not make the tokens and the dollars add up.
 *
 * The label also carries the **ceiling** the spend is measured against, for
 * the same reason `cortex ps` and `cortex top` carry it: a spend on its own
 * is 12% of one budget and 99% of another, and the window cannot answer
 * "is this one about to run out?" without it.
 *
 * The label travels with the row so the page never re-implements the rule: one
 * function, three views. The page's own number style is the only thing the
 * server does not decide here — it spells the numbers out (`1,234`) where the
 * CLI shortens them (`1.2k`), and that difference is the view's to make.
 */
function withTokenLabel<
  T extends {
    budgetsSpent?: {
      tokensIn?: number;
      tokensOut?: number;
      tokensCached?: number;
      usdSpent?: number;
      wallTimeMs?: number;
      syscallCount?: number;
    };
    budgetsRemaining?: { tokens?: number; usd?: number; wallTimeMs?: number };
  },
>(row: T): T & { tokenLabel: string } {
  return {
    ...row,
    tokenLabel: formatTokenBudget(budgetFactsOf(row), (n) => n.toLocaleString()),
  };
}

/**
 * The budget facts of one row, as the budget rule wants them.
 *
 * A row that came from the kernel carries both records; a row from a test
 * double may not, and a counter nobody reported is zero — the kernel counts
 * from zero, and a cell that said "no" about a spend nobody made would be a
 * claim.
 */
function budgetFactsOf(row: {
  budgetsSpent?: {
    tokensIn?: number;
    tokensOut?: number;
    tokensCached?: number;
    usdSpent?: number;
    wallTimeMs?: number;
    syscallCount?: number;
  };
  budgetsRemaining?: { tokens?: number; usd?: number; wallTimeMs?: number };
}): BudgetFacts {
  const spent = row.budgetsSpent;
  const remaining = row.budgetsRemaining;
  return {
    spent: {
      tokensIn: spent?.tokensIn ?? 0,
      tokensOut: spent?.tokensOut ?? 0,
      tokensCached: spent?.tokensCached ?? 0,
      usdSpent: spent?.usdSpent ?? 0,
      wallTimeMs: spent?.wallTimeMs ?? 0,
      syscallCount: spent?.syscallCount ?? 0,
    },
    remaining: {
      tokens: remaining?.tokens ?? -1,
      usd: remaining?.usd ?? -1,
      wallTimeMs: remaining?.wallTimeMs ?? -1,
    },
  };
}

/**
 * Put the **money** on the row, in the same words `cortex top` prints.
 *
 * The window showed a process's tokens and a process's money — but not in the
 * same row. The money was in the budget panel, which rolls it up **by role**:
 * three agents called `coder` became one line with one number on it. So the
 * operator could see which agent spent the tokens and could **not** see which
 * one spent the money, and could not see either one's money ceiling.
 *
 * The cell carries the spend and the ceiling it is measured against, for the
 * same reason every other spend does: a spend on its own is 12% of one budget
 * and 99% of another.
 *
 * The money's precision is not the page's to choose — six decimals is what a
 * microdollar count can say exactly (`src/money.ts`) — so this cell is built
 * by the same function `cortex top` uses, and the two cannot disagree about
 * what a process cost.
 */
function withUsdLabel<
  T extends {
    budgetsSpent?: {
      tokensIn?: number;
      tokensOut?: number;
      tokensCached?: number;
      usdSpent?: number;
      wallTimeMs?: number;
      syscallCount?: number;
    };
    budgetsRemaining?: { tokens?: number; usd?: number; wallTimeMs?: number };
  },
>(row: T): T & { usdLabel: string } {
  return { ...row, usdLabel: formatUsdBudget(budgetFactsOf(row)) };
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
 * prints it in its NOTE column, `cortex top` in its NOTE, and the page
 * prints it here — all from the same function.
 */
function withPendingLabel<T extends { pendingSignals?: readonly Signal[] }>(
  row: T,
): T & { pendingLabel: string } {
  return { ...row, pendingLabel: describePendingSignals('', row.pendingSignals) };
}

/**
 * Put the lifetime on the row, in the same words `cortex ps` prints.
 *
 * The window showed the **start time** and nothing else — and a start time is
 * not a duration. It says when a process began, which for a process that died
 * an hour ago says nothing at all about how long it lived; the number the
 * operator wants is the other one.
 *
 * And the number is not the same for every row: a running process is aging
 * right now, so its age is the time since it started, while a **finished**
 * process is not aging — it lived for a while and then it was over, and the
 * kernel recorded how long that was. So the label stops growing at the moment
 * the process ended, which is the only thing that makes it a lifetime rather
 * than a timestamp in disguise.
 *
 * The label travels with the row so the page never has to re-implement the
 * rule: `cortex ps` prints it in its AGE column, `cortex top` in its own, and
 * the page prints it here — all from the same function.
 */
function withAgeLabel<T extends AgeFacts>(
  row: T,
  now: number,
): T & { ageLabel: string } {
  return { ...row, ageLabel: formatAge(processAge(row, now)) };
}

/**
 * The transport's `memory` reply for one process: its regions.
 *
 * The shape the kernel's memory manager answers with (ABI.md §4.4), read
 * over the transport rather than out of the log: a region's contents live in
 * the memory driver, and the `.crec` deliberately keeps only a hash of every
 * value the process wrote.
 */
interface MemoryRegionsReply {
  readonly pid: number;
  readonly role: string;
  readonly regions: readonly {
    readonly region: string;
    readonly kind: string;
    readonly backing: string;
    readonly readOnly?: boolean;
    readonly writes: number;
    readonly entries: number;
    readonly truncated?: boolean;
    readonly sharedWith: readonly number[];
    readonly readOnlyPeers?: readonly number[];
    readonly effectiveMaxEntries?: number;
  }[];
}

/** The transport's `memory` reply for one region: its entries. */
interface MemoryDumpReply {
  readonly pid: number;
  readonly role: string;
  readonly region: string;
  readonly readOnly?: boolean;
  readonly entries: readonly { key: string; value: unknown; at: string }[];
}

/** One region, in the words the CLI's `cortex memory` prints. */
interface DescribedRegion {
  readonly region: string;
  readonly kind: string;
  readonly backing: string;
  /** `read-write`, `read-only`, or `?` when the kernel did not report it. */
  readonly access: string;
  readonly entries: number;
  readonly truncated: boolean;
  readonly writes: number;
  /** The write-count ceiling: the number, `∞`, or `?`. */
  readonly limit: string;
  /** The peers, each with the access mode it holds the region under. */
  readonly sharedWith: string;
}

/**
 * One region, said the way `cortex memory` says it.
 *
 * The words — the access mode, the ceiling, the peers — come from the shared
 * module (`src/cli/memory_view.ts`), so the window and the CLI cannot
 * disagree about a region. The page keeps only its own number style: it
 * spells the counts out (`1,234`) where the CLI shortens them (`1.2k`).
 */
function describeRegion(region: MemoryRegionsReply['regions'][number]): DescribedRegion {
  return {
    region: region.region,
    kind: region.kind,
    backing: region.backing,
    access: formatAccess(region.readOnly),
    entries: region.entries,
    truncated: region.truncated === true,
    writes: region.writes,
    limit: formatLimit(region.effectiveMaxEntries),
    sharedWith: formatPeers(region.sharedWith, region.readOnlyPeers),
  };
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

/**
 * Put the ending on the row, in the same words `cortex ps` and `cortex top`
 * print.
 *
 * The page is the operator's window, and it used to show a finished run and a
 * crashed one with the same word — `zombie` — so "did it finish, or did it
 * die?" needed the trace view to answer. The kernel knows the code and the
 * reason; the label carries them.
 *
 * The label travels with the row so the page never re-implements the rule: one
 * function, three views.
 */
function withOutcomeLabel<T extends { state: ProcessState; exitCode: number | null; exitReason: string | null }>(
  row: T,
): T & { outcomeLabel: string } {
  return { ...row, outcomeLabel: describeOutcome(row) };
}

/**
 * Put the budget on the row, in the same words `cortex ps` and `cortex top`
 * print.
 *
 * A process that has run out of budget cannot go on, and nothing else in the
 * row says so: a `ready` row that will never run again looks exactly like one
 * that is merely waiting. The kernel knows which budget ran out (the
 * remainder is zero), and the label says it.
 */
function withBudgetLabel<T extends { budgetsRemaining: BudgetLimits }>(
  row: T,
): T & { budgetLabel: string } {
  return { ...row, budgetLabel: describeBudget(row.budgetsRemaining) };
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
      // What one checkpoint holds.
      //
      // A `.csnap` is the one thing in this system you can **restore** but
      // never **look at**: the panel listed them by pid, time and size and
      // offered a 恢复 button, with no way to see what you were about to
      // restore. `cortex restore` re-materialised a process without ever
      // naming what it brought back.
      //
      // It is a **disk read**, and it is read with the *same reader the
      // kernel uses* — the magic, the version and the signature are checked
      // the same way — so the window can only describe a body the kernel
      // would actually restore.
      const checkpointMatch = /^\/api\/checkpoints\/([^/]+)$/.exec(url.pathname);
      if (checkpointMatch !== null) {
        const chainId = decodeURIComponent(checkpointMatch[1]!);
        const path = findCheckpointFile(dir, chainId);
        if (path === undefined) {
          json(response, 404, { error: `no checkpoint with chain ${chainId}` });
          return;
        }
        try {
          const facts = describeCheckpoint(await readCheckpointFile(path));
          // A snapshot's memory is a **full** dump in v0, so it can hold
          // thousands of entries. The view shows the last N of them and says
          // how many there were in all.
          const limitRaw = url.searchParams.get('limit');
          const requested = limitRaw === null ? DEFAULT_CHECKPOINT_MEMORY : Number(limitRaw);
          const limit = Number.isFinite(requested) && requested >= 0 ? requested : DEFAULT_CHECKPOINT_MEMORY;
          const shown = facts.memoryEntries.slice(Math.max(0, facts.memoryEntries.length - limit));
          json(response, 200, {
            ...facts,
            memoryEntries: shown,
            memoryEntryCount: facts.memoryWriteCount,
            // The labels are computed here because the page is a static file
            // and cannot compute them — and they are the same words every
            // other view uses for a budget: the spend next to the ceiling it
            // was measured against.
            tokenLabel: formatCheckpointTokenBudget(facts, (n) => n.toLocaleString()),
            usdLabel: formatCheckpointUsdBudget(facts),
          });
        } catch (err) {
          json(response, 502, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      if (url.pathname === '/api/checkpoints') {
        json(response, 200, await listCheckpoints(dir));
        return;
      }
      // Which node this window is attached to.
      //
      // The sidebar used to say 「本地节点已连接」 and 「ABI 1.0」 in plain
      // HTML — always, whether a kernel was running or not, and whatever ABI
      // that kernel actually spoke. The window's chrome was making two
      // claims it had never checked, while two panels inside it said out
      // loud that they could not answer without a live kernel.
      //
      // So the kernel is asked. `ping` is a transport-level command: it is
      // not recorded, it costs nothing, and it already answers "which kernel
      // is this, what does it speak, how long has it been up".
      //
      // This endpoint **always** answers, because "there is no kernel here"
      // is one of its answers and not an error: the window has to be able to
      // say that. What it does not do is guess — an unreported fact is null,
      // never zero.
      //
      // It also answers for the **top bar**: the same rule the sidebar
      // follows — a view must not claim what it has not checked — used to be
      // broken there. The bar said 「实时连接（SSE）」 with a green dot when
      // there was no kernel at all, after the kernel died under the window,
      // and never went back to green once a poll failed. So the bar's words
      // are computed here, from the kernel state that was just checked.
      //
      // The one thing the server cannot check for itself is **how the window
      // is fetching** — pushed or polled — because that is a fact about the
      // window. The window says which it is doing, and the words are still
      // computed here, so they cannot be two different sentences.
      if (url.pathname === '/api/node') {
        let facts: KernelFacts;
        if (options.kernel === undefined) {
          facts = describeKernel(undefined);
        } else {
          try {
            facts = describeKernel(
              (await options.kernel.request('ping')) as {
                abiVersion?: unknown;
                kernelPid?: unknown;
                startedAt?: unknown;
                daemons?: unknown;
              },
            );
          } catch (error) {
            facts = describeKernel(undefined, error);
          }
        }
        const transport = url.searchParams.get('transport') === 'sse' ? 'sse' : 'poll';
        json(response, 200, {
          // The state directory this window is serving. The sidebar claims to
          // show "the current working directory", so it had better show the
          // directory the window is actually reading.
          dir,
          dirName: basename(dir),
          kernel: facts,
          // What the top bar may claim, and how much to believe it.
          connection: describeConnection({ transport, kernel: facts.state }),
        });
        return;
      }
      // What this kernel can call.
      //
      // The window could show what an agent *did* and what it *knew*, and
      // nothing about the system it was running in — which tools existed,
      // which model was driving it, and which of those tools never said
      // whether they could be undone. `cortex audit` answers that, but it
      // boots a kernel of its own to do it, and the answer it gives is about
      // *that* kernel: an MCP server's tool list is pulled from the server
      // when the driver registers, so the surface of the kernel actually
      // running the agents is not the surface of a second one.
      //
      // So the window asks the kernel that has the agents — over the
      // transport's `drivers` command, which is a read and is not recorded.
      // There is no on-disk copy to fall back on: the tool list lives in the
      // registry of the kernel that owns it, so without one this says so
      // rather than showing an empty surface that looks like a kernel with
      // no tools.
      if (url.pathname === '/api/drivers') {
        if (options.kernel === undefined) {
          json(response, 409, {
            error:
              "no live kernel: the tool surface belongs to the kernel that registered the drivers — there is no on-disk copy to read instead",
          });
          return;
        }
        try {
          const reply = await options.kernel.request('drivers') as { surface: DriverSurface };
          const surface = reply.surface;
          json(response, 200, {
            toolDrivers: surface.toolDrivers.map((driver) => ({
              ...driver,
              tools: driver.tools.map((tool) => ({
                ...tool,
                // The label travels with the tool so the page never
                // re-implements the rule — the page is a static file and
                // cannot import it — and so the window and the terminal
                // mark an undeclared tool with the same word.
                declaredLabel: formatDeclaration(tool.declared),
              })),
            })),
            llmDrivers: surface.llmDrivers,
            memoryDrivers: surface.memoryDrivers,
            toolCount: surface.toolCount,
            undeclaredCount: surface.undeclaredCount,
            // The sentence about the undeclared tools, computed here for
            // the same reason: it is one sentence with one home, and both
            // views print it.
            summary: formatUndeclaredSummary(surface),
          });
        } catch (error) {
          json(response, 502, { error: error instanceof Error ? error.message : String(error) });
        }
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

        // --- something was printed -------------------------------------------
        //
        // The kernel relays every line an agent prints, the moment it is
        // printed — and the window used to drop those events on the floor.
        // So the window could not show what an agent **said**, which is the
        // first thing an operator reaches for when an agent is behaving
        // strangely.
        //
        // The line itself is **not** forwarded: the file is the truth, and
        // the page re-reads it. So the window and the file cannot disagree
        // about what was said, and a line that was written half-way cannot
        // reach the screen as half a line.
        //
        // It is **throttled**, not debounced, for the same reason the process
        // table is: a chatty agent prints a line at a time, and a debounce
        // that waited for the silence would never see the busy period at all.
        const outputPids = new Set<number>();
        let outputTimer: ReturnType<typeof setTimeout> | undefined;
        const outputChanged = (pid: number): void => {
          outputPids.add(pid);
          if (outputTimer !== undefined) return;
          outputTimer = setTimeout(() => {
            outputTimer = undefined;
            const pids = [...outputPids];
            outputPids.clear();
            send('output', { pids });
          }, PROCESS_REFRESH_DEBOUNCE_MS);
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
              if (converted.runId !== undefined && seeded.has(converted.runId)) return;
              recent = [converted, ...recent].slice(0, limit);
              send('events', recent);
              return;
            }
            if (event.kind === 'process-start' || event.kind === 'process-exit') {
              refreshProcesses(true);
            }
            if (event.kind === 'output') {
              // A line was printed. The window is told *that* it changed and
              // re-reads the file — the file is the truth, so the page and
              // the log cannot end up saying different things.
              outputChanged(event.pid ?? 0);
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
            // The kernel went away.
            //
            // The push stream cannot deliver another frame — the socket it
            // rides on is gone — and a window that keeps saying 「实时连接」 over
            // a dead socket is claiming something nobody checked. The
            // sidebar had already turned red and said 「内核失联」 by then,
            // while the bar right above it still showed a green light.
            //
            // So the stream ends. The window falls back to polling, asks the
            // kernel again (it will not answer), and says out loud that what
            // it is showing is what the disk still has.
            // The kernel went away.
            //
            // The push stream cannot deliver another frame — the socket it
            // rides on is gone — and a window that keeps saying 「实时连接」 over
            // a dead socket is claiming something nobody checked. The
            // sidebar had already turned red and said 「内核失联」 by then,
            // while the bar right above it still showed a green light.
            //
            // So the stream ends. The window falls back to polling, asks the
            // kernel again (it will not answer), and says out loud that what
            // it is showing is what the disk still has.
            options.kernel.onClose?.(() => {
              if (closed) return;
              closed = true;
              if (heartbeat !== undefined) clearInterval(heartbeat);
              if (processRefresh !== undefined) clearTimeout(processRefresh);
              if (outputTimer !== undefined) clearTimeout(outputTimer);
              unsubscribe?.();
              response.end();
            });
            request.on('close', () => {
              closed = true;
              if (heartbeat !== undefined) clearInterval(heartbeat);
              if (processRefresh !== undefined) clearTimeout(processRefresh);
              if (outputTimer !== undefined) clearTimeout(outputTimer);
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
          watcher = watch(dir, { recursive: true }, (_eventType, filename) => {
            // A line was printed: the output panel has to hear it, even
            // though no kernel is pushing anything here.
            const printed = filename === null || filename === undefined
              ? null
              : /processes[/\\](\d+)[/\\]output\.log$/.exec(String(filename));
            if (printed !== null) outputChanged(Number(printed[1]));
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
          if (outputTimer !== undefined) clearTimeout(outputTimer);
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
          // What the call spent, read by the same function the CLI's trace and
          // the event table read it with (`callUsage`, in
          // `src/token_usage.ts`). The timeline used to read the usage with
          // its own inline shape — and that shape had no `cachedTokens` in it,
          // so a call served out of the provider's cache read as a call that
          // was not.
          const usage = callUsage(record.syscall, record.result);
          records.push({
            timestamp: record.timestamp, pid: Number(record.pid), syscall: record.syscall,
            // The name a human reads. The kernel's own frames are placeholders
            // on disk (`__state`, `__sched`, …) and the *view* is what
            // distinguishes them — `__state:running->blocked(recv)`,
            // `__sched:sigxcpu(tokens)`. `cortex trace` prints that name, and
            // the operator's window must not say something else about the same
            // frame.
            frame: frameName(record),
            callId: record.callId, phase: record.phase, durationMs: record.durationMs,
            stateBefore: record.stateBefore, stateAfter: record.stateAfter,
            reversibility: record.reversibility, error: record.error?.errno,
            ...(record.error !== undefined ? { errorMessage: safeErrorMessage(record.error.message) } : {}),
            ...(usage?.model !== undefined ? { model: usage.model } : {}),
            ...(usage?.inputTokens !== undefined ? { tokensIn: usage.inputTokens } : {}),
            ...(usage?.outputTokens !== undefined ? { tokensOut: usage.outputTokens } : {}),
            ...(usage?.cachedTokens !== undefined ? { tokensCached: usage.cachedTokens } : {}),
            ...(usage?.usd !== undefined ? { usd: usage.usd } : {}),
          });
          if (records.length > 1000) records.shift();
        }
        json(response, 200, records.reverse());
        return;
      }
      // The memory a process KNOWS: its regions, what is in them, and who
      // else can see them.
      //
      // The window could show what an agent **did** (the event table, the
      // syscall timeline) and nothing about what it **knows** — and for an
      // agent, the knowledge is the point. It lives in the kernel's memory
      // driver, so there is no on-disk copy to fall back on: without a live
      // kernel this says so rather than showing an empty region.
      const memoryMatch = /^\/api\/memory\/(\d+)(?:\/([^/]+))?$/.exec(url.pathname);
      if (memoryMatch !== null) {
        const pid = Number(memoryMatch[1]);
        const region = memoryMatch[2] === undefined ? undefined : decodeURIComponent(memoryMatch[2]);
        if (options.kernel === undefined) {
          json(response, 409, {
            error:
              "no live kernel: a process's memory lives in the kernel that owns it — there is no on-disk copy to read instead",
          });
          return;
        }
        try {
          if (region === undefined) {
            const reply = await options.kernel.request('memory', { pid }) as MemoryRegionsReply;
            json(response, 200, { pid: reply.pid, role: reply.role, regions: reply.regions.map(describeRegion) });
            return;
          }
          const reply = await options.kernel.request('memory', { pid, region }) as MemoryDumpReply;
          json(response, 200, {
            pid: reply.pid,
            role: reply.role,
            region: reply.region,
            // The same word the CLI's dump header uses (`src/cli/memory_view.ts`).
            access: formatAccess(reply.readOnly),
            entries: reply.entries,
          });
          return;
        } catch (error) {
          const errno = (error as { errno?: string }).errno;
          json(response, errno === 'ESRCH' ? 404 : 502, {
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
      }
      // What the process **said**.
      //
      // The `.crec` log answers "what did it do", and it says nothing about
      // what it said: an agent's `console.log` used to go to the daemon's
      // stdout and nowhere else. It is kept now — one stamped line per
      // printed line, in `processes/<pid>/output.log` — and `cortex logs`
      // reads it back. The operator's window had no way to ask, so the one
      // thing an operator reaches for first was the one thing the window
      // could not show.
      //
      // It is a **disk read**: the lines are on disk, so this answers for a
      // process that has already exited and for one whose kernel is gone —
      // the same limit `cortex logs` has, and the same freedom.
      const outputMatch = /^\/api\/output\/(\d+)$/.exec(url.pathname);
      if (outputMatch !== null) {
        const pid = Number(outputMatch[1]);
        const tailRaw = url.searchParams.get('tail');
        // A tail that is not a number is not a tail. Falling back to the
        // default keeps a typo from asking for the whole history.
        const requested = tailRaw === null ? DEFAULT_OUTPUT_TAIL : Number(tailRaw);
        const tail = Number.isFinite(requested) && requested >= 0 ? requested : DEFAULT_OUTPUT_TAIL;
        const { entries, total } = await readOutputEntries(dir, asProcessId(pid), { tail });
        json(response, 200, { pid, total, lines: entries });
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
