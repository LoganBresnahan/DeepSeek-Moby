# LLM-Decided Web Search (Auto Web Search)

**Status:** Research complete, implementation deferred (after ChatProvider refactor)

**Depends on:** Phase 1 WebSearchManager extraction (complete), Phase 1b slider redesign (complete)

---

## Context

Currently web search is manual: the user toggles it on and every message gets searched via Tavily. The goal is to let the LLM decide when a web search is needed, like Claude Code does.

## Key Findings

### Existing Infrastructure

1. **Tool calling loop already exists** — `runToolLoop()` in `chatProvider.ts:2175` runs for the chat model with 5 workspace tools (read_file, search_files, grep_content, list_directory, get_file_info). It's a pre-streaming exploration phase.

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
| `src/providers/chatProvider.ts` | Import `webSearchTool`; add to tools array; intercept in tool loop; update system prompt; add web search detection in reasoner loop |
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

## Known Gaps

- **No web search progress indicator in UI**: `webSearching` and `webSearchComplete` messages are forwarded from ChatProvider to the webview via `postMessage`, but the webview gateway (`VirtualMessageGatewayActor`) has no handlers for them — they appear as `Unhandled message type` in logs. Could wire these up later to show a "Searching..." spinner in the chat UI.

## Verification

1. `npx vitest run` — all tests pass
2. Chat model: "What are the latest TypeScript features?" → LLM calls `web_search` in tool loop
3. Chat model: "Fix the bug in main.ts" → LLM does NOT call `web_search`
4. Reasoner: "What's new in React 19?" → R1 outputs `<web_search>` tag, results fed back
5. Both: manual toggle still works independently
6. Output channel shows `[WebSearch] Tool-triggered search:` log entries
