# Active-Plan Context

How an active plan from `.moby-plans/` reaches the model, and why it is injected in **two** places. Implementation reference for [ADR 0009](../decisions/0009-active-plan-recency-pinning.md).

## The invariant

The active plan's **current step** stays salient at the model's decision point through a long multi-iteration turn — without re-emitting the whole plan on every iteration, and with a single source of truth so the two copies can't contradict.

## Why this exists (one paragraph)

A traced auto-mode session (the `914pm` run) drifted off an active plan partway through a long agentic turn: it followed the plan for a few iterations, then skipped a step, re-did a completed one, and declared "done" with checklist items untouched. The plan was in context the entire time — injected into the system prompt on every request. The failure was **salience, not absence**: a single agentic turn is not one model call but the tool-calls loop running up to `maxToolCalls` iterations, and the system prompt (with the plan inside it) stays frozen at the *head* while reasoning and tool output accumulate between it and the model's current action. By iteration 15 the plan is thousands of tokens upstream — classic primacy fade / "lost in the middle".

## The two placements

The plan does two jobs; they want different context positions.

| Job | Position | Decay profile | Producer |
|-----|----------|---------------|----------|
| **Orientation** — the full goals/approach, read once | System prompt (primacy, head) | Frozen at the head; fades as the loop grows | `PlanManager.getActivePlansContext()` |
| **Steering** — *which step am I on right now* | Tail of the last user message (recency) + re-pinned mid-loop | Re-anchored next to the live action | `PlanManager.getActivePlanReminder()` |

`PlanManager` is the **single computed source** of both. The full prose lives once (system prompt); the recency block carries only the *derived pointer* (step N/M + remaining), so the head and tail can't drift, and there's no second copy of the prose to contradict the first.

### 1. Orientation — system prompt, size-capped

`getActivePlansContext({ maxChars })` injects active plans into the system prompt at section 5 of `buildSystemPrompt` ([requestOrchestrator.ts](../../../src/providers/requestOrchestrator.ts)), wrapped in `--- ACTIVE PLANS ---` / `--- END PLANS ---`. Each plan **body** is capped (default `DEFAULT_PLAN_MAX_CHARS` ≈ 1,500 chars) so an over-long plan can't crowd out the rest of the prompt; an over-cap body is truncated with `… (truncated; full plan in .moby-plans/<name>)`. Pass `maxChars: 0` to disable the cap (legacy behaviour).

### 2. Steering — terse reminder at recency

`getActivePlanReminder()` returns a compact block pinned at the tail of the last user message, immediately after the selected-files block ([requestOrchestrator.ts](../../../src/providers/requestOrchestrator.ts)):

```
--- ACTIVE PLAN (reminder) ---
plan-build-deck.md — step 3 of 7
Remaining:
[ ] 3. Wire Slide3 feedback-loop diagram
[ ] 4. Lifecycle slide
… (+2 more)
(full plan and completed steps are in the system prompt)
--- END ACTIVE PLAN ---
```

It is small by construction — a step count plus the *remaining* items (capped at `MAX_REMAINING_SHOWN`, the rest collapsed to `… (+K more)`), never the prose. It is derived for the **first active plan**.

## The checklist convention

`step N of M` is derived from the plan's checklist by `parsePlanSteps`:

- **GitHub-style checkbox items** — `- [ ]`, `* [x]`, `[ ]`, or numbered `1. [ ]` — anywhere in the body. `current step = first unchecked`, `M = total`, `Remaining` = the unchecked items. This is the live, agent-tickable shape.
- **A plain numbered list** (no checkboxes) degrades to `step 1 of M`, all items remaining; as the model adds `[x]`, it transitions to checkbox parsing.
- **Empty-bodied items** (e.g. the `1. ` from the new-plan template) are skipped, so a blank template reports no bogus pointer.
- **No parseable checklist** (free-form prose) → the reminder names the plan with no `step N of M` line. Never an error.
- **All boxes checked** → `<plan> — all M steps checked` with a verify-and-finish nudge, no `Remaining` list.

