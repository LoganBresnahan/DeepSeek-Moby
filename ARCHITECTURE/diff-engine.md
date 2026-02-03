# Diff Engine & Edit Modes

This document details the file modification system, including edit modes, diff creation, storage, and the pending changes workflow.

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
    │     │ User    │                        │
    │     │ prompt  │                        │
    │     │ Accept? │                        │
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
│   ASK    │  • Shows VS Code dialog: "Apply changes to X?"                  │
│    Q     │  • User responds Yes/No in dialog                               │
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
    │ PendingChanges  │ │ MessageShadow   │ │ ChatProvider    │
    │ ShadowActor     │ │ Actor           │ │ (extension)     │
    │ subscribes      │ │ subscribes      │ │ receives via    │
    └─────────────────┘ └─────────────────┘ │ postMessage     │
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
                │ createDiff(path,  │
                │            content)│
                └───────────────────┘
```

### Phase 2: Diff Creation

```typescript
// ChatProvider.createDiff()
async createDiff(filePath: string, newContent: string): Promise<DiffMetadata> {
  const diffId = `diff-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Read original content (if file exists)
  let originalContent = '';
  try {
    const uri = vscode.Uri.joinPath(this.workspaceRoot, filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    originalContent = doc.getText();
  } catch {
    // New file - no original content
  }

  const metadata: DiffMetadata = {
    diffId,
    filePath,
    originalContent,
    newContent,
    status: 'pending',
    timestamp: Date.now(),
    iteration: this.currentIteration
  };

  this.activeDiffs.set(diffId, metadata);
  return metadata;
}
```

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
    │ Store diff  │   │ Store diff  │   │ Apply now   │
    │ status:     │   │ Show dialog:│   │ status:     │
    │ 'pending'   │   │ "Apply X?"  │   │ 'applied'   │
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
                    │ notifyDiffList  │
                    │ Changed()       │
                    └─────────────────┘
```

### Phase 4: User Decision (Manual Mode)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      User Decision Flow (Manual)                             │
└─────────────────────────────────────────────────────────────────────────────┘

    Webview: PendingChangesShadowActor
    ┌─────────────────────────────────────────────────────────────┐
    │  📁 Pending Changes (2)                                     │
    │  ┌─────────────────────────────────────────────────────────┐│
    │  │  src/utils/helper.ts              [Accept] [Reject]     ││
    │  │  Status: pending • Iteration #3                         ││
    │  ├─────────────────────────────────────────────────────────┤│
    │  │  src/index.ts (superseded)        [View] [Dismiss]      ││
    │  │  Status: pending • Iteration #1 • Newer version exists  ││
    │  └─────────────────────────────────────────────────────────┘│
    └─────────────────────────────────────────────────────────────┘
                             │
              User clicks    │
              [Accept]       │
                             ▼
    ┌─────────────────────────────────────────────────────────────┐
    │  vscode.postMessage({                                       │
    │    type: 'acceptSpecificDiff',                              │
    │    diffId: 'diff-1234...'                                   │
    │  })                                                         │
    └─────────────────────────────────────────────────────────────┘
                             │
                             ▼
    ┌─────────────────────────────────────────────────────────────┐
    │  Extension: ChatProvider                                    │
    │                                                             │
    │  case 'acceptSpecificDiff':                                 │
    │    await this.applyDiff(msg.diffId);                        │
    │    break;                                                   │
    └─────────────────────────────────────────────────────────────┘
                             │
                             ▼
    ┌─────────────────────────────────────────────────────────────┐
    │  applyDiff(diffId)                                          │
    │  1. Get diff metadata from activeDiffs                      │
    │  2. Create WorkspaceEdit                                    │
    │  3. Apply edit to file                                      │
    │  4. Update status to 'applied'                              │
    │  5. Notify webview                                          │
    └─────────────────────────────────────────────────────────────┘
```

## Diff Storage

### In-Memory Structure

```typescript
// ChatProvider maintains active diffs
private activeDiffs: Map<string, DiffMetadata> = new Map();

interface DiffMetadata {
  diffId: string;           // Unique identifier
  filePath: string;         // Relative path in workspace
  originalContent: string;  // Content before change
  newContent: string;       // Proposed new content
  status: 'pending' | 'applied' | 'rejected';
  timestamp: number;        // When diff was created
  iteration?: number;       // Tool loop iteration number
  superseded?: boolean;     // Newer diff exists for same file
}
```

### State Synchronization

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Diff State Sync                                       │
└─────────────────────────────────────────────────────────────────────────────┘

    Extension (ChatProvider)                    Webview (Actors)
    ════════════════════════                    ════════════════

    activeDiffs Map                             PendingChangesShadowActor
    ┌──────────────────┐                        ┌──────────────────┐
    │ diff-001:        │                        │ _files: [        │
    │   path: a.ts     │    postMessage:        │   { id: diff-001 │
    │   status: pending│    diffListChanged     │     path: a.ts   │
    │ diff-002:        │ ─────────────────────▶ │     status: ... }│
    │   path: b.ts     │    { diffs: [...] }    │   { id: diff-002 │
    │   status: applied│                        │     path: b.ts   │
    └──────────────────┘                        │     status: ... }│
                                                │ ]                │
                                                └──────────────────┘

    On any change:
    - notifyDiffListChanged() sends full list
    - Webview reconciles with local state
    - UI updates to reflect current state
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
    │  src/index.ts (superseded)       [View] [Dismiss]   │
    │  Status: pending • Iteration #1                     │
    │  ⚠️ A newer version of this file exists            │
    └─────────────────────────────────────────────────────┘
```

## VS Code Integration

### Diff Editor

When user clicks on a pending file:

```typescript
// Open VS Code's diff editor
async focusDiff(diffId: string) {
  const diff = this.activeDiffs.get(diffId);
  if (!diff) return;

  // Create URIs for diff view
  const originalUri = vscode.Uri.parse(`diff-original:${diff.filePath}`);
  const modifiedUri = vscode.Uri.joinPath(this.workspaceRoot, diff.filePath);

  // Register content provider for original content
  this.diffContentProvider.setContent(originalUri, diff.originalContent);

  // Open diff editor
  await vscode.commands.executeCommand('vscode.diff',
    originalUri,
    modifiedUri,
    `${diff.filePath} (Original ↔ Modified)`
  );
}
```

### Workspace Edit Application

```typescript
async applyDiff(diffId: string): Promise<boolean> {
  const diff = this.activeDiffs.get(diffId);
  if (!diff || diff.status !== 'pending') return false;

  const uri = vscode.Uri.joinPath(this.workspaceRoot, diff.filePath);
  const edit = new vscode.WorkspaceEdit();

  try {
    // Check if file exists
    const stat = await vscode.workspace.fs.stat(uri);

    // File exists - replace content
    const doc = await vscode.workspace.openTextDocument(uri);
    const fullRange = new vscode.Range(
      doc.positionAt(0),
      doc.positionAt(doc.getText().length)
    );
    edit.replace(uri, fullRange, diff.newContent);

  } catch {
    // File doesn't exist - create it
    edit.createFile(uri, { overwrite: false });
    edit.insert(uri, new vscode.Position(0, 0), diff.newContent);
  }

  // Apply the edit
  const success = await vscode.workspace.applyEdit(edit);

  if (success) {
    diff.status = 'applied';
    this.notifyDiffListChanged();
  }

  return success;
}
```

## Webview UI Components

### PendingChangesShadowActor

```
DOM Structure:
┌─────────────────────────────────────────────────────────────────────────────┐
│ div[data-actor="pending"]                                                   │
│   └── #shadow-root                                                          │
│         ├── <style>...</style>                                              │
│         └── <div class="pending-changes">                                   │
│               ├── <div class="pending-header">                              │
│               │     ├── <span class="icon">📁</span>                        │
│               │     ├── <span>Pending Changes (2)</span>                    │
│               │     └── <button class="collapse-btn">▼</button>             │
│               │                                                             │
│               └── <div class="pending-list">                                │
│                     ├── <div class="pending-file" data-id="diff-001">       │
│                     │     ├── <span class="file-path">src/index.ts</span>   │
│                     │     ├── <span class="status">pending</span>           │
│                     │     └── <div class="actions">                         │
│                     │           ├── <button class="accept">Accept</button>  │
│                     │           └── <button class="reject">Reject</button>  │
│                     │                                                       │
│                     └── <div class="pending-file superseded">               │
│                           └── ...                                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### State Management

```typescript
class PendingChangesShadowActor extends ShadowActor {
  private _files: PendingFile[] = [];
  private _editMode: 'manual' | 'ask' | 'auto' = 'manual';
  private _collapsed = false;

  // Subscribe to state changes
  protected subscriptionKeys = ['pending.*', 'toolbar.editMode'];

  onStateChange(event: StateChangeEvent) {
    if (event.changedKeys.includes('toolbar.editMode')) {
      this._editMode = event.state['toolbar.editMode'];
      this.updateUI();
    }
  }

  // Called when diffListChanged message received
  updateFiles(diffs: DiffInfo[]) {
    this._files = diffs.map(d => ({
      id: d.diffId,
      path: d.filePath,
      status: d.status,
      iteration: d.iteration,
      superseded: d.superseded
    }));
    this.render();
  }
}
```

## Message Flow Summary

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Complete Diff Message Flow                               │
└─────────────────────────────────────────────────────────────────────────────┘

    Extension                                      Webview
    ═════════                                      ═══════

    1. AI calls write_file
           │
           ▼
    2. createDiff()
           │
           ▼
    3. postMessage ──────────────────────────────▶ 4. diffListChanged
       { type: 'diffListChanged',                      │
         diffs: [...],                                 ▼
         editMode: 'manual' }                    5. PendingChangesShadow
                                                    Actor.updateFiles()
                                                       │
                                                       ▼
                                                 6. UI renders pending file
                                                       │
                                                       │ User clicks Accept
                                                       ▼
    8. applyDiff(diffId) ◀─────────────────────── 7. postMessage
           │                                        { type: 'acceptSpecificDiff',
           ▼                                          diffId: '...' }
    9. WorkspaceEdit
           │
           ▼
   10. File written to disk
           │
           ▼
   11. Update status
           │
           ▼
   12. postMessage ──────────────────────────────▶ 13. UI updates
       { type: 'diffListChanged',                      status to 'applied'
         diffs: [{...status:'applied'}] }
```

## Configuration

### Settings

```json
{
  "deepseek.editMode": {
    "type": "string",
    "enum": ["manual", "ask", "auto"],
    "default": "manual",
    "description": "How to handle AI-suggested file changes"
  }
}
```

### Runtime Mode Switching

```typescript
// ToolbarShadowActor cycles through modes
cycleEditMode() {
  const modes = ['manual', 'ask', 'auto'];
  const currentIndex = modes.indexOf(this._editMode);
  const nextIndex = (currentIndex + 1) % modes.length;
  this._editMode = modes[nextIndex];

  // Publish to actor system
  this.publish({ 'toolbar.editMode': this._editMode });

  // Notify extension
  this.vscode.postMessage({
    type: 'setEditMode',
    mode: this._editMode
  });
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
    │ status: pending           │
    │ newContent: "function..." │
    └───────────────────────────┘

    User clicks Accept:
    ┌───────────────────────────┐
    │ CONFLICT DETECTED         │
    │                           │
    │ Options:                  │
    │ • Overwrite user changes  │
    │ • Open merge editor       │
    │ • Cancel                  │
    └───────────────────────────┘
```

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
// Browser console
window.actors.pending.getFiles()
// → [{ id: 'diff-001', path: 'src/index.ts', status: 'pending', ... }]

window.actors.pending.getEditMode()
// → 'manual'

// Extension debug console
this.activeDiffs.forEach((v, k) => console.log(k, v.status, v.filePath))
```
