# Testing Plan

## Overview

Three testing layers:

1. **CQRS Pipeline Tests** (happy-dom, vitest) — Fast, deterministic, runs in CI. Tests the data pipeline from event creation through consolidation, restore, and projection. **Status: Implemented** (`tests/events/pipeline.test.ts`, 38 tests passing).
2. **Webview Rendering Tests** (Playwright + headless Chromium) — Fast, headless, no VS Code dependency. Loads the webview HTML in Chromium with a mocked VS Code API, replays CQRS event fixtures, and asserts DOM state. **Status: Smoke tests passing** (`tests/e2e/smoke.spec.ts`).
3. **Full Integration Tests** (Playwright + VS Code via CDP) — Slower, requires display server. Launches the real VS Code Electron app, connects via Chrome DevTools Protocol, and tests the complete extension lifecycle. **Status: Working** (2 smoke tests passing, see Section 5).

---

## 1. CQRS Pipeline Tests

### Goal

Catch consolidation ordering, event loss, and status patching bugs without touching the UI. These are unit/integration tests for `TurnEventLog`, `consolidateForSave`, and `TurnProjector`.

### Test Location

`tests/unit/events/pipeline.test.ts`

### Test Framework

- vitest + happy-dom (already configured)
- Direct imports of `TurnEventLog` and `TurnProjector`
- No VS Code mocks needed — pure data transformation tests

### Test Scenarios

#### A. Consolidation Ordering

| Test | Description | Verifies |
|---|---|---|
| Text-only consolidation | Multiple text-append events merge into one | Basic consolidation |
| Thinking breaks text | thinking-start between text creates separate segments | Text flow break |
| Shell breaks text | shell-start between text creates separate segments | Text flow break |
| File-modified deferred | file-modified mid-text deferred to after text ends | B26 fix — no sentence splitting |
| File-modified without text | file-modified when no text buffer goes directly to result | Edge case |
| Multiple file-modified deferred | Two file-modified events mid-text both deferred | Batch deferral |
| Approval breaks text | approval-created between text creates separate segments | Text flow break |
| Tool batch breaks text | tool-batch-start between text creates separate segments | Text flow break |
| Shell-complete doesn't break text | shell-complete between text doesn't create new segment | Non-breaking event |

#### B. Projection (projectFull)

| Test | Description | Verifies |
|---|---|---|
| Text → file-modified → text | Creates 3 segments: text, file, text(continuation) | Text break at file-modified |
| Text → thinking → text | Creates 3 segments with thinking in between | Text break at thinking |
| Text → shell → text | Creates 3 segments with shell in between | Text break at shell |
| File-modified with editMode | editMode preserved through projection | editMode passthrough |
| File-modified with deleted status | Status preserved through projection | Status passthrough |
| Expired conversion on restore | Pending file-modified becomes expired when turn not streaming | Expired status logic |
| Applied status preserved | Applied file-modified stays applied | No false expiration |

#### C. Consolidation → Projection Round-Trip

| Test | Description | Verifies |
|---|---|---|
| Live events → consolidate → project matches expected | Simulate streaming order, consolidate, project, compare to expected segments | Full pipeline fidelity |
| File-modified after shell (deferred) | Shell-start, shell-complete, text, file-modified → consolidate → project | Deferred ordering correct |
| Ask mode accept patching | file-modified with pending status, patch to applied before project | Step 5b patching |
| Multiple iterations | thinking-start/complete across 3 iterations with text between | Multi-iteration support |
| Shell + file-modified + text interleaving | Complex stream: think, shell, text, file-modified, more text, think | Real-world scenario |

#### D. File-Modified Status Lifecycle

| Test | Description | Verifies |
|---|---|---|
| Pending → applied (step 5b) | Patch pending file-modified before save | Ask mode blocking flow |
| Pending → expired (restore) | Unresolved pending becomes expired on non-streaming turn | Session close without decision |
| Applied preserved on restore | Applied status survives save/load cycle | B17 fix |
| Rejected preserved on restore | Rejected status survives save/load cycle | B17 fix |
| Deleted status preserved | Deleted status survives save/load cycle | Delete tracking |
| Manual mode insert | No file-modified during streaming, inserted post-save | Manual mode persistence |

