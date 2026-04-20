# Events Table as Sole Source of Truth (ADR 0003)

**Goal:** Make the extension's events table the authoritative source for session history. Close the persistence gap where a process death mid-turn evaporates the in-memory response. Eliminate render-vs-saved drift by removing the webview's parallel CQRS blob.

**ADR:** [0003-events-table-sole-source-of-truth.md](../architecture/decisions/0003-events-table-sole-source-of-truth.md)

---

## Phase 1 — Foundation (DONE)

Shipped:

- [shared/parsing/codeBlocks.ts](../../shared/parsing/codeBlocks.ts) — single source, both bundles re-export.
- [shared/events/TurnEvent.ts](../../shared/events/TurnEvent.ts) — TurnEvent union moved out of `media/events/TurnEventLog.ts`. Added `iteration-end` variant.
- [src/events/StructuralEventRecorder.ts](../../src/events/StructuralEventRecorder.ts) — per-turn accumulator (`startTurn`, `append`, `drainTurn`, `peekCurrent`, `peekLastCompleted`). 8 unit tests.
- Recorder wired into [RequestOrchestrator](../../src/providers/requestOrchestrator.ts) `wireStructuralRecorder()`. Subscribes to existing emitters and appends TurnEvents with correct IDs.
- Events currently emitted extension-side: `text-append`, `thinking-start/content/complete`, `shell-start/complete`, `iteration-end`, `code-block`, `approval-created/resolved`.
- `tsconfig.json` updated: `rootDir: "."`, `include: ["src", "shared"]`.
- `Moby: Export Turn as JSON (Debug)` dev-mode command — opens `{ currentSessionId, inFlightTurn, lastCompletedTurn }` as a JSON document.
- 8 fidelity tests on the orchestrator (turn drain, shell/iteration pairing, text-append ordering, code-block extraction, approval pairing).

Still in Phase 1 but deferred to Phase 2.5 / 3:

- `drawing` — DrawingServer lives in ChatProvider, not the orchestrator.
- `tool-batch-*` — Chat model tool events have emitters but aren't yet mirrored to the recorder.
- `file-modified` — DiffManager events not yet subscribed.

---

## Phase 2 — Incremental persistence (DONE)

Shipped:

- [AssistantMessageEvent](../../src/events/EventTypes.ts) gains optional `status: 'in_progress' | 'complete' | 'interrupted'` and `turnId`.
- New `StructuralTurnEvent` variant on the ConversationEvent union — one row per TurnEvent, correlated by `turnId`, ordered by `indexInTurn`.
- `recordAssistantMessage` signature grew an optional `extras: { status?, turnId? }` param.
- New `recordStructuralEvent(sessionId, turnId, indexInTurn, payload)` on [ConversationManager](../../src/events/ConversationManager.ts).
- Orchestrator writes:
  - Placeholder `assistant_message` with `status='in_progress'` + generated `turnId` at turn start.
  - Each structural event to the events table live (single emit path via `_appendStructuralEvent`).
  - Finalization on normal completion with `status='complete'` (same `turnId`).
  - Finalization on abort with `status='interrupted'` (same `turnId`).
- 5 new Phase 2 tests + updates to ADR 0001 and history-save tests.
- Build clean; 239 tests in related suites green.

**Result today:** rows land on disk as they happen. Killing VS Code mid-turn leaves placeholder + partial structural events + (no finalization). Nothing reads them yet — hydration still goes through the old blob path.

---

## Phase 2.5 — Correctness gaps before flipping hydration (TODO)

Before Phase 3 flips hydration, the extension-authored event stream needs to match what the webview would have rendered. Research surfaced 10 gaps; 7 are blocking, 3 are follow-ups.

### Thinking / reasoning

