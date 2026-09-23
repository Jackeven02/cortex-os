# X / Twitter — launch thread

> 8 posts. Each fits in 280 chars. Keep the code block in 4/ as a plain quote if
> X mangles the formatting. Post the repo link in 8/ (and let X's card do the
> rest); pin the thread.

---

**1/8**

An agent is not a function.

It's a process — with a PID, a parent that supervises it, a log of every
syscall, and a lifetime that outlives its caller.

Cortex is a kernel that makes that the *real* abstraction, with the primitives
Unix gave programs in 1975. 🧵

---

**2/8**

The primitives, borrowed verbatim from Unix:

spawn · ps · kill · wait · fork · diff · checkpoint · restore · trace · attach · limit · daemon

24 syscalls. 11 kernel modules. Pure TypeScript, Node 22+, exactly one runtime
dep (cborg, for the CBOR syscall log), MIT.

---

**3/8**

The demo that convinced me this is a real primitive, not a metaphor:

A long-running agent checkpoints mid-thought and suspends.
The machine reboots. The kernel is gone.
`cortex restore` brings it back as a *new PID*, memory intact — and it skips the
work it already did.

Pause is a process primitive, not a prompt trick.

---

**4/8**

A supervisor, in your own code:

```
const { pid } = await ctx.spawn({ role: 'coder', agent: {...} });
try   { await ctx.wait(pid, { timeoutMs: 8000 }); }
catch { await ctx.kill(pid, 'SIGKILL'); /* respawn */ }
```

No orchestrator. No YAML. The timeout is an *observation*; the kill is your
call. That's the whole restart policy.

---

**5/8**

Fork = agent search.

`ctx.fork()` clones a process at its current state. Run two strategies in
parallel. Then `cortex diff` lines up their syscall logs from the exact byte
offset where they diverged.

Explore the whole decision tree at once. Keep the winner.

---

**6/8**

Every syscall is recorded — append-only CBOR, replayable.

*"Why did it do that?"* should have an answer that isn't *"the model felt like
it."*

`trace`, `attach`, `audit`, per-process token/USD/time budgets, 13 signals.

Debugging an agent should not be harder than debugging a program.

---

**7/8**

Honest about v0:

• A checkpoint captures the process *image*, not the JS call stack → a restored
  agent re-runs from the top and skips done work via a memory marker.
• Single host. No distribution.

Design docs written before the code. Gaps are in the repo, not hidden.

---

**8/8**

Repo → github.com/Jackeven02/cortex-os

Manifesto, four design contracts (STATE / PROCESS / ABI / ARCHITECTURE),
HACKING + COOKBOOK, and three demos that run offline.

If you look at agent frameworks and think *"this is not how computers work"* —
this one's for you. Harsh feedback very welcome.
