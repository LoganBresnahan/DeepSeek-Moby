# Conversation History Persistence

How conversations are saved, stored, and restored with full fidelity.

## Overview

History persistence captures every segment of a conversation — reasoning bubbles, tool calls, shell executions, file modifications, and text content — and restores them in the correct visual order when a session is loaded later. The system uses **event sourcing**: each action during a conversation is recorded as an immutable event, and the full conversation is reconstructed by replaying those events.

## Architecture

```
┌──────────────────────────────┐
│  Save (chatProvider.ts)      │  Extension process (Node.js)
│  Records granular events     │
│  during/after streaming      │
└──────────┬───────────────────┘
           │ recordAssistantReasoning()
           │ recordToolCall() / recordToolResult()
           │ recordAssistantMessage()
           ▼
┌──────────────────────────────┐
│  EventStore (sql.js)         │  In-memory SQLite (WASM)
│  Append-only events table    │  Auto-saves to disk via scheduleSave()
│  Indexed by session + type   │
└──────────┬───────────────────┘
           │ getEventsByType()
           ▼
┌──────────────────────────────┐
│  Restore (ConversationMgr)   │  Extension process (Node.js)
│  getSessionRichHistory()     │
│  Groups events → turns       │
└──────────┬───────────────────┘
           │ postMessage({ type: 'loadHistory', history })
           ▼
┌──────────────────────────────┐
│  Render (Gateway Actor)      │  Webview process (Browser)
│  handleLoadHistory()         │
│  Calls VirtualListActor API  │
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
| `assistant_message` | After streaming completes (final event in turn) | `content`, `model`, `finishReason`, `contentIterations` |

### Special Tool Names

- `shell` — Shell command execution. Arguments contain `{ command }`, result contains stdout.
- `_file_modified` — Marker for file modifications. Arguments contain `{ filePath }`. These are extracted into `filesModified[]` during restore, NOT shown as tool call badges.

## Save Pipeline

Located in [`chatProvider.ts`](../../src/providers/chatProvider.ts) around line 2125.

The save happens at the end of streaming (both normal completion and partial/abort). Events are recorded in this order:

```
1. recordAssistantReasoning()  × N reasoning iterations
2. recordToolCall() + recordToolResult()  × non-shell tool calls
3. recordToolCall('shell') + recordToolResult()  × shell results
4. recordToolCall('_file_modified') + recordToolResult()  × file modifications
5. recordAssistantMessage()  ← seals the turn
```

### Content Iterations

For the Reasoner model, each shell loop iteration produces separate text. The `contentIterations` parameter on `recordAssistantMessage()` captures per-iteration text (cleaned of shell tags and DSML). This enables correct interleaving during restore.

Without `contentIterations`, the restore would place ALL text at the end of the turn. With it, each iteration's text appears in the correct position relative to its thinking bubble and shell command.

### File Modification Timing

File paths are tracked **synchronously** at code block detection time (before the async `applyCodeDirectlyForAutoMode()`). This is critical because the async apply is fire-and-forget — it completes after the save pipeline runs. The sync tracking ensures `currentResponseFileChanges` is populated at save time.

## Restore Pipeline

Located in [`ConversationManager.ts`](../../src/events/ConversationManager.ts), method `getSessionRichHistory()`.

### Turn Grouping Algorithm

Events are queried by type and walked in sequence order:

1. `user_message` → Creates a new user turn. Finalizes any open assistant turn.
2. `assistant_reasoning` → Starts or continues an assistant turn. Appends to `reasoning_iterations[]`.
3. `tool_call` → Routes by `toolName`:
   - `'shell'` → Appends to `shellResults[]` with placeholder output
   - `'_file_modified'` → Appends `filePath` to `filesModified[]`
   - Other → Appends to `toolCalls[]`
4. `tool_result` → Matches by `toolCallId` to update output/status on the correct entry. Skips `_file_modified` results.
5. `assistant_message` → Finalizes the assistant turn with `content`, `model`, and optional `contentIterations`.

Empty arrays are cleaned up before returning (e.g., `reasoning_iterations` is `undefined` if empty).

### RichHistoryTurn Interface

```typescript
interface RichHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
  // Assistant-only:
  reasoning_iterations?: string[];   // Per-iteration thinking text
  contentIterations?: string[];      // Per-iteration content text (for interleaving)
  toolCalls?: Array<{ name: string; detail: string; status: string }>;
  shellResults?: Array<{ command: string; output: string; success: boolean }>;
  filesModified?: string[];          // File paths modified during this turn
  model?: string;                    // 'deepseek-chat' or 'deepseek-reasoner'
  // User-only:
  files?: string[];                  // Attached file names
  timestamp: number;
}
```

## Render Pipeline

Located in [`VirtualMessageGatewayActor.ts`](../../media/actors/message-gateway/VirtualMessageGatewayActor.ts), method `handleLoadHistory()`.

### Rendering Order by Model

The rendering order differs by model to match the live streaming experience:

#### Reasoner Model (has `reasoning_iterations`)

```
for each reasoning iteration i:
  1. startThinkingIteration → updateThinkingContent → completeThinkingIteration
  2. If contentIterations[i] exists AND shell[i] follows: addTextSegment (inline)
  3. If shell[i] exists: createShellSegment → setShellResults

