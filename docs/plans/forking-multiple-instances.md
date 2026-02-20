# Forking Conversations from Events

**Status:** Implementation — Part 1 (multi-instance blockers) complete, Part 2 (schema design) decided, Parts 3-4 ready to implement

---

## Goal

Allow users to "fork" a conversation at any point — branching from a specific event to explore a different direction while preserving the original. Like git branching but for conversations.

This requires understanding (a) what blocks multiple instances, and (b) what events are forkable.

---

## Part 1: Multi-Instance Blockers

Running multiple Moby instances simultaneously is a prerequisite for forking (forked sessions may run in parallel). Here's what currently blocks that.

### Critical

| Blocker | Location | Problem |
|---------|----------|---------|
| ~~**SQLite file lock**~~ | `src/events/SqlJsWrapper.ts` | ~~Single `moby.db` with SQLCipher, no `busy_timeout` pragma, no connection pooling.~~ **FIXED** — added `PRAGMA journal_mode = WAL` + `PRAGMA busy_timeout = 5000`. Concurrent reads now work; writes retry for 5s instead of crashing. |
| ~~**Drawing server port**~~ | `src/providers/drawingServer.ts:40` | ~~Hardcoded port 8839.~~ **FIXED** — now uses port 0 (OS-assigned). |

### Medium

| Blocker | Location | Problem |
|---------|----------|---------|
| ~~**`currentSessionId` in globalState**~~ | `ConversationManager.ts` | ~~Both instances read/write the same key — race condition corrupts session tracking.~~ **FIXED** — hybrid instance-scoped key (`currentSessionId-{instanceId}`) for runtime isolation, shared `currentSessionId` as cold-start fallback. |
| **In-memory session state** | `chatProvider.ts` | Two instances loading the same session maintain separate message arrays with no sync. Naturally resolved by forking (forks always create new sessions). |
| ~~**Singletons**~~ | Logger, TraceCollector, WebviewLogStore | ~~Shared output channels and trace buffers — messy but not fatal.~~ **FIXED** — `Logger.setInstanceNumber(n)` creates separate output channels per instance (`DeepSeek Moby`, `DeepSeek Moby (2)`, etc.). Trace/log exports are per-process — no cross-instance contamination. |

### Not Blockers (Resolved or Non-Issues)

- Encryption key: shared key is fine if DB lock is solved
- ~~Command approval cache: stale cache is low-risk~~ **FIXED** — globalState version counter (`commandRulesVersion`) enables cross-instance cache invalidation. When one instance adds/removes/resets rules, it bumps the counter; other instances detect the change on next `checkCommand()` and refresh from DB.
- No temp files or named pipes with fixed names

### Fixes Needed for Multi-Instance

1. ~~**Database**: Add `PRAGMA busy_timeout = 5000;` + WAL mode for concurrent reads~~ **DONE**
2. ~~**Drawing server**: Use port 0 for OS-assigned port~~ **DONE**
3. ~~**Session tracking**: Use workspace-scoped state or per-instance keys~~ **DONE** — hybrid instance-scoped key
4. ~~**Output channels**: Separate channels per instance~~ **DONE** — `Logger.setInstanceNumber()`

---

## Part 2: Event Architecture

### Decision: Join Table (M:N Events ↔ Sessions)

Events are immutable facts. Sessions curate which events they contain. The relationship is many-to-many via a join table (`event_sessions`), enabling zero-copy forking — a fork links existing events to a new session without duplicating data.

**Why not copy?** Copy is simpler but duplicates all event data on fork. The join table approach makes forking a lightweight INSERT...SELECT of IDs, and events are stored exactly once regardless of how many sessions reference them.

**Why not reference-parent?** Walking ancestry chains on every read is fragile and gets worse with fork-of-fork depth. The join table gives flat per-session lookups with no chain walking.

### Schema (Fresh — No Migration History)

Since this is still in development, we blow up existing migrations and start fresh with a single clean schema that incorporates everything we know.

