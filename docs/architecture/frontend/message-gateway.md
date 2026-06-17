# Message Gateway Architecture

The VirtualMessageGatewayActor implements the **Gateway Pattern** (also known as Anti-Corruption Layer) to connect the external VS Code extension system with the internal actor system.

---

## The Problem

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        EXTERNAL SYSTEM                                           │
│                     (VS Code Extension)                                          │
│                                                                                  │
│   Sends messages at arbitrary times, in arbitrary order                          │
│   No guarantees about timing or atomicity                                        │
│   High frequency during streaming (50-100 tokens/sec)                            │
└─────────────────────────────────────────────────────────────────────────────────┘
                                   │
                                   │ How do we connect this to...
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                      INTERNAL ACTOR SYSTEM                                       │
│                                                                                  │
│   Actors own their DOM and state                                                 │
│   Communication via pub/sub                                                      │
│   Need ordering guarantees for coordinated operations                            │
│   Need atomicity for multi-step operations                                       │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Challenges

1. **Ordering**: When `streamToken` arrives, we might need to finalize a segment before showing tools
2. **Atomicity**: Multiple operations must happen together (finalize + mark interleaved + create shell)
3. **State Across Messages**: Streaming sessions span many messages that share state
4. **Performance**: Pure pub/sub is too slow for per-token streaming

---

## The Solution: VirtualMessageGatewayActor

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        EXTERNAL BOUNDARY                                         │
│                                                                                  │
│  window.addEventListener('message', ...)                                         │
│                           │                                                      │
│                           ▼                                                      │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │              VirtualMessageGatewayActor                                      ││
│  │                                                                              ││
│  │  Coordination State:                                                         ││
│  │    - _currentTurnId: string     (active turn being streamed)                 ││
│  │    - _phase: GatewayPhase       (idle/streaming/waiting-for-results)         ││
│  │                                                                              ││
│  │  Responsibilities:                                                           ││
│  │    1. Receive ALL external messages                                          ││
│  │    2. Maintain coordination state                                            ││
│  │    3. Route to VirtualListActor (turn-based API)                             ││
│  │    4. Translate external protocol → internal calls                           ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────────┘
                           │
                           │ Turn-based API calls
                           ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                      VirtualListActor                                            │
│                                                                                  │
│   Manages pool of MessageTurnActor instances                                     │
│   Each turn contains: text, thinking, tools, shell, pending content             │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Unified Turn Architecture (CQRS Event Sourcing)

The gateway does **not** make direct per-message `VirtualListActor` calls. Each external
message handler appends a `TurnEvent` to a per-turn `TurnEventLog`, then runs it through
the shared `TurnProjector` (`emitTurnEvent()` → `projectIncremental()`). The projector
produces `ViewSegment` mutations, which `renderSegment()` / `updateRenderedSegment()` map
to the actual `VirtualListActor` calls. This CQRS / event-sourcing pipeline (`TurnEventLog`,
`TurnProjector`, `ViewSegment`, `_projector`, `_turnLogs`) is the real mechanism — the
table below shows the `TurnEvent` each message emits, not a direct method call:

| External Message | Emitted TurnEvent (→ projector → render) |
|------------------|------------------------------------------|
| `startResponse` | resets CQRS state, fresh `TurnEventLog`; `virtualList.addTurn(turnId, 'assistant', { model, timestamp })` + `startStreamingTurn(turnId)` |
| `streamToken` | `{ type: 'text-append', content: token }` |
| `iterationStart` | finalizes prior thinking/text and advances the iteration counter (no thinking-start here) |
| `streamReasoning` | `{ type: 'thinking-start' }` (first token only) then `{ type: 'thinking-content' }` |
| `toolCallsStart` | `{ type: 'tool-batch-start' }` |
| `shellExecuting` | `emitTextFinalizeIfOpen()` then `{ type: 'shell-start' }` |
| `diffListChanged` | appends `{ type: 'file-modified' }` and calls `virtualList.addPendingFile(turnId, ...)` |
| `endResponse` | finalizes the log, then `virtualList.endStreamingTurn()` (no arg) |

