# Diff Engine & Edit Modes

This document details the file modification system, including edit modes, diff creation, storage, and the pending changes workflow.

> **Scope note.** This document covers the *match-and-apply* contract: how a SEARCH/REPLACE block is parsed, matched, and written. The strict matching and hard-fail policy described here guards the **no-match** path — it does **not** validate a REPLACE whose SEARCH *does* match. The fail-safe wrapper around auto-apply (checkpoint, atomic batch, post-apply validation, revert-on-regression, Auto→Ask demotion) that covers the *match-but-garbled* case is specified separately in [edit-safety.md](edit-safety.md) / [ADR 0006](../decisions/0006-edit-safety-checkpoint-and-validation.md). Changes to the strategies below must preserve, or explicitly update, the guarantees those layers depend on.

## Search/Replace Format

The LLM uses an Aider-style search/replace format for precise code modifications. This format ensures reliable parsing even when the model output contains code with similar markers.

### Format Specification

```
<<<<<<< SEARCH
exact code to find (copied verbatim from file)
=======
replacement code
>>>>>>> REPLACE
```

**Key elements:**
- `<<<<<<< SEARCH` - Opens the search section (5-9 `<` characters)
- `=======` - Separates search from replace (5-9 `=` characters)
- `>>>>>>> REPLACE` - Closes the block (5-9 `>` characters)

The `SEARCH` and `REPLACE` labels on the outer markers provide sufficient disambiguation from similar patterns in source code (e.g., git merge conflicts).

### File Header

Each edit block should be preceded by a file header:

```
# File: path/to/file.ts
<<<<<<< SEARCH
original code
=======
new code
>>>>>>> REPLACE
```

### Examples

**Editing existing code:**
```typescript
# File: src/utils/helper.ts
<<<<<<< SEARCH
export function calculate(x: number): number {
  return x + 1;
}
=======
export function calculate(x: number): number {
  return x * 2;
}
>>>>>>> REPLACE
```

**Creating a new file (empty SEARCH):**
```typescript
# File: src/utils/newFile.ts
<<<<<<< SEARCH
=======
export function newHelper(): string {
  return "hello";
}
>>>>>>> REPLACE
```

**Adding code after existing code:**
```typescript
# File: src/services/api.ts
<<<<<<< SEARCH
  async fetchUser(id: string): Promise<User> {
    return this.get(`/users/${id}`);
  }
=======
  async fetchUser(id: string): Promise<User> {
    return this.get(`/users/${id}`);
  }

  async createUser(data: UserData): Promise<User> {
    return this.post('/users', data);
  }
>>>>>>> REPLACE
```

### Parsing Implementation

The regex pattern in `src/utils/diff.ts`:

```typescript
const regex = /<{5,9}\s*SEARCH\s*\n([\s\S]*?)(?:\n)?={5,9}\s*\n([\s\S]*?)(?:\n)?>{5,9}\s*REPLACE/g;
```

### Sanitization

Both SEARCH and REPLACE sections are sanitized to remove lines that are just conflict markers (`=======`, `<<<<<<`, `>>>>>>>`). These are format artifacts from model confusion, not actual code.

After sanitization:
- If SEARCH is empty → prepend REPLACE to file (or create new file)
- If SEARCH has content → find it in file and replace with REPLACE
- If SEARCH can't be matched → the block **hard-fails** (no force-apply)

### Match Strategies

`DiffEngine.applySearchReplace()` tries strategies in order of reliability and
**stops at the first that applies**. Every strategy inserts the REPLACE text
verbatim and only ever replaces a region the SEARCH genuinely matches — a SEARCH
that doesn't match the file is *refused*, not force-fit:

1. **Exact match** — direct substring search for the SEARCH content.
2. **Whitespace-normalized line match** — compares lines after trimming, so pure
   indentation drift still applies; the file's original indentation is preserved.
3. **Patch-based match** — builds a unified diff (jsdiff) and applies it with
   `fuzzFactor: 0` (strict context). `compareLine` still tolerates whitespace
   differences, but context lines must otherwise match, so the patch will not
   splice the change into an approximately-matching region.

Before strategies 2–3 run, a **staleness gate** rejects the block when the
SEARCH's line-similarity to the file is below `0.75` (the file likely changed
since the model last read it).

