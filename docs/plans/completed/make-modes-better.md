# Make Edit Modes Better

**Status:** Complete — all three modes implemented and verified

**Depends on:** DiffManager extraction (complete), sandbox research (complete)

---

## Context

The three edit modes (manual / ask / auto) control how the LLM's code output is handled:

| Mode | Behavior |
|------|----------|
| **Manual (M)** | Code blocks rendered in chat. User manually copies/applies. |
| **Ask (Q)** | Diff tabs auto-open. User reviews and accepts/rejects. **LLM blocks and waits for result.** |
| **Auto (A)** | Code applied directly to files. No user confirmation. |

## Blocking Ask Mode — IMPLEMENTED

Ask mode now **blocks** — the LLM waits for user accept/reject before continuing. This was the core feature of this plan.

### Architecture

The blocking flow uses Promise-based pending approvals in DiffManager:

**V3 (tool calls):**
```
LLM turn → apply_code_edit tool → diff shown → [BLOCKS] → user accept/reject → feedback injected → LLM continues
```

**R1 (shell/code tags):**
```
LLM turn → code block detected → diff shown → iteration ends → [BLOCKS] → user accept/reject → feedback as user msg → LLM continues
```

### Implementation Details

#### DiffManager (`src/providers/diffManager.ts`)
- `pendingApprovals: Map<string, { resolve, filePath }>` — stores Promises that block until user acts
- `registerPendingApproval(diffId, filePath)` — creates a Promise for a diff
- `waitForPendingApprovals()` — awaits all pending Promises, returns results array
- `cancelPendingApprovals()` — rejects all pending on abort/error
- Auto-superseding: when the same file gets a new diff, the old pending approval is auto-rejected
- Diff tab close → resolves as rejected
- Accept/reject buttons → resolve as accepted/rejected

#### RequestOrchestrator (`src/providers/requestOrchestrator.ts`)
- **V3 tool loop**: After `apply_code_edit` execution, if edit mode is "ask":
  1. Closes the current tool batch UI
  2. Calls `diffManager.waitForPendingApprovals()`
  3. Injects feedback: "User applied changes to foo.ts" or "User rejected changes to foo.ts"
  4. Opens new tool batch for next iteration
- **R1 iteration boundary**: After iteration ends with pending diffs:
  1. Calls `diffManager.waitForPendingApprovals()`
  2. Injects feedback as system message before next iteration
- Guard: `batchToolDetails` array bounds check after ask mode closes batch mid-loop

#### Webview Pending Files UI
- `VirtualMessageGatewayActor.handleDiffListChanged()` — routes diffs to correct pending group:
  - Global search by diffId (prevents re-adding resolved diffs)
  - Path-based lookup with resolved entry fall-through (retries get new groups)
  - New diff creation for truly new files
- `MessageTurnActor.updatePendingStatus()` — three-tier lookup for status updates:
  - Direct fileId match
  - Fallback by diffId (preferred, prevents wrong group match on retries)
  - Fallback by filePath (last resort)
- `MessageTurnActor.startStreaming()` — renders role header immediately so V3 assistant turns have visible height from the start (fixes whitespace gap)

#### Layout: Bottom-Push Chat Style
- `VirtualListActor.updateContentHeight()` computes `marginTop = max(0, viewport - totalHeight)` in JS
- CSS `margin-top: auto` was unreliable in VS Code webview; explicit JS computation is used instead
- `defaultTurnHeight: 0` — turns start with zero height, grow when content arrives
- `measureTurnHeight()` called synchronously (no `requestAnimationFrame` delay)
- ResizeObserver fires before paint (no rAF wrapper)

### Key Files Modified

| File | Changes |
|------|---------|
| `src/providers/requestOrchestrator.ts` | Ask mode blocking wait, feedback injection, batch guard |
| `src/providers/diffManager.ts` | Pending approvals Map, register/wait/cancel, auto-supersede |
| `src/providers/types.ts` | WaitingForApprovalEvent type |
| `src/providers/chatProvider.ts` | Wiring for waitingForApproval event |
| `media/actors/message-gateway/VirtualMessageGatewayActor.ts` | Diff reconciliation with resolved fall-through |
| `media/actors/turn/MessageTurnActor.ts` | diffId priority in updatePendingStatus, early header render |
| `media/actors/turn/styles/index.ts` | Removed spinning animation |
| `media/actors/virtual-list/VirtualListActor.ts` | JS margin-top, sync measurement, no rAF in ResizeObserver |
| `media/actors/virtual-list/types.ts` | defaultTurnHeight: 0 |
| `media/chat.css` | Removed CSS margin-top: auto (replaced by JS) |

### Decisions Made

| Question | Decision |
|----------|----------|
| **Should ask mode always block?** | Yes. Non-blocking ask is what we have today (fire-and-forget). If users want non-blocking, they use auto mode. |
| **Batch vs individual approval?** | Individual per file. Simpler, more control. |
| **Timeout on approval?** | No timeout. If the user walks away, the LLM waits. |
| **Ask mode UI for diffs?** | Existing diff tab with accept/reject buttons. No new UI needed. |
| **Where does blocking happen?** | Option B — block at iteration boundaries (after each tool loop iteration for V3, after each shell iteration for R1). |

### Test Coverage

| Test File | Coverage |
|-----------|----------|
| `tests/unit/providers/diffManager.test.ts` | Pending approvals: register, resolve, cancel, auto-supersede, waitForPendingApprovals |
| `tests/unit/providers/requestOrchestrator.test.ts` | Tool loop, streaming, context compression |
| `tests/actors/turn/MessageTurnActor.test.ts` | Header render on startStreaming, diffId fallback in updatePendingStatus, pending file grouping |
| `tests/actors/virtual-list/VirtualListActor.test.ts` | Streaming turn binding, height measurement, margin-top computation |

