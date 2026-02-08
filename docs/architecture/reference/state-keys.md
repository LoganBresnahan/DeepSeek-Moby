# State Keys Reference

This document lists all pub/sub state keys used in the actor system.

## Key Naming Convention

```
{domain}.{property}
{domain}.{subdomain}.{property}

Examples:
  streaming.active
  turn.content
  history.modal.open
```

## State Keys by Domain

### streaming.*

Keys related to AI response streaming.

| Key | Type | Publisher | Subscribers | Description |
|-----|------|-----------|-------------|-------------|
| `streaming.active` | `boolean` | StreamingActor | InputAreaShadowActor, ToolbarShadowActor, ScrollActor, VirtualListActor | Whether a response is being streamed |
| `streaming.messageId` | `string` | StreamingActor | VirtualListActor | ID of current streaming message |
| `streaming.model` | `string` | StreamingActor | - | Model being used |

### turn.*

Keys related to conversation turns (Unified Turn Architecture).

| Key | Type | Publisher | Subscribers | Description |
|-----|------|-----------|-------------|-------------|
| `turn.active` | `string` | VirtualListActor | - | Currently active turn ID |
| `turn.streaming` | `boolean` | VirtualListActor | ScrollActor | Whether a turn is streaming |

### virtualList.*

Keys related to virtual list state.

| Key | Type | Publisher | Subscribers | Description |
|-----|------|-----------|-------------|-------------|
| `virtualList.turnCount` | `number` | VirtualListActor | - | Total number of turns |
| `virtualList.visibleRange` | `{start, end}` | VirtualListActor | - | Currently visible turn range |

### input.*

Keys related to user input area.

| Key | Type | Publisher | Subscribers | Description |
|-----|------|-----------|-------------|-------------|
| `input.value` | `string` | InputAreaShadowActor | - | Current input text |
| `input.focused` | `boolean` | InputAreaShadowActor | - | Input has focus |
| `input.attachments` | `Attachment[]` | InputAreaShadowActor | - | Attached files |

### toolbar.*

Keys related to toolbar state.

| Key | Type | Publisher | Subscribers | Description |
|-----|------|-----------|-------------|-------------|
| `toolbar.editMode` | `string` | ToolbarShadowActor | VirtualListActor | Selected edit mode |
| `toolbar.webSearch` | `boolean` | ToolbarShadowActor | - | Web search enabled |

### edit.*

Keys related to edit mode.

| Key | Type | Publisher | Subscribers | Description |
|-----|------|-----------|-------------|-------------|
| `edit.mode` | `EditMode` | EditModeActor | VirtualListActor, ToolbarShadowActor | Current edit mode (manual/ask/auto) |
| `edit.mode.set` | `EditMode` | external | EditModeActor | Request to change edit mode |

### history.*

Keys related to history modal.

| Key | Type | Publisher | Subscribers | Description |
|-----|------|-----------|-------------|-------------|
| `history.modal.open` | `boolean` | external | HistoryShadowActor | Open/close modal |
| `history.modal.visible` | `boolean` | HistoryShadowActor | - | Modal visibility state |
| `history.sessions` | `HistorySession[]` | external | HistoryShadowActor | All history sessions |

### session.*

Keys related to current session.

| Key | Type | Publisher | Subscribers | Description |
|-----|------|-----------|-------------|-------------|
| `session.id` | `string` | SessionActor | HistoryShadowActor | Current session ID |
| `session.title` | `string` | SessionActor | HeaderActor | Current session title |
| `session.model` | `string` | SessionActor | HeaderActor, ModelSelectorShadowActor | Current model ID |
| `session.loading` | `boolean` | SessionActor | - | Session is loading |
| `session.error` | `string` | SessionActor | - | Session error message |

### model.*

Keys related to model selection.

| Key | Type | Publisher | Subscribers | Description |
|-----|------|-----------|-------------|-------------|
| `model.popup.open` | `boolean` | external | ModelSelectorShadowActor | Open model popup |
| `model.popup.visible` | `boolean` | ModelSelectorShadowActor | - | Popup visibility |
| `model.selected` | `string` | ModelSelectorShadowActor | - | Selected model in popup |
| `model.current` | `string` | external | ModelSelectorShadowActor | Current model from extension |
| `model.settings` | `ModelSettings` | external | ModelSelectorShadowActor | Model settings from extension |
| `model.temperature` | `number` | ModelSelectorShadowActor | - | Temperature setting |
| `model.toolLimit` | `number` | ModelSelectorShadowActor | - | Tool iteration limit |
| `model.maxTokens` | `number` | ModelSelectorShadowActor | - | Max output tokens |

