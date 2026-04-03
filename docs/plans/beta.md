# DeepSeek Moby - Beta Release Roadmap

**Goal:** Ship a production-ready beta before/alongside DeepSeek V4 release.

---

## 1. ContextBuilder Ack Tokens Bug (B3) — DONE

### The Bug

When messages are dropped due to context window limits, ContextBuilder injects a snapshot summary plus a fake assistant "acknowledgment" message. The summary tokens were counted against the budget, but the ack message tokens (~31) were not.

**Fix applied:** `src/context/contextBuilder.ts` — ack message tokens are now counted via `tokenCounter.countMessage()` and included in the budget check (`injectionCost = summaryTokens + ackTokens`). All 21 ContextBuilder tests pass.

### Context Warning UI (#11)

**Deferred.** The silent auto-compression works well enough for beta. Users don't need to see token counts to have a good experience. Revisit post-beta if users report context issues.

---

## 2. UI Updates

### 2a. Settings Popup

**Current sections** (in `media/actors/settings/SettingsShadowActor.ts`):
1. **Logging** — Extension output level, webview console level, trace collection toggle, color-coded logs toggle, "Open Logs" button
2. **Reasoner (R1)** — "Walk on the Wild Side" checkbox (allows all shell commands)
3. **System Prompt** — Textarea + Save/Reset/Show Default buttons
4. **Web Search** — Search depth, credits per prompt, results per request, cache duration, clear cache button
5. **History** — Auto-save toggle, "Clear All History" danger button
6. **Debug** — Test Status / Test Warning / Test Error buttons
7. **Reset** — "Reset All to Defaults" danger button

**Candidates for removal/change:**
- **Debug section** — Development-only, remove for beta
- **Trace collection toggle** — Too technical for users, remove (keep enabled by default so we get traces when users report issues)
- **Color-coded logs toggle** — Minor, remove to reduce clutter
- **Logging levels** — Could simplify to a single "Verbose logging" toggle instead of two dropdowns

**Visual improvements needed:**
- Better section dividers and spacing
- Consistent padding/margins between controls
- Consider grouping related items more clearly

### 2b. Input Box Resizing & Scroll

**Current behavior** (`media/actors/input-area/InputAreaShadowActor.ts`):
- Auto-resizes from 1 row up to `max-height: 200px`
- After 200px, internal scrollbar appears (default browser styling)
- `resize: none` in CSS (no manual drag-to-resize)

**Issues:**
- 200px max may be too small for large prompts (plan descriptions, code pastes)
- No styled scrollbar — uses default browser appearance
- No visual indicator that there's more content below the visible area

**Recommendations:**
- Increase max-height to ~300-400px (or make it a percentage of viewport)
- Style the scrollbar to match VS Code theme
- Consider a "expand to full editor" button for very large inputs

### 2c. Fork Icon — DONE

Changed from obscure Unicode `\u2442` (⑂) to 🍴 fork emoji at 16px. Also implemented:
- **Fork auto-send**: Forking from a user message automatically re-sends it to get a fresh response
- **Fork notification**: Moved from floating toast to bottom status panel
- **Divider redesign**: Removed dashed lines, left-aligned labels, "DEEPSEEK MOBY" → "MOBY"
- **User messages italic**: User message content renders in italics for visual distinction

### 2d. SVG Icons Audit

**Current SVGs:** 8 inline SVGs total, all in webview code:
- **Toolbar** (`media/actors/toolbar/ToolbarShadowActor.ts`): 7 icons — files, edit (M), plan (P), search, attach, send, stop
- **Status Panel** (`media/actors/status-panel/StatusPanelShadowActor.ts`): 1 icon — logs

**VS Code Marketplace SVG restrictions:**
- The extension **icon** in `package.json` cannot be SVG (we use `moby.png` — fine)
- SVGs in README/CHANGELOG badges must be from trusted providers
- **Inline SVGs in webview HTML are allowed** — webviews are sandboxed iframes, no marketplace restriction applies

