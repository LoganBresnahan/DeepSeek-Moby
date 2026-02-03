# Message Bridge

The message bridge handles communication between the VS Code extension (Node.js) and the webview (browser context). This is the only way these two contexts can communicate.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     VS Code Extension                            │
│                        (Node.js)                                 │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    ChatProvider                           │   │
│  │                                                           │   │
│  │  this._view.webview.postMessage({ type, ...data })       │   │
│  │                          │                                │   │
│  │  webview.onDidReceiveMessage(handler)                    │   │
│  │                          ▲                                │   │
│  └──────────────────────────┼────────────────────────────────┘   │
└─────────────────────────────┼────────────────────────────────────┘
                              │
                    ══════════╪══════════  Isolation Boundary
                              │
┌─────────────────────────────┼────────────────────────────────────┐
│                             │            Webview                  │
│                             │           (Browser)                 │
│                             │                                     │
│  ┌──────────────────────────┼────────────────────────────────┐   │
│  │                          │        chat.ts                  │   │
│  │                          ▼                                 │   │
│  │  window.addEventListener('message', handler)               │   │
│  │                                                            │   │
│  │  vscode.postMessage({ type, ...data })                    │   │
│  │           │                                                │   │
│  └───────────┼────────────────────────────────────────────────┘   │
└──────────────┼────────────────────────────────────────────────────┘
               │
               ▼
       acquireVsCodeApi()
       returns { postMessage, getState, setState }
```

## API Reference

### Extension Side (ChatProvider)

```typescript
// Send message to webview
this._view?.webview.postMessage({
  type: 'messageName',
  data: 'value',
  // ... any serializable data
});

// Receive messages from webview
webview.onDidReceiveMessage(async (data) => {
  switch (data.type) {
    case 'sendMessage':
      await this.handleUserMessage(data.message);
      break;
    // ...
  }
});
```

### Webview Side (chat.ts)

```typescript
// Get VS Code API (can only call once!)
const vscode = acquireVsCodeApi();

// Send message to extension
vscode.postMessage({
  type: 'sendMessage',
  message: 'Hello',
  attachments: []
});

