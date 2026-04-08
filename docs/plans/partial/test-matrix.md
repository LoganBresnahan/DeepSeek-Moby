# Test Matrix

Comprehensive test scenarios organized by testing layer. Each scenario maps to a specific layer based on what it needs to verify.

**Legend:**
- **Layer 1** = CQRS Pipeline (vitest + happy-dom) — data transformations, no UI
- **Layer 2** = Webview Rendering (Playwright + Chromium) — DOM assertions, no VS Code
- **Layer 3** = VS Code Integration (Playwright + CDP) — full extension lifecycle

---

## Current Coverage Summary

| Category | Test Files | Tests | Status |
|---|---|---|---|
| Actors (media/) | 27 | 727 | All actors covered |
| Events pipeline | 3 | 117 | Sections A-G complete |
| Providers (src/) | 11 | 458 | All providers covered |
| State management | 5 | 143 | Complete |
| Utilities | 16 | 524 | All major utils covered |
| Logging/Tracing | 7 | 180 | Complete |
| Tools | 2 | 91 | Complete |
| E2E Smoke | 2 | 5 | Chromium + VS Code CDP |
| E2E Rendering | 1 | 24 | Sections 2A, 2B, 2G |
| **Total** | **81 unit + 3 e2e** | **2,422** | |

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

### 1F. Streaming Simulation — IMPLEMENTED (10 tests)

Simulates realistic streaming sequences matching what the requestOrchestrator produces.

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

### 1G. Error Recovery — IMPLEMENTED (8 tests)

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

### 2A. Message Turn Rendering — IMPLEMENTED (6 tests)

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

### 2B. Pending Files Dropdown — IMPLEMENTED (8 tests)

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

### 2G. History Restore Fidelity (CQRS Replay) — IMPLEMENTED (11 tests)

Tests in `tests/e2e/webview-rendering.spec.ts`. Replay consolidated event fixtures into the webview via `loadHistory` message and verify rendered DOM.

| # | Test | Status |
|---|---|---|
| G1 | Simple text restore | Done |
| G2 | Text + thinking restore | Done |
| G3 | Full R1 turn (thinking+text+shell+file-modified) | Done |
| G4 | Ask mode applied on restore | Done |
| G5 | Ask mode rejected on restore | Done |
| G6 | Ask mode expired on restore | Done |
| G7 | Auto mode "Modified Files" on restore | Done |
| G8 | Multi-iteration (3 thinking + 3 text) | Done |
| G9 | Mixed editModes in one turn | Done |
| G10 | **Regression**: applying one file does not mark other turn's code block (same filename) | Done |
| G11 | Full conversation restore (4 turns) | Done |

### 2D. Input Area — TODO (Layer 2 portion)

Only textarea behavior tests — send flow requires the full actor system (Layer 3).

| # | Test | Action | Assert |
|---|---|---|---|
| D1 | Textarea exists and is focusable | Click textarea | Textarea receives focus |
| D2 | Textarea accepts input | Type text | Value reflects typed content |
| D3 | Textarea auto-resizes | Type many lines | Textarea height increases |

### Moved to Layer 3

The following sections require the full actor system responding to interactive events in real time, which headless Chromium without VS Code cannot provide:

- **2C. Streaming Visual State** → Layer 3 Section 3F (pulse animations, seeking indicator, stop/send button toggle need `startResponse`/`endResponse` message flow)
- **2E. Toolbar Controls** → Layer 3 Section 3G (edit mode cycling, popup positioning depends on VS Code layout)
- **2F. History Modal** → Layer 3 Section 3H (requires real session data from extension, modal backdrop positioning)
- **2D partial** (Enter to send, Shift+Enter, empty rejection) → Layer 3 Section 3G (send flow requires actor system)

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

### 3F. Streaming Visual State (moved from Layer 2) — TODO

| # | Test | Action | Assert |
|---|---|---|---|
| F1 | Thinking pulse during streaming | Send message to R1 | Pulse animation CSS class active during thinking |
| F2 | Thinking pulse stops after complete | Wait for response end | Pulse animation removed |
| F3 | Seeking animation during streaming | Send message | Seeking indicator visible |
| F4 | Seeking animation removed after end | Wait for response end | Seeking indicator removed |
| F5 | Send button becomes Stop during streaming | Send message | Stop button visible, Send hidden |
| F6 | Send button restored after streaming | Wait for response end | Send visible, Stop hidden |

### 3G. Toolbar & Input Controls (moved from Layer 2) — TODO

| # | Test | Action | Assert |
|---|---|---|---|
| G1 | Edit mode cycles M→Q→A | Click edit mode button 3 times | Button label changes through modes |
| G2 | Edit mode sends message | Click edit mode button | Mode change persists |
| G3 | Enter to send | Type text, press Enter | Message appears in chat |
| G4 | Shift+Enter adds newline | Shift+Enter in textarea | Textarea value has newline, no submit |
| G5 | Empty message not sent | Press Enter with empty textarea | No message sent |
| G6 | Textarea clears after send | Send message | Textarea empty after send |
| G7 | Model selector opens | Click model button | Model popup visible |
| G8 | Files button opens modal | Click files button | Files modal visible |

### 3H. History Modal (moved from Layer 2) — TODO

| # | Test | Action | Assert |
|---|---|---|---|
| H1 | Modal opens with session list | Click history button | Sessions rendered in date groups |
| H2 | Search filters sessions | Type in search input | Only matching sessions visible |
| H3 | Click session switches | Click session entry | Chat loads different session |
| H4 | Delete shows confirmation | Click delete button | Confirmation dialog visible |
| H5 | Backdrop click closes modal | Click outside modal | Modal hidden |
| H6 | Escape closes modal | Press Escape | Modal hidden |

