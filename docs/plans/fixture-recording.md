# Fixture Recording Plan

## Goal

Record real DeepSeek sessions as JSON fixtures for deterministic Layer 2 tests. Eliminates AI nondeterminism (R1 using shell vs code blocks) and enables offline testing.

## Implementation status (as of 2026-06-16)

**Partial / diverged.** The export command and the replay infrastructure both ship, but the recorded-fixture corpus this plan centered on was never created — Layer 2 tests use inline hand-written event arrays instead, and `tests/e2e/fixtures/` is empty.

Shipped:
- `moby.exportTestFixture` command registered (`src/extension.ts:259`) and exposed in the Command Palette as "Export Session (Test Fixture)" (`package.json:678`), gated behind `config.moby.devMode` (`package.json:703`).
- `exportTestFixture()` builds `RichHistoryTurn[]` via `getSessionRichHistory()` and writes formatted JSON through a save dialog defaulting into `tests/e2e/fixtures/` (`src/extension.ts:982-1023`).
- `getSessionRichHistory()` reconstructs full-fidelity turns including the `turnEvents` array (`src/events/ConversationManager.ts:751`, type at `:35-48`).
- The automated replay side exists: `replayHistory()` dispatches a `loadHistory` message (`tests/e2e/helpers/replay.ts:40-46`) and `tests/e2e/webview-rendering.spec.ts` asserts DOM state — exactly the Layer 2 flow described here.

Not yet / differs:
- No recorded fixture JSON files exist; `tests/e2e/fixtures/` is empty, so none of the named categories (`ask-accept.json`, `auto-apply.json`, etc.) were produced. Tests pass `turnEvents` arrays written inline (`tests/e2e/webview-rendering.spec.ts:53-57`).
- The plan placed `exportSessionAsFixture()` on `ConversationManager`; it actually lives as the free function `exportTestFixture()` in `src/extension.ts`. The default filename is `<title>.fixture.json`, not the bare names in the table.
- `TurnEventLog.consolidateForSave()` does exist (`media/events/TurnEventLog.ts:230`) and is the webview-side producer, but the export path doesn't call it: `getSessionRichHistory()` hydrates `turnEvents` from the persisted ADR 0003 `structural_turn_event` rows (`src/events/ConversationManager.ts:751-767`), so a fixture captures the stored event log, not a fresh consolidation.

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
