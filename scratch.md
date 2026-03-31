Step 1: Fix Bug 5 — Event log not reset between conversations.
Quick fix: clear _turnLogs in handleStartResponse and handleClearChat. Without this, event logs from previous conversations contaminate new ones. Must be first because all other debugging depends on clean event logs.

Step 2: Fix duplicate/spurious events in the event log.

Remove the spurious text-finalize at the start of handleIterationStart when no text exists (check if current iteration has any text-append events first)
Prevent duplicate text-finalize from both handleShellExecuting and handleIterationStart firing back-to-back
These are noise, not bugs — the projector handles them gracefully. But cleaning them up makes the logs readable and reduces the event count from 551 to something sane.

Step 3: Phase 5 — Save event log directly to DB instead of RichHistoryTurn.
This is the big one. Instead of saveToHistory assembling reasoningIterations[], contentIterations[], shellResultsForHistory[] separately and writing them as individual event types, serialize the entire TurnEventLog as a single JSON blob on the assistant_message event. The webview already has the event log ready at endResponse time.

This eliminates Bugs 1, 2, 3, and 4 in one shot because the event log captured everything correctly — approvals, all text iterations, file modifications. The problem was only in the lossy conversion from event log → RichHistoryTurn → DB → RichHistoryTurn → convertHistoryToEvents → event log.

Step 4: Update getSessionRichHistory to read the event log format.
When reading back from DB, detect whether the assistant_message event has a turnEvents field (new format) or contentIterations (old format). If new format, pass the raw events through. If old format, fall through to existing conversion logic (backward compat for any sessions created during testing, though we said we'd delete them).

Step 5: Update handleLoadHistory to use raw events when available.
Instead of calling convertHistoryToEvents(m), check if the history turn already has raw events. If so, load them directly into the TurnEventLog. The convertHistoryToEvents function becomes a fallback for old data only.

Step 6: Phase 4 — Remove legacy rendering from streaming path.
Now that both live and restore go through the same event log and both produce correct output, replace the legacy rendering in handleStreamToken, handleStreamReasoning, handleShellExecuting, etc. with projector-based rendering. The emitTurnEvent + applyMutations path replaces the direct VirtualListActor calls.

This removes _segmentContent, _hasInterleaved, finalizeCurrentSegment, resumeWithNewSegment, and the fence carry-forward logic from the gateway.

Step 7: Phase 6 — Dead code cleanup.
Remove convertHistoryToEvents (no longer needed), remove the dual-write CQRS comments, remove unused gateway state fields, clean up the saveToHistory method to just serialize the event log.

Step 8: Test thoroughly.
Run multiple conversations with various scenarios (shell commands, approvals, file modifications, code blocks, tool calls) and verify live ≡ restore for each.

Summary of dependencies:


Step 1 (bug fix) → independent, do first
Step 2 (event cleanup) → independent, do second
Step 3 (save events to DB) → enables Steps 4-5
Step 4 (read events from DB) → requires Step 3
Step 5 (history restore from raw events) → requires Step 4
Step 6 (remove legacy rendering) → requires Steps 3-5 working
Step 7 (cleanup) → requires Step 6
Step 8 (testing) → after each step, but especially after 5 and 6
