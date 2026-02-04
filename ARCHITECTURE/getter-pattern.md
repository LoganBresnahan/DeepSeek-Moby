# Getter Pattern in Actors

This document formalizes when and how to use getters vs publications in the actor system.

---

## Three Communication Patterns

| Pattern | Use Case | Example |
|---------|----------|---------|
| **Direct Calls** | Ordered operations, mutations | `message.finalizeCurrentSegment()` |
| **Publications (Pub/Sub)** | Broadcast state to multiple observers | `manager.publishDirect('streaming.active', true)` |
| **Getters** | Synchronous single-consumer queries | `message.isStreaming()` |

---

## When to Use Getters

Getters are appropriate when ALL of these conditions are true:

1. **Single consumer** - Only one caller needs this data
2. **Synchronous** - The caller needs the answer immediately
3. **Query, not mutation** - Reading state, not changing it
4. **Coordination logic** - Making ordering/conditional decisions

### Good Examples

```typescript
// Gateway coordination - needs immediate answer for ordering decision
if (message.isStreaming() && !this._hasInterleaved) {
  message.finalizeCurrentSegment();
}

// Conditional update based on current state
const currentCalls = toolCalls.getCalls();
if (currentCalls[msg.index]) { ... }

// UI coordination - close competing dropdowns
if (modelSelector?.isVisible()) modelSelector.close();
```

### When NOT to Use Getters

Use **publications** instead when:

- Multiple actors need the same state
- State changes should trigger reactions
- Debugging/inspector needs visibility

```typescript
// BAD: Multiple actors observing this
const isStreaming = streaming.isStreaming();
inputArea.setStreaming(isStreaming);
toolbar.setStreaming(isStreaming);
statusPanel.setStreaming(isStreaming);

// GOOD: Publish once, actors subscribe
streaming.startStream(...); // Publishes 'streaming.active': true
// InputArea, Toolbar, StatusPanel all subscribe to 'streaming.active'
```

---

## Current Getter Consumers

### 1. MessageGatewayActor (Primary Consumer)

The gateway uses getters for **coordination decisions**:

```typescript
// File: media/actors/message-gateway/MessageGatewayActor.ts

// Check if we need to start new segment after interleaving
if (message.needsNewSegment()) {
  message.resumeWithNewSegment();
}

// Finalize segment before tools/thinking (6 usages)
if (message.isStreaming() && !this._hasInterleaved) {
  message.finalizeCurrentSegment();
}

// Update specific tool call by index
const currentCalls = toolCalls.getCalls();
if (currentCalls[msg.index]) { ... }

// Sync pending files with backend diff list
const currentFiles = pending.getFiles();

// Validate edit mode before applying
if (editMode.isValidMode(msg.mode)) { ... }
```

### 2. chat.ts (Entry Point Wiring)

The entry point uses getters for **UI initialization and event handlers**:

```typescript
// File: media/chat.ts

// Toggle button state
inspectorBtn.classList.toggle('active', inspector.isVisible());

// Close competing dropdowns
if (settings?.isVisible()) settings.close();
if (modelSelector?.isVisible()) modelSelector.close();

// Initialize actors with current state
const initialEditMode = editModeActor.getMode();
pending.setEditMode(initialEditMode);

// Handler needs file data for backend message
const file = pending.getFiles().find(f => f.id === fileId);
```

---

## Naming Conventions

| Prefix | Returns | Example |
|--------|---------|---------|
| `is*` | boolean | `isStreaming()`, `isVisible()`, `isCollapsed(id)` |
| `has*` | boolean | `hasErrors()`, `hasContent()`, `hasPending()` |
| `needs*` | boolean | `needsNewSegment()` |
| `get*` | data | `getFiles()`, `getCalls()`, `getMode()` |

---

## Implementation Guidelines

### 1. Keep Getters Simple

Getters should be pure reads, not compute-heavy:

```typescript
// GOOD: Direct state access
isStreaming(): boolean {
  return this._currentSegment !== null;
}

// AVOID: Complex computation
isStreaming(): boolean {
  return this._segments.filter(s => !s.complete).some(s => s.lastUpdate > Date.now() - 1000);
}
```

### 2. Consider Publications for Observable State

If you add a getter and find multiple callers emerging, convert to publication:

```typescript
// Started as getter
hasErrors(): boolean { return this._errors.length > 0; }

// Multiple actors need this? Convert to publication:
publications: {
  'shell.hasErrors': () => this._errors.length > 0,
}
```

### 3. Document the Consumer

When adding a getter, add a comment noting who uses it:

```typescript
/**
 * Check if new segment needed after interleaving.
 * Used by: MessageGatewayActor for streamToken handling
 */
needsNewSegment(): boolean {
  return this._segmentFinalized && !this._currentSegment;
}
```

---

## Why No Registry System?

A getter registry was considered but rejected because:

1. **Type safety already exists** - TypeScript provides compile-time safety
2. **Limited consumers** - Only 2 locations use getters (gateway, entry point)
3. **No multi-consumer pattern** - Getters are 1:1, not 1:N
4. **Overhead** - Registry adds indirection without benefit
5. **Debugging** - Direct calls are easier to trace than registry lookups

If getter usage expands significantly or multi-consumer patterns emerge, revisit this decision.

---

## Related Documentation

- [message-gateway.md](message-gateway.md) - Gateway pattern and coordination state
- [actor-diagram.md](actor-diagram.md) - Actor relationships
- [media/state/EventStateActor.ts](../media/state/EventStateActor.ts) - Base actor with publication system

