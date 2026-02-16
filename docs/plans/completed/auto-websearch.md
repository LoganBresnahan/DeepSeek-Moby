# LLM-Decided Web Search (Auto Web Search)

**Status:** Complete

**Depends on:** Phase 1 WebSearchManager extraction (complete), Phase 1b slider redesign (complete), ChatProvider refactor (complete)

---

## Context

Currently web search is manual: the user toggles it on and every message gets searched via Tavily. The goal is to let the LLM decide when a web search is needed, like Claude Code does.

## Key Findings

### Existing Infrastructure

1. **Tool calling loop already exists** — `runToolLoop()` in `requestOrchestrator.ts:840` runs for the chat model with 5 workspace tools (read_file, search_files, grep_content, list_directory, get_file_info). It's a pre-streaming exploration phase.

2. **`webSearchTool` already defined but unused** — `src/tools/workspaceTools.ts:125` exports a complete tool definition for `web_search` with query parameter. It was anticipated but never wired up.

3. **Reasoner uses `<shell>` tags** — R1 can't use tool calling API. Instead it outputs `<shell>` tags detected by an iteration loop that executes commands and feeds results back.

### DeepSeek API Capabilities

| Feature | deepseek-chat (V3) | deepseek-reasoner (R1) |
|---------|-------------------|----------------------|
| Function calling | Yes (OpenAI-compatible) | No |
| Streaming + tools | Yes | N/A |
| Max tools | 128 | N/A |
| tool_choice | auto/none/required/specific | N/A |

- R1 explicitly does **not** support function calling (documented as "Not Supported Feature")
- V3 sometimes outputs tool calls in DSML markup format instead of standard JSON (code already handles this fallback)
- V3 is "not great at multi-turn function calling" per Fireworks AI — best when single user message triggers calls

## Design

### Two Integration Paths

**Chat model (V3)**: Add `web_search` to the existing tools array in `runToolLoop()`. The LLM decides when to call it. Results flow back as standard `role: 'tool'` messages. Near-zero new infrastructure.

**Reasoner model (R1)**: Add `<web_search>query</web_search>` as a recognized tag alongside `<shell>`. The existing shell iteration loop already handles: detect tags → execute → feed results back → continue. Same pattern, new tag type.

### New Method: `WebSearchManager.searchByQuery(query)`

Unlike `searchForMessage()` (manual toggle, parallel calls, full message as query):
- Bypasses the enabled toggle (only needs Tavily API key configured)
- Makes a single API call per invocation (LLM can call multiple times)
- Uses shared searchDepth, maxResultsPerSearch, cacheDuration settings
- Uses shared cache with `tool|` prefix in cache key
- Returns error strings on failure (so LLM can adapt)

### Coexistence with Manual Toggle

| Mechanism | When | Controlled by | Result destination |
|-----------|------|---------------|-------------------|
| Manual toggle | Before tool loop | User toggle | System prompt injection |
| Tool-triggered (chat) | During `runToolLoop()` | LLM decides | Tool result message |
| Tag-triggered (reasoner) | During shell iteration loop | LLM decides | User message (like shell results) |

No conflict — different methods, shared cache prevents duplicate API calls.

## Implementation Plan

### Files to Change

| File | Change |
|------|--------|
| `src/providers/webSearchManager.ts` | Add `searchByQuery()` method (~35 lines) |
| `src/providers/requestOrchestrator.ts` | Import `webSearchTool`; add to tools array; intercept in tool loop; update system prompt; add web search detection in reasoner loop |
| `src/tools/workspaceTools.ts` | No changes (tool definition already exists at line 125) |
| `src/tools/reasonerShellExecutor.ts` | Add `parseWebSearchCommands`, `containsWebSearchCommands`, `stripWebSearchTags`; update `getReasonerShellPrompt()` |
| `src/utils/ContentTransformBuffer.ts` | Extend `SegmentType` to include `'web_search'` |
| `tests/unit/providers/webSearchManager.test.ts` | Add `searchByQuery` tests |
| `tests/unit/tools/reasonerShellExecutor.test.ts` | Add web search tag parsing tests |

### Chat Model Changes

1. Import `webSearchTool` from workspaceTools (already exported)
2. Conditionally add to tools array when Tavily is configured:
   ```typescript
   const tools = [
     ...workspaceTools,
     applyCodeEditTool,
     ...(this.webSearchManager.getSettings().configured ? [webSearchTool] : [])
   ];
   ```
3. Intercept `web_search` tool calls before `executeToolCall()` — route to `webSearchManager.searchByQuery()`
4. Add `web_search` to system prompt tool list when configured
5. Add UI detail string: `search web: "query"`

### Reasoner Model Changes

1. Add parsing functions: `parseWebSearchCommands()`, `containsWebSearchCommands()`, `stripWebSearchTags()`
2. Update `getReasonerShellPrompt()` with `<web_search>` tag instructions
3. In shell iteration loop, detect `<web_search>` tags alongside `<shell>` tags
4. Execute searches via `webSearchManager.searchByQuery()`
5. Reuse shell UI (shellExecuting/shellResults messages) to display web search in the chat
6. Strip `<web_search>` tags from final response

