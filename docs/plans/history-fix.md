# Fix Conversation History Persistence (#14 + #15)

> **Status: IMPLEMENTED** — All steps complete. See [History Persistence Guide](../guides/history-persistence.md) for the current architecture.

## Context

When restoring a conversation from history, only the raw text content survives. Reasoning (thinking), tool calls, shell executions, and file diffs are all lost. The irony: the infrastructure to store AND render all of this already exists — the problem is just two chokepoints where data is discarded.

**Chokepoint 1 — Save**: `chatProvider.ts:2127` calls `addMessageToCurrentSession({role, content})` which hardcodes `model='deepseek-chat'` and `finishReason='stop'`, discards reasoning, tool calls, shell results. The real `recordAssistantReasoning()`, `recordToolCall()`, `recordToolResult()` methods on ConversationManager exist but are **never called**.

**Chokepoint 2 — Restore**: `getSessionMessagesCompat()` queries only `user_message` + `assistant_message` event types, returns `{role, content}[]`. The webview's `handleLoadHistory()` receives this stripped data and can never render reasoning/tools even though VirtualListActor already supports it.

## Plan

### Step 1: Fix Save Pipeline (chatProvider.ts)

Replace the single `addMessageToCurrentSession()` call with granular event recording using existing ConversationManager methods.

