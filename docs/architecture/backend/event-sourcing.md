# Event Sourcing Architecture

The conversation persistence system stores an immutable, append-only log of **events** that fully describe what happened during a session. Per [ADR 0003](../decisions/0003-events-table-sole-source-of-truth.md), the events table is the **sole source of truth** for session history — there is no parallel blob persistence path. Hydration replays events directly into the rendered conversation.

## Overview

Instead of storing mutable state (a list of messages), the extension stores discrete events. The current state of a session is derived by replaying its events.

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
│  │  }                      │          │      content: "hello" },        │   │
│  └─────────────────────────┘          │    { type: 'structural_turn_   │   │
│                                        │      event', payload: {...} }  │   │
│                                        │  ]                              │   │
│                                        └─────────────────────────────────┘   │
│  ✗ State is mutated                   ✓ Events are immutable                │
│  ✗ History is lost                    ✓ Full history preserved              │
│  ✗ Can't replay                       ✓ Can replay to any point             │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

Two design constraints are load-bearing for everything below:

1. **Events table is session-agnostic.** Rows in `events` carry no `session_id` or `sequence`. Those columns live in the `event_sessions` join table, which provides a many-to-many mapping with per-session sequencing. JSON blobs do not contain `sessionId`/`sequence` — they're hydrated from the join table on read. This decoupling makes forking zero-copy.

2. **Structural events are first-class.** Per ADR 0003, the extension emits structural events (`code-block-start`/`end`, iteration boundaries, shell lifecycle, approval lifecycle, drawings) as it observes them. The webview replays these on hydration to reconstruct exactly what was shown live — there is no client-side reconstruction heuristic.

## Component Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          ConversationManager                                 │
│                         (Primary Entry Point)                                │
│                                                                              │
│  Session lifecycle:                                                          │
│    createSession(), getSessionSync(), deleteSession(),                       │
│    forkSession(parentId, atSequence)                                         │
│                                                                              │
│  Content events (recorded by RequestOrchestrator):                           │
│    recordUserMessage, recordAssistantMessage,                                │
│    recordDiffCreated/Accepted/Rejected, recordWebSearch,                     │
│    recordError, recordFileRead/Write                                         │
│                                                                              │
│  Structural events (per ADR 0003):                                           │
│    recordStructuralEvent(turnId, indexInTurn, payload)                       │
│    getStructuralEventsForTurn(sessionId, turnId)                             │
│    getAssistantMessagesForTurn(sessionId, turnId)                            │
│                                                                              │
│  Hydration:                                                                  │
│    getSessionRichHistory(sessionId) → RichHistoryTurn[]                      │
│                                                                              │
│  Snapshots:                                                                  │
│    createSnapshot, getLatestSnapshotSummary, hasFreshSummary                 │
│                                                                              │
│  ┌──────────────────────────────┐  ┌─────────────────────────────────┐       │
│  │  StructuralEventRecorder     │  │  EventStore                     │       │
│  │  (in-memory turn builder)    │  │  • append()                     │       │
│  │  • startTurn / drainTurn     │──│  • getEvents()                  │       │
│  │  • append(TurnEvent)         │  │  • getByType()                  │       │
│  │  • flush via record-         │  └────────────┬────────────────────┘       │
│  │    StructuralEvent           │               │                            │
│  └──────────────────────────────┘  ┌────────────▼────────────────────┐       │
│                                     │  SnapshotManager                │       │
│                                     │  • createSnapshot               │       │
│                                     │  • getLatest()                  │       │
│                                     │  • deleteSession                │       │
│                                     └────────────┬────────────────────┘       │
│                                                  │                            │
│                                                  ▼                            │
│                                  ┌─────────────────────────────┐              │
│                                  │  SQLCipher-encrypted SQLite │              │
│                                  │                             │              │
│                                  │  • sessions                 │              │
│                                  │  • events  (session-        │              │
│                                  │    agnostic JSON blobs)     │              │
│                                  │  • event_sessions  (M:N     │              │
│                                  │    join + sequencing)       │              │
│                                  │  • snapshots                │              │
│                                  │  • command_rules            │              │
│                                  └─────────────────────────────┘              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Event Types

