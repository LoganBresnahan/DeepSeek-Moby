# Dead Code Cleanup Analysis

## Executive Summary

The codebase evolved through three phases:
1. **Initial Actor Refactor** (`bade773`) - Created non-shadow DOM actors including CodeBlockActor and DiffActor
2. **Shadow DOM Migration** (`6bc6d57`) - Created Shadow DOM versions of all actors, including CodeBlockShadowActor and DiffShadowActor
3. **1B Virtual Rendering** (uncommitted) - Created MessageTurnActor + VirtualListActor, superseding legacy interleaved actors

The `USE_VIRTUAL_RENDERING = true` flag (line 51 of `chat.ts`) makes the legacy code path unreachable.

---

## Category 1: Never Integrated Actors (Completely Dead)

### 1.1 CodeBlockShadowActor

| Property | Value |
|----------|-------|
| **Files** | `media/actors/codeblock/CodeBlockShadowActor.ts`, `shadowStyles.ts` |
| **Created** | Commit `6bc6d57` - "full actor and shadow dom setup" |
| **Lines** | ~580 lines |
| **Tests** | `tests/actors/codeblock/CodeBlockShadowActor.test.ts` (~329 lines) |

**Why it exists:**

The original design envisioned code blocks as separate shadow DOM containers, each with its own:
- Collapse/expand state
- Copy/Diff/Apply buttons
- Syntax highlighting
- Active diff tracking

This would have given each code block complete style isolation and independent lifecycle.

**Why it was never used:**

Code block rendering was implemented **inline within message formatting** instead:
- `MessageShadowActor.formatContent()` (lines 595-636) uses regex to transform ` ```code``` ` into HTML
- Code blocks are just `<div class="code-block">` elements inside message containers
- The inline approach was simpler - no need to manage separate actors for each block
- Click handlers are delegated at the message container level

**Counterpart:** Inline implementation in `MessageShadowActor.formatContent()` and `MessageTurnActor`'s text rendering methods.

**Evidence of non-use:**
```bash
$ grep -r "CodeBlockShadowActor" media/ --include="*.ts" | grep -v "index.ts" | grep -v ".test."
# Returns only the file itself - never instantiated
```

**Safe to remove:** Yes - completely unused, including tests

---

### 1.2 DiffShadowActor

| Property | Value |
|----------|-------|
| **Files** | `media/actors/diff/DiffShadowActor.ts`, `shadowStyles.ts` |
| **Created** | Commit `6bc6d57` - "full actor and shadow dom setup" |
| **Lines** | ~430 lines |
| **Tests** | `tests/actors/diff/DiffShadowActor.test.ts` (~327 lines) |

**Why it exists:**

The original design planned for a webview-based diff viewer:
- User clicks "Diff" on a code block
- Webview shows unified diff with +/- lines
- Apply/Reject buttons in the diff view
- Stats showing lines added/removed

**Why it was never used:**

The extension uses **VS Code's native diff editor** instead:
- `chatProvider.ts` calls `vscode.commands.executeCommand('vscode.diff', originalUri, modifiedUri)`
- Native diff is familiar to users, integrates with VS Code's theming
- No need to duplicate diff rendering in webview

The `showDiff` message from `MessageShadowActor` posts to VS Code, which opens the native diff:
```typescript
// In MessageShadowActor.setupCodeBlockHandlersForContainer()
this.postVSCodeMessage({
  type: 'showDiff',
  code,
  language: lang
});
```

**Counterpart:** VS Code native diff API via `chatProvider.ts`

**Evidence of non-use:**
```bash
$ grep -r "DiffShadowActor" media/ --include="*.ts" | grep -v "index.ts" | grep -v ".test."
# Returns only the file itself - never instantiated
```

**Safe to remove:** Yes - completely unused, including tests

---

### 1.3 InterleavedContentActor

| Property | Value |
|----------|-------|
| **File** | `media/state/InterleavedContentActor.ts` |
| **Created** | Commit `bade773` - initial actor refactor |
| **Lines** | ~265 lines |

**Why it exists:**

First attempt at a base class for actors that create dynamic containers inline with content. Predates shadow DOM.

Key methods:
- `createContainer()` - Creates div elements and tracks them
- `getContainer()` / `removeContainer()` - Container management
- `injectStyles()` - CSS injection (document-level, not shadow)

**Why it was never used:**

Superseded by `InterleavedShadowActor` which:
- Extends shadow DOM encapsulation from `ShadowActor`
- Creates shadow-isolated containers instead of plain divs
- Uses `adoptedStyleSheets` for efficient style sharing

The shadow version became the actual base class for MessageShadowActor, ThinkingShadowActor, etc.

**Counterpart:** `InterleavedShadowActor` in `media/state/InterleavedShadowActor.ts`

