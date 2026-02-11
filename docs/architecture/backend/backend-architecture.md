# Backend Architecture

The backend (VS Code extension) follows a **Mediator/Orchestrator pattern** where `ChatProvider` coordinates all services. This contrasts with the frontend's decentralized Actor Model.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         VS Code Extension (Node.js)                          │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                         ChatProvider                                    │ │
│  │                      (THE ORCHESTRATOR)                                 │ │
│  │                                                                         │ │
│  │  Responsibilities:                                                      │ │
│  │  • Receive webview messages (onDidReceiveMessage)                       │ │
│  │  • Build context and system prompts                                     │ │
│  │  • Coordinate API calls                                                 │ │
│  │  • Process streaming responses                                          │ │
│  │  • Execute tools and shell commands                                     │ │
│  │  • Manage file diffs                                                    │ │
│  │  • Push updates to webview (postMessage)                                │ │
│  └──────────────────────────────┬─────────────────────────────────────────┘ │
│                                 │                                            │
│           ┌─────────────────────┼─────────────────────┐                      │
│           │                     │                     │                      │
│           ▼                     ▼                     ▼                      │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────────┐  │
│  │  DeepSeekClient │  │  TavilyClient   │  │  ConversationManager        │  │
│  │                 │  │  (Web Search)   │  │  (Event Sourcing)           │  │
│  │  • HTTP/SSE     │  │                 │  │                             │  │
│  │  • Streaming    │  │  • Search API   │  │  • Session CRUD             │  │
│  │  • Tool calls   │  │  • Caching      │  │  • Event recording          │  │
│  └─────────────────┘  └─────────────────┘  │  • Context building         │  │
│                                            │  • Snapshot management       │  │
│                                            └─────────────────────────────┘  │
│                                                         │                    │
│                                                         ▼                    │
│                                            ┌─────────────────────────────┐  │
│                                            │  SQLite Database            │  │
│                                            │  (via SQLCipher)          │  │
│                                            │                             │  │
│                                            │  • events table             │  │
│                                            │  • sessions table           │  │
│                                            │  • snapshots table          │  │
│                                            └─────────────────────────────┘  │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                        Supporting Modules                                ││
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐      ││
│  │  │ContentTransform │  │ WorkspaceTools  │  │ ReasonerShell       │      ││
│  │  │Buffer           │  │                 │  │ Executor            │      ││
│  │  │                 │  │ • read_file     │  │                     │      ││
│  │  │ • Tag filtering │  │ • write_file    │  │ • <shell> parsing   │      ││
│  │  │ • Lookahead     │  │ • search_files  │  │ • Command safety    │      ││
│  │  │ • Debouncing    │  │ • list_dir      │  │ • Execution         │      ││
│  │  └─────────────────┘  └─────────────────┘  └─────────────────────┘      ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────────────┘
```

## Design Pattern: Mediator

The backend uses a **Mediator pattern** (sometimes called Orchestrator in service contexts):

```
                    ┌─────────────────┐
                    │  ChatProvider   │
                    │   (Mediator)    │
                    └────────┬────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ DeepSeekClient  │ │ Conversation    │ │ TavilyClient    │
│  (Colleague)    │ │ Manager         │ │  (Colleague)    │
│                 │ │ (Colleague)     │ │                 │
└─────────────────┘ └─────────────────┘ └─────────────────┘

Key principle: Colleagues don't communicate directly.
All coordination goes through the Mediator.
```

### Why Mediator?

| Benefit | How It Applies |
|---------|----------------|
| **Single point of control** | ChatProvider orchestrates the entire request lifecycle |
| **Loose coupling** | DeepSeekClient doesn't know about ConversationManager |
| **Easy to trace** | Follow the flow through one file |
| **Centralized error handling** | Catch and handle errors in one place |

### Trade-offs

| Downside | Mitigation |
|----------|------------|
| ChatProvider is large (~3800 lines) | Extract methods, but keep orchestration central |
| Single point of failure | Comprehensive error handling |
| Can become a "god class" | Keep colleagues focused; mediator only coordinates |

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
         │     this.handleUserMessage(data)
         │ }
         │
         ▼
```

### Phase 2: Context Building

```
handleUserMessage(data)
         │
         ├─► conversationManager.addMessageToCurrentSession('user', content, { attachments })
         │   // Store user message as event
         │
         ├─► extractFileIntent(message)
         │   // Infer which files user wants to modify
         │   // e.g., "fix auth.ts" → ['src/auth.ts']
         │
         ├─► getEditorContext()
         │   // Current file, selection, workspace info
         │
         ├─► buildSystemPrompt(editMode, context)
         │   // Combine base prompt + edit mode instructions
         │   // + custom user instructions
         │
         ├─► tavilyClient.search(query)  // if web search enabled
         │   // Augment context with web results
         │
         └─► Build conversation history for API call
```

### Phase 3: API Call & Streaming

```
deepSeekClient.streamChat({
  messages: conversationHistory,
  tools: getToolDefinitions(),  // Chat model only
  stream: true
})
         │
         │ Opens HTTP connection to api.deepseek.com
         │ Receives SSE stream
         │
         ▼
for await (const chunk of stream) {
         │
         ├─► chunk.delta.reasoning_content
         │   │
         │   └─► sendStreamReasoning(content)
         │       // Direct to webview, no buffering
         │       // postMessage({ type: 'streamReasoning', token })
         │
         └─► chunk.delta.content
             │
             └─► contentBuffer.append(content)
                 │
                 ├─► onText(text)
                 │   // postMessage({ type: 'streamToken', token })
                 │
                 └─► onShell(commands)
                     // Execute and inject results
}
```