Events are strongly typed and split into two roles: **content events** describe semantic facts (a user said this, a tool ran, a file was edited), and **structural events** describe the visual structure of a turn so the webview can replay it exactly as it was shown.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Event Type Hierarchy                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Base Event (all events have)                                                │
│  ┌─────────────────────────────────────────────────────────┐                │
│  │  id: string          // UUID (stored in JSON blob)      │                │
│  │  sessionId: string   // Hydrated from join table*       │                │
│  │  sequence: number    // Hydrated from join table*       │                │
│  │  timestamp: number   // Unix ms                         │                │
│  │  type: EventType     // Discriminator                   │                │
│  └─────────────────────────────────────────────────────────┘                │
│  * sessionId and sequence are NOT stored in the JSON blob.                  │
│    They're injected from the event_sessions join table during reads.        │
│                                                                              │
│  Content Events                                                              │
│                                                                              │
│  Message                                                                     │
│  ├── user_message        { content, attachments? }                          │
│  ├── assistant_message   { content, model, finishReason, usage? }           │
│  └── assistant_reasoning { content, iteration }      (legacy, see below)    │
│                                                                              │
│  Tool                                                                        │
│  ├── tool_call           { toolCallId, toolName, arguments }  (legacy)      │
│  └── tool_result         { toolCallId, result, success, duration? }         │
│                                  (legacy)                                    │
│                                                                              │
│  File                                                                        │
│  ├── file_read           { filePath, contentHash, lineCount }               │
│  ├── file_write          { filePath, contentHash, lineCount }               │
│  ├── diff_created        { diffId, filePath, original, new }                │
│  ├── diff_accepted       { diffId }                                          │
│  └── diff_rejected       { diffId }                                          │
│                                                                              │
│  Session                                                                     │
│  ├── session_created     { title, model }                                    │
│  ├── session_renamed     { oldTitle, newTitle }                              │
│  └── fork_created        { parentSessionId, forkPointSequence }             │
│                                                                              │
│  Other                                                                       │
│  ├── web_search          { query, resultCount, resultsPreview }             │
│  ├── context_imported    { previousSessionId }                               │
│  └── error               { errorType, message, recoverable }                │
│                                                                              │
│  Structural Events (ADR 0003 — drives hydration replay)                     │
│                                                                              │
│  └── structural_turn_event                                                   │
│        { turnId, indexInTurn, payload: TurnEvent }                          │
│                                                                              │
│      payload variants (the TurnEvent union):                                │
│        code-block-start / code-block-end                                     │
│        iteration-end                                                         │
│        shell-start / shell-output / shell-end                               │
│        approval-created / approval-resolved                                  │
│        drawing                                                               │
│        content-chunk      (Phase 2 — flushed at buffer boundaries)          │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Legacy event types (pending cleanup)

`assistant_reasoning`, `tool_call`, and `tool_result` are still written by [`requestOrchestrator.saveToHistory`](../../../src/providers/requestOrchestrator.ts) but **no consumer reads them anymore** post-Phase-3. The hydration path (`getSessionRichHistory`) reconstructs reasoning, tool calls, and tool results from the structural-event stream + assistant message content. These three writes are dead and tracked for removal in CLAUDE.md → "Events-table follow-ups → Small cleanups." They remain documented here only because the methods still exist and the events still land on disk.

### `StructuralEventRecorder`

[src/events/StructuralEventRecorder.ts](../../../src/events/StructuralEventRecorder.ts) is the in-memory accumulator that batches structural events emitted during a single turn. The orchestrator calls `startTurn(turnId, sessionId)` at turn start, `append(event)` as code-block boundaries / iteration ends / shell lifecycle / approvals fire, and `drainTurn()` at end. Events are flushed into the events table via `recordStructuralEvent`. Phase 2 added incremental flushes at `ContentTransformBuffer` boundaries (iteration end, pre-shell, pre-approval, end-of-turn) so a process death mid-turn no longer evaporates streamed content — the most common case being VS Code being closed while awaiting a shell-approval click.

The recorder has no `vscode` or DOM dependencies — pure TypeScript so it's testable without a host.

## Snapshots: Context Compression

For long conversations, the model can't see all events (context window cap). Snapshots solve this by summarizing older events into compact summaries that `ContextBuilder` injects when older messages would otherwise be dropped.

### Trigger: Proactive Context Pressure

Snapshots are **not** created on every event append. `RequestOrchestrator` checks context usage after each response and creates a snapshot only when usage crosses the threshold:

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

- **File:** [src/providers/requestOrchestrator.ts](../../../src/providers/requestOrchestrator.ts) — search `usageRatio` for the trigger; the `hasFreshSummary` guard prevents re-triggering if the latest snapshot covers within 5 events of the current sequence.
- **Threshold:** 80% context usage.

### Summarizer Strategy: LLM with Chaining

[src/events/SnapshotManager.ts](../../../src/events/SnapshotManager.ts) provides an `LLMSummarizer` that summarizes events with bounded input — the previous summary plus only new events since it was taken:

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
└─────────────────────────────────────────────────────────────────────────────┘
```

The summarizer implements `SummarizerFn`:

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
  summary: string;           // Natural-language summary — INJECTED into context
  keyFacts: string[];        // Stored but NOT currently injected
  filesModified: string[];   // Stored but NOT currently injected
  tokenCount: number;        // Estimated tokens used by `summary`
}
```

