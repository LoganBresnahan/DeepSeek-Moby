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
│  │   buildLLMContext()      getAllSessions()           getSession()     │    │
│  │                                                                      │    │
│  └──────────────────────────────────┬──────────────────────────────────┘    │
│                                     │                                        │
│           ┌─────────────────────────┼─────────────────────────┐              │
│           │                         │                         │              │
│           ▼                         ▼                         ▼              │
│  ┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐      │
│  │   EventStore    │      │ SnapshotManager │      │ ContextBuilder  │      │
│  │                 │      │                 │      │                 │      │
│  │ • append()      │      │ • createSnapshot│      │ • buildForLLM() │      │
│  │ • getEvents()   │◄─────│ • getLatest()   │      │ • tokenBudget   │      │
│  │ • getByType()   │      │ • prune()       │      │ • compress()    │      │
│  └────────┬────────┘      └────────┬────────┘      └────────┬────────┘      │
│           │                        │                        │                │
│           └────────────────────────┼────────────────────────┘                │
│                                    │                                         │
│                                    ▼                                         │
│                         ┌─────────────────────┐                              │
│                         │  SQLite Database    │                              │
│                         │  (via sql.js)       │                              │
│                         │                     │                              │
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
│  Context Events (for conversation forking)                                   │
│  ├── context_imported    { sourceSessionId, snapshotId, summary, ... }      │
│  └── context_imported_event { originalEventId, eventData }                   │
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

## Conversation Forking

One of the key benefits of Event Sourcing is the ability to fork conversations:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Conversation Forking                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Original Session                                                            │
│  ┌────────────────────────────────────────────────────────────────┐         │
│  │  E1 ──► E2 ──► E3 ──► E4 ──► E5 ──► E6 ──► E7 ──► E8          │         │
│  └────────────────────────────────┬───────────────────────────────┘         │
│                                   │                                          │
│                          "Fork from E4"                                      │
│                                   │                                          │
│                                   ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │                      New Forked Session                          │        │
│  │                                                                  │        │
│  │  ┌────────────────────┐                                         │        │
│  │  │ context_imported   │  ◄── Summary of E1-E4                   │        │
│  │  │ (snapshot or       │      OR cherry-picked events            │        │
│  │  │  selected events)  │                                         │        │
│  │  └─────────┬──────────┘                                         │        │
│  │            │                                                     │        │
│  │            ▼                                                     │        │
│  │           F1 ──► F2 ──► F3  (new events)                        │        │
│  │                                                                  │        │
│  └─────────────────────────────────────────────────────────────────┘        │
│                                                                              │
│  Methods:                                                                    │
│  • seedFromSnapshot(snapshotId) - Use a snapshot as starting context        │
│  • seedFromEvents(eventIds[]) - Cherry-pick specific events                 │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Context Building for LLM

The `ContextBuilder` transforms events into LLM-ready messages:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             ContextBuilder Flow                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Input: sessionId, tokenBudget                                               │
│                                                                              │
│  Step 1: Check for snapshots                                                 │
│  ┌────────────────────────────────────────────────────────────────┐         │
│  │  latestSnapshot = snapshotManager.getLatestSnapshot(sessionId) │         │
│  └────────────────────────────────────────────────────────────────┘         │
│                            │                                                 │
│                            ▼                                                 │
│  Step 2: Get events after snapshot (or all if no snapshot)                  │
│  ┌────────────────────────────────────────────────────────────────┐         │
│  │  events = eventStore.getEvents(sessionId, afterSequence)       │         │
│  └────────────────────────────────────────────────────────────────┘         │
│                            │                                                 │
│                            ▼                                                 │
│  Step 3: Build messages array                                                │
│  ┌────────────────────────────────────────────────────────────────┐         │
│  │  messages = []                                                  │         │
│  │                                                                 │         │
│  │  if (snapshot) {                                                │         │
│  │    messages.push({                                              │         │
│  │      role: 'system',                                            │         │
│  │      content: `Previous context:\n${snapshot.summary}`          │         │
│  │    });                                                          │         │
│  │  }                                                              │         │
│  │                                                                 │         │
│  │  for (event of events) {                                        │         │
│  │    if (event.type === 'user_message')                           │         │
│  │      messages.push({ role: 'user', content: event.content })    │         │
│  │    if (event.type === 'assistant_message')                      │         │
│  │      messages.push({ role: 'assistant', content: event.content })│        │
│  │  }                                                              │         │
│  └────────────────────────────────────────────────────────────────┘         │
│                            │                                                 │
│                            ▼                                                 │
│  Output: LLMContext { messages, totalTokens, hasSnapshot, eventCount }      │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Async Initialization