### status.*

Keys related to status display.

| Key | Type | Publisher | Subscribers | Description |
|-----|------|-----------|-------------|-------------|
| `status.message` | `string` | StatusPanelShadowActor | - | Current status message |
| `status.type` | `string` | StatusPanelShadowActor | - | info/warning/error |

### gateway.*

Keys for gateway observability (debugging).

| Key | Type | Publisher | Subscribers | Description |
|-----|------|-----------|-------------|-------------|
| `gateway.phase` | `GatewayPhase` | VirtualMessageGatewayActor | - | idle/streaming/waiting |
| `gateway.currentTurn` | `string` | VirtualMessageGatewayActor | - | Current streaming turn ID |

### external.*

Keys for external messages (from VS Code extension).

| Key | Type | Publisher | Subscribers | Description |
|-----|------|-----------|-------------|-------------|
| `external.*` | `any` | EventStateManager | varies | Messages from extension |

## Subscription Patterns

### Wildcard Examples

```typescript
// Subscribe to all streaming events
subscriptionKeys: ['streaming.*']

// Subscribe to specific key
subscriptionKeys: ['streaming.active']

// Subscribe to multiple domains
subscriptionKeys: ['streaming.active', 'session.id', 'history.*']
```

### Common Subscription Patterns

```typescript
// Actor that reacts to streaming start/stop
class MyActor {
  subscriptionKeys = ['streaming.active'];

  onStateChange(event: StateChangeEvent) {
    if (event.changedKeys.includes('streaming.active')) {
      const isActive = event.state['streaming.active'];
      this.handleStreamingChange(isActive);
    }
  }
}

// Actor that tracks multiple states
class DashboardActor {
  subscriptionKeys = ['streaming.*', 'turn.*', 'edit.*'];

  onStateChange(event: StateChangeEvent) {
    // Check which domain changed
    for (const key of event.changedKeys) {
      if (key.startsWith('streaming.')) {
        this.updateStreamingStatus(event.state);
      } else if (key.startsWith('turn.')) {
        this.updateTurnStatus(event.state);
      } else if (key.startsWith('edit.')) {
        this.updateEditMode(event.state);
      }
    }
  }
}
```

## External State Injection

State can be injected from outside the actor system:

```typescript
// From chat.ts message handler
manager.publishDirect('history.sessions', sessions);
manager.publishDirect('history.modal.open', true);
manager.publishDirect('session.id', sessionId);
```

## State Flow Diagram

```
                    External Sources
                    (postMessage)
                          │
                          ▼
                  ┌───────────────┐
                  │ publishDirect │
                  └───────┬───────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                  EventStateManager                       │
│                                                          │
│  globalState: {                                          │
│    'streaming.active': false,                            │
│    'session.id': 'abc123',                              │
│    'session.model': 'deepseek-chat',                    │
│    'edit.mode': 'manual',                               │
│    'history.sessions': [...],                           │
│    ...                                                   │
│  }                                                       │
│                                                          │
└───────────────────────────┬─────────────────────────────┘
                            │
            ┌───────────────┼───────────────┐
            │               │               │
            ▼               ▼               ▼
    ┌───────────┐   ┌───────────┐   ┌───────────┐
    │ Virtual   │   │ Input     │   │ History   │
    │ ListActor │   │ Area      │   │ Actor     │
    │           │   │           │   │           │
    │ subs:     │   │ subs:     │   │ subs:     │
    │ streaming │   │ streaming │   │ history.* │
    │ .*, edit  │   │ .active   │   │ session.  │
    │ .mode     │   │           │   │ id        │
    └───────────┘   └───────────┘   └───────────┘
```

## Debugging State

```javascript
// In browser console
window.actorManager.getAllState()
// → { 'streaming.active': false, 'session.id': '...', ... }

window.actorManager.getState('streaming.active')
// → false

// Watch for state changes
window.actorManager.getLogger().setLevel('DEBUG')
// Logs all state changes to console
```
