# V2EX — 分享创造

**节点:** 分享创造（次选：程序员）
**标题:**

1. `[分享创造] Cortex —— 把 AI Agent 当成进程，而不是函数`
2. `[分享创造] 给 Agent 装上 PID、fork、checkpoint/restore 的内核（TypeScript）`

**正文:**

大家好，我写了一个 TypeScript 内核 **Cortex**，做的事一句话说清楚：
**今天大家写的 Agent 本质是个函数 —— 传进去一段上下文，拿回来一个结果。
Cortex 想让它变成一个进程。**

进程和函数的区别是具体的：进程有身份（PID），身份活得比调用方长；有父进程监督它；
有 syscall 日志记录它干过什么；可以被暂停、fork、恢复。

所以我把 Unix 在 1975 年给程序的那套原语，原样搬给了 Agent：

```
spawn · ps · kill · wait · fork · diff · checkpoint · restore
trace · attach · limit · daemon · audit
```

24 个 syscall，11 个内核模块，纯 TypeScript，Node 22+，MIT，唯一的运行时依赖是
`cborg`（用来编码 append-only 的 CBOR syscall 日志）。

**现在已经能跑的东西**（v0，`npm install` 后全离线跑，走确定性 mock driver，不需要 API key）：

- **进程控制**：`spawn` / `ps` / `kill`（13 种信号）/ `wait`，包括
  `wait(pid, { timeoutMs })` —— 超时是内核报给你的一个**观测**，杀不杀是你的事，
  子进程不会被内核偷偷干掉。
- **状态**：`fork`（认知分叉）、`checkpoint`、`restore`。fork 的返回值里带**两个分支
  分叉的字节偏移**，`cortex diff` 就是靠它把两份 syscall 日志对齐的。
- **认知 / 记忆 / IPC**：`llm_call` / `tool_call` / `memory_read` / `memory_write` /
  `send` / `recv` / `sleep` / `now` / `random` / `on_signal` / `budget`。
- 7 个驱动：mock / deepseek / openai（LLM）、filesystem / MCP（工具）、
  inmem / sqlite（记忆）。

**三个 demo，README 里都能从零复现：**

1. **跨重启暂停。** 一个收件箱监听 Agent 跑到一半 checkpoint 然后挂起。机器重启
   （内核被销毁，快照留在磁盘上）。`cortex restore` 把它以**一个新的 PID** 拉起来，
   记忆完整恢复，并且**跳过已经做完的部分**。
2. **fork 对比。** 一个 coder 走到决策点，fork 出两个分支各走一种方案，
   `cortex diff` 从父日志里读出共享因果历史的偏移，只对齐两个 tail。
3. **监督树。** 一个 planner spawn 三个 coder，其中一个卡死；planner 通过带超时的
   `wait` 发现它，kill 掉，重启，最后汇总 —— 大约 40 行普通 `async/await`，
   没有任何外部编排器。

**我自己先泼的冷水，v0 的真实缺口（都在 repo 里写着，没藏）：**

- checkpoint 存的是进程**镜像**（记忆、预算、血缘），**不是活的 JS 调用栈**。
  恢复出来的 Agent 是从头重跑、靠 memory 标记跳过已完成的工作的。真正的
  continuation 捕获是 post-v0。这是最硬的一个限制，我也很想被说服换一个更好的设计。
- `attach` 目前是**跟磁盘上的 syscall 日志**，不是连到一个活着的内存进程。
  `cortex daemon run` 今天已经能监督一个长命 Agent，但 CLI 平时还是"短命进程"模型。
- 单机、单进程。没有分布式，没有 k8s。

**和 Temporal / LangGraph / k8s 有什么不一样？** 简单版：Temporal 是让**人写好的**
工作流变得持久 —— 决策图是提前声明的；LangGraph 跑的是**静态图**。而一个 Agent 在
运行时才决定"我要 spawn 三个子 Agent，等它们，然后合并"，在这两套里都不太顺，
因为**"spawn 三个"这个动作本身就是决策**。Cortex 的赌注是：所谓"图"，只是进程树在
运行时恰好长成的形状。

设计文档是**先于代码**写的（`STATE.md` 第一个写，因为"`fork()` 到底复制了什么"
是最难的部分，状态模型错了就得重写）。四份契约 —— STATE / PROCESS / ABI /
ARCHITECTURE —— 都在 repo 里，是唯一事实来源。

Repo: https://github.com/Jackeven02/cortex-os

真心求狠拍，尤其是 fork / checkpoint 的语义，以及"Agent 即进程"这个抽象到底值不值。

---

## 发帖备注

- **V2EX 的 GFM 支持有限**：代码块用围栏可能被吞，必要时改成缩进 4 空格或纯文本。
- **自顶一楼**（发完立刻自己回一条），给出最有说服力的 30 秒证据：Demo B 的
  终端记录（spawn → checkpoint → reboot → restore → `inbox cleared (6/6)`）。
  很多人不会点外链，把结论直接放在楼里。
- **预备回答**（大概率被问）：*"这跟 Temporal 有啥区别？"*、*"Erlang 早就能干了吧？"*、
  *"为什么用 TypeScript？"*、*"内核多少行？"*、*"一台机器能跑两个 Agent 吗？"*
  （诚实答：一个 state dir 一个内核，目前没有跨内核 IPC）。
- **别用的词**："颠覆"、"革命性"、"10x"。说清楚它做了什么就行。V2EX 对营销腔很敏感。
