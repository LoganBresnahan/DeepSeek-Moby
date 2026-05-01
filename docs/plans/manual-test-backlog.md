# Manual Test Backlog

Scenarios that have been implemented but not yet exercised in a VS Code dev host. Once a scenario has been walked through and passes, remove it from here (or move evergreen regressions into [test-scenarios.md](./test-scenarios.md)).

**Purpose:** caught-up list of "what needs eyeballing before shipping." Not a comprehensive regression suite — that's [test-scenarios.md](./test-scenarios.md).

---

## M1. Local-model users with no DeepSeek key (P0)

**Why this matters:** the extension must not gate send-button on a DeepSeek key when the user has deliberately configured a local or custom model. Previously the model-change path didn't refresh `apiKeyConfigured`, so switching to Ollama would leave send disabled.

**Setup:**
- Fresh install OR delete the DeepSeek key via *DeepSeek Moby: Set API Key* → empty input.
- Confirm settings popup's "DeepSeek API Key" dot is grey.

**Steps:**
1. Open the chat. Default model should be `deepseek-chat`. Send button should be **disabled** (tooltip: "Send: DeepSeek API key not set").
2. Run *Moby: Add Custom Model* → pick "Ollama — Qwen 2.5 Coder 7B" from the quickPick. Entry lands in `moby.customModels`.
3. Open the model dropdown → select the new Ollama entry.
4. **Send button should now be enabled.** The Ollama template declares `apiKey: 'ollama'` as a registry placeholder, which satisfies `isApiKeyConfigured()`.
5. Type "hello" → send button should turn **green** (primed state).
6. Switch back to `deepseek-chat` in the dropdown → send button should go back to **disabled** (since no DeepSeek key).
7. Switch to Ollama again → enabled.
8. *DeepSeek Moby: Set API Key* → enter a value → "DeepSeek API Key" dot turns green.
9. Switch to `deepseek-chat` → send button enabled now that the key is set.

**Pass criteria:** send-button state flips correctly on every model change. No lingering disabled state when moving onto a model that's properly configured.

---

## M2. Per-model API key set/clear updates send button live (P0)

**Why this matters:** for hosted custom models (Groq, Kimi, OpenAI), the user sets a per-model key via the settings popup. The send-button gate uses that per-model key when the model is active — but previously setting/clearing it only updated the per-model dot, not the send-button state.

**Setup:**
- Add a hosted custom model via *Moby: Add Custom Model* (e.g., Groq template). Do **not** set its key yet.

**Steps:**
1. Select the Groq model. Send button is **disabled** (no key).
2. Open settings popup → "Custom Model API Keys" section → click **Set** next to Groq.
3. Enter a key → dialog closes.
4. **Send button should be enabled immediately** without any other action.
5. Click **Clear** on the Groq entry → **send button should disable immediately**.

**Pass criteria:** send button reflects per-model key state without requiring a reload or model-switch.

---

## M3. Activity monitor + moby whale behavior (P1)

**Why this matters:** recently restructured to keep the whale visible across a whole request (even through internal tool-call roundtrips) and to have the spurt only fire during active activity text.

**Setup:** any prompt that generates multiple iterations — "create a small python script, then run it, then fix any errors" works well on DeepSeek-Reasoner.

**Steps:**
1. Send the prompt.
2. **Moby icon remains visible the entire time**, from first reasoning token through the end of the turn — even during text streaming, between tool calls, across iteration boundaries.
3. Activity label ("Thinking", "Running X", "Writing foo.py", etc.) appears only when there's an explicit activity. When the model is streaming final text, the **label and spurt disappear; whale stays**.
4. When label text changes, it **crossfades** (brief opacity dip), not an instant swap.
5. Spurt droplets animate **continuously** while a label is shown, not as one-shot bursts.
6. No layout jumps above the indicator when activity comes/goes — the slot is reserved via `visibility: hidden`.

**Pass criteria:** whale = persistent presence, spurt = activity indicator, label swaps are smooth.

---

## M4. Streamed response bubble-in (P1)

**Why this matters:** the first text of a response should feel consistent with how dropdowns enter — a scale-and-slide. Previously the text container got `anim-bubble-in` at creation but was invisible (`hidden`), so the animation played without being seen.

