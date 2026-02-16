# Event Sourcing Architecture

The conversation management system uses **Event Sourcing** to provide an immutable, replayable history of all conversation interactions.

## Overview

Instead of storing mutable state (like a list of messages), we store an append-only log of **events** that describe what happened. The current state is derived by replaying these events.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Event Sourcing vs Traditional                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Traditional (Mutable State)          Event Sourcing (Immutable Log)        │
│  ┌─────────────────────────┐          ┌─────────────────────────────────┐   │
│  │  session: {             │          │  events: [                      │   │
│  │    messages: [          │          │    { type: 'session_created' }, │   │
│  │      { user: "hi" },    │ ──vs──►  │    { type: 'user_message',      │   │
│  │      { asst: "hello" }  │          │      content: "hi" },           │   │
│  │    ]                    │          │    { type: 'assistant_message', │   │
│  │  }                      │          │      content: "hello" }         │   │
│  └─────────────────────────┘          │  ]                              │   │
│                                        └─────────────────────────────────┘   │
│  ✗ State is mutated                   ✓ Events are immutable                │
│  ✗ History is lost                    ✓ Full history preserved              │
│  ✗ Can't replay                       ✓ Can replay to any point             │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Component Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          ConversationManager                                 │
│                         (Primary Entry Point)                                │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                                                                      │    │
│  │   recordUserMessage()    recordAssistantMessage()   createSession()  │    │
│  │   recordToolCall()       recordToolResult()         deleteSession()  │    │
│  │   recordDiffCreated()    recordDiffAccepted()       switchSession()  │    │
│  │   addMessageToCurrentSession()   getAllSessions()   getSession()     │    │
│  │                                                                      │    │
│  └──────────────────────────────────┬──────────────────────────────────┘    │
│                                     │                                        │
│           ┌─────────────────────────┼─────────────────┐                      │
│           │                         │                                        │
│           ▼                         ▼                                        │
│  ┌─────────────────┐      ┌─────────────────┐                                │
│  │   EventStore    │      │ SnapshotManager │                                │
│  │                 │      │                 │                                │
│  │ • append()      │      │ • createSnapshot│                                │
│  │ • getEvents()   │◄─────│ • getLatest()   │                                │
│  │ • getByType()   │      │ • deleteSession │                                │
│  └────────┬────────┘      └────────┬────────┘                                │
│           │                        │                                         │
│           └────────────────────────┘                                         │
│                                    │                                         │
│                                    ▼                                         │
│                         ┌─────────────────────┐                              │
│                         │  SQLite Database    │                              │
│                         │  (@signalapp/       │                              │
│                         │   sqlcipher)        │                              │
│                         │  • events table     │                              │
│                         │  • sessions table   │                              │
│                         │  • snapshots table  │                              │
│                         └─────────────────────┘                              │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Event Types

Events are strongly typed and capture all conversation interactions:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Event Type Hierarchy                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Base Event (all events have)                                                │
│  ┌────────────────────────────────────────┐                                 │
│  │  id: string          // UUID           │                                 │
│  │  sessionId: string   // Session UUID   │                                 │
│  │  sequence: number    // Auto-increment │                                 │
│  │  timestamp: number   // Unix ms        │                                 │
│  │  type: EventType     // Discriminator  │                                 │
│  └────────────────────────────────────────┘                                 │
│                                                                              │
│  Message Events                                                              │
│  ├── user_message        { content, attachments? }                          │
│  ├── assistant_message   { content, model, finishReason, usage? }           │
│  └── assistant_reasoning { content, iteration }                             │
│                                                                              │
│  Tool Events                                                                 │
│  ├── tool_call           { toolCallId, toolName, arguments }                │
│  └── tool_result         { toolCallId, result, success, duration? }         │
│                                                                              │
│  File Events                                                                 │
│  ├── file_read           { filePath, contentHash, lineCount }               │
│  ├── diff_created        { diffId, filePath, original, new }                │
│  ├── diff_accepted       { diffId }                                          │
│  └── diff_rejected       { diffId }                                          │
│                                                                              │
│  Session Events                                                              │
│  ├── session_created     { title, model }                                    │
│  └── session_renamed     { oldTitle, newTitle }                              │
│                                                                              │
│  Other                                                                       │
│  ├── web_search          { query, resultCount, resultsPreview }             │
│  └── error               { errorType, message, recoverable }                 │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Snapshots: Context Compression

For long conversations, we can't send all events to the LLM (128K context window). Snapshots solve this by summarizing events into compact summaries that ContextBuilder injects when older messages are dropped.

### Trigger: Proactive Context Pressure

Snapshots are **not** created on every event append. Instead, `RequestOrchestrator` checks context usage after each response:

```
Response saved to history
         │
         ▼
   usageRatio = tokenCount / budget
         │
         ├─► > 80% AND !hasFreshSummary()
         │       │
         │       ├─► _onSummarizationStarted.fire()
         │       ├─► conversationManager.createSnapshot(sessionId)
         │       └─► _onSummarizationCompleted.fire()
         │
         └─► ≤ 80% OR hasFreshSummary() → skip
```

- **File:** `src/providers/requestOrchestrator.ts` (lines 334-361)
- **Threshold:** 80% context usage
- **Guard:** `hasFreshSummary()` prevents re-triggering if the latest snapshot covers within 5 events of the current sequence

### Summarizer Strategy: LLM with Chaining

