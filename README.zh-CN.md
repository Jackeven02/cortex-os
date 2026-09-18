# cortex

> AI agent 的操作系统。

[![status](https://img.shields.io/badge/status-v0%20%C2%B7%20phases%200%E2%80%934%20complete-brightgreen)](./MANIFESTO.md)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![runtime](https://img.shields.io/badge/runtime-TypeScript%20%2F%20Node%2022%2B-3178c6)](./package.json)

[English](./README.md) | **简体中文**

**今天的 agent 框架把 agent 当函数。Cortex 把它当进程。**

PID。Fork。Exec。Signals。IPC。Checkpoint。Restore。监督树。Syscall 追踪。Token 预算。进程组。Unix 在 1975 年给程序的所有东西，2026 年给 agent 再来一遍。

先读 **[Manifesto](./MANIFESTO.md)**（[中文版](./MANIFESTO.zh-CN.md)）。短、有立场、解释这个项目为什么存在。

---

## 它长这样

```bash
# 把 agent 作为后台进程 spawn 出来
$ cortex spawn --role coder --task "fix issue #42"
[pid 1234]

# 看进程树
$ cortex ps
PID    PPID   ROLE       STATE     TOKENS   AGE
1234   1      coder      running   12.3k    2m
1235   1234   tester     waiting   0        30s
1236   1234   reviewer   blocked   2.1k     10s

# 跟随一个正在跑的 agent 的 syscall 流（对它的 .crec 做 tail -f）
$ cortex attach 1234
# attach .cortex/processes/1234.crec (follow-mode)
14:23:01 1234  __state     exit  idempotent
14:23:01 1234  memory_read  exit  idempotent
14:23:04 1234  llm_call     exit  reversible
# （交互式发送 / 实时 prompt 随 cortex daemon install 落地，#039）

# fork 状态，去试另一条路
$ cortex fork 1234
[forked as pid 1240]
$ cortex send 1240 "try dynamic programming instead"

# 对比两个分支，挑一个赢家
$ cortex diff 1234 1240

# 追踪每一次 syscall
$ cortex trace 1234
14:23:01 llm_call(prompt=..., tools=[grep,edit]) -> "I'll search..."
14:23:04 tool_call(grep, "TypeError") -> "src/foo.ts:42"
14:23:06 llm_call(...) -> "Found it, editing now"

# 跨重启暂停和恢复
$ cortex checkpoint 1234 --tag "before risky edit"
$ cortex kill 1234
# ... 第二天 ...
$ cortex restore --tag "before risky edit"
[restored as pid 1502]

# 注册一个开机自启的长命 agent，并监督它
$ cortex daemon install inbox-watcher --role inbox-watcher \
    --module ./examples/checkpoint-agent.ts --restart on-failure
[daemon inbox-watcher] installed (role=inbox-watcher, restart=on-failure)
$ cortex daemon run inbox-watcher
[daemon inbox-watcher pid 2] running (restart=on-failure)
```

上面这些**大部分现在就能跑** —— `spawn`、`ps`、`kill`、`trace`、`attach`、`fork`、`diff`、`checkpoint`、`restore`、`send`、`limit`、`audit`、`daemon` 都已实现，并且被冒烟测试套件覆盖。`attach` 在 v0 里是一个只读的、基于磁盘的 follow-mode syscall 追踪（它对磁盘上的 `.crec` 做 tail，而不是连一个活着的内存进程 —— 它诚实的说明见 [BACKLOG.md](./BACKLOG.md) #031）；`cortex daemon run` 才是真正的长命监督者（BACKLOG #039）。七个驱动（LLM、MCP、文件系统、记忆）全部交付。哪些做完了、下一步做什么，见 [BACKLOG.md](./BACKLOG.md)。

---

## 当前状态

**Phase 0 — 设计（完成）。** 四份文档 v0 落地：`STATE.md`（最难的那份）、`PROCESS.md`（生命周期）、`ABI.md`（syscall 契约）、`ARCHITECTURE.md`（内核模块）。每份文档末尾的 open questions 是有意滚动记录的，会随着实现逼出决定而解决。

**Phase 1–3 —— 大体完成。** 内核能启动；十个内核模块加上驱动注册表都在；七个驱动全部交付（mock / deepseek / openai 三个 LLM，MCP 与文件系统两个工具驱动，inmem 与 sqlite 两个记忆驱动）；CLI 大部分可用。`cortex spawn → llm_call → exit → reap` 能跑，checkpoint/restore 能跨不同的 CLI 调用存活。v0 的已知缺口都诚实地记录在 [BACKLOG.md](./BACKLOG.md) 里，没有藏。

**Phase 4 —— 杀手级 demo。** 三个 demo 全部打磨完毕，并录成了回放。Demo A（监督树）：几个 coder 各自生成一个虚构库 README 的一个章节（见 `examples/supervision-tree.ts`、[`docs/demo-a.html`](./docs/demo-a.html)、`docs/demo-a.gif`）。Demo B（跨重启暂停）：一个收件箱监听器给工单分类，跑到一半 checkpoint，重启后恢复（见 `examples/checkpoint-agent.ts`、[`docs/demo-b.html`](./docs/demo-b.html)、`docs/demo-b.gif`）。Demo C（fork 对比）：一个 coder fork 出两个分支并行探索两种去重策略，然后 `cortex diff` 把两个分支对齐，好让你留下赢的那个（见 `examples/fork-compare-agent.ts`、[`docs/demo-c.html`](./docs/demo-c.html)、`docs/demo-c.gif`）。`cortex attach` 以 follow-mode syscall 追踪的形式交付（BACKLOG #031），`cortex daemon install/run` 能注册并监督长命 agent，正是它让 `attach` 的交互式发送成为可能（BACKLOG #039）。**Phase 3 至此完成** —— 上面 demo 里的每一条命令都能跑。

Demo A 值得单独说一下，因为它改变了内核：以前 agent 会在派发它的那个 quantum 里跑到结束，所以一个停在 `wait()` 里的父进程会一直占着自己的 tick，它的子进程永远没法被调度 —— `wait()` 在结构上就死锁，监督树根本写不出来。现在 continuation 是协作式的（见 PROCESS.md §8.2），所以下面这些不需要任何编排器就能跑：

![Demo A: a supervision tree](./docs/demo-a.gif)
*（实时回放：[`docs/demo-a.html`](./docs/demo-a.html)。GIF 由 `examples/make-demo-a-gif.py` 生成，需要先装 Pillow。）*

planner spawn 三个 coder，每个 coder 为一个虚构库（"tinylog"）生成一份真实 README 的一个章节，并把它发布到一个共享的 `semantic` 记忆区域。其中一个 coder（"api"）卡住了 —— 一次永不返回的模型调用 —— 于是 planner 通过一个带超时的 `wait` 察觉，把它 kill，spawn 一个替补，然后从三个章节组装出最终 README：

```bash
$ cortex spawn --role planner --module ./examples/supervision-tree.ts
[planner pid 2] spawning 3 coders (tinylog README)
[coder api pid 5] slow model — will miss its deadline
[planner] api (pid 5) missed its 8000ms deadline — killing
[coder api#2 pid 6] generating section: api
[planner] overview=ok(0) install=ok(0) api=respawned(0)
[planner] assembled README.md: # tinylog / ## Overview / ## Install / ## API
process exited (code 0: planner complete: overview=ok(0),install=ok(0),api=respawned(0))
```

Demo B 把「重启」这个故事变得具体。一个 checkpoint 捕获的是**进程镜像** —— 记忆区域、预算、血缘 —— 而不是活的 JS 调用栈，所以在 `restore` 时 agent 会从头重跑，靠读自己的 `episodic` 标记来跳过已经处理过的工单（这是被文档化的幂等模式，不是内核特性）。结果就是一个扛过一次断电、零工作丢失的长命 agent：

![Demo B: pause across reboots](./docs/demo-b.gif)
*（实时回放：[`docs/demo-b.html`](./docs/demo-b.html)。GIF 由 `examples/make-demo-b-gif.py` 生成，需要先装 Pillow。）*

收件箱监听器给每张工单分类（`bug` / `feature` / `question`），把回复草稿写进共享的 `semantic` 区域，并把已处理的 id 记到 `episodic`。处理完三张之后它 checkpoint 并 detach；重启之后，`cortex restore` 把它重新物化成一个新的 PID，它读回 `done` 集合，跳过那三张已经处理过的，然后把队列跑完：

```bash

$ cortex spawn --role inbox-watcher --module ./examples/checkpoint-agent.ts
[inbox-watcher pid 2] 6 tickets in queue
[inbox-watcher pid 2] #T-1180 App crashes on launch after the 2.3 update -> bug; reply drafted
[inbox-watcher pid 2] #T-1181 Can I export my data to CSV? -> feature; reply drafted
[inbox-watcher pid 2] #T-1182 How do I reset my password? -> question; reply drafted
[inbox-watcher pid 2] 3/6 handled — checkpointing (tag 'inbox-watcher') before shutdown
process suspended at checkpoint
###  laptop reboots - kernel torn down, .csnap persists on disk  ###
$ cortex restore --tag inbox-watcher
[inbox-watcher pid 3] recovered 3 processed ticket(s) from memory
[inbox-watcher pid 3] skip T-1180 (already handled)
[inbox-watcher pid 3] skip T-1181 (already handled)
[inbox-watcher pid 3] skip T-1182 (already handled)
[inbox-watcher pid 3] #T-1183 Dark mode flickers on Windows 11 -> bug; reply drafted
[inbox-watcher pid 3] #T-1184 Please add keyboard shortcuts for navigation -> feature; reply drafted
[inbox-watcher pid 3] #T-1185 I was charged twice this month -> bug; reply drafted
[inbox-watcher pid 3] inbox cleared (6/6)
process exited (code 0: inbox cleared)
```

Demo C 是「agent 搜索」的原子操作：走到一个决策点，`fork` 一次性探索所有分支，然后 `diff` 并留下赢家。coder 确立一个需求，fork，两个分支各采用一种不同的去重设计（counting Bloom filter vs LRU 有界哈希集合）—— 子进程从头重跑，并通过一个在 fork **之前**写下的 `forked` 标记知道自己就是那个 fork（完整模式见示例文件头部）。内核保证两个 tail 干净地分叉，`cortex diff` 从共享因果历史开始对齐它们：

![Demo C: fork and compare](./docs/demo-c.gif)
*（实时回放：[`docs/demo-c.html`](./docs/demo-c.html)。GIF 由 `examples/make-demo-c-gif.py` 生成，需要先装 Pillow。）*

```bash
$ cortex spawn --role demo --module ./examples/fork-compare-agent.ts
[parent 2] forked as pid 3 — branch A: counting bloom filter
[branch A pid 2] {"approach":"counting bloom filter","spaceComplexity":"O(k) bits, ...}
[branch B pid 3] resumed from the fork's snapshot
[branch B pid 3] {"approach":"lru-bounded hash set","spaceComplexity":"O(cap) entries, ...}
process exited (code 0: branch A complete)

$ cortex diff 2 3
  diverged after 4 shared syscall(s) — fork recorded in pid 2 at byte offset 1712
  syscall diff   (4 shared, - 6 A-only, + 8 B-only)
  - 15:21:58.345  fork         out {"childChainId":"9c7acbf9-...","c...
  - 15:21:58.346  llm_call     in  {"messages":[{"content":"Design dedup with a counting Blo...
  + 15:21:58.352  llm_call     in  {"messages":[{"content":"Design dedup with an LRU-bounded...
  + 15:21:58.353  exit         out {"code":0,"reason":"branch B complete"}
  summary
    records   14            12      syscalls  10        8
    exit      0 branch A    0 branch B
  last llm_call output
    A: mock reply to: Design dedup with a counting Bloom filter.
    B: mock reply to: Design dedup with an LRU-bounded hash set.
```

完整清单（按优先级排）见 **[BACKLOG.md](./BACKLOG.md)**。

---

## 文档

| 文档 | 内容 |
|---|---|
| [MANIFESTO.md](./MANIFESTO.md) | cortex 为什么存在。先读这个。（[中文](./MANIFESTO.zh-CN.md)） |
| [docs/STATE.md](./docs/STATE.md) | **最难的部分。** agent state 是什么，fork 时复制什么，什么根本不能复制。（[中文](./docs/STATE.zh-CN.md)） |
| [docs/PROCESS.md](./docs/PROCESS.md) | agent 生命周期：8 个状态、12 个合法转换、signals、调度 |
| [docs/ABI.md](./docs/ABI.md) | syscall 契约：19 个 syscall、3 个 driver 接口、错误模型、记录格式 |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 内核模块和数据流：11 个模块、syscall 生命周期、持久化布局、并发模型 |
| [docs/HACKING.md](./docs/HACKING.md) | 贡献者指南：开发环境、约定、怎么写驱动 / agent / syscall、测试。 |
| [docs/COOKBOOK.md](./docs/COOKBOOK.md) | 配方：监督树、暂停与恢复、fork 对比、daemon、工具、IPC、预算。 |
| [docs/CRITIQUE.md](./docs/CRITIQUE.md) | 外部批评的滚动记录，以及我们因此改了什么。 |
| [BACKLOG.md](./BACKLOG.md) | 第一批 issue，按优先级排好 |

---

## 设计血统

Cortex 是这样一个假设的产物：如果 **Plan 9**、**Erlang/OTP**、**MINIX** 当初是为 LLM agent 设计的（而不是文件系统、电信交换机、教学内核），它们会长成什么样。

我们无耻地借鉴：

- 从 Unix：进程、signals、文件描述符、"一切皆文件"。
- 从 Plan 9：syscall 作为干净统一的接口；协议作为万能溶剂。
- 从 Erlang：监督树、热代码重载、"let it crash"。
- 从 MINIX：微内核纪律、小即是美德。
- 从 seL4：对形式化保证的长期向往。

---

## 参与贡献

内核能启动、驱动能交付、CLI 也完整了 —— 所以现在就从这个文件开始：[docs/HACKING.md](./docs/HACKING.md)。当下最有价值的贡献：

1. **争论。** 开 issue 告诉我们某个 syscall 为什么是错的、缺的、或多余的。
2. **prior art。** 指出已经做了其中一部分的现有系统（研究或生产）。
3. **benchmark。** 提出内核必须优雅处理的 workload。
4. **代码。** 写一个驱动、加一个 syscall、或关掉一个 [BACKLOG.md](./BACKLOG.md) 里的条目 —— 并顺手往 `scripts/smoke.ts` 里加一条 `check`。

如果你想和我们一起做 agent 的 OS 层，开一个标题为 `[hello]` 的 issue，告诉我们你关心什么。

---

## License

MIT。见 [LICENSE](./LICENSE)。

---

## 关于这个名字

*cortex*（皮层）是器官外层负责有意思的工作的那一层 —— 大脑皮层（cerebral cortex）、肾上腺皮质（adrenal cortex）、肾皮质（renal cortex）。它不是整个大脑。它是负责思考的那一层。

这个内核想成为的就是这个：不是整个 agent 栈，而是让其他一切成为可能的那层薄皮。
