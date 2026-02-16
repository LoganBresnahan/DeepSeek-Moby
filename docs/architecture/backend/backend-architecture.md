# Backend Architecture

The backend (VS Code extension) follows an **Event-Driven Coordinator pattern** where `ChatProvider` acts as a thin coordinator routing webview messages to focused manager classes. Each manager owns its state and emits typed `vscode.EventEmitter` events, which ChatProvider subscribes to and forwards to the webview.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         VS Code Extension (Node.js)                          │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                      ChatProvider (~960 lines)                          │ │
│  │                    (Coordinator + Webview Bridge)                        │ │
│  │                                                                         │ │
│  │  • Receive webview messages (onDidReceiveMessage) → delegate            │ │
│  │  • Subscribe to manager events → forward to webview (postMessage)       │ │
│  │  • Session lifecycle (currentSessionId, loadSession)                    │ │
│  │  • VS Code context gathering (getEditorContext, findRelatedFiles)       │ │
│  └───────────┬───────────────────────────────────────────────────────────┘ │
│              │ delegates to                                                  │
│  ┌───────────┴───────────────────────────────────────────────────────────┐ │
│  │                        Extracted Managers                               │ │
│  │                                                                         │ │
│  │ ┌─────────────────┐  ┌────────────────┐  ┌─────────────────────────┐  │ │
│  │ │ Request         │  │ DiffManager    │  │ WebSearchManager        │  │ │
│  │ │ Orchestrator    │  │                │  │                         │  │ │
│  │ │                 │  │ • Diff create  │  │ • Tavily search         │  │ │
│  │ │ • System prompt │  │ • Accept/reject│  │ • Cache + TTL           │  │ │
│  │ │ • Streaming     │  │ • Edit modes   │  │ • Toggle/settings       │  │ │
│  │ │ • Tool loop     │  │ • Superseding  │  └─────────────────────────┘  │ │
│  │ │ • Shell loop    │  │ • Tab mgmt     │                               │ │
│  │ │ • History save  │  └────────────────┘  ┌─────────────────────────┐  │ │
│  │ └─────────────────┘                      │ FileContextManager      │  │ │
│  │                       ┌────────────────┐ │                         │  │ │
│  │                       │ Settings       │ │ • File selection        │  │ │
│  │                       │ Manager        │ │ • Workspace search      │  │ │
│  │                       │                │ │ • Context injection     │  │ │
│  │                       │ • Read/write   │ └─────────────────────────┘  │ │
│  │                       │ • Model change │                               │ │
│  │                       │ • Sync webview │                               │ │
│  │                       └────────────────┘                               │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                          Service Layer                                   │ │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌───────────────────────┐   │ │
│  │  │  DeepSeekClient │  │  TavilyClient   │  │  ConversationManager  │   │ │
│  │  │  • HTTP/SSE     │  │  • Search API   │  │  • Event Sourcing     │   │ │
│  │  │  • Streaming    │  │                 │  │  • Session CRUD       │   │ │
│  │  │  • Tool calls   │  │                 │  │  • Context building   │   │ │
│  │  └─────────────────┘  └─────────────────┘  └───────────┬───────────┘   │ │
│  └────────────────────────────────────────────────────────┼───────────────┘ │
│                                                            │                 │
│  ┌─────────────────────────────────────────────────────────▼───────────────┐ │
│  │                       SQLite Database (via SQLCipher)                     │ │
│  │  • events table  • sessions table  • snapshots table                    │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                        Supporting Modules                                │ │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐     │ │
│  │  │ContentTransform │  │ WorkspaceTools  │  │ ReasonerShell       │     │ │
│  │  │Buffer           │  │                 │  │ Executor            │     │ │
│  │  │                 │  │ • read_file     │  │                     │     │ │
│  │  │ • Tag filtering │  │ • write_file    │  │ • <shell> parsing   │     │ │
│  │  │ • Lookahead     │  │ • search_files  │  │ • Command safety    │     │ │
│  │  │ • Debouncing    │  │ • list_dir      │  │ • Execution         │     │ │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────────┘     │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Design Pattern: Event-Driven Coordinator

The backend was refactored from a monolithic ~4,400 line ChatProvider into focused managers communicating via `vscode.EventEmitter`:

