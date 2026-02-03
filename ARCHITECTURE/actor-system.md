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
| StreamingActor | `streaming.*` | - |
| MessageShadowActor | `message.*` | `streaming.*`, `session.id` |
| ThinkingShadowActor | `thinking.*` | `streaming.thinking` |
| ShellShadowActor | `shell.*` | - |
| ToolCallsShadowActor | `toolcalls.*` | - |
| PendingChangesShadowActor | `pending.*` | - |
| InputAreaShadowActor | `input.*` | `streaming.active` |
| StatusPanelShadowActor | `status.*` | - |
| ToolbarShadowActor | `toolbar.*` | `streaming.active` |
| HistoryShadowActor | `history.modal.*` | `history.*`, `session.id` |
| ScrollActor | - | `message.*`, `streaming.*` |

## Best Practices

1. **Single Responsibility**: Each actor owns specific state keys
2. **Unidirectional Flow**: State flows through manager, not directly between actors
3. **Immutable Updates**: Always create new objects when publishing
4. **Minimal Subscriptions**: Only subscribe to what you need
5. **No DOM Manipulation**: Never touch another actor's DOM directly
