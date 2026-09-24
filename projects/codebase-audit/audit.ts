/**
 * codebase-audit — 一个用 cortex 写的真实小项目。
 *
 * 做什么：一个「体检小队」并行扫描当前目录里的 TypeScript 源码，产出一份
 * markdown 体检报告。三个 worker 各负责一类检查，结果写进共享记忆，
 * 监督者汇总成报告落盘。
 *
 * 为什么值得用 cortex 写（而不是一个普通的 for 循环脚本）：
 *
 *   1. 每个 worker 是**进程**，不是函数。它有 PID、有截止时间、卡住了可以被
 *      kill 掉再换一个 —— 重启策略就写在下面的 catch 里，六行，没有外部编排器。
 *   2. 每一次文件读取都是一次 **syscall**（`tool_call`），全部落盘进 `.crec`。
 *      跑完之后 `cortex trace <pid>` 能完整回放：哪个 agent 读了哪个文件、
 *      花了多久。普通脚本做不到这件事。
 *   3. 可以设预算上限：`--token-budget` 让它花超了就停。
 *
 * 三个 worker：
 *   todos      — 统计 TODO / FIXME / HACK / XXX
 *   longfiles  — 找出最长的文件
 *   hygiene    — 统计 console.log 和 any
 *
 * 用法（在仓库根目录）：
 *
 *   node --import tsx src/cli/index.ts spawn --role auditor \
 *     --module ./projects/codebase-audit/audit.ts --timeout 180000
 *
 * 想看「卡住 → 被 kill → 重启」这条路径，加环境变量 AUDIT_CHAOS=1：
 * hygiene 那个 worker 会假装卡死，监督者会在截止时刻杀掉它、把扫描范围砍半、
 * 重新派一个。这是真实会发生的场景（某个模型调用永不返回），不是演戏。
 *
 * @module projects/codebase-audit/audit
 */

import type { CortexContext, MemoryRegionPolicy } from 'cortex-agent-os';

/**
 * 父进程把子进程指回本文件时必须用**绝对路径**：裸的相对路径会相对于
 * 内核（src/kernel/boot.ts）解析，而不是你的文件，子进程会 127 退出。
 */
const SELF = import.meta.url;

/** `semantic` 默认是 shared 区域，worker 写进去父进程能读到。 */
const RESULTS = 'semantic';

/**
 * 记忆区域是**按进程声明**的，不继承。父进程 spawn 子进程时必须再传一次，
 * 否则子进程的第一次 memory_write 会 trap ENOENT。
 */
const WORKER_MEMORY: Readonly<Record<string, MemoryRegionPolicy>> = {
  [RESULTS]: { kind: 'shared', backing: 'inmem' },
};

/** 每个 worker 的截止时间；超时不杀进程，只是观察到（kill 是下一步的决定）。 */
const DEADLINE_MS = Number(process.env['AUDIT_DEADLINE_MS'] ?? '20000');
/** 最多扫多少个文件（防止把整个 node_modules 读一遍）。 */
const MAX_FILES = Number(process.env['AUDIT_MAX_FILES'] ?? '50');
/** AUDIT_CHAOS=1 时让 hygiene 假装卡死，用来演示 kill + 重启。 */
const CHAOS = process.env['AUDIT_CHAOS'] === '1';

const WORKERS = ['todos', 'longfiles', 'hygiene'] as const;
type WorkerId = (typeof WORKERS)[number];

interface WorkerArgs {
  readonly kind: 'worker';
  readonly id: WorkerId;
  readonly files: readonly string[];
  /** 只有 chaos 模式下第一个 hygiene 才有。 */
  readonly chaos?: boolean;
}

function isWorker(args: Record<string, unknown>): args is WorkerArgs & Record<string, unknown> {
  return args['kind'] === 'worker';
}

/**
 * 这些目录不算「你的源码」。
 *
 * 注意 glob 在 Windows 上返回的是**反斜杠**路径（`dist\kernel\types.d.ts`），
 * 所以比较前先统一成正斜杠 —— 只写 `startsWith('dist/')` 会把整个 dist/ 放进来，
 * 报告里就全是编译出来的 .d.ts 了。
 */
function isNoise(p: string): boolean {
  const s = p.replace(/\\/g, '/');
  return (
    s.includes('node_modules') ||
    s.startsWith('dist/') ||
    s.includes('/dist/') ||
    s.startsWith('.cortex/') ||
    s.includes('/.cortex/')
  );
}

