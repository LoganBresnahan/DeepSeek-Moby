# State Keys Reference

This document lists all pub/sub state keys used in the actor system.

## Key Naming Convention

```
{domain}.{property}
{domain}.{subdomain}.{property}

Examples:
  streaming.active
  message.content
  history.modal.open
```

## State Keys by Domain

### streaming.*

Keys related to AI response streaming.

| Key | Type | Publisher | Subscribers | Description |
|-----|------|-----------|-------------|-------------|
| `streaming.active` | `boolean` | StreamingActor | InputAreaShadowActor, ToolbarShadowActor, ScrollActor | Whether a response is being streamed |
| `streaming.content` | `string` | StreamingActor | MessageShadowActor | Current streamed content |
| `streaming.thinking` | `string` | StreamingActor | ThinkingShadowActor | Current thinking/reasoning content |
| `streaming.messageId` | `string` | StreamingActor | MessageShadowActor | ID of current streaming message |
| `streaming.model` | `string` | StreamingActor | - | Model being used |

### message.*

Keys related to chat messages.

| Key | Type | Publisher | Subscribers | Description |
|-----|------|-----------|-------------|-------------|
| `message.added` | `Message` | MessageShadowActor | ScrollActor | New message was added |
| `message.updated` | `{ id, content }` | MessageShadowActor | - | Message content updated |
| `message.cleared` | `boolean` | MessageShadowActor | ScrollActor | All messages cleared |

### thinking.*

Keys related to thinking/reasoning display.

| Key | Type | Publisher | Subscribers | Description |
|-----|------|-----------|-------------|-------------|
| `thinking.active` | `boolean` | ThinkingShadowActor | - | Thinking block visible |
| `thinking.content` | `string` | ThinkingShadowActor | - | Current thinking text |
| `thinking.iteration` | `number` | ThinkingShadowActor | - | Current iteration number |

### shell.*

Keys related to shell command execution.

| Key | Type | Publisher | Subscribers | Description |
|-----|------|-----------|-------------|-------------|
| `shell.executing` | `boolean` | ShellShadowActor | - | Commands being executed |
| `shell.commands` | `ShellCommand[]` | ShellShadowActor | - | Current commands |
| `shell.results` | `ShellResult[]` | ShellShadowActor | - | Command outputs |

### toolcalls.*

Keys related to tool call display.

| Key | Type | Publisher | Subscribers | Description |
|-----|------|-----------|-------------|-------------|
| `toolcalls.active` | `boolean` | ToolCallsShadowActor | - | Tool calls in progress |
| `toolcalls.calls` | `ToolCall[]` | ToolCallsShadowActor | - | Current tool calls |

### pending.*

Keys related to pending file changes.

| Key | Type | Publisher | Subscribers | Description |
|-----|------|-----------|-------------|-------------|
| `pending.files` | `PendingFile[]` | PendingChangesShadowActor | - | Files with pending changes |
| `pending.editMode` | `string` | PendingChangesShadowActor | - | Current edit mode |

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
| `toolbar.editMode` | `string` | ToolbarShadowActor | PendingChangesShadowActor | Selected edit mode |
| `toolbar.webSearch` | `boolean` | ToolbarShadowActor | - | Web search enabled |

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
| `session.id` | `string` | external | MessageShadowActor, HistoryShadowActor | Current session ID |
| `session.title` | `string` | external | - | Current session title |

### status.*

Keys related to status display.

| Key | Type | Publisher | Subscribers | Description |
|-----|------|-----------|-------------|-------------|
| `status.message` | `string` | StatusPanelShadowActor | - | Current status message |
| `status.type` | `string` | StatusPanelShadowActor | - | info/warning/error |

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
subscriptionKeys: ['streaming.*', 'session.id', 'history.*']
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
  subscriptionKeys = ['streaming.*', 'toolcalls.*', 'pending.*'];

  onStateChange(event: StateChangeEvent) {
    // Check which domain changed
    for (const key of event.changedKeys) {
      if (key.startsWith('streaming.')) {
        this.updateStreamingStatus(event.state);
      } else if (key.startsWith('toolcalls.')) {
        this.updateToolsStatus(event.state);
      } else if (key.startsWith('pending.')) {
        this.updatePendingStatus(event.state);
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
│    'streaming.content': '',                              │
│    'session.id': 'abc123',                              │
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
    │ Message   │   │ Thinking  │   │ History   │
    │ Actor     │   │ Actor     │   │ Actor     │
    │           │   │           │   │           │
    │ subs:     │   │ subs:     │   │ subs:     │
    │ streaming │   │ streaming │   │ history.* │
    │ .*, sess  │   │ .thinking │   │ session.  │
    │ ion.id    │   │           │   │ id        │
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
