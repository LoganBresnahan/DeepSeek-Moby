# Make Edit Modes Better

**Status:** Partially Implemented

**Depends on:** DiffManager extraction (complete), sandbox research

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

## Manual Mode — UI Fixes (NOT STARTED)

Manual mode renders code blocks in the chat and leaves it to the user to copy/apply. The basic diff apply buttons need fixing:

### Current Issues

| Issue | Description |
|-------|-------------|
| **Apply button missing/broken** | Code blocks in chat should have a clear "Apply" button that opens a diff tab or applies directly |
| **Copy button** | Should reliably copy the code block content to clipboard |
| **No file target** | When the LLM outputs a code block with `# File: path`, the apply button should know which file to target |
| **No feedback after apply** | User clicks apply but gets no visual confirmation it worked |

### TODO

- [ ] Audit the current manual mode code block buttons (copy, apply)
- [ ] Fix apply button to open diff tab targeting the correct file
- [ ] Add visual feedback (checkmark, "Applied" label) after successful apply
- [ ] Ensure copy button works reliably across all code block types

---

## Auto Mode — Command Approval (NOT STARTED)

Auto mode trusts code edits (applies them without confirmation), but **commands should still require approval**. "I trust your code changes" is very different from "run anything on my system."

This ties into the sandboxing research in `docs/plans/sandbox.md` — the tiered command approval system (safe/dev/dangerous categories, learn-as-you-go allowlists) applies specifically to auto mode's command execution path.

### TODO

- [ ] Define which commands auto-approve in auto mode (safe + dev tool categories)
- [ ] Add approval gate for unknown/dangerous commands even in auto mode
- [ ] UI for command approval — VS Code QuickPick or inline chat widget
- [ ] Persist "always allow" / "always block" decisions to settings