If no strategy matches, `applySearchReplace` returns `success: false` with the
file content **unchanged**. In auto mode this propagates as an edit failure (see
`DiffManager.applyCodeDirectlyForAutoMode` → `RequestOrchestrator`), so the model
is told to re-read and resend a verbatim SEARCH — a non-match is never silently
reported as applied.

> **Boundary of this guarantee.** Strict matching + hard-fail protect against a
> SEARCH that doesn't match. They do **not** check whether the REPLACE the model
> emitted is itself correct: once a SEARCH matches (an append, a tiny search, a
> whole-file rewrite), the REPLACE is written verbatim, garble and all. Catching
> that case — model-emitted garble in a *matching* REPLACE — is the job of the
> post-apply validation gate in [edit-safety.md](edit-safety.md) / [ADR 0006](../decisions/0006-edit-safety-checkpoint-and-validation.md),
> not of these strategies.

> **Removed: location/anchor matching.** A former 4th strategy reconstructed the
> target region from a few distinctive "anchor" lines and wrote the REPLACE block
> over it. Because it ignored whether the *rest* of the SEARCH matched, a single
> misremembered line in the model's SEARCH could overwrite the file's real line
> with a hallucinated one (e.g. `this.turn` → an invented `this.current`). Even a
> high score threshold didn't prevent it — near-whole-file near-misses score high
> on anchors. It was removed in favor of hard-failing, which hands the model a
> clean retry signal instead of a corrupted file.

See `DiffEngine.applySearchReplace()` for implementation details.

---

## Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Diff Engine Overview                              │
└─────────────────────────────────────────────────────────────────────────────┘

    AI wants to modify a file
              │
              ▼
    ┌─────────────────────┐
    │  write_file tool    │
    │  or <shell> edit    │
    └──────────┬──────────┘
               │
               ▼
    ┌─────────────────────┐
    │   Check Edit Mode   │
    │  (manual/ask/auto)  │
    └──────────┬──────────┘
               │
    ┌──────────┼──────────┬──────────────────┐
    │          │          │                  │
    ▼          ▼          ▼                  │
 MANUAL      ASK        AUTO                 │
    │          │          │                  │
    ▼          ▼          ▼                  │
 Create     Create     Apply                 │
 diff &     diff &     directly              │
 show UI    prompt     ────────────────────--┤
    │          │                             │
    │          ▼                             │
    │     ┌─────────┐                        │
    │     │ Inline  │                        │
    │     │ Accept /│                        │
    │     │ Reject  │                        │
    │     └────┬────┘                        │
    │     ┌────┴────┐                        │
    │     │         │                        │
    │    Yes        No                       │
    │     │         │                        │
    │     ▼         ▼                        │
    │   Apply    Reject                      │
    │     │         │                        │
    └─────┼─────────┘                        │
          │                                  │
          ▼                                  │
    ┌─────────────────────┐                  │
    │ Update pending UI   │◀────────────────┘
    │ Notify webview      │
    └─────────────────────┘
```

## Edit Modes

### Mode Comparison

```
┌────────────────────────────────────────────────────────────────────────────┐
│                           Edit Mode Comparison                              │
├──────────┬─────────────────────────────────────────────────────────────────┤
│  Mode    │  Behavior                                                       │
├──────────┼─────────────────────────────────────────────────────────────────┤
│          │  • Creates diff without applying                                │
│  MANUAL  │  • Shows in Pending Changes panel                               │
│    M     │  • User must click Accept/Reject                                │
│          │  • Safest option - full user control                            │
│          │  • Files can be reviewed before any changes                     │
├──────────┼─────────────────────────────────────────────────────────────────┤
│          │  • Creates diff                                                 │
│   ASK    │  • Auto-opens the diff editor (no native dialog)                │
│    Q     │  • Accept/Reject via the inline webview buttons                 │
│          │  • Good balance of safety and speed                             │
│          │  • Interrupts workflow with each file                           │
├──────────┼─────────────────────────────────────────────────────────────────┤
│          │  • Applies changes immediately                                  │
│   AUTO   │  • No diff created (or immediately applied)                     │
│   🐾A    │  • "Walk on the Wild Side" mode                                 │
│          │  • Fast but dangerous - no review                               │
│          │  • Use only with git safety net                                 │
└──────────┴─────────────────────────────────────────────────────────────────┘
```

### Mode State Flow

```
                        ┌─────────────────┐
                        │   User selects  │
                        │   mode in UI    │
                        └────────┬────────┘
                                 │
                                 ▼
                        ┌─────────────────┐
                        │ ToolbarShadow   │
                        │ Actor publishes │
                        │ toolbar.editMode│
                        └────────┬────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
              ▼                  ▼                  ▼
    ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
    │ EditModeActor   │ │ VirtualList     │ │ ChatProvider    │
    │ .setMode()      │ │ Actor           │ │ (extension)     │
    │ publishes       │ │ .setEditMode()  │ │ delegates to    │
    │ 'edit.mode'     │ │ (per-turn rows) │ │ DiffManager     │
    └─────────────────┘ └─────────────────┘ │ .setEditMode()  │
                                            └─────────────────┘
