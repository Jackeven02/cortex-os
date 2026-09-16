# Critique Log

Cortex is built in the open and reviewed in the open. This file is a running record of substantive external critique — what reviewers said, what we changed because of it, and what we deliberately did not change.

The point is not to flatter critics or to capitulate to them. The point is to make our reasoning legible to future contributors, who will rightly ask *"why is this design the way it is?"*

Each entry follows the same structure: **Source · What they said · What we absorbed · What we rejected · Why.**

---

## 001 — Cross-model review of the initial design

**Date:** 2026-09-17
**Source:** A second LLM, asked to review the cortex pitch independently. Pasted back by the project lead as a cross-check.
**Stage:** Pre-code, post-manifesto.

### What they said

> "Concept has merit, but the 'Agent OS' grand narrative is currently running ahead of actual demand. What's worth doing first is not an 'operating system' but one specific core capability — Agent Process Runtime (pausable, resumable, forkable, supervised, communicating, budgeted, persistent).
>
> The biggest risk: building lots of low-level abstractions that developers find cool, but they don't know why they should migrate, so nobody uses it.
>
> The real technical meat is not PIDs and CLI — it is **defining what Agent State is**. What gets copied on fork? LLM context? Memory? Filesystem? Database? Tool side effects? External API? Tokens? Environment?
>
> If you build this seriously, you should write down an Agent State definition first."

The reviewer also recommended cutting the OS framing, focusing on four primitives (`spawn`, `checkpoint/resume`, `supervisor/restart`, `fork/branch`), and pursuing an enterprise dashboard / fleet management commercial path.

### What we absorbed

1. **`docs/STATE.md` was promoted from "nice to have" to the highest-priority design document.** The reviewer is right: fork semantics, checkpoint format, and the irreversible-action problem are the technical heart of this project. If we get them wrong, no amount of CLI polish saves us. STATE.md now exists, and it is the document we expect to be most cited and most argued with.

2. **MANIFESTO gained a new section §IV "Why Not..."** that directly answers the "isn't this just Temporal / LangGraph / Kubernetes?" question. This was a hole in v0 of the manifesto and the reviewer's framing forced us to fill it.

3. **Demo order changed from A→B→C to B→C→A.** Demo B (long-running daemon, checkpoint/resume across reboot) is the most differentiated from existing tools and the most legible to non-experts. It now leads.

4. **Capability/permission system was demoted from Phase 1 to icebox.** The reviewer's "cut 70%" instinct was over-broad, but the specific point about permissions was correct: v0 does not need them, and adding them early would slow the kernel without solving a real problem.

5. **STATE.md §8 "Open Questions" exists explicitly because of this review.** A reviewer told us we had not thought hard enough about state. The honest response is to publish the questions we have not answered, not to fake confidence.

### What we rejected

1. **"Drop the OS framing, call it a Runtime."** Rejected. The OS framing is not decoration; it is the project's intellectual spine. It commits us to abstraction discipline (small kernel, explicit syscalls, composition over features). It is also a far stronger attractor for the kind of contributors we want — systems people who would never read a manifesto for "yet another agent runtime" but will read one for "an operating system for AI agents." Plan 9 was not called "the Plan 9 file protocol runtime." Names shape destinies.

2. **"Pursue enterprise fleet management as the commercial path."** Rejected, but with respect. The path is real and the reviewer is correct that it is where money lives. It is just not what this project is for. Cortex's goal is to push the field forward and to be a beautiful piece of infrastructure. If commercial deployments emerge later, that is a derivative outcome, not the design constraint. We will not let an imagined enterprise buyer shape v0.

3. **"Cut 70% of the ambition."** Rejected as stated. The reviewer's list of things to cut (VFS, signals, capabilities, drivers, "real kernel," Rust 1500 lines) was partly directed at a strawman — cortex v0 was never going to be Rust, never going to ship a VFS, and was already scoped to a small TypeScript kernel. We did cut capability (§5 above). The rest of the cuts would have removed things we actually need.

### Why this matters

The reviewer's strongest contribution was forcing us to write STATE.md before ABI.md. Without that intervention, we would have specified a beautiful syscall surface and then discovered, while implementing `fork()`, that we had no answer for "what is being forked." That discovery would have cost weeks.

The reviewer's weakest contribution was the implicit assumption that the project's success criteria are commercial. They are not. Once that mismatch is named, the rest of the disagreement is mostly aesthetic.

**Net change to the project:** +1 critical document (STATE.md), +1 manifesto section, ±reordering of demos and Phase 1.

---

## How to add an entry

If you give us substantive critique — in an issue, a PR review, a blog post, a tweet — and we change the design because of it, you will be credited here. Format:

```
## NNN — Short title

**Date:** YYYY-MM-DD
**Source:** who / where
**Stage:** what phase the project was in

### What they said
> Quote or summarize the critique honestly, including the parts that sting.

### What we absorbed
Numbered list of concrete changes made.

### What we rejected
Numbered list of points we considered and disagreed with, with reasons.

### Why this matters
One paragraph on what the project gained (or did not lose) by engaging.
```

We will not pretend every critique was right. We will not pretend every critique was wrong. We will write down what happened.