```sql
-- Sessions (with fork metadata)
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  event_count INTEGER DEFAULT 0,
  last_snapshot_sequence INTEGER DEFAULT 0,
  tags TEXT DEFAULT '[]',
  first_user_message TEXT,
  last_activity_preview TEXT,
  parent_session_id TEXT,       -- Fork parent (NULL = original)
  fork_sequence INTEGER         -- Sequence in parent where forked (NULL = original)
);

-- Events (session-agnostic — no session_id or sequence)
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL             -- JSON blob (no sessionId/sequence inside)
);

-- Join table (M:N — each session curates its events with per-session sequence)
CREATE TABLE event_sessions (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  UNIQUE(session_id, sequence),
  UNIQUE(event_id, session_id)
);

-- Snapshots (session-specific, unchanged)
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  up_to_sequence INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  summary TEXT NOT NULL,
  key_facts TEXT NOT NULL,
  files_modified TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  UNIQUE(session_id, up_to_sequence)
);

-- Command rules (unchanged)
CREATE TABLE command_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prefix TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('allowed', 'blocked')),
  source TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('default', 'user')),
  created_at INTEGER NOT NULL
);
```

### Key Design Points

- **`parent_session_id`** on sessions is informational only (no FK constraint) — forks survive parent deletion
- **`event_sessions`** is the source of truth for which events belong to which session and in what order
- **JSON data blob** does NOT contain `sessionId` or `sequence` — these are hydrated from the join table during reads
- **`ON DELETE CASCADE`** on `event_sessions.session_id` cleans up join rows when a session is deleted
- **Orphan cleanup** is application-level: after session deletion, `DELETE FROM events WHERE id NOT IN (SELECT event_id FROM event_sessions)` runs in the same transaction

### Session Schema (Updated)

```sql
sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  model TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  event_count INTEGER,
  tags TEXT,
  first_user_message TEXT,
  last_activity_preview TEXT,
  parent_session_id TEXT,      -- NEW: fork parent (NULL = original)
  fork_sequence INTEGER        -- NEW: sequence where forked (NULL = original)
)
```

### Event Types

| Type | Role | Description |
|------|------|-------------|
| `session_created` | meta | Session initialization |
| `session_renamed` | meta | Title change |
| `user_message` | user | User input with optional attachments |
| `assistant_message` | assistant | Full response with model, finishReason, contentIterations |
| `assistant_reasoning` | assistant | Individual R1 reasoning iteration |
| `tool_call` | assistant | Tool invocation (toolCallId, toolName, arguments) |
| `tool_result` | tool | Execution result (linked by toolCallId) |
| `file_read` | meta | File access (stores hash, not content) |
| `file_write` | meta | File modification marker |
| `diff_created` | meta | Diff lifecycle |
| `diff_accepted` | meta | Diff lifecycle |
| `diff_rejected` | meta | Diff lifecycle |
| `web_search` | meta | Query with result count |
| `context_imported` | meta | Previous session context marker |
| `error` | meta | Error tracking |

### How Events Become Turns

The UI groups events into turns via `getSessionRichHistory()`:

```
user_message           → creates user turn
assistant_reasoning    → starts/appends to assistant turn (R1 only)
tool_call              → routes by name to toolCalls/shellResults/filesModified
tool_result            → matches by toolCallId to update previous tool entry
assistant_message      → finalizes assistant turn with content, model, iterations
```

A single assistant "turn" in the UI may contain: multiple reasoning iterations, multiple tool calls/results, shell commands, file modifications, and a final text response.

### How Events Become API Messages

```
Session Events → getSessionMessagesCompat()
  → extracts user_message + assistant_message events only
  → [{ role: 'user', content }, { role: 'assistant', content }, ...]
  → ContextBuilder.build()
  → Filters by token budget from NEWEST backward
  → Prepends system prompt
  → Sends to API
```

Only `user_message` and `assistant_message` events are sent to the LLM. Tool calls, reasoning, file events etc. are metadata/UI-only.

---

## Part 3: What Is Forkable?

### Turn-Level (Recommended)

The cleanest fork points are **turn boundaries** — after a complete user or assistant turn.

| Fork Point | What Copies | Use Case |
|------------|-------------|----------|
| **After user message** | All events up to and including the user's message | "Re-ask this differently" |
| **After assistant response** | All events through the assistant's final message | "Try a different follow-up" |