```

## Diff Lifecycle

### Phase 1: Detection

```
┌─────────────────────────────────────────────────────────────────┐
│                      File Change Detection                       │
└─────────────────────────────────────────────────────────────────┘

                    API Response
                         │
            ┌────────────┴────────────┐
            │                         │
            ▼                         ▼
    ┌───────────────┐        ┌───────────────┐
    │  Native Tool  │        │ Shell Command │
    │  write_file   │        │ (Reasoner)    │
    └───────┬───────┘        └───────┬───────┘
            │                        │
            ▼                        ▼
    ┌───────────────┐        ┌───────────────┐
    │ Extract:      │        │ Detect file   │
    │ • path        │        │ modifications │
    │ • content     │        │ from output   │
    └───────┬───────┘        └───────┬───────┘
            │                        │
            └────────────┬───────────┘
                         │
                         ▼
                ┌───────────────────┐
                │ showDiff(code,    │
                │          language)│
                └───────────────────┘
```

### Phase 2: Diff Creation

```typescript
// DiffManager.showDiff() — the diff-creation entry point.
// `code` is the raw edit body, prefixed with a "# File: <path>" header;
// `language` is the syntax hint for the diff editor.
async showDiff(code: string, language: string): Promise<void> {
  // Resolve the target file from the "# File:" header (absolute or
  // workspace-relative), creating it on disk if it doesn't exist yet.
  const targetPath = /* resolved from header or active editor */;

  // Per-file iteration counter (used in the diffId and the tab title).
  const iteration = (this.fileEditCounts.get(targetPath) || 0) + 1;
  this.fileEditCounts.set(targetPath, iteration);
  const diffId = `${targetPath}-${Date.now()}-${iteration}`;

  // Compute the proposed content by applying the search/replace blocks
  // to the file's current text, then expose both sides via a virtual
  // `deepseek-diff:` content provider for VS Code's diff editor.
  const originalContent = document.getText();
  const proposedContent = this.diffEngine.applyChanges(originalContent, cleanCode).content;

  const metadata: DiffMetadata = {
    proposedUri, originalUri, targetFilePath: targetPath,
    code, language, timestamp: Date.now(), iteration, diffId,
    superseded: false, action: isCreate ? 'created' : 'modified'
  };

  // Keyed by the proposed URI string, NOT by diffId.
  this.activeDiffs.set(proposedUri.toString(), metadata);
  this.notifyDiffListChanged();
}
```

> Note: there is no `status` field on `DiffMetadata` — pending vs.
> applied/rejected is tracked separately (see Diff Storage below). The
> original content is never stored on the metadata; it is recomputed live
> from disk whenever a diff is shown or accepted.

### Phase 3: Mode-Specific Handling

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Mode-Specific Flow                                    │
└─────────────────────────────────────────────────────────────────────────────┘

                         Diff Created
                              │
                              ▼
                    ┌─────────────────┐
                    │ Check editMode  │
                    └────────┬────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
    ┌─────────┐        ┌─────────┐        ┌─────────┐
    │ MANUAL  │        │   ASK   │        │  AUTO   │
    └────┬────┘        └────┬────┘        └────┬────┘
         │                  │                  │
         ▼                  ▼                  ▼
    ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
    │ Store diff  │   │ Open diff + │   │ Apply now   │
    │ status:     │   │ register    │   │ + record    │
    │ 'pending'   │   │ approval    │   │ resolved    │
    └──────┬──────┘   └──────┬──────┘   └──────┬──────┘
           │                 │                 │
           ▼                 │                 │
    ┌─────────────┐          │                 │
    │ Notify      │          │                 │
    │ webview:    │     ┌────┴────┐            │
    │ diffList    │     │         │            │
    │ Changed     │    Yes        No           │
    └──────┬──────┘     │         │            │
           │            ▼         ▼            │
           │      ┌─────────┐ ┌─────────┐      │
           │      │ Apply   │ │ Reject  │      │
           │      │ diff    │ │ diff    │      │
           │      └────┬────┘ └────┬────┘      │
           │           │           │           │
           └───────────┴─────┬─────┴───────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │ notifyDiff      │
                    │ Resolved()      │
                    └─────────────────┘
```