1. **Interleaved reasoning + content in a single API delta** (HIGH). [deepseekClient.ts:228-414](../../src/deepseekClient.ts#L228-L414) fires `onReasoning` and `onToken` from the same chunk handler. If content fires first, my heuristic closes thinking; reasoning in the same delta afterwards is orphaned. Fix: defensive open on every reasoning token (match webview's `emitThinkingCompleteIfOpen` pattern).
2. **Zero-content retry skips `onIterationStart`** (MEDIUM). [requestOrchestrator.ts:1760-1787](../../src/providers/requestOrchestrator.ts#L1760-L1787) `continue`s without firing. Reasoning lands with stale iteration stamp. Fix: fire `onIterationStart` on every retry.
3. **Shell interrupt-and-resume state misalignment** (MEDIUM). If resumed stream opens with content (no reasoning), extension-side `thinkingActive` is stale. Fix: stamp state at interrupt time, not at resume.

### HIGH — Phase 3 hydration breaks without these

4. **Tool-batch events not wired.** `_onToolCallsStart/Update/End` fire but `wireStructuralRecorder` doesn't subscribe. Chat-model hydration loses all tool call rendering. Fix: subscribe and map to `tool-batch-start/update/complete` and `tool-update`.
5. **`file-modified` not emitted live.** DiffManager's `onCodeApplied`, `onAutoAppliedFilesChanged` not subscribed. Currently backfilled during save at [requestOrchestrator.ts:2273-2281](../../src/providers/requestOrchestrator.ts#L2273-L2281). Phase 3 needs live emission with status patching inline.
6. **Drawing events not wired.** `DrawingServer` in ChatProvider. Fix: either subscribe from ChatProvider into the recorder, or move the wiring.

### MEDIUM — subtly wrong rendering

7. **Approval cancellation doesn't fire `approval-resolved`.** [commandApprovalManager.ts](../../src/providers/commandApprovalManager.ts) `cancelPendingApproval` resolves the promise but doesn't fire the emitter. Dangling "awaiting approval" state on reload. Fix: fire `onApprovalResolved` with a synthetic `cancelled` decision.
8. **State not reset on turn start.** `_currentShellIdForRecorder`, `_currentApprovalIdForRecorder`, `_iterationContentAccum`, `_iterationCodeBlocksEmitted` only reset on iteration-start or completion — not on turn-start. Rapid turn succession corrupts FIFO pairing. Fix: explicit reset alongside `structuralEvents.startTurn`.
9. **Abort path skips code-block flush + final iteration-end.** Success path does `_flushCodeBlocksForIteration` + emit `iteration-end` before drain; abort just drains. Partial turns lose trailing code blocks. Fix: same flush + emit on abort.
10. **Code blocks spanning iteration boundaries are lost.** Opening ` ``` ` in iter N, closing in iter N+1 → unclosed fence in N's buffer, fresh accumulator in N+1, block vanishes. Fix: carry `hasIncompleteFence` state forward and re-parse the combined buffer on next flush.

### Follow-ups (LOW — defer)

- **text-append volume.** One row per token is correct but inefficient (~2000 rows/turn). Consider consolidating adjacent text-appends at drain time.
- **Shell emitter try-finally.** If an exception throws between `_onShellExecuting.fire` and `_onShellResults.fire`, orphaned start. Wrap in try-finally.
- **ContentTransformBuffer ordering audit.** Theoretical token reorder under concurrent flush + batch. Unlikely in practice.

### Phase 2.5 test coverage

- Interleaved reasoning + content in a single synthetic delta.
- Zero-content retry produces correct iteration stamps.
- Shell interrupt-and-resume with content-first resume.
- Chat-model turn emits full `tool-batch-*` sequence.
- File modified fires live with status transitions.
- Approval cancel produces paired `approval-created` / `approval-resolved`.
- Rapid turn succession doesn't leak shell/approval IDs.
- Abort path carries final iteration-end + trailing code blocks.
- Code block spanning two iterations appears exactly once.

---

## Phase 3 — Retire the blob + flip hydration (DONE)

Shipped:

- **Step 1.** Migration 1 extended with a functional index on `json_extract(data, '$.turnId')` for events of type `assistant_message` / `structural_turn_event` — Phase 3 queries avoid table scans. Pre-Phase-3 DBs are wiped manually (pre-release, no users).
- **Step 2.** `shutdown-interrupted` TurnEvent added to [shared/events/TurnEvent.ts](../../shared/events/TurnEvent.ts). Synthesized at hydration time for turns whose host died before finalization.
- **Step 3.** `EventStore.getStructuralEventsForTurn` + `getAssistantMessagesForTurn` added; exposed on `ConversationManager`.
- **Step 4.** `getSessionRichHistory` flipped. Reads structural events per turn by `turnId`, groups `assistant_message` rows, picks authoritative (`complete` > `interrupted` > `in_progress` > legacy). Deleted all the old fragment-reconstruction logic.
- **Step 5.** Fidelity test #1 (extension-only) — 6 Phase 3 tests in [tests/unit/events/ConversationManager.test.ts](../../tests/unit/events/ConversationManager.test.ts) covering `turnEvents` population, authoritative row selection, `shutdown-interrupted` synthesis, and turn isolation.
- **Step 6.** Webview cleanup — `convertHistoryToEvents` deleted, fallback branch in `loadHistory` handler replaced with direct read of `m.turnEvents`.
- **Step 7.** Blob write path retired — `receiveTurnEvents`, `_turnEventsPromise`, `_turnEventsResolve`, `prepareTurnEventsReceiver` all deleted. `turnEventsForSave` postMessage removed from webview. ChatProvider's router no longer handles it. `recordAssistantMessage` drops the `turnEvents` blob param (placeholder kept). File-modified status patching (old "step 5b") removed — Phase 2.5 live emission covers it.
- **Step 8.** `shutdown-interrupted` ViewSegment added to TurnProjector, handled in both `projectFull` and `projectIncremental`. Renderer emits the distinct marker `*[Interrupted by shutdown — partial response restored]*`.
- **Step 9.** Fidelity test #2 (round-trip) — [tests/unit/providers/fidelity.test.ts](../../tests/unit/providers/fidelity.test.ts) — scripted turn → orchestrator → EventStore → hydration → `liveEvents == hydratedEvents`. Three tests covering single turn, content preservation, and multi-turn grouping.
- **Step 10.** E2E fixtures (`tests/e2e/webview-rendering.spec.ts`) already feed `turnEvents` inline — no changes needed.
- **Step 11.** Perf smoke test — [tests/unit/events/hydration-perf.test.ts](../../tests/unit/events/hydration-perf.test.ts). 10K rows hydrate in ~340ms. Eager load confirmed acceptable.
- **Step 12.** This plan doc updated.

### Risks managed

- Pre-Phase-3 sessions were wiped by deleting the local DB file. Pre-release, no users.
- Rendering state not captured in structural events (e.g. UI snapshots) turned out to be none — the webview was only reading `turnEvents` for everything.

---

## Follow-ups explicitly parked

### Phase 3b — Per-turn lazy load (MEDIUM)

Hydration currently sends the full turnEvents array in one `loadHistory` message. For very large sessions this could be 10MB+ payloads. Proposal:

- Extension: split `loadHistory` into turn headers + on-demand `requestTurnEvents(turnId)` → `turnEvents({ turnId, events })`.
- Webview: VirtualListActor visibility callback triggers requests; cache loaded turnIds.
- Edge cases: fast scroll debounce, session-switch orphaned responses, eager-load the most recent turn for non-empty initial paint.

Size estimate: 2-3 focused days. See conversation history for the detailed breakdown. Defer until real usage surfaces a perf complaint or until session sizes warrant it.

### Small cleanups

- Dead writes: `recordToolCall` / `recordToolResult` / `recordAssistantReasoning` are still emitted by the orchestrator's `saveToHistory` pipeline but no hydration code reads them. Remove once stable.
- `recordAssistantMessage` has a lingering `_unused` parameter slot where the `turnEvents` blob used to live. Drop it in a follow-up PR that updates all call sites.
- `contentIterations` field still populated on RichHistoryTurn — may be redundant now that structural events include per-iteration stamping. Audit and remove if unused.

### Other parked items

- **Dynamic loading indicator** — subscribes to the same event stream. Natural byproduct of the unified emission path, separate feature.
- **Inspector live event feed** — debug affordance showing the live structural stream in a sidebar. Builds on the existing InspectorShadowActor.
- **`Moby: Replay Last Turn` command** — replay saved events in a fresh view for visual comparison during development.
- **Real R1 trace fixtures** — capture actual R1 streams and replay them through the fidelity test to catch edge cases the synthetic tests miss.
