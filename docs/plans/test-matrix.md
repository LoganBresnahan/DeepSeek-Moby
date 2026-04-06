# Test Matrix

Comprehensive test scenarios organized by testing layer. Each scenario maps to a specific layer based on what it needs to verify.

**Legend:**
- **Layer 1** = CQRS Pipeline (vitest + happy-dom) — data transformations, no UI
- **Layer 2** = Webview Rendering (Playwright + Chromium) — DOM assertions, no VS Code
- **Layer 3** = VS Code Integration (Playwright + CDP) — full extension lifecycle

---

## Current Coverage Summary

| Category | Test Files | Tests | Gaps |
|---|---|---|---|
| Actors (media/) | 23 | 580+ | 4 untested actors |
| Events pipeline | 3 | 99 | Covered well |
| Providers (src/) | 8 | 379 | 4 untested providers |
| State management | 5 | 143 | Covered well |
| Utilities | 11 | 313 | 11 untested utils |
| Logging/Tracing | 6 | 157 | Covered well |
| Tools | 1 | 53 | Covered well |
| E2E | 2 | 5 | Smoke only |
| **Total** | **62** | **~1,938** | |

---

## 1. CQRS Pipeline Tests (Layer 1)

### 1A. Consolidation Ordering — IMPLEMENTED (9 tests)

All implemented in `tests/events/pipeline.test.ts`.

### 1B. Projection — IMPLEMENTED (7 tests)

All implemented in `tests/events/pipeline.test.ts`.

### 1C. Round-Trip — IMPLEMENTED (5 tests)

All implemented in `tests/events/pipeline.test.ts`.

### 1D. Status Lifecycle — IMPLEMENTED (7 tests)

All implemented in `tests/events/pipeline.test.ts`.

### 1E. Edge Cases — IMPLEMENTED (10 tests)

All implemented in `tests/events/pipeline.test.ts`.

### 1F. New: Streaming Simulation — TODO

Simulate realistic streaming sequences that match what the requestOrchestrator actually produces.

| # | Test | Description |
|---|---|---|
| F1 | R1 full iteration with shell | think → text → shell → file-modified → think → text (2 iterations) |
| F2 | R1 with command approval | think → text → shell → approval-created → approval-resolved → shell-complete |
| F3 | Chat with tool calls | tool-batch-start → tool-update(done) → tool-batch-complete → text |
| F4 | Auto-continuation sequence | iter0 think+text+shell, iter1 think+text+shell, iter2 think+text (3 iterations) |
| F5 | Ask mode blocking flow | text → file-modified(pending) → patch to applied → consolidate → verify applied |
| F6 | Multiple files in one turn | text → file-modified(a.ts) → text → file-modified(b.ts) → text → file-modified(c.ts) |
| F7 | Mixed shell-created and diff files | shell → file-modified(shell,auto) → text → file-modified(diff,ask) |
| F8 | Drawing event | text → drawing → text |
| F9 | Code block event | text → code-block(ts) → text |
| F10 | Web search inline | text → text (search tags stripped at orchestrator level, not in events) |

### 1G. New: Error Recovery — TODO

| # | Test | Description |
|---|---|---|
| G1 | Malformed event in log | Load events with missing fields → project gracefully |
| G2 | Duplicate text-finalize | Two text-finalize for same iteration → no crash |
| G3 | Shell-complete without shell-start | Orphaned shell-complete → ignored gracefully |
| G4 | Empty content text-append | text-append with content='' → consolidated correctly |
| G5 | Very large event log | 10,000 events → consolidate and project within reasonable time |

---

## 2. Webview Rendering Tests (Layer 2)

Tests that load `chat.js` in headless Chromium and assert DOM state via message replay.

### 2A. Message Turn Rendering — TODO