```
                    ┌──────────────────┐
                    │   ChatProvider   │
                    │  (Coordinator)   │
                    │                  │
                    │ • Message router │
                    │ • Event wiring   │
                    └────────┬─────────┘
                             │ subscribes to events from:
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ Request         │ │ DiffManager     │ │ WebSearch       │
│ Orchestrator    │ │                 │ │ Manager         │
│                 │ │ events:         │ │                 │
│ events:         │ │ diffListChanged │ │ events:         │
│ startResponse   │ │ codeApplied     │ │ onSearching     │
│ streamToken     │ │ diffClosed      │ │ onSearchComplete│
│ endResponse     │ │ warning         │ │ onToggled       │
│ toolCallsStart  │ │ editConfirm     │ └─────────────────┘
│ shellExecuting  │ └─────────────────┘
└─────────────────┘         ┌─────────────────┐
                            │ SettingsManager │
┌─────────────────┐         │                 │
│ FileContext      │         │ events:         │
│ Manager          │         │ settingsChanged │
│                 │         │ modelChanged    │
│ events:         │         │ settingsReset   │
│ onOpenFiles     │         └─────────────────┘
│ onSearchResults │
│ onFileContent   │
└─────────────────┘
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **`vscode.EventEmitter<T>`** | Typed events, disposal integration, already used by ConversationManager |
| **No custom EventBus** | ~5 classes with 3-7 events each — direct subscriptions are simpler |
| **Managers own their state** | No shared mutable state between managers |
| **Managers don't know about webview** | They emit events; ChatProvider bridges to postMessage |
| **Unidirectional dependencies** | Orchestrator → managers, never circular |

### Dependency Graph

```
ChatProvider (coordinator)
  ├── WebSearchManager         (independent)
  ├── FileContextManager       (independent)
  ├── DiffManager              (depends on: FileContextManager)
  ├── SettingsManager          (independent)
  └── RequestOrchestrator      (depends on: all managers + DeepSeekClient + ConversationManager)
```

### Event Wiring Pattern

```typescript
// ChatProvider.wireEvents() — subscribes to all manager events, forwards to webview
private wireEvents(): void {
  // Streaming events
  this.requestOrchestrator.onStartResponse(d => this.post('startResponse', d));
  this.requestOrchestrator.onStreamToken(d => this.post('streamToken', d));
  this.requestOrchestrator.onEndResponse(d => this.post('endResponse', d));

  // Diff events
  this.diffManager.onDiffListChanged(d => this.post('diffListChanged', d));
  this.diffManager.onCodeApplied(d => this.post('codeApplied', d));

  // ... ~25 total subscriptions
}

private post(type: string, data?: any): void {
  this._view?.webview.postMessage({ type, ...data });
}
```

## Request Lifecycle

### Phase 1: User Input

```
User types message in webview
         │
         ▼
InputAreaShadowActor.handleSubmit()
         │
         │ vscode.postMessage({
         │   type: 'sendMessage',
         │   message: 'fix the bug',
         │   attachments: [...]
         │ })
         │
         ▼
════════════════════════════════════
     postMessage Boundary
════════════════════════════════════
         │
         ▼
ChatProvider.onDidReceiveMessage()
         │
         │ switch (data.type) {
         │   case 'sendMessage':
         │     this.requestOrchestrator.handleMessage(...)
         │ }
         │
         ▼
```

### Phase 2: Context Building (RequestOrchestrator)

```
requestOrchestrator.handleMessage(message, sessionId, editorContextProvider)
         │
         ├─► prepareSession()
         │   • diffManager.clearProcessedBlocks()
         │   • fileContextManager.clearTurnTracking()
         │   • conversationManager.recordUserMessage(...)
         │
         ├─► buildSystemPrompt()
         │   • base prompt + model-specific instructions
         │   • diffManager.getModifiedFilesContext()
         │   • diffManager.currentEditMode → edit mode instructions
         │   • await editorContextProvider() (callback to ChatProvider)
         │   • webSearchManager.searchForMessage(message)
         │
         ├─► prepareMessages()
         │   • conversationManager.getSessionMessagesCompat()
         │   • inject fileContextManager.getSelectedFilesContext()
         │   • inject attachments
         │
         └─► buildContext()
             • ContextBuilder token budget truncation
             • snapshot injection if needed
