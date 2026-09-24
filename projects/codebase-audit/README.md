# codebase-audit

一个用 cortex 写的**真实**小项目：体检小队并行扫描当前目录的 TypeScript
源码，产出一份 markdown 体检报告。

它不是玩具 —— 扫的是真实文件，出的是真实数字。
`audit-report.sample.md` 是对 cortex 仓库自己跑出来的结果。

## 它长什么样

```
planner (pid 2)
├── todos      (pid 3)  → 统计 TODO / FIXME / HACK / XXX
├── longfiles  (pid 4)  → 找出最长的文件
└── hygiene    (pid 5)  → 统计 console.log 和 any
                          ↓ 写共享记忆 semantic
                      汇总成 audit-report.md
```

监督者给每个 worker 一个截止时间。超时**不会**自动杀进程 —— 超时只是「观察到
它没做完」，杀不杀、杀完怎么办，是你在 `catch` 里写的六行决定的。

## 怎么跑（Windows CMD）

在 cortex 仓库根目录：

```
cd /d F:\agent\cortex
node --import tsx src/cli/index.ts spawn --role auditor --module ./projects/codebase-audit/audit.ts --timeout 180000
```

应该看到：

```
[pid 2]
[planner pid 2] 发现 50 个 .ts 文件（上限 50）
[todos pid 3] 开始扫描 50 个文件
[todos pid 3] 完成
[planner] todos=ok(0)
...
[planner] 报告已写入 audit-report.md（44 行）
process exited (code 0: audit complete: 50 files)
```

然后当前目录下就有 `audit-report.md` 了。

### 想看「卡住 → 被 kill → 重启」

```
set AUDIT_CHAOS=1
set AUDIT_DEADLINE_MS=6000
node --import tsx src/cli/index.ts spawn --role auditor --module ./projects/codebase-audit/audit.ts --timeout 180000
```

`hygiene` 那个 worker 会假装卡死，你会看到：

```
[hygiene pid 5] AUDIT_CHAOS=1 —— 假装卡死（模拟永不返回的调用）
[planner] hygiene (pid 5) 超过 6000ms —— kill 后缩范围重启
[hygiene pid 6] 开始扫描 25 个文件
[hygiene pid 6] 完成
[planner] hygiene=respawned(0)
```

重启策略是「把扫描范围砍半再派一个」—— 这是真实有用的降级，不是演戏。

## 跑完之后：审计

cortex 真正值钱的地方在这儿 —— 每一次文件读取都是 syscall，全部落盘了：

```
node --import tsx src/cli/index.ts ps
node --import tsx src/cli/index.ts trace 2
```

你能完整回放：哪个 agent 在什么时候读了哪个文件、花了多久、可逆还是不可逆。
**普通脚本做不到这件事** —— 它跑完就什么都不剩了。

## 可配置项（环境变量）

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `AUDIT_MAX_FILES` | 50 | 最多扫多少个文件 |
| `AUDIT_DEADLINE_MS` | 20000 | 每个 worker 的截止时间 |
| `AUDIT_CHAOS` | 未设 | 设为 `1` 让 hygiene 假装卡死 |

## 想加一个检查项？

在 `audit.ts` 里加一个 worker，三步：

1. `WORKERS` 数组里加一个 id；
2. 照着 `scanTodos` 写一个 `scanXxx`（用 `ctx.tool_call('fs_read', ...)` 读文件，
   **别用 Node 的 fs** —— 那样不会进 syscall 日志，就白用了 cortex）；
3. `worker()` 的 switch 里加一个 case，再在 `renderReport` 里加一段 markdown。

监督、超时、重启、汇总这些都不用改 —— 那是内核的事。

## 换成真模型

目前这个项目不调 LLM，所以**离线、确定性、零成本**。想让它顺便给每类问题
写一句诊断意见，把 `scanXxx` 里那句换掉就行：

```ts
const res = await ctx.llm_call({ messages: [{ role: 'user', content: '评价一下这些 TODO' }] });
```

监督逻辑一行都不用动 —— 这正是 cortex 的分层：**内核管进程，agent 管业务**。
