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
│  │ • getByType()   │      │ • prune()       │                                │
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

For long conversations, we can't send all events to the LLM (context window limits). Snapshots solve this by periodically summarizing events:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Snapshot Strategy                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Events Timeline                                                             │
│  ┌────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┐   │
│  │ E1 │ E2 │ E3 │ E4 │ E5 │ E6 │ E7 │ E8 │ E9 │E10 │E11 │E12 │E13 │E14 │   │
│  └────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┘   │
│       │                   │                   │                   │          │
│       └───────────────────┼───────────────────┼───────────────────┘          │
│                           │                   │                              │
│                           ▼                   ▼                              │
│                    ┌────────────┐      ┌────────────┐                        │
│                    │ Snapshot 1 │      │ Snapshot 2 │                        │
│                    │ (E1-E5)    │      │ (E6-E10)   │                        │
│                    └────────────┘      └────────────┘                        │
│                                                                              │
│  Building LLM Context                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │                                                                  │        │
│  │  Option A: Recent events only (small context)                   │        │
│  │  ├── E11, E12, E13, E14                                          │        │
│  │                                                                  │        │
│  │  Option B: Snapshot + recent events (medium context)            │        │
│  │  ├── Snapshot 2 summary                                          │        │
│  │  ├── E11, E12, E13, E14                                          │        │
│  │                                                                  │        │
│  │  Option C: Multiple snapshots + events (large context)          │        │
│  │  ├── Snapshot 1 summary                                          │        │
│  │  ├── Snapshot 2 summary                                          │        │
│  │  ├── E11, E12, E13, E14                                          │        │
│  │                                                                  │        │
│  └─────────────────────────────────────────────────────────────────┘        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Snapshot Content

```typescript
interface Snapshot {
  id: string;
  sessionId: string;
  upToSequence: number;      // Events 1..N are summarized
  createdAt: number;

  // Summarized content
  summary: string;           // Natural language summary
  keyFacts: string[];        // Important points extracted
  filesModified: string[];   // Files changed in this period
  tokenCount: number;        // Estimated tokens used
}
```

### Auto-Snapshot Configuration

```typescript
// Default: snapshot every 20 events, keep max 5 per session
const snapshotManager = new SnapshotManager(db, eventStore, summarizer, {
  snapshotInterval: 20,        // Events between snapshots
  maxSnapshotsPerSession: 5    // Old snapshots are pruned
});

// On every event append, check if snapshot needed
await snapshotManager.maybeCreateSnapshot(sessionId);
```

## Initialization

With @signalapp/sqlcipher, initialization is synchronous. The encryption key is retrieved asynchronously in `activate()` and passed to the constructor:

```typescript
// extension.ts
const dbKey = await getOrCreateEncryptionKey(context);
conversationManager = new ConversationManager(context, dbKey);  // fully sync
```

The constructor creates the Database, EventStore, SnapshotManager, and prepares all statements synchronously.

## File Locations

| File | Description |
|------|-------------|
| [src/events/ConversationManager.ts](../src/events/ConversationManager.ts) | Main API, session management, history restore |
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