These are clean because all events form complete pairs — no orphaned tool results, no partial reasoning.

### Event-Level (Flexible)

You could fork at any sequence number, but some boundaries need validation:

| Fork Point | Safe? | Consideration |
|------------|-------|---------------|
| After `user_message` | Yes | Clean — user turn complete |
| After `assistant_message` | Yes | Clean — assistant turn complete |
| After `tool_result` | Yes | Tool call/result pair is complete |
| After `tool_call` (before result) | Tricky | Orphaned tool call — LLM expects a result that never comes. Would need to inject a synthetic "cancelled" result or drop the tool call. |
| After `assistant_reasoning` (mid-turn) | Tricky | Partial reasoning — the turn has reasoning but no final `assistant_message`. Would need to either drop the reasoning or synthesize a partial response. |
| After `diff_created` / `web_search` | No value | These are metadata, not conversational. Forking here is same as forking at the previous conversational event. |

### Sub-Event Level (Not Recommended)

Forking *within* an event (e.g., mid-sentence in an assistant response) would break immutability — events are atomic JSON blobs. Not worth the complexity.

### Summary: Forkable Granularity

```
Most granular (practical)        Least granular
─────────────────────────────────────────────────
  any event  →  tool pairs  →  turn boundaries
  (needs       (needs pair     (always safe,
   validation)  validation)     simplest)
```

**Recommendation:** Start with turn boundaries. Expose fork-at-event later if needed.

---

## Part 4: Implementation

### What Changes in the Code

| Layer | Change |
|-------|--------|
| `src/events/migrations.ts` | Rewrite — single clean schema (version 1), no migration history |
| `src/events/EventStore.ts` | All prepared statements use JOIN on `event_sessions`. `append()` inserts into both `events` + `event_sessions`. Add `linkEventsToSession()` for forking. |
| `src/events/EventTypes.ts` | Add `ForkCreatedEvent`. `sessionId`/`sequence` removed from stored JSON blob (hydrated during reads from join table). |
| `src/events/ConversationManager.ts` | Add `forkSession()`, `getSessionForks()`. Update `Session` interface (+`parentSessionId`, +`forkSequence`). Update `deleteSession()` with orphan cleanup. |
| `src/events/SnapshotManager.ts` | Minimal — snapshots are already session-scoped via FK |
| All tests | Update DB setup, update assertions for new schema |

### New Event Type

```typescript
// In EventTypes.ts
interface ForkCreatedEvent extends BaseEvent {
  type: 'fork_created';
  parentSessionId: string;
  forkPointSequence: number;
}
```

### EventStore Changes

**Reading events (JOIN-based):**
```sql
SELECT e.data, es.sequence
FROM events e
JOIN event_sessions es ON e.id = es.event_id
WHERE es.session_id = ? AND es.sequence > ?
ORDER BY es.sequence ASC
```

Events are hydrated with `sessionId` and `sequence` from the join table during reads (not stored in the JSON blob).

**Appending an event:**
1. INSERT into `events` (id, timestamp, type, data)
2. INSERT into `event_sessions` (event_id, session_id, sequence)

**Forking (new method — `linkEventsToSession`):**
```sql
INSERT INTO event_sessions (event_id, session_id, sequence)
SELECT event_id, ?, sequence
FROM event_sessions
WHERE session_id = ? AND sequence <= ?
```

This is the core of forking — link existing events to a new session. No event data copied.

### Fork Method

```typescript
// In ConversationManager.ts
async forkSession(parentSessionId: string, atSequence: number): Promise<Session> {
  // 1. Validate parent session exists
  // 2. Validate fork point is a clean turn boundary
  //    (event at atSequence must be user_message or assistant_message)
  // 3. Create new session with parent reference
  //    Title: "${parent.title} (fork)", same model
  //    parent_session_id = parentSessionId, fork_sequence = atSequence
  // 4. Link events via join table (INSERT...SELECT — zero-copy)
  // 5. Record fork_created event in the new session
  // 6. Update session metadata (event_count, first_user_message, etc.)
  // 7. Switch to forked session
  // 8. Return the new session
}
```

### Session Deletion with Orphan Cleanup

