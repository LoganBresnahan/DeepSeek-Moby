# 0003. Events table is the sole source of truth for session history

**Status:** Accepted
**Date:** 2026-04-19

## Context

History persistence today is dual-path. The extension writes per-event rows to the events table via `recordToolCall` / `recordToolResult` / `recordAssistantReasoning`. Separately, the webview builds a CQRS log and sends a consolidated `turnEvents` array (via `turnEventsForSave`) which gets stored inside the assistant message JSON blob. Both sides record overlapping facts through different paths.

Three concrete problems fall out of this split:

**1. Persistence gap on non-graceful shutdown.** The entire turn is saved atomically at the end of the stream ([requestOrchestrator.ts:1981-2057](../../../src/providers/requestOrchestrator.ts#L1981-L2057)). If the extension host dies mid-turn (most commonly: user closes VS Code while the extension is awaiting a shell command approval Promise), nothing in that block runs. Streamed content, reasoning, and executed shell commands evaporate. Only file modifications survive (DiffManager persists them on its own path).

**2. Restore-order divergence.** Live streaming order doesn't match hydrated order. Two root causes: a heuristic shell-to-iteration mapping at [VirtualMessageGatewayActor.ts:492-510](../../../media/actors/message-gateway/VirtualMessageGatewayActor.ts#L492-L510) ("1 shell per iteration, remainder to last" — fails when an iteration has 0 or 2+ shells), and a timestamp re-sort in `consolidateForSave` at [TurnEventLog.ts:282-286](../../../media/events/TurnEventLog.ts#L282-L286) that fixes postMessage queue delays for R1.

**3. Parser duplication.** [src/utils/codeBlocks.ts](../../../src/utils/codeBlocks.ts) and [media/utils/codeBlocks.ts](../../../media/utils/codeBlocks.ts) are identical twins, maintained as a chore with comments acknowledging it. The cross-bundle import ban (CLAUDE.md) forbids runtime cross-imports of things with different globals (vscode, DOM), but pure TS has no such constraint.

The extension is pre-release with no users, so we have freedom to reshape the architecture rather than patch around it.

## Decision

Make the extension's events table the sole source of truth for session history. Move structural event parsing (code-blocks, iteration boundaries, drawings, approval lifecycle) from webview-owned to extension-owned. Retire the `turnEvents` blob persistence path. Hydrate sessions entirely from the events table.

This is executed in three phases, shipped in order:

**Phase 1 — Foundation.** Create a `shared/parsing/` directory that both bundles import (pure TS only, no vscode/DOM deps). Migrate the duplicated `codeBlocks.ts` in. Extension begins emitting structural events (`code-block-start/end`, `iteration-end`, `drawing`, `approval-created/resolved`) as facts land. Webview continues to render but stops emitting these types to its CQRS log.

**Phase 2 — Incremental saves at buffer-flush boundaries.** Content is saved as `content-chunk` events when `ContentTransformBuffer` flushes (iteration boundary, pre-shell, pre-approval, end-of-turn). Add `status: 'in_progress' | 'complete' | 'interrupted'` to the assistant message JSON blob (no schema migration — the blob already stores arbitrary metadata). The pre-approval checkpoint closes the persistence gap: content that streamed before a command approval prompt survives a process death while awaiting the user's click.

**Phase 3 — Retire the blob, rewire hydration.** `recordAssistantMessage` stops storing `turnEvents`. Hydration reads purely from the events table. The heuristic shell-to-iteration mapping in `convertHistoryToEvents` is deleted — events already land in order, so no reconstruction is needed. Sessions reload as exactly what was shown live.

## Alternatives considered

### A. Split ownership (the "A" option from planning)

Keep `turnEvents` but classify each variant as extension-owned or webview-owned. Extension records what it observes; webview records what only it sees. At finalize, keep only webview-owned types in the blob.

Rejected because: it doesn't fix the restore-order divergence (the heuristic mapping stays). It leaves the dual-path architecture in place, which means future features need to choose a side. And the webview-owned set would be small (~drawings, UI state only) once structural events move to the extension — not enough to justify keeping the blob path.

### B. Dedupe by correlation ID at save-time (the "B" option)

Extension-recorded events get stable IDs; webview events reference the same IDs; `recordAssistantMessage` filters turnEvents whose IDs already exist in the events table. Tolerates classification drift between the two sides.

Rejected as a destination, but it's a plausible stopgap. Since the extension is pre-release, we skip the stopgap and go to the destination directly.

### D. Keep the split, add checkpointing only

Address the persistence gap without restructuring. Periodically save a snapshot of in-memory turn state. Leaves restore-order divergence and parser duplication in place.

Rejected because: the snapshot approach is more machinery than the event-sourcing approach we already have. The events table is designed for incremental writes — using it that way is less code, not more.

## Consequences

**Positive:**
- Persistence gap is closed. A crashed or force-quit VS Code leaves the session in a recoverable state.
- Live rendering and hydrated rendering produce byte-identical event sequences. No more "what renders doesn't look like what was saved."
- Duplicated parsers collapse into a shared module. Webview becomes a renderer, not a parser-plus-renderer.
- The dynamic loading indicator (planned feature in CLAUDE.md) becomes a natural byproduct — the same extension events that drive persistence drive "Running cat tsconfig.json" / "Writing src/game.ts" narration.

**Negative / accepted costs:**
- ~130 LOC of parser relocation plus event-plumbing and hydration rewiring. Not small, but bounded.
- The refactor touches hot paths: `requestOrchestrator`, `ConversationManager.getSessionRichHistory`, `VirtualMessageGatewayActor`. Regressions here are visible. Test coverage must come with the change.
- `convertHistoryToEvents` and adjacent fallback paths are deleted. Once gone, sessions saved before Phase 3 would need to be re-hydrated under the new rules. Since no users exist, we don't need a compatibility path — but once released, this decision is locked in.

**Follow-ups:**
- ✅ **Done.** The dynamic loading indicator now subscribes to the structural event stream (thinking / shell / approval / tools / web-search / code-block activity).
- The inspector actor should gain a live event feed view for debuggability during the refactor.
- ✅ **Done.** `Moby: Export Turn as JSON` is wired up in devMode (see `package.json`, `CommandsShadowActor`, `extension.ts`).
- ✅ **Done.** Fidelity test landed at [tests/unit/providers/fidelity.test.ts](../../../tests/unit/providers/fidelity.test.ts).
- **Parked.** Phase 3b — per-turn lazy load. Split `loadHistory` into headers + on-demand `requestTurnEvents(turnId)`, with VirtualListActor visibility callbacks driving requests. Deferred until real-world session sizes surface the need.
- **Planned.** Phase 3c — modified-files live render unification (see below). The "Modified Files" dropdown is the one structural fact still rendered live from a parallel notification channel instead of the structural event log.

---

## Phase 3c — modified-files live render unification (planned)

### The remaining divergence

Phase 3 made the structural event log the sole source of truth for *restore*, but the **live** "Modified Files" dropdown was never migrated onto it. The same `file-modified` fact is authored twice, through two channels with different timing:

- **Restore (event-driven, complete, canonical order).** Each apply unconditionally calls `DiffManager.sendCodeAppliedStatus(true, …, filePath)` ([diffManager.ts:1040](../../../src/providers/diffManager.ts#L1040)) → `onCodeApplied` → `RequestOrchestrator._appendStructuralEvent({type:'file-modified'})` → persisted. Hydration replays the whole log via `TurnProjector.projectFull` → `renderSegment('file-modified')` → `virtualList.addPendingFile`.
- **Live (notification-driven, lossy, arrival order).** A parallel `diffListChanged` / auto-applied notification (`DiffManager.notifyAutoAppliedFilesChanged` → `chatProvider` postMessage → `VirtualMessageGatewayActor.handleDiffListChanged`) renders the dropdown and *also* appends a `file-modified` to the webview's **local** `TurnEventLog`. Auto edits suppress the per-file notification (`skipNotification=true`, [requestOrchestrator.ts:2625](../../../src/providers/requestOrchestrator.ts#L2625)) and rely on a **batched** `emitAutoAppliedChanges()` at the tool-batch boundary ([requestOrchestrator.ts:3257-3260](../../../src/providers/requestOrchestrator.ts#L3257-L3260) and twin at ~3548).

Because the live notification is batched and flushed at specific loop points, the **final** file can be dropped live (the batch flush isn't reached before the turn ends) while the structural event is always persisted — so the dropdown is missing live but present on restore. The same two-channel split is why streamed segment **order** can differ slightly from hydrated order: two renderers over two event streams. (A band-aid landed first: an idempotent end-of-response `emitAutoAppliedChanges()` flush before each `_onEndResponse.fire()` — incremental via `_lastNotifiedDiffIndex`, so a no-op when the tail was already sent. It fixes the missing-final-file symptom but leaves the dual-channel architecture in place.)

### Decision

Render the live "Modified Files" dropdown by **projecting the same `file-modified` structural events the extension already persists**, not via the `diffListChanged` notification channel. One author, one log, one projection — for both live and restore. This is the modified-files instance of the Phase 3 principle ("live rendering and hydrated rendering produce byte-identical event sequences").

### Plan

1. **Emit `file-modified` structurally, live.** The extension already authors the event for persistence; additionally surface it to the webview through the same live structural-event stream the other types use (`emitTurnEvent` → incremental projector), carrying `{path, status, editMode, action, diffId}`. Dual-write at first (keep the notification channel) to validate parity.
2. **Render live via the projection path.** Route the live `file-modified` through `renderSegment('file-modified')` exactly as restore does, removing the modified-files rendering from `handleDiffListChanged`. The local-log append at [VirtualMessageGatewayActor.ts:1264](../../../media/actors/message-gateway/VirtualMessageGatewayActor.ts#L1264) comes from the emitted event instead of the notification.
3. **Model status transitions as events.** Accept/reject/supersede/expire currently flow as `diffListChanged` status updates and webview button handlers. Represent them as structural events (e.g. `file-status-changed` keyed by `diffId`/path) so the dropdown's lifecycle is reconstructable from the log alone. `projectFull` gains dedup-by-path/coalesce semantics matching today's `handleDiffListChanged` dedup ([VirtualMessageGatewayActor.ts:1209-1252](../../../media/actors/message-gateway/VirtualMessageGatewayActor.ts#L1209-L1252)).
4. **Retire the parallel channel.** Once live is event-driven, drop `skipNotification` + the batched `emitAutoAppliedChanges()` flushes + the Phase-3c band-aid end-of-response flush. `notifyAutoAppliedFilesChanged` / `_lastNotifiedDiffIndex` go away.
5. **Converge ordering.** Live and restore now project identical `file-modified` events in identical log order, so the modified-files ordering divergence disappears.

### Care points

- **Status lifecycle vs. recompute.** Decide whether status transitions are their own events or whether the renderer recomputes from the latest `file-modified` per path. Events are cleaner for restore fidelity; recompute is less plumbing. Ask/auto/manual differ (manual shows no dropdown but still marks the code block applied on restore — keep that gating in `renderSegment`).
- **Manual mode.** No dropdown; the structural event still records for the restore "applied" code-block marking. Preserve the `editMode === 'manual'` branch.
- **Dedup parity.** The notification path's dedupe-by-diffId-and-path must move into the projector so re-edits of the same file update a single row rather than piling up.
- **Fidelity test.** Extend [tests/unit/providers/fidelity.test.ts](../../../tests/unit/providers/fidelity.test.ts) to assert the live `file-modified` sequence equals the hydrated sequence (count + order + final status), which both fixes the missing-final-file and pins ordering.

### Phasing

- **3c-A:** live structural emission alongside the notification channel (dual-write, validate parity in the fidelity test).
- **3c-B:** switch live rendering to the projection path; notification channel kept only for status transitions.
- **3c-C:** model status transitions as events; retire `diffListChanged`/`emitAutoAppliedChanges`/`skipNotification` and the band-aid flush.

### Cost

Bounded but touches hot paths (`requestOrchestrator` dispatch, `diffManager` notify, `VirtualMessageGatewayActor` live handling, `TurnProjector`). Regression-visible — must land with the fidelity test above. No user-data migration (events already persist; this only changes the live render source).

**Implementation note (2026-06-16) — naming drift, decision unchanged.** This ADR records the decision as taken; the names below are the *as-shipped* event types (the decision itself still holds — the events table is the sole source of truth). For accuracy when discussing the shipped code, see [`shared/events/TurnEvent.ts`](../../../shared/events/TurnEvent.ts):
- The Phase 1 names `code-block-start`/`code-block-end` shipped as a single **`code-block`** event.
- The Phase 2 `content-chunk` event shipped as **`text-append`** / **`text-finalize`** (incremental streamed text), alongside the assistant message's `status` metadata for crash-survivable content.
- `iteration-end`, `drawing`, and the approval lifecycle events all shipped as named.
