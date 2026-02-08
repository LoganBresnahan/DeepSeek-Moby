# Actor System

The actor system is the foundation of the webview's UI architecture. It provides decoupled, event-driven communication between components.

## Core Components

### EventStateManager

The central coordinator that manages all actor communication.

```
┌─────────────────────────────────────────────────────────────────┐
│                      EventStateManager                           │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ globalState  │  │   actors     │  │   injectedStyles      │  │
│  │ {key: value} │  │ Map<id, reg> │  │   Set<actorId>        │  │
│  └──────────────┘  └──────────────┘  └───────────────────────┘  │
│                                                                  │
│  Methods:                                                        │
│  ├─ register(actor, initialState)                               │
│  ├─ unregister(actorId)                                         │
│  ├─ handleStateChange(event)                                    │
│  ├─ publishDirect(key, value)  ◄── External injection           │
│  ├─ getState(key)                                               │
│  └─ injectStyles(actorId, css)                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Location**: [media/state/EventStateManager.ts](../media/state/EventStateManager.ts)

### Actor Registration

Each actor registers with:
- `actorId`: Unique identifier
- `publicationKeys`: Keys this actor can publish
- `subscriptionKeys`: Keys this actor listens to (supports wildcards)
- `element`: DOM element for event dispatch

```typescript
interface ActorRegistration {
  actorId: string;
  publicationKeys: string[];
  subscriptionKeys: string[];
  element: HTMLElement;
}
```

## Pub/Sub Flow

### Publishing State

When an actor publishes state:

```
Actor.publish({ 'streaming.active': true })
         │
         ▼
┌─────────────────────────────────────┐
│     EventStateManager               │
│                                     │
│  1. Check circular dependency       │
│  2. Check chain depth (max 10)      │
│  3. Update globalState if changed   │
│  4. Broadcast to subscribers        │
└──────────────────┬──────────────────┘
                   │
         ┌─────────┴─────────┐
         ▼                   ▼
   ┌──────────┐        ┌──────────┐
   │ Actor A  │        │ Actor B  │
   │ (subs to │        │ (subs to │
   │ streaming│        │ streaming│
   │ .active) │        │ .*)      │
   └──────────┘        └──────────┘
```

### Subscription Patterns

Actors can subscribe with wildcards:

```typescript
// Exact match
subscriptionKeys: ['streaming.active']

// Wildcard - matches any key starting with 'streaming.'
subscriptionKeys: ['streaming.*']

// Multiple subscriptions
subscriptionKeys: ['streaming.active', 'message.*', 'session.id']
```

### State Change Event

```typescript
interface StateChangeEvent {
  source: string;           // Actor that published
  state: GlobalState;       // Changed state values
  changedKeys: string[];    // Which keys changed
  publicationChain: string[]; // Actors in the chain (loop detection)
  timestamp: number;
}
```

## Actor Lifecycle

### 1. Construction

```typescript
class MyActor extends ShadowActor {
  protected actorId = 'my-actor';
  protected publicationKeys = ['my.state'];
  protected subscriptionKeys = ['other.state'];

  constructor(manager: EventStateManager, container: HTMLElement) {
    super(manager, container);
    // Actor is now registered with manager
  }
}
```

### 2. Initial State Publication

On registration, actors can publish initial state:

```typescript
// In ShadowActor.register()
manager.register(registration, this.getInitialState());
```

### 3. Receiving State Changes

Actors receive state via CustomEvent:

```typescript
// EventStateManager dispatches to actor's element
const customEvent = new CustomEvent('state-changed', {
  detail: stateChangeEvent,
  bubbles: false,
  cancelable: false
});
actor.element.dispatchEvent(customEvent);

// Actor handles in onStateChange()
protected onStateChange(event: StateChangeEvent): void {
  if (event.changedKeys.includes('streaming.active')) {
    this.handleStreamingChange(event.state['streaming.active']);
  }
}
```

### 4. Publishing State

```typescript
// Actors call publish() to broadcast changes
this.publish({ 'my.state': newValue });

// This creates a StateChangeEvent and sends to manager
```

### 5. Cleanup

```typescript
// On destroy
this.manager.unregister(this.actorId);
```

## Loop Prevention

The manager prevents infinite loops:

### Circular Dependency Detection

```
Actor A publishes → Actor B receives → Actor B publishes → Actor A receives...

publicationChain: ['A', 'B', 'A']  ← Detected! Chain blocked.
```

### Chain Depth Limit

Maximum 10 actors in a chain before blocking:

```typescript
if (publicationChain.length >= this.maxChainDepth) {
  this.logger.longChainWarning(publicationChain.length, publicationChain);
  return; // Block further propagation
}
```

## External State Injection

For state from outside the actor system (e.g., VS Code messages):

```typescript
// In chat.ts message handler
case 'historySessions':
  manager.publishDirect('history.sessions', msg.sessions);
  break;