Two summarizer implementations are available (`src/events/SnapshotManager.ts`):

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    LLM Summarizer (createLLMSummarizer)                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  First snapshot:                                                             │
│  ┌────────────────────────────────────────────────────────┐                 │
│  │  [all events E1..EN] ──► LLM ──► Snapshot 1            │                 │
│  └────────────────────────────────────────────────────────┘                 │
│                                                                              │
│  Subsequent snapshots (chaining):                                            │
│  ┌────────────────────────────────────────────────────────┐                 │
│  │  [Snapshot 1 summary] + [new events EN+1..EM]          │                 │
│  │        ──► LLM ──► Snapshot 2                          │                 │
│  └────────────────────────────────────────────────────────┘                 │
│                                                                              │
│  Bounded input: O(1) per cycle — only previous summary + delta events       │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                  Extractive Summarizer (createExtractSummarizer)              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  No LLM needed — extracts key facts, user topics, and file modifications    │
│  from events using pattern matching. Used as fallback.                       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

Both implement `SummarizerFn`:
```typescript
type SummarizerFn = (events: ConversationEvent[], previousSummary?: string) => Promise<SnapshotContent>;
```

The `SummarizerChatFn` interface keeps the events module dependency-free from `DeepSeekClient`:
```typescript
interface SummarizerChatFn {
  (messages: Array<{ role: string; content: string }>, systemPrompt?: string,
   options?: { maxTokens?: number; temperature?: number }): Promise<{ content: string }>;
}
```

### Snapshot Content

```typescript
interface Snapshot {
  id: string;
  sessionId: string;
  upToSequence: number;      // Events 1..N are summarized
  timestamp: number;

  // Summarized content
  summary: string;           // Natural language summary
  keyFacts: string[];        // Important points extracted
  filesModified: string[];   // Files changed in this period
  tokenCount: number;        // Estimated tokens used
}
```

### Snapshot Configuration

```typescript
// Default: snapshot every 20 events
const snapshotManager = new SnapshotManager(db, eventStore, summarizer, {
  snapshotInterval: 20         // Events between snapshots
});
```

### Message Queuing During Summarization

When the proactive trigger fires, ChatProvider queues any incoming user messages until summarization completes:

```
User sends message during summarization
         │
         ├─► _summarizing === true
         │       └─► Push to _pendingMessages[]
         │           └─► Show "Queued — optimizing context..."
         │
         └─► Summarization completes
                 └─► drainQueue() processes pending messages sequentially
```

- **File:** `src/providers/chatProvider.ts` (lines 27-28, 280-294, 590-603)

## Initialization

With @signalapp/sqlcipher, initialization is synchronous. The encryption key is retrieved asynchronously in `activate()` and passed to the constructor:

```typescript
// extension.ts
const dbKey = await getOrCreateEncryptionKey(context);
conversationManager = new ConversationManager(context, dbKey);  // fully sync
```

The constructor performs the following sequence:
1. Creates `Database` (sets `PRAGMA foreign_keys = ON`)
2. Runs `runMigrations(db)` — single source of truth for all schema (v1: tables, v2: FK constraints)
3. Creates `EventStore` and `SnapshotManager` (prepared statements only)
4. Prepares session statements and loads the last active session

FK constraints with `ON DELETE CASCADE` mean deleting a session automatically removes its events and snapshots. Delete operations (`deleteSession`, `clearAllSessions`) are wrapped in transactions for atomicity.

## File Locations

| File | Description |
|------|-------------|
| [src/events/ConversationManager.ts](../src/events/ConversationManager.ts) | Main API, session management, history restore |
| [src/events/migrations.ts](../src/events/migrations.ts) | Schema migrations (single source of truth for all DDL) |
| [src/events/EventStore.ts](../src/events/EventStore.ts) | Append-only event storage with SQLite |
| [src/events/EventTypes.ts](../src/events/EventTypes.ts) | TypeScript types for all events |
| [src/events/SnapshotManager.ts](../src/events/SnapshotManager.ts) | Snapshot creation and retrieval |
| [src/events/SqlJsWrapper.ts](../src/events/SqlJsWrapper.ts) | Database wrapper (@signalapp/sqlcipher) |
| [src/events/index.ts](../src/events/index.ts) | Public exports |

## Usage Examples

### Recording Messages

```typescript
// Record events via addMessageToCurrentSession
conversationManager.addMessageToCurrentSession('user', 'Fix the authentication bug');
conversationManager.addMessageToCurrentSession('assistant', 'I\'ll help you fix that.', {
  model: 'deepseek-chat',
  finishReason: 'stop'
});
```

## Benefits of This Architecture

| Benefit | Description |
|---------|-------------|
| **Auditability** | Complete history of every interaction |
| **Debugging** | Replay events to reproduce issues |
| **Context Management** | Snapshots prevent context window overflow |
| **Flexibility** | Fork, branch, and import conversations |
| **Durability** | SQLite provides ACID guarantees |
| **Performance** | Prepared statements for fast queries |

## History Restore

Events are replayed into rich conversation turns via `getSessionRichHistory()` in ConversationManager. This method groups events by turn (user message → assistant response) and produces `RichHistoryTurn` objects containing reasoning iterations, tool calls, shell results, file modifications, and per-iteration content text.

The webview's `handleLoadHistory()` renders these turns using the VirtualListActor API, with segment ordering that matches the live streaming experience (e.g., Reasoner: thinking → content → shell; Chat: tools → files → text).

For full details, see the **[History Persistence Guide](../../guides/history-persistence.md)**.

## Related Documentation

- [Database Layer](database-layer.md) - SQLite implementation details
- [Backend Architecture](backend-architecture.md) - How ChatProvider uses ConversationManager
- [Message Bridge](message-bridge.md) - How events flow to/from the webview
- [History Persistence Guide](../../guides/history-persistence.md) - Full save → restore → render flow