| # | Test | Fixture | Assert |
|---|---|---|---|
| A1 | Simple text response | `{ type: 'text', content: 'Hello world' }` | `.turn-content` contains "Hello world" |
| A2 | Text with markdown | Text with `**bold**` and `\`code\`` | Rendered `<strong>` and `<code>` tags |
| A3 | Thinking dropdown | ThinkingSegment with content | `.thinking-container` visible, expandable |
| A4 | Thinking dropdown collapsed by default | ThinkingSegment complete=true | Dropdown header visible, content hidden |
| A5 | Shell dropdown | ShellSegment with commands+results | `.shell-container` visible with command text |
| A6 | Shell output expandable | ShellSegment with long output | Click header → output visible |
| A7 | Code block with syntax highlighting | CodeBlockSegment | `.code-block` with language class |
| A8 | Code block copy button | CodeBlockSegment | Click copy → clipboard mock called |
| A9 | Multiple segments interleaved | text → thinking → text → shell → text | 5 segments in correct order |
| A10 | Empty text hidden | TextSegment with content='' | Container has `hidden` attribute |

### 2B. Pending Files Dropdown — TODO

| # | Test | Fixture | Assert |
|---|---|---|---|
| B1 | Applied file shows green | FileModifiedSegment status='applied' | `.status-applied` class present |
| B2 | Rejected file shows red | FileModifiedSegment status='rejected' | `.status-rejected` class present |
| B3 | Pending file shows yellow | FileModifiedSegment status='pending' | `.status-pending` class present |
| B4 | Expired file shows muted | FileModifiedSegment status='expired' | `.status-expired` class present |
| B5 | Deleted file shows strikethrough | FileModifiedSegment status='deleted' | `.status-deleted` class present |
| B6 | Ask mode shows Accept/Reject buttons | FileModifiedSegment editMode='ask' | Accept and Reject buttons visible |
| B7 | Auto mode shows "Modified Files" label | FileModifiedSegment editMode='auto' | "Modified Files" title text |
| B8 | Manual mode hides dropdown on restore | FileModifiedSegment editMode='manual' | Dropdown suppressed |
| B9 | Multiple files grouped | 3 FileModifiedSegments | Single dropdown with 3 entries |
| B10 | Accept click sends message | Click accept button | `postMessage({ type: 'acceptSpecificDiff' })` captured |
| B11 | Reject click sends message | Click reject button | `postMessage({ type: 'rejectSpecificDiff' })` captured |

### 2C. Streaming Visual State — TODO

| # | Test | Simulate | Assert |
|---|---|---|---|
| C1 | Thinking pulse during streaming | Send thinking-start, don't complete | Pulse animation CSS class active |
| C2 | Thinking pulse stops after complete | Send thinking-complete | Pulse animation removed |
| C3 | Seeking animation during streaming | Start streaming state | Seeking indicator visible |
| C4 | Seeking animation removed after end | End streaming | Seeking indicator removed |
| C5 | Send button becomes Stop during streaming | Start streaming | Stop button visible, Send hidden |
| C6 | Send button restored after streaming | End streaming | Send visible, Stop hidden |

### 2D. Input Area — TODO

| # | Test | Action | Assert |
|---|---|---|---|
| D1 | Type and send message | Type in textarea, press Enter | `postMessage({ type: 'sendMessage' })` captured |
| D2 | Shift+Enter adds newline | Shift+Enter in textarea | Textarea value has newline, no submit |
| D3 | Empty message not sent | Press Enter with empty textarea | No postMessage fired |
| D4 | Textarea auto-resizes | Type many lines | Textarea height increases |
| D5 | Textarea clears after send | Send message | Textarea value is empty |

### 2E. Toolbar Controls — TODO

| # | Test | Action | Assert |
|---|---|---|---|
| E1 | Edit mode cycles M→Q→A | Click edit mode button 3 times | Button label changes through modes |
| E2 | Edit mode sends message | Click edit mode button | `postMessage({ type: 'setEditMode' })` captured |
| E3 | Model selector opens | Click model button | Model popup visible |
| E4 | Model selection sends message | Click model option | `postMessage({ type: 'selectModel' })` captured |
| E5 | History button opens modal | Click history via commands | History modal visible |
| E6 | Files button opens modal | Click files button | Files modal visible |