**Steps:**
1. Send any prompt that produces a text response.
2. When text first appears, it should **pop in** with a subtle scale (0.95 → 1) and translateY (−5px → 0) over ~300ms — matching the feel of pending-changes, thinking, and tools dropdowns.
3. Subsequent tokens within the same segment should not re-animate (streaming continues smoothly).
4. A new text segment (after a code block, say) should also bubble in on first appearance.

**Pass criteria:** first appearance of streamed content feels "placed" rather than "snapped."

---

## M5. Non-code dropdown slow-open (P1)

**Why this matters:** thinking / tools / shell / pending dropdowns previously snapped open via `display: none` ↔ `display: block`. Now they transition `max-height` + `padding` + `border-top-width` over 0.3s, matching the code dropdown.

**Steps:**
1. Trigger a turn with a reasoning-capable model so a **thinking** dropdown appears. Click the header to collapse/expand → transitions smoothly both ways.
2. Same for **tools** dropdown (any tool call).
3. Same for **shell** dropdown (R1 shell interrupt).
4. Same for **pending** (pending changes after any `edit_file` in ask mode).
5. Code dropdown still animates (regression check).
6. Collapsed state has **no 1px sliver** or phantom padding — the entire body (border + padding + content) collapses cleanly.

**Pass criteria:** all four dropdowns open/close with the same feel as the code dropdown.

---

## M6. Send button primed (green) state (P1)

**Setup:** DeepSeek API key is set OR a local model is active.

**Steps:**
1. Empty input → send button is default blue/grey (VS Code button background).
2. Type a character → send button turns **green** (`--vscode-terminal-ansiGreen`).
3. Delete the text → back to default.
4. Type only whitespace → should remain default (trimmed check).
5. Type content, click send → during streaming, stop button replaces send.
6. After streaming, send button reappears in default color (no residual primed state on empty input).
7. Remove the API key while input has content → send should go to **disabled** (disabled gate wins over primed).

**Pass criteria:** green tint is a clear "ready to fire" signal without being loud.

---

## M7. API key dots in settings popup reactive (P2)

**Steps:**
1. Open settings popup with no keys set → both "DeepSeek API Key" and "Tavily API Key" have grey dots.
2. Leave popup open. Run *DeepSeek Moby: Set API Key* via command palette → enter a value.
3. **Popup should show the DeepSeek dot flip to green** without needing to close/reopen.
4. Same for Tavily key.
5. Clear the DeepSeek key → dot back to grey, live.
6. Set a per-custom-model key → that entry's green dot updates live in the "Custom Model API Keys" section.

**Pass criteria:** all dots reflect SecretStorage truth without reload.

---

## M8. Custom model max-tokens slider (P2)

**Why this matters:** previously the slider tried to write to `moby.maxTokensCustom<ModelName>` which isn't a registered config key; VS Code threw. Now writes patch the matching entry's `maxOutputTokens` inside `moby.customModels[]`.

**Steps:**
1. Switch to a custom model.
2. Open settings and find the maxTokens slider (may be per-model in its popup).
3. Drag the slider → no errors in Debug Console about "not a registered configuration".
4. Open `settings.json` → the matching `moby.customModels[].maxOutputTokens` updated to the new value.
5. Send a message → request uses the new value (check tokenCV log or response length).

**Pass criteria:** slider works end-to-end for custom models, zero config-write errors.

---

## M9. Command approval: absolute-path `rm` no longer double-blocked (P0)

**Why this matters:** the executor's catastrophic blocklist used to reject any `rm` with a `/`-starting path (including `rm -f /home/user/foo.txt`), even after the approval UI said "allow." Now user-approved commands bypass the blocklist.

