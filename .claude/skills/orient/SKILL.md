---
name: orient
description: Take a bearing at the start of a new DeepSeek Moby context window. Read the recent commits and the CLAUDE.md work tracker to reconstruct what shipped and what's next, follow the commit trail into whichever docs it points at (docs/plans/, ADRs), then reconcile that ground truth against remembered state (MEMORY.md, cavemem) and flag any drift. Read-only — it briefs, it does not write memory or change code. Run when opening a fresh session or whenever you've lost the thread of where the project stands.
---

# /orient — take a bearing at session start

A new context window starts blind to *where we are*. This reconstructs it from
the sources that don't auto-load — the commits and the docs they point at —
then checks that what you already remember still matches reality.

**Read-only.** The deliverable is a briefing, not actions. It does **not** edit
code and does **not** write memory — memory files and cavemem own writing;
orient only reads and reconciles them. Assumes cwd = the Moby repo root
(same as `/shipshape`).

## The context sources — and which lane is orient's

| Source | Holds | Trust | Loaded |
| --- | --- | --- | --- |
| CLAUDE.md — Architecture / Conventions / Testing | how-to-work rules | authoritative, static | auto |
| CLAUDE.md — Active Bugs / Recently Fixed / Planned Work | the work tracker | *as-of-write-time* — can drift | auto |
| MEMORY.md + `memory/*.md` | curated durable facts | *as-of-write-time* — can drift | auto |
| **cavemem** (MCP, if connected) | narrative / the *why*, cross-session | *as-of-write-time*, richer | **on-demand** |
| **git + docs/plans/ + ADRs** | what the code *is* / the plan *says* | authoritative, **current** | **must be read** |

The Moby twist: CLAUDE.md is **both** the rulebook and the roadmap. The rules
half is authoritative; the tracker half is just another memory that happens to
be checked in — verify it against git like any remembered claim. (Known
failure shape: "Recently Fixed" cites ADR 0004 as latest while
`docs/architecture/decisions/` holds 0013.)

Rules that keep the lanes disjoint:

- **Don't re-summarize CLAUDE.md or MEMORY.md** — they're in context already.
  Add the *delta* (what changed since last session) and the *reconciliation*
  (does remembered/tracked state still match ground truth?).
- **git = what shipped. ADRs = what was decided. cavemem = what was discussed.**
  A commit says *what* changed; `docs/architecture/decisions/` says *why* it
  changed that way. Reach into cavemem only for a *why* that neither the
  commits nor the ADRs carry.
- **orient never writes memory.** If session-start recall already injected the
  narrative, don't repeat it — reconstruct the *ground truth* it can't.

## 1. What shipped — read the commits

```bash
git log --oneline -12
git status --short
```

Read back only until the arc is coherent — usually the last 5–10 commits, not
all of history. You're answering three things: what's the last known-good
state, what landed most recently, and is there uncommitted WIP on the floor.

## 2. Where we meant to be — the work tracker

Read CLAUDE.md's **Active Bugs** and **Planned Work → Next up** (already in
context — *map* onto them, don't re-read). The **frontier** = the first Active
Bug if any, else item 1 of Next up. Then read
`docs/plans/manual-test-backlog.md` — anything listed there is shipped code
awaiting dev-host verification, i.e. standing carry-ins that outrank new work
when the user is about to dogfood.

## 3. Reconcile ground truth against memory  ← the cavemem step

For every remembered or tracked claim that names a concrete artifact — a file,
symbol, ADR number, plan doc, or "fixed" bug — **verify it against what git /
docs / code show now.** Memories and tracker entries reflect what was true
when written; flag drift explicitly rather than trusting them.

Then, and only then, reach for the *why* the commits don't carry (skip cleanly
if the cavemem MCP isn't connected in this session):

```
cavemem search "<topic the commit raised>"   → get_observations(ids)   # targeted
# or replay the last session's decisions:
cavemem list_sessions → timeline(session_id) → get_observations(ids)
```

Query cavemem against a **specific question the commits raised** — never dump
it. Use it to recover a rationale or a thread that never became a commit or an
ADR — not to re-establish state the commits already prove.

## 4. Follow the trail into docs (on demand)

Commit messages and tracker items point at docs — "per docs/plans/subagents.md",
"see ADR 0004". Read the *specific* referenced doc **only when the next move
touches it** (about to start subagent routing → read
`docs/plans/subagents.md`; touching R1 shell semantics → read ADR 0004's
decisions and revisit triggers). Same on-demand rule as cavemem: pulled by a
question, not read by default.

## 5. The bearing (report)

```
ORIENT — Moby @ <branch> <sha>
  shipped     <recent arc in one line>  · last good: <commit>
  wip         <uncommitted files, or "clean">
  frontier    <active bug | Next-up item "<title>">  · untested: <manual-backlog count>
  drift       <remembered/tracked-vs-actual mismatch, or "none">
  next move   <the obvious task> — read <the one doc> first
```

Keep it to that shape. The point is a fast "you are here" that lets work
resume in one turn — not a re-run of the project's whole history.
