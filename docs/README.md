# Cortex Design Docs

This directory holds the technical specifications. **Read them in this order:**

1. **[STATE.md](./STATE.md)** — the agent state model. What gets copied on fork. What cannot be copied at all. The irreversible-action doctrine. **This is the hardest and most important document in the project.** Everything else depends on it.

2. **[PROCESS.md](./PROCESS.md)** — the agent process lifecycle. Eight states, twelve legal transitions, full signal table, scheduling policy, daemon/supervision posture, TypeScript types, seven open questions.

3. **[ABI.md](./ABI.md)** — the syscall contract. **Eighteen syscalls**, full TypeScript types, error model, recording format, three driver interfaces (LLM, Tool, Memory), seven open questions. If a behavior is not in the ABI, it does not exist.

4. **[ARCHITECTURE.md](./ARCHITECTURE.md)** — kernel modules and data flow. **Eleven modules** (recorder, process_table, signals, ipc, memory, checkpoint, fork, scheduler, init, syscall_dispatcher, driver_registry), the full syscall lifecycle trace, driver model, persistence layout (`.cortex/`), boot sequence, concurrency model, file layout, six open questions, and an honest "what we will get wrong" prediction section.

5. **[CRITIQUE.md](./CRITIQUE.md)** — the running log of external critique and what we changed (or didn't) because of it.

6. **[HACKING.md](./HACKING.md)** *(coming in Phase 5)* — how to contribute, how to write a driver, how to add a syscall.

---

## Status

| Document | State |
|---|---|
| STATE.md | **drafted v0** — open questions logged in §8 |
| PROCESS.md | **drafted v0** — open questions logged in §11 |
| ABI.md | **drafted v0** — open questions logged in §9 |
| ARCHITECTURE.md | **drafted v0** — open questions logged in §12 |
| CRITIQUE.md | live, 1 entry |
| HACKING.md | post-v0.1 |

**Phase 0 is design-complete.** The four core documents are drafted v0; open questions in each doc are intentionally rolling — they resolve as Phase 1 implementation forces decisions. Phase 1 (kernel skeleton, ~1500 lines TS) is unblocked.

Track progress in [BACKLOG.md](../BACKLOG.md), Phase 0.

---

## A note on document ordering

We wrote STATE.md before ABI.md on purpose. The syscall surface is the *easy* part — you can write down `llm_call(prompt, tools) -> response` in an afternoon. The hard part is deciding what `fork(pid)` actually *does* to that prompt history, to the tool sessions, to the side effects already in the world.

If we had written ABI.md first, we would have specified a beautiful interface and then discovered, while implementing fork, that we had no answer for what was being forked. STATE.md exists so that discovery happens on paper instead of in code.
