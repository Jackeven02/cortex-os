# Cortex Design Docs

This directory holds the technical specifications. Read them in this order:

1. **[ABI.md](./ABI.md)** — the syscall contract. The most important document after the manifesto. If a behavior is not in the ABI, it does not exist.

2. **[PROCESS.md](./PROCESS.md)** — the agent process lifecycle. States, transitions, what happens on `fork()`, what happens on parent death, how zombies are reaped.

3. **[ARCHITECTURE.md](./ARCHITECTURE.md)** — kernel modules and data flow. Scheduler, IPC, recording, checkpointing, capabilities, drivers.

4. **[HACKING.md](./HACKING.md)** — *(coming in Phase 5)* how to contribute, how to write a driver, how to add a syscall.

---

## Status

All three v0 documents are **drafts in progress**. They will be filled in over the next several sessions. Until they are done, the kernel should not be coded — a wrong abstraction here is a thousand rewrites later.

Track progress in [BACKLOG.md](../BACKLOG.md), Phase 0.
