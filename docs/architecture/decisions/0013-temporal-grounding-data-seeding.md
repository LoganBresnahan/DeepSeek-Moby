# 0013. Temporal grounding II: data-seeding classification clause (and a deferred behavioral backstop)

**Status:** Accepted — Lever B (the data-seeding clause) implemented as specified. The behavioral recency pin is **designed and deferred** (a documented follow-up, built only if trace data shows the clause alone is insufficient).
**Date:** 2026-06-21

Extends ADR [0007](0007-system-prompt-temporal-grounding.md) (which gave the model a standing date + staleness directive). This ADR does not supersede it — the always-present temporal block stays exactly as 0007 specified; 0013 strengthens its *wording* and records why the fix lives at primacy rather than in a recency re-pin.

## Context

A traced run (the **4:26pm** session) asked Moby to build a Blazor app and populate it with World Cup data. The model produced a clean, building app — and seeded it from **parametric memory**, yielding stale (old-tournament) data. It called `web_search` **zero** times across 31 iterations.

The decisive detail: it didn't search at iteration 31, and it didn't search at iteration **1** — when the ADR 0007 temporal directive was *fresh at primacy*, at the top of the prompt. The directive explicitly says "for live scores/standings … do NOT answer from memory. Call web_search first." World Cup squads and standings are squarely on that list. The model read it and seeded anyway.

So this is **not** salience decay over a long turn (the failure mode ADR [0009](0009-active-plan-recency-pinning.md) addresses for plans). It is a **task-classification** failure: the model filed "seed my app's data with real-world facts" as *a coding task*, not as *a time-sensitive lookup*. The 0007 directive's enumerated categories are phrased as things you **answer the user** about; the model never mapped *writing seed data into a file* onto them. The rule was present, fresh, and correctly worded for a case the model didn't recognize it was in.

This naturally suggested mirroring ADR 0009: if the plan needed re-pinning at recency to stay salient across a long turn, maybe the date does too. That hypothesis was pressure-tested with an adversarial design pass (5 steelmanned trigger designs, each attacked by an independent critic, plus a dedicated cost analysis). The pass **rejected** the re-pin-as-primary-fix idea, for reasons that turn out to be structural — see Alternatives.

## Decision

Two coupled changes, one shipped and one deferred.

### Lever B — harden the primacy directive (implemented)

Add a **data-seeding classification clause** to the always-present temporal block in `buildSystemPrompt` ([requestOrchestrator.ts](../../../src/providers/requestOrchestrator.ts), section 4.5), immediately after the existing staleness directive:

> This rule covers DATA you write, not just answers you give the user: seeding, populating, or hard-coding real-world facts — team rosters, fixtures, standings or results, prices, release versions, officeholders — into a source or data file IS a time-sensitive lookup. Verify with web_search before writing such data; do not seed it from memory.

This operates at the **iteration-1 decision point** — the only place the actual failure occurred — and targets the actual mechanism (mis-classification) by giving the rule an explicit handle for the seeding case. It reuses 0007's model-agnostic, no-hard-coded-cutoff framing and the single hoisted `today` source. It is **advisory, not enforced** (enforcement remains ADR [0011](0011-verification-gated-turn-completion.md)'s concern), and adds a handful of tokens to the cached system prefix on every turn.

### A behavioral recency backstop (designed, deferred)