### Key Design Decisions

1. **Single API call per tool invocation** — LLM calls the tool multiple times if it wants more, rather than using creditsPerPrompt parallel blast
2. **Reuse shell UI for reasoner** — web search queries display in the same expandable shell panel, zero webview changes
3. **Error strings not empty strings** — `searchByQuery()` returns `"Error: ..."` on failure so LLM knows it failed
4. **Shared cache + settings** — tool-triggered and manual searches share Tavily settings and cache

## Post-Implementation Additions

These were added after the core implementation:

1. **Tracing** — Added `tracer.trace()` calls to `searchByQuery()` (4 events: notConfigured, cacheHit, complete, error) and R1 web search path in requestOrchestrator (2 events: detected, complete)
2. **R1 token budget** — Added `accumulatedIterationTokens` tracking with 60k token safety cap for injected shell/web search results. Breaks iteration loop and fires warning when exceeded.
3. **Manual search visual indicators** — Wired `webSearching`, `webSearchComplete`, `webSearchCached` messages in VirtualMessageGatewayActor to StatusPanelShadowActor.showMessage(). `webSearchError` was already handled via `warning` message type.
4. **R1 prompt flexibility** — Updated continuation prompts to allow R1 to answer questions without forcing code edits. Added "if the task is a question, provide a clear answer" as a valid exit path in system prompt, continuation user message, and continuation system prompt.

## Web Search Mode Toggle (Off / Manual / Auto)

### Context

With auto web search implemented, the LLM always searches when it thinks it's needed (assuming Tavily API key is configured). Users need a way to completely disable web search or restrict it to manual-only, without removing their API key.

### Design

A persistent `deepseek.webSearchMode` setting with three values:

| Mode | Manual Toggle | LLM Auto-Search | Prompts Mention Web Search |
|------|:------------:|:---------------:|:--------------------------:|
| **off** | Disabled | No | No |
| **manual** | Available | No | No |
| **auto** | Available | Yes | Yes |

**Mode (`webSearchMode`)** is a persistent VS Code setting — survives restarts.
**Manual toggle (`enabled`)** is session-level state — controlled by Enable/Disable in the popup.

### Gating Logic

Current gating uses `tavilyConfigured` (API key exists) as the sole gate for auto search. This changes to `mode === 'auto' && configured`:

| Gate Point | Current | New |
|------------|---------|-----|
| V3 system prompt web_search line | `tavilyAvailable` | `mode === 'auto' && configured` |
| V3 tool loop webSearchTool inclusion | `tavilyConfigured` | `mode === 'auto' && configured` |
| R1 system prompt web_search section | `tavilyConfiguredForPrompt` | `mode === 'auto' && configured` |
| R1 iteration loop web_search tag detection | Always (for reasoner) | `mode === 'auto'` |
| `searchForMessage()` (manual) | `this.enabled && configured` | `mode !== 'off' && this.enabled && configured` |
| `searchByQuery()` (LLM-triggered) | `configured` | `mode === 'auto' && configured` |

### UI Changes

The toolbar popup replaces Enable/Disable with a three-way mode selector at the top:
- **Off** — dim/default button
- **Manual** — green button (like edit mode Q)
- **Auto** — blue button (like edit mode A)

Below the mode selector, the existing Enable/Disable buttons remain for the manual toggle (disabled when mode is `off`). All sliders and settings remain but are disabled when mode is `off`.

The search toolbar button shows color state:
- Off: default dim
- Manual + disabled: default
- Manual + enabled: green (existing `.active` class)
- Auto: blue glow

### Files to Change

| File | Change |
|------|--------|
| `package.json` | Add `deepseek.webSearchMode` setting (enum: off/manual/auto, default: auto) |
| `src/providers/types.ts` | Add `WebSearchMode` type, add to `SettingsSnapshot.webSearch` |
| `src/providers/webSearchManager.ts` | Add mode state, `setMode()`, `getMode()`, gate `searchByQuery()` |
| `src/providers/settingsManager.ts` | Read `webSearchMode` from config, include in snapshot |
| `src/providers/chatProvider.ts` | Handle `setWebSearchMode` message |
| `src/providers/requestOrchestrator.ts` | Gate auto search on mode at all 4 points |
| `media/actors/toolbar/ToolbarShadowActor.ts` | Add mode selector to popup, update button states |
| `media/actors/toolbar/shadowStyles.ts` | Add mode color states for search button |
| `media/actors/message-gateway/VirtualMessageGatewayActor.ts` | Handle `webSearchModeChanged` message |
| Tests | Update WebSearchManager, RequestOrchestrator tests |

## Verification

1. `npx vitest run` — all tests pass
2. Chat model: "What are the latest TypeScript features?" → LLM calls `web_search` in tool loop
3. Chat model: "Fix the bug in main.ts" → LLM does NOT call `web_search`
4. Reasoner: "What's new in React 19?" → R1 outputs `<web_search>` tag, results fed back
5. Both: manual toggle still works independently
6. Output channel shows `[WebSearch] Tool-triggered search:` log entries