**At the normal completion site (~line 2122-2131):**
```typescript
// Instead of addMessageToCurrentSession({role: 'assistant', content: fullContent})
if (this.currentSessionId && (cleanResponse || fullReasoning)) {
  // 1. Record reasoning iterations
  for (let i = 0; i < reasoningIterations.length; i++) {
    this.conversationManager.recordAssistantReasoning(reasoningIterations[i], i);
  }

  // 2. Record tool calls (from toolCallsForHistory + shellToolCalls)
  for (const tc of allToolCalls) {
    const toolCallId = `tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.conversationManager.recordToolCall(toolCallId, tc.name, { detail: tc.detail });
    this.conversationManager.recordToolResult(toolCallId, tc.detail, tc.status === 'done');
  }

  // 3. Record shell results with richer data
  for (const sr of shellResultsForHistory) {
    const shellCallId = `sh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.conversationManager.recordToolCall(shellCallId, 'shell', { command: sr.command });
    this.conversationManager.recordToolResult(shellCallId, sr.output, sr.success, sr.executionTimeMs);
  }

  // 4. Record the assistant message itself (with real model + finishReason)
  await this.conversationManager.recordAssistantMessage(
    cleanResponse, model, 'stop', undefined
  );
}
```

**At the partial/abort site (~line 2144-2155):**
Same pattern but with `finishReason: 'length'` or a new reason. Keep it simpler — just save reasoning iterations that completed + the partial content.

**Key detail**: The `allToolCalls` variable is already built at line 2118 but never used. We'll now actually use it. However, we should record shell results separately from non-shell tool calls since shell results have richer data (output, executionTimeMs). We'll split the loop: non-shell from `toolCallsForHistory`, shell from `shellResultsForHistory`.

### Step 2: New Rich Restore Method (ConversationManager.ts)

Add `getSessionRichHistory(sessionId)` that queries ALL relevant event types and groups them into "turns" for the webview.

```typescript
interface RichHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
  // Assistant-only fields:
  reasoning_content?: string;
  reasoning_iterations?: string[];
  toolCalls?: Array<{ name: string; detail: string; status: string }>;
  shellResults?: Array<{ command: string; output: string; success: boolean }>;
  model?: string;
  files?: string[];      // user attachments
  timestamp: number;
}
```

**Implementation**:
1. Query events by type: `['user_message', 'assistant_message', 'assistant_reasoning', 'tool_call', 'tool_result']` using existing `getEventsByType()`
2. Walk events in sequence order, grouping into turns:
   - `user_message` → new user turn
   - `assistant_reasoning` → accumulate into current assistant turn's reasoning
   - `tool_call` + `tool_result` → accumulate into current assistant turn's tools
   - `assistant_message` → finalize current assistant turn with content

**File**: [ConversationManager.ts](../../src/events/ConversationManager.ts) — add method after `getSessionMessagesCompat()` (~line 696)

### Step 3: Update Restore Senders (chatProvider.ts)

Update `loadCurrentSessionHistory()` and `loadSession()` to use the new rich history.

**`loadCurrentSessionHistory()` (~line 4142-4164)**:
```typescript
// Replace getSessionMessagesCompat with getSessionRichHistory
const history = await this.conversationManager.getSessionRichHistory(currentSession.id);
this._view.webview.postMessage({
  type: 'loadHistory',
  history  // Now contains reasoning, tools, shell, model, etc.
});
```

**`loadSession()` (~line 4166-4194)**: Same change.

### Step 4: Update Webview Receiver (VirtualMessageGatewayActor.ts)

Update `handleLoadHistory()` to render all segment types using existing VirtualListActor API.

**Current** (~line 755-786): Only renders text + checks `reasoning_content` (always undefined).

**New**:
```typescript
private handleLoadHistory(msg): void {
  // ... clear + reset (unchanged)

  history.forEach(m => {
    const turnId = `turn-${++this._messageCounter}`;

    if (m.role === 'user') {
      virtualList.addTurn(turnId, 'user', { files: m.files, timestamp: m.timestamp });
      virtualList.addTextSegment(turnId, m.content);
    } else if (m.role === 'assistant') {
      virtualList.addTurn(turnId, 'assistant', { model: m.model, timestamp: m.timestamp });

      // Reasoning iterations (thinking dropdowns)
      if (m.reasoning_iterations?.length) {
        for (const iteration of m.reasoning_iterations) {
          virtualList.startThinkingIteration(turnId);
          virtualList.updateThinkingContent(turnId, iteration);
          virtualList.completeThinkingIteration(turnId);
        }
      } else if (m.reasoning_content) {
        // Fallback for legacy single-blob reasoning
        virtualList.startThinkingIteration(turnId);
        virtualList.updateThinkingContent(turnId, m.reasoning_content);
        virtualList.completeThinkingIteration(turnId);
      }

      // Text content
      if (m.content) {
        virtualList.addTextSegment(turnId, m.content);
      }

      // Tool calls (read-only summary badges)
      if (m.toolCalls?.length) {
        virtualList.startToolBatch(turnId, m.toolCalls.map(tc => ({
          name: tc.name,
          detail: tc.detail,
          status: tc.status
        })));
        virtualList.completeToolBatch(turnId);
      }

      // Shell results
      if (m.shellResults?.length) {
        const commands = m.shellResults.map(sr => ({
          command: sr.command,
          output: sr.output,
          status: sr.success ? 'done' as const : 'error' as const
        }));
        virtualList.createShellSegment(turnId, commands);
      }
    }
  });
}
```

**Note**: Tool calls and shell results render as **read-only summaries** — no re-execution, no pending state. Just badges showing what happened.

### Step 5: Define the RichHistoryTurn type

Define the `RichHistoryTurn` interface in `ConversationManager.ts` (or a nearby types file). This type will be used by:
- `getSessionRichHistory()` return type
- `chatProvider.ts` when sending to webview
- `VirtualMessageGatewayActor.ts` when receiving (define a local mirror, no cross-import)

### Step 6: Tests

1. **ConversationManager tests**: Test `getSessionRichHistory()`:
   - Empty session returns `[]`
   - User-only messages group correctly
   - Assistant message with reasoning iterations groups correctly
   - Tool calls pair with results and attach to correct turn
   - Mixed conversation with multiple turns preserves order
   - Shell results (tool_call with name='shell') group into shellResults

2. **Existing tests**: Verify all 1,109 tests still pass (save changes are additive, restore changes affect gateway actor)

## Files to Modify

| File | Change |
|------|--------|
| [chatProvider.ts](../../src/providers/chatProvider.ts) | Replace `addMessageToCurrentSession()` with granular `record*()` calls at both save sites; update `loadCurrentSessionHistory()` and `loadSession()` to use rich history |
| [ConversationManager.ts](../../src/events/ConversationManager.ts) | Add `RichHistoryTurn` interface + `getSessionRichHistory()` method |
| [VirtualMessageGatewayActor.ts](../../media/actors/message-gateway/VirtualMessageGatewayActor.ts) | Update `handleLoadHistory()` to render reasoning, tools, shell segments |
| [ConversationManager.test.ts](../../tests/unit/events/ConversationManager.test.ts) | Add tests for `getSessionRichHistory()` |

## Existing Code to Reuse

- `ConversationManager.recordAssistantReasoning()` — line 415
- `ConversationManager.recordToolCall()` — line 430
- `ConversationManager.recordToolResult()` — line 450
- `ConversationManager.recordAssistantMessage()` — line 383
- `EventStore.getEventsByType()` — line 176 (accepts array of types)
- `VirtualListActor.startThinkingIteration()`, `.updateThinkingContent()`, `.completeThinkingIteration()`
- `VirtualListActor.startToolBatch()`, `.completeToolBatch()`
- `VirtualListActor.createShellSegment()`
- `VirtualListActor.addTextSegment()`

## Verification

1. **Unit tests**: `npx vitest run` — all tests pass
2. **Manual test — save**: Start a conversation that triggers reasoning + shell execution, check DB events with Export Logs to verify reasoning/tool/shell events are recorded
3. **Manual test — restore**: Close and reopen the webview (or switch sessions), verify reasoning dropdowns, tool badges, and shell segments render on restore
4. **Manual test — partial save**: Stop generation mid-stream, reopen — partial content should still show with reasoning that completed