```typescript
async deleteSession(sessionId: string): Promise<void> {
  const deleteAll = this.db.transaction(() => {
    // 1. Delete session (CASCADE removes event_sessions rows + snapshots)
    this.stmtDeleteSession.run(sessionId);
    // 2. Clean up orphaned events (no remaining session references)
    this.db.prepare(
      'DELETE FROM events WHERE id NOT IN (SELECT event_id FROM event_sessions)'
    ).run();
  });
  deleteAll();
}
```

### Helper: Get Forks of a Session

```typescript
async getSessionForks(sessionId: string): Promise<Session[]> {
  // SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY created_at DESC
}
```

### UI Affordance Options

- **Right-click on turn** → "Fork from here"
- **Branch icon on turn header** → creates fork
- **History modal** → shows fork tree (parent → children)
- **Forked session title** → shows "(fork of X)" or similar

### What Loads After Fork

The forked session loads normally — `getSessionRichHistory()` reads events via the join table and reconstructs turns. The user sees the conversation up to the fork point and can continue from there. The original session is untouched.

---

## Part 5: Parallel Subagents

Claude Code's "Task" tool spawns parallel agents that work independently and report back. This is an application-level orchestration pattern — not a model capability. It's buildable with any LLM API.

### How It Works (Claude Code's Model)

```
Main conversation identifies independent subtasks
  ├─ Subagent A: "search for X in the codebase"     ─┐
  ├─ Subagent B: "read and analyze file Y"            ├─ concurrent API calls
  └─ Subagent C: "check if test Z passes"            ─┘
                                                        │
Results collected ◄─────────────────────────────────────┘
  └─ Injected back into main conversation as context
```

Each subagent is a **separate API call** with:
- Its own system prompt (focused on one task)
- Its own tool access (file read, search, shell, etc.)
- Its own context window (independent of the main conversation)
- No awareness of other subagents

The main conversation orchestrates: decides what to parallelize, dispatches, collects, synthesizes.

### Architecture for Moby

#### Subagent Request

```typescript
interface SubagentRequest {
  id: string;
  systemPrompt: string;       // Focused prompt for this subtask
  userMessage: string;         // The specific task
  tools: ToolDefinition[];     // Which tools this subagent can use
  maxIterations: number;       // Limit tool loop depth
  tokenBudget: number;         // Max tokens for this subagent
}
```

#### Subagent Runner

A lightweight version of RequestOrchestrator that:
1. Sends a single API request with the subagent's system prompt + task
2. Runs a tool loop (file read, grep, shell) if the LLM requests tools
3. Returns the final text response (no streaming to UI needed)

```typescript
// In src/providers/subagentRunner.ts
class SubagentRunner {
  constructor(
    private client: DeepSeekClient,
    private toolExecutor: ToolExecutor
  ) {}

  async run(request: SubagentRequest): Promise<SubagentResult> {
    const messages = [
      { role: 'system', content: request.systemPrompt },
      { role: 'user', content: request.userMessage }
    ];

    // Tool loop — subagent can call tools and iterate
    for (let i = 0; i < request.maxIterations; i++) {
      const response = await this.client.chat(messages, {
        tools: request.tools,
        maxTokens: request.tokenBudget
      });

      if (!response.toolCalls?.length) {
        return { id: request.id, result: response.content };
      }

      // Execute tools, append results, continue loop
      for (const call of response.toolCalls) {
        const result = await this.toolExecutor.execute(call);
        messages.push(
          { role: 'assistant', tool_calls: [call] },
          { role: 'tool', tool_call_id: call.id, content: result }
        );
      }
    }

    return { id: request.id, result: 'Max iterations reached' };
  }
}
```

#### Orchestration in Main Conversation

Two approaches:

**A. LLM-Driven (like Claude Code):**
The LLM itself decides to spawn subagents via a `parallel_tasks` tool:

```typescript
// Tool definition given to the main LLM
{
  name: 'parallel_tasks',
  description: 'Run multiple independent tasks in parallel',
  parameters: {
    tasks: [{
      description: string,  // What the subagent should do
      tools: string[]        // Which tools it needs
    }]
  }
}
```

