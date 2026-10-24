# cortex

> AI agent 的操作系统。

[![release](https://img.shields.io/badge/release-v1.2.0-brightgreen)](./CHANGELOG.md)
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
PID  PPID  ROLE            STATE    TOKENS      CAPS  AGE  NOTE
---------------------------------------------------------------
1    -     init            running  0 of ∞      all   19s
2    1     holder          blocked  0 of 20.0k  all   19s  a channel — SIGTERM queued
3    1     planner         blocked  0 of ∞      all   19s  child 6 — SIGCHLD queued
4    3     coder:overview  zombie   0 of ∞      all   2s   exit 137 (signal:SIGKILL)
5    3     coder:install   zombie   0 of ∞      all   2s   exit 137 (signal:SIGKILL)
6    3     coder:api       blocked  0 of ∞      all   19s  a timer

# 同样这些进程，但按它们真实的父子关系画成树，
# 并标出各自在等什么、已经等了多久。
# AGE 是每个进程活了多久：已经结束的两个显示内核记下的
# 存活时长（2s），而且到那里就不再增长；还在跑的两个仍在变老（19s）。
$ cortex top
cortex top — 6 processes · 3 blocked · 2 zombie · 1 running · live kernel
0 tokens · $0.000000 spent · home .cortex

      PID  ROLE            STATE    TOKENS      USD                     AGE  NOTE
---------------------------------------------------------------------------------
      1    init            running  0 of ∞      $0.000000 of ∞          19s  3 syscalls
├─    2    holder          blocked  0 of 20.0k  $0.000000 of $1.000000  19s  waiting on a channel for 18.8s — SIGTERM queued
└─    3    planner         blocked  0 of ∞      $0.000000 of ∞          19s  waiting on child 6 for 18.8s — SIGCHLD queued
   ├─ 4    coder:overview  zombie   0 of ∞      $0.000000 of ∞          2s   exit 137 (signal:SIGKILL)
   ├─ 5    coder:install   zombie   0 of ∞      $0.000000 of ∞          2s   exit 137 (signal:SIGKILL)
   └─ 6    coder:api       blocked  0 of ∞      $0.000000 of ∞          19s  waiting on a timer for 18.8s

trace one:   cortex trace <pid>      follow one:  cortex attach <pid>

# ...以及卡住的那几个，顺带把该跑的命令给你
$ cortex top --stall-after 5000
# pid 2 has been inside recv for 18830ms — over your 5000ms threshold.
#   cortex supervise 2 --kill-after 5000
# pid 3 has been inside wait for 18821ms — over your 5000ms threshold.
#   cortex supervise 3 --kill-after 5000

# 这个 agent 一共可以花多少，以及还剩多少
# （运行中 agent 的预算在内核里，所以这需要活内核：`cortex daemon run`；
#   已经结束的进程则从它的退出记录里回答）
$ cortex limit 1234
pid 1234 (coder):
  tokens:    spent 12300 / limit 20000 (7700 left)
  usd:       spent $0.014000 / limit $1.000000 ($0.986000 left)
  wall time: spent 120000ms / limit ∞
$ cortex limit 1234 --tokens 20000   # 上限是 20000 —— 不是在原有基础上再加
set the budget for 1234 (coder):
  tokens:    spent 12300 / limit 20000 (7700 left)

# 跟随一个正在跑的 agent 的 syscall 流（有内核时是推送）
$ cortex attach 1234
# attach .cortex/processes/1234/log.crec (live — frames by push from the kernel)
time          pid     syscall                                                    phase  duration   reversibility spend
----------------------------------------------------------------------------------------------------------------------
14:23:01.402  1234    memory_read                                                 exit   -          idempotent
14:23:04.115  1234    llm_call                                                   exit   2523ms     reversible    $0.000161 · 1.2k in / 80 out (900 cached)
14:23:06.221  1234    __state:running->exiting(exit)                             exit   -          idempotent
# pid 1234 exited with code 0 (completed)
# detached
# （有活内核时：cortex attach 1234 --interactive
#  会把你输入的每一行投递到运行中的 agent）

# fork 状态，去试另一条路
# （fork 快照的是**正在运行**的进程，所以这需要活内核：
#  `cortex daemon run` —— 子进程会留在那个内核里）
$ cortex fork 1234 --tag "try the other way"
forked pid 1234 → child pid 1240
  chain: 7c1f0f2e-...
  shared causal past at offset: 18244
$ cortex send 1240 "try dynamic programming instead"

# 对比两个分支，挑一个赢家
$ cortex diff 1234 1240

# 把录下来的 agent（或者整棵监督树）再跑一遍，看它是不是还那样行事。
# 模型、工具、时钟、随机数全部由录制作答，所以对比的是 agent 本身，不是世界。
# 每个进程都由**自己**那份录制来作答。
$ cortex replay 1234
  recording: 2 process(es) — pid 1234, pid 1235
  pid 1234: recording 23 call(s), replay 23 call(s)
  pid 1235: recording 4 call(s), replay 4 call(s)
  REPRODUCED — every process made the same calls, in the same order,
  with the same outcomes.
# （如果 agent 的代码变了，它会指出**在哪里**变的，以及**是哪个进程**变的：
#  DIVERGED — pid 1235 did not reproduce the recording.
#  #3 changed
#      the request differs at request.messages[1].content
#        recorded: "summarise the diff"
#        replay:   "summarise the log"）

# 追踪每一次 syscall
$ cortex trace 1234
# tracing .cortex/processes/1234/log.crec
time          pid     syscall                                                    phase  duration   reversibility spend
----------------------------------------------------------------------------------------------------------------------
14:23:01.402  1234    llm_call                                                   exit   2523ms     reversible    $0.000161 · 1.2k in / 80 out (900 cached)
14:23:04.115  1234    tool_call                                                  exit   -          irreversible
14:23:06.221  1234    __state:running->exiting(exit)                             exit   -          idempotent
# 3 record(s)
# （内核自己的帧也有名字 —— 而且它们说清了**为什么**：
#  __state:running->blocked(recv)、__state:new->ready(spawn)、
#  __init:restart-gave-up、__sched:parked(recv)、__signal:SIGTERM(queued) —— 所以一份日志
#  读起来就是它本来该是的那个故事，而不是一排匿名占位符）
# （而一次花了东西的调用会说出它花了什么：先说价格，再说它读了多少、
#  写了多少 token，以及输入里有多少是服务商从缓存里读来的。
#  什么都没花的帧什么都不说：空格子是诚实的，
#  `$0.000000` 是一句断言）

# 读回一个进程**打印**过的东西
# （按进程分别保存，不再混进 daemon 的 stdout —— stdout 和 stderr 分开标注）
$ cortex logs 1234
2026-10-23T14:23:01.402Z | out | [coder] starting on issue #42
2026-10-23T14:23:06.115Z | err | [coder] grep timed out, retrying
# （--tail 20 只看最后 20 行；--follow 用推送盯着活着的 agent 打印，
#  并且在 agent 结束时自己收尾）

# 读回一个活着的进程**知道**的东西 —— 它的内存区域
# syscall 日志里存的是 memory 值的哈希而不是值，所以
# `cortex trace` 只能告诉你"它写了点什么"，永远不告诉你"写了什么"
# 表格还会说出每个区域**能**装多少：LIMIT 是内核用 ENOMEM 兜住的写入次数上限，
# WRITES 是这个上限所对照的那个计数（ENTRIES 是另一个数 —— 它装着多少个键）
# 表格还会说出谁**能写**：ACCESS 是这个进程自己能不能写
# （只读的区写入会 trap EPERM），SHARED WITH 里的每个共享方也各自带一个 ——
# 共享不等于能写
$ cortex memory 1234
# memory of pid 1234 (coder)
REGION          KIND      BACKING     ACCESS     ENTRIES   WRITES    LIMIT     SHARED WITH
------------------------------------------------------------------------------------------
episodic        cow       inmem       read-write 0         0         100       -
semantic        shared    inmem       read-write 2         3         ∞         1240 (read-only)
procedural      private   inmem       read-write 0         0         ∞         -
$ cortex memory 1234 semantic
# memory of pid 1234 (coder) — region 'semantic' (read-write)
issue:42     "found it — src/foo.ts:42"  2026-10-23T14:23:04.881Z
last_result  "ok"  2026-10-23T14:23:06.115Z
# 2 entries

# 等一个进程结束 —— 拿到它**真实**的退出码
# （退出码就是子进程自己的，所以 `cortex wait 2 || echo failed` 能用）
$ cortex wait 1234
pid 1234 exited with code 0 (finished the task)

# 实时盯着内核 —— 每一条 syscall 帧，发生了就推过来。
# 和 `cortex trace` 读到的是同一批帧，只是推过来而不是轮询。
$ cortex watch --pid 1234
# watching the kernel event stream (Ctrl-C to stop)
time          pid     syscall                                                    phase  duration   reversibility spend
----------------------------------------------------------------------------------------------------------------------
19:50:09.072  1234    sleep                                                      exit   64ms       idempotent
19:50:09.077  1234    __state:running->blocked(sleep)                            exit   -          idempotent
19:50:09.138  1234    __state:blocked->ready(wait-return)                        exit   -          idempotent
# pid 1234 exited with code 3 (probe finished on purpose)

# 监督一个活着的 agent：卡住就杀掉，再换一个新的上来。
# "卡住"是从 syscall 日志里读出来的，不是靠沉默判断 ——
# sleep 是一次声明过的等待，不是停滞。
# 换上来的是**同一个** agent：它拿到的权限和原来那个一样，不会更多。
$ cortex supervise 1234 --kill-after 30000 --restart
# pid 1234 has been inside recv for 1588ms — killing it
# pid 1234 exited with code 137 (signal:SIGKILL)
# restarted as pid 1240 (role=coder, caps=all)

# 内核在监视者脚下死掉时，CLI 会说出来 —— 绝不假装"看完了"。
$ cortex watch
cortex watch: the connection to the kernel was lost — it looks like the kernel died (connect ECONNREFUSED 127.0.0.1:60869)
  the watch did not finish — it lost the kernel it was watching.

# 跨重启暂停和恢复
# （快照捕获的是**正在运行**的进程，所以这需要活内核：
#   `cortex daemon run` —— SIGUSR2 的语义就是"立刻做快照"）
$ cortex checkpoint 1234 --tag "before risky edit"
$ cortex kill 1234
# ... 第二天 ...
$ cortex restore --tag "before risky edit"
[restored as pid 1502]

# ...或者把快照放回一个仍在运行的内核里，让恢复出来的 agent
# 在命令退出之后继续工作
$ cortex restore --live --tag "before risky edit"
[pid 1503]
  restored into the live kernel — it keeps running after this command

# 注册一个开机自启的长命 agent，并监督它
$ cortex daemon install inbox-watcher --role inbox-watcher \
    --module ./examples/checkpoint-agent.ts --restart on-failure
[daemon inbox-watcher] installed (role=inbox-watcher, restart=on-failure)
$ cortex daemon run inbox-watcher
[daemon inbox-watcher pid 2] running (restart=on-failure)

# 从 shell 往那个正在运行的内核里再起一个 agent
$ cortex spawn --live --role extra --module ./examples/listener-agent.ts
[pid 3] spawned into the live kernel — it keeps running after this command

# ...再从 shell 把内核停掉
$ cortex daemon stop
daemon stop requested
```

上面这些**大部分现在就能跑** —— `spawn`、`ps`、`kill`、`trace`、`attach`、`fork`、`diff`、`replay`、`checkpoint`、`restore`、`send`、`limit`、`audit`、`daemon` 都已实现，并且被冒烟测试套件覆盖。`attach` 跟着一个 agent 的 syscall 流 —— 有活内核且那个进程还在内核里时，帧是**推**过来的（中位延迟 1 毫秒，而且 agent 一结束，跟随就自己收尾，并报出它真实的退出码）；没有内核时才去 tail 日志文件；有活内核时它还能把你敲的每一行**送进运行中的 agent**（`--interactive`）。`cortex daemon run` 才是真正的长命监督者（BACKLOG #039），也是活内核能被连上的原因 —— 有它在，`cortex send` 会真的投递到运行中的 agent，`cortex kill` 会真的发出信号，`cortex checkpoint <pid>` 能给运行中的 agent 做快照，`cortex spawn --live` 能把一个**新** agent 起进那个内核里，`cortex restore --live` 能把快照**放回**那个内核，`cortex fork <pid>` 能把运行中的 agent 克隆成第二条可以驱动、可以对比的分支，`cortex daemon stop` 还能再把它停下来。`cortex top` 读的是每个活进程自己的日志 —— 读法跟 `cortex supervise` 完全一样，所以这个视图和那个会动手的命令**不可能各说各话**；加上 `--stall-after <ms>`，它会把超过**你的**阈值的进程标出来，顺带把该跑的命令给你。它还会说清楚**哪些信号正在排队**：发给一个卡死 agent 的 `kill` 不会立刻送达，而是排队等着一次可能永远不会来的唤醒 —— 视图会说出来，而不是把这件事只留给刚刚发出它的那条命令。`cortex limit` 也能碰到**运行中** agent 的预算 —— 预算是内核持有的东西，所以这条命令去问真正持有这个进程的内核，而不是自己 boot 一个除了 init 什么都没有的内核；它还把**上限**（这个进程总共可以花多少）和**还剩多少**分开说，因为一个会在你脚底下变小的数字不是上限。`--tokens N` 设的就是这个上限；已经结束的进程会**拒绝**改预算 —— 它花了多少是内核的记录。表格也保住了自己的形状：一列有多宽取决于这一列里最宽的值，放不下的值会被**截断并标记**（`…`），而 `cortex ps` 和 `cortex top` 对同一笔花费说的是同一个数。而且 token 数字会说出其中有多少是服务商从缓存里读的 —— `1.2k (300 cached)` —— 缓存价和新鲜价不是一回事，而以前没有任何视图说这件事。七个驱动（LLM、MCP、文件系统、记忆）全部交付。哪些做完了、下一步做什么，见 [BACKLOG.md](./BACKLOG.md)。

---

## 安装

```bash
npm i -g cortex-agent-os     # 把 `cortex` 和 `ctx` 装到 PATH 上
cortex help
```

不想安装也可以直接跑：

```bash
npx cortex-agent-os help
```

要求 **Node 22+**。只有一个运行时依赖（`cborg`，用于 syscall 日志）。想试一下**不需要任何 API key** —— mock 驱动是确定性的、完全离线。

`examples/` 目录**随包发布** —— 编译成纯 JS 放在 `dist/examples/` 里，所以 `npm i` 之后下面的 demo 直接能跑，不需要任何额外 flag，也不挑 Node 版本（`cortex example hello` 在 `engines` 里写的每个 Node 上都能跑）。`.ts` 源码也一并打包，从克隆仓库用 `tsx` 直接跑即可。完全不想管这件事的话，
`cortex spawn --role coder --task "..."` 不需要任何模块文件 —— `cortex` 自带一个 prompt agent。

想改 Cortex 本身？克隆下来跑测试套件：

```bash
git clone https://github.com/Jackeven02/cortex-os
cd cortex-os && npm install
unset OPENAI_API_KEY DEEPSEEK_API_KEY   # 回落到确定性的 mock 驱动
npx tsx scripts/smoke.ts                # 798 项断言，0 失败
```

> **npm 上的包名是 `cortex-agent-os`，不是 `cortex-os`。** npm 认为后者与已存在的 `cortexos` 太相似而拒绝上架 —— 两者去掉标点后完全相同。仓库名没变，命令名也没变：你敲的仍然是 `cortex`。

---

## 当前状态

**已发布 [`v1.0.0`](./CHANGELOG.md)**（2026-09-23）—— **syscall ABI 已冻结。**

`0.2.1` 及之前做的是「把东西建出来，然后补上文档早就承诺过的缺口」：`sleep()` 真的挂起进程、restore 出来的进程自己会跑、同步 syscall 写进日志、持久化布局变成 ARCHITECTURE §7 的每进程子树、`cortex top` 能说出阻塞中的进程在等什么。

`1.0.0` 是另一种发布 —— 它**把契约定下来**。ABI 里两条明写「留给 v1」的事，现在做完了：

- **能力系统（§4.9）** —— `acquire` / `release` / `caps`，六个封闭的能力（`spawn`、`kill`、`fork`、`tool:dangerous`、`ipc:any`、`admin`）。一个进程现在可以带着**比内核想给的更少的权限**运行。默认是「全权限」而不是「最小权限」，因为默认最小权限会让所有 1.0 之前的 agent 一升级就撞 `EPERM`；要收窄就在 `spawn` 时显式指定。有两道门是刻意做成「按条件触发」的：杀**自己的**子进程、调用**可逆**工具，永远不需要能力 —— 否则 `kill` 会发给每一个监督者，那它就什么也不意味着了。
- **显式 channel（§4.5）** —— `channel_open` / `channel_close`。`send` 时的隐式创建为兼容性保留，但它不再是拿到 channel 的唯一方式，channel 名打错也不再会悄悄造出一个没人读的 channel。

syscall 从 19 个变成 24 个。**从此以后**：破坏性变更需要大版本；新增式变更进小版本。见 [ABI.md「ABI status」](./docs/ABI.md)。

**Phase 0 — 设计（完成）。** 四份文档 v0 落地：`STATE.md`（最难的那份）、`PROCESS.md`（生命周期）、`ABI.md`（syscall 契约）、`ARCHITECTURE.md`（内核模块）。每份文档末尾的 open questions 是有意滚动记录的，会随着实现逼出决定而解决。

**Phase 1–3 —— 大体完成。** 内核能启动；十三个内核模块加上驱动注册表都在；七个驱动全部交付（mock / deepseek / openai 三个 LLM，MCP 与文件系统两个工具驱动，inmem 与 sqlite 两个记忆驱动）；CLI 大部分可用。`cortex spawn → llm_call → exit → reap` 能跑，checkpoint/restore 能跨不同的 CLI 调用存活。v0 的已知缺口都诚实地记录在 [BACKLOG.md](./BACKLOG.md) 里，没有藏。

**Phase 4 —— 杀手级 demo。** 三个 demo 全部打磨完毕，并录成了回放。Demo A（监督树）：几个 coder 各自生成一个虚构库 README 的一章（见 `examples/supervision-tree.ts`、[`docs/demo-a.html`](./docs/demo-a.html)）。Demo B（跨重启暂停）：一个收件箱监听器给工单分类，跑到一半 checkpoint，重启后恢复（见 `examples/checkpoint-agent.ts`、[`docs/demo-b.html`](./docs/demo-b.html)）。Demo C（fork 对比）：一个 coder fork 出两个分支并行探索两种去重策略，然后 `cortex diff` 把两个分支对齐，好让你留下赢的那个（见 `examples/fork-compare-agent.ts`、[`docs/demo-c.html`](./docs/demo-c.html)）。`cortex attach` 以 follow-mode syscall 追踪的形式交付（BACKLOG #031），有活内核时它还是交互式会话；`cortex daemon install/run` 能注册并监督长命 agent，并发布内核的 endpoint —— 那正是运行中的 agent 能被连上的原因（BACKLOG #039）。**Phase 3 至此完成** —— 上面 demo 里的每一条命令都能跑。

Demo A 值得单独说一下，因为它改变了内核：以前 agent 会在派发它的那个 quantum 里跑到结束，所以一个停在 `wait()` 里的父进程会一直占着自己的 tick，它的子进程永远没法被调度 —— `wait()` 在结构上就死锁，监督树根本写不出来。现在 continuation 是协作式的（见 PROCESS.md §8.2），所以下面这些不需要任何编排器就能跑：

**实时回放：[`docs/demo-a.html`](./docs/demo-a.html)** —— 自带零依赖，逐帧回放捕获到的 syscall 日志。

planner spawn 三个 coder，每个 coder 为一个虚构库（"tinylog"）生成一份真实 README 的一个章节，并把它发布到一个共享的 `semantic` 记忆区域。其中一个 coder（"api"）卡住了 —— 一次永不返回的模型调用 —— 于是 planner 通过一个带超时的 `wait` 察觉，把它 kill，spawn 一个替补，然后从三个章节组装出最终 README：

```bash
$ cortex example supervision-tree        # 或：cortex example demo-a
[planner pid 2] spawning 3 coders (tinylog README)
[coder api pid 5] slow model — will miss its deadline
[planner] api (pid 5) missed its 8000ms deadline — killing
[coder api#2 pid 6] generating section: api
[planner] overview=ok(0) install=ok(0) api=respawned(0)
[planner] assembled README.md: # tinylog / ## Overview / ## Install / ## API
process exited (code 0: planner complete: overview=ok(0),install=ok(0),api=respawned(0))
```

Demo B 把「重启」这个故事变得具体。一个 checkpoint 捕获的是**进程镜像** —— 记忆区域、预算、血缘 —— 而不是活的 JS 调用栈，所以在 `restore` 时 agent 会从头重跑，靠读自己的 `episodic` 标记来跳过已经处理过的工单（这是被文档化的幂等模式，不是内核特性）。结果就是一个扛过一次断电、零工作丢失的长命 agent：

**实时回放：[`docs/demo-b.html`](./docs/demo-b.html)** —— checkpoint 与重启，逐帧回放。

收件箱监听器给每张工单分类（`bug` / `feature` / `question`），把回复草稿写进共享的 `semantic` 区域，并把已处理的 id 记到 `episodic`。处理完三张之后它 checkpoint 并 detach；重启之后，`cortex restore` 把它重新物化成一个新的 PID，它读回 `done` 集合，跳过那三张已经处理过的，然后把队列跑完：

```bash

$ cortex example checkpoint-agent        # 或：cortex example demo-b
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

**实时回放：[`docs/demo-c.html`](./docs/demo-c.html)** —— 两个分支交错执行，然后 `diff`。

```bash
$ cortex example fork-compare-agent      # 或：cortex example demo-c
[parent 2] forked as pid 3 — branch A: counting bloom filter
[branch A pid 2] {"approach":"counting bloom filter","spaceComplexity":"O(k) bits, ...}
[branch B pid 3] resumed from the fork's snapshot
[branch B pid 3] {"approach":"lru-bounded hash set","spaceComplexity":"O(cap) entries, ...}
process exited (code 0: branch A complete)

$ cortex diff 2 3
  diverged after 7 shared syscall(s) — fork recorded in pid 2 at byte offset 2307
  syscall diff   (7 shared, - 7 A-only, + 9 B-only)
  - 16:08:15.616  fork         in  {"tag":"dedup-strategy"}
  - 16:08:15.619  fork         out {"childChainId":"8a644ebd-...","c...
  - 16:08:15.620  llm_call     in  {"messages":[{"content":"Design dedup with a counting Blo...
  + 16:08:15.628  llm_call     in  {"messages":[{"content":"Design dedup with an LRU-bounded...
  + 16:08:15.630  exit         out {"code":0,"reason":"branch B complete"}
  summary
    records   19            14      syscalls  15        10
    exit      0 branch A    0 branch B
  last llm_call output
    A: mock reply to: Design dedup with a counting Bloom filter.
    B: mock reply to: Design dedup with an LRU-bounded hash set.
```

---

## 监控大屏（dashboard）

`cortex dashboard` 在本机起一个零依赖的监控控制台。它是唯一能一眼看清整棵进程树在干什么的地方，加一个显式开关，还能顺手驱动它：

```bash
$ cortex dashboard                  # 只读：仅观察
$ cortex dashboard --ops spawn,kill,restore   # 允许这三个操作
```

**默认只读。** 状态目录里有活内核时（`cortex daemon run`），大屏**盯着那个内核**：**正在运行**的进程会出现在列表里——活进程还没有 `meta.json`，只看磁盘的话看到的是一堆尸体——事件流也由内核推送，边写边到。没有活内核时，大屏能做的就是任何"看文件系统的人"能做的事：读 `.cortex/processes/<pid>/meta.json`、解码 `.crec` syscall 日志（**包括还在跑的进程的日志**）、列出检查点、渲染进程树。`restore` 是纯写盘操作，所以它在 v0 的无守护进程模型下也能工作。

**而且大屏里的钱，和 CLI 里印的钱是同一笔钱。** 成本面板读的是内核的微美元计数器，在服务端换算一次，显示成美元——所以一个花了 `$0.003400` 的进程，在这里和 `cortex top` 里都读作 `$0.003400`，而不是一个视图说 `$3400`、另一个说 `$0.0034`。而且它按内核计数的精度打印：一次模型调用大约 `$0.000027`，这里就显示 `$0.000027`——而不是 `$0.0000`，一个花了真钱的运行就那样看起来像没花过钱。

**而且 token 数字会说出其中有多少是缓存读来的。** 服务商报的是整个 prompt，外加它其实不必再读一遍的那部分——而这些 token 是按缓存价计费的，不是新鲜价。大屏会说出来：进程表印 `1,234 (300 cached)`，预算面板多了一列 **缓存** 和一个 **缓存命中** 总数，事件表会说明单次调用里有多少是缓存读来的。

**而且事件表里看得见这次调用花了多少钱。** `cortex wrap --tap` 把模型自己发出的 HTTP 调用记进和驱动调用同一份日志，所以这些调用同样出现在事件表里——带着它们的 token 和价格，写成 ABI 规定的 `usage` 形状，也就是所有读 `llm_call` 帧的人都在找的那个形状。

**而且 `cortex trace` 也说。** 能说出一次调用花了什么的，不止大屏一个视图——CLI 最深的那个视图原本不能说，而它恰恰是运维为了弄清一个 agent 在干什么会打开的那个。它的最后一列现在会说出每次调用花了什么（`$0.000161 · 1.2k in / 80 out (900 cached)`），而且它和事件表用同一个函数读那一帧，所以两边不可能各说各话。什么都没花的帧什么都不说：空格子是诚实的，`$0.000000` 是一句断言。

**而且大屏自己的时间线也说。** 运维的窗口不止一个视图：它有**事件表**（agent 做出的每一次调用）和 **Syscall 时间线**（每一帧，按顺序），两者读的是同一份 `.crec`。而时间线曾经说得比旁边的事件表还少：没有缓存那部分（服务端压根没读它）、没有价格（服务端发过来了、页面把它丢了），还有给一个从没说过自己写了多少 token 的调用印上 `0 out`。现在两边都问同一个 helper 要 token，服务端也用和 `cortex trace` 同一个函数读帧——所以终端、事件表和时间线对同一次调用说的是同一句话。

**而且时间线读起来和终端里的一样。** 内核自己的帧在盘上是占位名（`__state`、`__sched`）——**区分**它们的是那个视图：`__state:running->blocked(recv)`、`__sched:sigxcpu(tokens)`。大屏印的是和 `cortex trace` 一样的名字，因为两边问的是同一个函数。

**而且大屏看得见 agent 知道什么。** 进程弹窗原本只有一个视图——Syscall 时间线，那是它**做了什么**。agent 的记忆是它**知道什么**，而窗口里对此一个字都没有。现在有两个视图：点一个进程，切到 **记忆**，大屏会列出它的记忆区——名字、类型、存储、访问模式、条目、写入、上限，以及和它绑在同一个区上的其他进程——再点一个区，就能看见里面装了什么：键、值，以及每条是什么时候写的。

它用的词和 `cortex memory` 一样（`read-write`、`read-only`、`∞`、`3 (read-only)`），因为措辞只在一处，每个视图只管自己怎么印数字。记忆是你打开面板时才取的，不是每次刷新进程表都去取一遍；没有活内核时，面板会直接说需要活内核，而不是给你看一个空区——区里的内容住在拥有它的内核里，盘上没有副本可读。

**而且大屏说得出每个进程活了多久。** 它的进程表原来只有启动时间——而启动时间不是时长：一个一小时前就死掉的进程，它什么也没说。现在旁边多了一列 **存活时长**，数字和 `cortex ps`、`cortex top` 印的完全一样，因为规则只在一处。还在跑的进程仍在变老，数字一直往上走；已经结束的那个不再变老，它显示内核记下的存活时长，就停在那里。

三个会改状态的操作都要显式授权，因为它们确实需要 boot 一个真内核去干活：

- `spawn` —— 把新 agent 跑到终态（或自行挂起，或 `--timeout` 兜底）。默认上限 30 秒，避免 HTTP 请求长挂。
- `kill` —— 把信号发给该进程。状态目录里没有活内核时，它把进程在磁盘上标记为 zombie；有活内核时，信号会通过内核的信号引擎真的投递出去。
- `restore` —— 把快照写回，把进程以新 PID 重新实体化。

授权是细粒度的：`--ops spawn` 只给你一个 spawn 按钮。`GET /api/ops` 回报当前服务器被授了哪些操作，未授权的 `POST /api/ops/<op>` 直接 `403`。服务器默认绑 `127.0.0.1`（除非 `--host` 指定），页面是静态 HTML + 严格 CSP，不挂 CDN、不需要构建、零依赖。也可以在自己的 Node 应用里通过 `cortex-agent-os/dashboard` 嵌入。完整接口见 [docs/INTEGRATIONS.md](./docs/INTEGRATIONS.md#embedded-dashboard)。

---

完整清单（按优先级排）见 **[BACKLOG.md](./BACKLOG.md)**。

---

## 文档

| 文档 | 内容 |
|---|---|
| [MANIFESTO.md](./MANIFESTO.md) | cortex 为什么存在。先读这个。（[中文](./MANIFESTO.zh-CN.md)） |
| [docs/STATE.md](./docs/STATE.md) | **最难的部分。** agent state 是什么，fork 时复制什么，什么根本不能复制。（[中文](./docs/STATE.zh-CN.md)） |
| [docs/PROCESS.md](./docs/PROCESS.md) | agent 生命周期：9 个状态、合法转换表、signals、调度 |
| [docs/ABI.md](./docs/ABI.md) | syscall 契约：24 个 syscall、3 个 driver 接口、错误模型、记录格式 |
| [docs/INTEGRATIONS.md](./docs/INTEGRATIONS.md) | 将 LangChain 事件和只读 Dashboard 接入现有 Node.js 项目 |
| [docs/DRIVERS.md](./docs/DRIVERS.md) | 内置 LLM 驱动（mock / deepseek / openai）：选择顺序、环境变量、端点覆盖 |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 内核模块和数据流：12 个模块、syscall 生命周期、持久化布局、并发模型 |
| [docs/HACKING.md](./docs/HACKING.md) | 贡献者指南：开发环境、约定、怎么写驱动 / agent / syscall、测试。 |
| [docs/COOKBOOK.md](./docs/COOKBOOK.md) | 配方：监督树、暂停与恢复、fork 对比、daemon、工具、IPC（含显式 channel）、预算、最小权限（能力系统）、测试。 |
| [docs/PUBLISHING.md](./docs/PUBLISHING.md) | 发版手册：飞行前检查、npm 登录/发布（含国内镜像的坑）、版本号提升流程。 |
| [docs/logo.md](./docs/logo.md) | 标志：为什么是「层 + 核 + 分叉」，以及哪个文件用在哪。 |
| [docs/CRITIQUE.md](./docs/CRITIQUE.md) | 外部批评的滚动记录，以及我们因此改了什么。 |
| [CHANGELOG.md](./CHANGELOG.md) | 发布历史、版本号规则，以及本版本的已知限制。 |
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