The agent advances the pointer by **checking off boxes** (`[ ]` → `[x]`) via an ordinary `edit_file` — no new tool. Because the plan file is mutated as work progresses, the *changing* content is what stays salient, and the file doubles as user-visible progress in `.moby-plans/<name>`. The edit is covered by the edit-safety transaction ([ADR 0006](../decisions/0006-edit-safety-checkpoint-and-validation.md)).

## In-turn re-pin: change-driven, with a fade backstop

The recency anchor only fixes iteration 1 — by iteration 15 it has the same fade problem as the system prompt. So at each iteration boundary (mirroring the edit-safety settle-point callback), `maybeRepinPlanReminder` recomputes the reminder from `PlanManager` and re-pins it as a fresh `user` message when **either**:

1. **the reminder text changed** since the last pin (the model ticked a box, so the derived pointer moved) — the primary, change-driven trigger; or
2. **`PLAN_REMINDER_FADE_ITERS` (6) iterations have elapsed with no change** — a fade backstop.

The backstop is **load-bearing, not belt-and-suspenders**. A pure change-gate has a failure mode that is *exactly the drift this targets*: the reminder is pinned once at iteration 1, and if the model then stops ticking boxes (the behaviour of a model losing the plan), the pointer never moves, the gate never fires, and the recency copy decays back into the middle of a long turn. The mechanism cannot depend solely on the discipline (ticking boxes) whose absence it exists to correct — so the backstop re-anchors salience even when the pointer is stuck.

It stays distinct from a noisy fixed-cadence re-emit (rejected as Alternative D in the ADR) on both axes that made that noisy: it re-pins only the **terse** block (not the prose), and the 6-iteration floor is a *reset-on-change* counter (not a fixed clock), so a steadily-advancing turn never triggers it.

Implementation notes:

- The change-gate is a **string diff** of `getActivePlanReminder()`'s output against `_lastPlanReminder`, not a separately tracked pointer integer — any change in step *or* remaining items re-pins, and there's no second source to drift from `PlanManager`.
- The recency seed (placement 2) primes `_lastPlanReminder` and zeroes `_planReminderStaleIters` so the first iteration boundary doesn't redundantly re-pin identical text. Both fields reset per turn.
- Wired into **both** agentic loops — `runStreamingToolCallsLoop` (pushes to `currentMessages`) and the legacy `runToolLoop` (pushes to `toolMessages`), mirroring how ADR 0011 covered both paths. The recency seed sits before pipeline selection, so it already covers every path.

## Tests

- **`PlanManager` parsing/derivation** ([tests/unit/providers/planManager.test.ts](../../../tests/unit/providers/planManager.test.ts)): `step N of M` from a `[ ]`/`[x]` checklist (remaining-only), the same pointer from a numbered checklist, plain-numbered degradation to `step 1 of M`, free-form and empty-template → no pointer, all-complete, the remaining-cap `… (+K more)`, no-active-plan/no-workspace → `''`; plus `getActivePlansContext` `maxChars` truncation (and `maxChars: 0` disables it).
- **Request-build split** ([tests/unit/providers/requestOrchestrator.test.ts](../../../tests/unit/providers/requestOrchestrator.test.ts)): the terse reminder lands in the last user message, the full plan in the system prompt, the prose appears exactly once across the two, and a changed step shows up in the next turn (tracks `PlanManager`).
- **In-turn re-pin** (same file): `maybeRepinPlanReminder` re-pins on change, no-ops on an unchanged reminder inside the fade window, and the **fade backstop** re-pins after `PLAN_REMINDER_FADE_ITERS` unchanged iterations (the regression guard for the model-stops-ticking-boxes case); plus a loop-driven wiring test proving the streaming loop re-pins the advancing step into its message array.

## Related

- [ADR 0009](../decisions/0009-active-plan-recency-pinning.md) — decision + alternatives.
- [ADR 0007](../decisions/0007-system-prompt-temporal-grounding.md) — keeps a *stable* rule (date/staleness) at primacy; 0009 keeps *evolving turn state* at recency.
- [ADR 0010](../decisions/0010-web-search-query-ledger-and-cache.md) — the same recency-reminder pattern for the per-turn search ledger.
- [ADR 0006](../decisions/0006-edit-safety-checkpoint-and-validation.md) — the settle-point callback this re-pin mirrors, and the transaction covering the agent's check-off edits.