**Evidence of non-use:**
```bash
$ grep -r "InterleavedContentActor" media/ --include="*.ts" | grep -v "state/index.ts"
# Returns only the file itself and the export - never extended
```

**Safe to remove:** Yes - never extended by any actor

---

## Category 2: Legacy Mode Actors (Dead due to Feature Flag)

These actors are only instantiated when `USE_VIRTUAL_RENDERING = false` (line 51 of chat.ts). Since the flag is `true`, they are unreachable at runtime.

### 2.1 MessageShadowActor (Legacy)

| Property | Value |
|----------|-------|
| **Files** | `media/actors/message/MessageShadowActor.ts`, `shadowStyles.ts` |
| **Created** | Commit `6bc6d57` |
| **Lines** | ~685 lines |
| **Tests** | `tests/actors/message/MessageShadowActor.test.ts` |

**Why it exists:**

Renders user and assistant messages with:
- Shadow DOM isolation per message segment
- Streaming content updates
- Interleaving support (text → thinking → tools → text)
- Inline code block rendering with copy/diff/apply

**Why it's dead (but kept):**

Superseded by `MessageTurnActor` which consolidates ALL content types (text, thinking, tools, shell, pending) into a single poolable actor.

| MessageShadowActor | MessageTurnActor |
|-------------------|------------------|
| One container per text segment | Multiple container types per turn |
| Separate actors for thinking/tools/shell | All content in one actor |
| Cannot be pooled | Designed for pooling |
| Creates sibling elements in DOM | Creates containers within host element |

**Counterpart:** `MessageTurnActor` text segment methods:
- `createTextSegment()` replaces lazy container creation
- `updateTextContent()` replaces `updateCurrentSegmentContent()`
- `finalizeTextSegment()` replaces `finalizeCurrentSegment()`
- `resumeWithNewSegment()` replaces same-named method

**Evidence of conditional use:**
```typescript
// chat.ts lines 199-224 (inside `if (!USE_VIRTUAL_RENDERING)`)
const message = new MessageShadowActor(manager, chatMessages);
```

**Safe to remove:** Only if legacy mode is fully deprecated

---

### 2.2 ThinkingShadowActor (Legacy)

| Property | Value |
|----------|-------|
| **Files** | `media/actors/thinking/ThinkingShadowActor.ts`, `shadowStyles.ts` |
| **Created** | Commit `6bc6d57` |
| **Lines** | ~350 lines |

**Why it exists:**

Renders chain-of-thought thinking iterations as:
- Collapsible dropdowns with "Thinking..." header
- Progressive streaming content
- Iteration numbering and expansion state

**Why it's dead:**

Thinking is now rendered by `MessageTurnActor`:
- `startThinkingIteration()` creates thinking container within turn
- `updateThinking()` streams content
- `completeThinking()` marks iteration complete
- Styles copied to `media/actors/turn/styles/thinkingStyles.ts`

**Counterpart:** `MessageTurnActor` thinking methods (lines ~300-450)

**Evidence of conditional use:**
```typescript
// chat.ts line 209 (inside `if (!USE_VIRTUAL_RENDERING)`)
const thinking = new ThinkingShadowActor(manager, chatMessages);
```

---

### 2.3 ToolCallsShadowActor (Legacy)

| Property | Value |
|----------|-------|
| **Files** | `media/actors/tools/ToolCallsShadowActor.ts`, `shadowStyles.ts` |
| **Created** | Commit `6bc6d57` |
| **Lines** | ~400 lines |

**Why it exists:**

Renders tool call batches as:
- "Used X tools" collapsible dropdown
- Individual tool cards with name, detail, status
- Status transitions: pending → running → done/error

**Why it's dead:**

Tool calls are now rendered by `MessageTurnActor`:
- `startToolBatch()` creates tool batch container
- `addToolCall()` adds individual calls
- `updateToolStatus()` updates status with visual feedback
- Styles copied to `media/actors/turn/styles/toolStyles.ts`

**Counterpart:** `MessageTurnActor` tool methods (lines ~450-600)

---

### 2.4 ShellShadowActor (Legacy)

| Property | Value |
|----------|-------|
| **Files** | `media/actors/shell/ShellShadowActor.ts`, `shadowStyles.ts` |
| **Created** | Commit `6bc6d57` |
| **Lines** | ~380 lines |

**Why it exists:**

Renders shell command executions as:
- Collapsible dropdown with command preview
- Output display with success/error styling
- Multiple commands per segment

**Why it's dead:**

Shell rendering is now in `MessageTurnActor`:
- `createShellSegment()` creates shell container
- `setShellResults()` populates output
- Styles in `media/actors/turn/styles/shellStyles.ts`

**Counterpart:** `MessageTurnActor` shell methods (lines ~600-750)

---

### 2.5 PendingChangesShadowActor (Legacy)

