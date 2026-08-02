# Manual Test Backlog

_Last reconciled with code 2026-07-31._

Scenarios that have been implemented but not yet exercised in a VS Code dev host. Once a scenario has been walked through and passes, remove it from here (or move evergreen regressions into [test-scenarios.md](./test-scenarios.md)).

**Purpose:** caught-up list of "what needs eyeballing before shipping." Not a comprehensive regression suite — that's [test-scenarios.md](./test-scenarios.md).

## What the test suite already covers (2026-07-31 reconciliation)

Seven scenarios were removed this pass because tests now pin their pass criteria — M8, M9, M16, M17, M18, M20, M25. Four more were narrowed to the part tests can't reach (M6, M10, M11, M26).

Two limits worth remembering when deciding whether a future item belongs here:

- **The webview e2e specs replay hand-authored event streams.** [webview-rendering.spec.ts](../../tests/e2e/webview-rendering.spec.ts)'s `2G. History Restore Fidelity` group proves the *renderer* handles a `file-modified` event, not that the extension ever *emits* one. Any bug whose root cause is a missing producer on the `src/` side survives a green run — that's why M32 stays.
- **Animation and feel are not assertable.** Golden screenshots ([golden-rendering.spec.ts](../../tests/e2e/golden-rendering.spec.ts)) pin an end state; they say nothing about whether a label crossfaded or snapped. M3, M4, M5, M12 are eyes-only by nature.

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

_Covered by tests: the enabled-with-a-key gate (`TB1` in [workflows.spec.ts](../../tests/e2e/workflows.spec.ts)) and the stop/send swap during streaming (`IA7`, `IA9`). The primed-green state itself has no assertion anywhere — steps 2–4 and 7 are the live part._

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

## M10. Input area: expand stays expanded while typing (P2)

**Why this matters:** clicking the expand toggle bumps the textarea to 300px. Previously typing would strip `force-expanded` and auto-resize back to content-height. Now only the collapse state exits on typing.

_Covered by tests: plain auto-resize from the default state (`D3` in [webview-rendering.spec.ts](../../tests/e2e/webview-rendering.spec.ts)), i.e. step 4. Nothing touches `force-expanded` — steps 1–3 and 5 are the live part._

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