// ---------------------------------------------------------------------------
// 工具层：所有文件访问都走 ctx.tool_call，这样它们才会进 syscall 日志
// ---------------------------------------------------------------------------

async function globTs(ctx: CortexContext): Promise<readonly string[]> {
  const res = await ctx.tool_call('fs_glob', { pattern: '**/*.ts' });
  const out = res.output as { matches?: unknown };
  const matches = Array.isArray(out.matches) ? (out.matches as unknown[]) : [];
  return matches
    .filter((p): p is string => typeof p === 'string' && !isNoise(p))
    .slice(0, MAX_FILES);
}

async function readFile(ctx: CortexContext, path: string): Promise<string> {
  const res = await ctx.tool_call('fs_read', { path });
  const out = res.output as { content?: unknown };
  return typeof out.content === 'string' ? out.content : '';
}

// ---------------------------------------------------------------------------
// 三个 worker：每种检查一个
// ---------------------------------------------------------------------------

async function scanTodos(ctx: CortexContext, files: readonly string[]): Promise<Record<string, unknown>> {
  const perFile: { file: string; count: number }[] = [];
  let total = 0;
  for (const f of files) {
    const text = await readFile(ctx, f);
    const hits = text.match(/\b(TODO|FIXME|HACK|XXX)\b/g);
    const count = hits === null ? 0 : hits.length;
    if (count > 0) {
      perFile.push({ file: f, count });
      total += count;
    }
  }
  perFile.sort((a, b) => b.count - a.count);
  return { total, top: perFile.slice(0, 8) };
}

async function scanLongFiles(
  ctx: CortexContext,
  files: readonly string[],
): Promise<Record<string, unknown>> {
  const rows: { file: string; lines: number }[] = [];
  let totalLines = 0;
  for (const f of files) {
    const text = await readFile(ctx, f);
    const lines = text.length === 0 ? 0 : text.split('\n').length;
    rows.push({ file: f, lines });
    totalLines += lines;
  }
  rows.sort((a, b) => b.lines - a.lines);
  return { totalLines, top: rows.slice(0, 8) };
}

async function scanHygiene(ctx: CortexContext, files: readonly string[]): Promise<Record<string, unknown>> {
  let consoleLog = 0;
  let anyType = 0;
  const offenders: { file: string; any: number }[] = [];
  for (const f of files) {
    const text = await readFile(ctx, f);
    const logs = text.match(/\bconsole\.log\b/g);
    const anys = text.match(/:\s*any\b|\bas\s+any\b/g);
    const logCount = logs === null ? 0 : logs.length;
    const anyCount = anys === null ? 0 : anys.length;
    consoleLog += logCount;
    anyType += anyCount;
    if (anyCount > 0) offenders.push({ file: f, any: anyCount });
  }
  offenders.sort((a, b) => b.any - a.any);
  return { consoleLog, anyType, top: offenders.slice(0, 8) };
}

async function worker(ctx: CortexContext, args: WorkerArgs): Promise<void> {
  console.log(`[${args.id} pid ${ctx.pid}] 开始扫描 ${args.files.length} 个文件`);

  if (args.chaos === true) {
    console.log(`[${args.id} pid ${ctx.pid}] AUDIT_CHAOS=1 —— 假装卡死（模拟永不返回的调用）`);
    await ctx.sleep(DEADLINE_MS * 5);
  }

  let payload: Record<string, unknown>;
  switch (args.id) {
    case 'todos':
      payload = await scanTodos(ctx, args.files);
      break;
    case 'longfiles':
      payload = await scanLongFiles(ctx, args.files);
      break;
    case 'hygiene':
      payload = await scanHygiene(ctx, args.files);
      break;
  }

  await ctx.memory_write(RESULTS, `report:${args.id}`, { id: args.id, ...payload });
  console.log(`[${args.id} pid ${ctx.pid}] 完成`);
  ctx.exit(0, `${args.id} complete`);
}

// ---------------------------------------------------------------------------
// 监督者：派活 → 限时 → 超时就 kill + 缩范围重启 → 汇总 → 落盘
// ---------------------------------------------------------------------------