**Verdict:** Our SVGs are fine. They're inline in the webview (not in package metadata), all 16x16, all use `currentColor` for theme compatibility. No action needed. The "M" and "P" icons are actually text-in-SVG, not traditional SVGs — they could be plain text if preferred.

### 2e. Modified Files Dropdown Mode Switching Bug — DONE

**Fixes applied:**
1. **renderPendingFiles crash**: `setupPendingHandlers()` called non-existent `this.renderPendingFiles()`. Fixed to find group by containerId and call `this.renderPendingGroup(group)`.
2. **Mode switching**: Added `editMode: EditMode` to `PendingGroup` type. Each group stores the edit mode at creation time. `renderPendingGroup()` uses `group.editMode` instead of the global `this._editMode`. Switching modes no longer retroactively changes existing dropdowns.
3. **History restore**: editMode persisted in `_file_modified` event arguments, extracted in `getSessionRichHistory`, threaded through history restore → VirtualListActor → MessageTurnActor.

Files changed: `types.ts`, `MessageTurnActor.ts`, `VirtualListActor.ts`, `VirtualMessageGatewayActor.ts`, `ConversationManager.ts`, `requestOrchestrator.ts`.

### 2f. Dropdown Header Hover Highlight — DONE

Removed `background: var(--vscode-list-hoverBackground)` from 5 hover rules: code-header, thinking-container, tools-container, shell-container, pending-container. Also removed vertical padding from `.tools-header` and `.pending-header`.

### 2g. General Styling Pass

Owner-driven task. Walk through every popup, modal, dropdown, and panel to verify:
- Consistent spacing and padding
- Font sizes and weights
- Color consistency with VS Code theme
- Responsive behavior at different panel widths

---

## 3. Better Interrupts

### Current State

A plan file exists at `docs/plans/better-interrupts.md` but is **empty**.

**What works today:**
- Stop button swaps in during streaming (send/stop toggle)
- `AbortController` cancels the HTTP stream
- Partial response saved to history with `*[Generation stopped]*` marker
- **Interrupt-on-send** works: user types during streaming → message queued → stop signal sent → after stop, queued message auto-sent (100ms delay)
- Tool loop checks `signal.aborted` at iteration boundaries

**What's broken/incomplete:**

| Issue | Severity | Detail |
|-------|----------|--------|
| Tool execution not interruptible | Medium | Once a tool starts (file read, grep), must complete. Signal only checked between iterations. |
| Shell commands not interruptible | Medium | No cancellation token passed to shell execution. Must wait for completion or `maxShellIterations` limit. |
| No explicit abort check in streaming loop | Low | `streamAndIterate()` relies on HTTP exception, no direct `signal.aborted` check |
| `StreamingActor.abortStream()` never called | Low | Method exists but unused — `endStream()` used for both normal and abort cases |
| Partial save uses wrong finish reason | Low | Aborted responses recorded as `finishReason: 'length'` instead of `'interrupted'` |
| Two separate queueing mechanisms | Info | `_pendingInterrupt` (webview) and `_pendingMessages` (extension, for summarization) are independent |

**Recommendations for beta:**
- Fix the finish reason semantics (trivial)
- Add explicit `signal.aborted` check in streaming loop (safety net)
- Add abort signal propagation to shell command execution
- Document the interrupt-on-send feature (it actually works well, users should know about it)
- Defer mid-tool cancellation to post-beta (complex, requires tool-level abort support)

---

## 4. Command Audit

### Current: 39 Commands

