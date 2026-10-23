/**
 * cortex CLI — `cortex memory`
 *
 * ## The question this answers
 *
 * *"Why did the agent do that?"*
 *
 * `cortex trace` answers half of it: the syscall log shows every call the
 * process made, in order, with its arguments. But the argument it recorded
 * for a `memory_write` is a **hash**, not the value (docs/ABI.md §4.4 — "full
 * values would bloat the log"). So the causal history can tell you that an
 * agent *wrote something down* and never *what it wrote down*. The knowledge
 * is the whole point of an agent that remembers, and the log deliberately
 * does not carry it.
 *
 * The live kernel still has it. An agent's memory regions are bound to
 * physical keys inside the kernel's memory driver — with the default `inmem`
 * backing, in the kernel process's RAM. This command reaches in and reads
 * them: which regions a process has, how much is in each, who else can see
 * them, and the entries themselves.
 *
 * ## Why it needs a live kernel
 *
 * The memory lives in the kernel that owns it. There is no on-disk copy to
 * fall back on (the only other place a region's contents appear is inside a
 * `.csnap`, and that is a *snapshot* of a moment, not the present). So this
 * command says plainly that it needs one, rather than reporting an empty
 * region and letting the operator wonder whether the agent really had
 * forgotten everything.
 *
 * ## Reading vs writing
 *
 * This is a **read**. It is answered by the kernel's memory manager directly,
 * not through the dispatcher, and it is not recorded in the `.crec`: the
 * operator looking at a process's memory is not something the process did.
 * (An agent's own `ctx.memory_read()` is a syscall and is still recorded —
 * ABI.md §4.4. Only this view is not.)
 *
 * Usage:
 *   cortex memory <pid>                  list the process's regions
 *   cortex memory <pid> <region>         dump the region's entries
 *   cortex memory <pid> --region <name>  same, explicitly
 *   cortex memory <pid> --key <k>        one entry
 *   cortex memory <pid> --prefix <p>     entries whose key starts with p
 *
 * @module cli/commands/memory
 */

import { parseArgs } from 'node:util';

import { defaultKernelDir } from '../index.js';
import { probeKernel, KernelCommandError } from '../kernel_client.js';

/** What the kernel reports about one region. */
interface RegionInfo {
  readonly region: string;
  readonly kind: 'private' | 'shared' | 'cow';
  readonly backing: string;
  readonly readOnly: boolean;
  readonly refCount: number;
  readonly writes: number;
  readonly entries: number;
  readonly truncated: boolean;
  readonly sharedWith: readonly number[];
}

/** One entry of a dumped region. */
interface MemoryEntryView {
  readonly key: string;
  readonly value: unknown;
  readonly at: string;
}

interface MemoryListResult {
  readonly pid: number;
  readonly role: string;
  readonly regions: readonly RegionInfo[];
}

interface MemoryDumpResult {
  readonly pid: number;
  readonly role: string;
  readonly region: string;
  readonly entries: readonly MemoryEntryView[];
}

