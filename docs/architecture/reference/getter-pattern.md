# Getter Pattern in Actors

This document formalizes when and how to use getters vs publications in the actor system.

---

## Three Communication Patterns

| Pattern | Use Case | Example |
|---------|----------|---------|
| **Direct Calls** | Ordered operations, mutations | `turn.completeCurrentTextSegment()` |
| **Publications (Pub/Sub)** | Broadcast state to multiple observers | `manager.publishDirect('history.modal.open', true)` |
| **Getters** | Synchronous single-consumer queries | `turn.isStreaming()` |

---

## When to Use Getters

Getters are appropriate when ALL of these conditions are true:

1. **Single consumer** - Only one caller needs this data
2. **Synchronous** - The caller needs the answer immediately
3. **Query, not mutation** - Reading state, not changing it
4. **Coordination logic** - Making ordering/conditional decisions

### Good Examples

```typescript
// Turn coordination - needs immediate answer for ordering decision
if (turn.isStreaming() && !turn.hasInterleaved()) {
  turn.completeCurrentTextSegment();
}

// Conditional decision based on current state
if (editMode.isValidMode(msg.mode)) {
  editMode.setMode(msg.mode);
}

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
const isStreaming = streaming.isActive;
inputArea.setStreaming(isStreaming);
toolbar.setStreaming(isStreaming);
scroll.setStreaming(isStreaming);

// GOOD: Publish once, actors subscribe
streaming.startStream(...); // Publishes 'streaming.active': true
// InputArea, Toolbar, Scroll all subscribe to 'streaming.active'
```

---

## Current Getter Consumers

### 1. VirtualMessageGatewayActor (Primary Consumer)

The gateway uses getters for **coordination decisions**. Content rendering is
delegated to a single `VirtualListActor` (the old per-type content actors —
message, shell, toolCalls, thinking, pending — were replaced by it):

```typescript
// File: media/actors/message-gateway/VirtualMessageGatewayActor.ts

// Validate edit mode before applying
if (msg.mode && editMode.isValidMode(msg.mode)) {
  editMode.setMode(mode);
}

// Finalize the current text segment when a text-finalize update arrives,
// so the segment drops its streaming placeholder before later content
virtualList.completeCurrentTextSegment(turnId);
```

The segment getters themselves live on `MessageTurnActor`, which `VirtualListActor`
drives per turn (e.g. `isStreaming()`, `getCurrentSegmentContent()`, `hasInterleaved()`).

### 2. chat.ts (Entry Point Wiring)

The entry point uses getters for **UI initialization and event handlers**:

```typescript
// File: media/chat.ts

// Close competing dropdowns
if (settings?.isVisible()) settings.close();
if (modelSelector?.isVisible()) modelSelector.close();

// Initialize actors with current state
const initialEditMode = editModeActor.getMode();
toolbar.setEditMode(initialEditMode);
virtualList.setEditMode(initialEditMode);
```

`media/dev.ts` also reads getters when wiring dev-only UI:

```typescript
// File: media/dev.ts

// Toggle inspector button state
inspectorBtn.classList.toggle('active', inspector.isVisible());
```

---

## Naming Conventions

| Prefix | Returns | Example |
|--------|---------|---------|
| `is*` | boolean | `isStreaming()`, `isVisible()`, `isValidMode(mode)` |
| `has*` | boolean | `hasInterleaved()`, `hasPendingInterrupt()` |
| `get*` | data | `getMode()`, `getCurrentSegmentContent()` |

---

## Implementation Guidelines

### 1. Keep Getters Simple

Getters should be pure reads, not compute-heavy:

```typescript
// GOOD: Direct state access
isStreaming(): boolean {
  return this._isStreaming;
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
 * Whether non-text content (shell/tools/thinking) has been interleaved
 * into this turn. Used by: MessageTurnActor coordination when deciding
 * whether to start a fresh text segment.
 */
hasInterleaved(): boolean {
  return this._hasInterleaved;
}
```

---

## Why No Registry System?

A getter registry was considered but rejected because:

1. **Type safety already exists** - TypeScript provides compile-time safety
2. **Scoped consumers** - Getters are read at a handful of coordination points (gateway, entry point in `chat.ts`/`dev.ts`, and a few shadow actors), not broadcast widely
3. **No multi-consumer pattern** - Getters are 1:1, not 1:N
4. **Overhead** - Registry adds indirection without benefit
5. **Debugging** - Direct calls are easier to trace than registry lookups

If getter usage expands significantly or multi-consumer patterns emerge, revisit this decision.

---

## Related Documentation

- [message-gateway.md](../frontend/message-gateway.md) - Gateway pattern and coordination state
- [actor-diagram.md](../overview/actor-diagram.md) - Actor relationships
- [media/state/EventStateActor.ts](../../../media/state/EventStateActor.ts) - Base actor with publication system

