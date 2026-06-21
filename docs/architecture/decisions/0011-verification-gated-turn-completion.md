# 0011. Verification-gated turn completion

**Status:** Accepted — implemented for the native-tool loops (streaming + legacy `runToolLoop`). Three implementation refinements vs. this text: (1) the artifact check flags only *present-but-empty* files, not *missing* ones (a missing file is ambiguous — an intentional delete, or an unresolved path — and flagging it risks false positives); (2) the regression re-inject is bounded by a one-shot per-turn guard (the iteration cap is `Infinity` under the user's `maxToolCalls ≥ 100` config, so it can't be the backstop there); (3) the R1 reasoner-shell break is **deferred** as a follow-up (it has its own auto-continuation state machine and isn't a native-tool path).
**Date:** 2026-06-20

## Context

The agentic loop accepts a model-declared "done" with **no completion check**. When the model returns a terminal turn — `finish_reason` is anything other than `tool_calls`, or it returns no tool calls — the loop simply breaks and reports the turn complete. In the V4 streaming loop, `runStreamingToolCallsLoop` breaks the moment a no-tool iteration arrives:

```ts
// requestOrchestrator.ts — runStreamingToolCallsLoop
const toolCalls = response.tool_calls ?? [];
if (response.finish_reason !== 'tool_calls' || toolCalls.length === 0) {
  logger.info(`[StreamingToolCalls] Iteration ${iterations} terminal …`);
  break;
}
```

([requestOrchestrator.ts:3330](../../../src/providers/requestOrchestrator.ts#L3330)). The non-streaming `runToolLoop` has the same shape (no tool calls → break, [requestOrchestrator.ts:3623](../../../src/providers/requestOrchestrator.ts#L3623)). The R1 reasoner-shell loop breaks once its auto-continuation heuristics are exhausted — failed-apply nudge, "no code edits" nudge, post-edit follow-up budget — and then falls through to `break` ([requestOrchestrator.ts:2599](../../../src/providers/requestOrchestrator.ts#L2599)). **None of these terminal boundaries consults whether the turn actually produced its artifact, or whether the project still builds.** The model says "done"; the loop believes it.

Meanwhile, ADR [0006](0006-edit-safety-checkpoint-and-validation.md) already built the machinery that *knows the answer to half of that question*. After each edit **batch**, `settleEditBatch` runs the project's own check command — `dotnet build` / `npm run …` / `make …` / `cargo check` / `go build`, discovered from workspace markers by `discoverCheckCommand` ([editValidation.ts:53](../../../src/providers/editValidation.ts#L53)) — and `EditValidator.validateBatch` classifies the result into a `CheckVerdict` of `clean` / `regression` / `held` / `inconclusive` ([editValidation.ts:147](../../../src/providers/editValidation.ts#L147), [editValidator.ts:122](../../../src/providers/editValidator.ts#L122)), with per-file "stuck" streak tracking via `recordRepairRegression` ([editValidation.ts:247](../../../src/providers/editValidation.ts#L247)). That verdict is consumed **within** a batch to revert/retry/halt ([requestOrchestrator.ts:372](../../../src/providers/requestOrchestrator.ts#L372)), and `settleEditBatch` is called from inside the loop body after each iteration's edits ([requestOrchestrator.ts:3485](../../../src/providers/requestOrchestrator.ts#L3485) streaming, [:3793](../../../src/providers/requestOrchestrator.ts#L3793) non-streaming).

The gap: **a final no-tool "I'm done" iteration produces no edits, so it never enters `settleEditBatch`** — the terminal break at [requestOrchestrator.ts:3330](../../../src/providers/requestOrchestrator.ts#L3330) fires *before* any settle point. The last batch's verdict and build output are now trapped as private state on `EditValidator` (`_baseline`, [editValidator.ts:81](../../../src/providers/editValidator.ts#L81)) and as transient locals inside `settleEditBatch`; nothing at the stop boundary asks "what was the last verdict, and should we accept this stop?" So a turn whose **last** editing batch left the tree broken, but which the model then ends with a clean "Done — the slide is updated" summary iteration, completes as a success.

Worse, **a passing build is not the same as a produced artifact.** This is the failure that actually bit us. In the traced `914pm` auto-mode session (Blazor deck, `deepseek-v4-pro`), the edit-safety baseline probed clean — `[EditSafety] baseline=clean (probed before first edit)` — and `Components/Slides/Slide3Demo.razor` was modified, yet the file was clobbered down to an essentially **empty `<div>`**. An empty Razor component **compiles fine**, so the project built green, the turn completed "successfully," and the verdict was `clean`. The user had to come back the next session and ask to *"fix Slide3Demo.razor back to its lets build something live state."* A build gate alone — even ADR 0006's — would have waved this through, because the artifact check it is missing is not "does it compile" but "did the deliverable actually get produced and is it non-empty."

So there are two distinct holes at the terminal `finish_reason=stop` boundary:

1. **The build verdict is never re-consulted at stop.** ADR 0006 reverts a regression *within* the editing batch that caused it, but a turn that ends with a trailing no-edit summary iteration after a non-clean final batch is accepted anyway.
2. **There is no artifact check at all.** Build-pass ≠ artifact-produced; the empty/clobbered-but-compiles case (the actual traced failure) is invisible to any build gate.

The invariant we want at turn completion: **the model cannot declare a turn "done" when its last build verdict was a regression/stuck, or when the deliverable it claims to have produced is absent or empty.** This is the natural extension of ADR 0006's invariant ("never report success on an edit that broke the build") from the *edit-batch* boundary to the *turn-completion* boundary.

## Decision

Add a **verification gate at the terminal stop boundary** of the agentic loops, before the `break` that ends the turn. This **extends ADR [0006](0006-edit-safety-checkpoint-and-validation.md)**: 0006 built the verdict and the per-file repair tracker; this ADR wires that verdict into the *stop decision* and adds a language-agnostic artifact check on top. It does **not** introduce a new validation oracle, and it does **not** fight 0006's terminal halt — when 0006 has already halted a turn (a file is stuck), this gate is a no-op and the halt stands.

The gate runs at the two terminal break sites — [requestOrchestrator.ts:3330](../../../src/providers/requestOrchestrator.ts#L3330) (`runStreamingToolCallsLoop`) and [requestOrchestrator.ts:3623](../../../src/providers/requestOrchestrator.ts#L3623) (`runToolLoop`) — and at the R1 fall-through break ([requestOrchestrator.ts:2599](../../../src/providers/requestOrchestrator.ts#L2599)). It is config-gated by a new `moby.editSafety.verifyOnStop` key (default `true`), consistent with the existing `moby.editSafety.*` keys ([package.json:546](../../../package.json#L546)).

### 1. Expose the last verdict and re-consult it at stop

`EditValidator` already computes the verdict per batch but keeps the last result private. Expose two read-only accessors (the build result is already in hand inside `validateBatch`):

```ts
// editValidator.ts — new, alongside _baseline (currently private, :81)
private _lastBatch: BatchValidation | null = null;   // set at the end of validateBatch
getLastVerdict(): CheckVerdict | 'skipped' | null { return this._lastBatch?.verdict ?? null; }
getLastBatch(): BatchValidation | null { return this._lastBatch; }   // carries output + errors
```

The orchestrator's `settleEditBatch` ([requestOrchestrator.ts:321](../../../src/providers/requestOrchestrator.ts#L321)) already holds `result` from `validateBatch`; nothing else changes there. At the terminal boundary, a new `verifyTurnCompletion(...)` helper consults `this.editValidator.getLastVerdict()`:

- If the **last batch verdict was a `regression`** that 0006's settle point did *not* already halt on (i.e. the regression was reverted, a repair iteration was injected, but the turn is now ending without that repair having landed a clean batch), inject the captured build errors as feedback and **`continue`** instead of `break` — giving the model one more bounded chance to fix it. The errors come from `getLastBatch()?.output`, the same text `settleEditBatch` feeds back today ([requestOrchestrator.ts:388](../../../src/providers/requestOrchestrator.ts#L388)).
- If a file is **stuck** per the per-file repair tracker (`_editRepairByFile`, [requestOrchestrator.ts:280](../../../src/providers/requestOrchestrator.ts#L280)), **respect 0006's halt** — do not re-inject, do not loop. 0006 already returned `true` from `settleEditBatch` in that case ([requestOrchestrator.ts:385](../../../src/providers/requestOrchestrator.ts#L385)) and the loop already broke; the gate never overrides it.
- `clean` / `held` / `inconclusive` / `skipped` / no-edits-this-turn → the build half of the gate passes (a `held` tree is "no worse than it started," matching 0006's contract). Fall through to the artifact check.

### 2. Language-agnostic artifact check

Build-pass ≠ artifact-produced, so add a second, deliberately loose check that needs **zero language knowledge** (consistent with 0006 Alternative A): did the turn's modified-file set actually change on disk, and are the intended deliverables non-empty?

Reuse the modified-file signal already in scope. The streaming loop already tracks `fileModifiedInBatch` ([requestOrchestrator.ts:3190](../../../src/providers/requestOrchestrator.ts#L3190), set at [:3449](../../../src/providers/requestOrchestrator.ts#L3449)); accumulate it into a turn-scoped `turnModifiedPaths: Set<string>` (sourced from `diffManager.checkpointedPaths` at each settle point, [diffManager.ts:987](../../../src/providers/diffManager.ts#L987)). Then:

```ts
// verifyTurnCompletion — artifact half (pseudocode)
const targets = turnModifiedPaths;                       // files this turn claimed to write
const emptyOrMissing: string[] = [];
for (const p of targets) {
  const bytes = await tryReadFileBytes(p);               // language-agnostic
  if (bytes === null || bytes.trim().length === 0) emptyOrMissing.push(p);
}
if (emptyOrMissing.length > 0 && withinRepairBudget(targets)) {
  pushFeedback(
    `You reported completion, but ${emptyOrMissing.join(', ')} is empty or missing. ` +
    `Re-read it and produce the intended content, then finish.`);
  continue;        // do NOT accept the stop yet
}
```

The check confirms only the *negative* — "this file is absent/empty/whitespace" — never "this file is correct" (that's out of reach without a per-language oracle, and we won't add one). That is enough to catch the traced empty-`Slide3Demo` clobber: a file the turn modified that ends the turn empty is a near-certain failure regardless of language.

### 3. Bound it by the EXISTING budgets — no new loop primitive

The gate must never loop forever. It introduces **no** new counter. It is bounded by the two budgets ADR 0006 already owns:

- The **per-file repair budget** (`moby.editSafety.maxRepairAttempts`, [package.json:562](../../../package.json#L562)) via the same `_editRepairByFile` / `recordRepairRegression` tracker ([editValidation.ts:247](../../../src/providers/editValidation.ts#L247)) — an artifact-empty file is recorded as a repair attempt keyed on that path, so the same file failing to materialize `maxRepairAttempts` times in a row stops the re-injection.
- The **turn iteration cap** (`maxToolCalls` → `maxIterations`, [requestOrchestrator.ts:3179](../../../src/providers/requestOrchestrator.ts#L3179) / [:3535](../../../src/providers/requestOrchestrator.ts#L3535)) — the `continue` path re-enters the `while (iterations < maxIterations)` loop, so the existing cap is the ultimate backstop. A `continue` that would exceed the cap instead accepts the stop with a one-time "completed but the deliverable looks empty/broken" warning via `_onWarning` ([requestOrchestrator.ts:156](../../../src/providers/requestOrchestrator.ts#L156)), mirroring how the loop already surfaces `limitReached` ([requestOrchestrator.ts:3826](../../../src/providers/requestOrchestrator.ts#L3826)).

When 0006 has already decided to **halt** (stuck file), this gate yields to it: it does not re-inject and does not continue. The two never fight because both read the same `_editRepairByFile` state.

## Alternatives considered

### A. Build-pass gate only (re-consult the verdict, no artifact check)

Wire only the last `CheckVerdict` into the stop decision; continue on a trailing regression, accept on `clean`.

Rejected as insufficient. It is a real improvement (it closes hole 1), but it **misses the actual traced failure**: the empty/clobbered `Slide3Demo.razor` compiled cleanly, so the verdict was `clean` and a build-only gate accepts the stop. Build-pass ≠ artifact-produced. We keep the verdict re-consult *and* add the artifact check.

### B. Artifact-presence gate only (no build re-consult)

Check only that the turn's modified files are non-empty; ignore the build verdict at stop.

Rejected. It catches the empty-file case but misses a turn that ends on a non-clean final batch whose file *is* non-empty but *doesn't compile* — exactly the regression ADR 0006 detects and that a trailing summary iteration would otherwise smuggle past the loop. The two checks are complementary: the build verdict catches "present but broken," the artifact check catches "compiles but absent/empty." Combine both; both are language-agnostic.

### C. Ask the model "are you actually done?" (self-certification)

End the turn by prompting the model to confirm completion against its own task list.

Rejected, for the same reason ADR [0006](0006-edit-safety-checkpoint-and-validation.md) rejected trusting model self-validation (its Alternative D). The traced session *is* the counterexample: the model declared the slide done while it sat empty. Self-certification cannot be the gate — the system must hold the invariant from observable ground truth (the build result + the bytes on disk), not from the model's say-so.

### D. Bundle per-language test runners / completeness checkers

Detect the project type and run a per-language "is this component complete / are its tests green" checker (a Razor render probe, a component-snapshot test, etc.).

Rejected, for the same language-agnostic reason ADR [0006](0006-edit-safety-checkpoint-and-validation.md) rejected bundled parsers (its Alternative A). It contradicts Moby's language-agnostic design and is an unbounded maintenance surface. The build verdict (the user's own toolchain) plus a content-presence heuristic ship **zero** language knowledge and still catch the failure that actually occurred. "Correctness" beyond "present, non-empty, and builds" is deliberately out of scope.

## Consequences

**Positive:**
- The model can no longer declare a turn "done" on a **broken build** (the last batch's regression is re-consulted at stop) or on an **empty/missing deliverable** (the artifact check catches the clobbered-but-compiles case — the exact `914pm` failure).
- **Reuses ADR 0006 machinery end to end** — `EditValidator`'s verdict, the captured build output, the `_editRepairByFile` per-file tracker, the iteration cap, and `_onWarning`. No new validation oracle, no new loop counter, no new halt surface.
- Extends 0006's invariant from the edit-batch boundary to the turn-completion boundary with a single new helper, leaving the existing settle path untouched.
- Both checks are language-agnostic; no project-type detection is added.

**Negative / accepted costs:**
- Extra continuation iterations and latency on a turn the gate doesn't accept (one re-read + repair pass, possibly a re-validation build). Bounded by the existing per-file repair budget and the iteration cap — the gate adds no new unbounded loop.
- The artifact check is **necessarily loose**: it can confirm "nothing / empty / whitespace," not "correct." A non-empty-but-wrong file (e.g. a stub that isn't the requested content) still passes — that is the accepted ceiling of a language-agnostic check, and the build verdict + 0006's ratchet remain the only correctness signals.
- Must coordinate with 0006's terminal halt so the two don't conflict: both read `_editRepairByFile`, and the gate yields to a 0006 halt rather than re-injecting. Recorded here rather than discovered later.
- A new visible behavior: a turn can now run one or more extra iterations before completing (or surface a "completed but the deliverable looks empty/broken" note). Config-gated by `moby.editSafety.verifyOnStop` (default `true`).

**Follow-ups:**
- Consider surfacing the verification outcome in the turn UI (a "verified: build clean, deliverables present" vs. "completed with warnings" badge), reusing the warning channel 0006's follow-ups already discuss.
- The artifact target set is currently "files this turn modified." A stronger signal — "files the user's request named as deliverables" — could tighten it, but needs intent extraction (see [fileContextManager.extractFileIntent](../../../src/providers/requestOrchestrator.ts#L736)); tracked as a refinement, not shipped here.
- Relates to ADR [0009](0009-active-plan-recency-pinning.md) (active-plan salience): a verified plan step could feed plan-completion state once both land.

## Test plan

Framework is **vitest** with injected deps and the `tests/__mocks__/vscode.ts` mock — matching the existing edit-safety suite, which builds an `EditValidator` from a `deps` object with `getConfig` / `checkApproval` / `runCommand` / `discover` and never touches a real shell or vscode (see [tests/unit/providers/editValidator.test.ts](../../../tests/unit/providers/editValidator.test.ts)).

**Unit — `EditValidator` accessor (extend `tests/unit/providers/editValidator.test.ts`):**
- `getLastVerdict()` returns `null` before any batch, then the last batch's verdict after `validateBatch` (one case per `clean` / `regression` / `held` / `inconclusive`), reusing the existing `pass`/`fail` `RunOutcome` fixtures in that file.
- `getLastBatch()?.output` carries the captured build output on a regression (assert the compiler text round-trips, mirroring the existing "regression carries the output" case).
- `resetTurn()` clears the last verdict back to `null`.

**Unit — stop-boundary gate (new `tests/unit/providers/verifyOnStop.test.ts`):** the orchestrator stop logic, reusing 0006's edit-safety fixtures/mocks (the injected `EditValidator` deps + a stubbed `diffManager` exposing `checkpointedPaths` and a file-bytes reader). Key cases/assertions:
- **regression verdict at stop → CONTINUES** (re-injects the build errors as feedback, does not `break`).
- **clean verdict + non-empty artifact → STOPS** (accepts the terminal break, no extra iteration).
- **clean build but EMPTY target file → CONTINUES** — the empty-`Slide3Demo` case: verdict `clean`, but the modified file reads back empty/whitespace, so the gate injects a "deliverable is empty" feedback and continues.
- **iteration cap respected** — when a `continue` would exceed `maxIterations`, the gate accepts the stop and fires a one-time `_onWarning` instead of looping.
- **per-file stuck budget respected** — a file that reads empty `maxRepairAttempts` times in a row stops re-injecting (asserts the gate does not loop forever; reuses `recordRepairRegression` semantics).
- **inconclusive verdict + present artifact → STOPS** — no false continuation when validation couldn't run but the file is present and non-empty.
- **0006 halt wins** — when `settleEditBatch` already halted on a stuck file, the gate is a no-op (no re-inject, no continue).
- **`verifyOnStop: false` → gate disabled** (pure legacy break; no read-back, no re-consult).

**Integration (extend `tests/integration/` alongside the existing [midstream-interrupt.test.ts](../../../tests/integration/midstream-interrupt.test.ts)):** a new `verify-on-stop.test.ts` mirroring the traced empty-file scenario end to end — drive a scripted turn whose final batch writes an empty file and then returns a no-tool "done" iteration; assert the loop injects a repair feedback and runs one more iteration rather than completing, and that with `verifyOnStop` off it completes immediately (the pre-ADR behavior).

The existing `tests/unit/providers/validationGate.test.ts` and `terminalHalt.test.ts` are `it.todo` scaffolds for 0006; this ADR's tests sit beside them and depend on the same wiring, but do not modify those files.

## Documentation plan

- **Update ADR [0006](0006-edit-safety-checkpoint-and-validation.md) cross-references** — add a forward pointer from 0006's "Follow-ups" to this ADR (the verdict it produces is now also consumed at the turn-completion boundary). The orchestrator owns that edit; this ADR only links back.
- **Update [docs/plans/improve-file-corruption.md](../../plans/improve-file-corruption.md)** (the 0006 companion) — note that the empty/clobbered-but-compiles case (build-pass ≠ artifact-produced) is closed at turn completion by this ADR, with the `914pm` `Slide3Demo` trace as the grounding evidence.
- **Update [docs/architecture/integration/edit-safety.md](../../architecture/integration/edit-safety.md)** — document the new `moby.editSafety.verifyOnStop` key alongside the existing `moby.editSafety.*` table, and add the stop-boundary gate to the layer/flow description (it sits above 0006's Layer 8 success-report gate: "verified at batch" → "verified at turn").
- **`package.json`** — contribute `moby.editSafety.verifyOnStop` (boolean, default `true`) under `contributes.configuration.properties`, with a `markdownDescription` matching the style of the sibling keys ([package.json:546](../../../package.json#L546)).
- **[CHANGELOG.md](../../../CHANGELOG.md)** — add an entry under `[Unreleased]`: "Verification-gated turn completion (ADR 0011): a turn can no longer report done on a broken build or an empty/missing deliverable; re-consults the ADR 0006 build verdict and adds a language-agnostic artifact-presence check at the stop boundary, bounded by the existing repair budget + iteration cap. Config: `moby.editSafety.verifyOnStop`."
- **Add an Index row to [docs/architecture/decisions/README.md](README.md)** — `| [0011](0011-verification-gated-turn-completion.md) | Verification-gated turn completion | Proposed | 2026-06-20 |` (the orchestrator performs the actual README edit).
