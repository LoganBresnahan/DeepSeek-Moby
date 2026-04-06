# Real-Time CQRS for the Webview UI

## Problem Statement

The live streaming path and the history restore path produce the same visual result through fundamentally different mechanisms:

- **Live streaming:** Imperative stream processor — tokens arrive, get buffered/debounced, transformed (shell tag detection, code fence detection), and pushed to the DOM incrementally. Async events (file watcher notifications, shell results) can arrive out of order, splitting text segments at arbitrary positions.

- **History restore:** Event-sourced projection — complete event data is read from SQLite, projected into `RichHistoryTurn` objects, and the UI rebuilds deterministically from the full picture. No timing issues because all data is available at once.

The two paths share no code. Bugs fixed in one path don't automatically fix the other. The live path has timing bugs (word splitting, segment ordering) that the history path doesn't have, precisely because history has the luxury of complete data.

## What CQRS Would Look Like in Real-Time

Instead of pushing tokens directly to DOM, every streaming event goes into an ordered in-memory event log:

```
[0] { type: 'text', content: "I'll add Otter...", ts: 1000 }
[1] { type: 'shell-start', command: "cat >> animals.txt...", ts: 1001 }
[2] { type: 'shell-complete', command: "cat >> ...", output: '', ts: 1002 }
[3] { type: 'file-modified', path: 'animals.txt', ts: 1003 }
[4] { type: 'text', content: "Done! I've appended...", ts: 1004 }
[5] { type: 'shell-start', command: "tail -5 animals.txt", ts: 1005 }
[6] { type: 'shell-complete', command: "tail -5...", output: '...', ts: 1006 }
```

A **projector** reads the log and produces the UI state. When event [3] (file-modified) arrives late (after event [4] text has started), the projector knows it belongs after event [2] (shell complete), not in the middle of event [4]. It places the Modified Files dropdown in the correct semantic position regardless of physical arrival time.

### How It Extends History Restoration

History restore already does this — `getSessionRichHistory()` reads all events from the DB, groups them into `RichHistoryTurn` objects, and the gateway's `handleLoadHistory()` builds the UI from the complete projection. The key difference is timing:

| Aspect | History Restore | Real-Time CQRS |
|--------|----------------|----------------|
| Data availability | Complete (all events in DB) | Incremental (events arrive over time) |
| Ordering | Guaranteed (sequence numbers) | Requires causal ordering logic |
| Projection | One-shot (build entire turn) | Incremental (update on each new event) |
| DOM updates | Full rebuild from data | Incremental reconciliation |

Real-time CQRS would unify both paths:
1. Live events go into the in-memory log (same structure as DB events)
2. The projector incrementally updates the UI as new events arrive
3. When streaming ends, the in-memory log IS the history — write it to DB
4. History restore reads from DB into the same log format, same projector renders it

This eliminates the current dual-path problem where live bugs and history bugs are fixed independently.

### Implementation Complexity