```

`publishDirect()` creates a synthetic state change with source `'external'`.

## Debugging

The `EventStateLogger` provides detailed logging:

```typescript
// Enable verbose logging
manager.getLogger().setLevel('DEBUG');
```

Log output example:
```
[ESM] Actor register: message-actor
      Publications: [message.content, message.streaming]
      Subscriptions: [streaming.*, session.id]
[ESM] State change: streaming-actor → streaming.active
      Chain depth: 0
[ESM] Broadcast to: message-actor [streaming.active]
```

## Actor Registry

Current actors in the system:

| Actor | Publications | Subscriptions |
|-------|-------------|---------------|
| **VirtualMessageGatewayActor** | `gateway.*` | - |
| **VirtualListActor** | `virtualList.*` | `streaming.active`, `edit.mode` |
| **MessageTurnActor** | `turn.*` | - |
| StreamingActor | `streaming.*` | - |
| SessionActor | `session.*` | - |
| EditModeActor | `edit.*` | - |
| InputAreaShadowActor | `input.*` | `streaming.active` |
| StatusPanelShadowActor | `status.*` | - |
| ToolbarShadowActor | `toolbar.*` | `streaming.active` |
| HistoryShadowActor | `history.modal.*` | `history.*`, `session.id` |
| ScrollActor | - | `turn.*`, `streaming.*` |
| HeaderActor | - | `session.model`, `session.title` |
| ModelSelectorShadowActor | `model.*` | `model.current`, `model.settings` |
| FilesShadowActor | `files.*` | - |
| CommandsShadowActor | - | - |
| SettingsShadowActor | - | - |
| InspectorShadowActor | - | - |

## Unified Turn Architecture

The **Unified Turn Architecture** consolidates all content types into a single per-turn actor (`MessageTurnActor`) with multiple shadow containers. This is the sole rendering architecture - there is no legacy mode.

### Why Unified Turns?

Previously, the architecture created separate actors for each content type. This created challenges:

- **Virtual rendering**: Couldn't easily pool/recycle actors across turns
- **Coordination**: Gateway had to orchestrate 5+ separate actors
- **State management**: Turn-level state scattered across actors

### The Solution: MessageTurnActor

One `MessageTurnActor` per conversation turn that internally creates multiple shadow containers:

```
┌─────────────────────────────────────────────────────────────────────┐
│  MessageTurnActor (turn 1 - assistant)                              │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  <div class="text-container">                               │   │
│  │    #shadow-root: [First paragraph...]                       │   │
│  ├─────────────────────────────────────────────────────────────┤   │
│  │  <div class="thinking-container">                           │   │
│  │    #shadow-root: [Let me analyze this...]                   │   │
│  ├─────────────────────────────────────────────────────────────┤   │
│  │  <div class="tools-container">                              │   │
│  │    #shadow-root: [shell_execute: ls -la]                    │   │
│  ├─────────────────────────────────────────────────────────────┤   │
│  │  <div class="text-container continuation">                  │   │
│  │    #shadow-root: [Based on that output...]                  │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Benefits

1. **Poolable**: Actor can be reset and rebound to new turn data
2. **Full shadow isolation**: Each container type has its own shadow root
3. **Simpler coordination**: Actor self-coordinates its segments
4. **Enables virtual rendering**: VirtualListActor can pool MessageTurnActor instances

### Pool Lifecycle

```typescript
// Acquire from pool
const actor = pool.acquire() ?? new MessageTurnActor(config);
actor.bind({ turnId: 'turn-1', role: 'assistant', timestamp: Date.now() });

// Use the actor
actor.startStreaming();
actor.createTextSegment('Hello');
actor.startThinkingIteration();
// ... more operations ...
actor.endStreaming();

// Release back to pool
actor.reset();  // Clears all containers and state
pool.release(actor);
```

### File Location

```
media/actors/turn/
├── MessageTurnActor.ts   # Main actor implementation
├── types.ts              # Type definitions
├── index.ts              # Exports
└── styles/
    └── index.ts          # Combined styles for all container types
```

See [media/actors/turn/MessageTurnActor.ts](../media/actors/turn/MessageTurnActor.ts) for implementation.

## VirtualListActor: Pool Management & Virtual Rendering

The **VirtualListActor** manages a pool of `MessageTurnActor` instances, implementing virtual rendering to handle large conversations efficiently.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  VirtualListActor                                                   │
│                                                                     │
│  ┌───────────────┐  ┌───────────────────────────────────────────┐  │
│  │    Pool       │  │        Turn Data (Source of Truth)        │  │
│  │ [actor, ...]  │  │  Map<turnId, TurnData>                    │  │
│  └───────────────┘  └───────────────────────────────────────────┘  │
│                                                                     │
│  Scroll Container (viewport)                                        │
│  ┌───────────────────────────────────────────────────────────┐     │
│  │ Content Container (full height)                           │     │
│  │                                                           │     │
│  │   ┌─ turn-1 ─────────────────────────────────────────┐   │     │
│  │   │ (off-screen, no actor bound)                      │   │     │
│  │   └──────────────────────────────────────────────────┘   │     │
│  │   ┌─ turn-2 ─────────────────────────────────────────┐   │     │
│  │   │ MessageTurnActor bound ✓                          │◄─┼─ visible
│  │   └──────────────────────────────────────────────────┘   │     │
│  │   ┌─ turn-3 ─────────────────────────────────────────┐   │     │
│  │   │ MessageTurnActor bound ✓                          │◄─┼─ visible
│  │   └──────────────────────────────────────────────────┘   │     │
│  │   ┌─ turn-4 ─────────────────────────────────────────┐   │     │
│  │   │ (off-screen, no actor bound)                      │   │     │
│  │   └──────────────────────────────────────────────────┘   │     │
│  └───────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Features