### Phase 4: User Decision (Manual Mode)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      User Decision Flow (Manual)                             │
└─────────────────────────────────────────────────────────────────────────────┘

    Webview: MessageTurnActor (per-turn pending rows)
    ┌─────────────────────────────────────────────────────────────┐
    │  📁 Pending Changes (2)                                     │
    │  ┌─────────────────────────────────────────────────────────┐│
    │  │  src/utils/helper.ts              [Accept] [Reject]     ││
    │  │  Status: pending • Iteration #3                         ││
    │  ├─────────────────────────────────────────────────────────┤│
    │  │  src/index.ts (superseded)        (no buttons)          ││
    │  │  data-superseded="true" • Iteration #1 (dimmed row)     ││
    │  └─────────────────────────────────────────────────────────┘│
    └─────────────────────────────────────────────────────────────┘
                             │
              User clicks    │
              [Accept]       │
                             ▼
    ┌─────────────────────────────────────────────────────────────┐
    │  vscode.postMessage({                                       │
    │    type: 'acceptSpecificDiff',                              │
    │    diffId: 'src/utils/helper.ts-1700000000000-3',           │
    │    filePath: 'src/utils/helper.ts'                          │
    │  })                                                         │
    └─────────────────────────────────────────────────────────────┘
                             │
                             ▼
    ┌─────────────────────────────────────────────────────────────┐
    │  Extension: ChatProvider → DiffManager                      │
    │                                                             │
    │  case 'acceptSpecificDiff':                                 │
    │    await this.diffManager.acceptSpecificDiff(msg.diffId);   │
    │    break;                                                   │
    └─────────────────────────────────────────────────────────────┘
                             │
                             ▼
    ┌─────────────────────────────────────────────────────────────┐
    │  DiffManager.acceptSpecificDiff(diffId)                     │
    │  1. Find metadata in activeDiffs by diffId (scan)           │
    │  2. Re-apply blocks vs current text (DiffEngine)            │
    │  3. Full-range WorkspaceEdit + document.save()              │
    │  4. Remove from activeDiffs, push to resolvedDiffs[]        │
    │  5. notifyDiffResolved() → webview (returns outcome)        │
    └─────────────────────────────────────────────────────────────┘
```

## Diff Storage

### In-Memory Structure

```typescript
// DiffManager maintains active (pending) diffs, keyed by proposed URI string.
private activeDiffs: Map<string, DiffMetadata> = new Map();

