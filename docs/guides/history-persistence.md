# Conversation History Persistence

How conversations are saved, stored, and restored with full fidelity.

## Overview

History persistence captures every segment of a conversation — reasoning bubbles, tool calls, shell executions, file modifications, and text content — and restores them in the correct visual order when a session is loaded later. The system uses **event sourcing**: each action during a conversation is recorded as an immutable event, and the full conversation is reconstructed by replaying those events.

The current model (ADR 0003) writes **structural turn events** incrementally during streaming, keyed by `turnId`, so a crash mid-turn still leaves the completed portion on disk. Restore hydrates each turn from its `assistant_message` boundary rows (resolving the authoritative one by status) plus its ordered `structural_turn_event` rows, which the webview projects through `TurnProjector` — there is no model-specific replay algorithm anymore.

## Architecture

```
┌──────────────────────────────┐
│  Save (requestOrchestrator)  │  Extension process (Node.js)
│  Records granular events     │  All record*() take explicit
│  during/after streaming      │  sessionId parameter
└──────────┬───────────────────┘
           │ recordStructuralEvent(sessionId, turnId, ...)  ← live, source of truth
           │ recordAssistantMessage(sessionId, ..., { status, turnId })
           │ recordToolCall/recordToolResult(...)  ← legacy, not read on restore
           ▼
┌──────────────────────────────┐
│  EventStore (SQLCipher)       │  Native SQLite (encrypted)
│  events + event_sessions     │  M:N join table for
│  (session-agnostic storage)  │  per-session sequencing
└──────────┬───────────────────┘
           │ getEventsByType(['user_message','assistant_message'])
           │ getStructuralEventsForTurn(turnId)
           ▼
┌──────────────────────────────┐
│  Restore (ConversationMgr)   │  Extension process (Node.js)
│  getSessionRichHistory()     │  Resolve authoritative row by
│  Groups by turnId → turns    │  status; attach turnEvents[]
└──────────┬───────────────────┘
           │ postMessage({ type: 'loadHistory', history })
           ▼
┌──────────────────────────────┐
│  Render (Gateway Actor)      │  Webview process (Browser)
│  handleLoadHistory()         │  TurnProjector.projectFull()
│  → ViewSegments → render     │  → VirtualListActor API
└──────────────────────────────┘
```

## Event Types

Each action during a conversation produces one or more events:

| Event Type | When Recorded | Key Fields |
|---|---|---|
| `user_message` | User sends a message | `content`, `attachments` |
| `assistant_reasoning` | After each Reasoner thinking iteration | `content`, `iteration` |
| `tool_call` | Tool invoked (shell, read_file, etc.) | `toolCallId`, `toolName`, `arguments` |
| `tool_result` | Tool completes | `toolCallId`, `result`, `success` |
| `structural_turn_event` | Incrementally during streaming (ADR 0003) | `turnId`, `indexInTurn`, `payload` (a `TurnEvent`) |
| `assistant_message` | Twice per turn: `in_progress` placeholder at turn start, `complete`/`interrupted` final row at end | `content`, `model`, `finishReason`, `contentIterations`, `status`, `turnId` |

> **Assistant message lifecycle.** Each assistant turn writes a placeholder `assistant_message` with `status: 'in_progress'` (empty content) *before* streaming — so a crash leaves a recoverable record — then a final row with `status: 'complete'` (or `'interrupted'` on abort) at the end. Both share the same `turnId`, which also keys the turn's `structural_turn_event` rows. Restore groups by `turnId` and resolves the authoritative row (`complete` > `interrupted` > `in_progress`).

### Special Tool Names

- `shell` — Shell command execution. Arguments contain `{ command }`, result contains stdout.
- `_file_modified` — Marker for file modifications. Arguments contain `{ filePath, editMode }`. These rows are still **written on save** (legacy/compat), but they are **no longer consumed during restore** — `getSessionRichHistory()` never reads `tool_call`/`tool_result` rows. File-modified state is carried by structural turn events instead.

## Save Pipeline

Located in [`requestOrchestrator.ts`](../../src/providers/requestOrchestrator.ts) `saveToHistory()`.

All `record*()` calls take an explicit `sessionId` — ConversationManager is a pure data service with no implicit "current session".

Two things happen **live during streaming**, before `saveToHistory()` runs:

- An `in_progress` placeholder `assistant_message` is recorded at turn start (carrying the shared `turnId`).
- Each view-affecting event is persisted as a `structural_turn_event` row via `recordStructuralEvent()` (driven by `StructuralEventRecorder`), keyed by `turnId`/`indexInTurn`. These rows are the restore source of truth.