**Steps:**
1. Use R1 on a test workspace. Ask it to delete a specific file at an absolute path, e.g., "Delete /tmp/moby-test-file.txt" (create the file first).
2. Approval UI appears → click **Allow once**.
3. **Command executes** — file is deleted, no "Blocked: Potentially dangerous operation" error in logs.
4. Try the catastrophic form: have R1 attempt `rm -rf /` (careful — this shouldn't happen in practice; you can also call `validateCommand('rm -rf /')` directly in tests). This **should still be blocked** without an approval prompt (regex-level catch).
5. `rm -rf ~`, `rm -rf /*`, `rm -f /` should all be blocked at the regex level.
6. `rm -rf /home/user/build`, `rm -rf ~/Documents/foo.zip`, `rm /tmp/workfile` should all flow through approval cleanly.

**Pass criteria:** approval UI decisions are respected by the executor; only bare-root / bare-home patterns are hard-blocked.

---

## M10. Input area: expand stays expanded while typing (P2)

**Why this matters:** clicking the expand toggle bumps the textarea to 300px. Previously typing would strip `force-expanded` and auto-resize back to content-height. Now only the collapse state exits on typing.

**Steps:**
1. Click the textarea expand toggle (▴) → textarea grows to 300px.
2. Start typing. **Textarea should remain at 300px** (not shrink to fit content).
3. Click the collapse toggle (▾) → goes back to content-height.
4. With an empty textarea (collapsed/default), start typing — auto-resize should still grow it to fit content up to its natural cap.
5. Collapse explicitly (▾), then type — should un-collapse and auto-resize (that behavior is preserved).

**Pass criteria:** manual expand state persists across typing; auto-resize still works from the collapsed state.

---

## M11. Idempotent-edit skip + dropdown dedupe (P2)

**Why this matters:** repeated applies of the same SEARCH/REPLACE to the same file (common when R1 retries after an unrelated error) used to add duplicate rows to the Modified Files dropdown and write the same content multiple times.

**Steps:**
1. On R1, trigger a scenario where the model emits the same fix for the same file twice in the same turn. (Or force it: ask for a fix, let it apply, then ask "apply that same fix again.")
2. **Second apply**: extension logs "Skipped idempotent apply for <file> (content unchanged)" — no disk write, no extra dropdown row.
3. If the second apply *does* produce different content (different diff), both applies should be reflected; the row should **update in place** rather than duplicating.

**Pass criteria:** dropdown has one row per file; repeated identical applies are no-ops.

---

## M12. R1 inline code-block fence normalization (P2)

**Why this matters:** R1 sometimes emits ```` ``` ``` ```` (close-fence immediately followed by open-fence, no newline between). The markdown parser flip-flopped and the code block visibly disappeared/reappeared during streaming.

**Steps:**
1. R1 prompt that typically produces consecutive code blocks: "Write a Python script, then write a separate Rust script that does the same thing."
2. Watch the streaming render. Code blocks should **not flicker** (appear → disappear → reappear).
3. Each code block renders as a proper dropdown.

**Pass criteria:** no mid-stream code-block flicker.

---

## M13. Local model end-to-end round-trip (P0)

**Why this matters:** M1 verifies the UI send-button gate flips correctly for local models. This scenario verifies the **full request path** — that the extension actually talks to the local endpoint, streams tokens back, and renders them like it does for DeepSeek. A local backend like Ollama exposes an OpenAI-compatible API at `http://localhost:11434/v1`; the registry's `apiEndpoint` field routes the request there instead of `api.deepseek.com`.

**Setup:**
- Install and start Ollama: `ollama serve` (default port 11434).
- Pull a small model: `ollama pull qwen2.5-coder:7b-instruct` (or whatever template matches).
- Run *Moby: Add Custom Model* → pick the Ollama template. Edit the `id` field in `settings.json` if needed to match the locally-pulled model tag.
- Confirm `apiEndpoint` in the entry points at `http://localhost:11434/v1` and `apiKey` is the placeholder `"ollama"`.

**Steps:**
1. Switch to the Ollama model in the dropdown.
2. Send a simple prompt: "Write a Python hello world."
3. **Watch for streaming tokens** in the chat — they should arrive progressively, not as a single dump.
4. Code block renders as a proper dropdown (click to expand; syntax highlighted).
5. Manual mode: verify the code-block actions (Diff / Apply / Copy) work — specifically that Apply lands the SEARCH/REPLACE block against a real file if the model emits one.
6. Check the Output channel ("DeepSeek Moby") — should show `[HTTP] POST http://localhost:11434/v1/chat/completions` (or similar), `[Timing] First token after Xms`, successful completion.
7. No DeepSeek-specific errors (wrong endpoint, 401, etc.).
8. Kill the Ollama server (`pkill ollama`) and send another message → extension should surface a reachability error gracefully (not silently hang).
9. Restart Ollama → next send recovers without needing extension reload.

**Pass criteria:** local backend round-trips work identically to DeepSeek from the user's perspective, including streaming, code blocks, edits, and tool-call-equivalent behaviors. Repeat the same for LM Studio and llama.cpp if time permits — each has its own transport quirks.

---

## M14. SearXNG web-search provider (P1 — when implemented)

**Why this matters:** covers Phase 2 of [web-search-providers.md](./web-search-providers.md). Validates that the provider abstraction works end-to-end with a non-Tavily backend, and that users can run the extension with zero cloud-search dependencies.

**Status:** ⚠️ Not yet implemented. Remove the "when implemented" guard and run this scenario after Phase 2 ships.

**Setup:**
- Run a SearXNG instance locally. Easiest: `docker run -d --name searxng -p 8080:8080 searxng/searxng` (official image).
- Confirm `http://localhost:8080/search?q=test&format=json` returns JSON.
- In settings, set `moby.webSearch.provider` to `"searxng"` and `moby.webSearch.searxng.endpoint` to `http://localhost:8080`.
- Leave the Tavily key blank or set it — both providers should coexist via the registry; the active one is whichever `provider` is set to.

**Steps:**
1. Open settings popup → **"SearXNG Endpoint"** row shows with a green dot (endpoint reachable). Tavily's own row keeps its own labelling and dot (regression check on the plan doc's explicit "don't hide provider names" rule).
2. Open the web-search popup (button left of send) → **provider-specific section** renders. With SearXNG selected: endpoint field + engine checkboxes (google/bing/ddg/etc.), no basic/advanced depth toggle. Click **Test connection** → flashes green.
3. Switch provider setting to Tavily in the popup → popup re-renders with Tavily's basic/advanced + credits section, no engine checkboxes. Test connection works here too.
4. Back to SearXNG. Set web-search mode to `manual`, toggle the toolbar web-search button on.
5. Send a query that needs current info: "What's the latest version of Node.js?"
6. Extension logs `[WebSearch] SearXNG: N results for "..."` — results prepended to the system prompt. Model answers using them.
7. Switch web-search mode to `auto` on a tool-calling model (e.g. `deepseek-chat`).
8. Send: "Search the web for the React 19 release notes."
9. Model calls `web_search({ query: "..." })` → extension routes it through SearXNG → tool result comes back → model uses it.
10. On a `model-native` custom model where we have a `nativeWebSearchEnable` translator (Groq, if configured): open popup → **"Search via" picker** appears with two options (model's built-in / SearXNG). Default is "model's built-in" because the translator exists. Send a query → model uses its own search, SearXNG is not called. Flip the picker to "SearXNG" → next send routes through SearXNG via our `provider-tool` path; model's native search does not fire. Flip back to native → behavior returns.
11. On a `model-native` model *without* a translator (e.g., an OpenAI browse-capable entry): popup shows only the provider option (SearXNG/Tavily); the "model's built-in" choice is absent. Web search works via the provider path. No native request is attempted.
12. On a `webSearch: 'none'` model: both toolbar toggle and popup fully disabled with tooltip.
13. Stop SearXNG (`docker stop searxng`) → **Test connection** flashes red. Next live web-search request surfaces a connection error as a tool result (not a silent hang).
14. Switch provider back to `tavily` → Tavily path works as before (regression).

**Pass criteria:** SearXNG is a first-class alternative to Tavily across manual, auto-with-tool, and auto-with-XML dispatch paths. Provider switching is a settings toggle, not a reload. Tavily behavior is unchanged.

---

## M15–M20. V4 `run_shell` native-tool path (Phase 3.75)

These exercise the `run_shell` tool for native-tool-calling models (V4, V3 Chat, custom). All tests use a V4 model (flash or flash-thinking) with `shellProtocol: 'native-tool'`.

### M15. V4 model runs tests via `run_shell`

**Setup:** A workspace with a project that has tests (any language — Ruby rspec, Python pytest, Node mocha).

**Steps:**
1. Send: "Run the tests and tell me if they pass."
2. Verify model calls `run_shell` with the correct test command.
3. Command appears in the approval UI (ask mode) or executes automatically (auto mode).
4. Test output flows back into the conversation.
5. Model interprets the results and reports pass/fail.

**Pass criteria:** `run_shell` dispatches through the existing approval + execution pipeline; test output is visible in the shell-results dropdown.

### M16. Long-running command detection

**Steps:**
1. Send: "Start the dev server with `npm run dev`."
2. Model calls `run_shell` with the dev-server command.
3. Extension rejects it via `LONG_RUNNING_PATTERNS`.
4. Model receives the rejection as a tool result and tells the user to run it manually.

**Pass criteria:** `npm run dev`, `flask run`, `python -m http.server`, etc. are all caught. Short commands (tests, builds) still execute.

### M17. `allowAllShellCommands` bypass

**Setup:** Set `moby.allowAllShellCommands: true`.

**Steps:**
1. Send a prompt requiring shell execution on a V4 model.
2. Model calls `run_shell`.
3. No approval prompt — command executes immediately.
4. Set `moby.allowAllShellCommands: false` → next `run_shell` triggers approval again.

**Pass criteria:** Bypass works identically for native-tool path and R1's `<shell>` path.

### M18. File-watcher diff with absolute paths (ADR 0004)

**Steps:**
1. Ask V4 to `mkdir tmp && echo "hello" > tmp/test.txt` via `run_shell`.
2. Check the tool result returned to the model — it must include `--- Files touched by this command (absolute paths) ---`.
3. Paths are absolute (e.g. `/home/user/project/tmp/test.txt`), not relative.

**Pass criteria:** ADR 0004 B-pattern preserved for native-tool shell path.

### M19. Interrupt during shell execution

**Steps:**
1. On a V4 model, trigger a `run_shell` with `sleep 30 && echo done`.
2. Click Stop during the sleep.
3. Turn ends cleanly with `*[User interrupted]*` marker.
4. No partial shell output leaks into subsequent turns.

**Pass criteria:** Abort during `run_shell` cancels cleanly — same path R1 uses.

### M20. Custom model gets `run_shell` automatically

**Setup:** Add a custom model with `toolCalling: 'native'` and `shellProtocol: 'native-tool'` (e.g., the Ollama Qwen template with `shellProtocol` changed from `"none"` to `"native-tool"`).

**Steps:**
1. Select the custom model.
2. Send a prompt that requires a shell command.
3. Verify the model's tools array includes `run_shell`.

**Pass criteria:** `run_shell` appears automatically for any model with `shellProtocol: 'native-tool'`.

---

## M21–M27. V4 streaming tool calls (Phase 4.5)

### M21. Visible reasoning during tool decisions

**Steps:**
1. Send a creation-heavy prompt on V4-flash-thinking: "Build me a small web app."
2. Watch the thinking dropdown during the first iteration.
3. Reasoning text appears **before** the tool call resolves — not just at the end.
4. Check `[ApiCall]` log line: `reasoning_chunks > 0`.

**Pass criteria:** Thinking text streams live during the tool-decision phase (the whole point of Phase 4.5).

### M22. Multi-tool batch in one iteration

**Steps:**
1. Prompt V4-flash-thinking to perform multiple reads in one turn: "Read package.json and tsconfig.json."
2. Verify both `read_file` calls appear as separate tools in the same batch dropdown.
3. Both execute and return results correctly (no missing or merged calls).

**Pass criteria:** Multi-tool batches accumulate and dispatch correctly from streaming deltas.

### M23. Multi-iteration tool loop closes cleanly

**Steps:**
1. Send a prompt that requires multiple iterations: "Create a Python script, test it, fix any errors."
2. Verify the loop runs multiple iterations (visible as separate tool batch dropdowns).
3. Final iteration ends with `finish_reason: 'stop'` and a single history-save.

**Pass criteria:** Multi-iteration streaming loop terminates cleanly without orphaned batches.

### M24. Abort mid-streaming-tool-call

**Steps:**
1. Start a turn on V4-flash-thinking that will produce a tool call (e.g., building a large file).
2. Click Stop before the tool call's arguments finish streaming (`finish_reason: 'tool_calls'` hasn't been emitted yet).
3. Verify `*[User interrupted]*` marker appears.
4. No half-executed tool (partial arguments are discarded).