// src/providers/types.ts
interface DiffMetadata {
  proposedUri: vscode.Uri;     // Virtual URI for the proposed-content side
  originalUri: vscode.Uri;     // Virtual URI for the original-content side
  targetFilePath: string;      // Path of the file being edited
  code: string;                // Raw edit body (with "# File:" header)
  language: string;            // Syntax hint for the diff editor
  timestamp: number;           // When diff was created
  iteration: number;           // Per-file edit count
  diffId: string;              // `${targetFilePath}-${timestamp}-${iteration}`
  superseded?: boolean;        // Newer diff exists for same file
  action?: 'created' | 'modified' | 'deleted';
}
```

There is no `status` field on the metadata. `activeDiffs` only ever holds
**pending** entries; once a diff is accepted or rejected it is removed from the
map (and pushed onto `resolvedDiffs[]`). Status is communicated to the webview
through a separate message path (see State Synchronization below).

### State Synchronization

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Diff State Sync                                       │
└─────────────────────────────────────────────────────────────────────────────┘

    Extension (DiffManager)                     Webview (Actors)
    ═══════════════════════                     ════════════════

    activeDiffs Map                             MessageTurnActor rows
    ┌──────────────────┐                        ┌──────────────────┐
    │ diff-001:        │                        │ pending rows:    │
    │   path: a.ts     │    postMessage:        │   { id: diff-001 │
    │   status: pending│    diffListChanged     │     path: a.ts   │
    │ diff-002:        │ ─────────────────────▶ │     status:pend }│
    │   path: b.ts     │    { diffs: [...] }    │   { id: diff-002 │
    │   status: pending│                        │     path: b.ts   │
    └──────────────────┘                        │     status:pend }│
                                                │ ]                │
                                                └──────────────────┘

    On any change to the PENDING set:
    - DiffManager fires _onDiffListChanged (diffs all have status 'pending')
    - ChatProvider subscribes → postMessage('diffListChanged')
    - VirtualMessageGatewayActor reconciles the turn's pending rows

    On accept / reject (status becomes 'applied' / 'rejected'):
    - The diff is removed from activeDiffs and pushed to resolvedDiffs[]
    - DiffManager fires _onAutoAppliedFilesChanged via notifyDiffResolved()
      (auto-applied files also flow through this event)
    - This is a SEPARATE message path — diffListChanged never carries a
      non-pending status, and activeDiffs never holds an applied entry
```

## Superseding Logic

When the AI modifies the same file multiple times:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Superseding Flow                                      │
└─────────────────────────────────────────────────────────────────────────────┘

    Iteration 1: AI creates diff for src/index.ts
                              │
                              ▼
                    ┌─────────────────┐
                    │ diff-001        │
                    │ src/index.ts    │
                    │ status: pending │
                    │ superseded: NO  │
                    └─────────────────┘

    Iteration 3: AI creates another diff for src/index.ts
                              │
                              ▼
                    ┌─────────────────┐
                    │ Check existing  │
                    │ pending diffs   │
                    │ for same path   │
                    └────────┬────────┘
                             │
                             │ Found diff-001
                             ▼
                    ┌─────────────────┐
                    │ Mark diff-001   │
                    │ superseded:true │
                    └─────────────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │ Create diff-002 │
                    │ src/index.ts    │
                    │ status: pending │
                    │ superseded: NO  │
                    │ iteration: 3    │
                    └─────────────────┘

    Result in UI:
    ┌─────────────────────────────────────────────────────┐
    │  src/index.ts                    [Accept] [Reject]  │
    │  Status: pending • Iteration #3                     │
    ├─────────────────────────────────────────────────────┤
    │  src/index.ts (superseded)       (no buttons)       │
    │  Iteration #1 • data-superseded="true" (dimmed)     │
    └─────────────────────────────────────────────────────┘
