# DeepSeek V4 integration

**Status:** Plan — not yet implemented
**Date:** 2026-04-26

## Context

DeepSeek released V4 as a preview on 2026-04-24 ([announcement](https://api-docs.deepseek.com/news/news260424)). Two new model IDs ship:

- `deepseek-v4-flash` — replaces `deepseek-chat`. Fast and cheap ($0.14/M input, $0.28/M output).
- `deepseek-v4-pro` — premium tier ($1.74/M input, $3.48/M output; $0.145/M cached input).

Both share these properties:

- **Same `https://api.deepseek.com` base URL** — no transport changes.
- **OpenAI-compatible chat completions format** — `messages`, `tools`, streaming, all unchanged.
- **1M context window** — up from 64K (R1) / 128K (Chat).
- **Two operational modes per model** — Thinking and Non-Thinking, toggled per-request via the `thinking` parameter.
- **Tool calling works in both modes**. This is the big change. The old `deepseek-reasoner` had no tool-calling — we worked around it via the `<shell>` XML transport. V4-thinking has native tools.
- **Same V3 tokenizer** with a few new special tokens added.

The retirement schedule is firm: `deepseek-chat` and `deepseek-reasoner` are reachable until **2026-07-24, 15:59 UTC**. Today they transparently route to `deepseek-v4-flash`. After that date both old IDs error out.

The capability registry we built in [model-capability-registry.md](./model-capability-registry.md) was designed for this kind of evolution. Most of the integration is registry entries plus a small client-side change to inject the `thinking` parameter.

## Decision

Each upstream V4 model becomes **two registry entries** — one non-thinking, one thinking. Mirrors the existing chat/reasoner split, keeps the cost/quality tradeoff at model-pick time, and avoids a per-turn UI toggle.

| Registry id | Upstream model | Mode | Replaces |
|---|---|---|---|
| `deepseek-v4-flash` | `deepseek-v4-flash` | non-thinking | `deepseek-chat` |
| `deepseek-v4-flash-thinking` | `deepseek-v4-flash` | thinking | `deepseek-reasoner` (parity tier) |
| `deepseek-v4-pro` | `deepseek-v4-pro` | non-thinking | (new tier) |
| `deepseek-v4-pro-thinking` | `deepseek-v4-pro` | thinking | (new tier) |

The `-thinking` suffix is a Moby-side identifier. Before sending the request, the client strips it and sends the bare upstream model id alongside the thinking parameter.

The four entries differ only in `reasoningTokens`, `supportsTemperature`, `maxOutputTokens`, and the new V4-only axes (below). The shared OpenAI envelope and tool-calling behavior is identical to today's `deepseek-chat` for non-thinking, and a superset for thinking.

## New capability axes

Four optional fields added to `ModelCapabilities`:

```ts
interface ModelCapabilities {
  // ... existing fields ...

  /** Send `{"thinking": {"type": "enabled"}}` in the request body.
   *  Only V4 thinking variants need this. Defaults to false. */
  sendThinkingParam?: boolean;

  /** Default reasoning effort sent on thinking requests.
   *  Per-model registry default. User overrides via
   *  `moby.modelOptions.<id>.reasoningEffort`. */
  reasoningEffort?: 'high' | 'max';

  /** Whether `reasoning_content` must be echoed back in subsequent
   *  requests when serializing assistant turns that contained
   *  tool_calls. V4-thinking returns 400 if you don't. */
  reasoningEcho?: 'required' | 'optional' | 'none';

  /** Upper bound for the per-model max-tokens slider in the UI.
   *  Defaults to `maxOutputTokens` when omitted (matches V3 behavior
   *  where the default and cap coincided). V4 sets this to 384000
   *  so the slider can reach the real API cap even though the
   *  practical default (`maxOutputTokens`) is much lower. */
  maxOutputTokensCap?: number;
}
```

### Why split into four

- `sendThinkingParam` — request-side wire format, model-specific, derived from registry entry. Not user-facing.
- `reasoningEffort` — user-facing knob with a per-model default. Lives in registry as the default; user override stored in `moby.modelOptions`.
- `reasoningEcho` — history-serialization rule. Derivable from `reasoningTokens === 'inline' && toolCalling === 'native'`, but explicit is clearer when reading the registry, and any future model with a similar requirement gets to declare it.
- `maxOutputTokensCap` — separates "default value sent as `max_tokens`" from "upper bound of the slider." V3 entries had these coincide (8K and 64K were both default and cap). V4 entries don't — the API allows 384K output but practical use is much lower.

## Concrete registrations

```ts
'deepseek-v4-flash': {
  toolCalling: 'native',
  reasoningTokens: 'none',
  editProtocol: ['native-tool', 'search-replace'],
  shellProtocol: 'none',
  supportsTemperature: true,
  maxOutputTokens: 32768,            // slider default — see "Output token limits" below
  maxOutputTokensCap: 384000,        // slider upper bound — the real API limit
  apiEndpoint: 'https://api.deepseek.com',
  tokenizer: 'deepseek-v3',
  requestFormat: 'openai',
  // sendThinkingParam: false (default)
  // reasoningEcho: 'none' (default)
},

'deepseek-v4-flash-thinking': {
  toolCalling: 'native',
  reasoningTokens: 'inline',
  editProtocol: ['native-tool', 'search-replace'],
  shellProtocol: 'none',
  supportsTemperature: false,        // thinking mode rejects temperature/top_p
  maxOutputTokens: 65536,            // slider default
  maxOutputTokensCap: 384000,        // slider upper bound
  apiEndpoint: 'https://api.deepseek.com',
  tokenizer: 'deepseek-v3',
  requestFormat: 'openai',
  sendThinkingParam: true,
  reasoningEffort: 'high',           // user can override
  reasoningEcho: 'required',
},

'deepseek-v4-pro': { /* same as flash */ },

'deepseek-v4-pro-thinking': {
  /* same as flash-thinking, but */
  reasoningEffort: 'max',            // pro defaults to max — paying for quality
},
```

### Output token limits

Both V4 models advertise a **1M-token context window** and a **384K max output tokens** ([source](https://api-docs.deepseek.com/quick_start/pricing)). Both modes share these caps.

The registry splits these two numbers deliberately:

| Field | Meaning | V4 flash (non-thinking) | V4 flash-thinking | V4 pro | V4 pro-thinking |
|---|---|---:|---:|---:|---:|
| `maxOutputTokens` | Slider default + value sent as `max_tokens` if user hasn't overridden | 32768 | 65536 | 32768 | 65536 |
| `maxOutputTokensCap` | Slider upper bound; the real API cap | 384000 | 384000 | 384000 | 384000 |

Users can drag the per-model maxTokens slider all the way to 384K if they want. The starting value is sensible-for-typical-use — most answers fit in <2K, and defaulting the slider to 384K would be a footgun.

V3 entries (`deepseek-chat`, `deepseek-reasoner`) don't set `maxOutputTokensCap`; the renderer falls back to `maxOutputTokens` as the slider max — matching their existing behavior where default and cap coincided.

## Storage decisions

**Per-model option override** lives in **VS Code settings.json**, not SecretStorage and not the DB.

```jsonc
"moby.modelOptions": {
  "deepseek-v4-flash-thinking": { "reasoningEffort": "max" },
  "deepseek-v4-pro-thinking":   { "reasoningEffort": "max" }
}
```

Schema declared in `package.json` under `contributes.configuration` so VS Code validates the shape.

**Why settings.json:** not sensitive; not volume / relational; user-editable; sync-friendly. Matches the pattern for every other user preference (edit mode, web-search provider, custom models). See the storage-layers principle: would this survive `git diff`? Yes → settings.json.

The DeepSeek API key continues to live in SecretStorage (`moby.apiKey`) — unchanged.

## UI for `reasoningEffort`

Inline sub-control in the **model dropdown popup**, rendered only when the active model has `reasoningEffort` defined in its capabilities:

```
┌────────────────────────────────────┐
│ DeepSeek Chat (V3 — retiring Jul)  │
│ DeepSeek Reasoner (R1 — retiring)  │
│ DeepSeek V4 Flash                  │
│ ● DeepSeek V4 Flash (Thinking)     │  ← active
│      Reasoning effort: [High] [Max]│  ← sub-control
│ DeepSeek V4 Pro                    │
│ DeepSeek V4 Pro (Thinking)         │
│ ─────────────────────────────────  │
│ Llama 3.3 70B (Groq)               │
│ ─────────────────────────────────  │
│ + Add custom model...              │
└────────────────────────────────────┘
```

Two pill buttons reflecting current setting. Click writes to `moby.modelOptions.<id>.reasoningEffort`. Effective on next request.

**Why in the model popup, not settings:** discoverability (visible at model-pick time), contextual (only shown when relevant), per-model in nature.

Future axes the user may want to tweak land in the same `modelOptions` bag with their own sub-controls.

## Phased rollout

### Phase 1 — Register V4 models + schema additions (~2 hours)

- Add the four entries to `MODEL_REGISTRY`.
- Add the optional `maxOutputTokensCap`, `sendThinkingParam`, `reasoningEffort`, `reasoningEcho` fields to `ModelCapabilities` (all non-breaking; V3 entries remain untouched).
- Update `validateCustomModelEntry` to accept (and permissively validate) the new fields.
- Wherever the per-model maxTokens slider reads its upper bound today, fall back from `maxOutputTokensCap` to `maxOutputTokens` so V3 behavior is preserved.
- Add display names. Add deprecation hints to existing chat/reasoner display names ("DeepSeek Chat (V3 — retiring Jul 2026)"). Verify the model dropdown shows them.
- Ensure non-thinking V4 models work end-to-end as a `deepseek-chat` drop-in (they should — the upstream model already accepts the same request shape).

After Phase 1: `deepseek-v4-flash` and `deepseek-v4-pro` selectable and functional; slider tops out at 384K; `-thinking` variants present but functionally identical to non-thinking (we haven't started sending the thinking param yet).

### Phase 2 — Thinking-mode request shape (~2 hours)

In `deepseekClient.ts`, when the active model has `sendThinkingParam: true`:

- Strip the `-thinking` suffix from the model id before sending.
- Add to the request body:
  ```jsonc
  "thinking": { "type": "enabled" },
  "reasoning_effort": "<high|max from settings or registry default>"
  ```
- Omit `temperature`, `top_p`, `presence_penalty`, `frequency_penalty` (V4-thinking rejects these).
- Resolve `reasoning_effort` precedence: `moby.modelOptions.<id>.reasoningEffort` > registry default > `'high'`.

After Phase 2: V4-thinking models functional for **single-turn** conversations. Streaming `reasoning_content` already works via the existing R1 pipeline (`reasoningTokens: 'inline'` triggers it).

### Phase 3 — `reasoning_content` echo on tool turns (~3 hours)

The hard part. V4-thinking returns 400 if a request includes a prior assistant turn that had `tool_calls` and `reasoning_content` is missing. So:

- Audit `ConversationManager` to confirm we keep `reasoning_content` on assistant-with-tool-calls events. Add it if not.
- Update the message-serialization path that builds the API request from history. When `reasoningEcho === 'required'` for the active model AND the assistant turn has tool calls, include `reasoning_content` alongside `content` and `tool_calls`.
- Test that mid-conversation tool loops don't 400.

Existing R1 (`deepseek-reasoner`) doesn't have this requirement (R1 has no tool-calls), so it's not a regression risk for that path. The new code branches on `reasoningEcho === 'required'`.

After Phase 3: V4-thinking with multi-turn tool loops works.

### Phase 3.5 — System prompt minimal variant for V4-thinking (~1.5 hours)

**Motivation.** Today's system prompt is one ~60-line block built in `requestOrchestrator.ts` around the `buildSystemPrompt`/`#systemPrompt` path (line 1075+). It was calibrated for V3 — a model that can't reliably disambiguate "show me an example" from "create a file for me" without an explicit decision tree. V4-thinking with `reasoning_effort=high` runs the prompt through its reasoning pass before acting; verbose instructions cost reasoning tokens, and the prompt's enumeration of edit-trigger phrases ("update foo.ts", "add X", "fix this bug") appears to bias V4 toward edit behavior even on read-only questions.

Observed in [logs/445pm.log], a V4-flash-thinking turn made an `edit_file` adding `aliases: aliases()` to `mix.exs`, immediately reverted it, then attempted a third edit that failed — all in response to a user question about Sudoku board sizes. The model treated a question about an existing project as continuation of an unfinished build. Plausibly the prompt encouraged that read.

**Changes.**

1. Add a new optional capability axis: `promptStyle: 'minimal' | 'standard'`. Defaults to `'standard'` when omitted. V3 / R1 / V4-non-thinking / custom models keep today's prompt unchanged.

2. Set `promptStyle: 'minimal'` on `deepseek-v4-flash-thinking` and `deepseek-v4-pro-thinking`. Pro-thinking shares the flag because `reasoning_effort=max` makes the over-prescriptive prompt even more expensive in reasoning tokens.

3. Refactor the inline system-prompt construction. Extract a `buildSystemPrompt(modelId, editMode, …)` helper that branches on `caps.promptStyle`. Both branches share the same skeleton so future axes (per-mode tool descriptions, web-search hints) compose cleanly.

**Two variants to start:**

| Section | Standard (today) | Minimal (V4-thinking) |
|---|---|---|
| Identity ("You are DeepSeek Moby…") | keep | keep |
| Reference/teaching vs edit-request decision tree | keep | **drop** — V4 infers intent from phrasing |
| Tool list — explore tools | keep with current framing | keep, **neutral framing** ("Tools available:" not "You have tools to") |
| Tool list — modify-workspace tools | keep with current framing | keep, **neutral framing**, drop edit-trigger phrase enumeration |
| Numbered rules 1–5 (paths, terminal actions, delete-vs-create, etc.) | keep all | keep #2 ("trust absolute paths from tool results" — load-bearing per ADR 0004) and #3 ("delete is terminal in the turn" — prevents real bugs); drop the rest |
| Edit-mode descriptor (manual / ask / auto) | keep | keep |
| `# File:` header / SEARCH-REPLACE format guidance | keep (R1 needs it; non-thinking V4 still benefits) | keep — `edit_file`'s structured schema already pushes the right shape, but a one-line reminder costs little |

**Empirical comparison protocol.** Don't ship the minimal variant on intuition alone. Run the same prompts on both styles and compare:

- API call count.
- Total wall time.
- Number of edits attempted vs. number actually needed for the task.
- Whether the response correctness matches user intent.

Test prompts (run on both `promptStyle` values for `deepseek-v4-flash-thinking`):

- **Creation-heavy:** "Build me a sudoku game in Elixir." — should produce a similar number of `write_file` calls in both. Regression is the worst case.
- **Read-only question:** "What does the function `solve/1` in `lib/sudoku/solver.ex` do?" — minimal should not produce any edits; standard sometimes will.
- **Targeted edit:** "Rename the function `foo` to `bar` in `src/file.ts`." — both should produce one `edit_file` with a single search/replace pair.
- **The exact regression:** "Explain Sudoku board sizes" — pointed at an existing Sudoku project. Replays the [445pm.log] over-eager-edit case. Minimal should answer without any edits; standard reproduced the wasted edit + revert.

**Pass criterion.** Minimal must produce same-or-fewer API calls, same-or-fewer attempted edits, with same-or-better response quality across all four prompts. If any test regresses materially (e.g., minimal misses a guardrail and creates the wrong file), the per-test fix is to fold the relevant standard-prompt language back into minimal — not to abandon the variant.

**What we are NOT doing in Phase 3.5.**

- **Per-turn dynamic prompt selection.** The prompt style is fixed by model capability. A future axis could let users override per-session, but adding that machinery before we know the variants are useful is premature.
- **Custom prompt strings in `moby.modelOptions`.** Users can already set `customSystemPrompt` for their custom models; we don't extend that to built-in entries here. Stay scoped to the registry-controlled split.
- **Splitting V3-era guidance from R1-era guidance.** R1 has its own system-prompt path via `getReasonerShellPrompt` already — out of scope.

**Risks and mitigation.**

- *Removing rules that were quietly load-bearing.* Mitigation: keep the two rules with documented incident history (#2 absolute-path rule from ADR 0004; #3 terminal-action rule). For each rule we drop, leave a one-line code comment explaining what it was guarding against, so re-adding is fast if a regression appears.
- *Per-model prompts diverge over time.* Mitigation: shared skeleton in the builder; the two branches are diffs of each other, not parallel rewrites.
- *Empirical results don't show a clear win.* Acceptable outcome — we ship the registry axis but leave V4-thinking on `'standard'` for now, and the infrastructure is in place to revisit.

After Phase 3.5: V4-thinking models use a prompt calibrated for reasoning-style models. V3 / R1 / V4-non-thinking / custom models unchanged. The capability axis is reusable for any future model that wants its own prompt flavor.

**Status (2026-04-25):** Code changes shipped — capability axis, V4-thinking entries flipped to `'minimal'`, both prompt variants live. The formal four-prompt empirical comparison is deferred to the manual-test backlog as future validation; the trigger to run it is a real-world V4-thinking turn that misbehaves in a way the standard prompt would have caught (e.g., creating files on a "show me" question, ignoring a clarifying-question opportunity). Initial real-turn evidence on `'minimal'` is positive — the Sudoku-Elixir build (6:03pm log) handled 31 tool calls cleanly with three successful `edit_file` patches and no thrash, comparing favorably to the prior pre-refactor turns where `apply_code_edit` + the destructive-merge fallback produced repeated failures.

### Phase 3.75 — `run_shell` tool for native-tool models (~3 hours)

**Motivation.** V4 has a meaningful capability gap relative to peer tools: it can read `package.json` and infer the test command, but can't execute it. It can write code, but can't verify the code compiles. Every other framework targeting developer use cases — Claude Code, Cursor, Cline, Aider — exposes shell as a first-class tool. R1 has shell via the `<shell>` XML transport (because R1 lacks native tool calling), but V4 / V3-chat / native-tool custom models don't. This is the single highest-leverage capability we could add — common follow-up tasks like "run the tests", "format the code", "install this dependency", "run git status" currently break the loop and force the user to leave the chat to run the command themselves.

**The infrastructure already exists.** `CommandApprovalManager`, `executeShellCommands`, the approval UI, the `LONG_RUNNING_PATTERNS` list, the `BLOCKED_PATTERNS` blocklist, the `allowAllShellCommands` bypass, the shell-result dropdown UI — all of this is wired and serves R1's `<shell>` path today. We're not building new safety machinery, we're routing native tool calls into existing safety machinery.

**Threat-model note.** Shell is the only tool with unbounded harm. Approval is the line of defense. The threat surface for V4 isn't worse than R1's today: prompt injection attacks against shell already exist via R1's `<shell>` transport, and they hit the same approval gate. We're not opening new attack surface, just letting more models reach the existing gate.

**Capability axis update.** `shellProtocol` gains a third value: `'xml-shell' | 'native-tool' | 'none'`.

| Value | Models | Transport |
|---|---|---|
| `'xml-shell'` | `deepseek-reasoner` (R1) | Parses `<shell>...</shell>` tags from content; existing path. |
| `'native-tool'` | `deepseek-chat`, `deepseek-v4-flash[-thinking]`, `deepseek-v4-pro[-thinking]`, custom models with `toolCalling: 'native'` | New: `run_shell` tool in the OpenAI-compat `tools` array. |
| `'none'` | Reserved — currently unused | No shell access. |

The orchestrator's tool-array assembly conditionally includes `runShellTool` when `caps.shellProtocol === 'native-tool'`. Same dispatcher pattern as the existing edit/file tools.

**Tool schema.**

```ts
export const runShellTool: Tool = {
  type: 'function',
  function: {
    name: 'run_shell',
    description:
      'Run a shell command in the workspace and return its output. ' +
      'Use this for actions that have no dedicated tool: running tests, ' +
      'compiling, installing dependencies, git operations, etc. ' +
      'Long-running commands (servers, watch modes, REPLs) are refused — ' +
      'the result will tell you to ask the user to run them manually. ' +
      'In ask mode, each command requires user approval before executing.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute. A single command line; chain with `&&` if you need multiple steps.'
        },
        description: {
          type: 'string',
          description: 'Brief description of what this command does, shown to the user during approval.'
        }
      },
      required: ['command']
    }
  }
};
```

**Dispatch path.** Mirrors the existing `<shell>` flow with one less parsing step:

1. Model emits a `run_shell` tool call.
2. Orchestrator's `runToolLoop` recognizes the name; passes the `command` string into the existing `parseShellCommands` (via a single-command shim), the `CommandApprovalManager.requestApproval` flow, and `executeShellCommands` with the same long-running-detection guard.
3. The captured stdout/stderr + file-watcher diff (modified/deleted files) is formatted via `formatShellResultsForContext` — identical to R1 — so the assistant gets the same absolute-path ground truth (ADR 0004 B-pattern).
4. Activity indicator: `pushTurnActivity('shell', `Running ${preview}`)` — same UI as R1's inline shell.

No new approval machinery. No new output capture. No new UI components. Just one new tool entry that funnels into the existing pipeline.

**Prompt updates.** Both `MINIMAL` and `STANDARD` variants gain one line under the modify-workspace section:

> `- run_shell: Run a shell command in the workspace (tests, builds, git, etc.). Long-running commands (servers, watch modes) are refused.`

Standard variant additionally adds a rule:

> *Use the dedicated tool when one exists — `read_file` not `cat`, `find_files` not `find`, `grep` not `grep`. Reach for `run_shell` when no dedicated tool fits (running tests, building, git operations, installing deps).*

Minimal variant skips the rule — V4-thinking can infer this from the tool descriptions.

**System-prompt scope question.** R1's prompt (via `getReasonerShellPrompt`) is unchanged. R1 keeps `<shell>` and the existing path-semantics rules from ADR 0004. Phase 3.75 does not touch R1.

**What we are NOT doing in Phase 3.75.**

- **Per-turn shell toggle.** Always-on for native-tool models; user can suppress via `allowAllShellCommands` setting flip or by clearing rules. Reserved for a future plan if telemetry shows users want finer control.
- **Streaming shell output.** Output captures fully before being sent back to the model. Live streaming of long-running output is deferred — most useful commands (test, build, git) finish in seconds.
- **Interactive shell sessions.** No persistent shell, no stdin. Each `run_shell` call is a fresh invocation, same as R1's existing semantics. Persistent cwd would be its own ADR.
- **Per-OS shell selection beyond what `resolveShell()` already does.** Existing logic (Git Bash on Windows, default shell elsewhere) covers the standard cases.

**Risks and mitigation.**

- *Models call `run_shell` for things tools cover better.* (e.g., `cat foo.ts` instead of `read_file`.) Mitigation: explicit guidance in the standard prompt, descriptions in the tool schema. Empirical: watch for it in real turns and tighten the prompt if it persists.
- *Tool-def overhead.* `run_shell` adds ~200 tokens to every request that includes the tools array. Acceptable cost for the capability lift.
- *Approval-flow fatigue.* Users in ask mode get prompted on every command. Existing mitigations (per-prefix allow/block rules, `allowAllShellCommands` bypass) already address this for R1; same behavior carries over.

**Manual test backlog entries (post-ship):**

- T1: V4-flash-thinking turn that needs to run tests — verify model picks `run_shell`, command appears in approval UI, output flows back into the conversation.
- T2: Long-running detection still rejects `npm run dev` / `flask run` / etc. via `LONG_RUNNING_PATTERNS`.
- T3: `allowAllShellCommands=true` bypasses approval for native-tool path same as for R1.
- T4: File-watcher diff (modified/deleted files) appears in the tool result with absolute paths — ADR 0004 B-pattern preserved.
- T5: Interrupt during shell execution (user clicks stop) cancels cleanly — same path R1 uses.
- T6: Custom model with `toolCalling: 'native'` and `shellProtocol: 'native-tool'` (e.g., a Qwen-Coder template) gets `run_shell` automatically.

After Phase 3.75: V4 / V3-chat / native-tool custom models can run tests, build code, do git operations, install dependencies, and recover from compile errors mid-turn. R1's path is unchanged.

### Phase 4 — `reasoningEffort` UI + per-model override (~2 hours)

- Add `moby.modelOptions` schema to `package.json`.
- In `ModelSelectorShadowActor`, render the sub-control under the active model when it has `reasoningEffort`.
- Wire the click handler to write `moby.modelOptions.<id>.reasoningEffort`.
- Hot-reload via the existing config-change listener (already set up to refresh on `moby.customModels`).

After Phase 4: full UX for swapping between high and max effort per model.

### Phase 5 — Polish (~1 hour)

- Update [docs/guides/custom-models.md](../guides/custom-models.md) field reference with the three new optional axes.
- Update display-name deprecation hints.
- Add a manual-test backlog entry covering: (a) plain V4 chat, (b) V4-thinking single turn, (c) V4-thinking multi-turn with tools, (d) reasoningEffort high vs max behavior diff.
- Stats modal — show DeepSeek pricing (we know V4 numbers now). Optional, separate ticket if it grows.

## Tokenizer

**Decision: keep `tokenizer: 'deepseek-v3'` for all V4 entries.**

Rationale: V4 doesn't ship standard tokenizer files (no `tokenizer.json`, `vocab.json`, `merges.txt`). What's published is a custom Python encoder ([encoding/encoding_dsv4.py](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro/tree/main/encoding)). Extracting a JSON vocab from it is a non-trivial one-shot task, and the result would need re-extracting on every encoder update during the preview period.

Community reports the tokenizer is "compatible" — same 128K base vocab plus a handful of new special tokens for context construction. Worst-case our exact counter under-tokenizes the new specials (counts each as multiple bytes via fallback), giving single-digit token errors on typical 5K-token requests. Inside our existing estimation noise.

`DynamicTokenCounter` self-calibrates from `usage.prompt_tokens` regardless, so a small static error gets corrected over the conversation.

When V4 leaves preview and stabilizes (or earlier if the error compounds in practice), we extract the vocab and ship `deepseek-v4.json.br`. Whether to ship as a strict superset of V3 (one combined file) depends on diffing the BPE merges and pre-tokenizer regex — verifiable when we extract.

## XML shell loop — keep, permanently

The V4-thinking native tool calling makes the `<shell>...</shell>` XML transport *unnecessary for V4*. But it stays in the codebase **forever** because it's a transport, not a model detail:

- Local R1 (or self-hosted derivatives) keep needing it.
- Local llama.cpp builds without tool-calling support need it.
- Future base instruction models that haven't been fine-tuned for `tool_calls` need it.

The capability registry already expresses this correctly: V4 entries set `shellProtocol: 'none'`; R1 stays `shellProtocol: 'xml-shell'`. No code path changes for the XML loop itself — it just serves fewer model entries by default.

## Web search

DeepSeek V4 does **not** ship a native `web_search` tool. Our existing `webSearchTool` (routed through Tavily / SearXNG via the registry) remains how V4 searches the web. In our `webSearch` capability axis (from [web-search-providers.md](./web-search-providers.md)), V4 is `'provider-tool'` — same as `deepseek-chat`. The `'model-native'` path remains reserved for Groq / Kimi / OpenAI Responses-API.

This is a simplification: zero new web-search wiring for V4.

## What we are NOT doing in this plan

- **Adding `reasoning_effort: 'max'` auto-escalation heuristics.** Static defaults + user override. Heuristic-driven escalation (e.g., "if tools present, use max") is a follow-up if telemetry shows users want it.
- **Removing the V3 chat/reasoner registry entries.** They keep working until 2026-07-24. Just add deprecation hints to display names. Final removal is a separate, dated PR closer to the cutoff.
- **Stats-modal V4 pricing display.** Mentioned in Phase 5 but easy to skip if it grows. Functionally orthogonal to the integration.
- **Extracting and shipping a V4-specific tokenizer vocab.** Deferred until the preview stabilizes or accuracy becomes a concrete pain point.
- **Per-turn thinking toggle.** Re-evaluate after Phase 5 ships and we have data on how users actually use the `-thinking` vs non-thinking variants. See "Open questions" for the three designs we'd pick from.

## Open questions

- **Does `reasoning_effort: "max"` actually slow down or change cost on the API side?** The docs say it changes behavior; we don't yet know the latency / cost delta empirically. Worth measuring once Phase 2 ships and we can run real requests.
- **What does V4 return on `usage` when in thinking mode?** Specifically: are reasoning tokens counted against output tokens? Does `usage.completion_tokens_details` exist with a breakdown? Affects how we display token counts in the stats modal.
- **Does V4 support strict JSON-schema tool calls?** Phase 1 doesn't need this; if it does, future tools that require strict shape compliance (image generation, structured extraction) get cleaner.
- **Long-term: should we surface a thinking/non-thinking toggle in the chat UI?** Today users pick `-thinking` vs non-thinking variants from the dropdown. Three options:
  - **A. Two model entries per upstream model** (current plan). Trivial — already done by registry config. Cost: 4 model rows in the dropdown for 2 underlying models.
  - **B. One entry, session-level toggle.** Pick `deepseek-v4-flash`, then a "thinking" toggle that persists for the session. ~4-6 hours: dynamic capability resolution, session-scoped storage of the mode flag, edit-mode/temperature/limits all resolve dynamically per turn, small UI control.
  - **C. One entry, per-turn toggle.** Toggle near the send button; defaults back next turn. Same complexity as B; storage shifts from session-scoped flag to a one-shot pipeline parameter. `reasoningEcho` already handles the mixed-mode history correctly.

  Lean toward (C) eventually if we go this route — most flexible for negligible architectural cost. But (A) is right for shipping now: zero new code paths, and we don't yet know whether users want to toggle per-turn or just pick a tier and stick with it. Re-evaluate after Phase 5 ships and we have telemetry on how the variants get used.

## Migration considerations for existing users

- **Sessions started on `deepseek-chat`** continue to work — the upstream now routes to `deepseek-v4-flash`. No user action needed pre-July.
- **Sessions started on `deepseek-reasoner`** continue too. R1's XML-shell behavior is unchanged.
- **After 2026-07-24**, both old IDs return errors. Closer to that date we ship a one-time migration: detect any `moby.model` set to a retired id and prompt the user to pick a V4 equivalent. Or auto-rewrite to the suggested replacement and surface a notification.
- **`maxTokensChatModel` / `maxTokensReasonerModel` settings** are tied to the old model IDs by `maxTokensConfigKey`. V4 entries get their own keys (`maxTokensV4Flash`, `maxTokensV4Pro`, etc.). Migration of the values isn't critical — registry defaults are reasonable.

## Risks

- **Phase 3 (`reasoning_content` echo) is the only place we write meaningfully new code.** Risk: subtle history-serialization bug that only manifests in multi-turn tool loops. Mitigation: dedicated test scenario in the manual-test backlog before shipping; existing unit tests for `ConversationManager` cover the data-model path.
- **Tokenizer drift.** If V4's actual encoder diverges meaningfully from V3 during preview, our token counts get steadily wrong. Mitigation: `DynamicTokenCounter` self-calibrates from `usage.prompt_tokens` over conversation lifetime, so the error bounds itself.
- **Server-side thinking mode quirks.** The docs warn `temperature` is silently rejected; some clients have reported edge cases where the API returns a 400 if you forget to omit it. Mitigation: explicit omission in the request builder, not optimistic-include.

## Related

- [model-capability-registry.md](./model-capability-registry.md) — the registry pattern this builds on.
- [web-search-providers.md](./web-search-providers.md) — web-search axis context (V4 lands as `'provider-tool'`).
- [DeepSeek V4 Preview Release announcement](https://api-docs.deepseek.com/news/news260424)
- [DeepSeek Thinking Mode API guide](https://api-docs.deepseek.com/guides/thinking_mode)
- [DeepSeek Function Calling guide](https://api-docs.deepseek.com/guides/function_calling)
- [DeepSeek streaming reasoning_content guide](https://api-docs.deepseek.com/guides/reasoning_model_api_example_streaming)
