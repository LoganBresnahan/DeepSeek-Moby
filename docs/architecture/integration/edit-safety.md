# Edit Safety

Reference for the fail-safe edit pipeline that wraps auto-mode file application. Decision record and rationale: [ADR 0006](../decisions/0006-edit-safety-checkpoint-and-validation.md). Diagnosis that motivated it: [improve-file-corruption.md](../../plans/improve-file-corruption.md). The underlying match/parse contract this builds on: [diff-engine.md](diff-engine.md).

**Status:** Implemented (ADR 0006, Phases 1–3). Checkpoint, atomic batch, the validation gate, **differential (error-set) attribution**, a **pre-edit baseline probe**, revert-on-regression, and terminal halt have landed. Phase 4 (content-embedded transport) remains a separate ADR; a few UI/restore follow-ups are still open (see ADR 0006 *Follow-ups*). Sections are marked *have* / *new* relative to the pre-ADR baseline.

## The invariant

> Moby never leaves a file worse than it found it, and never reports success on an edit that broke the build.

Every uncertain outcome resolves to **revert**, **autonomous retry**, or **halt and surface to the user** — never to *corrupt-and-claim-success*. The model's "done" can never outrank the project build. **Auto mode stays Auto** — it never covertly switches the user into per-edit approval.

## Why this exists (one paragraph)

The corruption Moby produced in the 2026-06-18 traced run came from the **model's own output bytes** — clean-but-wrong JSON in `edit_file` REPLACE strings — not from the diff engine, which applies a matched REPLACE byte-for-byte ([diff.ts:144](../../../src/utils/diff.ts#L144)). The `a5b71c1` hard-fail closed the *no-match* path; it is blind to the *match-but-garbled* path. This layer adds the missing question: **"did this edit leave the file valid?"** — answered by the user's own toolchain, with a checkpoint so the answer is safe to act on.

## Pipeline — before vs. after

Legend: ✅ have · ★ new (ADR 0006) · ⚠️ current gap.

### Today

```
  MODEL ─► edit_file {file, edits:[{search,replace}]}  (code as JSON-escaped string ⚠️)
        ▼
  ✅ SSE buffered framing ─► JSON.parse(args)
        ▼  ⚠️ clean-but-wrong JSON passes straight through
  DiffManager.applyCodeDirectlyForAutoMode      ⚠️ per edit, writes immediately
        ▼
  DiffEngine.applyChanges: exact / ws-normalized / patch ──► write REPLACE VERBATIM ⚠️
        else ─► ✅ HARD-FAIL (a5b71c1): success:false, file unchanged ─► "re-read & resend"
        ▼
  WRITE ─► notify "Code applied" ─► report SUCCESS ⚠️ (no validation)
        ▼
  (model MAY run `dotnet build` itself & react — NOT enforced ⚠️)
```

### With ADR 0006

```
  MODEL ─► ✅ SSE buffered framing ─► JSON.parse(args)
        │
  ★ BASELINE PROBE — before the turn's FIRST edit, run the check on the pristine
        tree (once/turn). Records clean | broken+error-set | unknown. This is what
        lets a single-edit turn be attributed without assuming a clean start.
        │
  ╭──────────── ATOMIC EDIT BATCH · one tool-iteration · ★ ───────────────
  │   ★ CHECKPOINT — snapshot each touched file (in-memory original content)
  │        ▼
  │   per edit:  ✅ freshness check → ✅ strict match | HARD-FAIL → write REPLACE
  │             + ★ write-back verify (re-read == intended; else revert)
  │        ▼
  │   any hard-fail / verify-fail? ──► ★ REVERT batch ─► re-read nudge
  │        ▼ no
  │   ★ VALIDATE — project toolchain, approval-gated, timeout, run ONCE
  │        run via CommandApproval · classify AFTER vs the BASELINE error-set
  │        ▼
  │   verdict ─┬─ clean (builds) ─────────► ★ COMMIT ─► emit "Modified Files" ─► SUCCESS ✅
  │            ├─ held (still broken, no   ─► ★ COMMIT (ratchet: not worse than start)
  │            │        NEW errors)
  │            ├─ regression (clean→broken ─► ★ REVERT ─► feed errors back ─► retry
  │            │   OR a new error appeared)    └─ budget exhausted ─► ★ HALT (files at last-good, surface)
  │            └─ inconclusive ───────────► ★ COMMIT + one-time note (no oracle/timeout/unparseable)
  ╰───────────────────────────────────────────────────────────────────────
```

## Layers

