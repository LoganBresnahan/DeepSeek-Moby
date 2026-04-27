# Changelog

## [0.1.0] - 2026-04-27 (Pre-Release)

### Models

- DeepSeek V4 — `deepseek-v4-flash-thinking` and `deepseek-v4-pro-thinking` — registered with full capability metadata (1M-token context, 384K-token output cap, native tool calling, inline reasoning, streaming-tool-calls pipeline)
- Default model is now `deepseek-v4-pro-thinking` — most capable native-tool + inline-reasoning + shell-access tier
- Display labels drop the "(Thinking)" qualifier (`DeepSeek V4 Pro` / `DeepSeek V4 Flash`) — V4 always reasons, the distinction was misleading and the non-thinking SKUs 400'd on iter 2 when the API expected `reasoning_content` to be echoed back
- DeepSeek V3 (`deepseek-chat`) and R1 (`deepseek-reasoner`) remain available, flagged as retiring 2026-07-24
- Per-model `reasoningEffort` override (`high` / `max`) via `moby.modelOptions` for V4 entries
- `thinking: { type: 'enabled' }` request param + `reasoning_content` echoing on tool turns for V4 compliance

### Streaming Pipeline (Phase 4.5)

- Single streaming pipeline for the V4 family: content + reasoning + tool_calls deltas surface in parallel, tools dispatch inline as they arrive, no separate non-streaming probe
- Replaces the runToolLoop + streamAndIterate split for any model with `streamingToolCalls: true` — all V4 entries opt in
- V3 chat (`deepseek-chat`) stays on the legacy split. V3 interleaves `delta.content` and `delta.tool_calls` in the same SSE stream, which can render text segments out of order relative to tool dropdowns. V3 retires 2026-07-24, so the fix would land on a sunsetting model — punting in favor of V4
- Reasoning tokens stream live during tool decisions on `-thinking` variants — visible work instead of silent gaps
- Pre-announce on tool-call metadata (id + name) so the user sees `write_file` immediately rather than waiting for argument streaming to complete
- Iteration-boundary tool-batch close mirrors the Modified Files dropdown — back-to-back tool calls collapse into one batch, breaks across iterations split into separate dropdowns
- Per-index tool-call accumulator handles fragmented OpenAI-format streaming deltas correctly

### Custom Models

- `moby.customModels` setting registers any OpenAI-compatible endpoint as a first-class model (Ollama, LM Studio, llama.cpp Server, OpenAI, Groq, Moonshot/Kimi, OpenRouter, etc.)
- Capability flags (`toolCalling`, `reasoningTokens`, `editProtocol`, `shellProtocol`, `streamingToolCalls`, `sendThinkingParam`, `reasoningEffort`, `reasoningEcho`, `promptStyle`) decide which protocols each model supports
- New commands: **Add Custom Model**, **Set Custom Model API Key**, **Clear Custom Model API Key**
- Per-model API keys stored encrypted in VS Code SecretStorage; falls back to global `moby.apiKey` when omitted
- Walkthrough docs at [docs/guides/custom-models.md](docs/guides/custom-models.md) covering Ollama, LM Studio, llama.cpp, OpenAI, Groq, Kimi

### Web Search

- Provider abstraction — `moby.webSearch.provider` toggles between `tavily` (hosted, paid) and `searxng` (self-hosted, free, no API key)
- SearXNG support: `moby.webSearch.searxng.endpoint` for instance URL, `moby.webSearch.searxng.engines` for engine selection (default: google, bing, duckduckgo)
- New **Set SearXNG Endpoint** command for one-shot config
- Tavily configuration unchanged: `moby.tavilySearchDepth`, `moby.tavilySearchesPerPrompt`

### Persistence (ADR 0003)

- Events table is the sole source of truth for session history — blob-based persistence path retired
- Session-agnostic events table + `event_sessions` join table provides M:N mapping with per-session sequencing
- Zero-copy session forking via `INSERT...SELECT` on the join table; fork metadata (`parent_session_id`, `fork_sequence`) carried separately
- Crash-recovery: partial assistant content restores with a distinct `*[Interrupted by shutdown — partial response restored]*` marker on next launch
- Live structural events == hydrated `turnEvents` round-trip pinned by fidelity tests
- Hydration perf: 10K events ~340ms

### R1 Reasoner

- Path-semantics guards (ADR 0004) — prompt rules + absolute-path ground truth in shell tool results, prevents thrash from cwd confusion across `<shell>` heredocs and SEARCH/REPLACE blocks
- `isLongRunningCommand` strips heredoc bodies before pattern matching (ADR 0002) — large heredocs no longer trigger spurious long-running detection
- File Edit Loops budget (`moby.maxFileEditLoops`) for R1 post-edit continuations
- Stop marker unification — extension owns the marker text consistently across user-stop / backend-abort / shutdown paths

### UI

- Stop button discards partial content on user-initiated stop (ADR 0001) — `*[User interrupted]*` marker without partial leakage; backend aborts keep partial content with `*[Generation stopped]*`
- Inline `<shell>` execution with per-command approval gate
- Directory click in Modified Files dropdown reveals in explorer (was erroring)
- Unfenced SEARCH/REPLACE markers no longer leak to chat UI

### Core (carried from earlier 0.1.0 snapshot)

- DeepSeek V3 (Chat) and R1 (Reasoner) model support with per-model settings
- Event-sourced conversation database with SQLCipher encryption (AES-256-CBC)
- WASM tokenizer with per-model vocabulary support
- Platform-specific VSIX packaging (6 targets)
- Three edit modes: Auto (apply immediately), Ask (accept/reject), Manual (VS Code diff tabs)
- SEARCH/REPLACE diff engine with exact, patch, fuzzy, and location-based matching
- Accept/Reject buttons in diff editor toolbar
- File watcher for shell-modified and deleted files
- Auto-continuation when code edits fail to apply (file creation nudge)

### Shell Security

- Three-layer command validation: regex blocklist, approval rules, user prompts
- Per-command approval with persistent allow/block rules
- Command Rules modal for managing rules
- Git Bash detection on Windows for cross-platform compatibility

### Sidebar / Webview

- Shadow DOM actor architecture with EventStateManager pub/sub
- Virtual scroll with actor pooling for large conversations
- Thinking dropdowns with per-iteration content
- Shell command dropdowns with output display
- Modified/Pending Files dropdowns with per-file status (applied, rejected, expired, deleted)
- Code block rendering with syntax highlighting, copy, diff, and apply actions
- "Seeking/Developing/Diving..." animation during code generation
- Expand/collapse toggle for input area

### History & Sessions

- Auto-save conversations to encrypted database
- Session forking with fork metadata
- History modal with search, date grouping, rename, export (JSON/Markdown/TXT), delete
- Expired status for unresolved pending changes on history restore

### Commands

- 26 commands under "Moby" category
- Drawing server for phone-based sketching input
- Unified log export (extension Logger + TraceCollector + WebviewTracer + WebviewLogBuffer)
- `Moby: Export Turn as JSON (Debug)` for live event-stream snapshots in devMode

### Known Limitations

- WSL2 file watcher may miss deletion events from chained shell commands (B25)
- Cross-platform coverage is incomplete — primary development is on Linux/WSL2; macOS and native Windows paths have had limited manual exercise
- Real R1 trace fixtures for regression testing are still synthetic (parked follow-up)
- V3 chat may occasionally render text segments out of order relative to tool dropdowns when content and tool_calls interleave mid-stream. V3 stays on the legacy non-streaming tool path to avoid this; V4 family uses the streaming pipeline and is unaffected