For the iteration-2+ case — a long authoring streak where the model keeps writing fact-bearing data without searching, and primacy salience has decayed — the design is a **behavioral** re-pin, `maybeRepinTemporalReminder`, fired at the same iteration boundary as `maybeRepinPlanReminder` ([:3669](../../../src/providers/requestOrchestrator.ts#L3669) / [:4031](../../../src/providers/requestOrchestrator.ts#L4031)) **only** when *all* hold:

1. **Armed** — `web_search` is actually in the schema this turn (`includeWebSearch` at [:3805](../../../src/providers/requestOrchestrator.ts#L3805)); never tell the model to call a tool it doesn't have.
2. **Not recently searched** — zero searches this turn, or ≥ `TEMPORAL_REPIN_GAP_ITERS` (≈4) iterations since the last one.
3. **Just authored real-world-fact content** — a `write_file`/`edit_file` this iteration whose payload trips a cheap `assertsRealWorldFact()` heuristic (4-digit year, proper-noun-bearing array/table literals, or a domain keyword), targeting a data/content file (reusing the existing build-output/edit-safety path filters).
4. **Anti-dilution** — off a short cooldown and capped at ≤2 pins/turn.

Crucially there is **no fade/interval trigger** — see Alternatives B. The date is static within a turn, so a time-based re-pin only re-states ignored text; the *behavioral signal* is the trigger.

This is deferred, not rejected: the heuristic carries false-positive risk (copyright years, config literals) and needs a `getSearchCount()` getter plus per-turn counters. The classification clause is the higher-leverage, lower-risk fix; ship it first and add the backstop only if traces show continued misses past iteration 1.

## Alternatives considered

### A. Piggyback the date onto the active-plan reminder

Fold a one-line date stamp into the reminder `maybeRepinPlanReminder` already pins, for zero new messages.

Rejected — **structural availability inversion.** `getActivePlanReminder` returns `''` with no active plan, so the carrier no-ops. The 4:26pm "just build me X" turn authored no `.moby-plans/*.md` and toggled no plan, so the stamp would have landed **nowhere** — the nudge is present only when the user was organized enough to write a plan, and absent in exactly the unplanned, spray-and-pray turns where parametric seeding happens. It also welds a never-changing footnote onto dynamic steering content.

### B. Standalone fade-backstop re-pin (mirror 0009, drop the change-gate)

Re-pin the temporal block as its own `user` message every N unchanged iterations, like `PLAN_REMINDER_FADE_ITERS=6`.

Rejected — it copies 0009's skeleton but amputates the organ that does 0009's real work. The plan reminder earns its recency slot because its text is **dynamic** ("step N of M" mutates as boxes get ticked); its change-gate carries the mechanism and the fade is a backstop. The date is **static** by construction (computed once per turn). A fade-only re-pin of static text is precisely the boilerplate-blindness regime the change-gate exists to escape: it fires no earlier than iteration ~8 (absent at the iteration-1 failure point) and, when it fires, re-states verbatim wording the model already ignored at primacy.

### C. Always re-pin (every iteration boundary)

The literal "it's incredibly cheap for DeepSeek, just do it" stance.

Rejected — highest-toxicity option for the recency edge. Token cost *is* negligible (append-only pin = cache-hit prefix + ~40 miss-tokens), but tokens are the wrong budget. Repeating the sentence the model demonstrably ignored when fresh ~30×, near-verbatim with the primacy block, maximizes banner-blindness — and that habituation generalizes to the **dynamic plan reminder** sharing the same slot, degrading the load-bearing reminder to "optimize" a free axis.

### D. Lever B alone, no backstop ever

Ship only the primacy clause.

Not rejected — adopted as the **primary** lever, and the only one shipping now. Rejected as provably *sufficient*: its own kill-shot is real — the model already ignored a precise primacy directive (and the `web_search` tool-description hint), so a longer primacy version risks "the same words, louder." That residual is what the deferred behavioral backstop covers, in a *different channel* (recency) gated on a *different signal* (authored fact-data), for the iteration-2+ case the clause can't reach. Pair, don't pick — but pair *later*, only if needed.

## Consequences

**Positive:**
- The directive now names the seeding case explicitly, at the primacy decision point where the miss actually happened — the highest-leverage place to flip the iteration-1 classification.
- The fix is ~5 lines of prose in an already-cached block: no new state, no new module, no recency competitor for the plan reminder, no heuristic to tune. Lowest-risk option that addresses the diagnosed root cause.
- The adversarial analysis is recorded, so a future "why not just re-pin the date like 0009?" gets a documented answer (static vs. dynamic text; classification vs. decay) instead of a re-litigation.

**Negative / accepted costs:**
- A few extra tokens on **every** turn, including pure refactors that have no real-world data. Negligible against the failure prevented, but real for thin-budget local 7B/14B models — if it bites, the clause can later be gated behind a coarse seeding-intent match on the first user message.
- **Advisory, not enforced** — a model can still ignore the strengthened clause (this is Lever B's own kill-shot). The deferred backstop is the mitigation, and hard verification stays ADR 0011's job.
- The iteration-2+ long-authoring-streak case is **not** covered until/unless the behavioral backstop ships; the clause raises iteration-1 propensity but does not re-assert itself mid-turn.

**Follow-ups:**
- Build the behavioral recency backstop (`maybeRepinTemporalReminder` + `getSearchCount()` + `assertsRealWorldFact()`) **only if** trace data shows seeding misses persisting past the clause. Tune the heuristic to ≥2 signals or year+keyword co-occurrence to bound false positives; keep the ≤2/turn cap.
- A replay harness for the 4:26pm trace (and 2-3 sibling "build + populate with real data" prompts) to measure whether the clause flips the iteration-1 search decision, rather than reasoning about it.

## Test plan

Framework is **vitest**, extending the existing `describe('temporal grounding (ADR 0007)', …)` block in [tests/unit/providers/requestOrchestrator.test.ts](../../../tests/unit/providers/requestOrchestrator.test.ts).

- **Seeding clause present (new, shipped):** on a normal turn the system prompt contains `seeding`, the load-bearing phrase `IS a time-sensitive lookup`, and `do not seed it from memory`. This is the direct regression for the 4:26pm miss. (The existing presence/date/ordering/single-source/reasoner tests continue to cover the rest of the block unchanged.)
- **Behavioral backstop (when built):** `maybeRepinTemporalReminder` fires only when armed + not-recently-searched + just-wrote-fact-data + off-cooldown + under-cap; does **not** fire on a pure refactor turn; respects the ≤2/turn ceiling; and `assertsRealWorldFact()` returns false for a bare copyright-year literal but true for a roster/standings table.

## Documentation plan

- This ADR.
- **CHANGELOG.md** — entry under `[Unreleased]`.
- **[docs/guides/system-prompt.md](../../guides/system-prompt.md)** — the quoted temporal block updated with the seeding clause; a design note on why the fix is primacy (classification), not a recency re-pin (decay); and an ADR 0013 row in Related decisions.
- **[docs/architecture/decisions/README.md](README.md)** — Index row for 0013.
