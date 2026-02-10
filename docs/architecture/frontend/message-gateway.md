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

### Unified Turn Architecture

The gateway routes all content to `VirtualListActor`, which manages turn-based rendering:

| External Message | Gateway Action |
|------------------|----------------|
| `startResponse` | `virtualList.addTurn(turnId, 'assistant')` |
| `streamToken` | `virtualList.updateTextContent(turnId, content)` |
| `iterationStart` | `virtualList.startThinkingIteration(turnId)` |
| `streamReasoning` | `virtualList.updateThinking(turnId, content)` |
| `toolCallsStart` | `virtualList.startToolBatch(turnId, tools)` |
| `shellExecuting` | `virtualList.createShellSegment(turnId, commands)` |
| `diffListChanged` | `virtualList.updatePendingFiles(turnId, files)` |
| `endResponse` | `virtualList.endStreamingTurn(turnId)` |

---

## Why Not Pure Pub/Sub?

### 1. Ordering Guarantees

With the gateway, this sequence is **guaranteed**:

```typescript
case 'shellExecuting':
  // 1. Finalize current text segment FIRST
  virtualList.finalizeTextSegment(turnId);
  // 2. THEN create shell segment (appears after text in DOM)
  virtualList.createShellSegment(turnId, msg.commands);
```

With pure pub/sub, if multiple actors subscribe to the same event, order is **undefined**.

### 2. Atomicity

The gateway case is **atomic** within a single event loop tick:

```typescript
case 'streamToken':
  const display = this.stripShellTags(content);  // Step 1
  virtualList.updateTextContent(turnId, display); // Step 2
  streaming.handleContentChunk(msg.token);        // Step 3
```

No other code runs between these lines.

### 3. Conditional Logic

The gateway can make decisions based on current state:

```typescript
if (virtualList.isStreaming(turnId)) {
  virtualList.finalizeTextSegment(turnId);
}
```

With pure pub/sub, this requires circular dependencies or a coordinator actor anyway.

### 4. Performance

Per-token streaming: ~50-100 tokens/second

**Pure pub/sub path:**
```
handleExternalMessage() → deepClone() → updateGlobalState() → broadcast() → O(n) actors
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

For turn-based content operations:

```typescript
virtualList.addTurn(turnId, 'assistant');
virtualList.updateTextContent(turnId, content);
virtualList.startThinkingIteration(turnId);
virtualList.endStreamingTurn(turnId);
```

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

The gateway handles ~40 message types in categories:

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
| Status | error, warning, statusMessage | Direct calls to StatusPanel |

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
  toolCallsStart (apply_code_edit) ─┘ [Used 2 tools]
  diffListChanged                   → [Modified Files 1 pending]
  toolCallsEnd
  toolCallsStart (read_file)       ─┐ These merge into
  toolCallsEnd                      │ [Used 2 tools]
  toolCallsStart (apply_code_edit) ─┘
  diffListChanged                   → [Modified Files 1 pending]
  toolCallsEnd
  toolCallsStart (read_file)        → [Used 1 tool]
  toolCallsEnd

UI displays:
  [Used 2 tools] read_file, apply_code_edit
  [Modified Files] wow.rb
  [Used 2 tools] read_file, apply_code_edit
  [Modified Files] wow.rb
  [Used 1 tool] read_file
```

### Implementation

**Backend (chatProvider.ts):**
- Accumulates tools across iterations until a file modification happens
- When `apply_code_edit` succeeds in auto mode, closes the current tool batch
- Sends `toolCallsEnd` followed by `diffListChanged`
- Next iteration starts a fresh tool batch

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
```

See also:
- [actor-diagram.md](../overview/actor-diagram.md) - Visual actor map
- [actor-system.md](actor-system.md) - Unified Turn Architecture details
- [getter-pattern.md](../reference/getter-pattern.md) - When to use getters vs publications
- [History Persistence Guide](../../guides/history-persistence.md) - How `handleLoadHistory()` restores conversations