**Production user-facing (25):**
- Chat: `startChat`, `clearConversation`, `newChat`, `switchModel`
- History: `showChatHistory`, `searchChatHistory`, `exportChatHistory`, `importChatHistory`, `clearChatHistory`, `exportCurrentSession`
- Settings: `setApiKey`, `setTavilyApiKey`, `openCommandRules`
- Info: `showStats`, `showLogs`
- Code actions (7, marked `[Experimental]`): `explainCode`, `refactorCode`, `documentCode`, `fixBugs`, `optimizeCode`, `generateTests`, `insertCode`
- UI: `showDiffQuickPick` (Ctrl+Shift+D)

**Debug/dev-only (7):**
- Trace: `exportTrace`, `copyTrace`, `viewTrace`, `clearTrace`, `traceStats`
- Log export: `exportLogsAI`, `exportLogsHuman`

**Specialized (2):**
- Drawing: `startDrawingServer`, `stopDrawingServer`

**Recommendations:**
- **Keep log exports** — rename to `[Beta] Export Logs (AI)` and `[Beta] Export Logs (Human)`. These are critical for user bug reports. If a user has issues, we want them to send trace/log exports.
- **Keep trace commands but hide** — Don't show in default Command Palette. Available via `deepseek.devMode` only. Or prefix with `[Debug]`.
- **Remove drawing server commands** — Phase 1 feature, not ready for beta users.
- **Remove `[Experimental]` labels** — Code actions work. Ship them with confidence or remove them entirely.
- **Audit `showDiffQuickPick`** — Does this still work with the new DiffManager? Verify.

---

## 5. Shipping Moby (Beta Release Strategy)

### Inspector & Dev Mode

The inspector (`media/dev/inspector/InspectorShadowActor.ts`, 1712 lines) is already **conditionally loaded** — only when `deepseek.devMode = true` (default: `false`). It's a separate bundle (`dev.js`) that doesn't ship in the production `chat.js`.

**Issue:** The inspector *button* in the header is always visible, even when devMode is off. It does nothing when clicked without devMode.

**Fix:** Conditionally render the inspector button in the HTML template based on `isDevMode`.

### Recommended Beta Defaults

| Setting | Default | Rationale |
|---------|---------|-----------|
| `devMode` | `false` | Users don't need the inspector |
| Trace collection | `true` (hidden from settings) | We need traces for debugging reports |
| Log level | `INFO` | Balanced output for issue reports |
| `exportLogsAI` / `exportLogsHuman` | Visible | Critical for beta feedback loop |

### Beta Feedback Loop

1. User encounters issue
2. User runs `Moby: Export Logs (Human)` from Command Palette
3. Sends exported file to developer
4. Developer can also request `Export Logs (AI)` format for deeper analysis

### CI/CD Pipeline

**Current state:** `.github/workflows/release.yml.disabled` exists with a complete 3-job pipeline:
1. **build** — Multi-platform (Ubuntu, Windows, macOS), Node 18, tests
2. **package** — `vsce package`, uploads VSIX artifact
3. **publish** — `vsce publish` on `v*` tags, requires `VSCE_PAT` secret

**What's needed to enable:**
1. Rename `release.yml.disabled` → `release.yml`
2. Create GitHub Secret: `VSCE_PAT` (VS Code Marketplace Personal Access Token)
3. Verify `npm run package` produces a valid VSIX
4. Test workflow on a branch first
5. Tag a release: `git tag v0.1.0-beta && git push --tags`