_Covered by tests: the idempotent-skip path itself — no disk write when content is unchanged ([diffManager.test.ts:451](../../tests/unit/providers/diffManager.test.ts#L451), [:499](../../tests/unit/providers/diffManager.test.ts#L499)). The dropdown side is untested: nothing asserts one row per file, so step 2's "no extra dropdown row" and step 3's update-in-place are the live part._

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

## M14. SearXNG web-search provider (P1)

**Why this matters:** covers Phase 2 of [web-search-providers.md](./completed/web-search-providers.md) (now marked completed). Validates that the provider abstraction works end-to-end with a non-Tavily backend, and that users can run the extension with zero cloud-search dependencies.

**Status (reconciled 2026-06-16):** the SearXNG provider has **shipped** — `SearxngClient` ([src/clients/searxngClient.ts](../../src/clients/searxngClient.ts)) is registered in [src/clients/webSearchProviderRegistry.ts:29](../../src/clients/webSearchProviderRegistry.ts), the `moby.webSearch.provider` enum includes `"searxng"`, and `moby.webSearch.searxng.endpoint`/`.engines` settings exist ([package.json:466-484](../../package.json)). Steps 1-9 and 12-14 below are now live and should be run. Steps 10-11 are still **not implemented**: there is no `nativeWebSearchEnable` translator, no `model-native` webSearch mode, and no "Search via" picker in the code — skip those two steps until that work lands.

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

## M15, M19. V4 `run_shell` native-tool path (Phase 3.75)

These exercise the `run_shell` tool for native-tool-calling models (V4, V3 Chat, custom). All tests use a V4 model (flash or flash-thinking) with `shellProtocol: 'native-tool'`.

M16, M17, M18 and M20 were removed on 2026-07-31: `run_shell` routes through the *same* pipeline as R1's `<shell>` ([workspaceTools.ts:252](../../src/tools/workspaceTools.ts#L252)), so long-running detection, the `allowAllShellCommands` bypass, the ADR-0004 absolute-path block and the shellProtocol-gated tools array are all pinned by [reasonerShellExecutor.test.ts](../../tests/unit/tools/reasonerShellExecutor.test.ts) and [fidelity.test.ts](../../tests/unit/providers/fidelity.test.ts). What's left here is model behaviour, which no test can assert.

### M15. V4 model runs tests via `run_shell`

**Setup:** A workspace with a project that has tests (any language — Ruby rspec, Python pytest, Node mocha).

**Steps:**
1. Send: "Run the tests and tell me if they pass."
2. Verify model calls `run_shell` with the correct test command.
3. Command appears in the approval UI (ask mode) or executes automatically (auto mode).
4. Test output flows back into the conversation.
5. Model interprets the results and reports pass/fail.

**Pass criteria:** `run_shell` dispatches through the existing approval + execution pipeline; test output is visible in the shell-results dropdown.

### M19. Interrupt during shell execution

**Steps:**
1. On a V4 model, trigger a `run_shell` with `sleep 30 && echo done`.
2. Click Stop during the sleep.
3. Turn ends cleanly with `*[User interrupted]*` marker.
4. No partial shell output leaks into subsequent turns.

**Pass criteria:** Abort during `run_shell` cancels cleanly — same path R1 uses.

---

## M21–M24, M26–M27. V4 streaming tool calls (Phase 4.5)

M25 (V3 legacy `runToolLoop` path with `streamingToolCalls: false`) was removed on 2026-07-31 — it's a pure code-path switch, covered by [requestOrchestrator.test.ts](../../tests/unit/providers/requestOrchestrator.test.ts) and [fidelity.test.ts](../../tests/unit/providers/fidelity.test.ts).

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

### M26. `reasoningEcho` round-trip — no live 400s (narrowed)

_Covered by tests: that the request body carries `reasoning_content` on prior assistant-with-tool-calls messages ([deepseekClient.streamChat.test.ts](../../tests/unit/deepseekClient.streamChat.test.ts), [requestOrchestrator.test.ts](../../tests/unit/providers/requestOrchestrator.test.ts)). Only the wire outcome needs eyes — whether the real API accepts what we send._

**Steps:**
1. Start a multi-turn conversation on V4-flash-thinking with tool calls.
2. Send a second message that triggers more tools.
3. Check logs — no `400` errors mentioning `reasoning_content must be passed back`.

**Pass criteria:** `reasoningEcho: 'required'` constraint satisfied against the live API across multi-turn tool loops.

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

## Subagent web-search-digest — Phase 1 first ship (P0)

**Why this matters:** first subagent role lands. Routing happens inside `webSearchManager.searchByQuery`; main agent loop is unchanged. Off-by-default — must verify no behavior change when setting is absent / `"off"`, and a real digest when enabled. See [docs/plans/subagents.md](./subagents.md).

**Setup:**
- Have a Tavily key OR a configured SearXNG endpoint (`moby.webSearch.provider`). Web search mode = `auto`.
- DeepSeek API key set (the V4-flash-thinking subagent uses it).

**S1. Setting off → no behavior change.**
1. Confirm `moby.subagents` is unset OR `"web-search-digest": "off"`.
2. Run a turn that triggers `web_search` (e.g. *"Search the web for the latest TypeScript 6 release notes."*).
3. Watch the Tool dropdown: web search result text should match today's `formatSearchResults` output (header line, separator, per-result title/URL/content blocks).
4. *Moby: Show Logs* → no `[Subagent]` lines. Trace export shows no `subagent.route` events.

**S2. Setting on → digest replaces raw output.**
1. Add `"moby.subagents": { "web-search-digest": "deepseek-v4-flash-thinking" }` in user settings.
2. Run the same turn from S1.
3. Tool dropdown's web search result should now show the digested format: each entry includes a `Why relevant: ...` line, plus a trailing `(Subagent considered N results; M omitted as less relevant.)` note when applicable.
4. Logs include `[WebSearch] Tool-triggered search complete: ... (digested by subagent)`. Trace export contains a `subagent.route` span with `validationResult: 'ok'` and a `digestBytes` value smaller than `inputBytes`.

**S3. Sub failure falls back gracefully.**
1. Temporarily set `"web-search-digest": "deepseek-chat"` (a model that does NOT declare `subagentRoles: ['web-search-digest']`).
2. Run the same turn.
3. Tool dropdown's web search result should show the raw `formatSearchResults` output unchanged. Main response should be normal — model has no idea routing was attempted.
4. Logs include `[Subagent] Model "deepseek-chat" is not declared for role "web-search-digest". Falling back to raw input.` Trace export does NOT contain a `subagent.route` span (router exits before opening one in this branch).

**Pass criteria:** all three scenarios behave as described, no regressions in non-search turns, and the main model's behavior is identical between S1 and S3 (proves invisibility of routing failures).

---

## Subagent web-search-digest — manual-mode routing (P0)

**Why this matters:** Phase 1 first ship only wired the auto-mode `web_search` tool path. Manual ("forced") mode uses a separate entry point (`webSearchManager.searchForMessage`) and was bypassing routing entirely. Phase 1 polish fix wires the router into manual mode too. See [docs/plans/subagents.md](./subagents.md) — "Phase 1 polish".

**Setup:** same as the prior P0 entry (Tavily key OR SearXNG endpoint, web search mode `manual`).

**S1. Manual mode + subagent enabled → digest replaces formatMultiSearchResults output.**
1. Set `"moby.subagents": { "web-search-digest": "deepseek-v4-flash-thinking" }`.
2. Toggle web search to **manual** mode in the popup, then click the search toggle so it's enabled.
3. Type a prompt that's a question (e.g. *"latest news in jquery"*). Send.
4. Logs include `[WebSearch] Manual-mode results digested by subagent`. Trace export contains a `subagent.route` span with `validationResult: 'ok'`.
5. The injected web search context (visible via *Moby: Export Turn as JSON*) shows the digest format (per-entry `Why relevant:` lines + trailing `(Subagent considered N results...)` note when applicable), not the raw `formatMultiSearchResults` output.

**S2. Manual mode + subagent off → unchanged behavior.**
1. Set `"moby.subagents": { "web-search-digest": "off" }` (or remove the key).
2. Repeat the manual-mode search from S1.
3. Injected web search context matches today's `formatMultiSearchResults` output (header + dedup'd results, no `Why relevant:` lines, no subagent footer).
4. No `[Subagent]` log lines, no `subagent.route` trace span.

**Pass criteria:** S1 digests, S2 doesn't. Both produce coherent main-model responses.

---

## Scroll investigation (not yet a test, still an audit item)

See the scroll-audit findings in conversation history. Top suspect is that any mouse movement during streaming breaks auto-scroll (via [ScrollActor.ts:309-324](../../media/actors/scroll/ScrollActor.ts#L309-L324)), and when combined with a large content jump (code block landing), the user can end up >100px from the bottom with `_userScrolled=true`, locking out automatic re-engagement.

Before fixing, instrument `handleContentResize()` and reproduce: start a turn that will produce a code block, move the mouse during streaming, check whether the `_userScrolled` flip is the culprit.

Not a pass/fail scenario yet — investigation only.

---

## M31. Active-plan injection carries the `.moby-plans/` path (P1)

**Why this matters:** the plan feature stores files in `.moby-plans/` but the model was only ever told the plan's bare filename (`## cobweb_update.md`) via the injected active-plan context — never the directory. Asked to "save/update the plan file," the model resolved the bare name to the **workspace root** and silently created a stray copy there (`write_file`/`createFile` auto-creates the parent dir, so no error), leaving the real `.moby-plans/<name>.md` untouched. Fix: [planManager.ts](../../src/providers/planManager.ts) now surfaces the workspace-relative path (`.moby-plans/<name>`) in both the system-prompt orientation block (`getActivePlansContext`) and the recency reminder (`getActivePlanReminder`), plus an explicit "write to that exact path, not the repo root" instruction.

**Setup:**
- Open a workspace, create a plan via the plans UI (*New Plan*) — this writes an empty template to `.moby-plans/<name>.md` and auto-activates it.
- Use a chat/V4 model (has `write_file`/`edit_file`).

**Steps:**
1. Ask the model to draft a plan for some task, then in a follow-up turn: *"save that plan into the plan file."*
2. **Pass:** the model writes to `.moby-plans/<name>.md` (the active plan file updates in place). **Fail (old bug):** a same-named file appears at the repo root and the `.moby-plans/` file stays empty.
3. Sanity-check the injected context via *Moby: Export Turn as JSON (Debug)* or logs: the `--- ACTIVE PLANS ---` block heading should read `## .moby-plans/<name>` and the `--- ACTIVE PLAN (reminder) ---` line should name `.moby-plans/<name>`.

---

## M32. History restore parity: modified files + no duplicate code dropdowns (P1)

**Why this matters:** the live render path and the history-restore path diverged (ADR 0003 says they should be identical). Two root causes, both fixed:
1. **Missing modified files.** `write_file`-created and shell-touched files only populated the live `autoAppliedFiles` side-channel (`onAutoAppliedFilesChanged` → `diffListChanged`); they never fired `onCodeApplied`, the sole producer of a *persisted* `file-modified` event. So they showed live but vanished on restore. Fixed by a new `diffManager.onFileRegistered` event fired from all four `register{Tool,Shell}{Created,Modified,Deleted}` methods, which [requestOrchestrator.ts](../../src/providers/requestOrchestrator.ts) persists as `file-modified` structural events. (`edit_file` already persisted via the diff engine.)
2. **Duplicated code dropdowns.** `text-append` keeps the raw ``` fence *and* a separate `code-block` event is extracted from the same text. The live webview stream never emits `code-block` events, so live renders one dropdown (from the text via `formatContent`); restore replayed the persisted `code-block` segment too → a second dropdown. Fixed by making the `code-block` case in [VirtualMessageGatewayActor.ts](../../media/actors/message-gateway/VirtualMessageGatewayActor.ts) a no-op (the fence is already in the text segment).

**Setup:** run a turn that (a) creates a file via `write_file`, (b) modifies a file via a shell command, (c) edits a file via `edit_file`, and (d) emits at least one fenced code block. Note the live "Modified Files" dropdown contents and the number of code-block dropdowns.

**Steps:**
1. During the live turn: confirm the Modified Files dropdown lists the write_file, shell, and edit_file targets, and each code block shows exactly one dropdown.
2. Switch to another session, then reload this one from the history sidebar (restore path).
3. **Pass:** the restored turn shows the **same** Modified Files (all three kinds, not just edit_file) and each code block still shows **exactly one** dropdown. **Fail (old bug):** write_file/shell files missing from the dropdown, and/or code blocks doubled.
4. Also restore a turn that deleted a file (via tool or shell) — it should show with `deleted` status, not vanish.

---

## M33. History modal: delete removes the row instantly + batched-broadcast fix (P1)

**Why this matters:** user report — deleting a session from the history modal didn't remove the row from the list until the modal was closed and reopened. Two fixes, one direct and one root-cause:

1. **Optimistic removal (direct).** `confirmDeleteSession` in [HistoryShadowActor.ts](../../media/actors/history/HistoryShadowActor.ts) previously only posted `deleteSession` and relied entirely on the extension's `historySessions` echo to re-render — a single point of failure with no local fallback. It now drops the row from `_sessions`/`_filteredSessions` and calls `updateHistoryList()` immediately (mirroring `cancelDeleteSession`); the echo still arrives and reconciles.

2. **Batched-broadcast correctness (root cause).** [EventStateManager.ts](../../media/state/EventStateManager.ts) `flushPendingBroadcasts` merged changed keys from *all* pending publishes under a single `lastSource`, then `broadcast()` skips the source actor for *every* key it's given. So an actor that co-published any key in the same rAF frame was wrongly skipped for keys **other** sources published — dropping updates it subscribes to (and, symmetrically, echoing an actor its own publish). The history modal's `open()` publishes `history.modal.visible` in the same frame as an incoming `history.sessions`, so the list could render stale until a reopen. Fixed by grouping pending broadcasts **by source** so each broadcast's skip is correct. Deterministic regression test: [EventStateManager.batching.test.ts](../../tests/unit/state/EventStateManager.batching.test.ts) (only reproduces with `batchBroadcasts: true`, the production default — the rest of the suite runs synchronous).

**Steps:**
1. Open the history modal with ≥2 sessions. Delete one via ⋮ → Delete → Yes.
2. **Pass:** the row disappears immediately, no reopen needed; the footer count decrements. Delete down to zero → "No chat history found" shows without reopening.
3. Delete the currently-active session and a non-active session — both remove instantly.
4. Reload the window, open the history modal → the list populates on the first open (not blank-until-reopen).

---

## M34. Attachment persistence + replay (ADR 0014) (P0)

**Why this matters:** attachments were never persisted — `recordUserMessage` dropped them and the `--- Attached Files ---` block was appended to the ephemeral per-request array. A reloaded session rebuilt model context *without* the attachment, silently differing from the conversation that actually happened. ADR 0014 persists bodies as content-addressed blobs and makes `getSessionMessagesCompat` the single place the context block is materialized. Unit tests pin byte-identical replay, exactly-once emission, fork carry-over, and GC — but nothing exercises the real DB file, a real reload, or the webview's restored view, which is precisely the path that used to break silently.

**Setup:** a workspace with a text file of a few KB. Tail the *DeepSeek Moby* output channel.

**Steps:**
1. New chat. Attach the text file, send a message that requires reading it (e.g. *"summarize the attached file"*). Model answers using the content — confirms the block still reaches the model now that the live injection is gone.
2. *Moby: Export Turn as JSON (Debug)* → the user message's context contains **exactly one** `--- Attached Files ---` block. **Fail (the double-inject regression):** two blocks.
3. Switch to another session, then restore this one from the history sidebar. Ask a follow-up that depends on the attachment (*"what was the third bullet in that file?"*). **Pass:** the model still knows. **Fail (old bug):** it has no idea what file you mean.
4. Fork the session at that turn → same follow-up → still answered.
5. Attach a file larger than 256KB. **Pass:** the model sees the head of the file plus a `[... truncated: N of M bytes omitted ...]` marker, and says so if asked. Logs show `[Attachments] Truncated "<name>" for persistence`.
6. Attach the *same* file twice in one session → only one row lands in `attachment_blobs` (content-addressed dedupe). Check via the DB or by confirming no size jump.
7. Delete the session from the history modal → its blobs are collected (`[AttachmentBlobStore] Collected N orphaned blob(s)` in the log). Delete a *forked* session while the parent survives → blobs are **kept**, and the parent's attachment still replays.

**Pass criteria:** the model's view of an attachment is identical live, after reload, and after fork; the block appears exactly once; oversized bodies truncate visibly; blob lifetime follows event lifetime in both directions.

**Note on the migration:** this run upgrades the database v1 → v2. Additive-only, but one-way — a DB touched by this build then opened by an older build loses blob rows.

---

## M35. Image attach — capture, downscale, chip (image-describe Phase 1) (P1)

**Why this matters:** the file picker now accepts `.png/.jpg/.jpeg/.webp/.gif/.bmp`. The webview downscales to a 1024px longest edge, re-encodes to WebP q0.8, and enforces a 1.5MB cap *after* re-encoding (a clipped image decodes to garbage, so oversize is rejected rather than truncated). Unit tests mock the canvas — happy-dom has no real encoder — so the actual downscale, the WebP encode, and the thumbnail rendering have never run.

**Interim behaviour, expected:** nothing routes the image to a model yet (that's phase 3). The image is stored and shown as a chip; the model is told nothing about it. Don't file that as a bug.

**Steps:**
1. Click attach → the picker offers image files alongside source files.
2. Attach a large screenshot (>2MB, e.g. a full 4K capture). **Pass:** a chip appears within a beat showing a **thumbnail of the image**, its name, and a size in the tens-to-low-hundreds of KB — i.e. the downscale ran. **Fail:** multi-MB size, or a 📄 icon instead of a thumbnail.
3. Attach a text file in the same batch → it still shows the 📄 icon and its own size. Both chips coexist.
4. Remove the image chip via × → it disappears; the text chip is unaffected.
5. Attach a `.gif` and a `.bmp` → both attach (canvas decodes them; they re-encode to WebP).
6. Rename a non-image file to `.png` and attach it → a VS Code error notification reads *"Could not read … as an image"*, and **no chip is added**.
7. Attach an enormous image (e.g. a 20000×20000 PNG, if you can produce one) → either it attaches downscaled, or a *"too large to attach"* notification appears. Never a silent no-op.
8. Send a message with an image attached → the turn sends normally and the model responds to the text. Reload the session → the turn restores. Check *Moby: Export Turn as JSON*: the persisted attachment carries a `blobId` and a small `bytes` value, **not** a base64 data URI.

**Pass criteria:** images downscale visibly, chips render thumbnails, non-images are rejected loudly, and no data URI ever lands in the event JSON.

---

## M36. Drag-and-drop attach (Phase 1b) (P1)

**Why this matters:** the automated tests synthesize a `DataTransfer` and dispatch `drop`, which exercises our handler, the image-vs-text branch, the highlight counter and the navigation guard. **Nothing automated can cross the real OS → webview boundary**, and nothing can reproduce what the VS Code Explorer actually puts on a drag payload — the `text/uri-list` round-trip is built against a documented assumption that has never been observed running.

**The dangerous failure mode is step 4.** An unhandled drop makes the webview frame navigate to the dropped file, blanking the chat and losing the in-flight turn. The document-level guard exists solely to prevent that.

**Steps:**
1. Drag an image from the OS file manager onto the **input box**. Chip appears with a thumbnail; size is tens-to-low-hundreds of KB (the downscale ran).
2. Drag a source file from the OS file manager onto the input box → 📄 chip with its name. Send a message → the model can quote the file's contents.
3. Drag a file **from the VS Code Explorer** onto the input box → same result. This is the `text/uri-list` path: the webview can't read it, so the extension does. Try both a text file and an image (e.g. `media/icon.png`).
4. **Drag a file over the transcript / header / anywhere that is not the input box, and drop it.** Nothing should attach — and critically **the chat must not disappear or navigate away**. If the panel goes blank, the guard isn't engaging.
5. While dragging over the input box, move the pointer across the textarea and over existing chips. The dashed highlight must stay **steady**, not flicker — that's the depth counter.
6. Drag over the input box then drag back out without dropping → highlight clears.
7. Drop a **folder** from the Explorer → warning notification, nothing attached.
8. Drop a very large file (>10MB) → warning naming the 10MB limit, nothing attached.
9. Drop several files at once (mixed image + text) → all attach, correct chip types.
10. Regression: the paperclip picker still works, and dropping still works after switching sessions (listeners survive re-render).

**Pass criteria:** both drop sources attach, off-target drops are inert and never navigate, the highlight is steady, and folder/oversize cases warn instead of failing silently.

**Not implemented, deliberately:** modifier keys. Shift+drop does nothing special — plain drop attaches, that's the whole interaction.

---

## Removing items from this backlog

When a scenario has been verified in a dev host:
- If it's a one-time verification of a recent change → delete the section.
- If it's worth keeping as an evergreen regression → move it to [test-scenarios.md](./test-scenarios.md) with full numbering.
