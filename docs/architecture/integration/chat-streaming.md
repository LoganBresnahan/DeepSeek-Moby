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
│         │     │ (ChatProv.) │     │              │
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
// ChatProvider.handleUserMessage()
async handleUserMessage(message: string) {
  // 1. Build context
  const context = await this.getEditorContext();
  const selectedFiles = this.getSelectedFilesContext();
  const modifiedFiles = this.getModifiedFilesContext();

  // 2. Record user message as event (Event Sourcing)
  await this.conversationManager.recordUserMessage(message, attachments);

  // 3. Get conversation history for API
  const sessionMessages = await this.conversationManager.getSessionMessagesCompat();

  // 4. Build API request
  const messages = this.buildMessages(context, sessionMessages);

  // 5. Start streaming
  this.streamResponse(messages);
}
```

## Phase 2: API Streaming

### SSE Connection

```
ChatProvider                           DeepSeek API
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
// For each SSE chunk
for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta;

  if (delta.reasoning_content) {
    // Reasoner model thinking - direct path, no buffering
    this.sendStreamReasoning(delta.reasoning_content);
  }

  if (delta.content) {
    // Regular content - goes through ContentTransformBuffer
    this.contentBuffer.append(delta.content);
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

Detection in ChatProvider:

```typescript
const shellMatch = content.match(/<shell>([\s\S]*?)<\/shell>/);
if (shellMatch) {
  const commands = this.parseShellCommands(shellMatch[1]);
  await this.executeShellCommands(commands);
}
```

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
Tool: write_file(path, content)
              │
              ▼
     ┌────────────────────┐
     │ Check editMode     │
     │ (manual/ask/auto)  │
     └─────────┬──────────┘
               │
    ┌──────────┼──────────┐
    │          │          │
    ▼          ▼          ▼
 manual      ask        auto
    │          │          │
    ▼          ▼          ▼
 Create     Create     Apply
 diff &     diff &     directly
 wait       prompt
    │          │          │
    └──────────┴──────────┘
               │
               ▼
    ┌─────────────────────┐
    │ postMessage:        │
    │ pendingFileAdd      │
    │ diffListChanged     │
    └─────────────────────┘
               │
               ▼
    ┌─────────────────────┐
    │ PendingChanges      │
    │ ShadowActor updates │
    └─────────────────────┘
```

### Diff States

```
┌─────────┐     ┌─────────┐     ┌──────────┐
│ pending │────▶│ applied │     │ rejected │
└─────────┘     └─────────┘     └──────────┘
     │                               ▲
     └───────────────────────────────┘
```

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
 150      │ streamToken ───────────▶ update segment     ─▶ Text appears
 160      │ streamToken ───────────▶ update segment     ─▶ More text
 170      │ streamToken ───────────▶ update segment
          │
 200      │ streamReasoning ───────▶ finalize segment   ─▶ Text frozen
          │                         thinking.start()    ─▶ Thinking box
 210      │ streamReasoning ───────▶ thinking.append()  ─▶ Thinking grows
          │
 300      │ iterationEnd
          │ streamToken ───────────▶ needsNewSegment!
          │                         resumeWithNew()     ─▶ New text area
          │
 400      │ shellExecuting ────────▶ finalize segment
          │                         shell.start()       ─▶ Shell box
 450      │ shellResults ──────────▶ shell.complete()   ─▶ Results shown
          │
 500      │ streamToken ───────────▶ resumeWithNew()    ─▶ More text
          │
 600      │ endResponse ───────────▶ streaming.end()
          │                         finalize all
────────────────────────────────────────────────────────────────────
```

## Error Handling

### Stream Interruption

```typescript
// User clicks Stop
case 'stopGeneration':
  this.abortController?.abort();
  this.sendMessage({ type: 'generationStopped' });
  break;

// In webview
case 'generationStopped':
  isStreaming = false;
  streaming.endStream();
  // Clean up partial content
```

### API Errors

```typescript
try {
  await this.streamResponse(messages);
} catch (error) {
  if (error.name === 'AbortError') {
    // User cancelled - already handled
  } else {
    this.sendError(`API Error: ${error.message}`);
  }
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