// Receive messages from extension
window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'streamToken':
      handleStreamToken(msg.token);
      break;
    // ...
  }
});
```

## Message Catalog

### Extension → Webview

#### Streaming Messages

| Type | Payload | Purpose |
|------|---------|---------|
| `startResponse` | `{ messageId, isReasoner }` | Begin new AI response stream |
| `streamToken` | `{ token }` | Content chunk for display |
| `streamReasoning` | `{ token }` | Thinking content (R1 model) |
| `iterationStart` | `{ iteration }` | New reasoning iteration |
| `endResponse` | `{ message }` | Stream complete |
| `generationStopped` | - | User cancelled generation |

#### Tool Execution Messages

| Type | Payload | Purpose |
|------|---------|---------|
| `shellExecuting` | `{ commands: [{cmd, cwd}] }` | Shell commands starting |
| `shellResults` | `{ results: [{output, success}] }` | Command output |
| `toolCallsStart` | `{ tools: [{name, detail}] }` | Tool batch starting |
| `toolCallUpdate` | `{ index, status }` | Single tool status change |
| `toolCallsUpdate` | `{ tools: [{name, detail, status}] }` | Batch tool update |
| `toolCallsEnd` | - | Tool batch complete |

#### File & Diff Messages

| Type | Payload | Purpose |
|------|---------|---------|
| `pendingFileAdd` | `{ filePath, diffId, iteration }` | New file modification |
| `pendingFileUpdate` | `{ fileId, status }` | File status change |
| `pendingFileAccept` | `{ fileId }` | File accepted |
| `pendingFileReject` | `{ fileId }` | File rejected |
| `diffListChanged` | `{ diffs: [...], editMode }` | Full diff list sync |

#### History & Chat Messages

| Type | Payload | Purpose |
|------|---------|---------|
| `addMessage` | `{ message: {role, content} }` | Add single message |
| `loadHistory` | `{ history: [...] }` | Load full session |
| `clearChat` | - | Clear all messages |
| `historySessions` | `{ sessions: [...] }` | History list for modal |
| `currentSessionId` | `{ sessionId }` | Active session ID |
| `historyCleared` | - | All history deleted |
| `openHistoryModal` | - | Trigger history modal |

#### Settings Messages

| Type | Payload | Purpose |
|------|---------|---------|
| `modelChanged` | `{ model }` | Model selection changed |
| `editModeSettings` | `{ mode }` | Edit mode changed |
| `settings` | `{ model, temperature, ... }` | Full settings sync |
| `defaultSystemPrompt` | `{ model, prompt }` | Show default prompt |
| `settingsReset` | - | Settings reset to defaults |
| `webSearchToggled` | `{ enabled }` | Web search on/off |

#### Status Messages

| Type | Payload | Purpose |
|------|---------|---------|
| `error` | `{ message }` | Display error |
| `warning` | `{ message }` | Display warning |
| `statusMessage` | `{ message }` | Display info |

#### File Modal Messages

| Type | Payload | Purpose |
|------|---------|---------|
| `openFiles` | `{ files: [...] }` | Currently open files |
| `searchResults` | `{ results: [...] }` | File search results |
| `fileContent` | `{ filePath, content }` | File content for context |

### Webview → Extension

#### User Input

| Type | Payload | Purpose |
|------|---------|---------|
| `sendMessage` | `{ message, attachments? }` | User sends message |
| `stopGeneration` | - | User stops AI response |

#### File Operations

| Type | Payload | Purpose |
|------|---------|---------|
| `acceptSpecificDiff` | `{ diffId }` | Accept file change |
| `rejectSpecificDiff` | `{ diffId }` | Reject file change |
| `focusDiff` | `{ diffId }` | Open diff in editor |
| `getOpenFiles` | - | Request open files list |
| `searchFiles` | `{ query }` | Search workspace files |
| `getFileContent` | `{ filePath }` | Get file for context |
| `setSelectedFiles` | `{ files: [{path, content}] }` | Set context files |

#### Settings

| Type | Payload | Purpose |
|------|---------|---------|
| `selectModel` | `{ model }` | Change model |
| `setTemperature` | `{ temperature }` | Set temperature |
| `setToolLimit` | `{ toolLimit }` | Set tool iteration limit |
| `setMaxTokens` | `{ maxTokens }` | Set max output tokens |
| `setSystemPrompt` | `{ systemPrompt }` | Set custom prompt |
| `setLogLevel` | `{ logLevel }` | Set logging level |
| `setLogColors` | `{ enabled }` | Toggle colored logs |
| `setAllowAllCommands` | `{ enabled }` | Toggle command safety |
| `resetToDefaults` | - | Reset all settings |
| `getSettings` | - | Request current settings |
| `getDefaultSystemPrompt` | - | Get default prompt |

#### History

| Type | Payload | Purpose |
|------|---------|---------|
| `getHistorySessions` | - | Request session list |
| `switchToSession` | `{ sessionId }` | Load specific session |
| `renameSession` | `{ sessionId, title }` | Rename session |
| `exportSession` | `{ sessionId, format }` | Export single session |
| `deleteSession` | `{ sessionId }` | Delete session |
| `exportAllHistory` | `{ format }` | Export all sessions |
| `clearAllHistory` | - | Delete all history |

#### Web Search

| Type | Payload | Purpose |
|------|---------|---------|
| `toggleWebSearch` | `{ enabled }` | Enable/disable search |
| `setSearchDepth` | `{ searchDepth }` | basic/advanced |
| `setSearchesPerPrompt` | `{ searchesPerPrompt }` | Max searches |
| `setCacheDuration` | `{ cacheDuration }` | Cache TTL minutes |
| `clearSearchCache` | - | Clear search cache |

#### Commands

| Type | Payload | Purpose |
|------|---------|---------|
| `executeCommand` | `{ command }` | Run VS Code command |
| `openLogs` | - | Open log output |

## Message Flow Examples

### User Sends Message

```
┌─────────────┐                    ┌─────────────┐
│   Webview   │                    │  Extension  │
└──────┬──────┘                    └──────┬──────┘
       │                                  │
       │ {type: 'sendMessage',            │
       │  message: 'Hello'}               │
       │─────────────────────────────────▶│
       │                                  │
       │                                  │ handleUserMessage()
       │                                  │ buildContext()
       │                                  │ callAPI()
       │                                  │
       │ {type: 'startResponse',          │
       │  messageId: '...'}               │
       │◀─────────────────────────────────│
       │                                  │
       │ {type: 'streamToken',            │
       │  token: 'Hi'}                    │
       │◀─────────────────────────────────│
       │                                  │
       │ {type: 'streamToken',            │
       │  token: ' there!'}               │
       │◀─────────────────────────────────│
       │                                  │
       │ {type: 'endResponse',            │
       │  message: {...}}                 │
       │◀─────────────────────────────────│
       │                                  │
