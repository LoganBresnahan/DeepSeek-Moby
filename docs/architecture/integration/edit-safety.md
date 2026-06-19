# Edit Safety

Reference for the fail-safe edit pipeline that wraps auto-mode file application. Decision record and rationale: [ADR 0006](../decisions/0006-edit-safety-checkpoint-and-validation.md). Diagnosis that motivated it: [improve-file-corruption.md](../../plans/improve-file-corruption.md). The underlying match/parse contract this builds on: [diff-engine.md](diff-engine.md).

**Status:** Specified (ADR 0006, Proposed) — not yet implemented. This doc describes the target design; sections are marked *have* / *new* accordingly.

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
  ╭──────────── ATOMIC EDIT BATCH · one tool-iteration · ★ ───────────────
  │   ★ CHECKPOINT — snapshot each touched file (in-memory original content)
  │        ▼
  │   per edit:  ✅ freshness check → ✅ strict match | HARD-FAIL → write REPLACE
  │             + ★ write-back verify (re-read == intended; else revert)
  │        ▼
  │   any hard-fail / verify-fail? ──► ★ REVERT batch ─► re-read nudge
  │        ▼ no
  │   ★ VALIDATE — project toolchain, approval-gated, timeout, run ONCE
  │        discover check cmd · run via CommandApproval · diff diagnostics BEFORE vs AFTER
  │        ▼
  │   outcome ─┬─ no new errors ─────────► ★ COMMIT ─► emit "Modified Files" ─► SUCCESS ✅
  │            ├─ new errors (regression)─► ★ REVERT ─► feed errors back ─► retry
  │            │                            └─ budget exhausted ─► ★ HALT (files at last-good, surface)
  │            └─ inconclusive ───────────► ★ COMMIT + one-time note (no oracle/timeout; Auto's default)
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
| 7 | **Bounded autonomy + terminal halt** (no mode switch) | ★ new | retry budget `maxFailedEditRetries` [requestOrchestrator.ts:1475](../../../src/providers/requestOrchestrator.ts#L1475) |
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
- **Delta, not absolute**: compare diagnostics/exit state *before* the batch vs *after*. A regression = a *new* error attributable to a touched file (or clean→broken exit transition). Pre-existing errors and errors in untouched files do not count.

## Configuration (`moby.editSafety.*`)

| Key | Default | Meaning |
|---|---|---|
| `checkpoint` | `true` | Snapshot + atomic batch + revert-on-regression. Pure safety; invisible on the happy path. |
| `validate` | `"auto"` | `"auto"` discover a command; `"off"` skip; or an explicit command string. |
| `validateTimeoutMs` | `60000` | Hard timeout for the check command. |
| `maxRepairAttempts` | `3` | Autonomous revert-and-retry rounds on a confirmed regression before the turn halts (reuses `maxFailedEditRetries`). |
| `onInconclusive` | `"commit"` | No oracle / timeout / unapproved: `"commit"` apply + note (Auto's default); `"halt"` stop the turn. No "ask" — Auto never becomes Ask. |

Contributed in `package.json` `contributes.configuration.properties`; read via `getConfiguration('moby')` (same pattern as `moby.subagents`).

## Rollout phases

1. **Checkpoint + atomic batch + write-back verify** — pure safety primitive; the keystone. Revert triggers only on write-back mismatch / hard-fail. Behind `moby.editSafety.checkpoint`.
2. **Validation gate + revert-on-regression + feedback** — `ProjectCheck` discovery, delta diagnostics, reuse of the `maxFailedEditRetries` re-read loop.
3. **Terminal halt** on repair-budget exhaustion + inconclusive handling (commit-with-note vs. halt). No mode switching.
4. **(separate ADR)** content-embedded edit transport — get bulky code out of JSON tool-call args (attacks garble *rate*, not just *surface*).

## Test matrix

Authoritative list of what must be covered. Pending scaffolding lives in `tests/unit/providers/{checkpoint,atomicBatch,validationGate,revert,terminalHalt}.test.ts` as `it.todo(...)` mirroring these rows; each becomes a real test as its phase lands. Harness conventions follow [diffManager.test.ts](../../../tests/unit/providers/diffManager.test.ts) and [requestOrchestrator.test.ts](../../../tests/unit/providers/requestOrchestrator.test.ts) (`vi.hoisted` `WorkingEventEmitter`, `vi.mock('vscode')`, factory mocks).

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

### validationGate.test.ts (Phase 2)
- discovers `dotnet build` from a `.csproj`; `npm run build` from package.json; `make` from a Makefile
- no marker → gate is a no-op (commit), per default config
- check command routed through CommandApproval; blocked → no-op + surfaced, no bypass
- timeout → inconclusive (not a false regression)
- delta: a pre-existing error does not count as a regression
- delta: a new error in a touched file counts as a regression
- delta: a new error only in an untouched file does not count
- clean build → commit
- `validate: "off"` → gate skipped entirely
- validation runs exactly once per batch, not per edit

### revert.test.ts (Phase 2)
- a regression triggers `revert` to checkpoint
- post-revert file content equals original bytes
- revert feeds the scoped build errors back through the re-read loop
- revert respects `maxFailedEditRetries` and increments the failed-apply count
- a reverted edit reports `status: 'failed'`, not success (layer 8)
- write-back verification: post-write read ≠ intended content → revert (fs-level corruption)

### terminalHalt.test.ts (Phase 3)
- a confirmed regression triggers revert + autonomous retry (no Ask prompt is shown)
- retries are bounded by `maxRepairAttempts`
- on repair-budget exhaustion the turn halts: files left reverted at last-good
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
