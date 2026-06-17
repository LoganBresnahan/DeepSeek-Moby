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
    │ { type:'sendMessage'│
    │   message: content, │
    │   attachments }     │
    └─────────────────────┘
```

### Context Building (Extension Side)

```typescript
// RequestOrchestrator.handleMessage()
// Called by ChatProvider: this.requestOrchestrator.handleMessage(
//   data.message, this.currentSessionId, () => editorContext, data.attachments)
async handleMessage(message, currentSessionId, editorContextProvider, attachments?, options?) {
  // 1. Clear per-turn tracking, get-or-create session, record user message inline
  //    (createSession / recordUserMessage), begin structural event recording
  let sessionId = currentSessionId
    ?? (await this.conversationManager.createSession(message, ...)).id;

  // 2. Build system prompt — edit mode, editor context, modified files, web search
  const systemPrompt = await this.buildSystemPrompt(message, editorContextProvider);

  // 3. Token budget truncation via ContextBuilder (inside DeepSeekClient.buildContext),
  //    fed history messages + any latest snapshot summary
  const contextResult = await this.deepSeekClient.buildContext(
    historyMessages, systemPrompt, snapshotSummary);

  // 4. Tool loop (chat model) or streaming + shell loop (reasoner) via streamAndIterate()
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
     ├─── reasoning_content ───→ _onStreamReasoning.fire() ─→ 'streamReasoning'
     │    (R1 thinking)           NO buffer, direct to webview
     │
     └─── content ─────────────→ ContentTransformBuffer ───→ 'streamToken'
          (regular response)      Filters <shell> tags
                                  Debounces partial patterns
```

```typescript
// In RequestOrchestrator.streamAndIterate()
// The chunk loop lives in deepseekClient.streamChat(); the orchestrator
// receives tokens via the onToken / onReasoning callbacks it passes in.
// Signature: streamChat(messages, onToken, systemPrompt?, onReasoning?, options?)
await this.deepSeekClient.streamChat(
  currentHistoryMessages,
  async (token) => {
    // Regular content - goes through ContentTransformBuffer
    this.contentBuffer.append(token);
    // Buffer's onFlush callback fires _onStreamToken events
    // ChatProvider subscribes → postMessage('streamToken')
  },
  systemPrompt,
  (reasoningToken) => {
    // Reasoner model thinking - direct path, emitted as event
    this._onStreamReasoning.fire({ token: reasoningToken });
    // ChatProvider subscribes → postMessage('streamReasoning')
  },
  { signal }
);
```

### ContentTransformBuffer

**Location**: Backend ([src/utils/ContentTransformBuffer.ts](../../../src/utils/ContentTransformBuffer.ts))

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

**Why ` ``` ` fences appear inside thinking dropdowns as literal text:**

1. Thinking content arrives via `streamReasoning` (bypasses ContentTransformBuffer)
2. Frontend receives raw thinking text including ` ``` ` fences
3. `MessageTurnActor.renderThinkingGroup()` writes each step's content into the
   `.thinking-body` element via `escapeHtml()` — it is **not** run through markdown-it
4. So fenced code inside reasoning shows as escaped plain text, not a highlighted
   code block (only the assistant's regular response prose is markdown-rendered)

This is **content-level mitigation**, not pub/sub optimization. It operates before tokens enter the actor system. See [REMINDER.md](../../../REMINDER.md#scalability--mitigations) for pub/sub level optimizations.

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
│ diffListChanged │ Diff state updated (file modified)      │
│ endResponse     │ Stream complete                         │
└─────────────────┴─────────────────────────────────────────┘
```

### Message Router (VirtualMessageGatewayActor)

`chat.ts` itself does **not** listen for extension messages — it only wires up the
actors and exposes `window.actors` / `window.actorManager` for debugging. The single
extension→webview message router lives in `VirtualMessageGatewayActor`, which registers
one `window.addEventListener('message', ...)` listener and dispatches via `handleMessage()`.
Each message is converted into a **TurnEvent** appended to a per-turn log; a projector
derives render mutations (CQRS: *record event → projector produces mutations → render*).

```typescript
// media/actors/message-gateway/VirtualMessageGatewayActor.ts
private handleMessage(msg) {
  switch (msg.type) {
    case 'startResponse':
      // begin a new turn; set reasoner mode
      break;

    case 'streamToken':
      this.handleStreamToken(msg);
      // → emitTurnEvent(turnId, { type: 'text-append', content: token, ... })
      break;

    case 'streamReasoning':
      this.handleStreamReasoning(msg);
      // → emitTurnEvent(turnId, { type: 'thinking-start' / 'thinking-content', ... })
      break;
    // ... iterationStart, shellExecuting, shellResults, toolCalls*,
    //     diffListChanged, endResponse, etc.
  }
}

// emitTurnEvent appends to the turn log, runs the projector, and applies mutations:
private emitTurnEvent(turnId, event) {
  const index = this.getTurnLog(turnId).append(event);
  const mutations = this._projector.projectIncremental(this._currentViewSegments, event, index);
  this.applyMutations(turnId, mutations);  // → VirtualListActor renders
}
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

### Event-Log Projection (CQRS)

There is no imperative segment state machine and no `MessageShadowActor` — both were
retired in favor of a CQRS event-log model. Each incoming message becomes a `TurnEvent`
appended to a per-turn `TurnEventLog`, and `TurnProjector` derives an ordered
`ViewSegment[]` (the view model) that `VirtualListActor` renders.

Interleaving falls out of the projection rules — no manual `finalize`/`resume`
bookkeeping:

```
TurnEventLog (append-only)        TurnProjector → ViewSegment[]
───────────────────────────       ─────────────────────────────
text-append   "Text chunk 1"  ─→  [ text(complete=false) ]
text-append   "Text chunk 2"  ─→  [ text                 ]
thinking-start                ─→  [ text(complete=true), thinking ]   ◄ open text finalized
thinking-content ...          ─→  [ text, thinking(...)  ]
thinking-complete             ─→  [ text, thinking(complete) ]
text-append   "Text chunk 3"  ─→  [ ..., text(continuation=true) ]    ◄ new text segment
shell-start                   ─→  [ text(complete=true), ..., shell ] ◄ open text finalized
text-append   "Text chunk 4"  ─→  [ ..., text(continuation=true) ]    ◄ new text segment
file-modified                 ─→  [ ..., file-modified ]              ◄ appended, text NOT closed
```

### Code Flow

```typescript
// media/events/TurnProjector.ts — projectIncremental(segments, event, index)

// When a text token arrives: extend the open text segment, or start a new one.
case 'text-append': {
  const openText = this.findLastIncomplete(segments, 'text');
  if (openText) {
    openText.content += event.content;
    return [{ op: 'update', segmentIndex: segments.indexOf(openText), segment: openText }];
  }
  // No open text segment (e.g. after thinking/shell) — append a continuation segment
  const newSeg = { type: 'text', content: event.content, complete: false,
                   continuation: segments.some(s => s.type === 'text'), iteration: event.iteration };
  segments.push(newSeg);
  return [{ op: 'append', segment: newSeg }];
}

// When thinking/shell interrupt: finalize (complete=true) the open text segment,
// then append the new thinking/shell segment.
case 'thinking-start': {
  const lastText = this.findLastOfType(segments, 'text');
  const mutations = [];
  if (lastText && !lastText.complete) {
    lastText.complete = true;
    mutations.push({ op: 'update', segmentIndex: segments.lastIndexOf(lastText), segment: lastText });
  }
  // ... append the new thinking segment ...
  return mutations;
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

**Interrupt-and-resume (primary R1 path):** When `ContentTransformBuffer` detects a complete `<shell>...</shell>` tag during streaming, it fires its `onShellDetected` callback. For reasoner models the orchestrator wires this callback to **abort the HTTP stream** (`abortController.abort()`). `streamChat` throws an `AbortError`, which `streamAndIterate()` catches; it then parses the command (heredoc-aware `parseShellCommands()`), executes it, injects the result into history, and starts a **new** API call — resuming where R1 left off. The same logic also runs when the stream finishes naturally before the abort lands (the post-stream race handler).

```typescript
// ContentTransformBuffer.onShellDetected (reasoner only):
onShellDetected: (command) => {
  this._shellInterruptCommand = command;
  this._shellInterruptAborted = true;
  this.abortController?.abort();   // streamChat throws AbortError
}

// streamAndIterate() catch / post-stream handler:
// - parseShellCommands(`<shell>${command}</shell>`)
// - approval via commandApprovalManager.requestApproval() (awaited inline)
// - FileSystemWatcher detects modifications → diffManager.registerShellModifiedFiles()
// - inject "[Shell output]\n...\n[Continue]..." into currentHistoryMessages
// - continue the do/while loop (next iteration / API call)
```

**Command approval:** Before executing, `commandApprovalManager.checkCommand()` is called synchronously. If the command needs approval (decision other than `'allowed'`), approval is awaited **inline** via `await commandApprovalManager.requestApproval(command)` inside the interrupt handler, before results are injected and the loop continues — so iteration 2 cannot start while a command from iteration 1 is awaiting approval. (`onFlush` also runs a synchronous pre-scan that sets `_approvalPending` and holds text segments so they don't render while approval is pending.)

**Legacy / disabled paths:** An older inline-queue mechanism (`_pendingInlineShellCommands` + `executeInlineShellCommands()`) still exists in the file but is **not wired up** — it is being replaced by interrupt-and-resume and is never called. The post-streaming batch shell scan is likewise disabled for the streaming path (`hasShell = false`); interrupt-and-resume catches `<shell>` tags during streaming instead.

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
│ │ ○ find_files                     │ │
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
       ┌──────────────────────────────┐
       │ Gateway.handleDiffListChanged │ ← Appends a 'file-modified'
       │ (no streaming-active gate)    │   TurnEvent at the CURRENT
       └──────────────┬───────────────┘   stream position (append,
                      │                     not insertCausal — so it
                      ▼                     is NOT backdated behind
       ┌──────────────────────────────┐    the causing shell command)
       │ turnLog.append(file-modified) │
       │ + addPendingFile() immediately │ (skipped in 'manual' mode —
       └──────────────────────────────┘  diffs shown via VS Code tabs)
```

### File Notification Ordering

During live streaming, `diffListChanged` messages from the file watcher arrive asynchronously. `VirtualMessageGatewayActor.handleDiffListChanged()` does **not** queue them or gate on a streaming flag — it processes each diff immediately:

1. It dedupes against existing pending files (by `diffId` globally, then by `filePath` in the current turn).
2. For a genuinely new diff it `append`s a `file-modified` event to the turn log — **always `append`, never `insertCausal`** — so the file notification lands at the *current* stream position, matching where the dropdown renders live. Backdating it behind the causing shell command would split text that streamed between the shell command and the notification.
3. It then calls `virtualList.addPendingFile()` right away (skipped in `manual` mode, where diffs are surfaced via VS Code diff tabs rather than a webview dropdown).

Ordering correctness therefore comes from the append-only event-log semantics, not from a `_pendingFileNotifications` queue. See [cqrs-webui.md](../../plans/completed/cqrs-webui.md) for the architectural context.

### Diff States

The diagram shows the common subset. A pending file's `status` (`VirtualListActor.addPendingFile` / `updatePendingStatus`) actually has seven values: `pending`, `applied`, `rejected`, `superseded`, `error`, `deleted`, `expired`.

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
  10      │ handleMessage()
          │ build context
          │
  50      │ API request sent
          │
 100      │ startResponse ─────────▶ begin turn (new log)
          │                         streaming.start()
          │
 150      │ streamReasoning ───────▶ thinking-start event ─▶ Thinking box
 160      │ streamReasoning ───────▶ thinking-content     ─▶ Thinking grows
          │
 300      │ iterationStart ────────▶ thinking-complete    ─▶ iteration N
          │                         (open text closes)
          │
 350      │ streamToken ───────────▶ text-append event    ─▶ Text appears
 360      │ streamToken ───────────▶ text-append event    ─▶ More text
          │
 400      │ <shell> tag detected
          │ onShellDetected ───▶ abortController.abort()
          │   (streamChat throws AbortError; loop catches it)
          │ shellExecuting ────────▶ shell-start event    ─▶ Shell dropdown
          │   ├─ checkCommand()
          │   ├─ requestApproval() (awaited inline if needed)
          │   ├─ execute command + inject [Shell output]
          │   └─ new API call (resume)
          │
 410      │ File watcher fires
          │ diffListChanged ───────▶ file-modified event  ─▶ Modified Files
          │   (append at stream pos; manual mode skipped)    dropdown appears
          │
 450      │ streamToken ───────────▶ text-append event    ─▶ More text
          │                         (continuation segment)    (not split!)
          │
 500      │ <shell> tag detected (interrupt-and-resume again)
          │ shellExecuting ────────▶ shell-start event    ─▶ Shell dropdown
          │
 600      │ endResponse ───────────▶ streaming.end()
          │                         finalize turn log
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
  this._userInitiatedStop = true;          // catch block saves marker-only
  if (this.abortController) {
    this.abortController.abort();
    this.abortController = null;
    logger.apiAborted();
  }
  // Cancel any in-flight approval prompts so a blocked turn unblocks
  this.diffManager.cancelPendingApprovals();
  this.commandApprovalManager?.cancelPendingApproval();
  this._onGenerationStopped.fire();
  // ChatProvider subscribes → postMessage('generationStopped')
}

// In webview (VirtualMessageGatewayActor.handleMessage)
case 'generationStopped':
  this.handleGenerationStopped(msg.userStopped === true);
  break;
```

### API Errors

```typescript
// In RequestOrchestrator.handleMessage()
try {
  // ... streaming pipeline ...
} catch (error) {
  if (error.name === 'CanceledError' || error.name === 'AbortError' || signal.aborted) {
    // User/backend abort — save a marker (or partial for backend aborts) via
    // conversationManager.recordAssistantMessage(..., { status: 'interrupted' })
    return { sessionId };
  }
  // Other errors: error.message (enriched for context-length cases)
  this._onError.fire({ error: errorMessage });
  // ChatProvider subscribes → postMessage('error')
}
```

## Debugging Tips

### Enable Logging

```typescript
// In VirtualMessageGatewayActor.handleMessage() — every inbound message is logged:
log.debug('Received:', msg.type);
// And each rendered ViewSegment is logged in renderSegment():
log.debug(`[${turnId}] RENDER: ${this.summarizeSegment(segment)}`);
```

### State Inspection

```javascript
// Browser console (actors registered on window in chat.ts)
window.actors.streaming.isActive          // getter, not a method
window.actorManager.getState('streaming.active')
window.actors.virtualList.getTurn('<turnId>')
```

### Common Issues

| Symptom | Likely Cause | Solution |
|---------|--------------|----------|
| Missing continuation segment | `thinking-start`/`shell-start` event not finalizing the open text segment | Ensure the projector marks the open text `complete` so the next `text-append` starts a `continuation` segment |
| Thinking in wrong place | `thinking-start` event emitted at the wrong log position | Emit `thinking-start` before the first `thinking-content` (`handleStreamReasoning` defers it to the first reasoning token) |
| Styles leaking | Light DOM used instead of Shadow | Use the Shadow-DOM actor pattern |
| File notification backdated behind shell | Used `insertCausal` instead of `append` for `file-modified` | `handleDiffListChanged` always `append`s at the current stream position |
| Iteration continues during approval | Approval not awaited inside the interrupt handler | Approval is awaited inline via `commandApprovalManager.requestApproval()` before the loop continues |
| Approval widget reverts on scroll | Decision not persisted in VirtualListActor data | Call `resolveCommandApprovalByActorId()` from click handler to persist in turn data |