Segment rendering maps `ViewSegment` types to `VirtualListActor` methods inside
`renderSegment()`/`updateRenderedSegment()` — e.g. a `thinking` segment calls
`startThinkingIteration()` + `updateThinkingContent()`, a `shell` segment calls
`createShellSegment()`, a `tool-batch` segment calls `startToolBatch()`.

---

## Why Not Pure Pub/Sub?

### 1. Ordering Guarantees

With the gateway, this sequence is **guaranteed** (inside `handleShellExecuting()`):

```typescript
// 1. Finalize the open text segment FIRST (if any)
this.emitTextFinalizeIfOpen(turnId);
// 2. THEN emit a shell-start event; the projector emits a shell ViewSegment,
//    and renderSegment() calls virtualList.createShellSegment() after the text.
this.emitTurnEvent(turnId, { type: 'shell-start', id: shellId, commands, ... });
```

With pure pub/sub, if multiple actors subscribe to the same event, order is **undefined**.

### 2. Atomicity

The gateway handler is **atomic** within a single event loop tick (`handleStreamToken()`):

```typescript
// Step 1: append a text-append event → projector → renderSegment()
this.emitTurnEvent(turnId, { type: 'text-append', content: token, ... });
// Step 2: forward the raw token to the streaming actor
streaming.handleContentChunk(token);
```

No other code runs between these lines. `<shell>...</shell>` stripping is **not** done
here — it happens later at render time inside `renderSegment()`/`updateRenderedSegment()`
(an inline `replace(/<shell>[\s\S]*?<\/shell>/gi, '')`) and **only** in reasoner mode
(`session.model === 'deepseek-reasoner'`).

### 3. Conditional Logic

The gateway can make decisions based on current state:

```typescript
const turn = virtualList.getTurn(turnId);
if (turn && turn.isStreaming) {
  this.emitTextFinalizeIfOpen(turnId);
}
```

With pure pub/sub, this requires circular dependencies or a coordinator actor anyway.

### 4. Performance

Per-token streaming: ~50-100 tokens/second

**Pure pub/sub path:**
```
handleMessage() → deepClone() → updateGlobalState() → broadcast() → O(n) actors
```

**Direct method call:**
```
virtualList.updateTextContent(turnId, content);
```

The pub/sub path has constant overhead per token that adds up at high frequency.

---

## Coordination State

### _currentTurnId

Tracks the active turn being streamed.

```
Timeline:
─────────────────────────────────────────────────────────────►
│         │              │           │              │
startResponse  streamToken   streamToken   shellExecuting  endResponse
│         │              │           │              │
│         └──────────────┴───────────┘              │
│         all operations target _currentTurnId      │
│                                    │              │
│                                    │         clear│
```

### _phase

Current streaming phase for debugging: `'idle' | 'streaming' | 'waiting-for-results'`

---

## Communication Patterns

### 1. Direct Method Calls to VirtualListActor

Turn lifecycle calls are made directly from the message handlers:

```typescript
virtualList.addTurn(turnId, 'assistant', { model, timestamp });
virtualList.startStreamingTurn(turnId);
virtualList.endStreamingTurn();   // no arg — streaming turn id is tracked internally
```

Content operations (`updateTextContent`, `startThinkingIteration`,
`updateThinkingContent`, `createShellSegment`, `startToolBatch`, `addPendingFile`)
are **not** called directly from the handlers — they are invoked by
`renderSegment()`/`updateRenderedSegment()` as the projector emits `ViewSegment`
mutations.

### 2. Pub/Sub (Broadcast State)

For state that multiple actors need:

```typescript
this._manager.publishDirect('model.current', msg.model);
this._manager.publishDirect('history.sessions', msg.sessions);
```

### 3. Getters (Synchronous Queries)

For single-consumer synchronous checks:

```typescript
if (virtualList.isStreaming(turnId)) { ... }
```

---

## Message Categories

The gateway's `handleMessage()` switch handles ~60 message types in categories:

| Category | Messages | Handler Pattern |
|----------|----------|-----------------|
| Streaming | startResponse, streamToken, streamReasoning, iterationStart, endResponse | VirtualListActor turn methods |
| Session | sessionLoaded, sessionCreated, sessionError | Direct calls to SessionActor |
| Shell | shellExecuting, shellResults | VirtualListActor shell methods |
| Tool Calls | toolCallsStart, toolCallUpdate, toolCallsEnd | VirtualListActor tool methods |
| Pending Files | pendingFileAdd, diffListChanged, etc. | VirtualListActor pending methods |
| History | loadHistory, addMessage, clearChat | VirtualListActor + History |
| Settings | settings, editModeSettings, modelChanged | Direct + pub/sub |
| Files | openFiles, searchResults, fileContent | Pub/sub broadcast |
| Status | error, warning, statusMessage | Pub/sub `publishDirect('status.message', ...)` (error also ends the current streaming turn) |

---

## Content Batching Rules

The gateway merges consecutive same-type content into single UI containers. Different content types create visual separation.

### The Rule

**Consecutive same-type content → MERGE into one dropdown**
**Different content type in between → SEPARATE dropdowns**

### Example Flow

```
Backend sends:
  toolCallsStart (read_file)       ─┐
  toolCallsEnd                      │ These merge into
  toolCallsStart (edit_file) ─┘ [Used 2 tools]
  diffListChanged                   → [Modified Files 1 pending]
  toolCallsEnd
  toolCallsStart (read_file)       ─┐ These merge into
  toolCallsEnd                      │ [Used 2 tools]
  toolCallsStart (edit_file) ─┘
  diffListChanged                   → [Modified Files 1 pending]
  toolCallsEnd
  toolCallsStart (read_file)        → [Used 1 tool]
  toolCallsEnd

UI displays:
  [Used 2 tools] read_file, edit_file
  [Modified Files] wow.rb
  [Used 2 tools] read_file, edit_file
  [Modified Files] wow.rb
  [Used 1 tool] read_file
```

### Implementation

**Backend (requestOrchestrator.ts — the tool-call loop):**
- Accumulates a tool batch across each iteration
- Fires `_onToolCallsEnd` to close the batch at every tool-iteration boundary (and on
  ask-mode approval that closes a batch mid-loop)
- When a file was modified in the iteration, calls `diffManager.emitAutoAppliedChanges()`
  (keeping the batch open) so the Modified Files UI updates
- Next iteration starts a fresh tool batch

**Backend bridge (chatProvider.ts):**
- Only forwards the orchestrator's events (`toolCallsStart`, `toolCallsUpdate`,
  `toolCallsEnd`) and `diffManager`'s `diffListChanged` to the webview

**Frontend (VirtualMessageGatewayActor.ts):**
- `toolCallsStart` creates a new tools container in the turn
- `toolCallsUpdate` adds tools to the existing container
- `toolCallsEnd` marks the batch complete
- `diffListChanged` creates/updates the pending files container

### Content Types and Separation

| Content Type | Creates New Batch When |
|--------------|----------------------|
| Tools (`toolCallsStart`) | After different content type |
| Modified Files (`diffListChanged`) | After different content type |
| Shell Commands (`shellExecuting`) | After different content type |
| Text (`streamToken`) | After different content type |
| Thinking (`iterationStart`) | After different content type |

---

## File Location

```
media/actors/message-gateway/
├── VirtualMessageGatewayActor.ts   # Main implementation
└── index.ts                        # Exports

media/events/
├── TurnEventLog.ts                 # Per-turn append-only event log
└── TurnProjector.ts                # Projects events → ViewSegment[]
```

See also:
- [actor-diagram.md](../overview/actor-diagram.md) - Visual actor map
- [actor-system.md](actor-system.md) - Unified Turn Architecture details
- [getter-pattern.md](../reference/getter-pattern.md) - When to use getters vs publications
- [History Persistence Guide](../../guides/history-persistence.md) - How `handleLoadHistory()` restores conversations