```

## VS Code Integration

### Diff Editor

When user clicks on a pending file:

```typescript
// DiffManager: Re-open VS Code's diff editor for an existing diff.
async focusSpecificDiff(diffId: string): Promise<void> {
  // Linear scan over activeDiffs (keyed by URI, not diffId).
  const metadata = Array.from(this.activeDiffs.values())
    .find(m => m.diffId === diffId);
  if (!metadata) return;

  // The original/proposed virtual URIs (scheme `deepseek-diff:`) were
  // created and registered when the diff was first shown, so we just
  // reuse them here — no new content provider is registered.
  const iterationLabel = metadata.iteration > 1 ? ` (${metadata.iteration})` : '';
  await vscode.commands.executeCommand('vscode.diff',
    metadata.originalUri,
    metadata.proposedUri,
    `${metadata.targetFilePath}${iterationLabel} ↔ With Changes`
  );
}
```

### Workspace Edit Application

```typescript
// DiffManager.acceptSpecificDiff()
async acceptSpecificDiff(diffId: string): Promise<DiffResolutionOutcome | null> {
  // Find the pending metadata by diffId (linear scan).
  const metadata = Array.from(this.activeDiffs.values())
    .find(m => m.diffId === diffId);
  if (!metadata) return null;

  // Superseded diffs can't be accepted — a newer edit replaced them.
  if (metadata.superseded) {
    this._onWarning.fire({ message: 'This version has been superseded by a newer edit.' });
    return null;
  }

  // Resolve the file URI (absolute → workspace-relative → create), then
  // re-apply the search/replace blocks against the file's CURRENT content
  // (there is no stored `newContent` — it is recomputed live).
  const document = await vscode.workspace.openTextDocument(fileUri);
  const currentContent = document.getText();
  const cleanCode = metadata.code.replace(/^#\s*File:.*\n/i, '');
  const result = this.diffEngine.applyChanges(currentContent, cleanCode);

  // Single full-range replace, then save.
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(
    document.positionAt(0),
    document.positionAt(currentContent.length)
  );
  edit.replace(fileUri, fullRange, result.content);
  await vscode.workspace.applyEdit(edit);
  await document.save();

  // Record the outcome and remove the diff from the active map.
  // Status is pushed to the webview via notifyDiffResolved (NOT a
  // `status='applied'` entry on diffListChanged).
  this.resolvedDiffs.push({ /* filePath, status: 'applied', diffId, ... */ });
  await this.closeSingleDiff(metadata);
  this.notifyDiffResolved(metadata.targetFilePath, metadata.diffId, 'applied',
    metadata.iteration, metadata.action);

  return { filePath: metadata.targetFilePath, status: 'applied' };
}
```

## Webview UI Components

Pending changes are **not** a standalone shadow-DOM panel. They are rendered
per conversation turn inside `MessageTurnActor` (the actor that owns one
assistant turn), and they are driven by the `diffListChanged` / `pendingFileUpdate`
messages handled in `VirtualMessageGatewayActor`. The edit mode itself lives in
`EditModeActor` (which extends `EventStateActor`).

### Pending rows in MessageTurnActor

```
DOM Structure (inside a turn's container):
┌─────────────────────────────────────────────────────────────────────────────┐
│ <div class="pending-changes">                                               │
│   ├── header: "Pending Changes"  (or "Modified Files" in auto mode)         │
│   │                                                                         │
│   └── <div class="pending-item" data-status="pending" data-action="..">     │
│         ├── <span class="pending-file" data-file-path="index.ts">…</span>   │
│         ├── <button class="pending-btn accept-btn"                          │
│         │           data-file-id="…" data-diff-id="…">Accept</button>       │
│         └── <button class="pending-btn reject-btn"                          │
│                     data-file-id="…" data-diff-id="…">Reject</button>       │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Message handling

```typescript
// VirtualMessageGatewayActor routes diff messages from the extension:
//   case 'pendingFileUpdate':  → update a single pending row's status
//   case 'diffListChanged':    → reconcile the turn's pending rows with the
//                                latest set of pending diffs (status='pending')
//
// MessageTurnActor wires the Accept/Reject buttons via event delegation; on
// click it invokes the host's onPendingFileAction(action, fileId, diffId, filePath)
// callback, which posts { type: 'acceptSpecificDiff', diffId, filePath } (or
// 'rejectSpecificDiff') back to the extension.

// EditModeActor (media/actors/edit-mode/EditModeActor.ts) — extends EventStateActor
class EditModeActor extends EventStateActor {
  private _mode: EditMode = 'manual';
  // publications: { 'edit.mode': () => this._mode }
  // subscriptions: { 'edit.mode.set': (m) => this.handleModeSet(m) }

  setMode(mode: EditMode): void { /* validate, store, publish 'edit.mode' */ }
  getMode(): EditMode { return this._mode; }
}
```

## Message Flow Summary

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Complete Diff Message Flow                               │
└─────────────────────────────────────────────────────────────────────────────┘

    Extension                                      Webview
    ═════════                                      ═══════

    1. AI calls write_file (via RequestOrchestrator)
           │
           ▼
    2. DiffManager.showDiff()
           │ fires _onDiffListChanged event
           ▼
    3. ChatProvider subscribes → postMessage ─────▶ 4. diffListChanged
       { type: 'diffListChanged',                      │
         diffs: [...],                                 ▼
         editMode: 'manual',                     5. VirtualMessageGateway
         source: 'diff-status' }                    Actor reconciles the
                                                    turn's pending rows
                                                       │
                                                       ▼
                                                 6. UI renders pending file
                                                       │
                                                       │ User clicks Accept
                                                       ▼
    8. DiffManager.acceptSpecificDiff() ◀────────── 7. postMessage
           │                                        { type: 'acceptSpecificDiff',
           ▼                                          diffId: '...' }
    9. WorkspaceEdit
           │
           ▼
   10. File written to disk
           │
           ▼
   11. Remove from activeDiffs,
       push to resolvedDiffs[]
           │
           ▼
   12. DiffManager.notifyDiffResolved()
       fires _onAutoAppliedFilesChanged
       ChatProvider → postMessage ─────────────────▶ 13. UI updates
       { type: 'diffListChanged',                        status to 'applied'
         source: 'diff-engine',
         diffs: [{...status:'applied'}] }

   Note: the PENDING list (_onDiffListChanged, source: 'diff-status')
   only ever carries status 'pending'; resolved status arrives on this
   separate _onAutoAppliedFilesChanged path (same 'diffListChanged'
   message type, different `source`).
```

## Configuration

### Settings

```json
{
  "moby.editMode": {
    "type": "string",
    "enum": ["manual", "ask", "auto"],
    "default": "manual",
    "description": "How to handle code edits from AI responses"
  }
}
```

### Runtime Mode Switching

```typescript
// ToolbarShadowActor cycles through modes
handleEditModeClick() {
  // Native-tool models (V3 chat, V4 family, native-tool customs) can't use
  // Manual mode — exclude it from the cycle for them.
  const supportsManual = this._supportsManualByModel.get(this._currentModel) ?? true;
  const availableModes = supportsManual
    ? EDIT_MODES
    : EDIT_MODES.filter(m => m !== 'manual');

  const currentIndex = availableModes.indexOf(this._editMode);
  const nextIndex = (currentIndex + 1) % availableModes.length;
  const newMode = availableModes[nextIndex];
  this._editMode = newMode;

  // Notify subscribers + extension
  this._onEditModeChange?.(newMode);
  this._vscode?.postMessage({ type: 'setEditMode', mode: newMode });
  this.publish({ 'toolbar.editMode': newMode });
}
```

## Edge Cases

### Concurrent Modifications

```
Scenario: User edits file while diff is pending

    User editing src/index.ts in VS Code
    ┌───────────────────────────┐
    │ function foo() {          │
    │   // user's changes       │ ◀─── User is here
    │ }                         │
    └───────────────────────────┘

    Meanwhile, AI created diff for same file
    ┌───────────────────────────┐
    │ diff-001: src/index.ts    │
    │ (pending, code stored as  │
    │  SEARCH/REPLACE blocks)   │
    └───────────────────────────┘

    User clicks Accept:
    ┌───────────────────────────┐
    │ Re-apply blocks against   │
    │ the file's CURRENT text   │
    │ (last-writer-wins; no     │
    │  merge editor, no prompt) │
    │                           │
    │ Only guard: DiffEngine    │
    │ refuses if SEARCH-to-file │
    │ similarity < 0.75 (stale) │
    └───────────────────────────┘
```

There is no conflict-detection dialog or merge editor in the accept path:
`acceptSpecificDiff` recomputes the result via `DiffEngine.applyChanges`
against the file's current content and does a single full-range replace. The
protection lives in `DiffEngine.applySearchReplace`: if the SEARCH content's
similarity to the file drops below `0.75`, the block is marked stale and refused
with a "re-read the file" message; and even above that threshold, a block whose
SEARCH cannot be matched by the strict strategies is refused (`success: false`,
file unchanged) rather than force-applied to an approximate location.

### Session Boundaries

```
When user starts new chat:
1. Clear all pending diffs
2. Reset file edit counts
3. Reset resolved diffs list

When user switches session:
1. Keep pending diffs (they're file-level, not session-level)
2. OR clear and warn user about uncommitted changes
```

## Debugging

```javascript
// Browser console — the registry exposes editMode, gateway, virtualList, etc.
// (there is no window.actors.pending)
window.actors.editMode.getMode()
// → 'manual'

window.actors.virtualList   // owns the per-turn MessageTurnActors (pending rows)

// Extension debug console (DiffManager) — field is `activeDiffs` (no leading
// underscore); DiffMetadata has no `.status`, and the path is `.targetFilePath`.
this.activeDiffs.forEach((v, k) => console.log(k, v.superseded, v.targetFilePath))
```