### Logging Coverage

All critical decision points have debug/warn logging:
- `requestOrchestrator.ts`: Batch guard skip logged when batch closed mid-loop
- `VirtualListActor.ts`: Height deltas logged in measureTurnHeight, streaming turn binding logged
- `MessageTurnActor.ts`: Pending status transitions logged with match type (fileId/diffId/filePath), warning on file not found
- `VirtualMessageGatewayActor.ts`: Diff reconciliation path logged (global match / path match / resolved fall-through / new entry)

---

## Manual Mode — UI Fixes — IMPLEMENTED

Manual mode renders code blocks in the chat with Diff, Apply, and Copy buttons.

### Issues Resolved

| Issue | Resolution |
|-------|------------|
| **`apply_code_edit` tool calls did nothing in manual mode** | Added manual mode handler in `requestOrchestrator.ts` that calls `diffManager.showDiff()` — opens diff tab for user review |
| **Copy button** | Already worked correctly — copies code block text content to clipboard |
| **No file target** | `# File: path` header in code blocks is parsed by both `showDiff` and `applyCode` to target the correct file |
| **No feedback after apply** | Permanent "✓ Applied" state with green background; Diff button greyed out |
| **Code block header layout** | Buttons (Diff/Apply/Copy) stay right-aligned when expanded via `margin-left: auto` on `.code-actions` |
| **Diff tab didn't close after Apply** | `applyCode` closes the diff via `closeSingleDiff`; removed `focusTargetFile` which was opening unwanted file tabs |
| **Apply stole focus from chat** | `applyCode` refactored to use `WorkspaceEdit` (no visible editor needed); file opened in background with `preserveFocus: true` |
| **No syntax highlighting** | Custom syntax highlighter (`media/utils/syntaxHighlight.ts`) with ~40 languages, replaced unused `highlight.js` dependency |

### Implementation Details

#### Manual mode `apply_code_edit` handler (`src/providers/requestOrchestrator.ts`)
- When edit mode is "manual" and a V3 `apply_code_edit` tool call arrives, constructs code with `# File:` header and calls `diffManager.showDiff()` to open a diff tab for user review

#### Permanent applied state (`media/actors/turn/MessageTurnActor.ts`)
- Apply button click handler: adds `.applied` class to code block, sets text to "✓ Applied"
- `.applied` class: green background on Apply button (non-clickable), greyed-out Diff button
- Requires `.diffed` class (must click Diff first) — prevents applying without reviewing

#### `applyCode` refactored to `WorkspaceEdit` (`src/providers/diffManager.ts`)
- Target file path known: `openTextDocument` → `WorkspaceEdit` → `applyEdit` → `showTextDocument(preserveFocus: true)`
- No target file path: falls back to active editor, also uses `WorkspaceEdit`
- Diff auto-closes via `closeSingleDiff` after apply; no `focusTargetFile` call

#### Syntax highlighter (`media/utils/syntaxHighlight.ts`)
- Left-to-right scanner: comments > strings > numbers > keywords
- Three tokenizer modes: standard (keyword-based), markup (HTML/XML), CSS
- ~40 language definitions with keyword/type/builtin lists, 40+ aliases
- Dark/light/high-contrast theme support via `:host-context(.vscode-light)`
- Lazy-cached keyword Sets; logging via `createLogger('SyntaxHL')` with deduped warnings

### Key Files Modified

| File | Changes |
|------|---------|
| `src/providers/requestOrchestrator.ts` | Manual mode `apply_code_edit` handler |
| `src/providers/diffManager.ts` | `applyCode` refactored to `WorkspaceEdit`, removed `focusTargetFile` |
| `media/actors/turn/MessageTurnActor.ts` | Permanent applied state, syntax highlighting integration |
| `media/actors/turn/styles/index.ts` | `.applied` CSS, `margin-left: auto` on `.code-actions`, syntax highlight styles |
| `media/utils/syntaxHighlight.ts` | **New** — custom syntax highlighter (~550 lines) |
| `tests/unit/utils/syntaxHighlight.test.ts` | **New** — 92 tests for highlighter |
| `package.json` | Removed unused `highlight.js` dependency |

### Test Coverage

| Test File | Coverage |
|-----------|----------|
| `tests/unit/providers/requestOrchestrator.test.ts` | Manual/auto/ask mode `apply_code_edit` handling |
| `tests/unit/utils/syntaxHighlight.test.ts` | All tokenizer modes, 26 language spot checks, edge cases, text preservation |

---

## Auto Mode — Command Approval — IMPLEMENTED

Auto mode trusts code edits (applies them without confirmation), but **commands require approval**. Implemented as a full sandboxing system — see `docs/plans/completed/sandbox.md` for the complete plan.

### What Was Built

- **CommandApprovalManager** (`src/providers/commandApprovalManager.ts`) — prefix-based rule engine with encrypted SQLite storage, platform-aware defaults (Unix/Windows)
- **Inline approval widget** — appears in chat when a command needs approval, with Allow / Block / Always Allow / Always Block buttons
- **Rules modal** (`media/actors/command-rules/CommandRulesModalActor.ts`) — unified alphabetical list with checkboxes (checked=approved), filter chips, search, add/delete, reset to defaults
- **`allowAllShellCommands` bypass** — setting that skips all approval checks when enabled
- **Edge cases** — cancel pending approvals on stop/new conversation, generation abort handling
