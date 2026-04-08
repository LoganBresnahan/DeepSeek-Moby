# Fixture Recording Plan

## Goal

Record real DeepSeek sessions as JSON fixtures for deterministic Layer 2 tests. Eliminates AI nondeterminism (R1 using shell vs code blocks) and enables offline testing.

## How It Works

### Recording (manual)

1. Use the extension normally (F5 debug)
2. When you have a good interaction (e.g., R1 produces a clean SEARCH/REPLACE code block in Ask mode, you accept it), export it:
   - Command Palette → **"DeepSeek Moby: Export Session (Test Fixture)"**
   - This saves the `RichHistoryTurn[]` data — the exact payload that `loadHistory` sends to the webview
3. Save the JSON file to `tests/e2e/fixtures/`

### Replaying (automated)

Layer 2 tests load the fixture and dispatch it as a `loadHistory` message:

```typescript
const fixture = require('../fixtures/ask-mode-accept.json');
await page.evaluate((history) => {
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'loadHistory', history }
  }));
}, fixture);
```

The webview renders exactly what it would have rendered during the live session. Tests assert the DOM state.

### What's in a fixture

Each fixture is a JSON array of `RichHistoryTurn` objects:

```json
[
  {
    "role": "user",
    "content": "Change hello to hi in greeter.ts",
    "timestamp": 1775509000000
  },
  {
    "role": "assistant",
    "content": "I'll make that change...",
    "model": "deepseek-reasoner",
    "reasoning_iterations": ["Let me think about this..."],
    "turnEvents": [
      { "type": "thinking-start", "iteration": 0, "ts": 1 },
      { "type": "thinking-content", "content": "...", "iteration": 0, "ts": 2 },
      { "type": "thinking-complete", "iteration": 0, "ts": 3 },
      { "type": "text-append", "content": "...", "iteration": 0, "ts": 4 },
      { "type": "text-finalize", "iteration": 0, "ts": 5 },
      { "type": "file-modified", "path": "greeter.ts", "status": "applied", "editMode": "ask", "ts": 6 }
    ]
  }
]
```

The `turnEvents` array is the key — it's the consolidated CQRS event log from `TurnEventLog.consolidateForSave()`. This is exactly what gets stored in the DB and what `handleLoadHistory` consumes on restore.

## Fixture Categories Needed

| Fixture | Scenario | Why |
|---|---|---|
| `manual-diff-apply.json` | R1 produces code block, user diffs and applies | Tests W1 without AI |
| `ask-accept.json` | R1 code block in Ask mode, user accepts | Tests W2 accept |
| `ask-reject.json` | R1 code block in Ask mode, user rejects | Tests W2 reject |
| `auto-apply.json` | R1 code block auto-applied | Tests W3 |
| `multi-iteration-shell.json` | R1 with 3+ iterations, shell commands | Tests W10 |
| `mixed-modes.json` | Multiple turns with different editModes | Tests W4/W9 |
| `thinking-only.json` | R1 simple response with thinking | Tests rendering |

## Implementation

1. Add `exportSessionAsFixture()` method to `ConversationManager`
2. Register a VS Code command `moby.exportTestFixture`
3. The method calls `getSessionRichHistory()` and saves as formatted JSON
4. User picks save location via file dialog

## Status

**Not yet implemented.** Will be built when the UI is stable enough that fixtures won't need constant re-recording.
