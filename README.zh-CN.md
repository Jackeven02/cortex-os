# cortex

> AI agent 的操作系统。

[![status](https://img.shields.io/badge/status-design%20phase-orange)](./MANIFESTO.md)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![runtime](https://img.shields.io/badge/runtime-TypeScript%20%2F%20Node%2020%2B-3178c6)](./package.json)

[English](./README.md) | **简体中文**

**今天的 agent 框架把 agent 当函数。Cortex 把它当进程。**

PID。Fork。Exec。Signals。IPC。Checkpoint。Restore。监督树。Syscall 追踪。Token 预算。进程组。Unix 在 1975 年给程序的所有东西,2026 年给 agent 再来一遍。

先读 **[Manifesto](./MANIFESTO.md)**。短、有立场、解释这个项目为什么存在。

---

## 它会长这样

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

# attach 到正在跑的 agent
$ cortex attach 1234
[attached. ctrl-d to detach]
> analyzing stack trace, calling grep tool...

# fork 状态,去试另一条路
$ cortex fork 1234
[forked as pid 1240]
$ cortex send 1240 "try dynamic programming instead"

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
```

这些现在都跑不了。但都会跑起来。

---

## 当前状态

**Phase 0 — 设计(完成)。** 四份文档 v0 草稿落地:`STATE.md`(最难的那份)、`PROCESS.md`(生命周期)、`ABI.md`(syscall 契约)、`ARCHITECTURE.md`(内核模块)。每份文档末尾的 open questions 是有意的滚动任务 —— 等 Phase 1 实现逼出决定。

**Phase 1 — 内核骨架(下一步)。** 约 1500 行 TypeScript:进程表、调度器、syscall 分发器、recorder、checkpoint、fork、IPC、signals、init。

完整 issue 列表见 **[BACKLOG.md](./BACKLOG.md)**(50 条,按优先级排好)。

---

## 文档

| 文档 | 内容 |
|---|---|
| [MANIFESTO.md](./MANIFESTO.md) | cortex 为什么存在。先读这个。 |
| [docs/STATE.md](./docs/STATE.md) | **最难的部分。** agent state 是什么,fork 时复制什么,什么根本不能复制。 |
| [docs/PROCESS.md](./docs/PROCESS.md) | agent 生命周期:8 个状态,12 个合法转换,signals,调度策略 |
| [docs/ABI.md](./docs/ABI.md) | syscall 契约:18 个 syscall,3 个 driver 接口,错误模型,记录格式 |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 内核模块和数据流:11 个模块,syscall 生命周期,持久化布局,并发模型 |
| [docs/CRITIQUE.md](./docs/CRITIQUE.md) | 外部批评的滚动记录,以及我们因此改了什么(或没改)。 |
| [BACKLOG.md](./BACKLOG.md) | 第一批 issue,按优先级排好 |

---

## 设计血统

Cortex 是这样一个假设的产物:如果 **Plan 9**、**Erlang/OTP**、**MINIX** 当初是为 LLM agent 设计的(而不是文件系统、电信交换机、教学内核),它们会长成什么样。

我们无耻地借鉴:

- 从 Unix:进程、signals、文件描述符、"一切皆文件"。
- 从 Plan 9:syscall 作为干净统一的接口;协议作为万能溶剂。
- 从 Erlang:监督树、热代码重载、"let it crash"。
- 从 MINIX:微内核纪律、小即是美德。
- 从 seL4:对形式化保证的长期向往。

---

## 参与贡献

现在是 v0 设计阶段。最有价值的贡献:

1. **争论。** 开 issue 告诉我们某个 syscall 为什么是错的、缺的、或多余的。
2. **prior art。** 指出已经做了其中一部分的现有系统(研究或生产)。
3. **benchmark。** 提出内核必须优雅处理的 workload。
4. **代码。** ABI 落地之后,内核和 driver 的工作会推进很快。

如果你想和我们一起做 agent 的 OS 层,开一个标题为 `[hello]` 的 issue,告诉我们你关心什么。

---

## License

MIT。见 [LICENSE](./LICENSE)。

---

## 关于这个名字

*cortex*(皮层)是器官外层负责有意思的工作的那一层 —— 大脑皮层(cerebral cortex)、肾上腺皮质(adrenal cortex)、肾皮质(renal cortex)。它不是整个大脑。它是负责思考的那一层。

这个内核想成为的就是这个:不是整个 agent 栈,而是让其他一切成为可能的那层薄皮。