Only `summary` lands in the request. `keyFacts` and `filesModified` are produced by the summarizer and persisted but currently unused at injection time — either dead state or pending wiring. See [src/context/contextBuilder.ts](../../../src/context/contextBuilder.ts) `build()` for the injection logic.

### Snapshot Configuration

```typescript
// Default: snapshot every 20 events
const snapshotManager = new SnapshotManager(db, eventStore, summarizer, {
  snapshotInterval: 20         // Events between snapshots
});
```

### Message Queuing During Summarization

When summarization fires, `ChatProvider` queues incoming user messages until it completes:

```
User sends message during summarization
         │
         ├─► _summarizing === true
         │       └─► Push to _pendingMessages[]
         │           └─► postMessage 'statusMessage':
         │               "Queued — optimizing context..."
         │
         └─► Summarization completes
                 └─► drainQueue() processes pending messages sequentially
```

- **File:** [src/providers/chatProvider.ts](../../../src/providers/chatProvider.ts) — `_summarizing` flag, `_pendingMessages`, `drainQueue()`.
- **Visual today:** transient toast in `StatusPanelShadowActor` that auto-clears after 30s — see [docs/architecture/integration/message-bridge.md](../integration/message-bridge.md) for the `status.message` pub/sub key. The 30s timeout is independent of summarization actually finishing, so on long sessions the toast can disappear mid-process. There's no completion message when `drainQueue` picks up a queued message.

## Storage Schema

`runMigrations` ([src/events/migrations.ts](../../../src/events/migrations.ts)) is the single source of truth for all DDL. Schema is at version 1 (no migration history — pre-release).

### Tables

```
sessions
├── id                  TEXT PRIMARY KEY
├── title               TEXT
├── model               TEXT
├── created_at          INTEGER
├── updated_at          INTEGER
├── parent_session_id   TEXT  (NULL unless this is a fork; informational, no FK)
└── fork_sequence       INTEGER (sequence in parent at which this fork branched)

events                  -- session-agnostic
├── id                  TEXT PRIMARY KEY
├── type                TEXT
├── timestamp           INTEGER
└── data                TEXT  (JSON blob; does NOT include sessionId/sequence)

event_sessions          -- M:N join, provides sequencing per session
├── session_id          TEXT  REFERENCES sessions(id) ON DELETE CASCADE
├── event_id            TEXT  REFERENCES events(id)
├── sequence            INTEGER
└── PRIMARY KEY (session_id, sequence)

snapshots
├── id                  TEXT PRIMARY KEY
├── session_id          TEXT  REFERENCES sessions(id) ON DELETE CASCADE
├── up_to_sequence      INTEGER
├── timestamp           INTEGER
├── summary             TEXT
├── key_facts           TEXT  (JSON array)
├── files_modified      TEXT  (JSON array)
└── token_count         INTEGER

command_rules           -- separate, not part of session history
└── ...
```

### Why this layout

- **Zero-copy forking.** `forkSession(parentId, atSequence)` is `INSERT INTO event_sessions SELECT ..., new_session_id, sequence FROM event_sessions WHERE session_id = parentId AND sequence <= atSequence`. Events themselves are not duplicated. Forks share underlying event rows with their ancestors; only the join table differs.
- **Crash safety.** WAL mode + `busy_timeout = 5000` + ACID transactions wrap any multi-row write. `PRAGMA foreign_keys = ON` means deleting a session cascades to `event_sessions` and `snapshots`; an application-level orphan-cleanup pass in `deleteSession` removes events no longer referenced by any session.
- **Hydration ordering.** Per-session reads use `SELECT events.* FROM event_sessions JOIN events ON events.id = event_sessions.event_id WHERE session_id = ? ORDER BY sequence`. The join injects `session_id` + `sequence` into the resulting `ConversationEvent` objects so callers don't need to know about the split.

## Initialization

@signalapp/sqlcipher initialization is synchronous. The encryption key is retrieved asynchronously in `activate()` and passed to the constructor:

```typescript
// extension.ts
const dbKey = await getOrCreateEncryptionKey(context);
conversationManager = new ConversationManager(context, dbKey);  // fully sync
```

Constructor sequence:

1. Creates `Database` and applies `PRAGMA foreign_keys = ON`, `journal_mode = WAL`, `busy_timeout = 5000`.
2. Runs `runMigrations(db)` — fresh v1 if the file is new, no-op otherwise.
3. Creates `EventStore` and `SnapshotManager` with prepared statements.
4. Prepares session statements. ChatProvider owns session lifecycle — ConversationManager doesn't track an "active" session.

Recovery from `SQLITE_NOTADB` (corrupted/garbage `moby.db`) is handled by [src/events/dbRecovery.ts](../../../src/events/dbRecovery.ts) — see [docs/guides/database-recovery.md](../../guides/database-recovery.md).

## File Locations

