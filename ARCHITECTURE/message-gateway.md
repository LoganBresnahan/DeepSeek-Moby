# Message Gateway Architecture

The MessageGatewayActor implements the **Gateway Pattern** (also known as Anti-Corruption Layer) to connect the external VS Code extension system with the internal actor system.

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

## The Solution: MessageGatewayActor

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        EXTERNAL BOUNDARY                                         │
│                                                                                  │
│  window.addEventListener('message', ...)                                         │
│                           │                                                      │
│                           ▼                                                      │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │              MessageGatewayActor                                             ││
│  │                                                                              ││
│  │  Coordination State:                                                         ││
│  │    - _segmentContent: string     (accumulated streaming content)             ││
│  │    - _hasInterleaved: boolean    (tools/thinking interrupted text)           ││
│  │    - _shellSegmentId: string     (pending shell operation)                   ││
│  │    - _phase: GatewayPhase        (idle/streaming/waiting-for-results)        ││
│  │                                                                              ││
│  │  Responsibilities:                                                           ││
│  │    1. Receive ALL external messages                                          ││
│  │    2. Maintain coordination state                                            ││
│  │    3. Orchestrate actors with ordering guarantees                            ││
│  │    4. Translate external protocol → internal calls                           ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
    Direct calls      Pub/sub         Getters
    (ordering)       (broadcast)     (queries)
          │                │                │
          ▼                ▼                ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                      INTERNAL ACTOR SYSTEM                                       │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Why Not Pure Pub/Sub?

### 1. Ordering Guarantees

With the gateway, this sequence is **guaranteed**:

```typescript
case 'shellExecuting':
  // 1. Finalize current text segment FIRST
  message.finalizeCurrentSegment();
  // 2. Mark that we've interleaved
  this._hasInterleaved = true;
  // 3. THEN create shell segment (appears after text in DOM)
  shell.createSegment(msg.commands);
```

With pure pub/sub, if multiple actors subscribe to the same event, order is **undefined**.

### 2. Atomicity

The gateway case is **atomic** within a single event loop tick:

```typescript
case 'streamToken':
  this._segmentContent += msg.token;           // Step 1
  const display = this.stripShellTags(content); // Step 2
  message.updateCurrentSegmentContent(display); // Step 3
  streaming.handleContentChunk(msg.token);      // Step 4
```

No other code runs between these lines.

### 3. Conditional Logic

The gateway can make decisions based on current state:

```typescript
if (message.isStreaming() && !this._hasInterleaved) {
  message.finalizeCurrentSegment();
  this._hasInterleaved = true;
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
this._segmentContent += token; message.updateCurrentSegmentContent(content);
```

The pub/sub path has constant overhead per token that adds up at high frequency.

---

## Coordination State

### _segmentContent

Accumulates streamed content for the current segment.

```
Timeline:
─────────────────────────────────────────────────────────────►
│         │              │           │              │
startResponse  streamToken   streamToken   shellExecuting  endResponse
│         │              │           │              │
│         └──────────────┴───────────┘              │
│         _segmentContent accumulates               │
│                                    │              │
│                                    reset          │
```

### _hasInterleaved

Tracks whether tools/thinking interrupted text flow. Used to prevent duplicate content.

```
Without interleaving:
  [text segment]──────────────────────►[endResponse uses content]

With interleaving:
  [text segment]──►[finalize]──►[tools]──►[more text]──►[endResponse skips content]
```

### _shellSegmentId

Tracks pending shell operation between `shellExecuting` and `shellResults`.

```
shellExecuting ──► create segment ──► store ID
        ...waiting...
shellResults ──► use ID ──► clear ID
```

### _phase

Current streaming phase for debugging: `'idle' | 'streaming' | 'waiting-for-results'`

---

## Communication Patterns

### 1. Direct Method Calls (Ordering)

For operations that require specific order:

```typescript
message.finalizeCurrentSegment();
shell.createSegment(commands);
shell.startSegment(segmentId);
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
if (message.isStreaming()) { ... }
if (message.needsNewSegment()) { ... }
```

---

## Message Categories

The gateway handles ~40 message types in categories:

| Category | Messages | Handler Pattern |
|----------|----------|-----------------|
| Streaming | startResponse, streamToken, streamReasoning, iterationStart, endResponse | Direct calls + state tracking |
| Session | sessionLoaded, sessionCreated, sessionError | Direct calls to SessionActor |
| Shell | shellExecuting, shellResults | Direct calls + segment ID tracking |
| Tool Calls | toolCallsStart, toolCallUpdate, toolCallsEnd | Direct calls |
| Pending Files | pendingFileAdd, diffListChanged, etc. | Direct calls + segment finalization |
| History | loadHistory, addMessage, clearChat | Direct calls |
| Settings | settings, editModeSettings, modelChanged | Direct + pub/sub (SessionActor + ModelSelector) |
| Files | openFiles, searchResults, fileContent | Pub/sub broadcast |
| Status | error, warning, statusMessage | Direct calls to StatusPanel |

---

## Testing

The gateway can be tested in isolation by mocking actor references:

```typescript
const mockActors = {
  streaming: { startStream: jest.fn(), endStream: jest.fn() },
  message: { addUserMessage: jest.fn(), isStreaming: () => false },
  // ... etc
};

const gateway = new MessageGatewayActor(manager, element, vscode, mockActors);

// Simulate message
window.dispatchEvent(new MessageEvent('message', {
  data: { type: 'startResponse', messageId: 'test-123' }
}));

expect(mockActors.streaming.startStream).toHaveBeenCalled();
```

---

## Observability

The gateway publishes its coordination state for debugging:

```typescript
publications: {
  'gateway.segmentContent': () => this._segmentContent,
  'gateway.interleaved': () => this._hasInterleaved,
  'gateway.phase': () => this._phase,
}
```

Access via browser console:
```javascript
window.actorManager.getState('gateway.phase')     // 'streaming'
window.actorManager.getState('gateway.interleaved') // true
```

---

## Related Patterns

| Pattern | Description |
|---------|-------------|
| **Gateway** | Adapts external protocol to internal model |
| **Anti-Corruption Layer** | Protects domain model from external concerns |
| **Adapter** | Translates between two interfaces |
| **Facade** | Simplifies complex subsystem interaction |
| **Mediator** | Centralizes complex communications |

The MessageGatewayActor combines aspects of all these patterns to create a clean boundary between the VS Code extension and the actor system.

---

## File Location

```
media/actors/message-gateway/
├── MessageGatewayActor.ts   # Main implementation
└── index.ts                 # Exports
```

See also:
- [actor-diagram.md](actor-diagram.md) - Visual actor map
- [getter-pattern.md](getter-pattern.md) - When to use getters vs publications
- [media/actors/index.ts](../media/actors/index.ts) - Actor exports
