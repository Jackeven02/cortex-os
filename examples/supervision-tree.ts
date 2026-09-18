/**
 * Example: a supervision tree (Demo A — BACKLOG #043, polished).
 *
 *   cortex spawn --role planner --module ./examples/supervision-tree.ts
 *
 * A planner spawns three parallel coders. Each coder generates ONE section of
 * a real README for a fictional library ("tinylog") and publishes it to a
 * shared `semantic` memory region. One coder ("api") hangs — standing in for a
 * model call that never returns — so the planner notices (a bounded `wait`),
 * kills it, spawns a replacement, and assembles the finished README from the
 * three sections. There is **no glue code**: no orchestrator script, no polling
 * loop, no supervisor process outside this file. The tree *is* the planner
 * agent, written with four syscalls — `spawn`, `wait`, `kill`, and
 * `memory_read`.
 *
 * ## Why this demos something
 *
 * The interesting part is that the planner is a *process*, not a driver. While
 * it sits in `wait()`, the scheduler is free to run its children; when a child
 * exits, the kernel wakes the planner and it continues at the next statement.
 * That is only possible because the agent continuation is cooperative — see
 * boot.ts, "The execution model". Before that rework, a parent parked in
 * `wait()` held its own quantum forever and the child it was waiting for could
 * never be dispatched: the tree deadlocked by construction.
 *
 * Two kernel details this file leans on:
 *
 *   • **`wait(pid, { timeoutMs })`** — a deadline on a child. Without it the
 *     only way to notice a hang is to poll `ps()` in a loop, i.e. glue code
 *     outside the supervisor. On timeout the syscall traps `ETIMEDOUT` and the
 *     child is left *running*: killing it is a separate decision, expressed
 *     here as `kill(pid, 'SIGKILL')` followed by a respawn. That is a restart
 *     policy in six lines, chosen by the person who understands the work.
 *   • **A `shared` memory region** (`semantic`) — the coders publish their
 *     sections where the planner can read them. The default regions are
 *     episodic=cow, semantic=shared, procedural=private (docs/STATE.md §2.3),
 *     so a coder writing to `semantic` is visible to its parent, while its
 *     private scratch state is not.
 *
 * ## The "real task"
 *
 * Each coder writes a genuine markdown section via `renderSection()` below. In
 * production that function is where you would call `ctx.llm_call(...)`; the
 * local generator keeps this demo offline and deterministic so it reproduces
 * identically in CI and in the README GIF. Swap the one line to use a real
 * model and the demo is unchanged.
 *
 * ## Args
 *
 * The same module plays both roles; `AgentSpec.args` decides which. Spawn the
 * planner with no args and it spawns coders pointing back at this file with
 * `{ kind: 'coder' }`:
 *
 *   planner: `{}`                                       → runs the tree
 *   coder:   `{ kind: 'coder', id, section, hang? }`    → one worker
 *
 * @module examples/supervision-tree
 */

import type { CortexContext, MemoryRegionPolicy } from '../src/index.js';

/**
 * How the planner points its children back at this file.
 *
 * It must be **absolute**: a bare `import()` resolves a relative specifier
 * against the *importing* module (the kernel, `src/kernel/boot.ts`), not
 * against the cwd — so `'./examples/supervision-tree.ts'` would look for
 * `src/kernel/examples/...` and the coders would exit 127 "agent load failed".
 * `import.meta.url` is this module's own URL, which is what the CLI passes for
 * `--module` too (it converts the path with `pathToFileURL`), so parent and
 * children end up loading the identical module identity.
 */
const SELF = import.meta.url;
/** `semantic` is `shared` by default — see docs/STATE.md §2.3. */
const RESULTS = 'semantic';
/**
 * Regions are declared per-process, not inherited: a child spawned without a
 * `memory` map has no regions at all, and its first `memory_write` traps
 * ENOENT. `cortex spawn` declares the three standard regions for the process
 * *it* creates (the planner), so the planner has them — but it must declare
 * them again for the coders it spawns itself.
 *
 * `inmem` is the built-in memory driver the CLI defaults to.
 */
const CODER_MEMORY: Readonly<Record<string, MemoryRegionPolicy>> = {
  [RESULTS]: { kind: 'shared', backing: 'inmem' },
};
/**
 * How long the planner gives each coder before it calls the child hung.
 * Override with `args.deadlineMs` when spawning the planner. Keep it under the
 * CLI's `--timeout` (default 30000) or the kernel will be torn down first.
 */
const DEFAULT_DEADLINE_MS = 8000;
/** Order the assembled README is printed in (independent of arrival order). */
const SECTION_ORDER = ['overview', 'install', 'api'] as const;
type SectionId = (typeof SECTION_ORDER)[number];

interface CoderArgs {
  readonly kind: 'coder';
  /** Label shown in logs (e.g. `api` or, after a respawn, `api#2`). */
  readonly id: string;
  /** Which README section this coder produces. */
  readonly section: SectionId;
  /** Set on one child to make this demo show a kill + respawn. */
  readonly hang?: boolean;
}

function isCoder(args: Record<string, unknown>): args is CoderArgs & Record<string, unknown> {
  return args['kind'] === 'coder';
}

// ---------------------------------------------------------------------------
// The real task: render one README section for the fictional "tinylog" lib.
// In production, replace the body with `await ctx.llm_call({ messages: [...] })`
// and use `res.text` — the supervisor logic around it does not change.
// ---------------------------------------------------------------------------