**Pass criteria:** Partial tool calls are discarded on abort; no half-baked file writes.

### M25. V3 regression (legacy path still works)

**Steps:**
1. Temporarily set `streamingToolCalls: false` on `deepseek-chat` in the registry.
2. Send a prompt that requires tool calls.
3. Verify the legacy `runToolLoop` + `streamAndIterate` path still works.
4. Restore `streamingToolCalls: true`.

**Pass criteria:** Legacy path still functional for models that don't opt into streaming.

### M26. `reasoningEcho` round-trip (no 400s)

**Steps:**
1. Start a multi-turn conversation on V4-flash-thinking with tool calls.
2. Send a second message that triggers more tools.
3. Check logs — no `400` errors mentioning `reasoning_content must be passed back`.
4. Verify the request body includes `reasoning_content` on prior assistant-with-tool-calls messages.

**Pass criteria:** `reasoningEcho: 'required'` constraint satisfied across multi-turn tool loops.

### M27. Wall-clock reduction on no-tool turns

**Steps:**
1. Send a simple question on V4-flash: "What is 2+2?"
2. Check the `[ApiCall]` log — only one `streamChat` call, no `chat()` probe.
3. Compare wall-clock time against the pre-Phase-4.5 baseline (should be ~30–50% faster on no-tool turns).