| # | Layer | State | Where it hooks |
|---|-------|-------|----------------|
| 0 | SSE buffered framing (bytes arrive intact) | ✅ have | [deepseekClient.ts:624](../../../src/deepseekClient.ts#L624) |
| 1 | Freshness / stale-content check (0.75 sim) | ✅ have | [diff.ts:164-169](../../../src/utils/diff.ts#L164) |
| 2 | Strict match or hard-fail (no-match → no write) | ✅ have | [diff.ts:384-389](../../../src/utils/diff.ts#L384) |
| 3 | **Checkpoint** (snapshot before apply) — *keystone* | ★ new | `applyCodeDirectlyForAutoMode` pre-[diffManager.ts:972](../../../src/providers/diffManager.ts#L972) |
| 4 | **Atomic batch** (commit/revert at batch close) | ★ new | `_onToolCallsEnd` [requestOrchestrator.ts:3287](../../../src/providers/requestOrchestrator.ts#L3287) |
| 5 | **Validation gate** (project toolchain, delta) | ★ new | new `ProjectCheck` + `executeShellCommand` [reasonerShellExecutor.ts:414](../../../src/tools/reasonerShellExecutor.ts#L414) |
| 6 | **Revert-on-regression** + feedback + write-back verify | ★ new | revert ⇒ re-read loop [requestOrchestrator.ts:2345](../../../src/providers/requestOrchestrator.ts#L2345) |
| 7 | **Bounded autonomy + terminal halt** (no mode switch; **per-file** same-error budget) | ★ new | `recordRepairRegression` per-file streak in `settleEditBatch` |
| 8 | **Success-report gate** (report only after commit) | ★ new | `sendCodeAppliedStatus` [diffManager.ts:1041](../../../src/providers/diffManager.ts#L1041) |

The keystone is **layer 3**: the checkpoint is what makes layers 5–7 safe to act on. Validation *detects* a regression; the checkpoint makes the response *reversible*.

## Data model (new)

```ts
interface FileCheckpoint { uri: vscode.Uri; originalContent: string; originalHash: string; }

interface EditTransaction {
  id: string;
  files: Map<string, FileCheckpoint>;   // keyed by fsPath; first write per file snapshots
  applied: Array<{ fsPath: string; description?: string }>;
  mode: 'auto';
}
```

`DiffManager` owns the open transaction. `applyCodeDirectlyForAutoMode` already reads `originalContent` before applying — that read seeds the checkpoint (idempotent per file). `revert(id)` rewrites every checkpointed file back to `originalContent` in reverse apply order. Snapshots are **in-memory** (works in non-git workspaces; see ADR 0006 Alternative C).

## Validation: delegation, not bundling

Moby ships the **mapping** from workspace markers to a check command; the project ships the **checker**. No language parsers in Moby.

| Marker | Check command |
|---|---|
| `*.csproj` / `*.sln` | `dotnet build` |
| `package.json` with `build` / `typecheck` / `test` script | `npm run <script>` |
| `Makefile` with `check` / `build` target | `make <target>` |
| `Cargo.toml` | `cargo check` |
| `go.mod` | `go build ./...` |
| *(none matched)* | gate is a **no-op** (commit + note; or halt per `onInconclusive`) |

Execution rules:
- Runs through `executeShellCommand` under `CommandApprovalManager` (`checkCommand` → allowed/blocked/ask). Blocked/unapproved ⇒ gate no-op + surfaced, never a silent bypass.
- Hard timeout (`validateTimeoutMs`, default 60s). Dev-servers/watch commands already excluded by `isLongRunningCommand`.
- **Differential, not absolute**: a regression = the edit made the tree *measurably worse than it started*, never the mere presence of errors (see *Baseline & verdicts*).

### Baseline & verdicts (no "assume clean")

The gate never assumes the tree built before the turn. It **measures** it: `EditValidator.ensureBaseline` runs the check on the *pristine* tree before the turn's first auto edit applies (once per turn; read-only turns and non-editing tools pay nothing). That pre-edit measurement is the reference every batch is compared against, and it's what lets a **single-edit** turn be attributed at all — without it, the first edit of a turn has no clean baseline and a broken result would commit as `inconclusive` instead of reverting.

When both the baseline and a post-edit check fail, exit codes are identical (`1` vs `1`) and tell you nothing, so we diff the **error sets**. `normalizeErrors(output)` extracts a line-shift-invariant set of error signatures: it strips source coordinates (`(82,13)`, `:5:1:`) so the *same* logical error compares equal after an edit moves it down the file, and drops count/summary lines (`5 Error(s)`, `Found 3 errors`) so a changing count isn't mistaken for a changing error. It's language-agnostic for toolchains that label each diagnostic with the word `error` (dotnet, tsc, cargo, clang/gcc, javac); toolchains that don't (e.g. `go build`) yield an empty set and fall back to inconclusive.

`classifyCheckOutcome({ baseline, after })` → one of four verdicts:

| Verdict | When | Action |
|---|---|---|
| `clean` | after builds (exit 0) — any starting state | commit ✅ |
| `regression` | clean→broken, **or** a normalized error appears that wasn't in the baseline | **revert** + feed errors back + retry/halt |
| `held` | both broken, but **no new** error vs. the baseline (incl. *fewer* errors) | commit (a "ratchet": never worse than the start) |
| `inconclusive` | no usable baseline, timeout, didn't run, or a failure whose errors can't be parsed on either side | commit + one-time note (or halt per `onInconclusive`) |

This makes the gate a **monotonic ratchet from any starting state**: a model fixing a broken file ratchets the error set down (each step `held`/`clean`, kept), and any batch that introduces a new error is reverted — even when the tree was already broken. The baseline carries forward across the turn (a `held`/committed batch becomes the new reference), and a `regression` keeps the pre-batch baseline since the caller reverts.

## Configuration (`moby.editSafety.*`)

| Key | Default | Meaning |
|---|---|---|
| `checkpoint` | `true` | Snapshot + atomic batch + revert-on-regression. Pure safety; invisible on the happy path. |
| `validate` | `"auto"` | `"auto"` discover a command; `"off"` skip; or an explicit command string. |
| `validateTimeoutMs` | `60000` | Hard timeout for the check command. |
| `maxRepairAttempts` | `3` | **Per-file** budget: consecutive **same-error** reverts for one file before the turn halts. Independent failures across files don't accumulate; a changing error resets the file's streak. |
| `onInconclusive` | `"commit"` | No oracle / timeout / unapproved: `"commit"` apply + note (Auto's default); `"halt"` stop the turn. No "ask" — Auto never becomes Ask. |
| `verifyOnStop` | `true` | **Verify on stop** (ADR 0011): at turn completion, don't accept "done" on a regression verdict or on a file the turn just wrote that reads back empty. One bounded repair pass, capped by `maxRepairAttempts`. |

Contributed in `package.json` `contributes.configuration.properties`; read via `getConfiguration('moby')` (same pattern as `moby.subagents`).

**Stop-boundary gate (ADR 0011).** Beyond the per-batch settle above, a verification gate runs at the agentic loop's *terminal stop*, extending 0006's invariant from the edit-batch boundary to the turn-completion boundary. It (a) re-consults the last batch verdict — a trailing no-edit "done" after a `regression` gets one bounded repair pass — and (b) adds a **language-agnostic artifact-presence check**: a file the turn just wrote that reads back empty/whitespace holds the turn open (build-pass ≠ artifact-produced — the empty-`Slide3Demo` clobber compiled clean and a build gate alone waved it through). It flags only *present-but-empty* files, never *missing* ones (a missing file is ambiguous — an intentional delete, or a path it couldn't resolve). Bounded by the same `maxRepairAttempts` per-file budget (no new loop counter); config `moby.editSafety.verifyOnStop`. The native-tool loops (streaming + legacy `runToolLoop`) are wired; the R1 reasoner-shell path is a documented follow-up.

## Rollout phases

1. **Checkpoint + atomic batch + write-back verify** — pure safety primitive; the keystone. Revert triggers only on write-back mismatch / hard-fail. Behind `moby.editSafety.checkpoint`.
2. **Validation gate + revert-on-regression + feedback** — `ProjectCheck` discovery, delta diagnostics, reuse of the `maxFailedEditRetries` re-read loop.
3. **Terminal halt** on repair-budget exhaustion + inconclusive handling (commit-with-note vs. halt). No mode switching.
4. **(separate ADR)** content-embedded edit transport — get bulky code out of JSON tool-call args (attacks garble *rate*, not just *surface*).

## Test matrix

Authoritative list of what must be covered, across `tests/unit/providers/{checkpoint,atomicBatch,editValidation,validationGate,revert,terminalHalt}.test.ts`. Real where a phase has landed (checkpoint, editValidation); `it.todo(...)` scaffolding elsewhere, converted as each phase lands. Harness conventions follow [diffManager.test.ts](../../../tests/unit/providers/diffManager.test.ts) and [requestOrchestrator.test.ts](../../../tests/unit/providers/requestOrchestrator.test.ts) (`vi.hoisted` `WorkingEventEmitter`, `vi.mock('vscode')`, factory mocks).

### checkpoint.test.ts (Phase 1)
- snapshots original content before the first write to a file
- snapshot is idempotent per file across multiple edits in one batch
- multiple files in one batch are each snapshotted independently
- `revert` restores exact original bytes for every checkpointed file
- `revert` is a no-op after a committed batch
- checkpoint is discarded after a successful commit (no cross-batch leak)
- snapshot survives the per-edit writes that happen within the batch

### atomicBatch.test.ts (Phase 1)
- a batch of all-valid edits commits every file
- a batch where edit N fails reverts edits 1..N-1 (no partial state)
- a single-edit batch behaves identically to today (back-compat)
- batch boundary aligns with `_onToolCallsEnd` (one validate/commit per iteration)
- `emitAutoAppliedChanges` fires only after commit, never before revert
- ask-mode early batch-close does not corrupt transaction state

### editValidation.test.ts (Phase 2 — engine, ✅ real)
- `discoverCheckCommand`: `.csproj`/`.sln` → `dotnet build`; package.json scripts (build→typecheck→test) → `npm run …`; Makefile (check→build) → `make …`; `Cargo.toml` → `cargo check`; `go.mod` → `go build ./...`; `.NET` preferred over package.json; unrecognised / unreadable / malformed → `null`
- `classifyCheckOutcome` (differential): passing after → clean (any start); clean baseline + failing → regression; broken baseline + a NEW error → regression; broken baseline + only pre-existing errors → held; failing with no comparable error-set (either side empty), no baseline, not-run, or timed-out → inconclusive
- `normalizeErrors`: strips line/col so a shifted error compares equal; dedupes to a set; drops count/summary lines (`N Error(s)`, `Found N errors`, cargo `could not compile`); ignores non-error/warning lines; `[]` when no line says `error` (go-style) or output is empty; handles `:line:col:` (clang/javac)
- `errorSetsEqual` / `recordRepairRegression` (per-file halt): order-independent set equality; three different files each failing once → no halt; one file failing the SAME error `limit`× in a row → stuck; a changing error set resets the streak; per-file keying survives an interleaved failure on another file

### editValidator.test.ts (Phase 2 — service, ✅ real)
- `validateBatch`: off → skipped; no command / not-approved / threw → inconclusive (with note); pass → clean (carries the build output on regression)
- `ensureBaseline`: clean pristine probe → first failing edit reverts (regression); broken pristine probe → same errors `held`, a line-shifted error `held`, a NEW error `regression`, fewer errors `held` + the baseline ratchets down; idempotent once/turn (`skipped`), reset by `resetTurn`; off / no-command / threw leave the baseline unknown (→ inconclusive, never a false revert)

### validationGate.test.ts (Phase 2 — orchestration wiring, todo)
- runs the discovered command via executeShellCommand under CommandApproval
- blocked / unapproved command → no-op + surfaced, no silent bypass
- no command → gate is a no-op (commit), per default `onInconclusive`
- clean → commit; `validate: "off"` → skipped entirely
- runs exactly once per batch, not per edit; timeout → inconclusive (no revert)
- (future refinement) per-file attribution: a new error only in an untouched file does not count

### revert.test.ts (Phase 2)
- a regression triggers `revert` to checkpoint
- post-revert file content equals original bytes
- revert feeds the scoped build errors back through the re-read loop
- revert respects `maxFailedEditRetries` and increments the failed-apply count
- a reverted edit reports `status: 'failed'`, not success (layer 8)
- write-back verification: post-write read ≠ intended content → revert (fs-level corruption)

### terminalHalt.test.ts (Phase 3)
- a confirmed regression triggers revert + autonomous retry (no Ask prompt is shown)
- retries are bounded **per file** by `maxRepairAttempts` consecutive same-error reverts (see `recordRepairRegression` in editValidation.test.ts); independent failures across files don't halt
- on a file's same-error budget exhaustion the turn halts: files left reverted at last-good
- the halt status clearly reports what failed and that the file was reverted
- inconclusive (no check command discovered) → commit + one-time note, no halt, no revert
- inconclusive (validation timeout) → commit + note, no halt, no revert (default `onInconclusive: "commit"`)
- `onInconclusive: "halt"` → halt instead of commit on an inconclusive outcome
- Auto mode never injects an Ask diff-approval prompt (mode-integrity guard)

### Integration (extend existing suites, Phase 2–3)
- `requestOrchestrator.test.ts` (todo): end-to-end auto-apply of a garbled REPLACE that builds-fail → revert → re-read nudge carries the compiler error
- `diffManager.test.ts` (todo): transaction open/commit/revert lifecycle across a multi-file batch

## Related

- [ADR 0006](../decisions/0006-edit-safety-checkpoint-and-validation.md) — decision + alternatives + consequences
- [diff-engine.md](diff-engine.md) — the match/parse/hard-fail contract these layers wrap
- [improve-file-corruption.md](../../plans/improve-file-corruption.md) — the diagnosis
- [ADR 0004](../decisions/0004-r1-path-semantics-guards.md) — the tool-surface-vs-detector policy this follows
- [ADR 0001](../decisions/0001-stop-button-discards-partial.md) — partial-content discard at the streaming boundary