#### E. Edge Cases

| Test | Description | Verifies |
|---|---|---|
| Empty text segments hidden | Text with only shell tags → empty after stripping | Empty container fix |
| Consecutive file-modified events | Two files modified in same iteration → grouped | Grouping behavior |
| Same file modified twice | Same filePath in two iterations → separate groups | Re-edit handling |
| No events | Empty event log → empty segments | Null case |
| Text-only (no structural events) | Just text-append events → single segment | Simple case |

### Implementation Pattern

```typescript
import { TurnEventLog } from '../../../media/events/TurnEventLog';
import { TurnProjector } from '../../../media/events/TurnProjector';

describe('CQRS Pipeline', () => {
  const projector = new TurnProjector();

  it('defers file-modified events until text ends', () => {
    const log = new TurnEventLog('test');
    log.append({ type: 'text-append', content: 'Hello ', iteration: 0, ts: 1 });
    log.append({ type: 'text-append', content: 'world', iteration: 0, ts: 2 });
    log.append({ type: 'file-modified', path: 'test.txt', status: 'applied', ts: 3 });
    log.append({ type: 'text-append', content: '. Done!', iteration: 0, ts: 4 });
    log.append({ type: 'text-finalize', iteration: 0, ts: 5 });

    const consolidated = log.consolidateForSave();
    const newLog = new TurnEventLog('restore');
    newLog.load(consolidated);
    const segments = projector.projectFull(newLog);

    // Text should be complete before file-modified (deferred)
    expect(segments[0].type).toBe('text');
    expect(segments[0].content).toBe('Hello world. Done!');
    expect(segments[1].type).toBe('file-modified');
  });
});
```

---

## 2. Webview Rendering Tests (Playwright + Chromium)

### Goal

Test the webview rendering layer in isolation: shadow DOM actors, dropdown states, streaming animations, CQRS event replay for history restore fidelity, and button/control states. Catches rendering bugs, shadow DOM issues, and visual state problems without needing VS Code or the DeepSeek API.

### Architecture

The webview HTML is loaded directly in headless Chromium. A mock `acquireVsCodeApi()` is injected via `addInitScript` before the page loads. Extension-to-webview messages are simulated via `window.dispatchEvent(new MessageEvent(...))`. This means:

- **Zero production code changes** — tests load the same `dist/media/chat.js` bundle
- **No VS Code dependency** — runs in headless Chromium, fast and CI-friendly
- **CQRS event replay** — feed `TurnEvent[]` fixtures directly into the webview
- **Full shadow DOM support** — Playwright auto-pierces open shadow roots

### What This Approach Tests vs. Doesn't Test

| Tested | Not Tested |
|---|---|
| Shadow DOM rendering and interactions | Extension activation and lifecycle |
| Dropdown state changes (pending/applied/rejected/expired) | Real VS Code command palette |
| Streaming animations (pulse, seeking) | Real settings integration |
| History restore fidelity (CQRS replay → verify DOM) | Webview CSP enforcement |
| Button enabled/disabled states | Extension-to-webview message contract |
| Mode switching UI changes | Real diff editor integration |
| Code block styling (Applied, Diff buttons) | File system interactions |

### Test Location

`tests/e2e/`

### Test Framework

- `@playwright/test` for assertions and test runner
- Headless Chromium (installed via `npx playwright install chromium`)
- Local and CI compatible

### Setup

```bash
npm install -D @playwright/test @vscode/test-electron
npx playwright install chromium
```

### Key Files

- `playwright.config.ts` — Playwright config at project root
- `tests/e2e/helpers/launch.ts` — `launchWebview()` (headless Chromium) and `launchVSCode()` (full VS Code via CDP)
- `tests/e2e/helpers/harness.html` — Test HTML that mirrors VS Code's webview structure, loads `dist/media/chat.js`
- `tests/e2e/smoke.spec.ts` — 3 smoke tests (Chromium renders, API mock works, chat.js loads)

### How Message Replay Works

The webview listens for messages via `window.addEventListener('message', ...)` — the same mechanism VS Code uses. Tests dispatch events directly:

