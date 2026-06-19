# 0006. Edit safety: checkpoint, atomic batch, and post-apply validation

**Status:** Accepted — implemented (Phases 1–3). Layer 5 was refined during implementation: validation is *differential* (a normalized error-set diff) against a **pre-edit baseline probe**, so the gate works from any starting state, not only a clean one. See Layer 5.
**Date:** 2026-06-19

## Context

A traced auto-mode session on 2026-06-18 (model `deepseek-v4-pro` at `reasoning_effort=max`, building a Blazor "Pig Dice" slide) corrupted two files across ~7 fix iterations before converging. Full diagnosis: [docs/plans/improve-file-corruption.md](../../plans/improve-file-corruption.md).

The decisive finding: **the corruption originates in the model's own output bytes, not the diff engine.** The model emitted clean-but-wrong JSON in its `edit_file` REPLACE strings and `write_file` payloads — dropped substrings (`var(--accent)` → `(--accent)`), truncated identifiers (`_winner` → `_`), missing colons, a localized double-escaped newline. On an exact-match apply ([diff.ts:144](../../../src/utils/diff.ts#L144)) the engine writes the REPLACE byte-for-byte via `String.replace`, so whatever the model sent lands on disk. The engine is a faithful messenger.

ADR-adjacent context: the `a5b71c1` hard-fail refactor closed the **no-match** path — an unmatched SEARCH now hard-fails ([diff.ts:384-389](../../../src/utils/diff.ts#L384)) instead of reconstructing a region from anchors and clobbering it. That was a real fix, but it is structurally blind to the failure mode that actually bit us: **SEARCH matches, REPLACE is garbled.** Once a SEARCH matches (an append, a tiny search, a whole-file rewrite), the entire REPLACE is spliced in unchecked. Nothing downstream asks "did this edit leave the file valid?"

Three structural gaps in the current auto-apply path compound this:

1. **No checkpoint.** `applyCodeDirectlyForAutoMode` ([diffManager.ts:930-1049](../../../src/providers/diffManager.ts#L930)) reads the file, applies, and writes at [diffManager.ts:1014](../../../src/providers/diffManager.ts#L1014). There is no pre-edit snapshot, so the only "undo" is for the model to emit another (also garble-prone) edit. This is the whack-a-mole amplifier: each fix is layered onto an already-corrupted file, and a fix can introduce a *new* garble (`_turnLost` → `_Lost`, which then needed its own follow-up edit).

2. **Non-atomic batches.** A turn's edits dispatch one at a time ([requestOrchestrator.ts:2637-2645](../../../src/providers/requestOrchestrator.ts#L2637)), each writing immediately; `fileModified` is emitted per edit at the batch close ([requestOrchestrator.ts:3272](../../../src/providers/requestOrchestrator.ts#L3272)). If edit 3 of 5 is garbage, the file is left half-edited — the single most dangerous state.

3. **Success reported without validation.** `sendCodeAppliedStatus(true, …)` fires at [diffManager.ts:1041](../../../src/providers/diffManager.ts#L1041) the moment the write returns. The model is told "applied" regardless of whether the result compiles. The only validation in the traced run was the model *choosing* to run `dotnet build` itself — and it then declared "Fix 5 compilation errors" while introducing a sixth.

We will **not** fix this by bundling per-language linters or parsers. Moby is language- and framework-agnostic by design ([no project-type detection exists today](../../../src/tools/workspaceTools.ts)); shipping a CSS/Razor/TS parser per supported language is the wrong shape and an unbounded maintenance surface. The validation oracle must be the **user's own toolchain**, which the model already invokes via `run_shell` and which the command-approval system ([commandApprovalManager.ts](../../../src/providers/commandApprovalManager.ts)) already gates.

The invariant we want: **Moby never leaves a file worse than it found it, and never reports success on an edit that broke the build.** Every uncertain outcome must resolve to *revert*, *autonomous retry*, or *halt and surface to the user* — never to *corrupt-and-claim-success*. Auto mode stays Auto: the safety layers run autonomously and never covertly switch the user into per-edit approval (see Alternative G).

## Decision

Wrap the auto-apply path in a fail-safe edit transaction. Each layer's failure mode is "revert / retry / halt," never "corrupt and claim success." The layers compose into the stack below; the keystone is **checkpoint** (layer 3) — it is what makes acting on validation safe. Auto mode never demotes to Ask (Alternative G).

```
  8  report SUCCESS  ── only if validated ──────────────────────  new
  7  repair budget exhausted → halt turn, files at last-good ───  new
  6  regression detected     → revert to checkpoint + retry ───  new
  5  validate via project toolchain (delta, approval-gated) ───  new
  4  apply atomically (whole batch, no partial state) ─────────  new
  3  checkpoint before apply ───────────────────────────────────  new   ◄ keystone
  2  strict match or hard-fail (no-match → no write) ──────────  have (a5b71c1)
  1  freshness / stale-content check ──────────────────────────  have
  0  transport: SSE buffered framing (bytes arrive intact) ────  have (this branch)
```

### Layer 3 — Checkpoint (keystone)

Introduce an `EditTransaction` owned by `DiffManager`, opened at the start of a turn's auto-apply batch and keyed by absolute file path:

```ts
interface FileCheckpoint { uri: vscode.Uri; originalContent: string; originalHash: string; }
interface EditTransaction {
  id: string;
  files: Map<string, FileCheckpoint>;   // keyed by fsPath; first write per file snapshots
  applied: Array<{ fsPath: string; description?: string }>;
  mode: 'auto';
}
```

`applyCodeDirectlyForAutoMode` already reads `originalContent` before applying — snapshot it into the transaction the first time a given file is touched in the batch (idempotent per file). **Revert** rewrites every checkpointed file back to `originalContent` via `vscode.workspace.applyEdit` + save, in reverse apply order. In-memory content snapshots (not git) so the feature works in non-git workspaces; git-stash was considered and rejected (see Alternatives).

Hook: open/extend the transaction in `applyCodeDirectlyForAutoMode` before [diffManager.ts:972](../../../src/providers/diffManager.ts#L972); a `revert(transactionId)` method restores all snapshots.

### Layer 4 — Atomic batch

A batch = one tool-iteration's auto-applied edits, bounded by the existing tool-batch lifecycle (`_onToolCallsStart` … `_onToolCallsEnd` at [requestOrchestrator.ts:3287](../../../src/providers/requestOrchestrator.ts#L3287) / [:3572](../../../src/providers/requestOrchestrator.ts#L3572)). The orchestrator opens the transaction when the batch starts and **commits or reverts the whole batch** at `_onToolCallsEnd`, after the validation gate runs once for the batch. `emitAutoAppliedChanges()` ([requestOrchestrator.ts:3272](../../../src/providers/requestOrchestrator.ts#L3272)) moves to *after commit* so the live "Modified Files" dropdown never shows an edit that was about to be reverted.

We keep the current "write per edit" mechanics and revert-on-failure via checkpoints, rather than buffering all writes in memory until commit. This is the smaller, lower-risk change; full write-deferral is an Alternative.

### Layer 5 — Validation gate (the missing layer)

After a batch applies and before commit, run the **project's own check command** once, gated and bounded:

- **Command discovery** (new `ProjectCheck` helper): map workspace markers → check command. `*.csproj`/`*.sln` → `dotnet build`; `package.json` with a `build`/`typecheck`/`test` script → the corresponding `npm run …`; `Makefile` with a `check`/`build` target → `make …`; `Cargo.toml` → `cargo check`; `go.mod` → `go build ./...`. No marker matched → **gate is a no-op** (commit + note; or halt per `onInconclusive`). This is delegation, not bundling — Moby ships the *mapping*, the project ships the *checker*.
- **Execution**: run through `executeShellCommand` ([reasonerShellExecutor.ts:414](../../../src/tools/reasonerShellExecutor.ts#L414)) under the existing `CommandApprovalManager` (`checkCommand` → allowed/blocked/ask). A blocked or unapproved check command → gate is a no-op + surfaced, never a silent bypass. Hard timeout (default 60s, configurable); long-running/dev-server commands are already excluded by `isLongRunningCommand`.
- **Differential against a pre-edit baseline (no "assume clean")**: the gate **measures** the starting state rather than assuming it. `ensureBaseline` runs the check on the *pristine* tree before the turn's first edit applies (once per turn; read-only turns pay nothing), capturing exit state **and**, when broken, the error set. Each batch is classified against that baseline:
  - **`clean`** — after builds (exit 0), regardless of start.
  - **`regression`** (the only verdict that reverts) — a clean→broken exit transition, **or** a *new* normalized error that wasn't in the baseline.
  - **`held`** — both broken but no new error (incl. *fewer* errors); committed, not reverted.
  - **`inconclusive`** — no usable baseline, timeout, didn't run, or a failure whose errors can't be parsed.

  Error comparison uses `normalizeErrors`, which strips source coordinates so a *shifted* error compares equal and drops count/summary lines, making it language-agnostic for toolchains that print `error` per diagnostic (dotnet/tsc/cargo/clang/javac); others (e.g. `go build`) degrade to inconclusive. This makes the gate a **monotonic ratchet from any starting state** — a model fixing a broken file ratchets its error set down (each step kept), and any batch that introduces a new error reverts, even from a broken start. Pre-existing errors never count against the model, so the gate can't revert-loop on breakage it didn't create. (The earlier draft assumed a clean baseline and was binary on exit code — it could neither attribute a single-edit turn nor protect a broken-start turn; both are fixed here.)

### Layer 6 — Revert-on-regression + autonomous retry

On regression: `revert(transactionId)` (layer 3), then route the scoped errors back through the **existing** failed-apply retry machinery — `getFailedAutoApplyCount()` / `maxFailedEditRetries = 3` ([requestOrchestrator.ts:1475](../../../src/providers/requestOrchestrator.ts#L1475)) and the re-read nudge at [requestOrchestrator.ts:2345](../../../src/providers/requestOrchestrator.ts#L2345). The nudge text gains the captured compiler errors and "the change was reverted; the file is back to its last-good state." Reusing this loop means no new retry/abort surface. This stays fully autonomous — Auto keeps trying to solve the problem itself.

A cheap **write-back verification** also lives here: after the save at [diffManager.ts:1014](../../../src/providers/diffManager.ts#L1014), re-read the file and confirm it equals the intended post-edit content; a mismatch (fs-level corruption, race) triggers revert. This is the only fs-truth check and is language-agnostic.

### Layer 7 — Bounded autonomy + terminal halt

Auto mode **stays Auto** — it never demotes to per-edit approval (Alternative G). The repair loop in layer 6 is bounded by the existing retry budget (`maxFailedEditRetries`). Two terminal outcomes:

- **Repair budget exhausted** — the same edit keeps regressing after N revert-and-retry rounds; the problem is genuinely not getting solved. **Halt the turn**: leave every file reverted at last-good, emit a clear terminal status ("couldn't apply these edits safely — reverted to last-good; here's what failed: …"), and stop. This hands control back to the user without covertly changing the edit mode.
- **Inconclusive** — no check command could be discovered, validation timed out, or the check command was not approved. Here there is no evidence the edit is *broken*, and Auto's contract is "apply." So **commit and surface a one-time note** ("applied without validation — no build command found / validation timed out") rather than halting or reverting. A stricter posture is available via `moby.editSafety.onInconclusive: "halt"`.

The stale-content branch ([diffManager.ts:976](../../../src/providers/diffManager.ts#L976)) keeps its current behavior: hard-fail + re-read nudge (it already routes through layer 6), no mode switch.

### Layer 8 — Success-report gate

`sendCodeAppliedStatus(true, …)` ([diffManager.ts:1041](../../../src/providers/diffManager.ts#L1041)) fires **only after commit** (validation passed or was a configured no-op). A reverted or halted edit reports `status: 'failed'`. "Applied" now means "applied and verified," so the model's self-certification can never outrank the build result.

### Configuration (`moby.editSafety.*`)

Contributed in `package.json` under `contributes.configuration.properties`, accessed via `getConfiguration('moby')` (the existing pattern, e.g. `moby.subagents`):

| Key | Default | Meaning |
|---|---|---|
| `moby.editSafety.checkpoint` | `true` | Snapshot + atomic-batch + revert-on-regression. Pure safety; no behavior change on the happy path. |
| `moby.editSafety.validate` | `"auto"` | `"auto"` discover a check command; `"off"` skip the gate; or an explicit command string. |
| `moby.editSafety.validateTimeoutMs` | `60000` | Hard timeout for the check command. |
| `moby.editSafety.maxRepairAttempts` | `3` | Autonomous revert-and-retry rounds on a confirmed regression before the turn halts. Reuses the existing `maxFailedEditRetries`. |
| `moby.editSafety.onInconclusive` | `"commit"` | When validation can't run (no command / timeout / unapproved): `"commit"` apply + note (Auto's default expectation); `"halt"` stop the turn instead. |

`checkpoint: true` is safe to default-on: with nothing failing it is invisible. `validate: "auto"` only runs a command the approval system already gates. There is deliberately **no** "demote to Ask" knob — Auto never becomes Ask (Alternative G).

### Rollout phases

- **Phase 1 — Checkpoint + atomic batch + write-back verification.** Pure safety primitive; the keystone. No validation yet. Revert is wired but only triggers on write-back mismatch / hard-fail. Ships behind `moby.editSafety.checkpoint`.
- **Phase 2 — Validation gate + revert-on-regression + feedback loop.** `ProjectCheck` discovery, delta diagnostics, reuse of the failed-apply retry loop.
- **Phase 3 — Terminal halt** on repair-budget exhaustion + inconclusive-outcome handling (commit-with-note vs. halt). No mode switching.
- **Phase 4 (separate ADR) — content-embedded edit transport.** Moving bulky code out of JSON tool-call args attacks the *root* (reduces the garble *rate*); the layers here reduce the garble *surface that reaches disk*. Tracked separately because it is a protocol change, not a safety wrapper.

## Alternatives considered

### A. Bundle per-language syntax linters / parsers

Validate the post-edit file by parsing it (Razor/CSS/TS/…) inside Moby.

Rejected. It contradicts Moby's language-agnostic design, has no project-type detection to build on, and is an unbounded maintenance surface (every language, every version). The project's own build/test is a stronger oracle (it's the ground truth the user already trusts) and ships zero language knowledge in Moby. We keep only *language-agnostic* in-process checks: write-back verification and (optionally) delimiter-balance tripwires.

### B. Defer all writes until the batch is validated (true in-memory transaction)

Buffer every edit in memory, run validation against the would-be content, and only touch disk on commit.

Deferred. Cleaner in theory (disk never sees an unvalidated byte), but the validation oracle is the *project build*, which reads files **from disk** — so we'd have to write to a temp overlay or shadow workspace to validate, which the toolchain won't see without extra plumbing. Checkpoint + apply + revert achieves the same external guarantee (file ends at last-good or verified-good) with far less surface. Revisit if write-back churn proves costly.

### C. Git-backed checkpoints (stash / blob)

Snapshot via `git stash` or write blobs to the object store.

Rejected as the default. It assumes a git workspace (Moby supports non-git folders), entangles Moby with the user's index/stash state, and complicates multi-file revert across dirty trees. In-memory content snapshots are workspace-agnostic and trivially correct for the batch lifetime. A git strategy could be an opt-in optimization for very large files later.

### D. Trust the model to self-validate (status quo)

Let the model run its own build and react, as it did in the traced run.

Rejected — that *is* the status quo, and it produced the corruption. The model declared a fix while introducing a new error; self-certification cannot be the gate. The model running a build is useful signal, but the *system* must hold the invariant.

### E. Per-edit validation instead of per-batch

Run the check after every single edit.

Rejected on cost. A build per edit multiplies latency by the edit count (the traced run had 9 edits). Per-batch validation catches the same regressions at the iteration boundary where the model would otherwise hand control back anyway. Batch is the natural transaction unit.

### F. Detector-style guards (repeat-write / thrash detection)

Per ADR [0004](0004-r1-path-semantics-guards.md)'s policy: detector-style guards are model-specific and data-gated.

Deferred, consistent with 0004. This ADR is explicitly **tool-surface**, not detector: checkpoints, transactions, and a validation gate make the *edit tool* safer for any model. They survive model changes because they make the tool better, not the model smarter. No garble-pattern detectors ship.

### G. Demote Auto → Ask on low confidence

An earlier draft of layer 7 demoted a file's edit from Auto to Ask (show the diff, await approval) whenever an outcome was inconclusive or repeatedly regressing.

Rejected. It **mixes the edit modes**, and that breaks the mode contract. Choosing Auto means "apply without making me click"; covertly injecting a per-edit approval prompt mid-turn is more surprising than either pure mode and erodes trust in what "Auto" means. The legitimate need behind it — "there should be a point where we stop if the problem isn't getting solved" — is a *terminal halt*, not a mode switch. So layer 7 keeps Auto fully autonomous (revert + retry within a budget) and, when the budget is exhausted, **halts the turn** with files at last-good and a clear explanation, handing control back to the user. The user can then do whatever they want — including switching to Ask themselves — but Moby never makes that switch for them. The blast-radius cap that would also have demoted large edits is dropped: the checkpoint already makes any edit reversible, so size needs no mode change. (Pre-edit *scope* guards — never auto-edit `.env`, protected paths — are a different concern and out of scope for this ADR.)

## Consequences

**Positive:**
- The invariant holds end to end: every failure path reverts or asks; "applied" means "verified." A garbled REPLACE that compiles-breaks can no longer sit on disk reported as success.
- **Works from any starting state.** The differential gate (Layer 5) measures the pre-edit baseline rather than assuming a clean tree, so it both attributes a *single-edit* turn (the common case) and protects a *broken-start* turn: it reverts only edits that make the tree measurably worse (a new error), and lets the model ratchet a broken file down toward clean (`held`) without false reverts. No "assume clean" assumption anywhere.
- Kills the whack-a-mole amplifier — a bad fix reverts to last-good instead of layering onto a corrupted file and spawning the next bad fix.
- No half-edited files: a batch is all-or-nothing.
- Zero language knowledge added to Moby; the validation oracle is the user's own toolchain, gated by the approval system that already governs shell execution.
- Tool-surface, not detector — aligned with ADR [0004](0004-r1-path-semantics-guards.md). The layers help every model, including ones that don't garble.
- Reuses existing machinery: the tool-batch lifecycle, `applyCodeDirectlyForAutoMode`'s `originalContent` read, the `maxFailedEditRetries` re-read loop, `handleAskModeDiff`, and `CommandApprovalManager`.

**Negative / accepted costs:**
- Latency: one project build per edit-batch in Auto mode, plus **one pre-edit baseline build** at the start of each editing turn (the Layer 5 probe; read-only turns are unaffected, and it runs only once per turn). Mitigated by per-*batch* (not per-edit) validation, a configurable fast check command, and `validate: "off"`. Real, and the reason validation is config-gated while checkpointing is default-on.
- The error-set diff is a heuristic: a toolchain that doesn't print `error` per diagnostic (e.g. `go build`) yields no comparable set, so a broken-start turn there degrades to `inconclusive` (commit + note) rather than the ratchet. Clean-start protection (exit-code floor) still holds everywhere. A wrong/missing parse degrades to no-op, never to a false revert.
- `ProjectCheck` command discovery is a heuristic map; unusual projects need an explicit `moby.editSafety.validate` command. A wrong/missing command degrades to no-op, not to corruption.
- In-memory checkpoints hold original content for the batch lifetime — bounded memory for very large files. Snapshots are released on commit/revert, so the batch-scoped lifetime keeps it bounded.
- Auto mode can now **halt a turn** when edits won't converge (repair budget exhausted). That is a visible behavior change — but it is a clean stop with files at last-good, not a covert mode switch, and it only fires after autonomous retries are exhausted. Config-gated and recorded here rather than shipped silently.
- Does **not** reduce the model's garble *rate* — only the surface that reaches disk. Root-cause attack (decoding knobs; content-embedded transport, Phase 4) is complementary and tracked separately.

**Follow-ups:**
- Phase 4 ADR: content-embedded SEARCH/REPLACE transport (get bulky code out of JSON tool-call args).
- Instrument the generation boundary (log raw REPLACE / `write_file` content as it exits `finalizeToolCalls`) to measure garble rate per model / `reasoning_effort` — quantifies whether decoding-knob changes help.
- Consider surfacing the validation result (build pass/fail + reverted) in the turn UI so the user sees why an edit was held.
- If `ProjectCheck` discovery proves brittle, add a one-time "what command verifies this project?" prompt, remembered like a command-approval rule.
- Revisit Alternative B (write-deferral) if write-back churn or flicker is observed in practice.
- **Retract reverted files from the UI/restore (known gap).** `emitAutoAppliedChanges` and the per-file `file-modified` structural events fire *before* the settle point, so after a regression revert the "Modified Files" dropdown and history-restore still list the (now-reverted) files as modified. The model is told explicitly via the feedback message, and the file *content* is correctly restored — but the UI/restore signal is stale. Needs a compensating `file-reverted` event on `_onAutoAppliedFilesChanged` + the structural log, plus `resolvedDiffs`/`_lastNotifiedDiffIndex` cleanup. (Surfaced by the Phase 2b-2 adversarial review.)
- **Repair feedback on the last allowed iteration.** A regression reverted on the final tool-iteration (iteration cap reached) reverts safely but the injected re-read feedback is never consumed by a further model call. Behaviour is safe (revert stands); the warning should say the iteration limit was hit so re-running lets the model repair.
- **Turn-end note when the tree is still broken (`held`).** A turn that *ends* on a `held` verdict (edits kept because they added no new errors, but the project still doesn't build) honours the invariant — no worse than it started — yet a clean-looking "Modified Files" dropdown could be mistaken for a passing build. Surface a one-time "edits kept; project still doesn't build" note when a turn's final committed batch is `held` (or inconclusive-while-broken). Behaviour is correct today; this is UX clarity. (The `held` verdict was added with the differential-validation refinement, after this list was first written.)
- **`go build` (and similar) error parsing.** The differential error-set diff is language-agnostic only for toolchains that print `error` per diagnostic (dotnet/tsc/cargo/clang/javac). `go build` omits the word, so a broken-start `go` project degrades to inconclusive rather than the ratchet (clean-start protection via the exit-code floor still holds). Add a `go`-aware line matcher to `normalizeErrors` if Go projects need the broken-start ratchet.