### 2F. History Modal — TODO

| # | Test | Action | Assert |
|---|---|---|---|
| F1 | Modal opens with session list | Open modal, inject sessions | Sessions rendered in date groups |
| F2 | Search filters sessions | Type in search input | Only matching sessions visible |
| F3 | Click session sends switch message | Click session entry | `postMessage({ type: 'switchToSession' })` |
| F4 | Delete shows confirmation | Click delete button | Confirmation dialog visible |
| F5 | Rename updates title | Click rename, enter text | `postMessage({ type: 'renameSession' })` |
| F6 | Backdrop click closes modal | Click outside modal | Modal hidden |
| F7 | Escape closes modal | Press Escape | Modal hidden |

### 2G. History Restore Fidelity (CQRS Replay) — TODO

These are the most valuable Chromium tests. They feed real consolidated event fixtures into the webview and verify the rendered output matches what was seen during live streaming.

| # | Test | Fixture | Assert |
|---|---|---|---|
| G1 | Simple text restore | Consolidated text-append + text-finalize | Single text segment rendered |
| G2 | Text + thinking restore | Consolidated thinking + text | Thinking dropdown + text both rendered |
| G3 | Text + shell + file-modified restore | Full R1 turn | Shell dropdown + file dropdown + text rendered |
| G4 | Ask mode applied restore | file-modified(applied, ask) | Green applied status in dropdown |
| G5 | Ask mode rejected restore | file-modified(rejected, ask) | Red rejected status in dropdown |
| G6 | Ask mode expired restore | file-modified(expired, ask) | Muted expired status |
| G7 | Auto mode restore | file-modified(applied, auto) | "Modified Files" dropdown with applied status |
| G8 | Manual mode restore | file-modified(applied, manual) | Code block marked applied, no dropdown |
| G9 | Multi-iteration restore | 3 iterations of thinking + text | 3 thinking dropdowns + 3 text segments |
| G10 | Mixed mode restore | file-modified(manual) + file-modified(ask) | Different rendering per editMode |

---

## 3. VS Code Integration Tests (Layer 3)

Tests that launch real VS Code, open the extension, and verify the full stack.

### 3A. Extension Lifecycle — PARTIAL (2 smoke tests)

| # | Test | Action | Assert | Status |
|---|---|---|---|---|
| A1 | Workbench loads | Launch VS Code | Title contains "Visual Studio Code" | Done |
| A2 | Extension activates | Open command palette, run "Moby: Open Chat" | No crash | Done |
| A3 | Sidebar panel renders | Open chat panel | Webview iframe exists with content | TODO |
| A4 | Extension deactivates cleanly | Close VS Code | No errors in console | TODO |

### 3B. Webview in VS Code — TODO

| # | Test | Action | Assert |
|---|---|---|---|
| B1 | Webview loads in sidebar | Open chat | Chat container visible inside webview iframe |
| B2 | Input area functional | Type in textarea | Text appears in textarea |
| B3 | Send button works | Click send | Message appears in chat (or error if no API key) |
| B4 | Model selector works | Open model popup, select model | Model changes, header updates |
| B5 | Edit mode toggle works | Click edit mode button | Mode label changes |

### 3C. Command Palette — TODO

| # | Test | Action | Assert |
|---|---|---|---|
| C1 | All commands registered | Open command palette, type "Moby" | All expected commands listed |
| C2 | Open Chat command | Run "Moby: Open Chat" | Sidebar opens |
| C3 | Set API Key command | Run "Moby: Set API Key" | Input box appears |
| C4 | Export Logs command | Run "Moby: Export Logs" | File save dialog or output |

### 3D. Settings Integration — TODO