function renderReport(files: readonly string[], sections: Map<WorkerId, unknown>): string {
  const lines: string[] = [];
  lines.push('# 代码库体检报告', '');
  lines.push(`- 扫描文件数：**${files.length}**`);
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  lines.push('');

  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const rows = (v: unknown): { file: string; count?: number; lines?: number; any?: number }[] =>
    Array.isArray(v) ? (v as { file: string; count?: number; lines?: number; any?: number }[]) : [];

  const todos = (sections.get('todos') ?? {}) as Record<string, unknown>;
  lines.push('## 1. TODO / FIXME / HACK / XXX', '');
  lines.push(`共 **${num(todos['total'])}** 处。`, '');
  const todoRows = rows(todos['top']);
  if (todoRows.length > 0) {
    lines.push('| 文件 | 数量 |', '| --- | --- |');
    for (const r of todoRows) lines.push(`| ${r.file} | ${r.count ?? 0} |`);
  } else {
    lines.push('_没有发现。_');
  }
  lines.push('');

  const long = (sections.get('longfiles') ?? {}) as Record<string, unknown>;
  lines.push('## 2. 最长的文件', '');
  lines.push(`总行数 **${num(long['totalLines'])}**。`, '');
  const longRows = rows(long['top']);
  if (longRows.length > 0) {
    lines.push('| 文件 | 行数 |', '| --- | --- |');
    for (const r of longRows) lines.push(`| ${r.file} | ${r.lines ?? 0} |`);
  }
  lines.push('');

  const hyg = (sections.get('hygiene') ?? {}) as Record<string, unknown>;
  lines.push('## 3. 代码卫生', '');
  lines.push(`- \`console.log\`：${num(hyg['consoleLog'])} 处`);
  lines.push(`- \`any\` 类型：${num(hyg['anyType'])} 处`);
  lines.push('');
  const hygRows = rows(hyg['top']);
  if (hygRows.length > 0) {
    lines.push('| 文件 | any 数量 |', '| --- | --- |');
    for (const r of hygRows) lines.push(`| ${r.file} | ${r.any ?? 0} |`);
  }
  lines.push('');
  lines.push('---', '');
  lines.push('_由 cortex 体检小队生成：三个 worker 进程并行扫描，监督者汇总。_');

  return lines.join('\n');
}

async function planner(ctx: CortexContext): Promise<void> {
  const files = await globTs(ctx);
  console.log(`[planner pid ${ctx.pid}] 发现 ${files.length} 个 .ts 文件（上限 ${MAX_FILES}）`);

  for (const id of WORKERS) {
    const chaos = CHAOS && id === 'hygiene';
    const { pid } = await ctx.spawn({
      role: `auditor:${id}`,
      agent: {
        module: SELF,
        args: {
          kind: 'worker',
          id,
          files,
          ...(chaos ? { chaos: true } : {}),
        },
      },
      memory: WORKER_MEMORY,
    });

    try {
      const res = await ctx.wait(pid, { timeoutMs: DEADLINE_MS });
      console.log(`[planner] ${id}=ok(${res.exitCode})`);
    } catch {
      // ETIMEDOUT。注意：超时只是「观察到它没做完」，进程还活着 ——
      // 要不要杀、杀完怎么办，是这一行代码决定的事，不是内核替你决定的。
      console.log(`[planner] ${id} (pid ${pid}) 超过 ${DEADLINE_MS}ms —— kill 后缩范围重启`);
      await ctx.kill(pid, 'SIGKILL');
      const half = files.slice(0, Math.max(1, Math.floor(files.length / 2)));
      const { pid: retry } = await ctx.spawn({
        role: `auditor:${id}`,
        agent: { module: SELF, args: { kind: 'worker', id, files: half } },
        memory: WORKER_MEMORY,
      });
      const res = await ctx.wait(retry, { timeoutMs: DEADLINE_MS });
      console.log(`[planner] ${id}=respawned(${res.exitCode})`);
    }
  }

  // 从共享记忆里把三个 worker 的产出收回来（semantic 是 shared 区域）。
  const entries = await ctx.memory_read(RESULTS, { prefix: 'report:' });
  const sections = new Map<WorkerId, unknown>();
  for (const e of entries) {
    const v = e.value as { id?: string } | null;
    if (v !== null && typeof v === 'object' && typeof v['id'] === 'string') {
      sections.set(v['id'] as WorkerId, v);
    }
  }

  const report = renderReport(files, sections);
  await ctx.tool_call('fs_write', { path: 'audit-report.md', content: report });
  console.log(`[planner] 报告已写入 audit-report.md（${report.split('\n').length} 行）`);

  ctx.exit(0, `audit complete: ${files.length} files`);
}

export default async function audit(
  ctx: CortexContext,
  args: Record<string, unknown> = {},
): Promise<void> {
  if (isWorker(args)) {
    await worker(ctx, args);
    return;
  }
  await planner(ctx);
}
