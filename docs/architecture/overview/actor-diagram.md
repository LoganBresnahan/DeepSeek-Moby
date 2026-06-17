# Actor System Diagram

Visual map of all actors and their relationships in the Unified Turn Architecture.

---

## Page Layout with Actors

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                    HEADER                                        │
│  ┌──────┐ ┌───────────────────────────────────────────────────────────────────┐│
│  │ Moby │ │                       header-actions                              ││
│  │ Icon │ │ ┌────────┐ ┌───────┐ ┌───────┐ ┌─────────┐ ┌────────┐ ┌──────┐    ││
│  │(stat)│ │ │Drawing │ │ Model │ │History│ │Inspector│ │Commands│ │ Gear │    ││
│  └──────┘ │ │  Pad   │ │ btn   │ │  btn  │ │btn (dev)│ │  btn   │ │ btn  │    ││
│           │ └───┬────┘ └───┬───┘ └───┬───┘ └────┬────┘ └───┬────┘ └──┬───┘    ││
│           └─────┼──────────┼─────────┼──────────┼──────────┼─────────┼────────┘│
│                 │          │         │          │          │         │          │
│                 ▼          ▼         ▼          ▼          ▼         ▼          │
│           ┌─────────┐ ┌─────────┐ ┌───────┐ ┌─────────┐ ┌────────┐ ┌─────────┐ │
│           │Drawing  │ │ModelSel │ │History│ │Inspector│ │Commands│ │Settings │ │
│           │Server✅ │ │ector ✅ │ │Sh. ✅ │ │Shadow ✅│ │Sh.  ✅ │ │Shadow ✅│ │
│           └─────────┘ └─────────┘ └───────┘ └─────────┘ └────────┘ └─────────┘ │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │ #currentModelName ← Updated by HeaderActor (subscribes to session.model)   │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                              CHAT MESSAGES AREA                                  │
│                              (#chatMessages)                                     │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │ VirtualListActor ✅                                                        │ │
│  │ - Manages pool of MessageTurnActors                                        │ │
│  │ - Virtual rendering for large conversations                                │ │
│  │ - Source of truth for turn data                                            │ │
│  │                                                                            │ │
│  │   ┌──────────────────────────────────────────────────────────────────────┐│ │
│  │   │ MessageTurnActor (pooled) ✅                                         ││ │
│  │   │ - User/Assistant messages                                            ││ │
│  │   │ - Text segments with code blocks (copy/diff/apply)                   ││ │
│  │   │ - Thinking iterations (collapsible)                                  ││ │
│  │   │ - Tool call batches with status                                      ││ │
│  │   │ - Shell command output                                               ││ │
│  │   │ - Pending file changes (accept/reject)                               ││ │
│  │   └──────────────────────────────────────────────────────────────────────┘│ │
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
│  │ - publishes: streaming.active, streaming.messageId                         │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                           BOTTOM INPUT AREA                                      │
│                                                                                  │
│  ┌────────────────────────────────────────────────────────────────────────────┐ │
│  │ ToolbarShadowActor ✅                                                      │ │
│  │ - Edit mode buttons (Manual/Ask/Auto)                                      │ │
│  │ - Files button → triggers FilesShadowActor                                │ │
│  │ - Web search button → triggers WebSearchPopupShadowActor                  │ │
│  │ - Plans button → triggers PlanPopupShadowActor                            │ │
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
│  │ - Activity text + messages                                                 │ │
│  │ - Warnings + Logs button                                                   │ │
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
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Actor Status Summary

### ✅ Active Actors

| Actor | Type | Location | Purpose |
|-------|------|----------|---------|
| VirtualMessageGatewayActor | Gateway | Hidden | External message routing to VirtualListActor |
| VirtualListActor | Virtual Rendering | chatMessages | Pool management, turn data source of truth |
| MessageTurnActor | Pooled UI | chatMessages | Renders all turn content (text, thinking, tools, shell, pending) |
| SessionActor | State-only | Hidden | Session state (model, title, id) |
| EditModeActor | State-only | Hidden | Edit mode state (manual/ask/auto) |
| StreamingActor | State-only | Hidden | Streaming state management |
| ScrollActor | State-only | chatMessages | Auto-scroll behavior |
| HeaderActor | Light DOM | Header | Updates #currentModelName |
| InputAreaShadowActor | Shadow | inputAreaContainer | Text input |
| StatusPanelShadowActor | Shadow | statusPanelContainer | Status display |
| ToolbarShadowActor | Shadow | toolbarContainer | Action buttons |
| InspectorShadowActor | Shadow | inspectorHost | UI inspection (dev) |
| HistoryShadowActor | Modal | historyHost | History modal |
| FilesShadowActor | Modal | filesHost | File picker modal |
| CommandsShadowActor | Popup | commandsHost | Commands dropdown |
| ModelSelectorShadowActor | Popup | modelHost | Model/settings popup |
| SettingsShadowActor | Popup | settingsHost | Settings dropdown |
| DrawingServerShadowActor | Popup | drawingServerActorHost | Drawing server start/stop + QR |
| PlanPopupShadowActor | Popup | planPopupHost | Plan file management |
| WebSearchPopupShadowActor | Popup | webSearchPopupHost | Web search settings |
| CommandRulesModalActor | Modal | rulesHost | Command approval rules |
| StatsModalActor | Modal | statsHost | Account usage stats |
| SystemPromptModalActor | Modal | systemPromptHost | System prompt editor |

---

## Pub/Sub Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              EXTENSION (VS Code)                                 │
│                                                                                  │
│   chatProvider.ts sends ~60 message types:                                       │
│     - Session: sessionCreated, sessionLoaded, modelChanged                       │
│     - Streaming: startResponse, streamToken, streamReasoning, endResponse        │
│     - Tools: shellExecuting, shellResults, toolCallsStart, toolCallsEnd          │
│     - Files: diffListChanged, showEditConfirm, openFiles, searchResults          │
│     - Settings: settings, editModeSettings, webSearchToggled                     │
│     - History: loadHistory, historySessions, clearChat                           │
│     - Status: error, warning, statusMessage, generationStopped                   │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       │ postMessage()
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    VirtualMessageGatewayActor (BOUNDARY)                         │
│                                                                                  │
│   The Gateway Pattern / Anti-Corruption Layer                                    │
│   See ARCHITECTURE/message-gateway.md for full documentation                     │
│                                                                                  │
│   Responsibilities:                                                              │
│   1. Receive ALL external messages from VS Code extension                        │
│   2. Route to VirtualListActor using turn-based API                              │
│   3. Translate external protocol → internal actor calls                          │
│                                                                                  │
│   Coordination State:                                                            │
│   - _currentTurnId: Active turn being streamed                                   │
│   - _phase: 'idle' | 'streaming' | 'waiting-for-results'                         │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       │ Turn-based API calls
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                            VirtualListActor                                      │
│                                                                                  │
│   Pool Management:                                                               │
│   - Pre-warms pool of MessageTurnActors                                          │
│   - Binds actors to visible turns                                                │
│   - Releases actors when turns scroll out of view                                │
│                                                                                  │
│   Turn Data (Source of Truth):                                                   │
│   - Map<turnId, TurnData> stores all conversation content                        │
│   - Actors are just views - can be detached and reattached                       │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
          ┌────────────────────────────┼────────────────────────────┐
          │                            │                            │
    Pub/sub                    Direct method calls           Actor delegation
    (state)                    (turn operations)             (content updates)
          │                            │                            │
          ▼                            ▼                            ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           INTERNAL ACTOR SYSTEM                                  │
│                                                                                  │
│   State Actors (no DOM):                                                         │
│   - SessionActor ──────► publishes session.model, session.title, session.id     │
│   - StreamingActor ────► publishes streaming.active, streaming.messageId        │
│   - EditModeActor ─────► publishes edit.mode                                    │
│   - ScrollActor ───────► manages scroll position                                │
│                                                                                  │
│   UI Actors (own DOM):                                                           │
│   - MessageTurnActor ─────► all turn content (text, thinking, tools, etc.)      │
│   - InputAreaShadowActor ─► text input, send/stop buttons                       │
│   - StatusPanelShadowActor ► status display                                     │
│   - ToolbarShadowActor ───► edit mode, files, web search                        │
│   - HistoryShadowActor ───► history modal                                       │
│   - FilesShadowActor ─────► file picker modal                                   │
│   - ModelSelectorShadowActor ► model/settings popup                             │
│   - SettingsShadowActor ──► settings dropdown                                   │
│                                                                                  │
│   Subscribers to session.model:                                                  │
│   - HeaderActor ──────► updates #currentModelName                                │
│                                                                                  │
│   Subscribers to streaming.active:                                               │
│   - InputAreaShadowActor ─► shows send/stop button                              │
│   - ToolbarShadowActor ───► updates UI state                                    │
│   - VirtualListActor ─────► manages streaming turn                              │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## File Locations

```
media/actors/
├── command-rules/     CommandRulesModalActor   ✅ USED (command approval rules)
├── commands/          CommandsShadowActor      ✅ USED
├── drawing-server/    DrawingServerShadowActor ✅ USED (server start/stop + QR)
├── edit-mode/         EditModeActor            ✅ USED (edit mode state)
├── files/             FilesShadowActor         ✅ USED
├── header/            HeaderActor              ✅ USED (updates model name)
├── history/           HistoryShadowActor       ✅ USED
├── input-area/        InputAreaShadowActor     ✅ USED
├── message-gateway/   VirtualMessageGatewayActor ✅ USED (external boundary)
├── model-selector/    ModelSelectorShadowActor ✅ USED
├── plans/             PlanPopupShadowActor     ✅ USED (plan file management)
├── scroll/            ScrollActor              ✅ USED
├── session/           SessionActor             ✅ USED (session state pub/sub)
├── settings/          SettingsShadowActor      ✅ USED
├── stats/             StatsModalActor          ✅ USED (account usage stats)
├── status-panel/      StatusPanelShadowActor   ✅ USED
├── streaming/         StreamingActor           ✅ USED
├── system-prompt/     SystemPromptModalActor   ✅ USED (system prompt editor)
├── toolbar/           ToolbarShadowActor       ✅ USED
├── turn/              MessageTurnActor         ✅ USED (unified turn rendering)
├── virtual-list/      VirtualListActor         ✅ USED (pool + virtual rendering)
└── web-search/        WebSearchPopupShadowActor ✅ USED (web search settings)

media/dev/
└── inspector/         InspectorShadowActor     ✅ USED (dev only)
```

---

## Related Documentation

- [actor-system.md](../frontend/actor-system.md) - Unified Turn Architecture details
- [message-gateway.md](../frontend/message-gateway.md) - Gateway pattern and coordination
- [getter-pattern.md](../reference/getter-pattern.md) - When to use getters vs publications
- [state-keys.md](../reference/state-keys.md) - All pub/sub state keys
