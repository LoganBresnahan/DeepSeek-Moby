# Changelog

## [0.3.0] - 2026-04-30 (Pre-Release)

### Context cleanup — orientation-only editor header

- **Editor context shrunk to a 4-line orientation header.** `FileContextManager.getEditorContext` ([src/providers/fileContextManager.ts](src/providers/fileContextManager.ts)) now returns only `Current File / Full Path / Language / Total Lines`. Removed in this pass:
  - `--- FULL FILE CONTENT ---` block (was 20-200K+ tokens per turn for non-trivial files)
  - `--- RELATED FILES IN WORKSPACE ---` block (paths-without-content, marginal value)
  - `findRelatedFiles` subprocess work — up to 6 `find` / `rg` / `grep` spawns per request with 2-3s timeouts each (worst-case ~15s of subprocess work before the LLM call even started; typical 100-500ms)
  - `Cursor at line N` line
  - `Selected code (lines A-B): <text>` block — was a Ctrl+A / large-selection blast-radius hazard
- **Why all of it:** native-tool models (V4 series, V3 chat) have `read_file`, `outline`, `find_symbol`, `get_symbol_source`, `find_definition`, `find_references`. They can fetch precisely what they need on demand cheaper than always-on injection. R1's shell tool covers the same ground via `cat`/`sed`/etc. The orientation header still names the file the user has focused, so the model has the entry point.
- **Token impact:** sessions with the active editor open used to pay 20-40K tokens per turn for a 5K-line file (up to 200K for a 50K-line file). Now ~20 tokens regardless of file size or selection. Ctrl+A no longer matters.
- **Latency impact:** removes the per-request subprocess spend entirely.
- 40 fileContextManager unit tests still pass; tests directly asserting on the removed blocks were rewritten as regression guards (no body, no related-files, no cursor, no selection text, no `spawnSync` calls).
- See [docs/plans/context-cleanup.md](docs/plans/context-cleanup.md) for the full audit + remaining phases (instrumentation, snapshot keyFacts wiring, dead-write cleanup).

### LSP integration

- **Five LSP-backed navigation tools** for native-tool models (V3 chat, V4-flash-thinking, V4-pro-thinking):
  - `outline(path)` — symbol tree of a file (functions, classes, methods) without reading bodies. Cheap orientation for large files.
  - `get_symbol_source(path, symbol)` — slice one symbol's body without reading the whole file. Handles overloads (returns all matches).
  - `find_symbol(name, maxResults?)` — workspace-wide symbol search via `executeWorkspaceSymbolProvider`.
  - `find_definition(path, line?|symbol?, maxResults?)` — jump from a reference to its declaration. Accepts `(file, line)` or `(file, symbol)`. Handles modern `LocationLink` and legacy `Location` shapes.
  - `find_references(path, line?|symbol?, maxResults?)` — list every place a symbol is used. More accurate than grep on names; ignores comments; handles dynamic dispatch through interfaces.