**Pass criteria:** No duplicate generation on no-tool turns; single `streamChat` call.

---

## M28–M29. V4 end-to-end scenarios (Phase 5)

### M28. V4-flash plain chat (non-thinking, no tools)

**Steps:**
1. Select `deepseek-v4-flash`.
2. Send a simple question: "Explain the visitor pattern in 2 sentences."
3. Verify streaming response, no tool calls, clean finish.

**Pass criteria:** V4 non-thinking works as a drop-in replacement for V3 Chat.

### M28a. V4-flash-thinking single turn (no tools)

**Steps:**
1. Select `deepseek-v4-flash-thinking`.
2. Send a read-only question: "What does the visitor pattern optimize for?"
3. Verify reasoning content streams in the thinking dropdown during the response.
4. Verify final answer appears, no tool calls made, no 400 errors.

**Pass criteria:** Single-turn thinking mode works without tool involvement.

### M29. V4-pro-thinking multi-turn with tools

**Steps:**
1. Select `deepseek-v4-pro-thinking`.
2. Send: "Create a markdown file README.md with a project overview, then add a LICENSE file."
3. Verify multiple tool calls across iterations, reasoning streams live, edits apply.
4. Verify `reasoningEffort: max` is active (check log for `reasoning_effort=max`).
5. Switch to `high` via the model-selector pills → next request uses `reasoning_effort=high`.