Then `saveToHistory()` runs at the end of streaming (both normal completion and partial/abort) and records these in order:

```
1. recordAssistantReasoning(sessionId, ...)  × N reasoning iterations
2. recordToolCall(sessionId, ...) + recordToolResult(sessionId, ...)  × non-shell tool calls
3. recordToolCall(sessionId, 'shell', ...) + recordToolResult(sessionId, ...)  × shell results
4. recordToolCall(sessionId, '_file_modified', ...) + recordToolResult(sessionId, ...)  × file modifications
5. recordAssistantMessage(sessionId, ...)  ← final complete/interrupted row (shared turnId)
```

Steps 1–4 are still written but are **not read during restore** (they predate ADR 0003). Step 5 writes the authoritative final row; restore reads only `user_message` + `assistant_message` boundary rows plus the per-turn `structural_turn_event` rows.

### Content Iterations

For the Reasoner model, each shell loop iteration produces separate text. The `contentIterations` parameter on `recordAssistantMessage()` captures per-iteration text (cleaned of shell tags and DSML). This enables correct interleaving during restore.

Without `contentIterations`, the restore would place ALL text at the end of the turn. With it, each iteration's text appears in the correct position relative to its thinking bubble and shell command.

### File Modification Timing

File paths are tracked **synchronously** at code block detection time (before the async `applyCodeDirectlyForAutoMode()`). This is critical because the async apply is fire-and-forget — it completes after the save pipeline runs. The sync tracking ensures `currentResponseFileChanges` is populated at save time.

## Restore Pipeline

Located in [`ConversationManager.ts`](../../src/events/ConversationManager.ts), method `getSessionRichHistory()`.

### Turn Hydration Algorithm (ADR 0003 Phase 3)

Only `user_message` and `assistant_message` rows are queried for turn boundaries — `assistant_reasoning`, `tool_call`, and `tool_result` are **not read during restore**. Each row is walked in sequence order:

1. `user_message` → Emits a user turn (`content`, `files`, `timestamp`, `sequence`).
2. `assistant_message` → Turns are grouped by `turnId`. Each turn is emitted exactly once, at the position of its first row (preserving sequence order against user turns). For the group, the **authoritative** row is resolved by status: `complete` > `interrupted` > `in_progress` (legacy rows without status fall back to the last in the group).
3. For an assistant turn, the per-turn `structural_turn_event` rows are loaded via `getStructuralEventsForTurn(turnId)` and their `payload`s are attached as the turn's `turnEvents[]` — this is what the webview actually replays.
4. **Crash recovery:** if a turn's group is `in_progress`-only (no final row) but has structural events, a synthetic `shutdown-interrupted` `TurnEvent` is appended so the renderer can show a distinct marker. It is derived at hydration time, never persisted.

`reasoning_iterations`, `toolCalls`, `shellResults`, and `filesModified` are **no longer populated** by `getSessionRichHistory()`; only `content`, `model`, `timestamp`, `sequence`, `contentIterations`, and `turnEvents` are set on assistant turns.

### RichHistoryTurn Interface

```typescript
interface RichHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
  // Assistant-only:
  reasoning_iterations?: string[];   // declared, but NOT populated by restore
  contentIterations?: string[];      // Per-iteration content text (stored; informational)
  toolCalls?: Array<{ name: string; detail: string; status: string }>;  // declared, not populated
  shellResults?: Array<{ command: string; output: string; success: boolean }>;  // declared, not populated
  filesModified?: string[];          // declared, not populated by restore
  editMode?: 'manual' | 'ask' | 'auto';  // edit mode active for this turn's file changes
  model?: string;                    // 'deepseek-chat' or 'deepseek-reasoner'
  turnEvents?: Array<Record<string, unknown>>;  // structural TurnEvents — what restore replays
  // User-only:
  files?: string[];                  // Attached file names
  timestamp: number;
  sequence?: number;                 // turn-boundary event sequence (used by fork API)
}
```

> `reasoning_iterations`, `toolCalls`, `shellResults`, and `filesModified` remain on the interface for legacy compatibility but are no longer populated by `getSessionRichHistory()`. The restore path consumes `turnEvents`.

## Render Pipeline

Located in [`VirtualMessageGatewayActor.ts`](../../media/actors/message-gateway/VirtualMessageGatewayActor.ts), method `handleLoadHistory()`.

### Projection (model-agnostic)

