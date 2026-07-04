# Plan-specific tools (minimal v1)

**Status:** proposed · **Leverage:** small–medium · **Scope:** tool-calling models (Chat / V4) only

## Why

The `.moby-plans/` feature is UI-managed ([planManager.ts](../../src/providers/planManager.ts)) and exposes **no tool to the model**. To touch a plan file the model uses the generic `write_file`/`edit_file` with a hand-built path — and gets the directory wrong. Observed failure (2026-07-03): asked to "save the plan into the plan file," V4 resolved the bare filename to the **workspace root** and [`createFile`](../../src/capabilities/files.ts#L63) silently `mkdir -p`'d a stray copy there, leaving the real `.moby-plans/<name>.md` untouched.

A prompt-level fix already shipped: the active-plan injection now carries the workspace-relative path (`## .moby-plans/<name>`) plus an explicit "write to that exact path" instruction ([planManager.ts](../../src/providers/planManager.ts), backlog M31). That closes the *save* bug for tool-calling models via steering. This plan is **defense-in-depth + ergonomics**: make the wrong action unrepresentable, and give the model a reliable way to tick steps off mid-turn (the workflow ADR 0009's recency reminder is built around).

## Goals

- The model can **save/overwrite** a plan and **check off a step** without ever supplying a filesystem path — addressing is by plan *name* (or "the active plan"), so the directory can't be wrong.
- Step-checking is by **position** (the same 1-based index the [recency reminder](../../src/providers/planManager.ts#L223) already prints), not brittle `search`/`replace` text matching.
- Plan writes stay **out of the code-diff machinery** — no diff-approval tab, no edit-safety checkpoint, not counted in "Modified Files". They're the user's planning notes, not source.
- State stays consistent: a write refreshes PlanManager and fires `onPlanState`, so the plans sidebar and the *next* turn's injected context update in lockstep.

## Non-goals (explicitly out of scope for v1)

- Create / delete / rename / activate-deactivate via tool. Those stay UI-driven (`createPlan`/`deletePlan`/`togglePlan`). v1 only edits plans that already exist.
- R1 (reasoner) support. R1 uses the `<shell>` + SEARCH/REPLACE path, not function tools, so it doesn't receive these — it relies on the shipped prompt-path fix. (Model-scope note per CLAUDE.md conventions.)
- Full status/query surface, structured diffs of plans, multi-plan batch ops, checklist reordering.

## The two tools

Defined as standalone `Tool` exports (mirroring `createFileTool`/`applyCodeEditTool`), added to both build arrays. New file [src/tools/planTools.ts](../../src/tools/planTools.ts) keeps them out of `workspaceTools.ts` (which has no PlanManager access).

### `update_plan`

Overwrite an existing plan's body. Full-body write — the simplest thing that kills the save-to-wrong-path bug. No line mapping needed.

```jsonc
{
  "name": "update_plan",
  "description": "Overwrite the contents of an existing plan in .moby-plans/. Address the plan by name (without .md) or omit `plan` to target the active plan. Use this to save a plan you've drafted, or to rewrite one. To tick a single step complete, prefer complete_step. Cannot create a new plan — the user creates plans from the Plans panel.",
  "parameters": {
    "plan":    { "type": "string", "description": "Plan name without extension, e.g. \"cobweb_update\". Omit to target the active plan." },
    "content": { "type": "string", "description": "The full new markdown body of the plan." }
  },
  "required": ["content"]
}
```

### `complete_step`

Tick a checklist item by position — the position shown in the reminder's `Remaining:` list.

```jsonc
{
  "name": "complete_step",
  "description": "Mark a step in a plan's checklist as done (flips [ ] to [x]). `step` is the 1-based position shown in the active-plan reminder's Remaining list. Omit `plan` to target the active plan. Only works on plans with [ ]/[x] checkboxes.",
  "parameters": {
    "plan": { "type": "string", "description": "Plan name without extension. Omit to target the active plan." },
    "step": { "type": "integer", "description": "1-based position of the checklist item, matching the reminder." },
    "done": { "type": "boolean", "description": "Optional. true (default) checks the box; false unchecks it." }
  },
  "required": ["step"]
}
```

> `get_plan_status` is deliberately **omitted** from v1: the recency reminder already injects `step N of M` + the remaining items with their positions, so the model has the indices it needs. Add it later only if turns start needing an explicit re-read.

## PlanManager API additions

Two public methods, both reusing the existing checkbox parser so indices match the reminder exactly.

```ts
/** Resolve a plan by name (with or without .md); fall back to the active plan. */
private resolvePlan(name?: string): PlanFile | null

/** Overwrite a plan body. Returns the workspace-relative path on success. Refreshes + emits. */
async writePlanBody(name: string | undefined, content: string):
  Promise<{ ok: true; path: string } | { ok: false; error: string }>

/** Flip the Nth (1-based) checkbox line. Walks the SAME `checkboxRe` used by
 *  parsePlanSteps, so `step` aligns with the reminder's positions. Refreshes + emits. */
async setStepDone(name: string | undefined, step: number, done: boolean):
  Promise<{ ok: true; path: string; text: string } | { ok: false; error: string }>
```

`setStepDone` implementation shape (no parsePlanSteps change needed — re-walk the regex, flip the Nth match's marker char in place):

```ts
const lines = body.split(/\r?\n/);
let seen = 0;
for (let i = 0; i < lines.length; i++) {
  const m = checkboxRe.exec(lines[i]);          // same regex as parsePlanSteps
  if (!m) continue;
  if (++seen === step) {
    lines[i] = lines[i].replace(/\[[ xX]\]/, done ? '[x]' : '[ ]');
    // write lines.join('\n') back via vscode.workspace.fs; refresh(); return ok
  }
}
// step out of range → { ok:false } ; zero checkboxes → guidance to use update_plan
```

Error/edge results (returned as the tool `result` string so the model self-corrects):
- plan not found → `Error: no plan named "<x>" in .moby-plans/ (available: a, b). Create it from the Plans panel first.`
- no active plan and `plan` omitted → `Error: no active plan; pass a plan name.`
- `complete_step` on a plan with no checkboxes → `Error: "<x>" has no [ ] checklist items; use update_plan to add them.`
- `step` out of range → `Error: step N is out of range (plan has M steps).`

Refactor note: `getPlansDir()` / `PLANS_DIRNAME` already centralize the directory (shipped with M31), so the new methods inherit correct addressing for free.

## Orchestrator wiring

**Dispatch** — both tools need `this.planManager`, which `executeToolCall` (a free function in workspaceTools.ts) can't reach. So special-case them in [`dispatchToolCall`](../../src/providers/requestOrchestrator.ts#L2910) exactly like `web_search`, before the `executeToolCall` fallthrough:

```ts
} else if (toolCall.function.name === 'update_plan' || toolCall.function.name === 'complete_step') {
  result = await this.handlePlanTool(toolCall);   // returns "Error: …" on failure so success-flag logic at L2937 works unchanged
}
```

Keep `fileModified = false` and `closesBatch = false` — plan writes bypass the diff/checkpoint system by design (§Goals). On success, `handlePlanTool` returns e.g. `Updated plan .moby-plans/cobweb_update.md.` or `Checked step 3 of 7 in .moby-plans/cobweb_update.md.` (the returned `text`/status lets the model see the new state without a separate read).

**Gating** — add to both build sites ([streaming L3408](../../src/providers/requestOrchestrator.ts#L3408), [runToolLoop L3823](../../src/providers/requestOrchestrator.ts#L3823)), matching the `...(includeX ? [x] : [])` pattern:

```ts
const includePlanTools = !!this.planManager && this.planManager.getPlans().length > 0;
// ...
...(includePlanTools ? [updatePlanTool, completeStepTool] : []),
```

Gate on *any* plan existing (not just active) so the model can update an inactive plan by name. `getPlans()` reads cached state from the last `refresh()`; plans rarely change mid-turn, so cached is acceptable (a stale-empty gate at worst falls back to `write_file`, which now has the correct path anyway). No `await` added to the hot build path.

**No new system-prompt block required** — the tool descriptions self-document, and the `--- ACTIVE PLANS ---` block already tells the model plans exist and where. Optionally add one line to [`renderStandardToolGuidance`](../../src/providers/requestOrchestrator.ts#L4220) when `includePlanTools`, but skip for v1.

## File-by-file change list

| File | Change |
|---|---|
| `src/tools/planTools.ts` *(new)* | `updatePlanTool`, `completeStepTool` `Tool` definitions (schemas above). |
| [src/providers/planManager.ts](../../src/providers/planManager.ts) | Add `resolvePlan`, `writePlanBody`, `setStepDone`. Reuse `checkboxRe`/`getPlansDir`/`PLANS_DIRNAME`; call `refresh()` + `emitState()` after writes. |
| [src/providers/requestOrchestrator.ts](../../src/providers/requestOrchestrator.ts) | Import the two tools; add `includePlanTools` + spread at both build sites; add `update_plan`/`complete_step` branch in `dispatchToolCall`; add private `handlePlanTool`. |
| `tests/unit/providers/planManager.test.ts` | Unit-test `writePlanBody` (writes to `.moby-plans/`, refuses unknown/active-missing) and `setStepDone` (flips Nth box; index aligns with `getActivePlanReminder`; out-of-range + no-checkbox errors). |
| `tests/unit/providers/requestOrchestrator.test.ts` | Dispatch test with a mocked planManager: `update_plan`/`complete_step` route to it, `fileModified` stays false, gating includes/excludes correctly. |
| [docs/plans/manual-test-backlog.md](manual-test-backlog.md) | Extend M31: verify the model uses `update_plan`/`complete_step` (not `write_file`) and that a stray root file never appears. |

## Verification

- Unit: the two suites above, plus confirm `complete_step(step=k)` targets the same item the reminder prints as position `k` (shared regex guarantees it — assert it).
- Dev host (the real proof, since this is model behavior): active plan present → ask "save this plan" then "mark step 2 done." Expect in-place edits to `.moby-plans/<name>.md`, the sidebar updating live (via `onPlanState`), and **no** file at the repo root. Cross-check the injected reminder shows the new step count next turn.

## Risks / open questions

- **Step-index drift.** If the model edits the checklist with `update_plan` and then `complete_step`s by an old index in the same turn, positions may have shifted. Mitigation: `handlePlanTool` returns the refreshed `step N of M` in the result string so the model re-grounds. Acceptable for v1.
- **Cached gate.** `getPlans()` reflects the last `refresh()`. If a plan is created via UI mid-session, a `refresh()` already fires on that path, so the gate sees it. Newly-created-then-immediately-referenced within one turn is the only gap; `write_file` remains the fallback.
- **Concurrency.** `setStepDone` is read-modify-write; if the user edits the plan file in the editor at the same instant, last-write-wins. Same exposure as `createPlan` today. Not worth locking for v1.
- **Should `update_plan` be create-capable?** Kept create UI-only so the model can't spawn plan files the user didn't ask for. Revisit if users want agent-authored plans end-to-end.
