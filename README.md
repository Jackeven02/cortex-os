# cortex

> An operating system for AI agents.

[![status](https://img.shields.io/badge/status-design%20phase-orange)](./MANIFESTO.md)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![runtime](https://img.shields.io/badge/runtime-TypeScript%20%2F%20Node%2020%2B-3178c6)](./package.json)

**Today's agent frameworks treat an agent as a function. Cortex treats it as a process.**

PIDs. Fork. Exec. Signals. IPC. Checkpoint. Restore. Supervision trees. Syscall traces. Token budgets. Process groups. Everything Unix gave to programs in 1975, applied to agents in 2026.

Read the **[Manifesto](./MANIFESTO.md)** first. It is short, opinionated, and explains why this project exists.

---

## What it will look like

```bash
# Spawn an agent as a background process
$ cortex spawn --role coder --task "fix issue #42"
[pid 1234]

# Inspect the process tree
$ cortex ps
PID    PPID   ROLE       STATE     TOKENS   AGE
1234   1      coder      running   12.3k    2m
1235   1234   tester     waiting   0        30s
1236   1234   reviewer   blocked   2.1k     10s

# Attach to a running agent
$ cortex attach 1234
[attached. ctrl-d to detach]
> analyzing stack trace, calling grep tool...

# Fork state to try an alternative path
$ cortex fork 1234
[forked as pid 1240]
$ cortex send 1240 "try dynamic programming instead"

# Trace every syscall
$ cortex trace 1234
14:23:01 llm_call(prompt=..., tools=[grep,edit]) -> "I'll search..."
14:23:04 tool_call(grep, "TypeError") -> "src/foo.ts:42"
14:23:06 llm_call(...) -> "Found it, editing now"

# Pause and resume across reboots
$ cortex checkpoint 1234 --tag "before risky edit"
$ cortex kill 1234
# ... next day ...
$ cortex restore --tag "before risky edit"
[restored as pid 1502]
```

None of this works yet. All of it will.

---

## Status

**Phase 0 — Design.** Manifesto, syscall ABI, process model, architecture. No code yet beyond skeletons.

See **[BACKLOG.md](./BACKLOG.md)** for the first 30 issues, prioritized.

---

## Documentation

| Document | What it covers |
|---|---|
| [MANIFESTO.md](./MANIFESTO.md) | Why cortex exists. Start here. |
| [docs/STATE.md](./docs/STATE.md) | **The hard part.** What agent state is, what gets copied on fork, what cannot be copied at all. |
| [docs/PROCESS.md](./docs/PROCESS.md) | Agent lifecycle: 8 states, 12 transitions, signals, scheduling |
| [docs/ABI.md](./docs/ABI.md) | Syscall contract, in TypeScript types *(pending)* |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Kernel modules and data flow *(pending)* |
| [docs/CRITIQUE.md](./docs/CRITIQUE.md) | Running log of external critique and what we changed because of it. |
| [BACKLOG.md](./BACKLOG.md) | First issues, prioritized |

---

## Design lineage

Cortex is what would have happened if **Plan 9**, **Erlang/OTP**, and **MINIX** had been designed for LLM agents instead of file systems, telecom switches, and teaching kernels.

We borrow shamelessly:

- From Unix: processes, signals, file descriptors, "everything is a file."
- From Plan 9: the syscall as a clean, uniform interface; protocol as the universal solvent.
- From Erlang: supervision trees, hot code reloading, "let it crash."
- From MINIX: microkernel discipline, smallness as a virtue.
- From seL4: the long-term aspiration of formal guarantees.

---

## Contributing

This is a v0 design phase. The most valuable contributions right now are:

1. **Arguments.** Open an issue and tell us why a syscall is wrong, missing, or redundant.
2. **Prior art.** Point us to existing systems (research or production) that already do part of this.
3. **Benchmarks.** Propose workloads the kernel must handle gracefully.
4. **Code.** Once the ABI lands, kernel and driver work will move fast.

If you want to build the OS layer for agents with us, open an issue titled `[hello]` and tell us what you care about.

---

## License

MIT. See [LICENSE](./LICENSE).

---

## A note on the name

A *cortex* is the outer layer of an organ where the interesting work happens — the cerebral cortex, the adrenal cortex, the renal cortex. It is not the whole brain. It is the part that thinks.

That is what this kernel aspires to be: not the whole agent stack, but the thin layer where everything else becomes possible.