Because sql.js uses WebAssembly, initialization is asynchronous:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Async Initialization Pattern                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  constructor()                                                               │
│       │                                                                      │
│       ├──► Store initPromise = this.initialize()                            │
│       │    (Fire and forget - don't await in constructor)                   │
│       │                                                                      │
│       ▼                                                                      │
│  initialize()                                                                │
│       │                                                                      │
│       ├──► await initializeSqlJs()   // Load WASM                           │
│       ├──► this.db = new Database()  // Create DB                           │
│       ├──► this.eventStore = new EventStore(db)                             │
│       ├──► this.snapshotManager = new SnapshotManager(...)                  │
│       ├──► this.initialized = true                                           │
│       │                                                                      │
│       ▼                                                                      │
│  ensureInitialized()  ◄── Called by all public methods                      │
│       │                                                                      │
│       └──► await this.initPromise                                           │
│                                                                              │
│                                                                              │
│  Usage in public methods:                                                    │
│  ┌────────────────────────────────────────────────────────────────┐         │
│  │  async getAllSessions(): Promise<Session[]> {                   │         │
│  │    await this.ensureInitialized();  // Wait for DB              │         │
│  │    return this.stmtGetAllSessions.all().map(rowToSession);      │         │
│  │  }                                                              │         │
│  └────────────────────────────────────────────────────────────────┘         │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## File Locations

| File | Description |
|------|-------------|
| [src/events/ConversationManager.ts](../src/events/ConversationManager.ts) | Main API, session management, compatibility layer |
| [src/events/EventStore.ts](../src/events/EventStore.ts) | Append-only event storage with SQLite |
| [src/events/EventTypes.ts](../src/events/EventTypes.ts) | TypeScript types for all events |
| [src/events/SnapshotManager.ts](../src/events/SnapshotManager.ts) | Snapshot creation and retrieval |
| [src/events/ContextBuilder.ts](../src/events/ContextBuilder.ts) | Build LLM context from events |
| [src/events/SqlJsWrapper.ts](../src/events/SqlJsWrapper.ts) | Database abstraction layer |
| [src/events/index.ts](../src/events/index.ts) | Public exports |

## Usage Examples

### Recording Messages

```typescript
// User sends a message
conversationManager.recordUserMessage(
  "Fix the authentication bug",
  [{ type: 'file', name: 'auth.ts', content: '...' }]
);

// Assistant responds
conversationManager.recordAssistantMessage(
  "I'll help you fix that. Let me read the file first...",
  "deepseek-chat",
  "tool_calls"
);

// Tool executed
conversationManager.recordToolCall("call_123", "read_file", { path: "auth.ts" });
conversationManager.recordToolResult("call_123", "file content here", true);
```

### Building Context for LLM

```typescript
// Get context with token budget
const context = await conversationManager.buildLLMContext(16000);

// context = {
//   messages: [
//     { role: 'system', content: 'Previous context: User was...' },
//     { role: 'user', content: 'Fix the authentication bug' },
//     { role: 'assistant', content: 'I\'ll help you...' }
//   ],
//   totalTokens: 1234,
//   hasSnapshot: true,
//   eventCount: 15
// }
```

### Forking Conversations

```typescript
// Fork from a snapshot
const snapshots = conversationManager.getAllSnapshots();
const selectedSnapshot = snapshots[0];
const newSession = await conversationManager.seedFromSnapshot(
  selectedSnapshot.id,
  "Retry auth fix with different approach"
);

// Cherry-pick specific events
const events = conversationManager.getBrowsableEvents(oldSessionId);
const selectedEventIds = [events[0].id, events[2].id];
const forkedSession = await conversationManager.seedFromEvents(
  selectedEventIds,
  "Partial context fork"
);
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