```

### Phase 3: API Call & Streaming (RequestOrchestrator)

```
requestOrchestrator.streamAndIterate(messages, systemPrompt, signal)
         │
         │ Creates ContentTransformBuffer
         │ Sets diffManager.flushCallback
         │
         ▼
deepSeekClient.streamChat(...)
         │
         ├─► reasoning_content
         │   └─► _onStreamReasoning.fire({ token })
         │       → ChatProvider → postMessage('streamReasoning')
         │
         └─► content
             └─► contentBuffer.append(content)
                 └─► _onStreamToken.fire({ token })
                     → ChatProvider → postMessage('streamToken')
```

### Phase 4: Save & Tool Loop (RequestOrchestrator)

```
Stream ends
         │
         ├─► Chat model: runToolLoop() if tool_calls
         │   │
         │   └─► While hasToolCalls && iteration < max:
         │       • Execute tools (read_file, write_file, etc.)
         │       • _onToolCallsStart/Update/End.fire(...)
         │       • diffManager.handleAutoShowDiff() for apply_code_edit
         │       • Append results → call API again
         │
         ├─► Reasoner model: shell detection in streamAndIterate()
         │   │
         │   └─► If <shell> tags detected:
         │       • _onShellExecuting.fire(...)
         │       • Execute commands
         │       • _onShellResults.fire(...)
         │       • Inject results → stream again
         │
         ├─► finalizeResponse()
         │   • Flush buffer, strip DSML/shell tags
         │   • diffManager.detectAndProcessUnfencedEdits()
         │   • _onEndResponse.fire(...)
         │
         └─► saveToHistory()
             • conversationManager.recordReasoningContent()
             • conversationManager.recordToolCalls()
             • conversationManager.recordShellResults()
             • conversationManager.recordFileModifications()
             • conversationManager.recordAssistantMessage()
```

### Phase 5: Proactive Context Compression (RequestOrchestrator)

After `saveToHistory()`, the orchestrator checks context pressure and proactively summarizes if needed. This runs **post-response** so it adds zero user-visible latency.

```
saveToHistory() completes
         │
         ├─► usageRatio = contextResult.tokenCount / contextResult.budget
         │
         ├─► IF usageRatio > 80% AND !hasFreshSummary(sessionId):
         │   │
         │   ├─► _onSummarizationStarted.fire()
         │   │   └─► ChatProvider sets _summarizing = true (queues new messages)
         │   │
         │   ├─► conversationManager.createSnapshot(sessionId)
         │   │   └─► LLM summarizer: [previous summary] + [new events] → snapshot
         │   │
         │   └─► _onSummarizationCompleted.fire()
         │       └─► ChatProvider sets _summarizing = false, calls drainQueue()
         │
         └─► ELSE: no summarization needed (below threshold or fresh summary exists)