This requires:
- An in-memory event log per turn (ordered, with causal relationships)
- A projector that maps event log to DOM state (similar to React's virtual DOM diffing)
- Incremental DOM reconciliation (insert/update/reorder elements without full rebuild)
- Causal ordering logic (file-modified events attach to their causing shell event, not to the current stream position)

**Estimated effort:** 2-4 weeks. This is a post-beta architectural investment.

### Pragmatic Alternative (Implemented)

**Status: Done.** Async file watcher notifications are queued in `VirtualMessageGatewayActor._pendingFileNotifications` during active streaming and flushed at natural break points:
- `handleShellExecuting()` — before a new shell dropdown
- `handleIterationStart()` — before a new thinking iteration
- `handleEndResponse()` — before the stream finalizes

This preserves the streaming feel while avoiding the word-splitting issue. The Modified Files dropdown appears ~1-2 seconds later than before (at the next natural break instead of immediately), but never splits a word. See [chat-streaming.md](../architecture/integration/chat-streaming.md) for the updated timing diagram.

---

## Alternative Architectures Considered

### 1. Event Sourcing with Projection

**What it is:** All events (tokens, shell results, file changes) go into an ordered log. A "projector" builds the UI state from the log.

**How we use it:** Partially — our history restoration is event-sourced (events stored in SQLite, projected into `RichHistoryTurn` objects). But the live streaming path bypasses this entirely, pushing tokens directly to the DOM.

**The gap:** Events arrive from different sources at different times (token stream, file watcher, shell executor) with no global ordering guarantee. The in-memory event log would need causal ordering — knowing that a file-modified event belongs after the shell-complete event, even if it physically arrives later.

**Applicability:** High. This is the natural extension of what we already have. The main cost is building the real-time projector and DOM reconciliation layer.

### 2. Reactive Streams / Backpressure

**What it is:** Systems like RxJS, Akka Streams, or Project Reactor where downstream consumers signal upstream producers to slow down. If the file watcher hasn't reported yet, the text stream pauses until all concurrent events are resolved.

**How it would help:** If the token stream had backpressure, we could pause text rendering until file watcher notifications arrive, ensuring correct ordering. The text would resume once all async operations for the current chunk complete.

**The gap:** We don't control the upstream — DeepSeek's SSE stream sends tokens at its own pace. We can buffer them (which we do with ContentTransformBuffer) but we can't tell DeepSeek to slow down. Backpressure only works within our own pipeline.

**Applicability:** Medium. We could use RxJS-style operators internally (merge, combineLatest, debounce) to coordinate the token stream with async notifications. But adding RxJS as a dependency for the webview bundle increases complexity and size. The queuing approach achieves similar results with less machinery.

### 3. Operational Transformation (OT)

**What it is:** What Google Docs uses for collaborative editing. Multiple concurrent operations are transformed against each other to maintain consistency. If two users edit the same paragraph simultaneously, OT ensures both edits are applied correctly.

**How it would help:** Multiple "editors" (token stream, file watcher, shell executor) producing concurrent changes to the same document (the chat UI). OT would transform late-arriving operations to insert at the correct position.

**Applicability:** Low. OT is designed for collaborative text editing with multiple human users. Our problem is simpler — we have one producer (the LLM) with multiple side-effect channels. The ordering is causal (file change is caused by shell command), not concurrent. OT is overkill.

### 4. Virtual DOM with Reconciliation

**What it is:** What React does. You declare the desired state as a tree of components. The framework diffs the new tree against the old tree and applies minimal DOM mutations.

**How it would help:** Instead of imperatively inserting DOM elements as events arrive, we'd declare the entire turn's state and let a reconciler figure out the mutations. When a file-modified event arrives, we'd update the state tree and the reconciler would insert the dropdown at the right position, potentially reordering existing elements.

**The gap:** We don't use React — our UI is built with Shadow DOM actors and imperative DOM manipulation. Adding a virtual DOM layer would require either adopting React/Preact for the webview or building a custom reconciler.

**Applicability:** Medium-high for a future rewrite. If we ever rebuild the webview UI, a declarative framework would eliminate entire categories of ordering bugs. But retrofitting it onto the current actor system is impractical.

### 5. CQRS (Command/Query Responsibility Segregation)

**What it is:** Separate the "what happened" (commands/events) from "what to show" (read model/projection). The write side records events. The read side builds optimized views from those events. The two sides can use completely different data structures and update at different rates.

**How we use it:** Our history system is CQRS — events are written to SQLite (write side), and `getSessionRichHistory()` projects them into `RichHistoryTurn` objects (read side). The read side rebuilds the full UI state from events, which is why history restore doesn't have timing bugs.

**The gap:** The live streaming path doesn't use CQRS — it pushes directly to the DOM (no separation between events and view). Extending CQRS to real-time would mean: write events to an in-memory log as they stream, project them into view state, render view state to DOM. Late-arriving events would update the log, re-project, and reconcile the DOM.

**Applicability:** High. This is the recommended long-term architecture. It unifies live streaming and history restore into one code path.

---

## Recommendation

**For beta:** Use the pragmatic queuing approach. Queue async notifications and flush at natural break points. Minimal code change, solves the visible problem.

**Post-beta:** Implement real-time CQRS. See implementation plan below.

---

## Implementation Plan

### Overview

Replace the current dual-path architecture (imperative streaming + projection-based history restore) with a unified event log + projector system. Both live streaming and history restore will feed events into the same in-memory log, and the same projector will render the UI.

### Current Architecture (What We're Replacing)

```
LIVE STREAMING:
  RequestOrchestrator → EventEmitters → VirtualMessageGatewayActor → VirtualListActor → MessageTurnActor → DOM
  (imperative, timing-dependent, ~15 handle* methods dispatching directly)

HISTORY RESTORE:
  SQLite → ConversationManager.getSessionRichHistory() → RichHistoryTurn → Gateway.handleLoadHistory() → VirtualListActor → DOM
  (projection-based, complete data, different code path)
```

The gateway currently has ~15 `handle*` methods that each modify `VirtualListActor` state imperatively. The `VirtualListActor.contentOrder` array is an ad-hoc event log — it tracks the creation order of segments so turns can be reconstructed when scrolled back into view. This is the seed of the CQRS pattern, but it's built after the fact rather than being the source of truth.

### Target Architecture

```
BOTH PATHS:
  Event Sources → TurnEventLog (in-memory, ordered) → TurnProjector → ViewModel → VirtualListActor → MessageTurnActor → DOM

  Event Sources:
    - Live: RequestOrchestrator emitters (streamToken, shellExecuting, etc.)
    - History: ConversationManager.getSessionRichHistory() → batch insert
    - Late: File watcher notifications, approval resolutions
```

### Phase 1: TurnEventLog (The In-Memory Event Store)

**New file: `media/events/TurnEventLog.ts`**

```typescript
/** Every event that can happen within a turn */
export type TurnEvent =
  | { type: 'text-append'; content: string; iteration: number; ts: number }
  | { type: 'text-finalize'; iteration: number; ts: number }
  | { type: 'thinking-start'; iteration: number; ts: number }
  | { type: 'thinking-content'; content: string; iteration: number; ts: number }
  | { type: 'thinking-complete'; iteration: number; ts: number }
  | { type: 'shell-start'; id: string; commands: ShellCommand[]; iteration: number; ts: number }
  | { type: 'shell-complete'; id: string; results: ShellResult[]; ts: number }
  | { type: 'approval-created'; id: string; command: string; prefix: string; shellId: string; ts: number }
  | { type: 'approval-resolved'; id: string; decision: 'allowed' | 'blocked'; persistent: boolean; ts: number }
  | { type: 'file-modified'; path: string; status: string; causedBy?: string; ts: number }
  | { type: 'tool-batch-start'; tools: ToolCall[]; ts: number }
  | { type: 'tool-update'; index: number; status: string; ts: number }
  | { type: 'tool-batch-complete'; ts: number }
  | { type: 'code-block'; language: string; content: string; iteration: number; ts: number }
  | { type: 'drawing'; imageDataUrl: string; ts: number };

export class TurnEventLog {
  private events: TurnEvent[] = [];
  private listeners: Array<(event: TurnEvent, index: number) => void> = [];

  /** Append an event to the log. Notifies listeners. */
  append(event: TurnEvent): number { ... }

  /** Insert an event at the correct causal position (for late-arriving events).
   *  e.g., file-modified inserts after its causedBy shell-complete, not at the end. */
  insertCausal(event: TurnEvent & { causedBy: string }): number { ... }

  /** Bulk load events (for history restore). No listener notifications. */
  load(events: TurnEvent[]): void { ... }

  /** Subscribe to new events (for live rendering). */
  subscribe(listener: (event: TurnEvent, index: number) => void): () => void { ... }

  /** Get all events (for history save or full projection). */
  getAll(): TurnEvent[] { ... }

  /** Get events for a specific iteration. */
  getByIteration(iteration: number): TurnEvent[] { ... }
}
```

**Key design decisions:**
- `causedBy` field on `file-modified` events links to the `shell-start.id` that caused the modification. The `insertCausal` method finds the corresponding `shell-complete` event and inserts after it, regardless of when the file watcher notification physically arrived.
- `iteration` field on content events replaces our current `iterationIndex` bolted-on fields. It's a first-class concept.
- The log is append-only during streaming. `insertCausal` is the only method that can insert out-of-order, and only for async side-effects (file watcher, late approvals).

**Effort: ~150 lines, 1-2 days**

### Phase 2: TurnProjector (Event Log → View Model)

**New file: `media/events/TurnProjector.ts`**

The projector reads the event log and produces an ordered array of "view segments" — the same concept as the current `contentOrder` array, but richer:

```typescript
export type ViewSegment =
  | { type: 'text'; content: string; complete: boolean; continuation: boolean }
  | { type: 'thinking'; content: string; iteration: number; complete: boolean }
  | { type: 'shell'; id: string; commands: ShellCommand[]; results?: ShellResult[]; complete: boolean }
  | { type: 'approval'; id: string; command: string; prefix: string; status: 'pending' | 'allowed' | 'blocked'; persistent?: boolean }
  | { type: 'file-modified'; path: string; status: string; editMode?: string }
  | { type: 'tool-batch'; tools: ToolCall[]; complete: boolean }
  | { type: 'code-block'; language: string; content: string }
  | { type: 'drawing'; imageDataUrl: string };

export class TurnProjector {
  /** Full projection: read entire log, produce complete view model.
   *  Used for: history restore, scroll-into-view reconstruction. */
  projectFull(log: TurnEventLog): ViewSegment[] { ... }

  /** Incremental projection: given a new event appended at index N,
   *  return the minimal set of view model mutations.
   *  Used for: live streaming. */
  projectIncremental(log: TurnEventLog, event: TurnEvent, index: number): ViewMutation[] { ... }
}

export type ViewMutation =
  | { op: 'append'; segment: ViewSegment }
  | { op: 'update'; segmentIndex: number; segment: ViewSegment }
  | { op: 'insert'; afterIndex: number; segment: ViewSegment }
  | { op: 'remove'; segmentIndex: number };
```

**How projectFull works (replaces handleLoadHistory restore loop + contentOrder):**

```typescript
projectFull(log: TurnEventLog): ViewSegment[] {
  const segments: ViewSegment[] = [];
  let currentText: ViewSegment | null = null;

  for (const event of log.getAll()) {
    switch (event.type) {
      case 'text-append':
        if (!currentText || currentText.complete) {
          currentText = { type: 'text', content: event.content, complete: false, continuation: !!currentText };
          segments.push(currentText);
        } else {
          currentText.content += event.content;
        }
        break;

      case 'text-finalize':
        if (currentText) currentText.complete = true;
        break;

      case 'thinking-start':
        currentText = null; // break text flow
        segments.push({ type: 'thinking', content: '', iteration: event.iteration, complete: false });
        break;

      case 'thinking-content':
        const thinking = segments.findLast(s => s.type === 'thinking' && !s.complete);
        if (thinking && thinking.type === 'thinking') thinking.content += event.content;
        break;

      case 'thinking-complete':
        const thinkingDone = segments.findLast(s => s.type === 'thinking' && !s.complete);
        if (thinkingDone && thinkingDone.type === 'thinking') thinkingDone.complete = true;
        break;

      case 'shell-start':
        currentText = null;
        segments.push({ type: 'shell', id: event.id, commands: event.commands, complete: false });
        break;

      case 'shell-complete':
        const shell = segments.find(s => s.type === 'shell' && s.id === event.id);
        if (shell && shell.type === 'shell') { shell.results = event.results; shell.complete = true; }
        break;

      case 'approval-created':
        segments.push({ type: 'approval', id: event.id, command: event.command, prefix: event.prefix, status: 'pending' });
        break;

      case 'approval-resolved':
        const approval = segments.find(s => s.type === 'approval' && s.id === event.id);
        if (approval && approval.type === 'approval') {
          approval.status = event.decision;
          approval.persistent = event.persistent;
        }
        break;

      case 'file-modified':
        // Causal insertion already handled by TurnEventLog.insertCausal
        // By the time we see it here, it's in the right position
        segments.push({ type: 'file-modified', path: event.path, status: event.status });
        break;
    }
  }
  return segments;
}
```

**How projectIncremental works (replaces the gateway's handle* methods):**

For most events, `projectIncremental` returns a single `append` or `update` mutation. For `insertCausal` events (file-modified), it returns an `insert` mutation at the correct position. The gateway applies mutations to VirtualListActor instead of calling individual methods.

**Effort: ~300 lines, 2-3 days**

### Phase 3: Gateway Integration (Wire It Up)

**Modified file: `media/actors/message-gateway/VirtualMessageGatewayActor.ts`**

Replace the ~15 individual `handle*` methods with a unified event dispatch:

```typescript
// BEFORE (current): 15 methods, each imperatively modifying VirtualListActor
handleStreamToken(msg) { ... }
handleStreamReasoning(msg) { ... }
handleShellExecuting(msg) { ... }
handleDiffListChanged(msg) { ... }
// ... etc

// AFTER: One method receives all messages, appends to event log, applies mutations
private _turnLogs = new Map<string, TurnEventLog>();
private _projector = new TurnProjector();

handleTurnEvent(turnId: string, event: TurnEvent): void {
  const log = this._turnLogs.get(turnId) ?? this.createTurnLog(turnId);

  // Causal insertion for async events
  if (event.type === 'file-modified' && event.causedBy) {
    log.insertCausal(event);
    // Full re-project needed (insertion changes segment order)
    const segments = this._projector.projectFull(log);
    this.reconcile(turnId, segments);
  } else {
    // Normal append + incremental projection
    const index = log.append(event);
    const mutations = this._projector.projectIncremental(log, event, index);
    this.applyMutations(turnId, mutations);
  }
}
```

**The message dispatcher translates VS Code messages → TurnEvents:**

```typescript
// In handleMessage():
case 'streamToken':
  this.handleTurnEvent(this._currentTurnId, {
    type: 'text-append', content: msg.token, iteration: this._currentIteration, ts: Date.now()
  });
  break;
case 'shellExecuting':
  this.handleTurnEvent(this._currentTurnId, {
    type: 'shell-start', id: generateId(), commands: msg.commands, iteration: this._currentIteration, ts: Date.now()
  });
  break;
case 'diffListChanged':
  this.handleTurnEvent(this._currentTurnId ?? this._lastStreamingTurnId, {
    type: 'file-modified', path: msg.filePath, status: msg.status, causedBy: this._lastShellId, ts: Date.now()
  });
  break;
```

**What gets removed:**
- `_hasInterleaved` flag (projector handles segment breaks)
- `_segmentContent` accumulator (event log accumulates)
- `_pendingFileNotifications` queue (causal insertion handles ordering)
- `_pendingApprovalId` tracking (event log links approvals to shells by id)
- `finalizeCurrentSegment()` calls (projector knows when segments end)
- `flushPendingFileNotifications()` (no longer needed)

**What stays:**
- `_currentTurnId` / `_lastStreamingTurnId` (still need to know which turn is active)
- `_currentIteration` counter (still incremented by iterationStart messages)
- `_streaming` phase tracking (for UI state like disabling buttons)

**Effort: ~200 lines changed, 2-3 days**

### Phase 4: Reconciler (View Model → DOM)

**Modified file: `media/actors/virtual-list/VirtualListActor.ts`**

The `applyMutations` method on the gateway calls into VirtualListActor, which applies `ViewMutation[]` to its `TurnData`:

```typescript
applyViewMutations(turnId: string, mutations: ViewMutation[]): void {
  const turn = this._turnMap.get(turnId);
  if (!turn) return;

  for (const mutation of mutations) {
    switch (mutation.op) {
      case 'append':
        this.appendSegment(turnId, turn, mutation.segment);
        break;
      case 'update':
        this.updateSegment(turnId, turn, mutation.segmentIndex, mutation.segment);
        break;
      case 'insert':
        this.insertSegment(turnId, turn, mutation.afterIndex, mutation.segment);
        break;
      case 'remove':
        this.removeSegment(turnId, turn, mutation.segmentIndex);
        break;
    }
  }
}

/** Full reconcile: clear turn and rebuild from segments (used for causal re-ordering) */
reconcileFull(turnId: string, segments: ViewSegment[]): void {
  const turn = this._turnMap.get(turnId);
  if (!turn) return;

  // Clear existing content
  turn.contentOrder = [];
  turn.textSegments = [];
  turn.shellSegments = [];
  // ... clear all arrays ...

  // Rebuild from view model
  for (const segment of segments) {
    this.appendSegment(turnId, turn, segment);
  }

  // If bound, re-render
  const bound = this._boundActors.get(turnId);
  if (bound) {
    bound.actor.reset();
    this.restoreTurnContent(bound.actor, turn);
  }
}
```

**The key insight:** `appendSegment` replaces the current `addTextSegment`, `createShellSegment`, `addPendingFile`, etc. — it's a single method that handles all segment types. The `contentOrder` array is built as a side effect of appending segments, not tracked separately.

**`restoreTurnContent` stays almost unchanged** — it already iterates `contentOrder` and delegates to MessageTurnActor. The difference is that it's now called from reconcileFull (for causal re-ordering) as well as from bindTurn (for scroll reconstruction).

**Effort: ~200 lines changed, 2 days**

### Phase 5: History Unification

**Modified files: `VirtualMessageGatewayActor.ts`, `ConversationManager.ts`**

**History Save (streaming → DB):**

When streaming ends, the `TurnEventLog` for the current turn is serialized and stored. The existing `saveToHistory` pipeline in `requestOrchestrator.ts` can extract the events from the log instead of manually assembling `shellResultsForHistory`, `contentIterations`, `reasoningIterations`, etc.

```typescript
// In requestOrchestrator, after streaming ends:
const turnLog = this.getCurrentTurnEventLog();
await this.conversationManager.recordTurnEvents(sessionId, turnLog.getAll());
```

This replaces the current `saveToHistory` method which manually records reasoning iterations, shell results, tool calls, and content iterations as separate event types. The entire turn is saved as one ordered event log.

**History Restore (DB → event log → projector → DOM):**

```typescript
// In handleLoadHistory:
for (const turn of history) {
  const log = new TurnEventLog();

  // Convert RichHistoryTurn → TurnEvent[] (backward compatibility)
  const events = convertRichHistoryToEvents(turn);
  log.load(events);

  // Project and render
  const segments = this._projector.projectFull(log);
  this.reconcileFull(turnId, segments);

  // Store log for potential re-projection
  this._turnLogs.set(turnId, log);
}
```

**No backward compatibility needed.** Old sessions are deleted before the beta ships. The migration file has a single version 1 schema — no incremental migrations. New sessions will be saved in the event log format directly.

**Effort: ~150 lines, 1-2 days**

### Phase 6: Remove Dead Code

After phases 1-5, the following can be removed:

**Gateway methods replaced by `handleTurnEvent`:**
- `handleStreamToken` → `text-append` event
- `handleStreamReasoning` → `thinking-content` event
- `handleShellExecuting` → `shell-start` event
- `handleShellResults` → `shell-complete` event
- `handleCommandApprovalRequired` → `approval-created` event
- `handleCommandApprovalResolved` → `approval-resolved` event
- `handleDiffListChanged` → `file-modified` event (causal)
- `handleIterationStart` → iteration counter update
- `finalizeCurrentSegment` → `text-finalize` event
- `flushPendingFileNotifications` → no longer needed

**VirtualListActor methods replaced by `applyViewMutations`:**
- Individual `addTextSegment`, `updateTextContent`, `finalizeCurrentSegment`, `resumeWithNewSegment` → `appendSegment` + `updateSegment`
- `createShellSegment`, `setShellResults` → `appendSegment` + `updateSegment`
- `createCommandApproval`, `resolveCommandApproval` → `appendSegment` + `updateSegment`
- `addPendingFile` → `appendSegment`

**RequestOrchestrator fields replaced by event log:**
- `_approvalPending`, `_heldSegments` → approval events in log
- `iterationIndex` tagging on shell results → `iteration` field on events
- `contentIterations` array with `{ text, iterationIndex }` → `text-append` events with `iteration`

**Effort: ~300 lines removed, 1 day**

### Migration Strategy

1. **Phase 1-2 first** (TurnEventLog + TurnProjector) — these are new files with no existing code dependencies. Can be built and unit tested in isolation.
2. **Phase 3** (Gateway integration) — the highest-risk phase. Replace the handle methods with event dispatch. Work on a branch — if it breaks, revert.
3. **Phase 4** (Reconciler) — modify VirtualListActor to accept `ViewMutation[]`. The existing methods can remain as internal helpers called by `appendSegment`.
4. **Phase 5** (History unification) — once live streaming works through the new path, switch history restore to use the same path. No backward compatibility needed — old sessions are deleted.
5. **Phase 6** (Cleanup) — remove the old handle methods, dead fields, and `iterationIndex` bolted-on fields.

### Testing Strategy

The key advantage of CQRS: **one test suite covers both paths.**

```typescript
describe('TurnProjector', () => {
  it('text + shell + text produces correct segments', () => {
    const log = new TurnEventLog();
    log.append({ type: 'text-append', content: 'Hello', iteration: 0, ts: 1 });
    log.append({ type: 'text-finalize', iteration: 0, ts: 2 });
    log.append({ type: 'shell-start', id: 'sh-1', commands: [...], iteration: 0, ts: 3 });
    log.append({ type: 'shell-complete', id: 'sh-1', results: [...], ts: 4 });
    log.append({ type: 'text-append', content: 'World', iteration: 0, ts: 5 });

    const segments = projector.projectFull(log);
    expect(segments).toEqual([
      { type: 'text', content: 'Hello', complete: true, continuation: false },
      { type: 'shell', id: 'sh-1', commands: [...], results: [...], complete: true },
      { type: 'text', content: 'World', complete: false, continuation: true },
    ]);
  });

  it('causal insertion places file-modified after its shell', () => {
    const log = new TurnEventLog();
    log.append({ type: 'shell-start', id: 'sh-1', ... });
    log.append({ type: 'shell-complete', id: 'sh-1', ... });
    log.append({ type: 'text-append', content: 'Done!', ... });
    // File notification arrives late — insertCausal places it after shell-complete
    log.insertCausal({ type: 'file-modified', path: 'file.txt', status: 'applied', causedBy: 'sh-1', ts: 999 });

    const segments = projector.projectFull(log);
    // file-modified should be after shell, before text
    expect(segments[1].type).toBe('shell');
    expect(segments[2].type).toBe('file-modified');
    expect(segments[3].type).toBe('text');
  });
});
```

These same events can be loaded from history or emitted live — the projector doesn't know or care.

### Estimated Total Effort

| Phase | Description | New/Changed Lines | Days |
|-------|-------------|-------------------|------|
| 1 | TurnEventLog | ~150 new | 1-2 |
| 2 | TurnProjector | ~300 new | 2-3 |
| 3 | Gateway integration | ~200 changed | 2-3 |
| 4 | Reconciler | ~200 changed | 2 |
| 5 | History unification | ~150 changed | 1-2 |
| 6 | Dead code removal | ~300 removed | 1 |
| **Total** | | **~1000 net** | **9-13 days** |

### Risk Assessment

**High risk:** Phase 3 (gateway integration). The gateway is the most complex component and touching every message path is risky. Mitigation: working on a branch — if it breaks, revert.

**Medium risk:** Phase 4 (reconciler). The `reconcileFull` method re-renders an entire turn, which could cause flickering or layout shifts during causal re-ordering. Mitigation: only use full reconcile for causal insertions (rare — only file-modified events).

**Low risk:** Phases 1-2 (event log + projector). Pure data structures with no UI dependencies. Easy to unit test in isolation.