### Phase 4: Save & Tool Loop

```
Stream ends with finish_reason
         │
         ├─► conversationManager.recordAssistantMessage(content, model, reason)
         │   // Store assistant response as event
         │
         ├─► 'stop' ──────────────────► Done
         │
         └─► 'tool_calls' ────────────► Enter tool loop
                   │
                   ▼
         ┌─────────────────────────────────────────┐
         │            TOOL LOOP                     │
         │                                          │
         │  while (hasToolCalls && iteration < max) │
         │    │                                     │
         │    ├─► executeTools(toolCalls)           │
         │    │   // read_file, write_file, etc.    │
         │    │                                     │
         │    ├─► conversationManager.recordToolCall │
         │    │   conversationManager.recordToolResult│
         │    │                                     │
         │    ├─► appendResults(messages)           │
         │    │   // Tool results go back to LLM    │
         │    │                                     │
         │    └─► streamChat(messages) ◄────────────┤
         │        // Next iteration                 │
         │                                          │
         └─────────────────────────────────────────┘
```

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
│  Execution:                                                  │
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
│  Execution:                                                  │
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
│  │  SnapshotManager                                                     │    │
│  │  ┌────────────────┐                                                  │    │
│  │  │ Snapshot 1     │  Summary of old events                           │    │
│  │  │ (E1-E20)       │  for context compression                         │    │
│  │  └────────────────┘                                                  │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ChatProvider instance state (transient)                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  activeDiffs: Map<diffId, DiffMetadata>                              │    │
│  │  // Pending file changes awaiting accept/reject                      │    │
│  │                                                                      │    │
│  │  readFilesThisTurn: Set<string>                                      │    │
│  │  // Files LLM has read (prevents redundant reads)                    │    │
│  │                                                                      │    │
│  │  isStreaming: boolean                                                │    │
│  │  // Prevents concurrent requests                                     │    │
│  │                                                                      │    │
│  │  contentBuffer: ContentTransformBuffer                               │    │
│  │  // Stateful streaming buffer                                        │    │
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

| File | Responsibility |
|------|----------------|
| [src/providers/chatProvider.ts](../src/providers/chatProvider.ts) | Main orchestrator (~3800 lines) |
| [src/deepseekClient.ts](../src/deepseekClient.ts) | HTTP/SSE API client |
| [src/events/ConversationManager.ts](../src/events/ConversationManager.ts) | Event sourcing, sessions, context |
| [src/events/EventStore.ts](../src/events/EventStore.ts) | Append-only event storage |
| [src/events/SnapshotManager.ts](../src/events/SnapshotManager.ts) | Snapshot creation/retrieval |
| [src/events/SqlJsWrapper.ts](../src/events/SqlJsWrapper.ts) | SQLite via SQLCipher |
| [src/tools/workspaceTools.ts](../src/tools/workspaceTools.ts) | Tool definitions & execution |
| [src/tools/reasonerShellExecutor.ts](../src/tools/reasonerShellExecutor.ts) | R1 shell command handling |
| [src/utils/ContentTransformBuffer.ts](../src/utils/ContentTransformBuffer.ts) | Streaming tag filter |
| [src/providers/commandProvider.ts](../src/providers/commandProvider.ts) | VS Code command handlers |
| [src/providers/completionProvider.ts](../src/providers/completionProvider.ts) | Inline completions |

## Comparison: Frontend vs Backend Architecture

| Aspect | Frontend (Webview) | Backend (Extension) |
|--------|-------------------|---------------------|
| **Pattern** | Actor Model | Mediator/Orchestrator |
| **Communication** | Pub/Sub (decentralized) | Direct calls (centralized) |
| **State** | Distributed across actors | Event Sourcing (centralized) |
| **Persistence** | None (transient) | SQLite database |
| **Coordination** | EventStateManager routes | ChatProvider coordinates |
| **Coupling** | Loose (actors independent) | Tight (services depend on mediator) |

### Why Different Patterns?

**Frontend**: Many independent UI components that need to update without knowing about each other. Actor model provides isolation and prevents cascading complexity.

**Backend**: Linear request/response flow with clear phases. Mediator provides clear control flow and easier debugging. Event sourcing provides durability and replay.

## Error Handling

```
┌─────────────────────────────────────────────────────────────┐
│                    Error Handling Layers                     │
└─────────────────────────────────────────────────────────────┘

Layer 1: API Errors
├─► Network failures → Retry with backoff
├─► Rate limits → Queue and retry
├─► Auth errors → Prompt for API key
└─► Invalid response → Log and notify user

Layer 2: Tool Errors
├─► File not found → Return error to LLM (it can adapt)
├─► Permission denied → Return error to LLM
├─► Timeout → Cancel and notify
└─► Shell blocked → Return blocked message to LLM

Layer 3: Stream Errors
├─► Connection drop → Attempt resume or notify
├─► Parse error → Skip chunk, continue
└─► Timeout (30s) → Force end stream

Layer 4: Database Errors
├─► Encryption key error → Toast error message
├─► Write failure → Retry, then notify
└─► Corruption → Offer to reset

Layer 5: User Notification
└─► postMessage({ type: 'error', message: '...' })
```

## Related Documentation

- [Event Sourcing](event-sourcing.md) - Detailed event sourcing architecture
- [Database Layer](database-layer.md) - SQLite/@signalapp/sqlcipher implementation
- [Message Bridge](message-bridge.md) - postMessage protocol details
- [Tool Execution](tool-execution.md) - Tool loop and shell commands
- [Chat Streaming](chat-streaming.md) - Token processing and ContentTransformBuffer
- [Diff Engine](diff-engine.md) - Code edit handling