**Missing but nice-to-have:**
- No `npm run lint` script (workflow references it with `--if-present`, so it's optional)
- No automated changelog
- No pre-release channel configuration in marketplace

**`.vscodeignore` is correctly configured** — excludes source, configs, WASM source. Only dist/ output ships.

---

## 6. Plan Mode

### Current State

- "P" button exists in toolbar (`media/actors/toolbar/ToolbarShadowActor.ts`)
- Clicking sends `{ type: 'togglePlan', enabled: true }` to extension
- Title says "Plan (coming soon)"
- **No backend handler** — message is received but not processed

### Proposed Design (Simple Version)

**Concept:** When "P" is clicked, create a plan markdown file for the current session. The file is automatically included in the LLM's context on every message. User and LLM can both reference and update it.

**Implementation:**

1. **File creation:**
   - Create `.moby-plans/` directory in workspace root (add to `.gitignore` suggestion)
   - File name: `plan-{sessionId-short}.md` or `plan-{timestamp}.md`
   - Open the file in a VS Code editor tab alongside the chat

2. **Context injection:**
   - On every user message, read the plan file contents
   - Inject into system prompt: `[Active Plan]\n{contents}\n[End Plan]`
   - Similar pattern to how `fileContextManager.getSelectedFilesContext()` works

3. **LLM awareness:**
   - Add to system prompt: "The user has an active plan file. Reference it when relevant. You can suggest updates to the plan."
   - LLM can suggest edits but cannot directly write to the plan file (user maintains control)

4. **Toggle behavior:**
   - P button on → create file (if not exists), inject into context
   - P button off → stop injecting into context (file remains)

**Complexity estimate:** Medium. ~2-3 hours. The context injection pattern is well-established (see fileContextManager, webSearchManager). The main work is file lifecycle management and the VS Code editor integration.

**Recommendation for beta:** Include if time permits. It's a differentiating feature that's simple in concept. The MVP is just "create file + inject into system prompt" — no fancy UI needed.

---

## 7. File Context Manager — Is It Needed?

### What It Does

`src/providers/fileContextManager.ts` (529 lines) provides:
- Modal for selecting files from open editors or workspace search
- Selected files get injected into the system prompt as full content
- Sophisticated file path inference (6-strategy fallback) for code edits

### Analysis

**Arguments for keeping:**
- Explicit file selection gives users control over what context the LLM sees
- Workspace search helps users find files in large repos
- File path inference is genuinely useful when LLM generates edits without specifying a file
- Some users prefer to manually curate context rather than trust the LLM

**Arguments for simplifying:**
- DeepSeek models with tool use can read files themselves (read_file, search_files tools)
- Users may not understand why they need to manually add files
- The UI is another thing to learn and can be confusing

**Recommendation for beta:** Keep it, but don't make it prominent. The toolbar already has the files button — leave it as-is. Power users will find it; casual users can ignore it. The file path inference logic is genuinely needed for code edits regardless of the modal UI.

---

## 8. GitHub Actions Deployment

See Section 5 (CI/CD Pipeline) for full details.

**Action items:**
1. Enable the existing workflow (`release.yml.disabled` → `release.yml`)
2. Get a VS Code Marketplace publisher account and Personal Access Token
3. Add `VSCE_PAT` as a GitHub repository secret
4. Test with a dry run: `vsce package` locally, install VSIX manually
5. Tag and push to trigger automated publish
6. Consider pre-release flag: `vsce publish --pre-release` for beta

---

## 9. README Overhaul

### Current State

`README.md` is 102 lines. Lists basic features but is significantly outdated. Missing:

**Features not mentioned:**
- Session management with fork support
- Edit modes (Manual / Ask / Auto)
- File context selection
- Three-tier logging and tracing system
- Command approval system for shell commands
- Context window management (sliding window, summarization)
- Event-sourced conversation history
- Database encryption (SQLCipher)

**Settings table incomplete:** Lists 8 settings, actual count is 12+

**No screenshots or demos**

### Recommended Structure

```
# DeepSeek Moby

> An AI coding assistant for VS Code, powered by DeepSeek.

## Features
- Chat with DeepSeek V3 (chat) and R1 (reasoning)
- Tool use: file read/write, search, shell commands
- Edit modes: Manual, Ask, Auto
- Session history with conversation forking
- Web search integration (Tavily)
- Context window management with auto-summarization
- Code actions: Explain, Refactor, Document, Fix, Optimize, Test

## Getting Started
1. Install from marketplace (or VSIX)
2. Set API key: Cmd+Shift+P → "Moby: Set API Key"
3. Open chat: Click Moby icon in sidebar

## Configuration
[Updated settings table with all settings]

## Commands
[Organized list of all user-facing commands]

## Architecture (For Contributors)
- Event-driven coordinator pattern
- Actor model UI with Shadow DOM encapsulation
- Event-sourced persistence with SQLCipher encryption
- See REMINDER.md for full technical details

## Privacy
[Existing privacy statement]

## License
AGPL
```

---

## Priority Order for Beta

### Completed

| Item | Details |
|------|---------|
| ~~Fix B3 ContextBuilder ack tokens (#1)~~ | Ack message tokens now counted in budget check |
| ~~UI bug fixes: mode switching (#2e), renderPendingFiles crash, dropdown hover (#2f)~~ | editMode per-group, history restore, hover removal |
| ~~Fork icon + UX (#2c)~~ | 🍴 emoji, auto-send on user fork, toast → status panel, divider redesign, user italics |
| ~~Streaming guards~~ | Model selector, edit mode, and plan buttons disabled during active requests |
| ~~Command audit (#4)~~ | Removed duplicates (newChat/clearConversation, showChatHistory/searchChatHistory), removed 7 experimental code actions, consolidated log commands (exportLogsAI removed, exportLogsHuman → exportLogs) |
| ~~Settings cleanup (#2a)~~ | Removed logging section (default debug), reasoner section (in system commands), web search settings (dedicated popup), history section (always auto-save), reset all. Added API key buttons, kept debug buttons with pub/sub |
| ~~System prompt modal~~ | New modal with saved prompts DB table, per-model tags, active/deactivate, unsaved changes bar, save as flow. Removed facade defaults — empty = use built-in prompt |
| ~~Prompt improvements~~ | Trimmed system prompt, split per-model (reasoner vs chat), added conversational gate, removed "AND" from SEARCH/REPLACE separator |
| ~~Drawing server WSL2 fix~~ | Shows netsh port-forward command for WSL2 users in drawing server popup |
| ~~Popup architecture fix~~ | PopupShadowActor base class: triggerElement support, auto-fixed positioning. Applied to plans and web search popups |
| ~~Model selector per-model settings~~ | maxTokens stored per-model so switching doesn't overwrite. Temperature hidden for Reasoner (not supported). "No Limit" display for shell iterations |
| ~~Auto new session on model switch~~ | Switching models creates a new session automatically (no mixed-model conversations) |
| ~~DiffEngine separator fix~~ | Removed "AND" from `=======` separator. Parser accepts bare `=======`. Better model compliance |
| ~~Inline shell execution~~ | Shell commands execute inline during streaming (one at a time, interleaved with text). File watcher detects modifications. Heredoc-aware parsing |
| ~~File context modal fixes~~ | Fixed deselect/re-select bug, search result reappear bug. Removed cancel button and add-all |
| ~~Thinking dropdown scroll~~ | User can scroll up during streaming thinking; auto-follows when scrolled to bottom |
| ~~Dropdown padding~~ | 6px top/bottom padding on shell, tools, pending headers (matches thinking) |
| ~~Command approval: full command as unit~~ | No chain splitting — full command is one rule entry. Blocked commands show approval prompt (user can override) |
| ~~File notification queuing~~ | Async file watcher notifications queued during streaming, flushed at natural break points (shell, iteration, endResponse). Prevents text splitting mid-word |
| ~~CQRS unified rendering~~ | Real-time CQRS: TurnEventLog + TurnProjector. Live streaming and history restore use same code path. Eliminates text splitting, ordering bugs, missing approvals/shells in history. 1902 tests passing |
| ~~CQRS event persistence~~ | Webview's event log sent to extension for DB storage (replaces lossy `buildTurnEvents` reconstruction). `consolidateForSave()` compresses ~2000 per-token events to ~20-50 structural events |
| ~~Command approval bugs (B1-B2)~~ | `updateLayout()` → `measureTurnHeight()` fix. Approval events always recorded in CQRS log. Shell/diff-engine source distinction for causal linking |
| ~~UI polish pass~~ | Web search popup state sync (onOpen request pattern), toolbar button state on startup, command rules modal fixed height + column layout, scroll-to-bottom button removed, streaming disable audit (fork/apply/accept/reject/newChat/sessionSwitch), send button disabled without API key, web search button disabled without Tavily key, encryption key management UI |
| ~~DiffManager fixes~~ | Manual mode skips pending dropdown, `source` field corrected (`diff-status` vs `diff-engine`), diff tab close resets code block buttons (shadow DOM query fix), `_onDiffClosed` wired up |

### Active Bugs

| # | Bug | Status | Details |
|---|-----|--------|---------|
| B1 | Command approval: streaming not paused during prompt | **Fixed** | CQRS Step 6: projector handles segment flow. `updateLayout()` → `measureTurnHeight()` fix. Approval widget renders and resolves correctly |
| B2 | Command approval: no visual feedback after decision | **Fixed** | Root cause: `createCommandApproval` threw from missing `updateLayout()`, so `_pendingApprovalId` was never set. Fixed + CQRS approval events always recorded |
| B3 | Duplicate rules in system commands modal | **Fixed** | Not a real bug — double broadcast caused unnecessary re-render but no visible duplicates. Fixed double-broadcast by removing redundant `getCommandRules` request on modal open |
| B4 | History restore ordering differs from live | **Fixed** | CQRS architecture: unified event log + projector for both live streaming and history restore. `buildTurnEvents` (lossy reconstruction) replaced with webview's actual event log sent to extension for DB storage |
| B5 | History text splitting around file modifications | **Fixed** | `projectIncremental` text-append uses `findLastIncomplete('text')` instead of checking last segment. File-modified events no longer split text flow |
| B6 | Web search popup: mode not restored on startup | **Fixed** | Popup now requests fresh state on open (`getWebSearchSettings`), gateway handles `webSearchSettings` response and publishes to popup's subscription keys. Follows SystemPrompt/Files pattern |
| B7 | Web search popup cleanup | **Fixed** | Renamed "Manual" → "Forced", removed Enable/Disable buttons. Selecting Forced auto-enables, selecting Off/Auto auto-disables |
| B8 | Streaming disable audit | **Fixed** | Disabled during streaming: fork button, apply code button, accept/reject file buttons. New Chat and session switch stop active generation first. `isGlobalStreaming()` helper on MessageTurnActor |
| B9 | DiffManager creates new file instead of editing existing | **Fixed** | Workspace-relative path resolution issue resolved |
| B10 | Manual mode: diff tab stays open after apply | **Fixed** | Diff tab now closes on accept in manual mode |
| B11 | Web search button disabled without Tavily key | **Fixed** | Toolbar disables search button with tooltip "Tavily API key not set" when not configured. Send button disabled with tooltip when no DeepSeek API key |
| B12 | Command rules modal fixed height | **Fixed** | Modal uses `height: 80vh` instead of `max-height` so switching filters doesn't resize. Rules list uses CSS columns for top-to-bottom alphabetical flow |
| B13 | Scroll-to-bottom button removed | **Fixed** | Removed button, styles, creation/visibility/cleanup code from ScrollActor |
| B14 | Approval widget reverts on turn rebind | Fixed | Approval status + persistent flag persisted in VirtualListActor data, approval status stored in event history for session reload |
| B15 | Database encryption key management | **Fixed** | New settings section + command for viewing, changing, and regenerating the SQLCipher encryption key via `PRAGMA rekey` |
| B16 | Modified files dropdown ordering vs "Seeking..." text | **Fixed** | During streaming, the Moby "diving/seeking" animation appears ABOVE the modified files dropdown. Fix: `addPendingFile()` now moves the text container to the end of the parent element during streaming, so the animation always stays below file dropdowns |
| B17 | Rejected edit not restored from history | **Fixed** | In ask mode, the turn was saved at `endResponse` before the user accepted/rejected, so `file-modified` events had `status: 'pending'`. Fix: on accept/reject, `updateFileModifiedStatus()` writes the decision back to the DB's turnEvents blob. Webview now sends `filePath` with accept/reject messages |
| B18 | File context button color indicator | **Fixed** | When files are selected for context, the files button should change color (same as plan button when plans are active) to indicate files are attached |
| B19 | Multi-vocabulary tokenizer support | **Fixed** | V3/R1 share one 128K vocabulary. DeepSeek V4 (~1T params, 1M context, multimodal) will likely use a different tokenizer. Need to support multiple vocab files loaded per-model — `tokenService.countTokens(text, model)` picks the right tokenizer. WASM binary (BPE logic) stays the same, only `.br` vocab files change. See: DeepSeek V4 uses Engram memory, multimodal generation — tokenizer changes expected |
| B20 | Platform-specific VSIX packaging | **Fixed** | Shipping all 6 SQLCipher prebuilds (12MB) to every user. Fix: `vsce --target` publishes platform-specific VSIXs — each user downloads only their ~2MB prebuild |
| B21 | Input area layout and expand/collapse | **Fixed** | Attachment chips overflow and expanded textarea covers chat content. Fix: move input from absolute positioning to flex layout, add collapse/expand toggle arrow |
| B22 | History rename reorders list | **Fixed** | Renaming a session causes it to jump position because `updated_at` was set to `Date.now()`. Fix: rename only updates `title` column without touching `updated_at` |
| B23 | Last thinking dropdown keeps pulsing | **Fixed** | Final thinking iteration pulse animation doesn't stop until response ends. Fix: `emitThinkingCompleteIfOpen()` now uses `emitTurnEvent()` so the projector produces the mutation that calls `completeThinkingIteration()` |
| B24 | "Seeking/Developing..." animation persists after response ends | **Fixed** | `endStreaming()` set `_isStreaming = false` but didn't re-render the text content, so the animation HTML stayed in the DOM. Fix: re-render the current text segment in `endStreaming()` so `formatContent` runs without the streaming flag and removes the animation |
| B25 | Chained shell commands miss file watcher deletions | **Open** | When DeepSeek chains `ls` and `rm -f` with `;` in a single command, the file watcher may miss the deletion event (100ms window too short or events batched by OS). No "Modified Files" dropdown appears for the deleted files |
| B26 | History restore dropdown positioning differs from live | **Open** | During live streaming, `file-modified` events are positioned via `insertCausal` after the shell that triggered the diff. On restore, `text-append` events are consolidated into single blocks, shifting relative positions so the dropdown renders in a different location |

### Testing Audit Needed

Modified files and pending files dropdowns need comprehensive testing across all edit modes:
- Auto mode: file watcher detection, multiple files, ordering vs text
- Ask mode: accept/reject flow, history restore of accepted AND rejected states
- Manual mode: diff/apply flow, history restore
- Reasoner shell modifications: file watcher → modified files dropdown ordering
- Multiple iterations: do modified files correctly group or split?

### Remaining Work

| Priority | Item | Effort | Impact |
|----------|------|--------|--------|
| **P0** | ~~Fix all active bugs B1-B15~~ | **Done** | All 15 bugs fixed |
| **P0** | ~~UI polish, streaming audit, DiffManager fixes~~ | **Done** | Web search, toolbar, diff, encryption key, modal styling |
| **P0** | Enable GitHub Actions CI/CD (#8) | 1-2 hrs | Blocker — can't ship without it |
| **P0** | README overhaul (#9) | 2-3 hrs | Blocker — first thing users see |
| **P1** | Hide inspector button when devMode off (#5) | 30 min | Polish |