```typescript
// Simulate the extension sending a streaming response
await page.evaluate((events) => {
  for (const event of events) {
    window.dispatchEvent(new MessageEvent('message', { data: event }));
  }
}, consolidatedEvents);

// Assert the rendered segments
await expect(page.locator('.file-modified-dropdown')).toBeVisible();
await expect(page.locator('.status-applied')).toHaveCount(2);
```

### How Shadow DOM Works

Playwright's CSS engine auto-pierces open shadow roots. Since our actors use `attachShadow({ mode: 'open' })`, standard selectors work:

```typescript
// These work even though elements are inside shadow roots
await page.locator('.model-selector-btn').click();
await expect(page.locator('.pending-container')).toBeVisible();
```

### Test Scenarios

#### A. Edit Mode Flows

| Test | Description |
|---|---|
| Manual: Diff → Apply → code block shows "Applied" | Click Diff, click Apply, verify green button |
| Manual: Toolbar Accept → code block shows "Applied" | Open diff, click checkmark, verify code block |
| Ask: Pending dropdown → Accept → shows "applied" | Send message, accept from dropdown, verify status |
| Ask: Pending dropdown → Reject → shows "rejected" | Send message, reject, verify status |
| Ask: Toolbar Accept → dropdown updates | Accept from editor toolbar, verify dropdown |
| Auto: Modified Files dropdown appears | Send message, verify auto-applied dropdown |

#### B. History Restore Fidelity

| Test | Description |
|---|---|
| Ask mode accepted → restore shows "applied" | Accept, switch session, restore, verify |
| Ask mode rejected → restore shows "rejected" | Reject, restore, verify |
| Manual mode applied → restore shows green code block | Apply, restore, verify code block styling |
| Unresolved pending → restore shows "expired" | Don't decide, restore, verify expired |
| Shell-modified files → restore shows "Modified Files" | Shell creates file, restore, verify dropdown |
| Deleted files → restore shows deleted status | Shell deletes file, restore, verify |

#### C. Mode Switching

| Test | Description |
|---|---|
| Manual → Ask mid-session | Switch modes between requests, verify correct dropdown type |
| Ask → Auto mid-session | Switch to auto, verify auto-applied behavior |
| Manual → Auto mid-session | Switch from manual to auto, verify auto-applied dropdown appears |
| Auto → Ask mid-session | Switch from auto to ask, verify pending dropdown with Accept/Reject |
| Auto → Manual mid-session | Switch from auto to manual, verify code block with Diff/Apply buttons |
| Shell-modified in ask mode shows "Modified Files" | Shell-created file shows auto dropdown in ask mode |
| Shell-modified in auto mode shows "Modified Files" | Shell-created file in auto mode shows auto dropdown |
| Shell-modified in manual mode shows "Modified Files" | Shell-created file in manual mode shows auto dropdown |

#### D. Streaming Visual State

| Test | Description |
|---|---|
| Thinking dropdown stops pulsing after response | B23 — verify pulse animation stops |
| Seeking animation below file dropdowns | B16 — verify animation position |
| Seeking animation removed after response | B24 — verify animation cleanup |
| Empty text containers hidden | Shell-only text stripped → no empty space |

#### E. Button & Control States During Streaming

| Test | Description |
|---|---|
| Send button disabled during streaming | Cannot submit while response active |
| Mode selector locked during streaming | Cannot switch edit mode mid-response |
| Accept/Reject enabled during ask mode streaming | Blocking flow requires interaction while streaming |
| Diff button enabled during manual mode streaming | Can open diff while response streams |
| Stop button visible and functional during streaming | Cancel button appears and stops response |
| Input field disabled during streaming | Cannot type while response active |
| All controls re-enabled after response completes | Verify full unlock after stream ends |

### Running Tests

```bash
# Run all e2e tests
npm run test:e2e

# Run with headed browser (see what's happening)
npm run test:e2e:headed

# Run specific test
npx playwright test tests/e2e/edit-modes.spec.ts

# Debug mode (step through)
npm run test:e2e:debug
```

---

## 4. Approach Comparison: Why Chromium Over Alternatives

### Approaches Evaluated

