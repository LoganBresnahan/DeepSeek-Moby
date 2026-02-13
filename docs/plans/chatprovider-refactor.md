# ChatProvider Refactor — Event Emitter Extraction

**Purpose:** Decompose the 4,400-line `chatProvider.ts` god object into focused classes that communicate via `vscode.EventEmitter`, matching the event-driven pattern already used on the webview side.

**Status:** Phase 3 (DiffManager) — Phases 0-2 complete

**Depends on:** Context Management (complete), Dead Code Cleanup (complete)

---

## Table of Contents

1. [Problem](#1-problem)
2. [Architecture](#2-architecture)
3. [Event Emitter Pattern](#3-event-emitter-pattern)
4. [Phase 0 — Shared Types & Event Contracts](#4-phase-0--shared-types--event-contracts)
5. [Phase 1 — WebSearchManager](#5-phase-1--websearchmanager)
6. [Phase 2 — FileContextManager](#6-phase-2--filecontextmanager)
7. [Phase 3 — DiffManager](#7-phase-3--diffmanager)
8. [Phase 4 — SettingsManager](#8-phase-4--settingsmanager)
9. [Phase 5 — RequestOrchestrator](#9-phase-5--requestorchestrator)
10. [Phase 6 — Wire Webview Bridge](#10-phase-6--wire-webview-bridge)
11. [What Stays in ChatProvider](#11-what-stays-in-chatprovider)
12. [Testing Strategy](#12-testing-strategy)
13. [Migration Safety](#13-migration-safety)
14. [Key Files](#14-key-files)

---

## 1. Problem

`src/providers/chatProvider.ts` is 4,400 lines handling 6+ distinct responsibilities:

| Responsibility | Lines | Methods |
|---------------|-------|---------|
| Diff/code edit lifecycle | ~800 | 15 methods |
| Request orchestration (handleUserMessage) | ~940 | 1 mega-method |
| Tool loop | ~300 | 1 method |
| Settings management | ~300 | 12 methods |
| History/session management | ~200 | 8 methods |
| File context (selection, search) | ~200 | 6 methods |
| Web search | ~100 | 5 methods |
| Editor context & workspace search | ~200 | 4 methods |
| Webview message router | ~200 | 51 case branches |

Consequences:
- **Hard to test** — most logic requires mocking `vscode.WebviewView`
- **Hard to navigate** — finding a method requires scrolling through unrelated code
- **Tight coupling** — every feature touches the same class, diffs affect streaming, settings affect diffs
- **Risky changes** — modifying the tool loop risks breaking the diff system because they share state

---

## 2. Architecture

### Current (monolith)

```
┌─────────────┐     postMessage     ┌────────────────────────────────────┐
│  Webview UI  │ ◄─────────────────►│  ChatProvider (4,400 lines)        │
│  (media/)    │                    │  - 51 incoming message types       │
└─────────────┘                    │  - 40+ outgoing message types      │
                                    │  - 15+ state variables             │
                                    │  - ALL responsibility areas mixed  │
                                    └────────────────────────────────────┘
```

### After (event-driven)

```
┌─────────────┐     postMessage     ┌──────────────────────────────┐
│  Webview UI  │ ◄─────────────────►│  ChatProvider (coordinator)  │
└─────────────┘                    │  - message router (switch)   │
                                    │  - event subscriptions       │
                                    │  - webview bridge            │
                                    └──────┬───────────────────────┘
                                           │ subscribes to events
           ┌────────────┬─────────────┬────┴──────┬──────────────┐
           │            │             │           │              │
    ┌──────▼──────┐ ┌───▼────┐ ┌─────▼─────┐ ┌───▼───┐ ┌───────▼───────┐
    │ DiffManager │ │Settings│ │ Request   │ │ File  │ │ WebSearch     │
    │             │ │Manager │ │Orchestrator│ │Context│ │ Manager       │
    │ events:     │ │        │ │           │ │Manager│ │               │
    │ diffList    │ │events: │ │events:    │ │       │ │events:        │
    │ codeApplied │ │changed │ │streamToken│ │events:│ │searchStarted  │
    │ diffClosed  │ │modelChg│ │endResponse│ │files  │ │searchComplete │
    └─────────────┘ └────────┘ └───────────┘ └───────┘ └───────────────┘
```

Each extracted class:
- Owns its state (no shared mutable state)
- Emits typed events (doesn't know about the webview)
- Receives method calls from ChatProvider (which dispatches incoming messages)
- Is independently testable (subscribe to events, assert results)

---

## 3. Event Emitter Pattern

Use `vscode.EventEmitter<T>` — the same pattern already in `ConversationManager`:

```typescript
// src/events/ConversationManager.ts (existing pattern)
private onSessionsChanged: vscode.EventEmitter<void>;
public readonly onSessionsChangedEvent: vscode.Event<void>;

constructor() {
  this.onSessionsChanged = new vscode.EventEmitter<void>();
  this.onSessionsChangedEvent = this.onSessionsChanged.event;
}

// Fire:
this.onSessionsChanged.fire();

// Subscribe (from ChatProvider):
conversationManager.onSessionsChangedEvent(() => { ... });
```

### Convention for Extracted Classes

```typescript
export class DiffManager {
  // Private emitter — only this class can fire
  private readonly _onDiffListChanged = new vscode.EventEmitter<DiffListChangedEvent>();
  // Public event — anyone can subscribe
  readonly onDiffListChanged = this._onDiffListChanged.event;

  async acceptDiff(diffId: string): Promise<void> {
    // ... business logic ...
    this._onDiffListChanged.fire({ diffs: this.getAllDiffs(), editMode: this.editMode });
  }

  dispose(): void {
    this._onDiffListChanged.dispose();
  }
}
```

### Why Not a Custom EventBus?

With ~5 extracted classes emitting 3-7 events each, direct subscriptions in ChatProvider are simpler:

```typescript
// In ChatProvider constructor — ~20-25 subscriptions, all in one place
this.diffManager.onDiffListChanged(data => {
  this._view?.webview.postMessage({ type: 'diffListChanged', ...data });
});
this.diffManager.onCodeApplied(data => {
  this._view?.webview.postMessage({ type: 'codeApplied', ...data });
});
```

No indirection, no string-based event routing, full type safety. If we later grow to 10+ classes with 50+ events, we can introduce a bus then.

### Why Not Node.js EventEmitter?

- `vscode.EventEmitter` is already used in the codebase (`ConversationManager`)
- It's typed (`EventEmitter<T>`)
- It integrates with VS Code's disposal pattern (`Disposable`)
- It avoids the string-based event names of Node.js `EventEmitter`

---

## 4. Phase 0 — Shared Types & Event Contracts

**Goal:** Define the event payload types and shared interfaces before any extraction.

### Create `src/providers/types.ts`

```typescript
/** Diff metadata tracked per code edit */
export interface DiffInfo {
  filePath: string;
  timestamp: number;
  status: 'pending' | 'applied' | 'rejected';
  iteration: number;
  diffId: string;
  superseded: boolean;
}

/** Payload for diff list updates sent to webview */
export interface DiffListChangedEvent {
  diffs: DiffInfo[];
  editMode: 'manual' | 'ask' | 'auto';
}

/** Payload for code application results */
export interface CodeAppliedEvent {
  success: boolean;
  error?: string;
  filePath?: string;
}

/** Payload for settings sync */
export interface SettingsSnapshot {
  model: string;
  temperature: number;
  maxToolCalls: number;
  maxTokens: number;
  logLevel: string;
  webviewLogLevel: string;
  tracingEnabled: boolean;
  logColors: boolean;
  systemPrompt: string;
  autoSaveHistory: boolean;
  maxSessions: number;
  allowAllCommands: boolean;
  webSearch: { enabled: boolean; configured: boolean };
}

/** Payload for web search events */
export interface WebSearchResultEvent {
  context: string;  // Formatted search results for system prompt
}

/** Payload for file context */
export interface OpenFilesEvent {
  files: string[];  // Relative paths
}

export interface FileSearchResultsEvent {
  results: string[];
}

export interface FileContentEvent {
  filePath: string;
  content: string;
}
```

### Files

| File | Change |
|------|--------|
| `src/providers/types.ts` | **New** — shared event payload types |

### Verification

- `npx vitest run` — no tests change (types only)
- Build clean — no runtime changes

---

## 5. Phase 1 — WebSearchManager

**Goal:** Extract the cleanest subsystem first to prove the pattern. Web search has minimal dependencies and clear boundaries.

**Status:** Complete (includes Phase 1b slider redesign)

### Issues Found During Investigation

#### Critical (fixed during extraction)

1. **Cache TTL never checked** — `cacheDuration` setting exists (default 15 min) but the cache lookup at `chatProvider.ts:1492` never compares timestamps against it. Cached results live forever until explicit clear or session reset. **Fix:** Add TTL check in `searchForMessage()` — expired entries evicted on read.

2. **Missing logging/tracing in `toggleWebSearch()` and `updateWebSearchSettings()`** — These methods (lines 887-919) silently mutate state with zero observability. No `logger.*` calls, no `tracer.trace()` calls. **Fix:** Add logging and tracing in WebSearchManager methods.

#### Non-critical (deferred)

3. **`maxSearchesPerPrompt` setting accepted but ignored** — UI allows 1-20 searches per prompt but only 1 search ever executes per message (line 1506). No loop or batching logic exists. The setting is misleading UX. Same behavior carries forward in WebSearchManager.

4. **`WebSearchEvent` defined but never recorded** — `src/events/EventTypes.ts` defines `WebSearchEvent` (type: `'web_search'`) but `handleUserMessage()` never calls `conversationManager.recordEvent()` for web searches. Search results are invisible in conversation replay/history.

5. **B2 "Tavily web search not working" (REMINDER.md)** — The Tavily integration code is structurally sound: API client at `src/clients/tavilyClient.ts` handles auth, errors (401/429), and search depth. Likely an API key configuration issue or Tavily service problem, not a code bug.

### State Moved

| Variable | From | To |
|----------|------|----|
| `webSearchEnabled` (line 45) | ChatProvider | WebSearchManager |
| `webSearchSettings` (lines 46-56) | ChatProvider | WebSearchManager |
| `searchCache` (line 57) | ChatProvider | WebSearchManager |

### Class Design

```typescript
// src/providers/webSearchManager.ts

export class WebSearchManager {
  // Events
  private readonly _onSearching = new vscode.EventEmitter<void>();
  private readonly _onSearchComplete = new vscode.EventEmitter<WebSearchResultEvent>();
  private readonly _onSearchCached = new vscode.EventEmitter<void>();
  private readonly _onSearchError = new vscode.EventEmitter<{ message: string }>();
  private readonly _onToggled = new vscode.EventEmitter<{ enabled: boolean }>();
  private readonly _onSettingsChanged = new vscode.EventEmitter<void>();

  readonly onSearching = this._onSearching.event;
  readonly onSearchComplete = this._onSearchComplete.event;
  readonly onSearchCached = this._onSearchCached.event;
  readonly onSearchError = this._onSearchError.event;
  readonly onToggled = this._onToggled.event;
  readonly onSettingsChanged = this._onSettingsChanged.event;

  // State
  private enabled = false;
  private settings: WebSearchSettings = {
    searchesPerPrompt: 1,
    searchDepth: 'basic',
    cacheDuration: 15,
    maxSearchesPerPrompt: 1
  };
  private cache = new Map<string, { results: string; timestamp: number }>();

  constructor(private tavilyClient: TavilyClient) {}

  // Methods (moved from ChatProvider)
  toggle(enabled: boolean): void { ... }        // + logging/tracing (was silent)
  updateSettings(settings: Partial<WebSearchSettings>): void { ... }  // + logging/tracing
  clearCache(): void { ... }
  async searchForMessage(message: string): Promise<string> { ... }  // + cache TTL check (was missing)
  formatSearchResults(response: TavilySearchResponse): string { ... }
  getSettings(): { enabled: boolean; settings: WebSearchSettings; configured: boolean } { ... }
  resetToDefaults(): void { ... }

  dispose(): void { /* dispose all emitters */ }
}
```

### Logging & Tracing Integration

| Method | Logger | Tracer | Notes |
|--------|--------|--------|-------|
| `toggle()` | `logger.info('[WebSearch] ...')` | `tracer.trace('webSearch.toggle', ...)` | **NEW** — was silent |
| `updateSettings()` | `logger.info('[WebSearch] ...')` | `tracer.trace('webSearch.settingsChanged', ...)` | **NEW** — was silent |
| `searchForMessage()` | `logger.webSearchRequest/Result/Cached/Error` | Existing spans via logger | Existing — already traced |
| `clearCache()` | `logger.webSearchCacheCleared()` | Existing trace | Existing |
| `resetToDefaults()` | `logger.info('[WebSearch] ...')` | — | **NEW** |

### ChatProvider Changes

```typescript
// Member + constructor:
private webSearchManager: WebSearchManager;
this.webSearchManager = new WebSearchManager(this.tavilyClient);

// Event subscriptions (in constructor):
this.webSearchManager.onSearching(() =>
  this._view?.webview.postMessage({ type: 'webSearching' }));
this.webSearchManager.onSearchComplete(() =>
  this._view?.webview.postMessage({ type: 'webSearchComplete' }));
this.webSearchManager.onSearchCached(() =>
  this._view?.webview.postMessage({ type: 'webSearchCached' }));
this.webSearchManager.onSearchError(e =>
  this._view?.webview.postMessage({ type: 'warning', message: `Web search failed: ${e.message}` }));
this.webSearchManager.onToggled(d =>
  this._view?.webview.postMessage({ type: 'webSearchToggled', enabled: d.enabled }));

// In handleUserMessage — replace 40-line inline block:
const webSearchContext = await this.webSearchManager.searchForMessage(message);

// In clearConversation — replace this.searchCache.clear():
this.webSearchManager.clearCache();

// In resetToDefaults — replace 6-line inline reset:
this.webSearchManager.resetToDefaults();
```

### Switch Cases Affected

`toggleWebSearch`, `updateWebSearchSettings`, `getWebSearchSettings`, `clearSearchCache`, `setSearchDepth`, `setSearchesPerPrompt`, `setCacheDuration` — 7 cases delegate to WebSearchManager.

### Removed from ChatProvider

- **State:** `webSearchEnabled`, `webSearchSettings`, `searchCache` (3 variables)
- **Methods:** `toggleWebSearch()`, `updateWebSearchSettings()`, `clearSearchCache()`, `formatSearchResults()` (4 methods)
- **Inline code:** Web search block in `handleUserMessage()` (~40 lines), reset block in `resetToDefaults()` (~6 lines)

### Files

| File | Change |
|------|--------|
| `src/providers/webSearchManager.ts` | **New** — ~150 lines |
| `src/providers/chatProvider.ts` | Remove ~100 lines, add ~15 lines (member, event wiring, delegations) |
| `tests/unit/providers/webSearchManager.test.ts` | **New** — ~200 lines |

### Verification

- `npx vitest run` — all existing tests pass + new WebSearchManager tests
- Manual: toggle web search on/off, verify indicator state
- Manual: send message with web search enabled, verify results injected into LLM context
- Manual: send same message again, verify cache hit (check logger output for `[cached]`)
- Check output channel for new `[WebSearch]` log entries on toggle/settings changes

---

## 6. Phase 2 — FileContextManager

**Goal:** Extract file selection, search, and context injection.

**Status:** Complete

### State Moved

| Variable | From | To |
|----------|------|----|
| `selectedFiles` | ChatProvider | FileContextManager |
| `readFilesInTurn` | ChatProvider | FileContextManager |
| `userMessageIntent` | ChatProvider | FileContextManager |
| `fileModalOpen` | ChatProvider | FileContextManager |

### Class Design

```typescript
// src/providers/fileContextManager.ts

export class FileContextManager {
  // Events
  private readonly _onOpenFiles = new vscode.EventEmitter<OpenFilesEvent>();
  private readonly _onSearchResults = new vscode.EventEmitter<FileSearchResultsEvent>();
  private readonly _onFileContent = new vscode.EventEmitter<FileContentEvent>();

  readonly onOpenFiles = this._onOpenFiles.event;
  readonly onSearchResults = this._onSearchResults.event;
  readonly onFileContent = this._onFileContent.event;

  // Methods
  async sendOpenFiles(): Promise<void> { ... }
  async handleFileSearch(query: string): Promise<void> { ... }
  async sendFileContent(filePath: string): Promise<void> { ... }
  setSelectedFiles(files: Array<{ path: string; content: string }>): void { ... }
  setModalOpen(open: boolean): void { ... }
  clearTurnTracking(): void { ... }  // Called at start of each user message
  trackReadFile(filePath: string): void { ... }  // Called when tool reads a file
  extractFileIntent(message: string): void { ... }
  getSelectedFilesContext(): string { ... }  // Returns formatted context for system prompt
  inferFilePath(code: string, language: string): string | null { ... }

  dispose(): void { ... }
}
```

### Switch Cases Affected

`getOpenFiles`, `fileModalOpened`, `fileModalClosed`, `searchFiles`, `getFileContent`, `setSelectedFiles` — 6 cases.

### Files

| File | Change |
|------|--------|
| `src/providers/fileContextManager.ts` | **New** — ~250 lines |
| `src/providers/chatProvider.ts` | Remove ~200 lines, add ~8 lines of subscriptions |
| `tests/unit/providers/fileContextManager.test.ts` | **New** |

### Verification

- `npx vitest run` — all pass
- Manual: open file modal, search files, attach files, verify they appear in context

---

## 7. Phase 3 — DiffManager

**Goal:** Extract the largest subsystem — diff creation, acceptance, rejection, superseding, tab management, status bar, code block detection, and edit mode. This is the biggest win for code organization (~800 lines out, 14 state variables, 30+ methods, 10 switch cases).

**Status:** In progress

### State Moved (14 variables)

| Variable | Line | Description |
|----------|------|-------------|
| `diffEngine` | 39 | DiffEngine instance |
| `activeDiffs` | 40 | `Map<string, DiffMetadata>` — pending diffs by URI |
| `resolvedDiffs` | 41 | Array of applied/rejected diffs |
| `_lastNotifiedDiffIndex` | 42 | Incremental notification tracker (fix from prior session) |
| `autoAppliedFiles` | 43 | Array of auto-applied files (auto mode) |
| `diffTabGroupId` | 44 | VS Code view column for diff tabs |
| `diffStatusBarItem` | 45 | Status bar item showing pending count |
| `lastActiveEditorUri` | 37 | Last active file editor (used by showDiff/applyCode) |
| `editMode` | 51 | `'manual' | 'ask' | 'auto'` |
| `processedCodeBlocks` | 52 | Set for dedup during streaming |
| `pendingDiffs` | 55 | Debounced diffs (ask mode, 2.5s delay) |
| `fileEditCounts` | 58 | Iteration count per file |
| `currentResponseFileChanges` | 61 | File changes for history save |
| `closingDiffsInProgress` | 65 | Race condition counter |

**Stays in ChatProvider:** `contentBuffer` (request lifecycle, not diff lifecycle)

### Class Design

```typescript
// src/providers/diffManager.ts

export class DiffManager {
  // Events (8)
  private readonly _onDiffListChanged = new vscode.EventEmitter<DiffListChangedEvent>();
  private readonly _onAutoAppliedFilesChanged = new vscode.EventEmitter<DiffListChangedEvent>();
  private readonly _onCodeApplied = new vscode.EventEmitter<CodeAppliedEvent>();
  private readonly _onActiveDiffChanged = new vscode.EventEmitter<{ filePath: string }>();
  private readonly _onDiffClosed = new vscode.EventEmitter<void>();
  private readonly _onWarning = new vscode.EventEmitter<{ message: string }>();
  private readonly _onEditConfirm = new vscode.EventEmitter<{ filePath: string; code: string; language: string }>();
  private readonly _onEditRejected = new vscode.EventEmitter<{ filePath: string }>();

  constructor(
    private diffEngine: DiffEngine,
    private fileContextManager: FileContextManager,
    initialEditMode: 'manual' | 'ask' | 'auto'
  ) {
    // Creates diffStatusBarItem
    // Registers onDidCloseTextDocument listener
    // Registers onDidChangeActiveTextEditor listener
  }

  // Diff lifecycle
  async showDiff(code: string, language: string): Promise<void> { ... }
  async applyCode(code: string, language: string): Promise<void> { ... }
  async applyCodeDirectlyForAutoMode(filePath: string, code: string, description?: string, skipNotification?: boolean): Promise<boolean> { ... }
  async acceptSpecificDiff(diffId: string): Promise<void> { ... }
  async rejectSpecificDiff(diffId: string): Promise<void> { ... }
  async acceptAllDiffs(): Promise<void> { ... }
  async rejectAllDiffs(): Promise<void> { ... }
  async closeDiff(): Promise<void> { ... }
  async rejectEdit(filePath: string): Promise<void> { ... }

  // Focus / navigation
  async focusSpecificDiff(diffId: string): Promise<void> { ... }
  async focusFileOrDiff(diffId?: string, filePath?: string): Promise<void> { ... }
  async openFile(filePath: string): Promise<void> { ... }

  // Streaming integration
  handleCodeBlockDetection(accumulatedResponse: string): void { ... }  // encapsulates lines 1591-1638
  async handleAutoShowDiff(code: string, language: string): Promise<void> { ... }
  handleDebouncedDiff(code: string, language: string): void { ... }
  async detectAndProcessUnfencedEdits(content: string): Promise<void> { ... }
  clearProcessedBlocks(): void { ... }
  clearPendingDiffs(): void { ... }
  clearResponseFileChanges(): void { ... }

  // State queries
  getModifiedFilesContext(): string { ... }
  getFileChanges(): Array<{ filePath: string; status: string; iteration: number }> { ... }
  get currentEditMode(): 'manual' | 'ask' | 'auto' { ... }

  // Edit mode & session
  setEditMode(mode: 'manual' | 'ask' | 'auto'): void { ... }
  clearSession(): void { ... }  // called from clearConversation
  emitAutoAppliedChanges(): void { ... }  // called after tool batch closes

  // VS Code UI
  async showDiffQuickPick(): Promise<void> { ... }

  // Buffer coordination
  setFlushCallback(fn: () => void): void { ... }

  dispose(): void { ... }
}
```

### Constructor Dependencies

```typescript
constructor(
  diffEngine: DiffEngine,           // for applyChanges()
  fileContextManager: FileContextManager,  // for inferFilePath()/resolveFilePath() in handleAutoShowDiff
  initialEditMode: 'manual' | 'ask' | 'auto'
)
```

FileContextManager is injected because `handleAutoShowDiff()` calls `fileContextManager.resolveFilePath()` (interactive QuickPick). No circular dependency — unidirectional.

### Constructor Responsibilities (moved from ChatProvider)

1. Create `diffStatusBarItem` (ChatProvider lines 114-120)
2. Register `onDidCloseTextDocument` listener (lines 127-153) — diff tab close tracking
3. Register `onDidChangeActiveTextEditor` listener (lines 156-179) — active diff tracking

### Buffer Flush Coordination

DiffManager needs to flush the content buffer before sending `diffListChanged` (prevents race conditions). ChatProvider provides a callback:

```typescript
this.diffManager.setFlushCallback(() => {
  if (this.contentBuffer) this.contentBuffer.flush();
});
```

Called internally by `notifyDiffListChanged()` and `notifyAutoAppliedFilesChanged()` before firing events.

### ChatProvider Changes

**New member + constructor wiring:**
```typescript
private diffManager: DiffManager;

const editMode = config.get<string>('editMode') || 'manual';
this.diffManager = new DiffManager(new DiffEngine(), this.fileContextManager, editMode as any);
this.diffManager.setFlushCallback(() => { if (this.contentBuffer) this.contentBuffer.flush(); });

// Wire 8 events → webview
this.diffManager.onDiffListChanged(d => this.post('diffListChanged', d));
this.diffManager.onAutoAppliedFilesChanged(d => this.post('diffListChanged', d));
this.diffManager.onCodeApplied(d => this.post('codeApplied', d));
this.diffManager.onActiveDiffChanged(d => this.post('activeDiffChanged', d));
this.diffManager.onDiffClosed(() => this.post('diffClosed'));
this.diffManager.onWarning(d => this.post('warning', d));
this.diffManager.onEditConfirm(d => this.post('showEditConfirm', d));
this.diffManager.onEditRejected(d => this.post('editRejected', d));
```

**Switch cases → single-line delegations (10 cases):**
```
applyCode          → this.diffManager.applyCode(data.code, data.language)
showDiff           → this.diffManager.showDiff(data.code, data.language)
closeDiff          → this.diffManager.closeDiff()
setEditMode        → this.diffManager.setEditMode(data.mode)
rejectEdit         → this.diffManager.rejectEdit(data.filePath)
acceptSpecificDiff → this.diffManager.acceptSpecificDiff(data.diffId)
rejectSpecificDiff → this.diffManager.rejectSpecificDiff(data.diffId)
focusDiff          → this.diffManager.focusSpecificDiff(data.diffId)
openFile           → this.diffManager.openFile(data.filePath)
focusFile          → this.diffManager.focusFileOrDiff(data.diffId, data.filePath)
```

**handleUserMessage cross-cutting (5 call sites):**
```
Line 1146: this.processedCodeBlocks.clear()  →  this.diffManager.clearProcessedBlocks()
Line 1151: this.clearPendingDiffs()           →  this.diffManager.clearPendingDiffs()
Line 1347: this.currentResponseFileChanges=[] →  this.diffManager.clearResponseFileChanges()
Lines 1591-1638: inline code block detection  →  this.diffManager.handleCodeBlockDetection(accumulatedResponse)
Line 1885: this.detectAndProcessUnfencedEdits →  this.diffManager.detectAndProcessUnfencedEdits(cleanResponse)
```

**Tool loop cross-cutting (3 call sites):**
```
Line 2249: this.handleAutoShowDiff(...)       →  this.diffManager.handleAutoShowDiff(...)
Line 2253: this.applyCodeDirectlyForAutoMode  →  this.diffManager.applyCodeDirectlyForAutoMode(...)
Line 2304: this.notifyAutoAppliedFilesChanged →  this.diffManager.emitAutoAppliedChanges()
```

**Other references:**
```
Line 870:  this.editMode = editMode            →  this.diffManager.setEditMode(editMode)
Line 1229: this.editMode                      →  this.diffManager.currentEditMode
Line 1897: editMode: this.editMode            →  editMode: this.diffManager.currentEditMode
Line 1951: this.currentResponseFileChanges    →  this.diffManager.getFileChanges()
Lines 656-663: clearConversation resets        →  this.diffManager.clearSession()
```

### Removed from ChatProvider

- **14 state variables** (listed above)
- **30+ methods** (all diff/edit methods)
- **10 switch cases** (become 1-line delegations)
- **2 constructor event listeners** (onDidCloseTextDocument, onDidChangeActiveTextEditor)
- **Status bar item creation**

### Files

| File | Change |
|------|--------|
| `src/providers/diffManager.ts` | **New** — ~850 lines |
| `src/providers/chatProvider.ts` | Remove ~800 lines, add ~50 lines (member, events, delegations) |
| `tests/unit/providers/diffManager.test.ts` | **New** — ~400-500 lines |

### Verification

- `npx vitest run` — all pass + new DiffManager tests
- Manual: send message with code block in ask mode → diff appears, accept/reject work
- Manual: send multiple edits to same file → superseding works (older shows "Newer Version Below")
- Manual: auto mode applies directly without diff view, Modified Files shows correctly
- Manual: tool loop `apply_code_edit` → diffs appear in ask mode, auto-applies in auto mode
- Manual: status bar shows pending diff count, clicking opens quick pick
- Manual: clearConversation resets diff state

---

## 8. Phase 4 — SettingsManager

**Goal:** Extract settings read/write/sync logic. This is moderately complex because settings are read from VS Code configuration AND synced bidirectionally with the webview.

### State Moved

No state variables move — settings are read from `vscode.workspace.getConfiguration('deepseek')`. The extraction is about consolidating the 12 settings methods.

### Class Design

```typescript
// src/providers/settingsManager.ts

export class SettingsManager {
  // Events
  private readonly _onSettingsChanged = new vscode.EventEmitter<SettingsSnapshot>();
  private readonly _onModelChanged = new vscode.EventEmitter<{ model: string }>();
  private readonly _onEditModeChanged = new vscode.EventEmitter<{ mode: string }>();
  private readonly _onDefaultPromptRequested = new vscode.EventEmitter<{ model: string; prompt: string }>();
  private readonly _onSettingsReset = new vscode.EventEmitter<void>();

  readonly onSettingsChanged = this._onSettingsChanged.event;
  readonly onModelChanged = this._onModelChanged.event;
  readonly onEditModeChanged = this._onEditModeChanged.event;
  readonly onDefaultPromptRequested = this._onDefaultPromptRequested.event;
  readonly onSettingsReset = this._onSettingsReset.event;

  constructor(private deepSeekClient: DeepSeekClient) {}

  // Methods
  updateSettings(settings: { model?: string; temperature?: number; ... }): void { ... }
  updateLogSettings(settings: { logLevel?: string; logColors?: boolean }): void { ... }
  updateWebviewLogSettings(settings: { webviewLogLevel?: string }): void { ... }
  updateTracingSettings(settings: { enabled?: boolean }): void { ... }
  updateReasonerSettings(settings: { allowAllCommands?: boolean }): void { ... }
  updateSystemPrompt(prompt: string): void { ... }
  getDefaultSystemPrompt(): { model: string; prompt: string } { ... }
  getCurrentSettings(): SettingsSnapshot { ... }
  resetToDefaults(): void { ... }

  dispose(): void { ... }
}
```

### Switch Cases Affected

`updateSettings`, `selectModel`, `setTemperature`, `setToolLimit`, `setMaxTokens`, `setLogLevel`, `setLogColors`, `setWebviewLogLevel`, `setTracingEnabled`, `setAllowAllCommands`, `setSystemPrompt`, `getDefaultSystemPrompt`, `getSettings`, `setAutoSaveHistory`, `setMaxSessions`, `resetToDefaults` — 16 cases.

### Files

| File | Change |
|------|--------|
| `src/providers/settingsManager.ts` | **New** — ~300 lines |
| `src/providers/chatProvider.ts` | Remove ~300 lines, add ~8 lines of subscriptions |
| `tests/unit/providers/settingsManager.test.ts` | **New** |

### Verification

- `npx vitest run` — all pass
- Manual: change model, temperature, edit mode — verify settings sync to webview

---

## 9. Phase 5 — RequestOrchestrator

**Goal:** Extract the request pipeline from `handleUserMessage`. This is the hardest phase because `handleUserMessage` is 940 lines with complex control flow (tool loop, shell loop, streaming, history save). We split it into a pipeline of discrete stages.

### What Moves

The 940-line `handleUserMessage` and 300-line `runToolLoop` become a separate class that orchestrates the request lifecycle.

### State Moved

| Variable | From | To |
|----------|------|----|
| `contentBuffer` | ChatProvider | RequestOrchestrator |
| `abortController` | ChatProvider | RequestOrchestrator |
| `currentResponseFileChanges` | ChatProvider | RequestOrchestrator |

### Class Design

```typescript
// src/providers/requestOrchestrator.ts

export class RequestOrchestrator {
  // Events (streaming)
  private readonly _onStartResponse = new vscode.EventEmitter<{ isReasoner: boolean; correlationId?: string }>();
  private readonly _onStreamToken = new vscode.EventEmitter<{ token: string }>();
  private readonly _onStreamReasoning = new vscode.EventEmitter<{ token: string }>();
  private readonly _onEndResponse = new vscode.EventEmitter<EndResponseEvent>();
  private readonly _onGenerationStopped = new vscode.EventEmitter<void>();
  private readonly _onIterationStart = new vscode.EventEmitter<{ iteration: number }>();
  private readonly _onAutoContinuation = new vscode.EventEmitter<{ count: number; max: number; reason: string }>();

  // Events (tool calls)
  private readonly _onToolCallsStart = new vscode.EventEmitter<{ tools: ToolInfo[] }>();
  private readonly _onToolCallsUpdate = new vscode.EventEmitter<{ tools: ToolInfo[] }>();
  private readonly _onToolCallUpdate = new vscode.EventEmitter<{ index: number; status: string; detail: string }>();
  private readonly _onToolCallsEnd = new vscode.EventEmitter<void>();

  // Events (shell execution)
  private readonly _onShellExecuting = new vscode.EventEmitter<{ commands: ShellCommandInfo[] }>();
  private readonly _onShellResults = new vscode.EventEmitter<{ results: ShellResultInfo[] }>();

  // Events (errors)
  private readonly _onError = new vscode.EventEmitter<{ error: string }>();
  private readonly _onWarning = new vscode.EventEmitter<{ message: string }>();

  // Events (history)
  private readonly _onSessionCreated = new vscode.EventEmitter<{ sessionId: string; model: string }>();

  constructor(
    private deepSeekClient: DeepSeekClient,
    private conversationManager: ConversationManager,
    private diffManager: DiffManager,
    private webSearchManager: WebSearchManager,
    private fileContextManager: FileContextManager,
    private settingsManager: SettingsManager,
  ) {}

  // Main entry point (replaces handleUserMessage)
  async handleMessage(message: string, attachments?: Attachment[]): Promise<void> { ... }

  // Abort current request
  stopGeneration(): void { ... }

  dispose(): void { ... }
}
```

### The Pipeline

`handleMessage` becomes a pipeline of steps:

```
1. prepareSession()        — get/create session, save user message
2. buildSystemPrompt()     — combine base + edit mode + editor context + modified files
3. runWebSearch()           — call webSearchManager.searchForMessage()
4. buildContext()           — ContextBuilder truncation + snapshot injection
5. runToolLoop()            — tool calling (chat model only)
6. streamResponse()        — stream tokens through ContentTransformBuffer
7. runShellLoop()           — shell execution loop (reasoner only)
8. saveToHistory()          — record reasoning, tools, shells, files, assistant message
```

Each step is a separate private method. The 940-line method becomes ~8 methods of ~100 lines each.

### Coordination with DiffManager

During streaming, the orchestrator detects code blocks and delegates to DiffManager:

```typescript
// In streaming callback:
if (this.diffManager.editMode !== 'manual') {
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)\n```/g;
  for (const match of accumulatedResponse.matchAll(codeBlockRegex)) {
    const blockId = `${match.index}-${match[0].length}`;
    this.diffManager.handleCodeBlock(blockId, match[2], match[1] || 'plaintext');
  }
}
```

### Files

| File | Change |
|------|--------|
| `src/providers/requestOrchestrator.ts` | **New** — ~1,200 lines (handleUserMessage + runToolLoop + helpers) |
| `src/providers/chatProvider.ts` | Remove ~1,200 lines, add ~20 lines of subscriptions |
| `tests/unit/providers/requestOrchestrator.test.ts` | **New** — pipeline stages, abort handling |

### Verification

- `npx vitest run` — all pass
- Manual: send message, verify streaming, tool calls, shell execution, history save
- Manual: stop generation mid-stream, verify partial save

---

## 10. Phase 6 — Wire Webview Bridge

**Goal:** After all extractions, ChatProvider is a thin coordinator. Clean up the webview bridge — all event subscriptions and message routing in one clear section.

### ChatProvider Final Shape (~400-500 lines)

```typescript
export class ChatProvider implements vscode.WebviewViewProvider {
  // Dependencies
  private webSearchManager: WebSearchManager;
  private fileContextManager: FileContextManager;
  private diffManager: DiffManager;
  private settingsManager: SettingsManager;
  private requestOrchestrator: RequestOrchestrator;

  constructor(...) {
    // Create extracted managers
    this.webSearchManager = new WebSearchManager(tavilyClient);
    this.fileContextManager = new FileContextManager();
    this.diffManager = new DiffManager(new DiffEngine(), 'manual');
    this.settingsManager = new SettingsManager(deepSeekClient);
    this.requestOrchestrator = new RequestOrchestrator(
      deepSeekClient, conversationManager,
      this.diffManager, this.webSearchManager,
      this.fileContextManager, this.settingsManager
    );

    // Wire events → webview (Section A)
    this.wireEvents();
  }

  // ── Section A: Event → Webview Bridge ──
  private wireEvents(): void {
    // Streaming events
    this.requestOrchestrator.onStartResponse(d => this.post('startResponse', d));
    this.requestOrchestrator.onStreamToken(d => this.post('streamToken', d));
    this.requestOrchestrator.onStreamReasoning(d => this.post('streamReasoning', d));
    this.requestOrchestrator.onEndResponse(d => this.post('endResponse', d));
    // ... ~25 more subscriptions ...

    // Diff events
    this.diffManager.onDiffListChanged(d => this.post('diffListChanged', d));
    this.diffManager.onCodeApplied(d => this.post('codeApplied', d));
    // ...
  }

  // ── Section B: Webview → Method Router ──
  private handleWebviewMessage(data: any): void {
    switch (data.type) {
      case 'sendMessage': this.requestOrchestrator.handleMessage(data.message, data.attachments); break;
      case 'stopGeneration': this.requestOrchestrator.stopGeneration(); break;
      case 'acceptSpecificDiff': this.diffManager.acceptDiff(data.diffId); break;
      case 'toggleWebSearch': this.webSearchManager.toggle(data.enabled); break;
      case 'getSettings': this.settingsManager.getCurrentSettings(); break;
      // ... all 51 cases, each a single-line delegation ...
    }
  }

  // ── Section C: Remaining Direct Responsibilities ──
  // resolveWebviewView, getHtmlForWebview, reveal, dispose
  // History modal, stats (small methods that talk to ConversationManager)

  private post(type: string, data?: any): void {
    this._view?.webview.postMessage({ type, ...data });
  }

  dispose(): void {
    this.webSearchManager.dispose();
    this.fileContextManager.dispose();
    this.diffManager.dispose();
    this.settingsManager.dispose();
    this.requestOrchestrator.dispose();
  }
}
```

### Files

| File | Change |
|------|--------|
| `src/providers/chatProvider.ts` | Final cleanup — ~400-500 lines |

---

## 11. What Stays in ChatProvider

After all phases, ChatProvider retains only:

1. **WebviewViewProvider implementation** — `resolveWebviewView()`, `getHtmlForWebview()`
2. **Message router** — the switch statement (thin, single-line delegations)
3. **Event subscriptions** — wiring extracted class events to `postMessage`
4. **Lifecycle** — constructor, dispose, `reveal()`
5. **Small direct methods** — `openHistoryModal()`, `showStats()`, `clearConversation()`, history session CRUD (these are thin enough to not warrant their own class)

Estimated: **400-500 lines** (down from 4,400).

---

## 12. Testing Strategy

### Per-Class Unit Tests

Each extracted class is independently testable without `vscode.WebviewView`:

```typescript
// Example: DiffManager test
describe('DiffManager', () => {
  it('should emit diffListChanged after accepting a diff', async () => {
    const diffManager = new DiffManager(new DiffEngine(), 'ask');
    const events: DiffListChangedEvent[] = [];
    diffManager.onDiffListChanged(e => events.push(e));

    await diffManager.showDiff(code, 'typescript');
    await diffManager.acceptDiff(diffId);

    expect(events).toHaveLength(2);  // One for show, one for accept
    expect(events[1].diffs[0].status).toBe('applied');
  });
});
```

### Integration Test

Verify the full flow: message → orchestrator → diff → webview:

```typescript
describe('ChatProvider integration', () => {
  it('should forward diff events to webview', async () => {
    const messages: any[] = [];
    mockWebview.postMessage = (msg: any) => messages.push(msg);

    chatProvider.diffManager.acceptDiff('test-id');

    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'diffListChanged' })
    );
  });
});
```

### Existing Tests

All 1,109+ existing tests should continue passing at every phase. Run `npx vitest run` after each phase.

---

## 13. Migration Safety

### Rules

1. **One phase at a time** — each phase is a standalone PR
2. **Tests pass after each phase** — no "temporarily broken" states
3. **Feature parity** — no behavior changes, only structural moves
4. **No new features during refactor** — resist the temptation
5. **Commit before each phase starts** — easy rollback

### Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Broken webview communication | Each phase: manual test the affected message types |
| Shared state bugs | State variables are moved wholesale — no splitting |
| Event ordering | Events fire synchronously in `vscode.EventEmitter` — ordering preserved |
| Disposal leaks | Each class implements `dispose()`, ChatProvider calls all in its `dispose()` |
| Circular dependencies | Dependency graph is acyclic: Orchestrator depends on all managers, managers are independent |

### Dependency Graph

```
ChatProvider
  ├── RequestOrchestrator
  │     ├── DiffManager
  │     ├── WebSearchManager
  │     ├── FileContextManager
  │     ├── SettingsManager
  │     ├── DeepSeekClient
  │     └── ConversationManager
  ├── DiffManager
  ├── WebSearchManager
  ├── FileContextManager
  └── SettingsManager
```

No circular dependencies. Each manager is independent. Only RequestOrchestrator has cross-manager dependencies (it calls methods on the others during the request pipeline).

---

## 14. Key Files

### New Files

| File | Role | Est. Lines |
|------|------|-----------|
| `src/providers/types.ts` | Shared event payload types | ~80 |
| `src/providers/webSearchManager.ts` | Web search state & logic | ~120 |
| `src/providers/fileContextManager.ts` | File selection & context | ~250 |
| `src/providers/diffManager.ts` | Diff lifecycle & tab management | ~800 |
| `src/providers/settingsManager.ts` | Settings read/write/sync | ~300 |
| `src/providers/requestOrchestrator.ts` | Request pipeline (handleUserMessage + runToolLoop) | ~1,200 |
| Tests for each | Unit tests | ~200 each |

### Modified Files

| File | Change |
|------|--------|
| `src/providers/chatProvider.ts` | 4,400 → ~400-500 lines (coordinator + webview bridge) |
| `src/extension.ts` | May need to pass new dependencies to ChatProvider |

### Existing Files (unchanged)

| File | Role |
|------|------|
| `src/deepseekClient.ts` | API client (used by RequestOrchestrator) |
| `src/events/ConversationManager.ts` | History (used by RequestOrchestrator) |
| `src/context/contextBuilder.ts` | Token budget (used by RequestOrchestrator) |
| `src/utils/diff.ts` | Diff engine (used by DiffManager) |
| `src/tools/workspaceTools.ts` | Tool definitions (used by RequestOrchestrator) |
| `src/tools/reasonerShellExecutor.ts` | Shell execution (used by RequestOrchestrator) |