export async function cmdMemory(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      region: { type: 'string' },
      key: { type: 'string' },
      prefix: { type: 'string' },
      limit: { type: 'string' },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`cortex memory — what a running process knows

USAGE
  cortex memory <pid>                  List the process's memory regions
  cortex memory <pid> <region>         Dump one region's entries
  cortex memory <pid> --region <name>  Same, explicitly
  cortex memory <pid> --key <key>      One entry, by exact key
  cortex memory <pid> --prefix <p>     Entries whose key starts with <p>

OPTIONS
  --region <name>  Region to dump (default: the second positional)
  --key <key>      Read a single key
  --prefix <p>     Prefix scan
  --limit <n>      Maximum number of entries to return
  -h, --help       Show this help

NOTES
  This reads a LIVE kernel. An agent's memory lives in the kernel's memory
  driver — with the default 'inmem' backing, in the kernel process's RAM —
  so there is no on-disk copy to fall back on. Start one with
  'cortex daemon run'.

  The syscall log deliberately stores a HASH of a memory value rather than
  the value (ABI.md §4.4), so 'cortex trace' can show that an agent wrote
  something down but never what. This command shows what.

EXAMPLES
  cortex memory 2
  cortex memory 2 semantic
  cortex memory 2 --region semantic --key last_result
`);
    return values.help ? 0 : 1;
  }

  const raw = positionals[0]!;
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid < 0) {
    console.error(`cortex memory: invalid PID: '${raw}'`);
    return 1;
  }

  // The region may be given positionally or by flag.
  const region = values.region ?? positionals[1];

  let limit: number | undefined;
  if (values.limit !== undefined) {
    const parsed = Number.parseInt(values.limit, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      console.error(`cortex memory: invalid --limit: '${values.limit}' (expected a non-negative integer)`);
      return 1;
    }
    limit = parsed;
  }

  const dir = defaultKernelDir();
  const probe = await probeKernel(dir);
  if (probe.kind !== 'live') {
    if (probe.kind === 'stale') {
      console.error(
        `cortex memory: the kernel that published ${probe.endpoint.host}:${probe.endpoint.port} ` +
        `is not reachable (${probe.reason})`,
      );
    }
    console.error('cortex memory: no live kernel is running in this directory.');
    console.error("  a process's memory lives in the kernel that owns it — there is no");
    console.error('  on-disk copy to read instead. Start one with `cortex daemon run`.');
    return 1;
  }

  const client = probe.client;
  try {
    if (region === undefined) {
      const result = await client.request<MemoryListResult>('memory', { pid });
      printRegions(result);
      return 0;
    }

    const result = await client.request<MemoryDumpResult>('memory', {
      pid,
      region,
      ...(values.key !== undefined ? { key: values.key } : {}),
      ...(values.prefix !== undefined ? { prefix: values.prefix } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    printEntries(result);
    return 0;
  } catch (err) {
    if (err instanceof KernelCommandError) {
      console.error(`cortex memory: ${err.errno}: ${err.message}`);
      return 1;
    }
    throw err;
  } finally {
    client.close();
  }
}

/**
 * Render the region list.
 *
 * The `SHARED WITH` column is the one that matters most: a `shared` region
 * is visible to every process that declared it, so knowing that agent 3 is
 * reading agent 2's notes is the difference between a shared scratchpad and
 * a leak.
 */
function printRegions(result: MemoryListResult): void {
  console.log(`# memory of pid ${result.pid} (${result.role})`);

  if (result.regions.length === 0) {
    console.log('  (this process has no memory regions)');
    return;
  }

  const header =
    'REGION'.padEnd(16) +
    'KIND'.padEnd(10) +
    'BACKING'.padEnd(12) +
    'ENTRIES'.padEnd(10) +
    'SHARED WITH';
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const region of result.regions) {
    const count = region.truncated ? `${region.entries}+` : String(region.entries);
    const shared = region.sharedWith.length === 0 ? '-' : region.sharedWith.join(', ');
    console.log(
      region.region.padEnd(16) +
        region.kind.padEnd(10) +
        region.backing.padEnd(12) +
        count.padEnd(10) +
        shared,
    );
  }
}

/**
 * Render a region's entries.
 *
 * The value is printed as compact JSON — lossless for anything that came
 * through the wire, and greppable. A value that is not JSON-serialisable
 * falls back to `String(value)`, which is what the kernel's own serialiser
 * does.
 */
function printEntries(result: MemoryDumpResult): void {
  console.log(`# memory of pid ${result.pid} (${result.role}) — region '${result.region}'`);

  if (result.entries.length === 0) {
    console.log('  (no entries)');
    return;
  }

  const keyWidth = Math.min(40, Math.max(...result.entries.map((e) => e.key.length)));
  for (const entry of result.entries) {
    const key = entry.key.length > keyWidth ? `${entry.key.slice(0, keyWidth - 1)}…` : entry.key;
    console.log(`${key.padEnd(keyWidth)}  ${formatValue(entry.value)}  ${entry.at}`);
  }
  console.log(`# ${result.entries.length} entr${result.entries.length === 1 ? 'y' : 'ies'}`);
}

/** Render a memory value as compact JSON, or as a string when it cannot be. */
function formatValue(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}