1. **Actor Pooling**: Pre-warms pool, acquires/releases actors based on visibility
2. **Source of Truth**: Turn data stored in VirtualListActor, actors are just views
3. **Scroll-based Visibility**: Debounced scroll handling with configurable overscan
4. **Height Measurement**: Measures actual heights after render, adjusts offsets
5. **Content Delegation**: All content operations update data first, then delegate to bound actors

### Usage

```typescript
const virtualList = new VirtualListActor(manager, scrollContainer, {
  config: {
    minPoolSize: 5,      // Pre-warmed actors
    maxPoolSize: 20,     // Max pooled actors
    overscan: 2,         // Extra turns to render outside viewport
    defaultTurnHeight: 150
  }
});

// Add turns - binding happens automatically if visible
const turn = virtualList.addTurn('turn-1', 'assistant');
virtualList.startStreamingTurn('turn-1');

// Content operations delegate to bound actor
virtualList.addTextSegment('turn-1', 'Hello');
virtualList.startThinkingIteration('turn-1');
virtualList.startToolBatch('turn-1', [{ name: 'read_file', detail: 'src/main.ts' }]);

// End streaming
virtualList.endStreamingTurn();

// Get stats
const stats = virtualList.getPoolStats();
// { totalTurns: 50, visibleTurns: 5, actorsInUse: 5, actorsInPool: 15, totalActorsCreated: 20 }
```

### File Location

```
media/actors/virtual-list/
├── VirtualListActor.ts   # Main actor with pool management
├── types.ts              # TurnData, PoolStats, VisibleRange, etc.
└── index.ts              # Exports
```

See [media/actors/virtual-list/VirtualListActor.ts](../media/actors/virtual-list/VirtualListActor.ts) for implementation.

## Best Practices

1. **Single Responsibility**: Each actor owns specific state keys
2. **Unidirectional Flow**: State flows through manager, not directly between actors
3. **Immutable Updates**: Always create new objects when publishing
4. **Minimal Subscriptions**: Only subscribe to what you need
5. **No DOM Manipulation**: Never touch another actor's DOM directly

## Scalability & Performance

The actor system includes several optimizations for performance at scale. See [REMINDER.md](../REMINDER.md) for the full list of mitigations with implementation status.

### Implemented Optimizations

#### Indexed Subscriptions (O(1) Lookup)

Instead of scanning all actors on each publish, subscriptions are indexed:

```typescript
// O(1) exact key lookup
exactSubscriptions: Map<string, Set<actorId>>

// O(w) wildcard matching (w = number of wildcard patterns)
wildcardSubscriptions: Map<string, Set<actorId>>
```

**Best practice**: Prefer exact subscription keys over wildcards when you know the specific keys you need.

```typescript
// BETTER - O(1) lookup
subscriptions: {
  'streaming.active': (v) => this.handleActive(v),
  'streaming.content': (v) => this.handleContent(v)
}

// OK for catch-all - but O(w) per publish
subscriptions: {
  'streaming.*': (v, key) => this.handleAny(key, v)
}
```

#### Adopted StyleSheets (Shared CSS)

Shadow DOM actors share parsed CSS via `adoptedStyleSheets`:

```typescript
// Manager caches parsed stylesheets
const baseSheet = manager.getShadowBaseSheet();           // Shared by ALL shadow actors
const actorSheet = manager.getStyleSheet(css, 'ActorName'); // Cached per actor type

this.shadow.adoptedStyleSheets = [baseSheet, actorSheet];
```

Benefits:
- One parsed CSSOM tree shared across N shadow roots
- ~300KB savings at 100 actors with 3KB CSS each

#### Container-Level Event Delegation

Actors use container-level delegation instead of per-item listeners:

```typescript
// ONE listener handles all items (current and future)
this._container.addEventListener('click', (e) => {
  const item = (e.target as HTMLElement).closest('.item');
  if (item) this.handleItemClick(item.dataset.id);
});
```

### Future Optimizations (Not Yet Needed)

| Optimization | When to Consider |
|--------------|------------------|
| Batched Publications | 5+ subscribers to high-frequency events |
| Virtual Rendering | 100+ items in scrollable lists |
| Object Pooling | Rapid create/destroy cycles causing GC pauses |

See [REMINDER.md Scalability section](../../../REMINDER.md#scalability--mitigations) for implementation details.