- All tools call VS Code's command proxies (`executeDocumentSymbolProvider` / `executeDefinitionProvider` / `executeReferenceProvider` / `executeWorkspaceSymbolProvider`). No custom indexer, no daemon. The LSP is already running for any language the user has installed.
- Per-model gating via new `lspTools?: boolean` capability axis. Default `false`. R1 explicitly excluded (xml-shell transport doesn't surface LSP results).
- Result formatter returns absolute paths (ADR 0004 B-pattern), trimmed snippet per match, configurable `maxResults` cap (default 20, max 100), truncation note when over.
- **Per-language `LspAvailability` service** ([src/services/lspAvailability.ts](src/services/lspAvailability.ts)) — replaces the earlier global `LspProbe` (Phase 3a) which lied in mixed-language workspaces because the built-in TypeScript server made any JS-containing repo report `true` regardless of what the other languages had. The new service maps each languageId in the workspace to one of three states (`available` / `unavailable` / `untested`), feeds the partition into the system prompt as *"LSP works for: X. No LSP for: Y. Untested: Z."*, and self-corrects on every tool call via `reportToolResult(languageId, hadSymbols)`. `false → true` flips immediately on success; `true → false` requires two consecutive empties so a single stub file can't poison a whole language.
- **Reactive recovery for cold + late-installed language servers.** Five triggers populate or refresh the map: activation + 3s warmup, `onDidChangeWorkspaceFolders`, `vscode.extensions.onDidChange`, a 30s post-discovery retry that catches slow-cold servers (rust-analyzer, gopls, kotlin-lsp routinely exceed the 5s probe timeout on first launch), and an `onDidChangeActiveTextEditor` listener that schedules a 1s retry probe when the user focuses a tab in a language currently marked unavailable — so fixing your LSP setup mid-session (`gem install`, `asdf install`, editing `~/.profile`) gets reflected as soon as you click a relevant file.
- **Timeout safety wrapper** ([src/utils/lspTimeout.ts](src/utils/lspTimeout.ts)) — every `vscode.commands.executeCommand` call into an LSP is wrapped in `withLspTimeout` (5s). VS Code's command proxy doesn't expose a timeout natively, so a deadlocked Pylance / hung gopls indexer / mid-cold-start rust-analyzer would otherwise leave a tool call awaiting forever and stall the chat. Tools surface `Error: LSP request timed out after 5s — try again or fall back to grep + read_file` so the model can recover; the probe treats timeout as `unavailable` and lets the post-discovery retry catch slow-cold cases.
- **`Moby: Refresh LSP Availability` command** for users who install LSP support outside VS Code (`gem install`, `asdf install`, etc.) where no `extensions.onDidChange` event fires.
- 80 unit tests covering tool dispatch, position resolution, multi-result truncation, error paths, no-LSP fallbacks, timeout behavior, adaptive feedback, the editor-focus listener, post-discovery retry firing, and per-language threshold flips.
- See [docs/architecture/integration/lsp-integration.md](docs/architecture/integration/lsp-integration.md) for the runtime architecture and [docs/plans/partial/lsp-integration.md](docs/plans/partial/lsp-integration.md) for the design/rationale.

### DeepSeek V4 tokenizer

- **Bundled `deepseek-v4.json.br`** (1.37 MB brotli-compressed). V4 shares V3's BPE base (same 128K vocab, same merges, same pre-tokenizer/decoder/normalizer) but adds 465 new special tokens (`<think>`, `</think>`, `｜DSML｜`, file/repo markers, multimodal placeholders). Counting V4 with V3's vocab missed those tokens.
- **Auto-load on activation + session-restore.** Previously `tokenService.selectModel()` fired only on the webview's model-dropdown click — extension activation defaulted to V3 even when the restored model was V4. Now activation calls `selectModel(restoredModel)` after `initialize()`, and `chatProvider.onModelChanged` also routes to it so any model-switch path keeps the WASM vocab in sync.
- TokenCV delta on V4 turns drops from ~77% (V3 vocab) to ~10% (V4 vocab + remaining gap from server-side chat-template wrappers and tool-array overhead).
- TokenService log line includes vocab name on load: `[TokenService] Loaded "deepseek-v4" in 372ms (128000 tokens)` and emits a `Switched active vocab X → Y` line on switches.

### Markdown rendering

- **HTML escape in `formatContent`.** Model-emitted raw HTML tags (`<a href>`, `<u>`, `<font>`, `<script>`) now render as escaped text instead of executing as live elements. Two-pass placeholder substitution preserves fenced code-block extraction and the apply/diff/copy buttons; markdown bold/italic/inline-code/newlines work as before.
- Bug: V4-thinking with `reasoning_effort=max` occasionally emitted raw `<a href>` anchors for layout, which the old renderer passed through verbatim. Result was prose styled as blue-underlined links — the "purple highlighting" bug. The escape pass closes the security/correctness floor; a follow-up will swap the manual regex transforms for `markdown-it` to render tables/headings/lists/links properly instead of passing them through as literal text.
- System-prompt nudge: *"Output renders as markdown. Use markdown syntax (links, tables, lists), not raw HTML tags."* Added to both minimal and standard prompt variants.

### Database recovery

- **Auto-recovery from `SQLITE_NOTADB`** on activation. If `moby.db` exists but can't be decrypted (typically a crashed first activation that left a partial file), `openDbWithRecovery` quarantines files ≤4096 bytes (one SQLite page — structurally cannot hold user data) and starts fresh. Larger files surface a descriptive error pointing at `Moby: Manage Database Encryption Key` rather than auto-deleting potentially-real history.
- Reproduced on a clean M1 Mac install: extension crashed during first activation after creating an empty `moby.db`, leaving a zero/garbage file; subsequent activations couldn't decrypt it. Auto-recovery path resolves this case without data loss.
- Helper extracted to [src/events/dbRecovery.ts](src/events/dbRecovery.ts) for testing against real SQLCipher (8 unit tests covering both quarantine and refuse-to-discard branches).
- New user-facing guide: [docs/guides/database-recovery.md](docs/guides/database-recovery.md) with mermaid flowcharts of the auto-recovery decision tree and per-OS database file paths.

### Logging fixes

- **`[ApiCall] iter=N` counter mislabel.** `logger.setIteration` is now wired in both the streaming-tool-calls loop and the legacy `runToolLoop`. Previously only R1's shell loop pushed to the counter, so V4 turns logged `iter=1` for every iteration regardless of how many ran. The summary line now shows the actual loop iteration.
- **`VirtualList` "actor NOT bound" warnings** during session restore downgraded from WARN to debug. Off-screen turns bind only when scrolled into view; the bind-time replay loop reconstructs stored data correctly. The old WARN message (*"will be stored but not rendered"*) was misleading — data IS rendered at bind. Updated message clarifies the deferred-render pattern.

### Developer experience

- **F5 launches an isolated VS Code profile.** `.vscode/launch.json` "Run Extension" now passes `--profile=moby-dev`, so the Extension Development Host gets its own clean profile (no marketplace Moby, no inherited extensions) without needing to disable extensions globally. Survives across F5 runs; persists settings within the profile.
- **README Help section** links to recovery guides (database, custom models, logging, shell execution) plus a pointer to `Moby: Show Logs` for issue triage.
- Plan docs reorganized: completed plans moved to [docs/plans/completed/](docs/plans/completed/); partial/in-progress plans (LSP integration) live in [docs/plans/partial/](docs/plans/partial/).

## [0.1.2] - 2026-04-27 (Pre-Release)

### Fixed

- **Model selector dropdown showed only V3 + R1 on fresh installs.** `sendModelList()` was only called from `loadCurrentSessionHistory()`, which early-returns when there's no active session — so the webview kept its hardcoded V3+R1 fallback list, and V4 entries from `moby.customModels` never reached the UI. Now fires on `webviewReady` regardless of session state.

## [0.1.1] - 2026-04-27 (Pre-Release)

### Fixed

- **Extension hung in "Activating..." with no logs after 0.1.0 install.** `node_modules/node-gyp-build` was excluded from the VSIX by `.vscodeignore`, but `@signalapp/sqlcipher`'s entry module requires it at load time to locate the prebuild. Result: silent `Cannot find module 'node-gyp-build'` thrown before the extension's logger could initialize. `.vscodeignore` now whitelists `node_modules/node-gyp-build/**` alongside `@signalapp/**`.
- **`list_directory`, `read_file`, `file_metadata` failed on absolute paths inside the workspace.** `path.join(workspacePath, '/abs/path')` produced `/workspace/abs/path` (POSIX `path.join` doesn't reset on absolute second args). V4 emits absolute paths often; tools returned `Error: Directory not found` 50%+ of the time. Switched to `path.resolve` + `path.relative` boundary check so absolute-paths-inside-workspace resolve correctly while traversal escapes still get blocked.
- **VSIX shipped a 10 MB README preview gif and stale compiled `vitest.config.js`.** Added `dist/media/*.gif` and `dist/media/*.mp4` to `.vscodeignore`; build script no longer copies preview media into `dist/`. VSIX size dropped 18.97 MB → 8.95 MB.

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