**Pass criteria:** Pro-thinking end-to-end with max effort, tool loops, and effort toggle.

---

## M30. LSP per-language availability + reactive recovery (P0)

**Why this matters:** Phase 4 of [docs/plans/partial/lsp-integration.md](partial/lsp-integration.md) shipped a per-language `LspAvailability` service that gates the LSP tools (`outline`, `get_symbol_source`, `find_symbol`, `find_definition`, `find_references`) and feeds the system prompt's *"LSP works for: X. No LSP for: Y."* declaration. Five real-world recovery paths need eyeballing in a dev host because mocks can't reproduce cold rust-analyzer / language-server-not-installed scenarios.

**Setup:**
- Open a polyglot workspace with at least one language whose LSP is installed and one whose isn't (e.g. a Rails repo with `.rb` + `.ts`, or any project plus a Ruby file when `shopify.ruby-lsp` is uninstalled).
- Tail the *DeepSeek Moby* output channel — all LspAvailability log lines are prefixed `[LspAvailability]`.

**Steps:**

1. **Cold-start discovery.** Reload the window. Within ~30s of activation, look for:
   ```
   [LspAvailability] Discovery complete in <ms> — available=[…] unavailable=[…] untested=[…]
   ```
   The list should match what's actually installed (TypeScript almost always available; Ruby/Elixir/Rust depend on installed extensions + tools).

