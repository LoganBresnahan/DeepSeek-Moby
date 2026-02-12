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
10. [Future: LLM-Powered Summarization](#10-future-llm-powered-summarization)
11. [Future: Token Count Caching](#11-future-token-count-caching)
12. [Key Files](#12-key-files)

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
| ContextBuilder doesn't account for tool definitions | ~730 tokens unbudgeted when tools are active | Future (Section 7) |
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

Tool definitions cost approximately 730 tokens for all 6 workspace tools. This is a fixed cost per request when tools are active (deepseek-chat model only; deepseek-reasoner uses shell commands, no tool definitions).

The caller should compute tool definition tokens once and pass them to `buildContext()`:

```typescript
const toolTokens = tools
  ? this.tokenCounter.count(JSON.stringify(tools))
  : 0;

const contextResult = await this.deepSeekClient.buildContext(
  historyMessages,
  systemPrompt,
  snapshotSummary,
  toolTokens
);
```

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

## 10. Future: LLM-Powered Summarization

The current extractive summarizer is basic - it grabs the first 5 user messages and file names. An LLM-powered summarizer would produce much better context preservation.

### Design

The key insight: **the LLM should write the summary for itself.** It knows what context it needs to continue a conversation effectively. The prompt would be something like:

```
Summarize the following conversation history. Your summary will be injected
as context at the start of future requests in this conversation when older
messages are dropped to fit the context window. Include:
- What the user is working on and their goals
- Key decisions made and their rationale
- Current state of any code changes
- Any constraints or preferences the user expressed
```

### Implementation

The `SummarizerFn` type already supports this - it's `(events: ConversationEvent[]) => Promise<SnapshotContent>`. Replace `createExtractSummarizer()` with an LLM-powered version that calls `deepSeekClient.chat()` with the events formatted as conversation history.

### Trade-offs

| Factor | Extractive (current) | LLM-powered (future) |
|--------|---------------------|---------------------|
| Latency | ~0ms | 2-5 seconds |
| API cost | Free | ~500-1000 tokens per snapshot |
| Quality | Lists user messages | Understands context, goals, state |
| Reliability | Always works | Depends on API availability |

### When to Implement

When users report context quality issues after truncation. The extractive summarizer is good enough for short-to-medium conversations. LLM summarization becomes important for very long sessions (50+ messages) where the dropped context contains important decisions.

---

## 11. Future: Token Count Caching

### Opportunity

ContextBuilder re-tokenizes every message on every request. For a 100-message conversation, that is approximately 100 calls to the WASM tokenizer. Currently this takes 5-10ms total (sub-millisecond per message), so it is not a bottleneck.

### Design

Cache a single integer (token count) alongside each event in the database. When ContextBuilder runs, it reads pre-computed counts instead of re-tokenizing:

```sql
-- Add column to events table
ALTER TABLE events ADD COLUMN token_count INTEGER;
```

```typescript
// On event recording
const tokenCount = tokenCounter.countMessage(role, content);
eventStore.append(sessionId, event, tokenCount);

// In ContextBuilder -- use cached count if available
const tokens = cachedTokenCount ?? this.tokenCounter.countMessage(msg.role, text);
```

### Why Not Now

- Tokenization is already sub-millisecond per message
- `ContextBuilder.build()` for 100 messages takes 5-10ms total
- Adding a database column and migration adds complexity
- If DeepSeek changes their tokenizer, cached counts become stale (text is the durable format)

### When to Implement

When profiling shows ContextBuilder is a bottleneck, or when conversations regularly exceed 500+ messages. The break-even point is when the database read (cached integer) is faster than the WASM tokenization call, which is unlikely to matter until message counts are very high.

---

## 12. Key Files

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