```

**Key files:**
- Trigger: `src/providers/requestOrchestrator.ts` (lines 334-361)
- Guard: `src/events/ConversationManager.ts` → `hasFreshSummary()`
- Summarizer: `src/events/SnapshotManager.ts` → `createLLMSummarizer()`, `createExtractSummarizer()`
- Queuing: `src/providers/chatProvider.ts` → `_summarizing`, `_pendingMessages`, `drainQueue()`

## Two Model Paths

The system supports two models with different tool execution strategies:

### Chat Model (deepseek-chat)

```
┌─────────────────────────────────────────────────────────────┐
│                    Native Tool Calling                       │
│                                                              │
│  API Response:                                               │
│  {                                                           │
│    finish_reason: 'tool_calls',                             │
│    tool_calls: [                                             │
│      {                                                       │
│        id: 'call_123',                                       │
│        function: {                                           │
│          name: 'read_file',                                  │
│          arguments: '{"path": "src/auth.ts"}'               │
│        }                                                     │
│      }                                                       │
│    ]                                                         │
│  }                                                           │
│                                                              │
│  Handled by: RequestOrchestrator.runToolLoop()               │
│  • Structured JSON arguments                                 │
│  • Parallel execution possible                               │
│  • Results formatted as tool_results                         │
└─────────────────────────────────────────────────────────────┘
```

### Reasoner Model (deepseek-reasoner / R1)

```
┌─────────────────────────────────────────────────────────────┐
│                    Shell Tag Execution                       │
│                                                              │
│  API Response (in content):                                  │
│  "Let me check the file structure.                          │
│                                                              │
│  <shell>                                                     │
│  ls -la src/                                                 │
│  cat src/auth.ts                                             │
│  </shell>                                                    │
│                                                              │
│  Based on what I find..."                                    │
│                                                              │
│  Handled by: RequestOrchestrator.streamAndIterate()          │
│  • Parsed from content text                                  │
│  • Sequential execution                                      │
│  • Results injected back into conversation                   │
│  • Auto-continuation if exploration but no code output       │
└─────────────────────────────────────────────────────────────┘
```

## State Management

### Event Sourcing Architecture

The conversation state uses **Event Sourcing** - all changes are stored as an append-only log of events:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         State Management                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ConversationManager                                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                                                                      │    │
│  │  currentSessionId: string | null                                     │    │
│  │  // Active conversation                                              │    │
│  │                                                                      │    │
│  │  EventStore (SQLite)                                                 │    │
│  │  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐                            │    │
│  │  │ E1  │→│ E2  │→│ E3  │→│ E4  │→│ E5  │→ ...                       │    │
│  │  └─────┘ └─────┘ └─────┘ └─────┘ └─────┘                            │    │
│  │  (append-only, immutable history)                                    │    │
│  │                                                                      │    │
│  │  SnapshotManager (LLM summarizer with chaining)                      │    │
│  │  ┌────────────────┐                                                  │    │
│  │  │ Snapshot 1     │  LLM summary of old events                       │    │
│  │  │ (E1-E20)       │  Triggered proactively at >80% context usage     │    │
│  │  └────────────────┘  hasFreshSummary() prevents re-triggering        │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  Manager Instance State (transient, distributed across managers)             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  DiffManager:                                                        │    │
│  │    activeDiffs: Map<diffId, DiffMetadata>                            │    │
│  │    editMode, processedCodeBlocks, fileEditCounts                     │    │
│  │                                                                      │    │
│  │  RequestOrchestrator:                                                │    │
│  │    abortController, contentBuffer (per-request lifecycle)            │    │
│  │                                                                      │    │
│  │  FileContextManager:                                                 │    │
│  │    selectedFiles, readFilesInTurn                                    │    │
│  │                                                                      │    │
│  │  WebSearchManager:                                                   │    │
│  │    searchCache, enabled, settings                                    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  Database File                                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  ~/.vscode/extensions/.../globalStorage/conversations.db             │    │
│  │                                                                      │    │
│  │  Tables:                                                             │    │
│  │  • sessions  - Session metadata                                      │    │
│  │  • events    - All conversation events                               │    │
│  │  • snapshots - Periodic summaries                                    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Benefits of Event Sourcing

| Feature | Benefit |
|---------|---------|
| **Immutable history** | Full audit trail, no lost data |
| **Event replay** | Reconstruct any past state |
| **Snapshots** | Compress old events for LLM context |
| **Forking** | Start new conversations from any point |
| **ACID transactions** | SQLite guarantees data integrity |

## File Locations

### Coordinator

| File | Responsibility |
|------|----------------|
| [src/providers/chatProvider.ts](../../../src/providers/chatProvider.ts) | Coordinator + webview bridge (~960 lines) |

### Extracted Managers

| File | Responsibility |
|------|----------------|
| [src/providers/requestOrchestrator.ts](../../../src/providers/requestOrchestrator.ts) | Request pipeline: handleUserMessage + runToolLoop + streaming |
| [src/providers/diffManager.ts](../../../src/providers/diffManager.ts) | Diff lifecycle, edit modes, tab management, superseding |
| [src/providers/webSearchManager.ts](../../../src/providers/webSearchManager.ts) | Web search state, caching, Tavily integration |
| [src/providers/fileContextManager.ts](../../../src/providers/fileContextManager.ts) | File selection, search, context injection |
| [src/providers/settingsManager.ts](../../../src/providers/settingsManager.ts) | Settings read/write/sync |
| [src/providers/types.ts](../../../src/providers/types.ts) | Shared event payload types |

### Service Layer

| File | Responsibility |
|------|----------------|
| [src/deepseekClient.ts](../../../src/deepseekClient.ts) | HTTP/SSE API client |
| [src/events/ConversationManager.ts](../../../src/events/ConversationManager.ts) | Event sourcing, sessions, context |
| [src/events/EventStore.ts](../../../src/events/EventStore.ts) | Append-only event storage |
| [src/events/SnapshotManager.ts](../../../src/events/SnapshotManager.ts) | Snapshot creation/retrieval |
| [src/events/SqlJsWrapper.ts](../../../src/events/SqlJsWrapper.ts) | SQLite via SQLCipher |
| [src/clients/tavilyClient.ts](../../../src/clients/tavilyClient.ts) | Tavily web search API client |

### Supporting Modules

| File | Responsibility |
|------|----------------|
| [src/tools/workspaceTools.ts](../../../src/tools/workspaceTools.ts) | Tool definitions & execution |
| [src/tools/reasonerShellExecutor.ts](../../../src/tools/reasonerShellExecutor.ts) | R1 shell command handling |
| [src/utils/ContentTransformBuffer.ts](../../../src/utils/ContentTransformBuffer.ts) | Streaming tag filter |
| [src/providers/commandProvider.ts](../../../src/providers/commandProvider.ts) | VS Code command handlers |
| [src/providers/completionProvider.ts](../../../src/providers/completionProvider.ts) | Inline completions |

## Comparison: Frontend vs Backend Architecture

| Aspect | Frontend (Webview) | Backend (Extension) |
|--------|-------------------|---------------------|
| **Pattern** | Actor Model | Event-Driven Coordinator |
| **Communication** | Pub/Sub (decentralized) | vscode.EventEmitter (typed events) |
| **State** | Distributed across actors | Distributed across managers + Event Sourcing |
| **Persistence** | None (transient) | SQLite database + context.secrets + globalState (see [Storage Overview](database-layer.md#extension-storage-overview)) |
| **Coordination** | EventStateManager routes | ChatProvider routes messages, subscribes to events |
| **Coupling** | Loose (actors independent) | Loose (managers independent, coordinator bridges) |

### Why Different Patterns?

**Frontend**: Many independent UI components that need to update without knowing about each other. Actor model provides isolation and prevents cascading complexity.

**Backend**: Linear request/response flow with clear phases. The coordinator pattern keeps message routing centralized while managers own their business logic independently. Event sourcing provides durability and replay.

## Error Handling

```
┌─────────────────────────────────────────────────────────────┐
│                    Error Handling Layers                     │
└─────────────────────────────────────────────────────────────┘