| File | Description |
|------|-------------|
| [src/events/ConversationManager.ts](../../../src/events/ConversationManager.ts) | Main API, session management, history restore |
| [src/events/migrations.ts](../../../src/events/migrations.ts) | Schema migrations (single source of truth for all DDL) |
| [src/events/EventStore.ts](../../../src/events/EventStore.ts) | Append-only event storage |
| [src/events/EventTypes.ts](../../../src/events/EventTypes.ts) | TypeScript types for all events + type guards |
| [src/events/StructuralEventRecorder.ts](../../../src/events/StructuralEventRecorder.ts) | In-memory turn builder for structural events |
| [src/events/SnapshotManager.ts](../../../src/events/SnapshotManager.ts) | Snapshot creation, retrieval, chaining |
| [src/events/SqlJsWrapper.ts](../../../src/events/SqlJsWrapper.ts) | Database wrapper (@signalapp/sqlcipher) |
| [src/events/dbRecovery.ts](../../../src/events/dbRecovery.ts) | `SQLITE_NOTADB` auto-recovery |
| [src/events/index.ts](../../../src/events/index.ts) | Public exports |

## Usage Examples

### Session Ownership

ConversationManager is a **pure data service** — it has no concept of a "current" session. Every write method takes an explicit `sessionId` parameter. ChatProvider owns which session is "active" via its `currentSessionId` field and persists it to `globalState`.

This separation is what enables multi-panel support: multiple ChatProvider instances can share one ConversationManager (single DB connection) while each tracking their own active session independently. The shared `onSessionsChangedEvent` notifies all subscribers when any panel mutates sessions.

### Recording Messages

```typescript
// All record methods take an explicit sessionId — no implicit "current session".
await conversationManager.recordUserMessage(sessionId, 'Fix the authentication bug');
await conversationManager.recordAssistantMessage(
  sessionId, "I'll help you fix that.", 'deepseek-v4-pro', 'stop'
);
```

### Recording Structural Events (during streaming)

```typescript
// Per-turn lifecycle owned by RequestOrchestrator:
recorder.startTurn(turnId, sessionId);

// As events fire from the stream:
recorder.append({ type: 'code-block-start', language: 'typescript', ... });
recorder.append({ type: 'iteration-end', iteration: 0 });
recorder.append({ type: 'shell-start', commandId, command });
// ...

// At buffer-flush boundaries (Phase 2) and end-of-turn:
for (const ev of recorder.drainTurn()) {
  await conversationManager.recordStructuralEvent(sessionId, turnId, ev.indexInTurn, ev.payload);
}
```

### Forking

```typescript
// Zero-copy via the join table — events themselves aren't duplicated.
const { session: forked, lastUserMessage } = await conversationManager.forkSession(
  parentSessionId,
  atSequence
);
```

## History Restore

`getSessionRichHistory(sessionId)` ([ConversationManager.ts:751](../../../src/events/ConversationManager.ts#L751)) is the **only** hydration path. It walks the session's events in sequence order and groups them into `RichHistoryTurn` objects containing reasoning iterations, tool calls, shell results, file modifications, and per-iteration content text. Structural events drive the segment ordering (so reload order matches what was shown live, exactly).

The webview's `handleLoadHistory()` renders these turns through the `VirtualListActor` API. Segment ordering matches the live streaming experience (Reasoner: thinking → content → shell; Chat: tools → files → text).

For full save → restore → render flow, see the [History Persistence Guide](../../guides/history-persistence.md).

## Benefits of This Architecture

| Benefit | Description |
|---------|-------------|
| **Auditability** | Complete history of every interaction |
| **Debuggability** | Replay events to reproduce issues; `Moby: Export Turn as JSON` exports the live structural-event stream |
| **Crash safety** | Phase 2's incremental flushes mean partial turns survive process death (mid-stream content, mid-approval shell calls) |
| **Context management** | Snapshots prevent context-window overflow on long sessions |
| **Zero-copy forking** | M:N join table — fork via `INSERT...SELECT` on event_sessions |
| **Durability** | SQLite ACID + SQLCipher encryption + WAL mode |
| **Performance** | Prepared statements + `(session_id, sequence)` PK on event_sessions for flat per-session lookups |

## Related Documentation

- [ADR 0003 — Events table is the sole source of truth](../decisions/0003-events-table-sole-source-of-truth.md)
- [Database Layer](database-layer.md) — SQLite + @signalapp/sqlcipher details
- [Backend Architecture](backend-architecture.md) — How ChatProvider uses ConversationManager
- [Message Bridge](../integration/message-bridge.md) — How events flow to/from the webview
- [History Persistence Guide](../../guides/history-persistence.md) — Full save → restore → render flow
- [Database Recovery Guide](../../guides/database-recovery.md) — `SQLITE_NOTADB` recovery decision tree