There is no model-specific branch. For each assistant turn, `handleLoadHistory()` does the same thing regardless of model:

```
1. virtualList.addTurn(turnId, 'assistant', { model, timestamp, sequence })
2. tl = getTurnLog(turnId); tl.load(m.turnEvents ?? [])   // build a TurnEventLog
3. segments = this._projector.projectFull(tl)             // TurnProjector → ViewSegment[]
4. for each segment: this.renderSegment(turnId, segment)  // → VirtualListActor API
```

The ordering and interleaving of thinking bubbles, shell segments, file modifications, and text all come from the recorded `turnEvents` themselves, replayed through `TurnProjector`. `reasoning_iterations`, `contentIterations`, `shellResults`, `toolCalls`, and `filesModified` are not consulted in the render path.

### No Legacy Fallback

The previous fragment-reconstruction fallback (`convertHistoryToEvents`) was deleted along with the fragment fields it read. An assistant turn that arrives **without** `turnEvents` renders nothing — there is no `content`/`contentIterations` fallback during restore anymore.

## Live vs Restored: Key Differences

| Aspect | Live Streaming | Restored |
|---|---|---|
| Thinking bubbles | Animate token-by-token | Immediately complete, collapsed |
| Tool call badges | Show progress spinner | Static with final status |
| Shell segments | Show "Running..." then output | Show completed output |
| File modifications | Show pending/accept/reject UI | Show as 'applied' (read-only) |
| Text content | Streams token-by-token | Rendered all at once |
| Content interleaving | Handled by ContentBuffer | Handled by structural `turnEvents` (TurnProjector) |

## Troubleshooting

### No events in DB after conversation

Check that events are being appended correctly. The native SQLCipher database writes directly to disk, so data should persist automatically.

### Restored text appears in wrong order

Restore order comes from the turn's `structural_turn_event` rows, replayed through `TurnProjector`. Check the `[RichHistory]` log for the turn's boundary/assistant-turn counts and the `[VirtualGateway] restore turn …: N events` / `projected …: N segments` logs — if a turn shows `0 events`, no structural rows were persisted for it (the live `recordStructuralEvent()` path didn't fire), and the turn will render nothing.

### File modifications missing from restore

File-modified state is carried by structural turn events (`file-modified` `TurnEvent` payloads), not by the `_file_modified` tool rows. Check that structural events were written live during streaming (`[VirtualGateway] restore turn …: N events` should be non-zero). The `_file_modified` `tool_call`/`tool_result` rows in the DB are legacy and are not read during restore.

### Session switch shows nothing

Check `[loadSession]` logs for `found=true, view=true`. If the session is found but history is empty, the events may have been recorded to a different session ID. Cross-check `[HistorySave] Saving to session=<id>` with the session being loaded.

## Test Coverage

- **ConversationManager tests** (`tests/unit/events/ConversationManager.test.ts`): 14 cases in the `getSessionRichHistory` block covering turn grouping by `turnId`, authoritative-row selection (`complete` > `interrupted` > `in_progress`), structural-event hydration into `turnEvents`, the synthesized `shutdown-interrupted` event, and cross-turn isolation.
- **Gateway restore tests** (`tests/actors/message-gateway/VirtualMessageGatewayActor.test.ts`): 6 cases in the `loadHistory restore` block, all driven by `turnEvents`/structural events — including "renders nothing for assistant turns missing turnEvents (no legacy fallback)" and empty-history handling.

## Related Files

| File | Role |
|---|---|
| [`requestOrchestrator.ts`](../../src/providers/requestOrchestrator.ts) | Save pipeline (`saveToHistory()`) + live structural-event recording |
| [`chatProvider.ts`](../../src/providers/chatProvider.ts) | Session loading (`loadSession()` → posts `loadHistory`) |
| [`ConversationManager.ts`](../../src/events/ConversationManager.ts) | `RichHistoryTurn` type + `getSessionRichHistory()` |
| [`EventTypes.ts`](../../src/events/EventTypes.ts) | Event type definitions |
| [`EventStore.ts`](../../src/events/EventStore.ts) | Append-only event storage |
| [`SqlJsWrapper.ts`](../../src/events/SqlJsWrapper.ts) | Database wrapper (@signalapp/sqlcipher) |
| [`VirtualMessageGatewayActor.ts`](../../media/actors/message-gateway/VirtualMessageGatewayActor.ts) | `handleLoadHistory()` restore renderer |
| [`VirtualListActor.ts`](../../media/actors/virtual-list/VirtualListActor.ts) | DOM rendering API |
