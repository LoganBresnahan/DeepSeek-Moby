# Chat Streaming Flow

This document details the complex flow from user input to AI response, including streaming, tool execution, and interleaved rendering.

## Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Complete Message Flow                         │
└─────────────────────────────────────────────────────────────────────┘

User Input
    │
    ▼
┌─────────┐     ┌─────────────┐     ┌──────────────┐
│ Webview │────▶│ Extension   │────▶│ DeepSeek API │
│         │     │ (Request    │     │              │
│         │     │ Orchestrator│     │              │
└─────────┘     └──────┬──────┘     └──────┬───────┘
                       │                    │
                       │◄───────────────────┘
                       │     SSE Stream
                       ▼
              ┌────────────────┐
              │  Parse Tokens  │
              │  Detect Tools  │
              │  Execute Shell │
              └────────┬───────┘
                       │
                       ▼
              ┌────────────────┐
              │ postMessage to │
              │    Webview     │
              └────────┬───────┘
                       │
                       ▼
              ┌────────────────┐
              │ Actor System   │
              │ Updates DOM    │
              └────────────────┘
```

## Phase 1: User Input

### Input Capture

```
User types in InputAreaShadowActor
              │
              ▼
    ┌─────────────────────┐
    │ onSend(content,     │
    │        attachments) │
    └──────────┬──────────┘
              │
              ▼
    ┌─────────────────────┐
    │ vscode.postMessage  │
    │ { type: 'sendMsg',  │
    │   message: content, │
    │   attachments }     │
    └─────────────────────┘
```

### Context Building (Extension Side)

```typescript
// RequestOrchestrator.handleMessage()
// Called by ChatProvider: this.requestOrchestrator.handleMessage(message, sessionId, editorContextProvider)
async handleMessage(message, currentSessionId, editorContextProvider) {
  // 1. Prepare session — clear turn tracking, record user message
  const sessionId = await this.prepareSession(message, currentSessionId);

  // 2. Build system prompt — edit mode, editor context, modified files, web search
  const systemPrompt = await this.buildSystemPrompt(editorContextProvider);

  // 3. Get conversation history + inject attachments + selected files
  const messages = await this.prepareMessages(sessionId, attachments);

  // 4. Token budget truncation via ContextBuilder
  const contextResult = await this.buildContext(messages, systemPrompt, sessionId);

  // 5. Tool loop (chat model) or streaming + shell loop (reasoner)
  // ...
}
```

## Phase 2: API Streaming

### SSE Connection

```
RequestOrchestrator                    DeepSeek API
     │                                      │
     │  POST /chat/completions              │
     │  { stream: true, messages: [...] }   │
     │─────────────────────────────────────▶│
     │                                      │
     │  HTTP 200 + SSE Stream               │
     │◀─────────────────────────────────────│
     │                                      │
     │  data: {"choices":[{"delta":...}]}   │
     │◀─────────────────────────────────────│
     │                                      │
     │  data: {"choices":[{"delta":...}]}   │
     │◀─────────────────────────────────────│
     │                                      │
     │  data: [DONE]                        │
     │◀─────────────────────────────────────│
```

### Token Processing

The DeepSeek API returns two separate content streams:

```typescript
// SSE chunk structure
{
  choices: [{
    delta: {
      reasoning_content: "...",  // Thinking (R1 reasoner only)
      content: "..."             // Regular response content
    }
  }]
}
```

These take **different paths** through the backend:

```
DeepSeek API
     │
     ├─── reasoning_content ───→ sendStreamReasoning() ───→ 'streamReasoning'
     │    (R1 thinking)           NO buffer, direct to webview
     │
     └─── content ─────────────→ ContentTransformBuffer ───→ 'streamToken'
          (regular response)      Filters <shell> tags
                                  Debounces partial patterns
```

```typescript
// In RequestOrchestrator.streamOneIteration()
for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta;

  if (delta.reasoning_content) {
    // Reasoner model thinking - direct path, emitted as event
    this._onStreamReasoning.fire({ token: delta.reasoning_content });
    // ChatProvider subscribes → postMessage('streamReasoning')
  }

  if (delta.content) {
    // Regular content - goes through ContentTransformBuffer
    this.contentBuffer.append(delta.content);
    // Buffer's onFlush callback fires _onStreamToken events
    // ChatProvider subscribes → postMessage('streamToken')
  }
}
```

### ContentTransformBuffer

**Location**: Backend ([src/utils/ContentTransformBuffer.ts](../src/utils/ContentTransformBuffer.ts))

The buffer prevents jarring UI transitions when special tags appear mid-stream:

```
Without buffer:
  Token: "Here's how to <shell>git status"  ← Raw tag briefly visible!
  Token: "</shell> shows your changes"