Layer 1: API Errors (RequestOrchestrator)
├─► Network failures → Retry with backoff
├─► Rate limits → Queue and retry
├─► Auth errors → Prompt for API key
└─► Invalid response → Log and notify user

Layer 2: Tool Errors (RequestOrchestrator.runToolLoop)
├─► File not found → Return error to LLM (it can adapt)
├─► Permission denied → Return error to LLM
├─► Timeout → Cancel and notify
└─► Shell blocked → Return blocked message to LLM

Layer 3: Stream Errors (RequestOrchestrator.streamAndIterate)
├─► Connection drop → Attempt resume or notify
├─► Parse error → Skip chunk, continue
└─► Timeout (30s) → Force end stream

Layer 4: Database Errors (ConversationManager)
├─► Encryption key error → Toast error message
├─► Write failure → Retry, then notify
└─► Corruption → Offer to reset

Layer 5: User Notification (ChatProvider → webview)
└─► postMessage({ type: 'error', message: '...' })
```

## Related Documentation

- [Event Sourcing](event-sourcing.md) - Detailed event sourcing architecture
- [Database Layer](database-layer.md) - SQLite/@signalapp/sqlcipher implementation
- [Message Bridge](../integration/message-bridge.md) - postMessage protocol details
- [Tool Execution](tool-execution.md) - Tool loop and shell commands
- [Chat Streaming](../integration/chat-streaming.md) - Token processing and ContentTransformBuffer
- [Diff Engine](../integration/diff-engine.md) - Code edit handling
- [ChatProvider Refactor Plan](../../plans/chatprovider-refactor.md) - Full refactor plan and history