| Property | Value |
|----------|-------|
| **Files** | `media/actors/pending/PendingChangesShadowActor.ts`, `shadowStyles.ts` |
| **Created** | Commit `6bc6d57` |
| **Lines** | ~450 lines |

**Why it exists:**

Renders "Modified Files" dropdown with:
- File list with status (pending/applied/rejected)
- Accept/Reject buttons in manual/ask mode
- "Auto Applied" label in auto mode
- Iteration tracking for superseded files

**Why it's dead:**

Pending files are now rendered by `MessageTurnActor`:
- `addPendingFile()` adds file to pending container
- `updatePendingStatus()` updates status
- Styles in `media/actors/turn/styles/pendingStyles.ts`

**Counterpart:** `MessageTurnActor` pending methods (lines ~750-900)

---

### 2.6 MessageGatewayActor (Legacy)

| Property | Value |
|----------|-------|
| **File** | `media/actors/message-gateway/MessageGatewayActor.ts` |
| **Created** | Commit `8475ff7` - "Gateway Refactor" |
| **Lines** | ~795 lines |

**Why it exists:**

The "anti-corruption layer" between VS Code extension and internal actors:
- Routes incoming messages to appropriate actors
- Maintains coordination state (segment content, interleaving)
- Orchestrates multi-step operations (streaming sessions)

**Why it's dead:**

Superseded by `VirtualMessageGatewayActor` which:
- Routes to `VirtualListActor` instead of individual actors
- Uses turn-based API instead of actor-per-content-type
- Simpler coordination (VirtualListActor manages turn state)

| MessageGatewayActor | VirtualMessageGatewayActor |
|--------------------|-----------------------------|
| References 5 content actors | References 1 VirtualListActor |
| Complex coordination state | Turn-based state in VirtualListActor |
| Per-actor method calls | Turn-scoped API calls |

**Counterpart:** `VirtualMessageGatewayActor` in same directory

---

## Category 3: Experimental UI Framework (Unused)

### 3.1 UIActor Base Class

| Property | Value |
|----------|-------|
| **Files** | `media/ui/UIActor.ts`, `render.ts`, `types.ts`, `builders.ts`, `index.ts` |
| **Lines** | ~800 lines total |

**Why it exists:**

Experimental declarative UI framework:
```typescript
class MyActor extends UIActor {
  getView(): UINode {
    return ui.dropdown(
      ui.header('My Component'),
      ui.list(this.state.items.map(i => ui.text(i)))
    );
  }
}
```

Inspired by React's component model but simpler. Framework would diff and patch DOM.

**Why it was never used:**

The direct imperative approach (InterleavedShadowActor with innerHTML) was:
- More straightforward for streaming updates
- No virtual DOM overhead
- Easier to debug

The only implementation is `ExampleToolsActor` in `media/ui/examples/` which is itself never instantiated.

**Counterpart:** None - different paradigm, never adopted

**Safe to remove:** Keep for reference or move to branch

---

## Cleanup Phases

### Phase 1: Safe Immediate Removal

Delete completely dead code with zero runtime risk:

| Action | Files | Lines |
|--------|-------|-------|
| Delete | `media/actors/codeblock/` | ~700 |
| Delete | `media/actors/diff/` | ~650 |
| Delete | `media/state/InterleavedContentActor.ts` | ~265 |
| Delete | `tests/actors/codeblock/` | ~329 |
| Delete | `tests/actors/diff/` | ~327 |
| Update | `media/actors/index.ts` | Remove exports |
| Update | `media/state/index.ts` | Remove export |

**Total: ~2,270 lines**

### Phase 2: Legacy Mode Removal (After Testing)

Remove `USE_VIRTUAL_RENDERING` flag and all legacy code:

| Action | Files | Lines |
|--------|-------|-------|
| Delete | `media/actors/message/` | ~920 |
| Delete | `media/actors/thinking/` | ~460 |
| Delete | `media/actors/tools/` | ~550 |
| Delete | `media/actors/shell/` | ~550 |
| Delete | `media/actors/pending/` | ~680 |
| Delete | `MessageGatewayActor.ts` | ~795 |
| Modify | `chat.ts` | Remove ~200 lines of legacy branches |
| Update | `media/actors/index.ts` | Remove legacy exports |
| Delete | Related test files | ~2,000+ |

**Total: ~6,000+ lines**

### Phase 3: UI Framework Removal (Optional)

| Action | Files | Lines |
|--------|-------|-------|
| Delete | `media/ui/` | ~800 |

---

## Verification Checklist

After each phase:

1. **Build:** `npm run build:media`
2. **Tests:** `npx vitest run`
3. **Runtime testing:**
   - [ ] User messages display correctly
   - [ ] Assistant streaming works
   - [ ] Thinking iterations collapse/expand
   - [ ] Tool calls show status progression
   - [ ] Shell output displays
   - [ ] Modified Files works in all edit modes
   - [ ] Code blocks have copy/diff/apply buttons
