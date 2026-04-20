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
- The dynamic loading indicator can be implemented by subscribing to the same event stream after Phase 1.
- The inspector actor should gain a live event feed view for debuggability during the refactor.
- A `Moby: Export Turn as JSON` command (dumps live / saved / hydrated event sequences side-by-side) becomes the primary debugging tool. Build it early in Phase 1.
- A fidelity test — scripted turn → capture live events → save → reload → capture hydrated events → assert equal — is the single highest-ROI test for this change. Land it before Phase 3.