With buffer:
  Token: "Here's how to <shell>git status"  ← Held back (incomplete tag)
  Token: "</shell> shows your changes"      ← Complete! Extract & emit separately
  Emit: "Here's how to " (text)
  Emit: {type: 'shell', commands: ['git status']} (structured)
  Emit: " shows your changes" (text)
```

**Key design choices:**

| Choice | Rationale |
|--------|-----------|
| Lookahead pattern | Emit safe content immediately, only buffer potential tag starts like `<s` |
| 150ms fallback timer | Release held content if stream pauses (partial `<` that never completes) |
| Code blocks NOT filtered | ` ``` ` flows through to frontend markdown renderer |
| `<think>` tags filtered | Legacy pattern for non-R1 models; R1 uses `reasoning_content` instead |

**Why code blocks render inside thinking dropdowns:**

1. Thinking content arrives via `streamReasoning` (bypasses ContentTransformBuffer)
2. Frontend receives raw thinking text including ` ``` ` fences
3. ThinkingShadowActor passes content to markdown renderer
4. Markdown renderer handles code block syntax highlighting

This is **content-level mitigation**, not pub/sub optimization. It operates before tokens enter the actor system. See [REMINDER.md](../REMINDER.md#scalability--mitigations) for pub/sub level optimizations.

## Phase 3: Webview Message Handling

### Message Types During Streaming

```
Extension → Webview Messages:

┌─────────────────┬─────────────────────────────────────────┐
│ Message Type    │ Purpose                                 │
├─────────────────┼─────────────────────────────────────────┤
│ startResponse   │ Begin new stream, set reasoner mode     │
│ streamToken     │ Content chunk for display               │
│ streamReasoning │ Thinking content (reasoner model)       │
│ iterationStart  │ New thinking iteration                  │
│ shellExecuting  │ Shell commands detected                 │
│ shellResults    │ Command output                          │
│ toolCallsStart  │ Tool execution beginning                │
│ toolCallsUpdate │ Tool status change                      │
│ toolCallsEnd    │ Tool execution complete                 │
│ pendingFileAdd  │ File modification detected              │
│ diffListChanged │ Diff state updated                      │
│ endResponse     │ Stream complete                         │
└─────────────────┴─────────────────────────────────────────┘
```

### chat.ts Message Handler

```typescript
window.addEventListener('message', (event) => {
  const msg = event.data;

  switch (msg.type) {
    case 'startResponse':
      isStreaming = true;
      currentSegmentContent = '';
      hasInterleavedContent = false;
      streaming.startStream(msg.messageId, currentModel);
      break;

    case 'streamToken':
      // Check if tools/thinking interrupted
      if (message.needsNewSegment()) {
        message.resumeWithNewSegment();
        currentSegmentContent = '';
      }
      currentSegmentContent += msg.token;
      message.updateCurrentSegmentContent(currentSegmentContent);
      break;

    case 'streamReasoning':
      // Finalize text before thinking
      if (message.isStreaming() && !hasInterleavedContent) {
        message.finalizeCurrentSegment();
        hasInterleavedContent = true;
      }
      streaming.handleThinkingChunk(msg.token);
      break;
    // ... more cases
  }
});
```

## Phase 4: Interleaved Rendering

### The Interleaving Problem

Content doesn't arrive linearly:

```
Time →
  ├─ Text chunk 1
  ├─ Text chunk 2
  ├─ [Thinking starts]     ◄─ Need to finalize text
  ├─ Thinking chunk 1
  ├─ Thinking chunk 2
  ├─ [Thinking ends]
  ├─ Text chunk 3          ◄─ Need new segment!
  ├─ [Tools detected]      ◄─ Finalize text again
  ├─ Tool execution...
  ├─ Text chunk 4          ◄─ Another new segment
  └─ [Stream ends]