| Approach | How It Works | Status |
|---|---|---|
| **Playwright + Chromium (chosen)** | Load webview HTML in headless Chromium, mock VS Code API, replay events | Working (3 smoke tests passing) |
| **Playwright + Electron (`electron.launch`)** | Launch VS Code via Playwright's Electron API | Blocked — Playwright hardcodes `--remote-debugging-port=0` which VS Code's native launcher rejects ([microsoft/playwright#39008](https://github.com/microsoft/playwright/issues/39008)) |
| **Playwright + CDP (`connectOverCDP`)** | Launch VS Code ourselves, connect Playwright via Chrome DevTools Protocol | Working — root cause was `ELECTRON_RUN_AS_NODE` env var (see Section 5) |
| **WebdriverIO + wdio-vscode-service** | Uses ChromeDriver to control full VS Code instance | Evaluated and rejected (see below) |

### Why Not wdio-vscode-service

[wdio-vscode-service](https://webdriver.io/docs/wdio-vscode-service/) is purpose-built for VS Code extension E2E testing. It provides page objects for VS Code's UI (ActivityBar, EditorView, StatusBar, etc.) and handles webview iframe switching via a `WebView` class.

**Reasons we rejected it:**

1. **Can't do CQRS event replay.** The killer feature of our Chromium approach is feeding raw `TurnEvent[]` arrays into the webview and asserting DOM state. wdio-vscode-service requires a full backend + database + real API responses to generate content.

2. **Performance.** VS Code launch: 5-15 seconds per test file. ChromeDriver/WebDriver protocol adds latency per assertion. Our Chromium approach: ~1 second launch, sub-millisecond DOM queries.

3. **No headless mode.** VS Code must render in a window (needs xvfb on CI/WSL2). Our approach runs fully headless.

4. **Maintenance concerns.** 41 open GitHub issues including "session dies after ~60 seconds", VS Code 1.93+ compatibility problems, and an outdated peer dependency (`webdriverio@^8.32.2` vs. v9).

5. **We don't need VS Code page objects.** Our bugs are all in the webview rendering layer, not in VS Code's chrome. We don't need to test the ActivityBar or EditorView.

6. **We already have the integration path.** Our `launchVSCode()` helper in `launch.ts` does what wdio-vscode-service does (launch VS Code, connect for automation) using Playwright instead of ChromeDriver.

### Comparison: Chromium vs. Full VS Code

| What We Test | Chromium (standalone) | Full VS Code |
|---|---|---|
| Dropdown state after CQRS replay | Direct event injection, instant | Need full backend + real chat |
| Shadow DOM rendering | Auto-pierce, sub-ms queries | Auto-pierce, slower protocol |
| Streaming animations (pulse/seeking) | Fire events at controlled rate | Need real API, can't control timing |
| Button disabled during streaming | Simulate via message events | Real but timing-dependent |
| History restore fidelity | Load consolidated events, verify DOM | Need full session save/restore cycle |
| Mode switching UI | Send mode-change message, verify | Real toolbar interaction |
| Extension sidebar opens | Not tested | Tested |
| Command palette works | Not tested | Tested |
| Real API calls | No (uses recorded fixtures) | Yes |

### Production Code Impact

**Zero.** The entire test infrastructure lives in `tests/e2e/` and `playwright.config.ts`. No changes to `media/` or `src/`. The webview code already listens for messages via `window.addEventListener('message', ...)` — tests dispatch the same `MessageEvent` that VS Code would. The `acquireVsCodeApi()` mock is injected by Playwright's `addInitScript`, not compiled into the bundle.

---

## 5. Full Integration Tests (Playwright + VS Code via CDP)

### Goal

Test the complete extension lifecycle: sidebar activation, command palette, real settings, real diff editor, and the extension-to-webview message contract. Complements the Chromium webview tests by covering the integration boundary.

### Architecture

Launch VS Code as a child process with `--remote-debugging-port=9222`, then connect Playwright via `chromium.connectOverCDP()`. This gives full page automation without needing `electron.launch()`.

```typescript
// Launch VS Code ourselves
const vscodeProcess = spawn(vscodePath, [
  '--remote-debugging-port=9222',
  '--extensionDevelopmentPath=' + extensionPath,
  '--no-sandbox',
  '--user-data-dir=/tmp/vscode-e2e',
]);

// Connect Playwright via CDP
const browser = await chromium.connectOverCDP('http://localhost:9222');
const page = browser.contexts()[0].pages()[0];
```

### Root Cause: `ELECTRON_RUN_AS_NODE` (Resolved)

VS Code's `code` binary was silently exiting with code 1 on WSL2. The root cause: **`ELECTRON_RUN_AS_NODE=1`** is set in VS Code's integrated terminal environment. When inherited by child processes, this causes the Electron binary to run as a plain Node.js runtime instead of launching the GUI — it reads stdin, gets EOF, and exits silently.

**The fix:** Clear VS Code host environment variables before spawning:

```typescript
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VSCODE_IPC_HOOK_CLI;
delete env.VSCODE_NLS_CONFIG;
delete env.VSCODE_HANDLES_SIGPIPE;
delete env.VSCODE_HANDLES_UNCAUGHT_ERRORS;
delete env.VSCODE_ESM_ENTRYPOINT;
```

**Status: Working.** VS Code 1.92.2 launches successfully with `--remote-debugging-port`, Playwright connects via CDP, and the workbench is fully automatable. Two integration smoke tests passing.

### Known Issues with `electron.launch()`

Playwright's `electron.launch()` API hardcodes `--inspect=0` and `--remote-debugging-port=0` into every launch ([source](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/electron/electron.ts)). There is no API to disable these flags. VS Code's native launcher binary rejects them before Electron starts.

- [microsoft/playwright#39008](https://github.com/microsoft/playwright/issues/39008) — original report
- A fix (PR #39012) was merged January 2026 but reverted in March 2026 (PR #39710) due to regressions
- No replacement fix has landed as of Playwright 1.59 (April 2026)

### How VS Code's Own Tests Work

VS Code's internal smoke tests ([test/automation/src/electron.ts](https://github.com/microsoft/vscode/blob/main/test/automation/src/electron.ts)) bypass the `code` wrapper entirely and point to the raw Electron binary inside the build output. This isn't practical for extension developers testing against a downloaded VS Code distribution.

## Priority Order

1. **CQRS Pipeline Tests** — Implemented. 38 tests passing. Covers data pipeline bugs.
2. **Webview Rendering Tests** — Smoke tests passing. Next: build message replay helper and event fixtures.
3. **Full Integration Tests** — Working. 2 smoke tests passing (workbench loads, extension activates). Next: webview iframe navigation for in-VS-Code UI testing.

## CI Integration

CQRS pipeline tests and webview rendering tests can both run in CI:

```yaml
# In .github/workflows/ci.yml
- name: Run unit tests
  run: npm run test:unit
- name: Run e2e tests
  run: npm run test:e2e
```

Full integration tests are manual — requires display server and VS Code binary.

---

## 3. Response Recording & Replay (Future)

### Problem

Real API responses introduce flakiness: varying content/length, network latency, rate limits, API outages. As the Playwright test suite grows, hitting DeepSeek's API on every run becomes slow and unreliable.

### Solution: Event Log Fixtures

The CQRS architecture provides a natural recording mechanism. `TurnEventLog.consolidateForSave()` already produces a compact, replayable representation of any response — the same format stored in the database for history restore.

### How It Works

1. **Record**: Run a real test scenario once. After the response completes, export the consolidated `TurnEvent[]` as a JSON fixture file.

2. **Replay**: In test mode, bypass the DeepSeek client. Instead, feed the fixture events into `TurnEventLog.append()` at timed intervals (using the `ts` field for pacing).

3. **Assert**: Playwright tests run against the UI exactly as they would with a live response, but deterministically.

### Fixture Format

```
tests/e2e/fixtures/
  ask-mode-accept.events.json    # Consolidated TurnEvent[] for an ask-mode accept flow
  manual-mode-apply.events.json  # Consolidated TurnEvent[] for a manual-mode apply flow
  multi-iteration.events.json    # 3-iteration R1 response with shell commands
  ...
```

Each fixture is a JSON array of `TurnEvent` objects — identical to what `consolidateForSave()` returns.

### When to Implement

Start with real API responses to discover what needs testing and to build initial fixtures. Once stable test scenarios are identified, record them as fixtures and switch to replay mode. This gives:

- **Deterministic**: Same events, same order, every time
- **Fast**: No network latency, no API wait time
- **Offline**: Tests run without API access
- **Stable**: No flakiness from varying response content
