# Actor System Diagram

Visual map of all actors, their relationships, and identified gaps.

---

## Page Layout with Actors

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                    HEADER                                        │
│  ┌─────────┐ ┌─────────────────────────────────────────────────────────────────┐│
│  │ Moby    │ │                      header-actions                             ││
│  │ Icon    │ │  ┌──────────────┐ ┌─────────┐ ┌───────────┐ ┌────────┐ ┌──────┐││
│  │ (static)│ │  │ Model Button │ │ History │ │ Inspector │ │Commands│ │ Gear │││
│  └─────────┘ │  │ + popup      │ │  btn    │ │   btn     │ │  btn   │ │ btn  │││
│              │  └──────┬───────┘ └────┬────┘ └─────┬─────┘ └───┬────┘ └──┬───┘││
│              └─────────┼──────────────┼───────────┼────────────┼─────────┼────┘│
│                        │              │           │            │         │      │
│                        ▼              ▼           ▼            ▼         ▼      │
│              ┌─────────────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐│
│              │ModelSelector    │ │History  │ │Inspector│ │Commands │ │Settings ││
│              │ShadowActor  ✅  │ │Shadow   │ │Shadow   │ │Shadow   │ │Shadow   ││
│              │                 │ │Actor ✅ │ │Actor ✅ │ │Actor ✅ │ │Actor ✅ ││
│              └─────────────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘│
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │ #currentModelName ← Updated by HeaderActor (subscribes to session)   │ │
│  │ #toastContainer (static div) ← No actor                                    │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                              CHAT MESSAGES AREA                                  │
│                              (#chatMessages)                                     │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │ MessageShadowActor ✅                                                      │ │
│  │ - User messages                                                            │ │
│  │ - Assistant messages (with CodeBlockShadowActor ✅ for code)              │ │
│  │ - Edit mode indicators                                                     │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │ ThinkingShadowActor ✅  (interleaved)                                      │ │
│  │ - Reasoning content dropdowns                                              │ │
│  │ - Collapsed by default                                                     │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │ ShellShadowActor ✅  (interleaved)                                         │ │
│  │ - Shell command output                                                     │ │
│  │ - Command grouping                                                         │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │ ToolCallsShadowActor ✅  (interleaved)                                     │ │
│  │ - Tool call badges                                                         │ │
│  │ - Status indicators                                                        │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │ PendingChangesShadowActor ✅  (interleaved)                                │ │
│  │ - File change previews                                                     │ │
│  │ - Accept/reject controls                                                   │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │ ScrollActor ✅  (state-only, no DOM)                                       │ │
│  │ - Auto-scroll behavior                                                     │ │
│  │ - Scroll position tracking                                                 │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │ StreamingActor ✅  (state-only, hidden root)                               │ │
│  │ - Streaming state management                                               │ │
│  │ - publishes: streaming.active, streaming.content                           │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                           BOTTOM INPUT AREA                                      │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │ ToolbarShadowActor ✅                                                      │ │
│  │ - Edit mode buttons (Manual/Ask/Auto)                                      │ │
│  │ - Files button → triggers FilesShadowActor                                │ │
│  │ - Web search toggle                                                        │ │
│  │ - Pending changes controls                                                 │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │ InputAreaShadowActor ✅                                                    │ │
│  │ - Text input                                                               │ │
│  │ - File attachment chips                                                    │ │
│  │ - Send/Stop buttons                                                        │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │ StatusPanelShadowActor ✅                                                  │ │
│  │ - Moby icon                                                                │ │
│  │ - Status text                                                              │ │
│  │ - Token count display (future)                                             │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                              MODALS (OVERLAY)                                    │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │ FilesShadowActor ✅                                                        │ │
│  │ - File picker modal                                                        │ │
│  │ - Search, tabs, selection                                                  │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │ DiffShadowActor ✅ (created by PendingChangesShadowActor)                  │ │
│  │ - Diff view for file changes                                               │ │
│  │ - Accept/reject per-file                                                   │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Actor Status Summary

### ✅ USED (Instantiated in chat.ts)

| Actor | Type | Location | Purpose |
|-------|------|----------|---------|
| MessageGatewayActor | Gateway | Hidden | External message routing, coordination state |
| SessionActor | State-only | Hidden | Session state (model, title, id) |
| EditModeActor | State-only | Hidden | Edit mode state (manual/ask/auto) |
| StreamingActor | State-only | Hidden | Streaming state management |
| ScrollActor | State-only | chatMessages | Auto-scroll behavior |
| HeaderActor | Light DOM | Header | Updates #currentModelName |
| MessageShadowActor | Interleaved | chatMessages | User/assistant messages |
| ShellShadowActor | Interleaved | chatMessages | Shell command output |
| ToolCallsShadowActor | Interleaved | chatMessages | Tool call badges |
| ThinkingShadowActor | Interleaved | chatMessages | Reasoning dropdowns |
| PendingChangesShadowActor | Interleaved | chatMessages | File change previews |
| InputAreaShadowActor | Shadow | inputAreaContainer | Text input |
| StatusPanelShadowActor | Shadow | statusPanelContainer | Status display |
| ToolbarShadowActor | Shadow | toolbarContainer | Action buttons |
| InspectorShadowActor | Shadow | inspectorHost | UI inspection (dev) |
| HistoryShadowActor | Modal | historyHost | History modal |
| FilesShadowActor | Modal | filesHost | File picker modal |
| CommandsShadowActor | Popup | commandsHost | Commands dropdown |
| ModelSelectorShadowActor | Popup | modelHost | Model/settings popup |
| SettingsShadowActor | Popup | settingsHost | Settings dropdown |
| CodeBlockShadowActor | Embedded | Inside messages | Code syntax highlighting |
| DiffShadowActor | Embedded | Inside pending | Diff view |

### ✅ RECENTLY INTEGRATED

| Actor | Type | Status | Notes |
|-------|------|--------|-------|
| MessageGatewayActor | Gateway | ✅ INTEGRATED | Boundary between extension and actor system. Routes ALL external messages. See [message-gateway.md](message-gateway.md) |
| SessionActor | State | ✅ INTEGRATED | Publishes session.* state. Handlers called by gateway. |
| HeaderActor | Light DOM | ✅ INTEGRATED | Minimal version - subscribes to session.model, updates #currentModelName |
| EditModeActor | State | ✅ INTEGRATED | Manages edit mode state (manual/ask/auto) |

### ❌ DELETED (No longer exists)

| Actor | Type | Why Deleted | Notes |
|-------|------|-------------|-------|
| SidebarShadowActor | Shadow | Different UI layout | Deleted - sidebar not in current design |

---

## Identified Gaps

### ✅ GAP 1: Session State Not Published - FIXED

**Problem:** Session state (model, title, id) not available via pub/sub.

**Solution:** SessionActor now:
- Handles `sessionLoaded`, `sessionCreated`, `modelChanged` messages from extension
- Publishes `session.model`, `session.title`, `session.id`, `session.loading`, `session.error`
- Extension updated to send these messages in `chatProvider.ts`

---

### ✅ GAP 2: Model Name Display Never Updates - FIXED

**Problem:** `#currentModelName` span was static HTML.

**Solution:** HeaderActor (minimal version) now:
- Subscribes to `session.model`
- Updates `#currentModelName` element when model changes
- Uses light DOM (finds existing elements) rather than Shadow DOM

```
Current Flow:
Extension ─► sessionCreated/modelChanged ─► SessionActor
                                                │
                                                ▼ publishes session.model
                                           HeaderActor
                                                │
                                                ▼ updates
                                           #currentModelName
```

---

### GAP 3: Session Title Not Displayed (OPTIONAL - LOW PRIORITY)

**Problem:** No session title shown in UI.

**Status:** Low priority - current design doesn't include visible session titles.

**If needed:** HeaderActor already subscribes to `session.title` and could display it.

---

### GAP 4: Toast Container Not Actor-Managed

**Problem:** `#toastContainer` is static HTML with no actor.

```
Current:
┌────────────────────────────────────────┐
│ <div id="toastContainer">              │ ← just exists
│   (manually populated by chat.ts?)     │
│ </div>                                 │
└────────────────────────────────────────┘
```

**Question:** Is toast functionality used? If so, should be actor.

---

### GAP 5: Header Buttons Have Scattered Handlers

**Problem:** Each header button has its own addEventListener in chat.ts.

```
chat.ts:
  inspectorBtn.addEventListener('click', ...)
  historyBtn.addEventListener('click', ...)
  commandsBtn.addEventListener('click', ...)
  settingsBtn.addEventListener('click', ...)
  modelBtn.addEventListener('click', ...)
```

**Not necessarily a problem** - buttons trigger their respective popup actors.
But if we had a HeaderActor, it could own these handlers.

---

## Pub/Sub Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              EXTENSION (VS Code)                                 │
│                                                                                  │
│   chatProvider.ts sends ~40 message types:                                       │
│     - Session: sessionCreated, sessionLoaded, modelChanged                       │
│     - Streaming: startResponse, streamToken, streamReasoning, endResponse        │
│     - Tools: shellExecuting, shellResults, toolCallsStart, toolCallsEnd          │
│     - Files: diffListChanged, pendingFileAdd, openFiles, searchResults           │
│     - Settings: settings, editModeSettings, webSearchToggled                     │
│     - History: loadHistory, historySessions, clearChat                           │
│     - Status: error, warning, statusMessage, generationStopped                   │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       │ postMessage()
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        MessageGatewayActor (BOUNDARY)                            │
│                                                                                  │
│   The Gateway Pattern / Anti-Corruption Layer                                    │
│   See ARCHITECTURE/message-gateway.md for full documentation                     │
│                                                                                  │
│   Responsibilities:                                                              │
│   1. Receive ALL external messages from VS Code extension                        │
│   2. Maintain coordination state (segmentContent, hasInterleaved, phase)         │
│   3. Orchestrate internal actors with ORDERING GUARANTEES                        │
│   4. Translate external protocol → internal actor calls                          │
│                                                                                  │
│   Coordination State:                                                            │
│   - _segmentContent: Accumulated content during streaming                        │
│   - _hasInterleaved: Whether tools/thinking interrupted text flow                │
│   - _shellSegmentId: Pending shell operation tracking                            │
│   - _phase: 'idle' | 'streaming' | 'waiting-for-results'                         │
│                                                                                  │
│   Publications (for debugging/observability):                                    │
│   - gateway.segmentContent, gateway.interleaved, gateway.phase                   │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
          ┌────────────────────────────┼────────────────────────────┐
          │                            │                            │
    Direct calls              Pub/sub (broadcast)            Getters
    (ordering)                 (state changes)              (queries)
          │                            │                            │
          ▼                            ▼                            ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           INTERNAL ACTOR SYSTEM                                  │
│                                                                                  │
│   State Actors (no DOM):                                                         │
│   - SessionActor ──────► publishes session.model, session.title, session.id     │
│   - StreamingActor ────► publishes streaming.active, streaming.content          │
│   - EditModeActor ─────► publishes edit.mode                                    │
│   - ScrollActor ───────► manages scroll position                                │
│                                                                                  │
│   UI Actors (own DOM):                                                           │
│   - MessageShadowActor ─────► user/assistant messages                           │
│   - ShellShadowActor ───────► shell command output                              │
│   - ToolCallsShadowActor ───► tool call badges                                  │
│   - ThinkingShadowActor ────► reasoning dropdowns                               │
│   - PendingChangesShadowActor ► file change previews                            │
│   - InputAreaShadowActor ───► text input, send/stop buttons                     │
│   - StatusPanelShadowActor ─► status display                                    │
│   - ToolbarShadowActor ─────► edit mode, files, web search                      │
│   - HistoryShadowActor ─────► history modal                                     │
│   - FilesShadowActor ───────► file picker modal                                 │
│   - ModelSelectorShadowActor ► model/settings popup                             │
│   - SettingsShadowActor ────► settings dropdown                                 │
│                                                                                  │
│   Subscribers to session.model:                                                  │
│   - HeaderActor ──────► updates #currentModelName                         │
│                                                                                  │
│   Subscribers to streaming.active:                                               │
│   - InputAreaShadowActor ───► shows send/stop button                            │
│   - ToolbarShadowActor ─────► updates UI state                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Recommended Changes

### ✅ Priority 1: Fix Model Name Bug - COMPLETED
HeaderActor (minimal version) now subscribes to `session.model` and updates `#currentModelName`.

### ✅ Priority 2: Implement SessionActor - COMPLETED
- SessionActor instantiated in chat.ts
- Handles `sessionLoaded`, `sessionCreated`, `modelChanged` messages
- Publishes `session.model`, `session.title`, `session.id`, `session.loading`, `session.error`
- Extension updated to send these messages in `chatProvider.ts`

### ✅ Priority 3: HeaderActor - COMPLETED (Option B)
Chose **Option B: Minimal HeaderActor**
- Subscribes to `session.model` and `session.title`
- Updates existing DOM elements (light DOM, not Shadow DOM)
- Does NOT duplicate functionality of other popup actors

### ✅ Priority 4: Remove Dead Code - COMPLETED
- SidebarShadowActor deleted (different UI design, never used)

---

## File Locations

```
media/actors/
├── codeblock/         CodeBlockShadowActor     ✅ USED (embedded in messages)
├── commands/          CommandsShadowActor      ✅ USED
├── diff/              DiffShadowActor          ✅ USED (embedded in pending)
├── edit-mode/         EditModeActor            ✅ USED (edit mode state)
├── files/             FilesShadowActor         ✅ USED
├── header/            HeaderActor        ✅ USED (minimal, updates model name)
├── history/           HistoryShadowActor       ✅ USED
├── input-area/        InputAreaShadowActor     ✅ USED
├── message/           MessageShadowActor       ✅ USED
├── message-gateway/   MessageGatewayActor      ✅ USED (external boundary)
├── model-selector/    ModelSelectorShadowActor ✅ USED
├── pending/           PendingChangesShadowActor ✅ USED
├── scroll/            ScrollActor              ✅ USED
├── session/           SessionActor             ✅ USED (session state pub/sub)
├── settings/          SettingsShadowActor      ✅ USED
├── shell/             ShellShadowActor         ✅ USED
├── sidebar/           (DELETED)
├── status-panel/      StatusPanelShadowActor   ✅ USED
├── streaming/         StreamingActor           ✅ USED
├── thinking/          ThinkingShadowActor      ✅ USED
├── toolbar/           ToolbarShadowActor       ✅ USED
└── tools/             ToolCallsShadowActor     ✅ USED

media/dev/
└── inspector/         InspectorShadowActor     ✅ USED (dev only)
```

---

## Related Documentation

- [message-gateway.md](message-gateway.md) - Gateway pattern and coordination state
- [getter-pattern.md](getter-pattern.md) - When to use getters vs publications