```

### Segment State Machine

```
                    ┌─────────────────┐
                    │   NO_SEGMENT    │
                    │  (initial)      │
                    └────────┬────────┘
                             │ startResponse
                             ▼
                    ┌─────────────────┐
         ┌────────▶│   STREAMING     │◀────────┐
         │         │ (active segment)│         │
         │         └────────┬────────┘         │
         │                  │                  │
         │   resumeWith     │  finalize        │
         │   NewSegment()   │  Segment()       │
         │                  ▼                  │
         │         ┌─────────────────┐         │
         │         │   NEEDS_NEW     │         │
         └─────────│   _SEGMENT      │─────────┘
                   └────────┬────────┘
                            │ endResponse
                            ▼
                   ┌─────────────────┐
                   │    COMPLETE     │
                   └─────────────────┘
```

### Code Flow

```typescript
// In MessageShadowActor

// When text arrives
updateCurrentSegmentContent(content: string) {
  if (!this.currentSegment) {
    this.currentSegment = this.createSegment();
  }
  this.renderToSegment(this.currentSegment, content);
}

// When tools/thinking interrupt
finalizeCurrentSegment(): boolean {
  if (this.currentSegment && this.isStreaming) {
    this.markSegmentComplete(this.currentSegment);
    this.needsNewSegment = true;
    this.currentSegment = null;
    return true;
  }
  return false;
}

// When text resumes after interruption
resumeWithNewSegment() {
  this.currentSegment = this.createSegment();
  this.needsNewSegment = false;
}
```

## Phase 5: Tool Detection & Execution

### Shell Command Detection

Reasoner models emit shell commands in XML tags:

```xml
<shell>
git status
npm run test
</shell>
```

**Inline execution (primary path):** Shell commands are detected by `ContentTransformBuffer` during streaming. Each `<shell>` tag is extracted, parsed with the heredoc-aware `parseShellCommands()`, and executed immediately — one command at a time, interleaved with surrounding text. Each command gets its own dropdown in the UI.

```typescript
// ContentTransformBuffer detects complete <shell>...</shell> tags
// and queues them for inline execution via onFlush callback
case 'shell':
  this._pendingInlineShellCommands.push(cmd);

// RequestOrchestrator.executeInlineShellCommands() processes the queue
// - Command approval check (may block for user input)
// - File watcher for detecting modifications
// - Results injected into context for next iteration
```

**Command approval:** Before executing each command, `commandApprovalManager.checkCommand()` is called synchronously. If the command needs approval (`'blocked'` or `'ask'`), the approval prompt is shown and the iteration loop blocks until the user decides. The `onFlush` pre-scan detects this synchronously and holds text segments in the same batch to prevent them from rendering while approval is pending.

**Iteration loop blocking:** After `streamChat` returns, the iteration loop checks `commandApprovalManager.hasPendingApproval()` and awaits it before starting the next iteration. This prevents iteration 2 from starting while a command from iteration 1 is still awaiting approval.

**Batch fallback path:** After streaming, `streamAndIterate()` also checks for shell commands in the full response text and runs any that weren't already handled inline (deduplication via `_inlineExecutedCommands` set).

### Tool Loop

```
┌─────────────────────────────────────────────────────────────────┐
│                          Tool Loop                               │
└─────────────────────────────────────────────────────────────────┘

                     ┌──────────────┐
                     │ API Response │
                     └──────┬───────┘
                            │
                            ▼
                    ┌───────────────┐
                    │ Has tool_use? │
                    └───────┬───────┘
                            │
               ┌────────────┴────────────┐
               │ Yes                     │ No
               ▼                         ▼
      ┌─────────────────┐       ┌─────────────────┐
      │ Execute Tools   │       │ Display Content │
      │ (read, write,   │       │ End Stream      │
      │  search, etc.)  │       └─────────────────┘
      └────────┬────────┘
               │
               ▼
      ┌─────────────────┐
      │ Append Results  │
      │ to Messages     │
      └────────┬────────┘
               │
               ▼
      ┌─────────────────┐
      │ Check Iteration │
      │ Limit           │
      └────────┬────────┘
               │
               ▼
      ┌─────────────────┐
      │ Call API Again  │─────────▶ (loop)
      └─────────────────┘
```

### Tool Execution Display

```
Webview shows:

┌────────────────────────────────────────┐
│ 🔧 Tool Calls                          │
│ ┌────────────────────────────────────┐ │
│ │ ✓ read_file                        │ │
│ │   src/utils/config.ts              │ │
│ ├────────────────────────────────────┤ │
│ │ ⟳ write_file                       │ │
│ │   src/utils/helper.ts              │ │
│ ├────────────────────────────────────┤ │
│ │ ○ search_files                     │ │
│ │   pattern: "*.test.ts"             │ │
│ └────────────────────────────────────┘ │
└────────────────────────────────────────┘

Status: ✓ done  ⟳ running  ○ pending  ✗ error
```

## Phase 6: Diff & Pending Files

### File Modification Flow

```
Tool: write_file(path, content)    Shell: cat >> file.txt << 'EOF'
              │                              │
              ▼                              ▼
     ┌────────────────────┐        ┌──────────────────┐
     │ Check editMode     │        │ FileSystemWatcher │
     │ (manual/ask/auto)  │        │ detects change    │
     └─────────┬──────────┘        │ (async, ~100ms)   │
               │                   └────────┬─────────┘
    ┌──────────┼──────────┐                 │
    │          │          │                 │
    ▼          ▼          ▼                 │
 manual      ask        auto               │
    │          │          │                 │
    └──────────┴──────────┘                 │
               │                            │
               ▼                            ▼
    ┌─────────────────────────────────────────────┐
    │ postMessage: diffListChanged                 │
    └─────────────────┬───────────────────────────┘
                      │
                      ▼
            ┌───────────────────┐
            │ Gateway: queued   │ ← During streaming, notifications
            │ or immediate?    │   are QUEUED to prevent splitting
            └────────┬──────────┘   text segments mid-word
                     │
         ┌───────────┴───────────┐
         │ Streaming active      │ Not streaming
         ▼                       ▼
  Queue in                Insert immediately
  _pendingFileNotifications  via addPendingFile()
         │
         │ Flush at natural break:
         │ - Next shell command
         │ - Iteration boundary
         │ - End of response
         ▼
  Insert via addPendingFile()
```

### File Notification Queuing

During live streaming, `diffListChanged` messages from the file watcher arrive asynchronously and can land in the middle of a text segment (e.g., splitting "I've" into "I" and "'ve"). To prevent this:

1. `VirtualMessageGatewayActor.handleDiffListChanged()` checks if streaming is active
2. If active, new file notifications are queued in `_pendingFileNotifications`
3. `flushPendingFileNotifications()` is called at natural break points:
   - `handleShellExecuting()` — before a new shell dropdown
   - `handleIterationStart()` — before a new thinking iteration
   - `handleEndResponse()` — before the stream finalizes

This ensures the Modified Files dropdown never interrupts flowing text. See [cqrs-webui.md](../plans/cqrs-webui.md) for the architectural context.

### Diff States

```
┌─────────┐     ┌─────────┐     ┌──────────┐
│ pending │────▶│ applied │     │ rejected │
└─────────┘     └─────────┘     └──────────┘
     │                               ▲
     └───────────────────────────────┘
```

## Phase 7: Post-Response Context Compression

After the response is fully streamed, saved, and diffs are processed, `RequestOrchestrator` checks context pressure and proactively creates a snapshot if needed. This runs **after** the response is delivered to the user, so there is zero user-visible latency.

### Flow

```
Phase 6 complete (diffs processed, response displayed)
         │
         ▼
RequestOrchestrator checks contextResult from Phase 2
         │
         ├─► usageRatio = tokenCount / budget
         │
         ├─► IF > 80% AND !hasFreshSummary():
         │   │
         │   ├─► _onSummarizationStarted.fire()
         │   │   └─► ChatProvider._summarizing = true
         │   │       └─► New user messages queued in _pendingMessages[]
         │   │           └─► Webview shows "Queued — optimizing context..."
         │   │
         │   ├─► conversationManager.createSnapshot(sessionId)
         │   │   └─► LLM summarizer: [prev summary] + [new events] → snapshot
         │   │
         │   └─► _onSummarizationCompleted.fire()
         │       └─► ChatProvider._summarizing = false
         │           └─► drainQueue() → process queued messages sequentially
         │
         └─► ELSE → no compression needed