When the LLM calls this tool, the extension spawns N concurrent API requests, waits for all, and returns combined results as the tool result.

**B. Application-Driven (simpler):**
The extension detects patterns where parallelism helps and handles it transparently:
- Multiple `file_read` tool calls → batch them concurrently
- Multiple `web_search` calls → fire in parallel
- Multiple independent `shell` commands → run concurrently

No new tool needed — the existing tool loop just executes independent calls concurrently instead of sequentially.

### UI Representation

Subagent work could appear in the chat as:

```
┌─────────────────────────────────────┐
│ ⏳ Running 3 tasks in parallel      │
├─────────────────────────────────────┤
│ ├ ✓ Search codebase for auth logic  │
│ ├ ✓ Read database schema            │
│ └ ⏳ Check test coverage            │
└─────────────────────────────────────┘
```

This maps naturally to the existing `tools-container` UI pattern — a collapsible group showing individual task status.

### What This Enables

| Scenario | Sequential | Parallel |
|----------|-----------|----------|
| "Check 5 files for this pattern" | 5 API round-trips | 1 round-trip (5 concurrent) |
| "Run tests and lint" | 2 shell calls in sequence | 2 concurrent shells |
| "Research X, Y, and Z" | 3 separate search+read chains | 3 concurrent chains |
| "Analyze this PR" | Read each file one-by-one | Read all changed files at once |

### Complexity Considerations

| Concern | Approach |
|---------|----------|
| **Token cost** | Each subagent uses its own tokens — N subagents = N× the cost of one. Budget limits per subagent. |
| **Tool conflicts** | Two subagents editing the same file → race condition. Limit write tools to main conversation only; subagents get read-only tools. |
| **Error handling** | If one subagent fails, others continue. Partial results are still useful. |
| **Streaming** | Subagents don't stream to UI (they run in background). Main conversation streams normally. |
| **Context injection** | Subagent results are injected as tool results in the main conversation — the LLM sees them as "I asked for X and got Y." |
| **Model choice** | Subagents could use a cheaper/faster model (e.g., V3 instead of R1) since they do focused tasks. |

### Implementation Phases

**Phase 1: Application-driven parallelism (no new tools)**
- Detect independent tool calls in the existing tool loop
- Execute them concurrently instead of sequentially
- No LLM changes, no new UI — just faster execution

**Phase 2: LLM-driven subagents (new tool)**
- Add `parallel_tasks` tool definition
- Build `SubagentRunner` with tool loop
- Add parallel task UI container
- Subagents get read-only tools (file read, grep, shell read)

**Phase 3: Full autonomy**
- Subagents can spawn their own subagents (depth limit)
- Write tools for subagents (with conflict detection)
- Cross-subagent communication (shared scratchpad)

---

## Decided Questions

| Question | Decision |
|----------|----------|
| **Copy events or reference parent?** | **Join table (M:N)** — events stored once, sessions link to them via `event_sessions`. Zero-copy forking. No ancestry chain walking. |
| **Schema migration strategy?** | **Fresh start** — blow up existing migrations, single clean schema. Still in development, no user databases to migrate. |
| **Orphan event cleanup?** | **Application-level** — `DELETE FROM events WHERE id NOT IN (SELECT event_id FROM event_sessions)` in same transaction as session delete. No triggers. |
| **Parent deletion cascade to forks?** | **No** — `parent_session_id` is informational only (no FK). Forks are fully independent. |
| **Can you fork a fork?** | **Yes** — the join table makes this trivial. Link events from any session to a new session. |
| **Fork while streaming?** | **No** — only fork completed turns. |
| **JSON blob contents?** | **No sessionId/sequence in blob** — hydrated from join table during reads. |

## Open Questions

| Question | Options |
|----------|---------|
| **Show fork tree in history?** | Flat list with "(fork of X)" label vs. visual tree. |
| **Subagent model?** | Same model as main conversation, or cheaper/faster model for focused tasks? |
| **Subagent tool access?** | Read-only safe, write tools risk conflicts. Start read-only. |
| **Who decides to parallelize?** | Application-driven (Phase 1) is safer. LLM-driven (Phase 2) is more flexible. |