### 3E. Real API Flow (requires API key) — TODO

#### Timeout Strategy: Stream-Aware Waiting

Real API tests must NOT use fixed timeouts. DeepSeek response times vary from 2-3 seconds (simple chat) to 60+ seconds (R1 with shell). Instead, tests use **stream-aware waiting** — watching for actual completion signals:

**Completion signals (from extension → webview messages):**
- `startResponse` → streaming has begun (proves connection works)
- `streamToken` / `streamReasoning` → tokens arriving (proves stream is alive)
- `endResponse` → response fully complete
- `generationStopped` → user cancelled

**Implementation pattern:**
```typescript
// Wait for the stream to complete (timeout is a safety net, not the mechanism)
await webviewFrame.locator('.stop-btn').waitFor({ state: 'visible', timeout: 15_000 }); // streaming started
await webviewFrame.locator('.stop-btn').waitFor({ state: 'hidden', timeout: 120_000 }); // streaming ended
```

Or at the message level:
```typescript
await page.waitForFunction(() => {
  const msgs = (window as any).__vscodeMessages;
  return msgs?.some(m => m.type === 'endResponse' || m.type === 'generationStopped');
}, { timeout: 120_000 });
```

**Ask mode approval flow** requires multi-step choreography:
1. Wait for streaming to start (stop button visible)
2. Wait for approval dialog (pending dropdown appears)
3. Click accept/reject
4. Wait for `endResponse`

Each step has its own short timeout. The test completes as soon as the stream ends — a 3-second response finishes in 3 seconds, not 120.

#### Test Scenarios

| # | Test | Action | Assert |
|---|---|---|---|
| E1 | Send message gets response | Type message, send | Assistant response appears (wait for endResponse) |
| E2 | Stop generation works | Send message, click stop | generationStopped received, partial response shown |
| E3 | R1 thinking appears | Select R1 model, send message | thinking-container visible during stream |
| E4 | Shell execution shows | Send message requesting file operations | shell-container appears |
| E5 | History persists | Send message, close/reopen panel | Message still visible after reload |

---

## 4. Unit Test Gaps — FILLED

All previously untested files now have tests. 437 new unit tests added.

### Actors (4 files, 147 tests) — DONE
- `DrawingServerShadowActor.ts` — 32 tests
- `PlanPopupShadowActor.ts` — 29 tests
- `SystemPromptModalActor.ts` — 42 tests
- `WebSearchPopupShadowActor.ts` — 44 tests

### Providers (3 files, 79 tests) — DONE
- `commandProvider.ts` — 24 tests
- `planManager.ts` — 26 tests
- `savedPromptManager.ts` — 29 tests

### Utilities/Tools (9 files, 211 tests) — DONE
- `dsmlParser.ts` — 25 tests
- `config.ts` — 10 tests
- `formatting.ts` — 33 tests
- `httpClient.ts` — 19 tests
- `diff.ts` — 28 tests
- `UnifiedLogExporter.ts` — 23 tests
- `statusBar.ts` — 11 tests
- `tavilyClient.ts` — 24 tests
- `workspaceTools.ts` — 38 tests

### Remaining (low priority, not blocking)
- `src/providers/chatProvider.ts` — Message routing (partial coverage via queuing tests)
- `src/events/SqlJsWrapper.ts` — Thin wrapper around sqlcipher (tested indirectly via EventStore/ConversationManager)

---

## 5. Implementation Status

### Phase 1: Unit Test Gaps — DONE
- 16 new test files, 437 new tests
- Pipeline Sections 1F (streaming simulation, 10 tests) and 1G (error recovery, 8 tests)
- All previously untested actors, providers, and utilities now covered

### Phase 2: Webview Rendering Tests — DONE
- Message replay helper built (`tests/e2e/helpers/replay.ts`)
- Harness updated with all required DOM elements + VS Code theme stubs
- Section 2A (message turn rendering, 6 tests)
- Section 2B (pending files dropdown, 8 tests)
- Section 2G (history restore fidelity, 10 tests)

### Phase 3: VS Code Integration — IN PROGRESS
- Section 3A (extension lifecycle) — 2 smoke tests passing
- Section 3B-3D — TODO (webview iframe navigation, commands, settings)
- Section 3E (real API flow) — TODO, will use stream-aware waiting (see 3E above)

### Phase 4: Regression Workflow — ACTIVE
The workflow is now operational for Layers 1 and 2:
1. You report a bug with a screenshot/description
2. I identify the root cause and fix it
3. I write a test that reproduces the bug (appropriate layer)
4. I run the full suite to verify no regressions
5. The test prevents the bug from coming back

---

## 6. Running the Full Suite

```bash
# All unit tests (2,393 tests, ~11s)
npm run test:unit

# All e2e tests (29 tests, ~59s)
npm run test:e2e

# Everything
npm run test:unit && npm run test:e2e

# Specific layers
npx vitest run tests/events/pipeline.test.ts              # Layer 1: CQRS pipeline
npx playwright test tests/e2e/smoke.spec.ts               # Layer 2: Chromium smoke
npx playwright test tests/e2e/webview-rendering.spec.ts    # Layer 2: Rendering tests
npx playwright test tests/e2e/vscode-integration.spec.ts   # Layer 3: VS Code integration
```