| # | Test | Action | Assert |
|---|---|---|---|
| D1 | Edit mode persists | Change edit mode, reload webview | Same mode restored |
| D2 | Model persists | Change model, reload | Same model restored |
| D3 | API key stored | Set API key via command | Key available to extension |

### 3E. Real API Flow (requires API key) — TODO

| # | Test | Action | Assert |
|---|---|---|---|
| E1 | Send message gets response | Type message, send | Assistant response appears |
| E2 | Stop generation works | Send message, click stop | Streaming stops, partial response shown |
| E3 | R1 thinking appears | Select R1 model, send message | Thinking dropdown appears |
| E4 | Shell execution shows | Send message requesting file operations | Shell dropdown appears |
| E5 | History persists | Send message, close/reopen panel | Message still visible |

---

## 4. Unit Test Gaps to Fill

These are existing source files without test coverage that should have vitest unit tests.

### Priority 1 — High impact, frequently touched

| File | What to Test |
|---|---|
| `src/providers/chatProvider.ts` | Message routing (all 68 inbound message types dispatch correctly) |
| `src/providers/planManager.ts` | Plan CRUD, toggle, file watching |
| `src/providers/savedPromptManager.ts` | Prompt save/load/delete/activate |
| `media/actors/web-search/WebSearchPopupShadowActor.ts` | Mode buttons, slider interactions, settings messages |
| `media/actors/plans/PlanPopupShadowActor.ts` | Plan list rendering, toggle, create/delete |
| `media/actors/system-prompt/SystemPromptModalActor.ts` | Textarea editing, dirty bar, save/load/delete prompts |
| `media/actors/drawing-server/DrawingServerShadowActor.ts` | Start/stop server, QR code, copy button |

### Priority 2 — Utilities and parsers

| File | What to Test |
|---|---|
| `src/utils/dsmlParser.ts` | DSML markup parsing edge cases |
| `src/utils/diff.ts` | Diff generation for various file types |
| `src/utils/formatting.ts` | Text formatting and sanitization |
| `src/providers/commandProvider.ts` | Command registration and execution |

---

## 5. Implementation Order

### Phase 1: Fill Unit Test Gaps (vitest)
1. WebSearchPopupShadowActor tests
2. PlanPopupShadowActor tests
3. SystemPromptModalActor tests
4. DrawingServerShadowActor tests
5. Pipeline Section 1F (streaming simulation)
6. Pipeline Section 1G (error recovery)

### Phase 2: Webview Rendering Tests (Playwright + Chromium)
1. Build message replay helper (dispatches events into webview)
2. Record first event fixture from a real session
3. Section 2G (history restore fidelity) — highest value
4. Section 2B (pending files dropdown)
5. Section 2A (message turn rendering)
6. Section 2C (streaming visual state)
7. Sections 2D-2F (input, toolbar, modals)

### Phase 3: VS Code Integration (Playwright + CDP)
1. Section 3A (extension lifecycle) — extend existing smoke tests
2. Section 3B (webview in VS Code) — iframe navigation
3. Section 3C (command palette)
4. Section 3D (settings integration)
5. Section 3E (real API flow) — requires API key, manual only

### Phase 4: Regression Workflow
Once all phases complete, the workflow becomes:
1. You report a bug with a screenshot/description
2. I identify the root cause and fix it
3. I write a test that reproduces the bug (appropriate layer)
4. I run the full suite to verify no regressions
5. The test prevents the bug from coming back

---

## 6. Running the Full Suite

```bash
# All unit tests (1,938 tests, ~10s)
npm run test:unit

# All e2e tests (5 tests, ~10s)
npm run test:e2e

# Everything
npm run test:unit && npm run test:e2e

# Specific layer
npx vitest run tests/events/pipeline.test.ts        # Layer 1
npx playwright test tests/e2e/smoke.spec.ts          # Layer 2
npx playwright test tests/e2e/vscode-integration.spec.ts  # Layer 3
```