2. **Cold-LSP retry.** If a language's LSP boots slowly (rust-analyzer, gopls), the initial probe times out and reports unavailable. ~30s later you should see:
   ```
   [LspAvailability] Retrying probe for rust (…)
   [LspAvailability] rust now available after retry
   ```
   Send an LSP-aware question afterwards (e.g. *"outline src/main.rs"*) and verify the model uses `outline` rather than falling back to grep.

3. **Editor-focus retry.** With ruby still marked unavailable (e.g. ruby-lsp not yet installed), open a `.rb` file in the editor. Expect:
   ```
   [LspAvailability] ruby marked unavailable; editor focus triggers retry probe
   [LspAvailability] Retrying probe for ruby (…)
   [LspAvailability] ruby still unavailable after retry  (debug)
   ```
   Now install `shopify.ruby-lsp` (and its gem). Focus the `.rb` tab again. Within ~1s:
   ```
   [LspAvailability] ruby now available after retry  (info)
   ```

4. **System-prompt declaration updates per request.** With ruby in `available` after step 3, send any user message. In the request log (or via *Moby: Export Turn as JSON (Debug)*) confirm the system prompt contains `LSP works for: …, ruby` and the LSP tool definitions are attached. Without manually invalidating, edit the gem to break it and run *Moby: Refresh LSP Availability* — next request should drop ruby from `LSP works for:` and add it to `No LSP for:`.

5. **Timeout safety.** Hardest to provoke deliberately, easiest to verify visually with a misbehaving LSP. If a tool call (`find_symbol`, `find_definition`, etc.) takes >5s to return, the tool result must be:
   ```
   Error: LSP request timed out after 5s. The language server may be cold-starting, indexing, or hung. Try again in a few seconds, or fall back to grep + read_file for this query.
   ```
   The chat must NOT hang waiting for the LSP — the request should complete with the timeout-error tool result and the model proceeds (typically by falling back to grep). Closest natural reproduction: open a fresh huge Rust workspace, immediately ask the model to `find_symbol "main"` while rust-analyzer is still indexing.

**Pass criteria:**
- Discovery log matches the actual installed LSP picture (no false positives, no false negatives).
- Cold-LSP recovery happens within the 30s post-discovery retry OR on the next editor focus.
- System prompt declaration tracks `LspAvailability.getDeclaredAvailability()` per request — visible in exported turn JSON.
- A hung LSP returns a `timed out after 5s` error rather than stalling the chat indefinitely.
- `Moby: Refresh LSP Availability` command flushes + re-discovers.

**Failure modes to look for:**
- Discovery silently lists `untested=[…]` languages forever — means findFiles missed their extensions or `openTextDocument` failed; check `PROBE_FILE_GLOB` in [src/services/lspAvailability.ts](../../src/services/lspAvailability.ts).
- LSP tools advertised in the prompt for a language with no symbol provider — means `lspTools` capability is on but `available` list is wrong. Check `reportToolResult` is firing on every tool call.
- Chat freezes on tool execution and only Stop button recovers — the timeout wrapper isn't engaging; verify [src/utils/lspTimeout.ts](../../src/utils/lspTimeout.ts) is imported by every `executeCommand` site.

---

---

## Scroll investigation (not yet a test, still an audit item)

See the scroll-audit findings in conversation history. Top suspect is that any mouse movement during streaming breaks auto-scroll (via [ScrollActor.ts:309-324](../../media/actors/scroll/ScrollActor.ts#L309-L324)), and when combined with a large content jump (code block landing), the user can end up >100px from the bottom with `_userScrolled=true`, locking out automatic re-engagement.

Before fixing, instrument `handleContentResize()` and reproduce: start a turn that will produce a code block, move the mouse during streaming, check whether the `_userScrolled` flip is the culprit.

Not a pass/fail scenario yet — investigation only.

---

## Removing items from this backlog

When a scenario has been verified in a dev host:
- If it's a one-time verification of a recent change → delete the section.
- If it's worth keeping as an evergreen regression → move it to [test-scenarios.md](./test-scenarios.md) with full numbering.
