# State Keys Reference

This document lists the primary pub/sub state keys used in the actor system.

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
| `streaming.active` | `boolean` | StreamingActor | InputAreaShadowActor, ToolbarShadowActor, ScrollActor, VirtualListActor, ModelSelectorShadowActor | Whether a response is being streamed |
| `streaming.content` | `string` | StreamingActor | - | Current streamed assistant text |
| `streaming.thinking` | `string` | StreamingActor | - | Current streamed reasoning text |
| `streaming.messageId` | `string \| null` | StreamingActor | - | ID of current streaming message |
| `streaming.model` | `string` | StreamingActor | - | Model being used |

### turn.*

Keys related to conversation turns (Unified Turn Architecture).

Published per-turn by MessageTurnActor (last-writer-wins, since only one turn streams at a time).

| Key | Type | Publisher | Subscribers | Description |
|-----|------|-----------|-------------|-------------|
| `turn.id` | `string` | MessageTurnActor | - | Current turn ID |
| `turn.role` | `string` | MessageTurnActor | - | Turn role (user/assistant) |
| `turn.streaming` | `boolean` | MessageTurnActor | - | Whether this turn is streaming |
| `turn.hasInterleaved` | `boolean` | MessageTurnActor | - | Turn has interleaved content |
| `turn.textSegmentCount` | `number` | MessageTurnActor | - | Number of text segments |
| `turn.thinkingCount` | `number` | MessageTurnActor | - | Number of thinking iterations |
| `turn.toolBatchCount` | `number` | MessageTurnActor | - | Number of tool batches |
| `turn.shellSegmentCount` | `number` | MessageTurnActor | - | Number of shell segments |

### activity.*

Keys driving the StatusPanelShadowActor's activity slot, published per-turn by MessageTurnActor.

| Key | Type | Publisher | Subscribers | Description |
|-----|------|-----------|-------------|-------------|
| `activity.streaming` | `boolean` | MessageTurnActor | StatusPanelShadowActor | Whether a turn is streaming |
| `activity.label` | `string \| null` | MessageTurnActor | StatusPanelShadowActor | Current activity label |

### virtualList.*

Keys related to virtual list state.

| Key | Type | Publisher | Subscribers | Description |
|-----|------|-----------|-------------|-------------|
| `virtualList.turnCount` | `number` | VirtualListActor | - | Total number of turns |
| `virtualList.visibleCount` | `number` | VirtualListActor | - | Number of bound (rendered) turns |
| `virtualList.poolStats` | `object` | VirtualListActor | - | Actor pool statistics |

### input.*

Keys related to user input area.

| Key | Type | Publisher | Subscribers | Description |
|-----|------|-----------|-------------|-------------|
| `input.value` | `string` | InputAreaShadowActor | ToolbarShadowActor | Current input text |
| `input.submitting` | `boolean` | InputAreaShadowActor | - | Submit in progress |
| `input.streaming` | `boolean` | InputAreaShadowActor | - | Streaming-driven disabled state |
| `input.attachments` | `Attachment[]` | InputAreaShadowActor | - | Attached files |

### toolbar.*

Keys related to toolbar state.

| Key | Type | Publisher | Subscribers | Description |
|-----|------|-----------|-------------|-------------|
| `toolbar.editMode` | `string` | ToolbarShadowActor | - | Selected edit mode |
| `toolbar.webSearchEnabled` | `boolean` | ToolbarShadowActor | - | Web search enabled |
| `toolbar.webSearchMode` | `string` | ToolbarShadowActor | - | Web search mode |
| `toolbar.filesModalOpen` | `boolean` | ToolbarShadowActor | - | Files modal open state |
| `toolbar.planEnabled` | `boolean` | ToolbarShadowActor | - | Plan mode enabled |

### edit.*

Keys related to edit mode.

| Key | Type | Publisher | Subscribers | Description |
|-----|------|-----------|-------------|-------------|
| `edit.mode` | `EditMode` | EditModeActor | - | Current edit mode (manual/ask/auto) |
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
| `session.model` | `string` | SessionActor | HeaderActor, ToolbarShadowActor | Current model ID |
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
| `model.shellIterations` | `number` | ModelSelectorShadowActor | - | Shell iteration limit |
| `model.fileEditLoops` | `number` | ModelSelectorShadowActor | - | File edit loop limit |
| `model.maxTokens` | `number` | ModelSelectorShadowActor | - | Max output tokens |

### status.*

Keys related to status display.

| Key | Type | Publisher | Subscribers | Description |
|-----|------|-----------|-------------|-------------|
| `status.hasMessage` | `boolean` | StatusPanelShadowActor | - | A message is currently shown |
| `status.hasWarning` | `boolean` | StatusPanelShadowActor | - | A warning is currently shown |
| `status.hasError` | `boolean` | StatusPanelShadowActor | - | An error is currently shown |
| `status.message` | `{type, message}` | external | StatusPanelShadowActor | Message to display (injected via publishDirect) |

### gateway.*

Keys for gateway observability (debugging).

| Key | Type | Publisher | Subscribers | Description |
|-----|------|-----------|-------------|-------------|
| `gateway.phase` | `GatewayPhase` | VirtualMessageGatewayActor | - | idle/streaming/waiting-for-results |
| `gateway.currentTurn` | `string` | VirtualMessageGatewayActor | - | Current streaming turn ID |

### scroll.*

Keys related to scroll behavior.

| Key | Type | Publisher | Subscribers | Description |
|-----|------|-----------|-------------|-------------|
| `scroll.autoScroll` | `boolean` | ScrollActor | - | Auto-scroll is engaged |
| `scroll.userScrolled` | `boolean` | ScrollActor | - | User scrolled away from bottom |
| `scroll.nearBottom` | `boolean` | ScrollActor | - | Viewport is near the bottom |
| `scroll.request` | `ScrollRequest` | external | ScrollActor | Request to scroll |

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
// From chat.ts (toolbar/command handlers)
manager.publishDirect('history.modal.open', true);
manager.publishDirect('files.modal.open', true);
manager.publishDirect('status.message', { type: 'info', message: '...' });

// From VirtualMessageGatewayActor.onMessage (extension → webview)
manager.publishDirect('history.sessions', sessions);
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
    │ .active   │   │ .active   │   │ session.  │
    │           │   │           │   │ id        │
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
window.actorManager.getLogger().setLogLevel('DEBUG')
// Or: window.actorManager.getLogger().enableDebug()
// Logs all state changes to console
```