function renderSection(section: SectionId): string {
  switch (section) {
    case 'overview':
      return [
        '## Overview',
        '',
        'tinylog is a structured logger you can still read at 2am. Twelve lines of',
        'source, zero dependencies, one `log` export.',
        '',
        '```ts',
        "import { log } from 'tinylog';",
        '',
        "log.info('boot', { pid: process.pid });",
        "log.error('db', { err: 'down' });",
        '```',
      ].join('\n');
    case 'install':
      return [
        '## Install',
        '',
        '```bash',
        'npm install tinylog',
        '```',
        '',
        '```ts',
        "import { log } from 'tinylog';",
        '',
        "log.level = 'debug';",
        "log.info('ready');",
        '```',
      ].join('\n');
    case 'api':
      return [
        '## API',
        '',
        '- `log(level, msg, meta?)` — emit one structured line.',
        '- `log.child(meta)` — derive a child logger that merges `meta` into every line.',
        "- `log.level` — `'debug' | 'info' | 'warn' | 'error'` (default `'info'`).",
      ].join('\n');
    default:
      return `## ${section}\n\n(no content)`;
  }
}

// ---------------------------------------------------------------------------
// The worker: renders one section, publishes it to the shared region.
// ---------------------------------------------------------------------------

async function coder(ctx: CortexContext, args: CoderArgs): Promise<void> {
  console.log(`[coder ${args.id} pid ${ctx.pid}] generating section: ${args.section}`);

  if (args.hang === true) {
    // Stands in for the failure mode this demo exists to survive: a model call
    // that never comes back, a tool that hangs, an infinite reasoning loop.
    console.log(`[coder ${args.id} pid ${ctx.pid}] slow model — will miss its deadline`);
    await ctx.sleep(DEFAULT_DEADLINE_MS * 8);
    return;
  }

  const markdown = renderSection(args.section);
  await ctx.memory_write(RESULTS, `section:${args.section}`, {
    id: args.id,
    section: args.section,
    markdown,
  });
  console.log(`[coder ${args.id} pid ${ctx.pid}] section ready`);
  ctx.exit(0, `coder ${args.id} complete`);
}

// ---------------------------------------------------------------------------
// The supervisor: spawn, bound, kill, respawn, gather, assemble.
// ---------------------------------------------------------------------------

async function planner(ctx: CortexContext, deadlineMs: number): Promise<void> {
  const tasks: readonly { readonly id: string; readonly section: SectionId; readonly hang?: boolean }[] = [
    { id: 'overview', section: 'overview' },
    { id: 'install', section: 'install' },
    { // The one that hangs — the whole point of the demo.
      id: 'api',
      section: 'api',
      hang: true,
    },
  ];

  console.log(`[planner pid ${ctx.pid}] spawning ${tasks.length} coders (tinylog README)`);
  const children = [];
  for (const t of tasks) {
    const { pid } = await ctx.spawn({
      role: `coder:${t.id}`,
      agent: {
        module: SELF,
        args: {
          kind: 'coder',
          id: t.id,
          section: t.section,
          ...(t.hang === true ? { hang: true } : {}),
        },
      },
      memory: CODER_MEMORY,
    });
    children.push({ ...t, pid });
  }

  // --- Bound every child, and act on the ones that miss their deadline. -----
  const outcomes: string[] = [];
  for (const child of children) {
    try {
      const res = await ctx.wait(child.pid, { timeoutMs: deadlineMs });
      outcomes.push(`${child.id}=ok(${res.exitCode})`);
    } catch {
      // Missed the deadline. The child is still running — a timeout is an
      // observation, not a punishment. Deciding what to do about it is ours.
      console.log(`[planner] ${child.id} (pid ${child.pid}) missed its ${deadlineMs}ms deadline — killing`);
      await ctx.kill(child.pid, 'SIGKILL');
      // ...and the restart policy: same section, fresh process, no hang.
      const { pid } = await ctx.spawn({
        role: `coder:${child.id}`,
        agent: {
          module: SELF,
          args: { kind: 'coder', id: `${child.id}#2`, section: child.section },
        },
        memory: CODER_MEMORY,
      });
      const res = await ctx.wait(pid);
      outcomes.push(`${child.id}=respawned(${res.exitCode})`);
    }
  }

  // --- Gather the sections the coders published into shared memory. ---------
  const published = await ctx.memory_read(RESULTS, { prefix: 'section:' });
  const bySection = new Map<string, string>();
  for (const entry of published) {
    const v = entry.value as { readonly section?: string; readonly markdown?: string };
    if (v.section !== undefined && v.markdown !== undefined) bySection.set(v.section, v.markdown);
  }

  // --- Assemble the finished README in a fixed, sensible order. -------------
  const parts = ['# tinylog', '', '> A 12-line structured logger for Node.', ''];
  for (const section of SECTION_ORDER) {
    const md = bySection.get(section);
    if (md !== undefined) parts.push(md, '');
  }
  const readme = parts.join('\n').trimEnd() + '\n';

  console.log(`[planner] ${outcomes.join(' ')}`);
  const readmeLines = readme.split('\n');
  const width = Math.min(78, Math.max(40, ...readmeLines.map((l) => l.length)));
  const rule = '+' + '-'.repeat(width + 2) + '+';
  console.log('[planner] assembled README.md:');
  console.log(rule);
  for (const line of readmeLines) console.log(`| ${line.padEnd(width)} |`);
  console.log(rule);

  ctx.exit(0, `planner complete: ${outcomes.join(',')}`);
}

export default async function supervisionTree(
  ctx: CortexContext,
  args: Record<string, unknown> = {},
): Promise<void> {
  if (isCoder(args)) {
    await coder(ctx, args);
    return;
  }
  const deadlineMs =
    typeof args['deadlineMs'] === 'number' ? (args['deadlineMs'] as number) : DEFAULT_DEADLINE_MS;
  await planner(ctx, deadlineMs);
}
