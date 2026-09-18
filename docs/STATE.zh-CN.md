# Agent 状态

> Cortex 里最难的一份文档。其他都只是管道工程。

> 英文原文见 [STATE.md](./STATE.md)。若两者有出入，以英文版为准。

---

## 1. 这份文档为什么存在

Unix 的 `fork()` 以「规格极简单、实现极难」闻名。规格就一句话：*「通过复制调用进程来创建一个新进程。」* 而实现它，要求内核必须对**「进程是什么」**有一个精确的定义。

那个定义才是难的部分。Unix 里的进程状态包括：

- 寄存器组
- 虚拟内存页
- 文件描述符表
- 信号掩码与待处理信号
- 凭据（uid / gid / capabilities）
- 工作目录、root、umask
- 资源限制
- 打开的文件锁
- …… 以及一长串其他的

这里面每一样都有定义明确的复制语义：写时复制、共享、复制、或者失败。操作系统打磨这份清单打磨了五十年。

**Cortex 的 `fork()` 面对同样的问题，却没有这五十年的积累。** 一个 Agent 到底*是什么*？当你 fork 一个 Agent 时，复制的是什么？哪些东西根本没法复制？

这份文档是我们的第一个答案。它有些地方会是错的。我们会修订它。但在我们写下*点什么东西*之前，内核根本没法开工。

---

## 2. Agent 状态的七个类别

Agent 拥有的每一份状态，都落在下面某一类里：

### 2.1 身份（Identity）

- PID、父 PID、角色名、创建时间戳。
- **复制语义：** fork 产生一个全新的身份。PID 是新的；`parent_pid` 指向 fork 的那个进程；血缘被记录。

### 2.2 认知上下文（Cognitive context）

- 当前的消息历史（system prompt、对话、草稿本）。
- 「当前意图」—— Agent 认为自己此刻在做什么。
- 等待响应的待处理工具调用。
- **复制语义：** 深拷贝。这是纯的可序列化 JSON，也是快照里最大的一块。

### 2.3 记忆（Memory）

- 长期情节记忆（事件）。
- 语义记忆（学到的事实）。
- 程序性记忆（技能、习惯）。
- **复制语义：** 按记忆*区域*逐个配置：
  - `private` —— fork 时深拷贝，之后各自分叉。
  - `shared` —— 两个进程看到同一个后端存储；写入对双方可见（并发问题见 §8.1）。
  - `cow` —— 写时复制。首次写入前读的是共享的，一旦写入就 fork 那一页。
- **默认值：** 情节记忆用 `cow`，语义记忆用 `shared`，程序性记忆用 `private`。

### 2.4 资源预算（Resource budgets）

- 花掉的 token（输入 / 输出 / 缓存）。
- 花掉的钱（按 provider 计的微美元）。
- 存活挂钟时间。
- syscall 次数。
- **复制语义：** 可配置。默认在 fork 时**重置为零**。fork 是一次新的尝试，父进程已经沉没的成本不应该拖累它。备选：`inherit`（继承）、`split`（平分）。

### 2.5 驱动 / 工具状态（Driver / tool state）

- 打开的 MCP server 会话。
- Agent 沙箱里的文件句柄。
- DB 连接、HTTP 会话 cookie、流程中途缓存的 OAuth token。
- 子进程句柄。
- **复制语义：一般不可复制。** 这是第一个硬性限制。大多数外部资源没法被有意义地复制 —— 两个进程无法共享同一个 socket、同一个 DB 事务、同一个已认证的会话。
- **Cortex 的策略：** fork 默认会**关闭**父进程和子进程双方的*所有*驱动状态。双方各自重新获取。驱动可以自行声明 `forkable: true` 能力，前提是它能序列化并重新水化自己。这很少见，而且没有测试的话，内核不会相信这个声明。

### 2.6 在世界上留下的副作用（Side effects in the world）

- 发出去的邮件。
- 写到宿主文件系统上的文件（沙箱之外的）。
- 发出的 API 调用 —— 下的单、发的推、转的钱。
- 提交的数据库改动。
- **复制语义：按定义不可复制。** 现实只有一个分支。fork 出来的进程记得那封邮件被发出去了；但邮件本身只存在过一次。

这是这份文档的哲学核心。见 §5。

### 2.7 血缘（Lineage）

- syscall 历史（那份记录）。
- checkpoint 链（哪些快照先于当前状态）。
- fork 树（谁从谁 fork 出来的）。
- **复制语义：** append-only，fork 时产生分支。两个子进程共享前缀；各自追加自己的后缀。

---

## 3. fork 的分类学