```

### Key Points

- **Post-response sync:** Summarization happens AFTER `saveToHistory()`, not during streaming
- **Message queuing:** If the user sends a message while summarizing, it's queued and processed when summarization completes
- **Freshness guard:** `hasFreshSummary()` prevents redundant re-summarization (threshold: within 5 events)
- **Event bridge:** `onSummarizationStarted` / `onSummarizationCompleted` events connect RequestOrchestrator → ChatProvider

**Files:** `src/providers/requestOrchestrator.ts` (trigger), `src/providers/chatProvider.ts` (queuing), `src/events/SnapshotManager.ts` (summarizer)

## Timing Diagram

Complete flow with timestamps:

```
Time(ms)  Extension                 Webview                 DOM
────────────────────────────────────────────────────────────────────
   0      User clicks Send
          │
  10      │ handleUserMessage()
          │ build context
          │
  50      │ API request sent
          │
 100      │ startResponse ─────────▶ streaming.start()
          │                         message.prepare()
          │
 150      │ streamReasoning ───────▶ thinking.start()   ─▶ Thinking box
 160      │ streamReasoning ───────▶ thinking.append()  ─▶ Thinking grows
          │
 300      │ iterationStart ────────▶ flush queued files
          │                         finalize segment
          │
 350      │ streamToken ───────────▶ update segment     ─▶ Text appears
 360      │ streamToken ───────────▶ update segment     ─▶ More text
          │
 400      │ <shell> tag detected
          │ shellExecuting ────────▶ flush queued files
          │                         finalize segment
          │                         shell.start()       ─▶ Shell dropdown
          │ executeInlineShell()
          │   ├─ checkCommand()
          │   ├─ (if needs approval: block iteration loop)
          │   └─ execute command
          │
 410      │ File watcher fires
          │ diffListChanged ───────▶ QUEUED (streaming)  ─▶ (nothing yet)
          │
 450      │ streamToken ───────────▶ resumeWithNew()    ─▶ More text
          │                                                 (not split!)
          │
 500      │ <shell> tag detected
          │ shellExecuting ────────▶ flush queued files  ─▶ Modified Files
          │                         finalize segment        dropdown appears
          │                         shell.start()       ─▶ Shell dropdown
          │
 600      │ endResponse ───────────▶ flush queued files
          │                         streaming.end()
          │                         finalize all
────────────────────────────────────────────────────────────────────
```

## Error Handling

### Stream Interruption

```typescript
// User clicks Stop — ChatProvider delegates to orchestrator
case 'stopGeneration':
  this.requestOrchestrator.stopGeneration();
  break;

// RequestOrchestrator.stopGeneration()
stopGeneration(): void {
  this.abortController?.abort();
  this._onGenerationStopped.fire();
  // ChatProvider subscribes → postMessage('generationStopped')
}

// In webview
case 'generationStopped':
  isStreaming = false;
  streaming.endStream();
  // Clean up partial content
```

### API Errors

```typescript
// In RequestOrchestrator.handleMessage()
try {
  // ... streaming pipeline ...
} catch (error) {
  if (isAbortError(error, signal)) {
    await this.savePartialResponse(...);  // Save what we have
    return { sessionId };
  }
  this._onError.fire({ error: formatError(error) });
  // ChatProvider subscribes → postMessage('error')
}
```

## Debugging Tips

### Enable Logging

```typescript
// In chat.ts
console.log('[Frontend] streamToken:', msg.token.substring(0, 50));
console.log('[Frontend] segment state:', {
  currentSegmentContent: currentSegmentContent.length,
  hasInterleavedContent,
  needsNewSegment: message.needsNewSegment()
});
```

### State Inspection

```javascript
// Browser console
window.actors.message.getSegmentCount()
window.actors.streaming.isActive()
window.actorManager.getState('streaming.active')
```

### Common Issues

| Symptom | Likely Cause | Solution |
|---------|--------------|----------|
| Duplicate content | Not checking `hasInterleavedContent` | Check before finalizing |
| Missing continuation | `needsNewSegment` not set | Call `resumeWithNewSegment()` |
| Thinking in wrong place | Not finalizing before thinking | Call `finalizeCurrentSegment()` |
| Styles leaking | Light DOM used instead of Shadow | Use `ShadowActor` pattern |
| Text split mid-word by dropdown | Async notification (diffListChanged) arrives during text streaming | Queue in `_pendingFileNotifications`, flush at natural break points |
| Iteration continues during approval | `streamChat` doesn't await `onToken` callback | Check `commandApprovalManager.hasPendingApproval()` after `streamChat` returns |
| Approval widget reverts on scroll | Decision not persisted in VirtualListActor data | Call `resolveCommandApprovalByActorId()` from click handler to persist in turn data |
