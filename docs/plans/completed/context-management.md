# Context Window Management

**Purpose:** Wire ContextBuilder into the request flow so conversations stay within the 128K token budget, with snapshot summaries injected when old messages are dropped.

**Status:** Complete (Phases 1-3 implemented)

**Depends on:** WASM tokenizer (complete), Event Sourcing + snapshots (complete)

---

## Table of Contents

1. [Problem](#1-problem)
2. [Current State](#2-current-state)
3. [Architecture](#3-architecture)
4. [Implementation](#4-implementation)
5. [ContextBuilder Enhancements](#5-contextbuilder-enhancements)
6. [Snapshot Summary Injection](#6-snapshot-summary-injection)
7. [Tool Definition Budget](#7-tool-definition-budget)
8. [Logging](#8-logging)
9. [Testing Strategy](#9-testing-strategy)
10. [Context Compression — Implemented](#10-context-compression--implemented)
11. [Token Count Caching — Implemented](#11-token-count-caching--implemented)
12. [Session & Data Lifecycle Management](#12-session--data-lifecycle-management)
13. [Key Files](#13-key-files)

---

## 1. Problem

Messages are sent to the API without any context window management. The path today:

```
chatProvider.getSessionMessagesCompat()  →  ALL messages  →  deepSeekClient.chat/streamChat()  →  API
```

If a conversation exceeds 128K tokens, the API rejects the request. ContextBuilder exists and is fully tested, but nobody calls it.

---

## 2. Current State

### What's Built

| Component | Status | Location |
|-----------|--------|----------|
| ContextBuilder | ✅ Implemented, tested | `src/context/contextBuilder.ts` |
| DeepSeekClient.buildContext() | ✅ Wrapper exists | `src/deepseekClient.ts:608-614` |
| TokenService (WASM) | ✅ Running | `src/services/tokenService.ts` |
| SnapshotManager | ✅ Auto-creates every 20 events | `src/events/SnapshotManager.ts` |
| Extractive summarizer | ✅ Working | `src/events/SnapshotManager.ts:320-364` |
| Cross-validation | ✅ Logging after every request | `src/deepseekClient.ts:625-663` |

### What's Missing

| Gap | Impact | Status |
|-----|--------|--------|
| ContextBuilder not called before API requests | Context overflow on long conversations | ✅ Fixed (Phase 2) |
| No public accessor for snapshots from ConversationManager | Can't retrieve snapshot summary | ✅ Fixed (Phase 1) |
| ContextBuilder doesn't account for tool definitions | ~730 tokens unbudgeted when tools are active | ✅ Not needed — `countRequestTokens()` counts tool definitions; cross-validation delta stabilized at 3.5-5% (see [token-counting.md](../../architecture/backend/token-counting.md#cross-validation)) |
| Tool loop doesn't check budget between iterations | Context can grow unbounded (up to 25 iterations x N tool results) | ✅ Fixed (Phase 3) |

---

## 3. Architecture

### After Wiring

```
chatProvider
    |
    +-- getSessionMessagesCompat()  -->  all messages
    |
    +-- getLatestSnapshotSummary()  -->  snapshot summary (if any)
    |
    +-- deepSeekClient.buildContext(messages, systemPrompt, snapshotSummary)
    |       |
    |       +-- ContextBuilder.build()
    |              |
    |              +-- Count system prompt tokens (fixed cost)
    |              +-- Subtract tool definition tokens (if tools active)
    |              +-- Fill from newest messages backward
    |              +-- Drop oldest messages when budget exceeded
    |              +-- Inject snapshot summary if messages dropped
    |
    +-- Use result.messages for API call
    |
    +-- Log: [Context] 45,231/119,808 tokens | 12 dropped | summary injected
```

### Model Budgets

| Model | Total Context | Max Output | Available for Input |
|-------|--------------|------------|-------------------|
| deepseek-chat | 128,000 | 8,192 | ~119,808 |
| deepseek-reasoner | 128,000 | 16,384 | ~111,616 |

---

## 4. Implementation

### Phase 1: Expose Snapshot Access ✅

Added `getLatestSnapshotSummary(sessionId)` to `ConversationManager` (line 957-963). Returns the latest snapshot summary string or undefined. Tested with 3 unit tests.

### Phase 2: Wire ContextBuilder Into chatProvider ✅

**Injection point:** `src/providers/chatProvider.ts` ~line 1690, after message retrieval, before tool loop.

ContextBuilder runs once per user message. It:
1. Pulls all messages from the database
2. Counts tokens, fills from newest backward
3. Drops oldest messages when budget exceeded
4. Injects snapshot summary if messages were dropped
5. Returns trimmed messages used for all subsequent API calls (tool loop + streaming)

### Phase 3: Tool Loop Budget Check ✅

Two protections implemented:

**3a. Token counting + early stop in tool loop** (`chatProvider.ts` runToolLoop)

The tool loop receives `contextTokenCount` and `contextBudget` from the initial ContextBuilder result. Each iteration counts tokens for the assistant message and tool results. If accumulated tokens push past 95% of the budget, the loop stops early with a user-visible warning. This prevents `context_length_exceeded` API errors during long tool chains.

**3b. Atomic pair cleanup in ContextBuilder** (`contextBuilder.ts` lines 102-137)

After the backward-fill picks a cutoff, a cleanup loop scans the boundary to avoid splitting tool-call / tool-result pairs. The DeepSeek API requires every `tool` message (with `tool_call_id`) to have a matching `assistant` message (with `tool_calls`) earlier in the array. If the cutoff splits a pair, the cleanup nudges the cutoff forward to drop both halves. This protects against old tool messages from previous requests being split during trimming of historical messages.

Tested with 3 unit tests: no-split verification, orphaned-result cleanup, complete-pair preservation.

---

## 5. ContextBuilder Enhancements

### Tool Definition Token Reservation

When tools are active, subtract their cost from the available budget:

```typescript
// src/context/contextBuilder.ts -- in build()

// Subtract tool definition cost from budget (if provided)
const toolTokens = toolDefinitionTokens ?? 0;
const availableBudget = Math.floor(
  (budget.totalContext - budget.maxOutputTokens) * safetyMultiplier
) - systemTokens - toolTokens;
```

Add an optional `toolDefinitionTokens` parameter to `build()` and `buildContext()`. The caller computes this once via `tokenCounter.count(JSON.stringify(tools))`.

### Message Type Compatibility

ContextBuilder currently works with `Message` (role + content). Tool loop messages have additional fields (`tool_calls`, `tool_call_id`). These pass through fine since ContextBuilder only reads `role` and `content` for counting, and returns the original message objects. No type changes needed.

---

## 6. Snapshot Summary Injection

Already implemented in ContextBuilder (lines 106-121). When messages are dropped and a snapshot summary is available, it injects a synthetic user/assistant exchange at the start of the truncated messages. The summary is passed through from `SnapshotManager.getLatestSnapshot().summary`.

The current extractive summarizer collects: first 5 user messages (truncated to 150 chars), modified file paths, and key facts. This works as a v1. See Section 10 for the LLM-powered upgrade path.

---

## 7. Tool Definition Budget

~~Originally planned to add a `toolDefinitionTokens` parameter to `ContextBuilder.build()`.~~

**Status: Not needed.** Tool definitions (~730 tokens for 6 workspace tools) are already counted by `countRequestTokens()` during cross-validation. The measured delta between our local count and the API's `prompt_tokens` stabilized at 3.5-5% for chat-with-tools — and the remaining gap is the API's hidden tool-use instruction preamble (~300 tokens we never send), not unaccounted tool definitions. This consistently undercounts, meaning the budget is slightly conservative. Combined with the 95% tool loop check (Phase 3), there's no practical risk of context overflow from unbudgeted tool tokens.

---

## 8. Logging

ContextBuilder already logs via `logger.info()`:

```
[Context] 45,231/119,808 tokens | 12 dropped | summary injected
```

This runs before every API request, giving visibility into:
- How much of the budget is consumed
- Whether messages were dropped
- Whether a snapshot summary was injected

Combined with the existing `[TokenCV]` cross-validation logs (which run after), we get full before/after visibility.

---

## 9. Testing Strategy

### Unit Tests (ContextBuilder)

Already exist at `tests/unit/context/contextBuilder.test.ts`. Cover:
- Budget calculation per model
- Backward-fill truncation
- Snapshot summary injection
- Safety margin for estimation mode

### New Tests Needed

- `getLatestSnapshotSummary()` on ConversationManager (returns summary or undefined)
- `buildContext()` with `toolDefinitionTokens` parameter
- Integration: chatProvider calls buildContext before API (mock verification)

### Manual Verification

1. Start a long conversation (20+ messages)
2. Check `[Context]` logs show truncation happening
3. Verify snapshot summary injection when messages are dropped
4. Check `[TokenCV]` deltas remain stable after truncation

---

## 10. Context Compression — Implemented

LLM-powered summarization with chaining, triggered proactively by context pressure. Implemented across three phases, all complete.

**Status:** All three phases implemented and tested.

### Overview

The context compression system replaces the old event-count-based snapshots with a proactive, context-pressure-driven LLM summarizer. When context usage exceeds 80%, the system automatically summarizes the conversation using DeepSeek itself, creating a high-quality summary that ContextBuilder injects when old messages are dropped.

```
User sends message
    → RequestOrchestrator.handleMessage()
        → buildContext() → stream response → save to history
        → [Post-response] Check context pressure
            → If >80% usage AND no fresh summary:
                → fire onSummarizationStarted
                → ConversationManager.createSnapshot(sessionId)
                    → SnapshotManager.createSnapshot()
                        → createLLMSummarizer() with chaining
                → fire onSummarizationCompleted
    → ChatProvider.drainQueue() (if messages queued during summarization)
```

### Phase 1: LLM Summarizer with Chaining

**Files:**
- `src/events/SnapshotManager.ts` — `createLLMSummarizer()`, `SummarizerChatFn`, `formatEventsForSummary()`
- `src/events/ConversationManager.ts` — `summarizer` option, `hasFreshSummary()`, `createSnapshot()`
- `src/events/index.ts` — barrel exports for `createLLMSummarizer`, `SummarizerChatFn`
- `src/extension.ts` — wires LLM summarizer wrapping `deepSeekClient.chat()`

#### SummarizerFn Interface

```typescript
type SummarizerFn = (events: ConversationEvent[], previousSummary?: string) => Promise<SnapshotContent>;
```

The `previousSummary` parameter enables chaining. On first call it's `undefined`; on subsequent calls it contains the previous snapshot's summary text.

#### SummarizerChatFn Interface

```typescript
interface SummarizerChatFn {
  (messages: Array<{ role: string; content: string }>,
   systemPrompt?: string,
   options?: { maxTokens?: number; temperature?: number }): Promise<{ content: string }>;
}
```

Minimal callback wrapping `DeepSeekClient.chat()`. Keeps the events module dependency-free.

#### How Chaining Works

1. **First summarization** — All raw events formatted via `formatEventsForSummary()` are sent to the LLM with `FIRST_SUMMARY_PROMPT`. No previous summary exists.

2. **Subsequent summarizations** — Only events since the last snapshot are sent, along with the previous snapshot's summary. Uses `CHAINED_SUMMARY_PROMPT`. This bounds input to O(1) per cycle instead of O(n).

3. **SnapshotManager.createSnapshot()** — Loads the latest snapshot, calls `this.summarizer(events, lastSnapshot?.summary)`, stores the result.

#### Event Formatting

`formatEventsForSummary()` converts events to a readable format:
```
User: {content}
Assistant: {content}
[Tool: {toolName}]
[Tool result: success — {truncated result}]
[File edit: {filePath}]
[Web search: {query}]
```

Tool results are truncated to 200 chars. Reasoning events, errors, and session events are skipped.

#### Extractive Fallback

`createExtractSummarizer()` remains as the fallback summarizer. If no LLM summarizer is configured (e.g., in tests or early startup), the extractive version provides basic coverage: first 5 user messages (150 chars each), file paths, and key facts (~200-500 tokens).

### Phase 2: Proactive Context-Pressure Trigger

**Files:**
- `src/providers/requestOrchestrator.ts` — proactive trigger logic, `onSummarizationStarted`/`onSummarizationCompleted` events
- `src/events/ConversationManager.ts` — `hasFreshSummary()`, `createSnapshot()`

#### Trigger Logic (in `RequestOrchestrator.handleMessage()`)

After the response is streamed and saved, context pressure is checked:

```typescript
if (sessionId && contextResult.budget > 0) {
  const usageRatio = contextResult.tokenCount / contextResult.budget;
  if (usageRatio > 0.80 && !this.conversationManager.hasFreshSummary(sessionId)) {
    // Trigger summarization
  }
}
```

**Why >80%:** Leaves headroom for the next user message + response. The summary is ready before ContextBuilder needs to drop messages.

**Why proactive, not reactive:** A reactive trigger creates a one-cycle coverage gap — messages are dropped before a summary exists. Proactive means zero gap.

#### Freshness Check

`ConversationManager.hasFreshSummary(sessionId, threshold=5)` prevents re-triggering on every request once at 80%. It checks if the latest snapshot's `upToSequence` is within `threshold` events of the current sequence.

#### Event-Count Trigger Removal

The old `maybeCreateSnapshot()` call was removed from `recordAssistantMessage()`. The proactive context-pressure trigger in RequestOrchestrator replaces it entirely. `maybeCreateSnapshot()` still exists in SnapshotManager for backward compatibility but is no longer called from the main path.

#### Events

Two new `vscode.EventEmitter` instances:
- `_onSummarizationStarted` — fired before `createSnapshot()` call
- `_onSummarizationCompleted` — fired after (even on error, to ensure queue release)

### Phase 3: Message Queuing

**Files:**
- `src/providers/chatProvider.ts` — `_summarizing` flag, `_pendingMessages` queue, `drainQueue()`, event subscriptions in `wireEvents()`

#### How It Works

If the user sends a message during the 2-5 second post-response summarization window:

1. **Queue:** `_summarizing` is `true`, message is pushed to `_pendingMessages` array
2. **UI feedback:** Webview receives `statusMessage: 'Queued — optimizing context...'`
3. **Drain:** After the normal `handleMessage()` completes, `drainQueue()` processes all queued messages sequentially

```typescript
private async drainQueue(): Promise<void> {
  while (this._pendingMessages.length > 0) {
    const pending = this._pendingMessages.shift()!;
    const result = await this.requestOrchestrator.handleMessage(
      pending.message, this.currentSessionId,
      () => this.fileContextManager.getEditorContext(),
      pending.attachments
    );
    this.currentSessionId = result.sessionId;
  }
}
```

#### Event Subscriptions

In `wireEvents()`:
```typescript
this.requestOrchestrator.onSummarizationStarted(() => {
  this._summarizing = true;
  logger.info('[ChatProvider] Summarization started — queuing enabled');
});
this.requestOrchestrator.onSummarizationCompleted(() => {
  this._summarizing = false;
  logger.info('[ChatProvider] Summarization completed — queuing disabled');
});
```

#### User Experience

| Scenario | What happens |
|----------|-------------|
| Normal message | Instant render + response streams |
| Message during summarization | Instant render + "Queued" status + response ~2-5s later |
| Multiple messages during summarization | All render instantly, all queued, processed sequentially |

User messages render optimistically in the webview before the extension receives them, so queuing is invisible.

### Logging

All three phases produce structured logs with the `[Snapshot]` and `[ChatProvider]` tags:

| Log | Level | Location |
|-----|-------|----------|
| `[Snapshot] Creating snapshot for session=...` | info | `SnapshotManager.createSnapshot()` |
| `[Snapshot] Created in Xms \| summary=N chars...` | info | `SnapshotManager.createSnapshot()` |
| `[Snapshot] LLM summarize (first/chained) \| input=...` | info | `createLLMSummarizer()` |
| `[Snapshot] LLM summarize complete in Xms...` | info | `createLLMSummarizer()` |
| `[Snapshot] LLM summarize failed: ...` | error | `createLLMSummarizer()` |
| `[Snapshot] Extractive summarizer called \| events=N` | debug | `createExtractSummarizer()` |
| `[Snapshot] Extractive summarizer complete \| summary=...` | debug | `createExtractSummarizer()` |
| `[Snapshot] hasFreshSummary: FRESH/STALE \| eventsSince=...` | debug | `ConversationManager.hasFreshSummary()` |
| `[Snapshot] ConversationManager.createSnapshot called` | info | `ConversationManager.createSnapshot()` |
| `[Snapshot] maybeCreateSnapshot skipped \| events=N/M` | debug | `SnapshotManager.maybeCreateSnapshot()` |
| `[Snapshot] Pruning snapshots (keep=N)` | debug | `SnapshotManager.pruneSnapshots()` |
| `[Snapshot] Proactive trigger fired \| usage=X%...` | info | `RequestOrchestrator.handleMessage()` |
| `[Snapshot] Proactive trigger skipped — fresh summary exists` | debug | `RequestOrchestrator.handleMessage()` |
| `[Snapshot] Proactive summarization complete` | info | `RequestOrchestrator.handleMessage()` |
| `[Snapshot] Proactive summarization failed: ...` | error | `RequestOrchestrator.handleMessage()` |
| `[ChatProvider] Summarization started — queuing enabled` | info | `ChatProvider.wireEvents()` |
| `[ChatProvider] Summarization completed — queuing disabled` | info | `ChatProvider.wireEvents()` |
| `[ChatProvider] Message queued during summarization (queue=N)` | info | `ChatProvider sendMessage handler` |
| `[ChatProvider] Draining queued message (remaining=N)` | info | `ChatProvider.drainQueue()` |

### Testing

| Test file | Tests | Coverage |
|-----------|-------|----------|
| `tests/unit/events/SnapshotManager.test.ts` | 13 | `createLLMSummarizer` (first prompt, chained prompt, response mapping, filesModified, keyFacts, token estimation, options passthrough, event formatting, tool result truncation, error propagation, empty events), chaining integration |
| `tests/unit/events/ConversationManager.test.ts` | 7 | `hasFreshSummary` (no snapshot, fresh, stale, custom threshold, all covered), `createSnapshot` delegation, `recordAssistantMessage` no auto-snapshot |
| `tests/unit/providers/requestOrchestrator.test.ts` | 7 | Proactive trigger (>80%, <80%, fresh summary skip, budget=0, error handling, boundary at 80%, trigger at 81%) |
| `tests/unit/providers/chatProvider.queuing.test.ts` | 6 | `drainQueue` (sequential processing, empty queue, sessionId updates, attachments), `_summarizing` flag toggle, queue ordering |

### Trade-offs

| Factor | Extractive (fallback) | LLM with Chaining (primary) |
|--------|---------------------|-----------------------------------|
| User-visible latency | 0ms | 0ms (post-response) |
| API cost per summary | Free | ~1,000-2,000 input tokens |
| Summary quality | Lists first 5 messages | Understands context, goals, decisions |
| Reliability | Always works | Depends on API (extractive is fallback) |
| Coverage gap | Yes (event-count trigger) | No (proactive pressure trigger) |
| Summarizer scaling | N/A | O(1) per cycle (chaining) |
| Code complexity | Minimal | ~100 lines across 3 files |

### Why Not Async

Post-response sync was chosen over async (fire-and-forget) because:
- **Zero user-visible latency** — response is already delivered when summarization runs
- **Zero coverage gap** — summary is ready before next request needs it
- **Simple code** — sequential `await`, no background promise management or race conditions
- **Same UX** — the natural reading/thinking pause hides the 2-5s summarization time

### Edge Case: Oversized Single Message

**TODO (UI needed):** If a single user message exceeds the entire context budget, ContextBuilder cannot fit it. Needs: detection flag on `ContextResult`, request blocking in RequestOrchestrator, UI warning in StatusPanel.

---

## 11. Token Count Caching — Implemented

### Opportunity

ContextBuilder re-tokenizes every message on every request. For a 100-message conversation, that is approximately 100 calls to the WASM tokenizer. Currently this takes 5-10ms total (sub-millisecond per message), so it is not a bottleneck — but it's free to eliminate.

### Implementation: In-Memory Map

An in-memory `Map<string, number>` on the `ContextBuilder` instance caches token counts keyed by stable IDs. Two types of content are cached:

**Event messages** — keyed by `eventId`:

```typescript
// In the token counting loop:
const cached = msg.eventId ? this._tokenCache.get(msg.eventId) : undefined;
if (cached !== undefined) {
  // Cache hit — skip tokenization
  messageCosts.push({ message: msg, tokens: cached });
} else {
  // Cache miss — tokenize and cache
  const tokens = this.tokenCounter.countMessage(msg.role, text);
  if (msg.eventId) { this._tokenCache.set(msg.eventId, tokens); }
}
```

**Snapshot summaries** — keyed by `snapshotId`:

```typescript
// Snapshot summary uses pre-computed tokenCount from the Snapshot record
const summaryTokens = this._tokenCache.get(snapshotSummary.snapshotId)
  ?? snapshotSummary.tokenCount;
this._tokenCache.set(snapshotSummary.snapshotId, summaryTokens);
```

`getLatestSnapshotSummary()` returns a `SnapshotSummary` object (`{ summary, tokenCount, snapshotId }`) instead of a plain string. The pre-computed `tokenCount` from the snapshot record is used directly — no tokenization needed on the first encounter either.

**Event ID threading:** The `eventId` field was added to the `Message` interface. `ConversationManager.getSessionMessagesCompat()` now includes the event store ID in the returned messages, and `RequestOrchestrator` threads it through to `buildContext()`.

**Why in-memory (not DB):**
- Cache dies on extension restart — no staleness risk if the tokenizer changes
- No migration needed, no cache busting logic
- Both event IDs and snapshot IDs are immutable — content never changes for a given ID
- Messages without an ID (tool messages created during the current request) are always tokenized fresh

### Tokenizer Versioning

The WASM tokenizer ships a static `tokenizer.json.br` (1.4 MB compressed, 7.5 MB decompressed) bundled inside the `.vsix`. This asset is pinned to whichever version was built into the extension — it does not auto-update.

**Why cached counts are fragile across tokenizer versions:**

If DeepSeek releases a new model (e.g., V4) with a different tokenizer (new vocab, different merge rules), any token counts cached in the database become wrong. The same text produces different token counts under the old vs new tokenizer. Since the raw text is always stored in events, re-tokenizing on the fly (current approach) is self-correcting — it always uses the active tokenizer. A cache would silently return stale counts until invalidated.

**Version mismatch risk:**

Even without caching, a version mismatch can occur if a user runs an old extension version while DeepSeek silently updates their API tokenizer. The WASM counter would produce confidently wrong counts until the extension is updated. The `EstimationTokenCounter` self-calibration (adjusts ratio from `usage.prompt_tokens`) would detect this drift naturally, but the WASM counter has no such feedback loop.

**Mitigation if caching is implemented:**

- Store a tokenizer version hash alongside cached counts (e.g., SHA-256 of `tokenizer.json`)
- On extension startup, compare the current tokenizer hash to the stored one
- If they differ, invalidate all cached counts (set `token_count = NULL` in the events table)

### Tokenizer Update Script

A periodic check script should be developed to detect when DeepSeek publishes an updated tokenizer. Tokenizer changes are rare (tied to new model releases, not patches to existing models), but catching them early prevents version mismatch drift.

**Approach:**

- Script fetches the latest `tokenizer.json` from HuggingFace (e.g., `https://huggingface.co/deepseek-ai/DeepSeek-V3/resolve/main/tokenizer.json`)
- Compares SHA-256 hash against the currently bundled `packages/moby-wasm/assets/tokenizer.json`
- If hashes differ: logs the change, optionally downloads the new version, and alerts the maintainer
- Can run as a GitHub Actions cron job (e.g., weekly) or a pre-release CI step

**Script location:** `scripts/check-tokenizer-update.sh` (to be created when needed)

### Future: Database-Level Caching

If profiling shows the in-memory cache is insufficient (e.g., conversations exceeding 500+ messages across extension restarts), a database column (`ALTER TABLE events ADD COLUMN token_count INTEGER`) could persist counts across restarts. This would require the PRAGMA migration framework (see [database-cleanup.md](database-cleanup.md)) and tokenizer version hashing for cache invalidation. The in-memory approach is sufficient for now.

---

## 12. Session & Data Lifecycle Management

### Design Decisions

**No artificial limits on snapshots or sessions.** Previously, snapshots were pruned to 5 per session and a `maxSessions` setting existed in the UI. Both limits have been removed:

- **Snapshots:** All snapshots are retained for the lifetime of their session. Each snapshot is ~1-2 KB (summary text + metadata), so even hundreds of snapshots per session are negligible. Snapshots are deleted when their parent session is deleted via `deleteSession()`.
- **Sessions:** No cap on number of sessions. The database grows organically. Users manage sessions through explicit cleanup commands.

### Session Cleanup Commands

Users need easy ways to manage their conversation history. Planned commands:

| Command | Description | Status |
|---------|-------------|--------|
| `Moby: Delete Session` | Delete a single session (events + snapshots) | Infrastructure exists (`ConversationManager.deleteSession()`) |
| `Moby: Delete All Sessions` | Clear all history | Infrastructure exists (`clearAllHistory` message handler) |
| `Moby: Delete Sessions Older Than...` | Bulk cleanup by age (e.g., older than 30 days) | TODO |
| `Moby: Export Session` | Export a session before deleting | TODO |

### What `deleteSession()` Already Cleans Up

`ConversationManager.deleteSession(sessionId)` already cascades properly:
1. `eventStore.deleteSessionEvents(sessionId)` — removes all events
2. `snapshotManager.deleteSessionSnapshots(sessionId)` — removes all snapshots
3. `stmtDeleteSession.run(sessionId)` — removes the session record

No orphaned data is left behind.

### Database Growth Estimates

| Usage Pattern | Sessions/Month | Events/Session | DB Growth/Month |
|---------------|---------------|----------------|-----------------|
| Light (few chats) | 10 | 50 | ~2 MB |
| Moderate (daily use) | 60 | 100 | ~25 MB |
| Heavy (power user) | 200 | 200 | ~150 MB |

At these rates, even heavy users accumulate manageable amounts. The bulk delete commands give users control without imposing arbitrary limits.

### Migration Framework (PRAGMA user_version)

SQLite's `PRAGMA user_version` will be used for schema versioning. This is a single integer stored in the database file header, read in < 1 ms.

```typescript
function runMigrations(db: Database): void {
  const version = db.pragma("user_version", { simple: true }) as number;

  if (version < 1) {
    // Formalize existing schema as version 1
    // (tables already created by CREATE TABLE IF NOT EXISTS)
  }

  // Future: if (version < 2) { ALTER TABLE events ADD COLUMN token_count INTEGER; }

  db.pragma(`user_version = 1`);
}
```

**Release process:**
- Each schema change adds a new `if (version < N)` block
- Runs once during `activate()` before any DB access
- Fresh installs: all migrations run in sequence from 0
- Updates: only new migrations run (skips already-applied ones)
- Downgrades: old code ignores new columns (SQLite is lenient)

---

## 13. Key Files

| File | Role |
|------|------|
| `src/context/contextBuilder.ts` | Budget management, backward-fill, snapshot injection |
| `src/deepseekClient.ts` | `buildContext()` wrapper, cross-validation |
| `src/providers/chatProvider.ts` | Integration point (~line 1648) |
| `src/events/ConversationManager.ts` | Session messages, snapshot access |
| `src/events/SnapshotManager.ts` | Auto-snapshot creation, summarizer |
| `src/services/tokenCounter.ts` | TokenCounter interface, countRequestTokens |
| `src/services/tokenService.ts` | WASM tokenizer |
| `src/tools/workspaceTools.ts` | Tool definitions (~730 tokens) |
| `tests/unit/context/contextBuilder.test.ts` | ContextBuilder unit tests |