不是所有 fork 都一样。Cortex 区分四种。

### 3.1 认知 fork（默认，v0）

复制类别 1–4 与 7。关闭类别 5。把类别 6 承认为共享的过去。

**用途：** 从一个决策点出发，探索另一条推理路径。*「如果我当时换一种方式问 LLM 会怎样？」*

### 3.2 沙箱 fork（post-v0）

在认知 fork **之上**，加一个写时复制的文件系统覆盖层，和一个网络出口记录器。沙箱里的副作用在提交之前不会逃逸到宿主。

**用途：** 让 Agent 尝试一次有风险的编辑而不真正提交。胜出的分支被 `commit()`；输掉的分支连同它的覆盖层一起被丢弃。

需要沙箱驱动。v0 不含。

### 3.3 回放（Replay，严格说不算 fork）

不 fork 一个活进程。而是从一个 checkpoint 重建，然后向前跑。

**用途：** 确定性测试、调试、「如果我把第 12 步的 prompt 改一下会怎样？」

这是 Agent 调试的日常主食，v0 里有。

### 3.4 影子进程（Shadow process，post-v0）

用同一份认知快照 spawn 一个新进程，但换一套驱动配置 —— 不同的 LLM、不同的 temperature、不同的 system prompt。

**用途：** 在完全相同状态下对模型行为做 A/B 对比。

一旦认知 fork 能用，这个加进来很便宜。v0 不含。

**v0 交付认知 fork 与回放。** 沙箱 fork 与影子进程属于 post-v0。

---

## 4. Checkpoint 格式

一个 checkpoint 是单个文件。二进制，CBOR 编码，以 SHA-256 做内容寻址。

```
.csnap 文件：

  Header
    magic:        "CRTX"
    version:      u32
    pid:          u64
    parent_pid:   u64 | null
    created_at:   ISO8601
    chain_id:     uuid       # 把同一条血缘上的 checkpoint 串起来
    prev_in_chain: chain_id | null

  CognitiveSnapshot
    messages:      Message[]
    intent:        string | null
    pending_calls: PendingCall[]

  MemoryDelta
    base_chain_id: chain_id | null    # 如果是增量的话
    writes:        MemoryEntry[]      # 相对 base 的写入

  BudgetCounters
    tokens_in:      u64
    tokens_out:     u64
    tokens_cached:  u64
    usd_spent:      u64              # 微美元
    wall_time_ms:   u64
    syscall_count:  u64

  SyscallLogOffset
    file:         path               # 通常是紧邻 .csnap 的 .crec
    byte_offset:  u64

  DriverStates
    [driver_name: string]: opaque blob | null
    # null = "checkpoint 时这个驱动没有状态"
    # blob = 由驱动自定义；内核不解释

  Signature
    sha256(以上全部)
```

**syscall 日志**本身是另一个 append-only 文件（`.crec`）。Checkpoint 引用它里面的一个偏移量。恢复的含义是：加载 checkpoint，把 syscall 日志 seek 到那个偏移，然后向前重放 —— 如果开了确定性模式就用缓存下来的响应，否则就用真实调用。

为什么是两个文件？因为 syscall 日志会持续增长，我们希望它能被流式处理；而 checkpoint 是离散快照，我们希望它内容寻址。把两者混在一起，是每个工作流引擎最终都会后悔的错误。

---

## 5. 不可逆动作信条

这一节，是 Cortex 与那些天真的「Agent 时间旅行」宣传之间的分界线。

> **主张：** *fork 是一次认知操作，不是一台物理时间机器。*

当一个 Agent 调用 `tool_call("send_email", ...)` 且邮件被发出，那封邮件就在世界上存在了。如果你之后 fork 这个 Agent，fork 出来的进程拥有发送这封邮件的**记忆** —— 但邮件本身只被发送过恰好一次。

这不是 bug。这是「在现实中运作」的一个根本属性。任何假装不是这样的框架，都在卖给你某种不诚实的东西。

Cortex 的策略：

### 5.1 syscall 被打上标签

每个工具声明它的副作用类别：

- `reversible`（可逆）—— 可以被另一次调用撤销（例如 `file_write` 可以从备份还原）。
- `idempotent`（幂等）—— 调两次和调一次一样（例如 `http_get`）。
- `irreversible`（不可逆）—— 一旦做了就没法撤销（例如 `send_email`、`stripe_charge`、`tweet_post`）。

标签是逐工具的，由驱动作者声明。内核把这个标签记录到 syscall 日志里。

### 5.2 可 fork 区域（Forkable regions）

Agent 可以把一段执行声明为一个**可 fork 区域**：

