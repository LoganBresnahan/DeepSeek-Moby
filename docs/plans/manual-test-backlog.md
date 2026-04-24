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
4. Same for **pending** (pending changes after any `apply_code_edit` in ask mode).
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

## Scroll investigation (not yet a test, still an audit item)

See the scroll-audit findings in conversation history. Top suspect is that any mouse movement during streaming breaks auto-scroll (via [ScrollActor.ts:309-324](../../media/actors/scroll/ScrollActor.ts#L309-L324)), and when combined with a large content jump (code block landing), the user can end up >100px from the bottom with `_userScrolled=true`, locking out automatic re-engagement.

Before fixing, instrument `handleContentResize()` and reproduce: start a turn that will produce a code block, move the mouse during streaming, check whether the `_userScrolled` flip is the culprit.

Not a pass/fail scenario yet — investigation only.

---

## Removing items from this backlog

When a scenario has been verified in a dev host:
- If it's a one-time verification of a recent change → delete the section.
- If it's worth keeping as an evergreen regression → move it to [test-scenarios.md](./test-scenarios.md) with full numbering.
