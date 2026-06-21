# 0009. Active-plan recency pinning (context salience)

**Status:** Proposed
**Date:** 2026-06-20

## Context

A traced auto-mode session on 2026-06-14 (the "914pm" run) drifted off an active plan partway through a long agentic turn. The user had an active plan in `.moby-plans/` describing a multi-step build; the model followed it for the first few iterations, then began improvising — skipping a step, re-doing one it had already completed, and finally declaring the turn done with two checklist items untouched. The plan was *present in context the whole time*. The failure was salience, not absence.

It is worth stating the mechanics precisely, because an earlier triage assumed the plan was being dropped. It is not. The active plan **is** injected on **every** request, re-read from disk each time, into the **system prompt**:

```ts
// ── 5. Active plans ──
if (this.planManager) {
  const plansContext = await this.planManager.getActivePlansContext();
  if (plansContext) {
    systemPrompt += plansContext;
  }
}
```

at [requestOrchestrator.ts:1433-1439](../../../src/providers/requestOrchestrator.ts#L1433), via [`getActivePlansContext`](../../../src/providers/planManager.ts#L152), which wraps the concatenated active plan files in a `--- ACTIVE PLANS ---` / `--- END PLANS ---` block ([planManager.ts:175](../../../src/providers/planManager.ts#L175)). So the plan reliably occupies the **head** of the context (primacy, near index 0).

Selected/open files are *also* injected on every request — but into a **different position**. They are appended to the **last user message** at [requestOrchestrator.ts:967-977](../../../src/providers/requestOrchestrator.ts#L967), via [`getSelectedFilesContext`](../../../src/providers/fileContextManager.ts#L206) (which logs `[FileContext] Injecting N selected files into context` at [fileContextManager.ts:212](../../../src/providers/fileContextManager.ts#L212) and wraps them in `--- Selected Files for Context ---`). So selected files sit at the **tail** of the message array (recency).

The two placements have very different decay profiles **inside one turn**. A single agentic turn is not one model call — it is the `StreamingToolCalls` loop, which runs up to `maxToolCalls` iterations (default **25**, [requestOrchestrator.ts:3178](../../../src/providers/requestOrchestrator.ts#L3178)):

```ts
const configuredLimit = config.get<number>('maxToolCalls') ?? 25;
const maxIterations = configuredLimit >= 100 ? Infinity : configuredLimit;
```

Each iteration **appends** an assistant turn ([requestOrchestrator.ts:3399](../../../src/providers/requestOrchestrator.ts#L3399)) and one `tool` result per tool call ([requestOrchestrator.ts:3456](../../../src/providers/requestOrchestrator.ts#L3456)) onto a growing `currentMessages` array ([requestOrchestrator.ts:3194](../../../src/providers/requestOrchestrator.ts#L3194)). The system prompt — and the plan inside it — stays frozen at the head while iterations 2…25 pile reasoning and tool output between it and the model's current decision point. By iteration 15 the plan is thousands of tokens upstream of the action: classic primacy fade / "lost in the middle." The selected-files block, by contrast, is re-anchored at the tail of the *original* user message but is **not** re-emitted as the loop appends — and crucially, nothing tracks *which plan step is current*. The plan in the traced session was ~3,800 characters; its own checklist was buried inside that wall of prose, so even a fresh re-read wouldn't have surfaced "you are on step 3 of 7."

There is already a precedent in this exact loop for injecting a compact reminder *at recency mid-turn*: the edit-safety settle point (ADR [0006](0006-edit-safety-checkpoint-and-validation.md)) feeds build errors back by pushing a fresh `user` message into `currentMessages` via a callback at [requestOrchestrator.ts:3485-3489](../../../src/providers/requestOrchestrator.ts#L3485). That is the structural hook we mirror here.

The invariant we want: **the active plan's current step stays salient at the model's decision point through a long multi-iteration turn**, without paying to re-emit the whole 3,800-character plan on every one of 25 iterations, and with a single source of truth so the head and tail copies never contradict.

## Decision

Split the plan's two jobs — **orientation** (the full goals/approach, read once) and **steering** (which step am I on right now) — across the two context positions, and keep `PlanManager` the single source of both.

1. **Keep a *brief* plan summary in the system prompt** (primacy, orientation). `getActivePlansContext` stays the head-of-context injection but is **size-constrained**: a new `PlanManager` cap (`getActivePlansContext({ maxChars })`, default ~1,500 chars per active plan) truncates an over-long plan body with a `… (truncated; full plan in .moby-plans/<name>)` marker so a 3,800-char plan can't crowd out the rest of the system prompt. The wrapper text at [planManager.ts:175](../../../src/providers/planManager.ts#L175) is unchanged.

2. **Pin a terse "current step" reminder at recency** (the new part). Add `PlanManager.getActivePlanReminder(): string` that returns a compact block — the plan name, a `current step: N of M` line, and the *remaining* checklist items only — derived from the active plan file:

   ```
   --- ACTIVE PLAN (reminder) ---
   plan-build-deck.md — step 3 of 7
   Remaining:
   [ ] 3. Wire Slide3 feedback-loop diagram
   [ ] 4. …
   (full plan and completed steps are in the system prompt)
   --- END ACTIVE PLAN ---
   ```

   Inject it into the **last user message**, immediately after the selected-files block, at the same site as [requestOrchestrator.ts:967-977](../../../src/providers/requestOrchestrator.ts#L967):

   ```ts
   const planReminder = this.planManager?.getActivePlanReminder() ?? '';
   if (planReminder && historyMessages.length > 0) {
     const lastMsg = historyMessages[historyMessages.length - 1];
     if (lastMsg.role === 'user') {
       lastMsg.content = lastMsg.content + planReminder;
     }
   }
   ```

   This is short by construction (a step count + the *remaining* items, never the prose), so it costs little and never duplicates the orientation copy.

3. **Re-pin the reminder across iterations within a turn.** The recency anchor above only fixes iteration 1 — by iteration 15 it has the same fade problem as the system prompt. So, mirroring the settle-point callback at [requestOrchestrator.ts:3485-3489](../../../src/providers/requestOrchestrator.ts#L3485), re-push the *current* `getActivePlanReminder()` as a fresh `user` message at the iteration boundary when an active plan exists, **only when the step pointer has changed** since it was last emitted (debounced — see Alternative D for why not every iteration). The reminder is recomputed from `PlanManager` each time, so it always reflects the live step.

4. **Let the agent advance the pointer by checking off steps.** "Step N of M" is meaningful only if it moves. The model already edits files via `edit_file`; checking a box (`[ ]` → `[x]`) in `.moby-plans/<name>` is an ordinary edit it can make. `PlanManager.getActivePlanReminder()` parses the checklist (GitHub-style `[ ]`/`[x]`, or numbered `## Steps`) and derives `current step = first unchecked`, `M = total`. Because the plan file is mutated as work progresses, the *changing* content is what stays salient — the reminder is never stale boilerplate. No new tool is introduced; this is a documented convention plus a parser in `PlanManager`.

The full plan lives in **one** place (system prompt, orientation). The recency block carries only the **derived pointer** (step N/M + remaining), computed from the same `PlanManager` state — so the head and tail can't drift, and there is no second copy of the prose to contradict the first.

This complements ADR [0007](0007-system-prompt-temporal-grounding.md) (which deliberately keeps a *standing* directive — date/staleness — in the system prompt, where a stable rule belongs) and reuses the same recency-reminder pattern as ADR [0010](0010-web-search-query-ledger-and-cache.md) (a compact search-ledger reminder pinned at the tail). Where 0007 keeps stable rules at primacy, 0009 and 0010 keep *evolving turn state* at recency.

## Alternatives considered

### A. System prompt only (status quo)

Leave the full plan in the system prompt and trust the model to keep referring back.

Rejected — this is exactly what the 914pm session ran, and it drifted. Salience decays across a 25-iteration loop: the plan is frozen at the head while reasoning and tool output accumulate between it and the decision point. Primacy alone does not survive a long agentic turn, and a 3,800-char plan buries its own checklist even on a fresh read.

### B. Duplicate the full plan in both positions

Re-emit the entire `--- ACTIVE PLANS ---` body at recency as well as in the system prompt.

Rejected on cost and correctness. Re-emitting 3,800 chars per iteration across up to 25 iterations is a large, repetitive token bill for content that's already in context. Worse, two full copies invite contradiction: if one is truncated or trimmed by context-window management and the other isn't, the model sees two versions of "the plan." The decision keeps exactly one prose copy and pins only the small derived pointer.

### C. Re-summarize the plan via a subagent each iteration

Spin a subagent ([`src/subagents/`](../../../src/subagents)) to compress the plan to "what's next" before each iteration.

Rejected as overkill. It adds a model call (latency + cost) on the hot agentic path to produce something a deterministic checklist parser yields for free. The reminder we need is mechanical — "first unchecked item, count" — not a judgement call. A subagent here buys nothing over parsing the file.

### D. Periodically re-emit the whole plan mid-loop on a fixed cadence

Push the full plan back into the message stream every K iterations regardless of state.

Rejected as noisy. A fixed cadence re-emits identical text even when nothing changed (the model is mid-step), training it to ignore the repetition, and it re-pays the full-plan token cost of Alternative B on a timer. The decision instead re-pins only the *terse* reminder and only **when the step pointer actually moves** — change-driven, not clock-driven, so a re-emit always carries new information.

## Consequences

**Positive:**
- The plan's current step stays salient at the model's decision point through long multi-iteration turns; the model stops forgetting the goal mid-turn. The 914pm drift (skipped/ re-done steps, premature completion) is the target failure.
- One source of truth: the full prose lives once (system prompt); the recency block is *derived* from the same `PlanManager` state, so head and tail can't contradict.
- Cheap by construction — the recency reminder is a step count plus the *remaining* items, not the prose; re-pins are change-gated, so a steady-state iteration adds nothing.
- The plan file becomes a live checklist the agent ticks off, which doubles as user-visible progress in `.moby-plans/<name>` and keeps the salient content *changing* (so it reads as state, not boilerplate).
- Reuses the existing recency-injection hook (the settle-point callback at [requestOrchestrator.ts:3485](../../../src/providers/requestOrchestrator.ts#L3485)) and the existing selected-files append site — no new orchestration surface.

**Negative / accepted costs:**
- A small per-turn token cost for the recency reminder, paid again on each step transition. Bounded by the terse format and the change-gate; the system-prompt cap (item 1) actually *reduces* total plan tokens for over-long plans.
- The "step N of M" value is only as good as the plan's authoring — it requires a parseable checklist (`[ ]`/`[x]` or numbered `## Steps`). A free-form plan with no checklist degrades gracefully to "active plan: <name>" with no step pointer, never to an error.
- Dual placement requires `PlanManager` to remain the single computed source; an ad-hoc second injection elsewhere would reintroduce drift. Encoded as a rule: only `PlanManager.getActivePlanReminder()` / `getActivePlansContext()` produce plan text.
- The agent mutating the plan file to check off steps is an edit to a user-owned file under `.moby-plans/`; it is an ordinary `edit_file` and is covered by the edit-safety transaction (ADR [0006](0006-edit-safety-checkpoint-and-validation.md)), but users will see their plan file change as the turn runs.

**Follow-ups:**
- Surface "step N of M" in the Plans popup UI (it already renders active plans) so the user sees turn progress without opening the file.
- Consider a config knob (`moby.plans.recencyReminder: true|false`, `moby.plans.maxPlanChars`) once the defaults are validated on real sessions.
- If parsing free-form plans proves brittle, a one-time normalization (offer to add a `## Steps` checklist when a plan is activated) could make the pointer reliable.

## Test plan

Framework is **vitest**, following the in-memory-`vscode`-mock pattern in [tests/unit/providers/planManager.test.ts](../../../tests/unit/providers/planManager.test.ts) and the mock-streamChat / assert-on-`buildContext`-messages pattern in [tests/unit/providers/requestOrchestrator.test.ts](../../../tests/unit/providers/requestOrchestrator.test.ts).

**Unit — `PlanManager` (extend [tests/unit/providers/planManager.test.ts](../../../tests/unit/providers/planManager.test.ts)):**
- `getActivePlanReminder()` derives `step N of M` from a checklist plan (`[ ]`/`[x]`): with two of seven items checked, asserts `step 3 of 7` and that the block lists **only** the remaining (unchecked) items, not the completed ones.
- Numbered `## Steps` plan (the `createPlan` template at [planManager.ts:104](../../../src/providers/planManager.ts#L104) emits this shape) parses to the same pointer.
- Free-form plan (no checklist) → reminder names the plan but emits **no** `step N of M` line, and never throws.
- No active plan → `getActivePlanReminder()` returns `''`.
- `getActivePlansContext({ maxChars })` truncates an over-long plan body and appends the `… (truncated; …)` marker; a short plan is returned unchanged (no marker).

**Unit — `RequestOrchestrator` request building (extend [tests/unit/providers/requestOrchestrator.test.ts](../../../tests/unit/providers/requestOrchestrator.test.ts), in the `handleMessage - message building` describe at line ~650, next to the existing `should inject selected files context` test):**
- Add a `planManager` mock (currently absent from the orchestrator mocks) exposing `getActivePlansContext` and `getActivePlanReminder`. Assert the terse reminder (`step 3 of 7`, remaining items) lands in the **last user message** of `buildContext.mock.calls[0][0]` — mirroring the selected-files assertion at [requestOrchestrator.test.ts:665-673](../../../tests/unit/providers/requestOrchestrator.test.ts#L665) — and that the full plan still lands in the **system prompt** arg (`streamChat.mock.calls[0][2]`), proving the split.
- **No-duplication-blowup:** with both the system-prompt plan and the recency reminder present, assert the *full* prose block (`--- ACTIVE PLANS ---`) appears exactly **once** across the combined system-prompt + last-user-message text (the recency copy is the terse `ACTIVE PLAN (reminder)` form, not a second prose copy).
- **Sync:** changing the mock's reported current step between two `handleMessage` calls changes the `step N of M` in the next built request — the reminder tracks `PlanManager`, not a cached value.

**Unit — in-turn re-pin (extend the streaming-tool-calls describe at [requestOrchestrator.test.ts:2172](../../../tests/unit/providers/requestOrchestrator.test.ts#L2172)):**
- Drive a multi-iteration `StreamingToolCalls` loop (the existing Phase 4.5 harness in that describe) with an active plan; assert that across simulated iterations the current reminder is re-pushed into `currentMessages` **when the step pointer changes** and is **not** re-pushed on an iteration where it didn't change (the change-gate from Decision item 3). This parallels how `settleEditBatch` feedback injection is unit-tested via the `pushFeedback` callback at [requestOrchestrator.test.ts:327-331](../../../tests/unit/providers/requestOrchestrator.test.ts#L327).

**Integration — persistence across a turn:**
- Add `tests/actors/plans/active-plan-recency.test.ts` (new; the `tests/actors/plans/` dir already holds [PlanPopupShadowActor.test.ts](../../../tests/actors/plans/PlanPopupShadowActor.test.ts)) exercising the end-to-end shape: an active plan with a checklist, a turn that checks off a step mid-loop, and an assertion that a later iteration's request carries the *updated* `step N of M`. Keep model interaction mocked; this is a request-shape contract, not a live-model test.

Unit-vs-integration split: the parsing/derivation and the two injection sites are **unit** (deterministic, mock `vscode`/`buildContext`); the "checked-off step propagates into the next iteration's request" round-trip is the one **integration**-flavoured case.

## Documentation plan

- **New reference doc:** `docs/architecture/integration/active-plan-context.md` — describe the two placements (system-prompt orientation vs. last-user-message steering), the `getActivePlanReminder()` format, the checklist convention the agent ticks off, the `maxChars` cap, and the change-gated re-pin. Mirror the structure of the existing `docs/architecture/integration/edit-safety.md` referenced from ADR 0006.
- **Update [README.md](../../../README.md) "Plan Mode" section ([README.md:116-124](../../../README.md#L116)):** note that active plans are now injected in two places (full plan for orientation, a terse "current step N of M + remaining" reminder kept next to the live action), and that writing a checklist (`- [ ]` items or a numbered `## Steps`) lets Moby track and check off progress as a turn runs.
- **CHANGELOG.md:** add an entry under `## [Unreleased]` — "Active-plan recency pinning (ADR 0009): the active plan's current step now stays pinned next to the model's live action across long agentic turns; Moby tracks `step N of M` from your plan's checklist and checks items off as it works. Full plan stays in the system prompt for orientation; the system-prompt copy is now size-capped." Link the ADR and the new reference doc.
- **Add an Index row to [docs/architecture/decisions/README.md](README.md):** `| [0009](0009-active-plan-recency-pinning.md) | Active-plan recency pinning (context salience) | Proposed | 2026-06-20 |` (the orchestrator performs the actual README edit).
- No existing `docs/plans/*.md` covers plan-mode mechanics (they are feature design docs), so no update there is required; the new integration doc is the home for this.