```typescript
await ctx.forkable(async () => {
  // 在这个区域内，不可逆的 syscall 会 trap（陷入内核）。
  // 内核会在允许它们之前询问监督者。
  await ctx.llm_call(...);
  await ctx.tool_call('grep', ...);   // 幂等，没问题
  // await ctx.tool_call('send_email', ...);  // TRAP
});
```

正是这条纪律让有意义的 fork 成为可能：你要在现实提交**之前** fork，而不是之后。

### 5.3 两阶段模式

驱动可以实现 `stage` 与 `commit` 两个操作：

```typescript
const staged = await ctx.tool_call('email.stage', { to, body });
await ctx.checkpoint({ tag: 'before-send' });
// ... 在这里 fork，探索不同方案 ...
await ctx.tool_call('email.commit', { staged_id: staged.id });
```

在 stage 与 commit 之间，fork 给出了一个真正的选择点。commit 之后，两个分支继承同一个过去。

### 5.4 事后（After the fact）

如果你 fork 的 Agent 已经做过不可逆的工作，两个分支会继承那段记忆。内核把它记录为一段**共享因果历史（shared causal past）**。哪个分支都无法撤销它。

这没关系。**fork 是用来探索未来的分支的，不是用来重写过去的分支的。**

### 5.5 我们承诺什么，不承诺什么

我们承诺：

- 你总能确定性地回放一个 Agent 的推理过程。
- 你总能在任意有 checkpoint 的时间点 fork 并探索一条替代的未来。
- 你总能知道哪些动作可逆、哪些不可逆。

我们不承诺：

- 撤销已提交的现实。
- 跨外部服务的分布式事务语义。
- 对世界上副作用的「回滚」。

如果你想要那些，你要的是一个带补偿事务的工作流引擎（去看看 Temporal）。Cortex 是另一个工具。

---

## 6. 状态生命周期（预告）

完整状态机在 `PROCESS.md`。快速摘要：

```
                       spawn
                         ↓
                       [new]
                         ↓
                       [ready] ←──────────────┐
                         ↓                  │
                       [running]            │
                  ↙       ↓        ↘        │
            [blocked]  [exiting]  [checkpointing]
                ↓         ↓             ↓
              ready    [zombie]    [suspended]
                                          ↓
                                       restore
                                          ↓
                                        ready

           fork（从 running 或 suspended）
                         ↓
                创建一个新的 [new] 进程
                带着复制出来的快照
                两个进程各自向自己的
                syscall 日志分支追加
```

---

## 7. TypeScript 类型

内核侧契约。这些类型住在 `src/kernel/types.ts`，并从 `cortex-os` 重新导出。

```typescript
export type ProcessId = number;      // 实现中是 Brand<number,'ProcessId'>
export type ChainId = string;        // 串起 checkpoint 的 UUID
export type SyscallOffset = number;  // .crec 日志里的字节偏移

export type Reversibility = 'reversible' | 'idempotent' | 'irreversible';

export interface Message {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly toolCallId?: string;
}

export interface PendingCall {
  readonly id: string;
  readonly tool: string;
  readonly args: unknown;
  readonly startedAt: string;
}

export interface CognitiveSnapshot {
  readonly messages: readonly Message[];
  readonly intent: string | null;
  readonly pendingCalls: readonly PendingCall[];
}

export interface BudgetCounters {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly tokensCached: number;
  readonly usdSpent: number;        // 微美元，整数
  readonly wallTimeMs: number;
  readonly syscallCount: number;
}

export interface MemoryDelta {
  readonly baseChainId: ChainId | null;
  readonly writes: readonly MemoryEntry[];
}

export interface MemoryEntry {
  readonly region: string;
  readonly key: string;
  readonly value: unknown;
  readonly at: string;
}

export type MemoryRegionKind = 'private' | 'shared' | 'cow';

export interface MemoryRegionPolicy {
  readonly kind: MemoryRegionKind;
  readonly backing: string;         // 由驱动标识
}

export interface Checkpoint {
  readonly magic: 'CRTX';
  readonly version: number;
  readonly pid: ProcessId;
  readonly parentPid: ProcessId | null;
  readonly createdAt: string;       // ISO8601
  readonly chainId: ChainId;
  readonly prevInChain: ChainId | null;
  readonly cognitive: CognitiveSnapshot;
  readonly memoryDelta: MemoryDelta;
  readonly budgets: BudgetCounters;
  readonly syscallLogOffset: SyscallOffset;
  readonly driverStates: Readonly<Record<string, Uint8Array | null>>;
  readonly signature: Uint8Array;   // sha256
}

export type ForkKind = 'cognitive';   // v0；sandbox/shadow 之后加

export type BudgetForkPolicy = 'reset' | 'inherit' | 'split';

export interface ForkOptions {
  readonly kind?: ForkKind;                       // 默认 'cognitive'
  readonly budgets?: BudgetForkPolicy;            // 默认 'reset'
  readonly memoryOverrides?: Partial<Record<string, MemoryRegionPolicy>>;
  readonly closeDriverState?: boolean;            // 默认 true
  readonly tag?: string;                          // 人类可读标签
}

export interface ForkResult {
  readonly childPid: ProcessId;
  readonly childChainId: ChainId;
  readonly sharedCausalPast: SyscallOffset;       // 分支发生分叉的日志偏移
  readonly irreversibleInPast: readonly string[]; // 已经发生过的工具名
}
```