After iterations:
  4. filesModified → addPendingFile (status: 'applied')
  5. Remaining contentIterations → addTextSegment (the "real" response)
```

#### Chat Model (no reasoning)

```
  1. toolCalls → startToolBatch → updateTool × N → completeToolBatch
  2. filesModified → addPendingFile (status: 'applied')
  3. content → addTextSegment
```

### Fallback for Legacy Data

If `contentIterations` is not present (older saved data), the full accumulated `content` field is placed after all thinking/shell segments. This preserves backward compatibility.

## Live vs Restored: Key Differences

| Aspect | Live Streaming | Restored |
|---|---|---|
| Thinking bubbles | Animate token-by-token | Immediately complete, collapsed |
| Tool call badges | Show progress spinner | Static with final status |
| Shell segments | Show "Running..." then output | Show completed output |
| File modifications | Show pending/accept/reject UI | Show as 'applied' (read-only) |
| Text content | Streams token-by-token | Rendered all at once |
| Content interleaving | Handled by ContentBuffer | Handled by contentIterations |

## Troubleshooting

### No events in DB after conversation

Check that `StatementWrapper.run()` calls `onMutate()` → `scheduleSave()`. The sql.js database operates entirely in-memory; without explicit save triggers, data is lost on extension deactivation.

### Restored text appears in wrong order

Likely missing `contentIterations`. Check the `[HistorySave]` log for `contentIts=N` — if it shows `0` for a Reasoner conversation, the per-iteration content wasn't captured. The text will fall back to the accumulated `content` field placed at the end.

### File modifications missing from restore

Two possible causes:
1. **Chat model**: Check that `currentResponseFileChanges` is populated at save time (log: `[HistorySave] Recorded file modification: <path>`).
2. **Reasoner model**: Check sync tracking at code block detection point. The `applyCodeDirectlyForAutoMode()` is async — file paths must be tracked before it's called.

### Session switch shows nothing

Check `[loadSession]` logs for `found=true, view=true`. If the session is found but history is empty, the events may have been recorded to a different session ID. Cross-check `[HistorySave] Saving to session=<id>` with the session being loaded.

## Test Coverage

- **ConversationManager tests** (`tests/unit/events/ConversationManager.test.ts`): 19 test cases covering event grouping, `_file_modified` extraction, `contentIterations`, full Reasoner and Chat model integration.
- **Gateway restore tests** (`tests/actors/message-gateway/VirtualMessageGatewayActor.test.ts`): 7 test cases covering restore rendering order for Reasoner (interleaved), Chat (tools-first), file placement, legacy fallback, and empty history.

## Related Files

| File | Role |
|---|---|
| [`chatProvider.ts`](../../src/providers/chatProvider.ts) | Save pipeline + session loading |
| [`ConversationManager.ts`](../../src/events/ConversationManager.ts) | `RichHistoryTurn` type + `getSessionRichHistory()` |
| [`EventTypes.ts`](../../src/events/EventTypes.ts) | Event type definitions |
| [`EventStore.ts`](../../src/events/EventStore.ts) | Append-only event storage |
| [`SqlJsWrapper.ts`](../../src/events/SqlJsWrapper.ts) | Database wrapper with auto-save |
| [`VirtualMessageGatewayActor.ts`](../../media/actors/message-gateway/VirtualMessageGatewayActor.ts) | `handleLoadHistory()` restore renderer |
| [`VirtualListActor.ts`](../../media/actors/virtual-list/VirtualListActor.ts) | DOM rendering API |