```

### File Change Flow

```
┌─────────────┐                    ┌─────────────┐
│   Webview   │                    │  Extension  │
└──────┬──────┘                    └──────┬──────┘
       │                                  │
       │                                  │ Tool: write_file()
       │                                  │
       │ {type: 'diffListChanged',        │
       │  diffs: [{filePath, diffId,      │
       │          status: 'pending'}]}    │
       │◀─────────────────────────────────│
       │                                  │
       │ PendingChangesShadowActor        │
       │ shows pending file               │
       │                                  │
       │ User clicks Accept               │
       │                                  │
       │ {type: 'acceptSpecificDiff',     │
       │  diffId: '...'}                  │
       │─────────────────────────────────▶│
       │                                  │
       │                                  │ applyDiff()
       │                                  │
       │ {type: 'diffListChanged',        │
       │  diffs: [{status: 'applied'}]}   │
       │◀─────────────────────────────────│
       │                                  │
```

## Serialization Rules

All data crossing the bridge must be JSON-serializable:

```typescript
// ✓ Valid
{ type: 'example', data: 'string', count: 42, items: [1, 2, 3] }
{ type: 'example', nested: { a: 1, b: 'two' } }

// ✗ Invalid (will be lost or cause errors)
{ type: 'example', fn: () => {} }           // Functions
{ type: 'example', date: new Date() }       // Date objects
{ type: 'example', map: new Map() }         // Map/Set
{ type: 'example', element: document.body } // DOM elements
{ type: 'example', circular: obj }          // Circular refs
```

## State Persistence

The webview API provides state persistence:

```typescript
// Save state (survives webview hide/show)
vscode.setState({ lastModel: 'deepseek-chat' });

// Restore state
const state = vscode.getState();
if (state?.lastModel) {
  currentModel = state.lastModel;
}
```

**Note**: State is lost when VS Code restarts. Use extension's `globalState` for persistent storage.

## Security Considerations

### Content Security Policy

The webview has a CSP that:
- Only allows scripts from the extension
- Prevents inline scripts (use event handlers)
- Blocks external resources

### Input Validation

Always validate messages on both sides:

```typescript
// Extension side
webview.onDidReceiveMessage(async (data) => {
  if (typeof data.type !== 'string') return;
  if (data.type === 'sendMessage') {
    if (typeof data.message !== 'string') return;
    // Now safe to use
  }
});

// Webview side
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg.type !== 'string') return;
  // Now safe to use
});
```

## Debugging

### Log All Messages

```typescript
// Extension side
webview.onDidReceiveMessage((data) => {
  console.log('[Ext←Web]', data.type, data);
});

// Before each postMessage
console.log('[Ext→Web]', message.type, message);

// Webview side
window.addEventListener('message', (event) => {
  console.log('[Web←Ext]', event.data.type, event.data);
});

vscode.postMessage = ((original) => (msg) => {
  console.log('[Web→Ext]', msg.type, msg);
  return original(msg);
})(vscode.postMessage);
```

### Common Issues

| Problem | Cause | Solution |
|---------|-------|----------|
| Message not received | Wrong type string | Check exact spelling |
| Data undefined | Not serializable | Use JSON-safe types |
| Webview blank | Script error | Check DevTools console |
| Slow updates | Too many messages | Batch updates |