---

## 8. 未决问题

这些我们还没决定。每一个都会开一个 issue。

### 8.1 共享内存上的并发

如果两个 fork 出来的 Agent 都往同一个 `shared` 语义记忆区域写，会发生什么？

- **后写覆盖（Last-write-wins）。** 简单。令人意外。对「事实」来说大概是错的。
- **CRDT。** 正确。重。需要选一个 CRDT 库和一套数据模型。
- **加锁。** 熟悉。会强加 Agent 未必想要的协调。

**直觉：** 先用后写覆盖，记录每一次冲突，如果日志显示真的疼了再加 CRDT。别把 v0 过度工程化。

### 8.2 预算分配语义

如果父进程有 5 美元预算然后 fork，子进程拿到 0（reset）、5（inherit）、还是 2.5（split）？

默认的 `reset` 是有立场的。它把 fork 当成「一次新尝试」，而不是「并行探索」。对 Demo C（对比两个分支）来说，`split` 可能更诚实。我们可能需要把它做成每次 fork 可选的选项，默认仍是 `reset`。

### 8.3 syscall 日志的分支

fork 之后，两个进程是带 PID 标签往同一个日志文件追加，还是各自拿到一个独立文件、共享同一段前缀？

- **同一个文件**让「diff 两个分支」的工具变得轻而易举。
- **各自独立文件**实现和推理都更简单。

**直觉：** 独立文件，外加一个小索引知道分叉点在哪。更好做 GC，更好落盘。

### 8.4 「意图」到底是什么？

我们给它留了槽位，但没有定义。它是：

- 最后一条用户消息？
- 一段 Agent 写给自己的自由文本摘要？
- 一个带 schema 的结构化任务对象？

**v0 的答案：** 自由文本字符串，由 Agent 自己负责。等我们看清人们怎么用它，v1 可能标准化。

### 8.5 Checkpoint 链的裁剪

长期运行的 daemon 会产生成千上万个 checkpoint。我们要做垃圾回收吗？按什么策略？

**v0：** 从不裁剪；这是用户的问题；提供一个手动的 `cortex gc` 命令。
**v1：** 可配置的保留策略（保留最近 N 个、保留带标签的、保留每天的）。

### 8.6 驱动状态的选择性开启

一个声明 `forkable: true` 的驱动，是在做一个很强的承诺。我们怎么测试这个承诺？

- CI 里的基于属性的测试（property-based tests）？
- 相信驱动作者？
- 运行时探测（试着 fork，看什么坏了）？

**直觉：** v0 先「相信 + 警告」。v1 加一个 `cortex doctor` 命令来探测驱动。

### 8.7 什么才算「副作用」？

一个只读的 HTTP GET，打到了一个限流的 API、消耗了额度 —— 这算副作用吗？一个 `console.log`，输出到用户正在看的 stdout —— 这算副作用吗？

**v0 的答案：** 如果驱动作者给它标了 `irreversible`，我们就信。我们提供一个 `cortex audit` 工具，把没打标签的工具暴露出来，好让作者注意到。

---

## 9. 我们会在哪里犯错

这份文档是 v0。一些预测：

- 我们会发现一类没列出来的状态（§2 会涨到九个或十个类别）。
- 默认的记忆策略（§2.3）会在某些常见场景下被证明是错的。
- 「可 fork 区域」这个抽象（§5.2）会让人觉得别扭，我们会重新设计它。
- 驱动状态（§2.5）会被证明比我们预想的更常可复制 —— 尤其是无状态的、基于 HTTP 的工具。

这些不是失败。这是这份文档在尽它的职责：**具体到足以被证伪。**

---

*这份文档是 Cortex 的心脏。如果你在这里发现一个缺陷，开一个 issue —— 它比任何内核 bug 都重要。*
