# Subagent routing for protected main context

**Status:** Not started — design draft.
**Date:** 2026-04-29

## Context

The main agent loop pays for context twice: once when it sends a prompt and once when the model rebuilds working memory from that prompt. Several common operations don't need the main model's reasoning at all but currently consume its context:

1. **Search digestion.** [`grep`](../../src/tools/workspaceTools.ts#L80) returns 50+ matches across many files. The main model reads all of them, then picks 3 that matter. The other 47 are dead weight in context for the rest of the turn.
2. **File summarization.** Large file (1000+ lines) where the model needs an overview, not the source. Reading the whole file costs ~10K tokens; a 500-token symbolic summary covers the actual need.
3. **Tool-result classification.** Was the shell command a real failure, a transient hiccup, or a success with stderr noise? Currently the main model parses the full output to decide.
4. **Stack trace / build error parsing.** A wall of compiler output where one line is the actionable signal. Model reads everything, finds the line, ignores the rest.

These are all *digest* operations: take a verbose input, produce a focused output. The right model for them is small, cheap, and fast — not the same model doing the strategic reasoning. Doing them with the main model is the architectural equivalent of running everything on the GPU when most of it should be on CPU.

The subagent pattern is well-established (Claude Code's `Agent` tool, Aider's repo-map summarization, token-savior's progressive disclosure layers). What's missing for Moby is the routing infrastructure — a way to send specific tool calls to a different model, get back a digest, and never let the verbose intermediate state touch the main context.

The capability registry from [model-capability-registry.md](completed/model-capability-registry.md) sets up the right place to declare "this model handles role X." The work in this plan extends that registry with a `role` axis and adds a routing layer that uses it.

## Decision

Introduce three concepts:

1. **Subagent role** — a class of work that can be delegated. Initial roles: `search-digest`, `file-summarize`, `tool-classify`. Each has a stable prompt template and structured output schema.
2. **Role assignment** — a registry mapping from role to model. Multiple models can be eligible; the user picks which model handles each role via settings.
3. **Routing layer** — when a tool call would benefit from delegation, the orchestrator routes it through the assigned subagent model, captures the structured output, and surfaces only the digest to the main model.

Routing happens *under* the tool surface. The main model calls `grep("authMiddleware")` like normal; the orchestrator decides whether to route through a subagent. The main model's prompt and tool list don't change. This is the **tool-routing** pattern, not the **delegation** pattern (where the main model would explicitly call `delegate_to_subagent`). Tool-routing keeps the main prompt simple at the cost of less flexibility — the right tradeoff for a starting design.

### Why tool-routing over delegation

- **Zero main-prompt overhead.** Delegation requires describing every subagent in the system prompt; ~200 tokens per role just to advertise them.
- **No new model behavior to learn.** Main model keeps calling tools it already knows. Routing is invisible.
- **Failure handling is transparent.** Sub fails → fall back to direct tool call without bouncing back to the main model. With delegation, a failed delegation is a tool call the main model has to interpret.

The tradeoff: tool-routing is less flexible. The main model can't say "this is a hard search, do it yourself" — every grep goes through the sub. We accept this. If real usage shows the rigidity hurts, a `delegate_to_subagent` escape hatch can be added later as an additional tool, not a replacement.

## Subagent roles

### `web-search-digest`

**Trigger:** every `web_search` call whose response holds more than ~3 results OR > 1.5KB of cumulative `content` bytes. Below threshold, raw response passes through.

**Sub input:** the normalized `WebSearchResponse` (`{results: WebSearchResult[], answer?, query, responseTime}` from [src/clients/webSearchProvider.ts](../../src/clients/webSearchProvider.ts) — backend-agnostic; Tavily and SearXNG both produce this shape) + the user's recent prompt as task context.

**Sub output (JSON):**
```ts
{
  rankedResults: Array<{
    title: string;
    url: string;
    snippet: string;        // condensed from original content; ≤2 sentences
    reason: string;         // why this matters for the user's task
  }>;
  refinedAnswer?: string;   // upstream answer, refined or pass-through
  discardedCount: number;
}
```

**Main model sees:** the formatted digest with top 3–5 ranked results + a one-line note that `discardedCount` other results were considered.

**Schema validation:** strict JSON schema. Fall back to the original formatted search results on validation failure.

**Insertion point:** inside `webSearchManager.searchByQuery()` ([src/providers/webSearchManager.ts](../../src/providers/webSearchManager.ts)) — between the raw `WebSearchResponse` returned by the provider and `formatSearchResults()`. Keeps router inside the manager that owns web-search formatting; orchestrator stays unaware.

### `search-digest`

**Trigger:** `grep` results exceed a threshold (default: > 10 matches OR > 2KB of result text).

**Sub input:** the full grep result + the original query + (optional) the user's recent prompt as task context.

**Sub output (JSON):**
```ts
{
  relevantMatches: Array<{
    file: string;
    line: number;
    snippet: string;
    reason: string;  // why this is relevant to the query
  }>;
  irrelevantPattern?: string;  // if many matches share an obvious-irrelevant pattern, name it (e.g., "test fixtures")
  totalSeen: number;
}
```

**Main model sees:** the formatted digest with the top relevant matches + a one-line note that the sub looked at all `totalSeen` results.

**Schema validation:** strict JSON schema. Fall back to direct grep if validation fails.

### `file-summarize`

**Trigger:** model calls `read_file` on a file > 500 lines without `startLine`/`endLine`. Or, a new explicit tool `summarize_file(path)`.

**Sub input:** full file contents + the user's recent prompt as task context.

**Sub output (JSON):**
```ts
{
  symbolMap: Array<{ name: string; kind: 'function' | 'class' | 'export' | ...; line: number }>;
  abstractions: string[];   // 3–5 bullet "what this file does"
  keyDependencies: string[];
  suggestedReadRanges: Array<{ start: number; end: number; reason: string }>;
}
```

**Main model sees:** the summary, with explicit "if you need to read more, here are the suggested ranges." Encourages targeted follow-up reads instead of full re-reads.

**Heuristic gate:** only triggers when file is large AND task isn't an edit. For edits, the main model still gets the full file (truncation harms edit accuracy more than reading harms context).

### `tool-classify`

**Trigger:** every `run_shell` result. Cheap enough to always run.

**Sub input:** stdout + stderr + exit code + the command itself.

**Sub output (JSON):**
```ts
{
  status: 'success' | 'failure' | 'transient' | 'partial';
  actionable_summary: string;  // one sentence
  signal_lines: string[];      // up to 5 lines containing the actionable info
  noise_pattern?: string;      // optional name for the noisy bulk
}
```

**Main model sees:** the structured classification + signal lines, instead of the full output. Full output remains available via a follow-up "show me the full output" tool if needed.

**Cautious deployment:** opt-in per session. Tool-classify is the role with the highest blast radius (silently dropping output the main model needed). Ship behind a setting before defaulting on.

### `image-describe`

**Shape note:** unlike the three roles above, this is a *capability bridge* (modality conversion), not a *digest* (compression). The main model lacks vision; the subagent provides it. No size threshold — always routes when configured and an image enters context.

**Trigger:** main model is non-vision AND an image enters context. Three paths:
1. User attaches an image to chat (paste screenshot, drag-drop file).
2. Main model calls `read_file` on a path with image extension (`.png|.jpg|.jpeg|.webp|.gif`).
3. New explicit `describe_image(path, focus?)` tool, optional first ship.

**Sub input:** image bytes + the user's recent prompt as task context + (optional) caller-supplied focus hint (e.g. "what error message does this dialog show?").

**Sub output (JSON):**
```ts
{
  description: string;            // 2–5 sentence overall summary
  detectedKind: 'screenshot' | 'diagram' | 'photo' | 'code' | 'chart' | 'other';
  textContent?: string;           // OCR-extracted text if present
  uiElements?: Array<{            // populated when detectedKind === 'screenshot'
    label: string;
    kind: 'button' | 'input' | 'menu' | 'error' | 'heading' | 'other';
    text?: string;
  }>;
  notableColors?: string[];       // accent / error colors etc., if relevant to task
}
```

**Main model sees:** the structured description with an explicit `[Image processed by vision subagent: <model-id>]` prefix, so the model knows the description is second-hand and can ask for re-description with a different focus if needed.

**Failure mode:** no vision-capable subagent configured AND main model is non-vision → tool returns an error message naming the missing capability and pointing at the `moby.subagents.image-describe` setting. Don't silently drop the image — silent drops here are worse than digest silent drops because the user sees an attached image in their UI and assumes the model saw it.

**Why this role differs architecturally:** input is binary (image bytes), not text. Each provider's transport adapter needs a multimodal-encode path:
- Anthropic: `{type: 'image', source: {type: 'base64', media_type, data}}`
- OpenAI / OpenAI-compatible: `{type: 'image_url', image_url: {url: 'data:image/png;base64,…'}}`
- Ollama: `images: [base64]` array on the message
The `SubagentRouter` stays generic; the encoder lives per-provider.

## Capability axis additions

```ts
interface ModelCapabilities {
  // ... existing fields ...

  /** Roles this model can serve as a subagent. Empty/absent = main-only.
   *  A model can declare multiple roles; the routing layer picks based
   *  on user assignment in settings. */
  subagentRoles?: Array<'web-search-digest' | 'search-digest' | 'file-summarize' | 'tool-classify' | 'image-describe'>;

  /** Model accepts image inputs in multimodal requests. Required to be
   *  eligible for the `image-describe` role; settings UI filters on this. */
  acceptsImages?: boolean;
}
```

```jsonc
// Example user settings.json:
"moby.subagents": {
  "search-digest":     "deepseek-v4-flash-thinking",
  "web-search-digest": "deepseek-v4-flash-thinking",
  "file-summarize":    "deepseek-v4-flash-thinking",
  "tool-classify":     "deepseek-v4-flash-thinking",
  "image-describe":    "claude-haiku-4-5"      // first non-DeepSeek subagent — main use of cross-provider plumbing
}
```

Each role can be set to a model id from the registry, or `"off"` to disable routing for that role.

## Architecture

```
┌─ main agent loop (requestOrchestrator) ───────────────────┐
│                                                            │
│   model emits tool_call: grep("authMiddleware")            │
│                                                            │
│   ┌─ tool dispatcher (workspaceTools.executeToolCall) ─┐  │
│   │                                                    │  │
│   │   1. execute the tool (real grep)                  │  │
│   │   2. check if router would route (size threshold)  │  │
│   │   3. if yes → SubagentRouter.process(role, input)  │  │
│   │   4. return either raw result OR digest            │  │
│   │                                                    │  │
│   └────────────────────────────────────────────────────┘  │
│                                                            │
└────────────────────────────────────────────────────────────┘
                             │
                             ▼
   ┌─ SubagentRouter ──────────────────────────────────────┐
   │   - resolve role → modelId from settings              │
   │   - load role's prompt template                       │
   │   - call model via existing DeepSeekClient (different │
   │     model param + structured-output config)           │
   │   - validate JSON output against role schema          │
   │   - on validation failure: log + return raw input     │
   │   - on success: format digest for main model          │
   └────────────────────────────────────────────────────────┘
```

**New module: `src/subagents/`**

```
subagents/
  router.ts          — SubagentRouter class; role resolution + dispatch
  roles/
    searchDigest.ts  — prompt template + zod schema + formatter
    fileSummarize.ts — same shape
    toolClassify.ts  — same shape
  types.ts           — Role, SubagentInput, SubagentResult shapes
```

Each role is a self-contained module exporting a stable interface:

```ts
interface SubagentRole<TInput, TOutput> {
  name: string;
  shouldRoute(input: TInput): boolean;
  buildPrompt(input: TInput, taskContext: string): string;
  schema: ZodSchema<TOutput>;
  formatForMain(output: TOutput, originalInput: TInput): string;
}
```

The router is generic over roles — adding a new role is a new module + a registry entry, no router changes.

## Phases

### Phase 1 — `web-search-digest` only ✅ Smallest viable slice

**Goal:** prove the routing pattern end-to-end on the most isolated tool surface in the codebase, with one model (`deepseek-v4-flash-thinking`), no new infrastructure.

**Why `web-search-digest` first:** smallest scope of any digest candidate.
- Exactly one tool (`web_search`) in scope — not a "search" umbrella that spans grep / find_files / find_symbol with a fuzzy boundary (see Open questions for the scope debate).
- Result shape is fully normalized at [src/clients/webSearchProvider.ts](../../src/clients/webSearchProvider.ts) — Tavily and SearXNG both produce the same `WebSearchResponse`, so the role module is backend-agnostic.
- Insertion point is local to `webSearchManager.searchByQuery()` — no orchestrator changes, no tool-dispatch refactor.
- Failure mode is benign — if the digest is wrong, main model still gets correct (raw) search results on the fallback path; nothing is lost.

**Why V4-flash-thinking first:** same provider as main models. No new endpoint config. Same `DeepSeekClient` infrastructure. JSON mode already wired via `chatWithJsonOutput`. Validates the routing pattern *before* introducing local-model variability or cross-provider plumbing.

**Work:**
- New `src/subagents/` module structure with `router.ts`, `roles/webSearchDigest.ts`, `types.ts`.
- Add `subagentRoles?: Array<...>` to `ModelCapabilities` (after the existing `lspTools?` field, mirroring the same opt-in convention). Set `subagentRoles: ['web-search-digest']` on the `deepseek-v4-flash-thinking` entry in [src/models/registry.ts](../../src/models/registry.ts).
- Add `moby.subagents` setting schema in `package.json` with default `{"web-search-digest": "off"}` (off until user opts in).
- Wire `SubagentRouter` into `webSearchManager.searchByQuery()` ([src/providers/webSearchManager.ts](../../src/providers/webSearchManager.ts)) — between the raw `WebSearchResponse` returned by the provider and `formatSearchResults()`. Router stays inside the manager that owns formatting; orchestrator stays unaware.
- Use `DeepSeekClient` with structured output via `chatWithJsonOutput` ([src/deepseekClient.ts:791](../../src/deepseekClient.ts#L791)) — JSON mode is already wired, no `response_format` plumbing PR needed.
- **Subagent client lifecycle:** instantiate a *separate* `DeepSeekClient` per subagent modelId (lazy-created on first route, cached per-modelId for the session). Do not mutate the main client's `modelOverride` — that would race with the streaming main loop. Router holds its own client cache.
- **Failure model:** every fallback path (settings off, threshold miss, schema validation fail, sub-call timeout, sub-API error) returns the raw `WebSearchResponse` formatted as today. Main model never knows whether routing happened. Trace logs capture every call for debugging.
- Tests: 9 unit tests + 1 integration test (see plan-internal test list — covers threshold, schema pass/fail, timeout, settings off/on, model resolution, per-modelId client cache, task-context propagation, trace event shape, end-to-end with mocked transport).
- Manual-test backlog: 3 entries — large web search gets digested, small search bypasses, sub failure falls back gracefully and is visible in trace logs.

**Acceptance:** with `moby.subagents.web-search-digest = "deepseek-v4-flash-thinking"`, a `web_search` returning 8+ results gets routed through V4-flash-thinking and the main model sees a 3–5 result digest instead. Same task completes in fewer main-model tokens. No regression with `"off"`. Backend (Tavily or SearXNG) makes no difference to digest behavior.

### Phase 1 polish — manual-mode wiring + UX controls + tuning

**Goal:** close the gaps surfaced by first-ship dev-host testing. Phase 1 wired the auto-mode `web_search` tool path only; first real session showed manual ("forced") mode skipped routing entirely and that the role's hard-coded thresholds + max-results were too aggressive for typical SearXNG-basic responses.

**Why a polish slice instead of a new phase:** infrastructure is already in place (router, role, settings schema, capability axis). These items are tuning and hookup only — no new abstractions.

**Work:**

- **Manual-mode router wire.** `webSearchManager.searchForMessage()` (used when the user explicitly toggles search on for a turn — `mode === 'manual' && enabled`) currently bypasses routing because the original Phase 1 plan only enumerated the auto-mode tool path. Wire the router between dedup and `formatMultiSearchResults`. Build a synthetic `WebSearchResponse` from the deduped merged results so one sub call covers all parallel searches; on `routed: false` fall back to `formatMultiSearchResults` output exactly as today.
- **Web-search popup additions** (lives in [media/](media/) — webview surface):
  - **Subagent on/off checkbox.** Toggles `moby.subagents.web-search-digest` between the user's chosen model id and `"off"`. Default off. When enabled with no prior model picked, defaults to the active main-loop model id (which may or may not be eligible — router silently falls back if it isn't, see [Phase 1 failure model](#phases)).
  - **Model dropdown.** Same registered-model list as the new-session model selector (`getAllRegisteredModels()`). Pick which model handles the digest. No filter on `subagentRoles` — router gracefully handles ineligible picks. Power users can still set obscure model ids via raw settings.
  - **Max results slider.** New setting `moby.subagents.webSearchDigest.maxResults` (default 5, range 1–10). The role uses this to override the hard-coded `MAX_DIGEST_RESULTS` constant. Maps to user mental model: "5 raw results in, N most relevant out."
- **Threshold tuning.** Bump `THRESHOLD_RESULT_COUNT` to `> 5` and `THRESHOLD_TOTAL_BYTES` to `> 3000`. Observed first-session data: 5-result Tavily basic responses (~1500B raw) produced ~zero compression (digest was same size or larger than raw). Routing those was pure overhead. New thresholds skip them; only larger-payload searches (Tavily advanced, SearXNG with verbose engines) get digested. Could also become user-tunable in a follow-up if real usage warrants.
- **Tighter role prompt.** Current prompt allows "≤2 sentence" snippets; sub interpreted that loosely. Switch to "Pick at most {maxResults} results. Snippet ≤1 sentence (~100 chars). Drop the rest." Forces real compression even at smaller input sizes.
- Tests: extend `tests/unit/subagents/roles/webSearchDigest.test.ts` with maxResults override, prompt-changes assertion. Add manual-mode routing test in `tests/unit/providers/` (or a new `webSearchManager.subagent.test.ts`) covering: routed → digest returned; off → `formatMultiSearchResults` output; sub fails → fallback.
- Manual-test backlog: 2 entries — manual-mode (forced) search routes when checkbox on, slider value reflects in digest size.

**Acceptance:** popup exposes checkbox + dropdown + slider; toggling them updates settings live and changes next search behavior accordingly. Manual-mode (forced) search routes through subagent when enabled. Threshold change visible in trace logs (small searches now show no `subagent.route` span at all).

### Phase 1.75 — non-thinking V4-flash variant for sub use

**Goal:** cut subagent latency by 2–3x using a true non-thinking model variant, after first-session data confirmed thinking-mode reasoning was the dominant per-call cost.

**Why this slice:** Phase 1+polish data showed subagent calls land in 4–7s range, with 457–1527 chars of reasoning per call. The digest task (rank N results, write 1-sentence snippets) doesn't need reasoning — it's pure output formatting. Cutting reasoning should give same compression in much less wall time.

**Why we missed this earlier:** the original V4 integration tested `model: "deepseek-v4-flash"` with no `thinking` param and observed reasoning still emitted. Concluded "non-thinking V4 doesn't actually exist." Wrong conclusion — DeepSeek's API defaults the `thinking` param to `enabled` when omitted. The documented mechanism is to send `thinking: {"type": "disabled"}` explicitly. Confirmed empirically 2026-05-15 — request returns no `reasoning_content`, fast wall time. See [api-docs.deepseek.com Thinking Mode guide](https://api-docs.deepseek.com/guides/thinking_mode).

**Work:**
- **Capability axis change.** Today's `sendThinkingParam?: boolean` injects `{thinking: {type: 'enabled'}}` when true. Two options:
  - **A. Tri-state field.** Convert to `sendThinkingParam?: 'enabled' | 'disabled'`. Cleaner — one field captures all three states (omitted, enabled, disabled). Touches a handful of call sites in `deepseekClient.applyThinkingMode`.
  - **B. New mutually-exclusive field.** Keep boolean, add `disableThinking?: boolean` for the `{type: 'disabled'}` case. No breaking change but two fields for one concept.
  - Recommend A.
- **New registry entry.** Add `deepseek-v4-flash` (no `-thinking` suffix) with `sendThinkingParam: 'disabled'`, no `reasoningEffort`, no `reasoningEcho`. Display name "DeepSeek V4 Flash (Non-thinking)". Tag `subagentRoles: ['web-search-digest']`.
- **Also tag `deepseek-v4-pro-thinking` with `subagentRoles: ['web-search-digest']`.** Lets users pick the higher-quality (more expensive) variant from the popup dropdown if they want better digestion. Currently the dropdown shows it but the router rejects it.
- **No webview changes needed** — popup dropdown already lists all registered models; eligibility is enforced at route time.
- Tests: capability axis change → unit tests for `applyThinkingMode` with both `'enabled'` and `'disabled'`. Registry entry validation. Sub-routing test with the new model id.
- Manual-test backlog: 1 entry — pick `deepseek-v4-flash` (non-thinking) in popup dropdown, run a search, confirm trace `subagent.route` span has shorter `durationMs` than the thinking variant on a comparable input.

**Acceptance:** with `moby.subagents.web-search-digest = "deepseek-v4-flash"` (the new non-thinking entry), web-search routing produces digests of comparable quality to V4-flash-thinking but in 1.5–2.5s instead of 4–7s. No reasoning chars in trace logs for sub calls.

### Phase 2 — `image-describe` (capability bridge)

**Goal:** unblock vision use cases for non-vision main models (DeepSeek V3/R1/V4 today, future text-only models tomorrow). User can paste a screenshot or attach an image and get useful behavior even when their chosen main model is blind.

**Why this comes after Phase 1:** routing scaffolding from Phase 1 must be stable. `image-describe` reuses `SubagentRouter` and the role-module shape, so it validates that the abstraction generalizes from a pure-digest role (Phase 1) to a capability-bridge role.

**Why this before `search-digest` / `file-summarize` / `tool-classify`:** acute user-visible gap (DeepSeek users currently cannot use screenshots at all), and forces cross-provider plumbing to be sorted out before more roles accumulate that silently assume a DeepSeek-only world.

**Prerequisites:**
- `apiEndpoint` plumbing from [model-capability-registry F1+F3](completed/model-capability-registry.md#f1--wire-apiendpoint-through-deepseekclient) — same prerequisite as the local-model phase, pulled forward. Without it, no non-DeepSeek subagent can be reached.
- A multimodal-encode path per provider transport adapter (see role section above for the three shapes).

**Work:**
- New `roles/imageDescribe.ts` module with prompt template + zod schema + formatter. Differs from digest roles in that input is binary; everything else fits the same `SubagentRole` interface.
- Add `acceptsImages?: boolean` to `ModelCapabilities`. Tag eligible cloud models (Claude Haiku 4.5, GPT-4o-mini, Gemini Flash) and at least one local option (Qwen2.5-VL-7B via Ollama).
- Add `'image-describe'` to the `subagentRoles` union and the settings schema.
- Webview chat input: accept image paste / drag-drop. If scope is too big for first ship, defer the UI piece and ship only the `read_file`-on-image-path trigger — covers the model-initiated case and lets us validate the routing end-to-end before expanding the UI.
- Wire image detection into `read_file` ([workspaceTools.ts](../../src/tools/workspaceTools.ts)) — extension dispatch routes through router when path has an image extension.
- Settings UI: filter `moby.subagents.image-describe` dropdown to models with `acceptsImages: true`.
- Tests: 8–10 unit tests covering trigger paths, schema validation, missing-config error path, multi-provider encoder shape.
- Manual-test backlog: 4 entries — screenshot paste with Claude Haiku configured, file-path read with Ollama Qwen-VL configured, no subagent configured surfaces clear error, vision-capable main model bypasses routing entirely.

**Acceptance:** with `moby.subagents.image-describe = "claude-haiku-4-5"` and DeepSeek V3 as main model, user pastes a screenshot of an error dialog. Main model receives a structured description naming the dialog title, error text, and visible buttons. Same task with `"off"` returns a clear error pointing at the setting.

**Out of scope for this phase:**
- Multi-image reasoning chains (one image at a time; main model can call again for sequential images).
- Image generation (vision-out, not vision-in).
- Image content moderation / safety filtering beyond what the upstream provider does.

### Phase 3 — `search-digest` (codebase search digestion)

**Goal:** extend routing to local-codebase search results, the highest-volume context-blower (every grep on a real codebase pulls 50+ matches into main context).

**Why after `image-describe`:** scope is fuzzier than web-search-digest. The "search" umbrella plausibly covers grep, find_files, find_symbol, find_references, list_directory — all return ranked-list-shaped results. The right design (one role with multiple insertion points, separate roles per tool, or shape-based roles like `result-list-digest`) is an open question worth answering with usage data from Phase 1's web-search-digest before committing. See Open questions for the scope debate.

**Work (assuming "one role, grep-only first" interpretation):**
- New `roles/searchDigest.ts` module — same `SubagentRole` interface as `web-search-digest`.
- Trigger: `grep` results exceed threshold (default `> 10` matches OR `> 2KB` of result text).
- Sub input: full grep result + original query + user's recent prompt.
- Sub output (JSON): `{relevantMatches: Array<{file, line, snippet, reason}>, irrelevantPattern?, totalSeen}`.
- Wire `SubagentRouter` into `executeToolCall` ([workspaceTools.ts:368](../../src/tools/workspaceTools.ts#L368) — grep dispatch case inside the switch at [workspaceTools.ts:338](../../src/tools/workspaceTools.ts#L338)). After `grepContent` returns, check threshold + route if enabled.
- Add `'search-digest'` to `subagentRoles` and `moby.subagents` setting.
- Tests: 6–8 unit tests mirroring Phase 1's coverage shape, adapted for grep input/output.
- Manual-test backlog: 3 entries — large grep digested, small grep bypassed, sub failure falls back.

**Decision before Phase 3 ships:** answer the scope question. If "one role for many tools," design the input shape as a shared "list-of-results" envelope and write the role once; insertion sites multiply. If "shape-based roles," design `result-list-digest` and possibly `path-list-digest` instead. If "separate role per tool," accept the duplication and ship `grep-digest` first, deferring others.

**Acceptance:** with `moby.subagents.search-digest = "deepseek-v4-flash-thinking"`, a grep returning 30+ results gets routed and the main model sees a 5–10 result digest. Same task completes in fewer main-model tokens. No regression with `"off"`.

### Phase 4 — `file-summarize` + `tool-classify`

**Goal:** broaden the role set to cover the other two high-leverage cases.

**Work:**
- Add `roles/fileSummarize.ts` and `roles/toolClassify.ts` modules following the same shape.
- Wire `file-summarize` into `read_file` (size-gated) and add explicit `summarize_file` tool to the workspace tool set (gated behind `lspTools` style capability or its own flag).
- Wire `tool-classify` into `run_shell` result formatting.
- Add `moby.subagents.file-summarize` and `moby.subagents.tool-classify` settings.
- Decision point: should `tool-classify` be opt-in even when configured? Likely yes for first ship — easy to silently drop a critical line of stderr.
- Tests: 8–10 more covering both new roles.

**Acceptance:** large file reads return summaries with suggested ranges; shell results return classifications with signal lines. Both behind explicit setting; off by default.

### Phase 5 — Local-model support as subagent backend

**Goal:** let users run subagents on local hardware (Ollama, LM Studio, llama.cpp) for privacy / cost.

**Why this comes after Phases 1–4:** the routing pattern needs to be stable and validated with cloud models first. Adding local model variability (cold-start latency, GPU contention, quality variance) on top of an unproven routing layer makes failures hard to attribute. Phase 2's cross-provider plumbing is also a hard prerequisite.

**Work:**
- Custom-model support landing in [model-capability-registry F1+F3](completed/model-capability-registry.md#f1--wire-apiendpoint-through-deepseekclient) is a hard prerequisite. Without `apiEndpoint` config, local models can't be reached.
- Verify each role's prompt template still produces valid structured output on a 14B-class local model. Likely candidates: Qwen2.5-14B-Coder, DeepSeek-Coder-V2-Lite. Smaller models often need stricter schemas or example-laden prompts to avoid mode collapse.
- Add a "warm-up" hook on extension activate: if a local subagent is configured, send a minimal prompt to start the model load. Cold start (20–60s on a 14B) shouldn't appear on the user's first real call.
- Failure mode handling: structured-output validation failures are more likely with smaller models. Tighten the fallback path — log the bad output for debugging, fall back to raw input, surface a one-time notification recommending a different model if failures persist.
- Documentation: a short guide for "running Qwen 14B as your search-digest subagent on local hardware."

**Acceptance:** user with Ollama running Qwen-14B-Coder configures `moby.subagents.search-digest = "qwen2.5-coder-14b-local"`, search digestion works at a quality bar comparable to V4-flash, no main-loop latency regression after warm-up.

### Phase 6 — Per-turn tool subsetting (cross-cuts with context-cleanup)

**Goal:** stop advertising every tool on every turn. The full tools array is ~1850 tokens regardless of what the user asked — `delete_file`, `run_shell`, `edit_file` schemas are dead weight on a "what does X do?" question.

**Why this lives here:** the routing infrastructure that makes subagents work (intent classification before the main model runs) is the same infrastructure that decides which tools to advertise. A `tool-classify` role (already in Phase 4 above) can do double duty: classify the user's intent, then attach only the relevant tool subset to the main model's request.

**Tool tiers:**

| Tier | Tools | When attached |
|---|---|---|
| **Always** | `read_file`, `find_files`, `grep`, `list_directory`, `file_metadata` | Every turn (cheap; ~600 tokens) |
| **LSP** | `outline`, `get_symbol_source`, `find_symbol`, `find_definition`, `find_references` | Already gated on `LspAvailability.getDeclaredAvailability().available.length > 0` |
| **Modify** | `edit_file`, `write_file`, `delete_file`, `delete_directory` | Intent classifier flags edit-shaped ("update foo", "add X", "fix this", "refactor") |
| **Shell** | `run_shell` | Intent classifier flags shell-shaped ("run tests", "build", "git status") OR explicit user mention |
| **Web** | `web_search` (when not in manual mode) | Already conditional on `webSearchManager.isAvailable()` |

**Token math:** typical "explain this" question on a workspace with TS LSP attached → ~600 (always) + ~600 (LSP) = ~1200 tokens. Was ~1850. Saves ~650 tokens per request, plus the corresponding system-prompt tool-guidance lines (which are already conditional on the rendered tool set, so they shrink for free).

**Risk: misclassification suppresses a needed tool.** Mitigations:
- Never suppress a tool the model has previously used in the same session — once `edit_file` is in play, it stays advertised through the rest of the turn.
- The classifier output is a hint, not a hard gate. On classifier failure (timeout, unparseable response), default to the full tool set. Cost of extra tokens beats the cost of the model not having a tool it needed.
- Classifier confidence below threshold → also default to full set. Better to spend 650 tokens than have the model fight a missing tool.

**Acceptance:** simple "what is X?" questions show `tools_array≈1200` instead of `tools_array≈1850` in the Phase 1 instrumentation log; edit-shaped questions still get the full set; no observed regressions where the main model wants a suppressed tool.

**Cross-reference:** this is also tracked in [context-cleanup.md → Phase 5](context-cleanup.md) as a context-spend lever; the design lives here because the routing primitives are shared.

### Phase 7 — Optional MCP extraction (parked; revisit after Phase 5 lands)

**Goal:** extract the subagent routing layer as an MCP server for cross-editor reuse.

**Why parked:** building a polished MCP server is its own product surface. Time spent on packaging, multi-client compatibility, configuration UX is time not spent validating the underlying idea inside Moby. Once Phase 5 ships and the routing pattern has earned its keep, extraction becomes an option rather than a bet.

**MCP-specific design constraint to flag for later:** MCP servers default to running per-client (one process per editor instance). For a 14B local model this is unworkable — you can't load 8GB of weights per VS Code window. The eventual MCP server has to be designed as a *thin protocol layer* that connects to a *persistent daemon* holding the model. That's a non-default MCP architecture.

**Decision criteria for un-parking:**
- Phase 5 has been in real use for ~2 months with positive signal.
- At least one external user request for a non-Moby integration of the same routing pattern.
- A clear separation between "Moby-specific orchestrator integration" (stays in Moby) and "generic subagent routing" (extracts cleanly).

If those conditions don't hold, Phase 7 stays parked indefinitely and that's fine — the Moby-internal version is providing the value.

## What we are NOT doing in this plan

- **Bundling local LLMs with the extension.** Distribution friction (4–8GB model files) and quality concerns make this wrong for a general-purpose VS Code extension. Users who want local subagents bring their own runner.
- **Edits via subagent.** Editing code requires reasoning the small models handle poorly. Edit tools (`edit_file`, `write_file`, `delete_file`) stay on the main model.
- **Multi-step planning via subagent.** Same reason — small models lose the thread on multi-iteration tool loops. Planning stays on main.
- **Allowing the main model to choose to delegate.** Tool-routing first; the explicit `delegate_to_subagent` escape hatch can be added later if needed (see "Why tool-routing" above).
- **Cross-turn subagent memory.** Subagents are stateless per call. If a sub needs context, it's passed in as part of the input. No subagent-level conversation history.
- **A UI for monitoring subagent calls.** Useful for debugging, but a later concern. Subagent activity initially logs through the existing extension Logger and shows up in tool dropdowns just like any other tool result.
- **Cost / quota tracking per role.** Cloud subagents incur API spend. Tracking this is a follow-up — first prove the spend is worth it.
- **Bundling vision models with the extension.** Same reason as bundled local LLMs — distribution weight (Qwen-VL is 7GB+) and quality variance. Vision-capable subagents are an opt-in advanced configuration.
- **Image generation / vision-out.** This plan is vision-*in* only (image → text). Generating images would need a different role shape (text → image), different output handling, different validation, and a much larger surface for misuse. Out of scope.
- **Multi-image reasoning chains.** One image at a time. If a workflow needs to compare two images, the main model calls `describe_image` twice and reasons over the two text descriptions.

## Risks and mitigation

- **Bad summary corrupts main agent's reasoning.** The main model acts on the digest as if it were ground truth. If the digest drops the relevant grep match, the main model concludes incorrectly. *Mitigation:* (1) include `totalSeen` in every digest so the main model knows it's a sample, (2) log the raw input for debugging, (3) start with `search-digest` (lowest blast radius) and ship `tool-classify` (highest blast radius) only behind opt-in.
- **Two-layer error compounds debugging.** A wrong action could be "sub hallucinated → main believed it" — twice the failure surface. *Mitigation:* every subagent call is logged with input + output + validation result. Trace exporter ([Moby's existing tracer](../../src/tracing/TraceCollector.ts)) gets new entries for sub calls so users can see exactly what happened.
- **Sub failures are invisible to the main model — by design.** Every fallback path (settings off, threshold miss, schema fail, sub-call timeout, sub-API error) returns the raw tool result unchanged. The main model never knows whether routing happened or whether it failed. *Reason:* digestion is enrichment, not gating. If the sub fails, the raw result is still correct — the main model has no need to adapt. Letting main see sub-failures invites overcorrection (retries, strategy swaps) without benefit. *Mitigation for users:* repeated sub failures surface in the status panel (Phase 3+, when local-model variance makes user-facing notification load-bearing). Trace logs always capture the full call so debugging stays possible.
- **Schema validation failures.** Smaller models drift from JSON schemas. *Mitigation:* zod-based validation on every output; fall back to raw input on failure; instrument failure rates and surface a notification if a configured subagent fails > 30% of calls.
- **Latency tax.** Routing through a sub adds a network round-trip (cloud) or model-load latency (local cold start). *Mitigation:* skip routing under threshold (most grep calls have < 10 results and bypass the sub); warm up local models on activate; benchmark to confirm net wall-time is lower.
- **Cost accounting.** Two API calls per affected tool result instead of one. *Mitigation:* V4-flash is ~10× cheaper than V4-pro per token, and the digest is much shorter than the saved main-context tokens. Net cost should drop, not rise. Validate empirically after Phase 1.
- **Concurrency on a single GPU (local case).** Two parallel subagent calls queue, not parallelize. *Mitigation:* serialize subagent calls per backend; document the limitation. Most main loops are sequential anyway (tool calls execute one at a time today).
- **Routing decisions are surprising to users.** "Why is my grep result different from `grep` in a terminal?" *Mitigation:* tool result formatter explicitly notes when a digest was used, with the raw match count. Settings UI makes role assignments visible.
- **Vision description trusted as ground truth.** Worse blast radius than digest roles: user attached a screenshot expecting the model to see it, can't easily verify the description was accurate, and a wrong "the button says Submit" → main model writes wrong code. *Mitigation:* always-prefix `[Image processed by vision subagent: <model-id>]` so the main model knows it's second-hand, log the raw image alongside the description in the trace exporter, and surface the description verbatim to the user (not buried) so mismatches with what they see are catchable.
- **Per-provider multimodal encoder drift.** Each provider formats image inputs differently; an upstream API change can silently break one backend. *Mitigation:* per-provider encoder is its own module with a small contract test (round-trip a known image through each adapter and assert the model returns a non-empty description). Run on CI.
- **Drift between role schemas and prompt templates.** If we change the schema without updating the prompt, the model produces what we asked for and we reject it as invalid. *Mitigation:* schema and prompt template live in the same module, with a unit test that the schema is the ground truth for what the formatter expects.

## Why this approach over alternatives

**A. Static deterministic slicing instead of subagent reasoning.** Tree-sitter / LSP can extract function bodies and document outlines without an LLM. For `file-summarize`, this is largely sufficient and is being addressed in [lsp-integration.md](lsp-integration.md). Subagents add value where reasoning *about relevance* is needed: digesting grep matches by meaning, classifying noisy stderr, picking which lines of a stack trace are actionable. The two approaches are complementary — LSP for "what is this," subagents for "what matters here." Don't pick one or the other; deploy both.

**B. Bundle a tiny local model in the extension.** Discussed and rejected — distribution weight, resource contention, quality variance for a default that has to work for everyone. Local subagents are an opt-in advanced configuration, not a bundled default.

**C. Bolt on token-savior or claude-mem instead of building.** They're good tools, but solve adjacent problems with their own opinions. token-savior's progressive disclosure assumes a symbol-indexed world; claude-mem focuses on persistent memory across sessions. Building Moby-specific subagent routing keeps us aligned with our existing primitives (capability registry, tool dispatch, transport adapters) and adds ~600 LOC of focused code instead of importing thousands.

**D. Use Anthropic's `clear_tool_uses` context-management header.** Mentioned in [docs/plans/context-management.md](completed/context-management.md). Different lever — that header *forgets* old tool use after a threshold. Subagents *prevent* the verbose stuff from entering main context in the first place. Both useful, both compatible.

The chosen approach (**tool-routing with role-assigned subagents, cloud-first then local**) builds on existing registry plumbing, ships incrementally, validates each piece before the next, and leaves the door open for future delegation/MCP layers without committing to them now.

## Open questions

- **Tool-classify default state.** Ship off-by-default (safe) or on-by-default for V4 (more impact)? Probably off-by-default first; flip to on once Phases 1+4 have ~1 month of clean operation.
- **`image-describe` default model.** No DeepSeek model accepts images today. Ship with no default (user must configure) or auto-suggest Claude Haiku 4.5 / GPT-4o-mini based on which provider key the user already has? Probably auto-suggest based on detected keys, with a one-time prompt on first image attachment.
- **`search-digest` scope — one role or many?** "Search" plausibly covers grep, find_files, find_symbol, find_references, list_directory — all return ranked-list-shaped results. Three options: (A) one `search-digest` role with multiple insertion points and a generic prompt, (B) shape-based roles like `result-list-digest` (file:line:snippet shapes from grep / find_symbol / find_references) and `path-list-digest` (path-only shapes from find_files / list_directory) — two roles cover all surfaces, (C) one role per tool (`grep-digest`, `find-symbol-digest`, …) accepting duplication for tunability. Defer until Phase 1 (`web-search-digest`) ships and we have one role's worth of usage data to inform the call. Current preference: B — shape-based roles fit the existing `SubagentRole` interface cleanly, avoid prompt-genericness from A, and avoid scaffold-multiplication from C. Real usage data wins over preference.
- **Should `search-digest` see prior conversation context?** The user's last message provides task context — knowing "the user is debugging an auth bug" makes the digest pick `auth*` matches over `health*` matches. But passing conversation context grows the sub's input cost. Probably yes for the *most recent* user message only; revisit after Phase 1.
- **What's the right size threshold for `file-summarize`?** 500 lines is a guess. Some 200-line files are dense (a single 200-line function); some 2000-line files are mostly imports/declarations. Phase 2 may need a token-based threshold instead of line-based.
- **Privacy markers.** A user might want subagent routing for some files (workspace code) but not others (local secrets, `.env`). Per-glob exclusion via setting? Defer until users ask.
- **Failure budget UX.** After N consecutive subagent failures, do we auto-disable that role for the session? How does the user notice and re-enable? Probably a soft notification with a one-click restore. Phase 3+ concern.
- **Subagent for `find_symbol` / LSP truncation.** When [`find_symbol`](lsp-integration.md) returns 50+ workspace symbols, that's a digest case. Cleanly fits as a fourth role (`symbol-rank`?) once Phase 1 routing is proven. Not in this plan's scope, but on-deck.

## Related

- [model-capability-registry.md](completed/model-capability-registry.md) — registry pattern this builds on; new `subagentRoles` and `moby.subagents` axes follow the established convention.
- [lsp-integration.md](lsp-integration.md) — companion plan for semantic code navigation. LSP and subagents protect different parts of the token budget; both worth shipping.
- [deepseek-v4-integration.md](completed/deepseek-v4-integration.md) — V4-flash is the first-choice subagent model; pricing economics ($0.14/M input, $0.28/M output) make it cheap enough for routine digestion.
- [ADR 0004](../architecture/decisions/0004-r1-path-semantics-guards.md) — absolute-path B-pattern in tool results; subagent digests preserve the same path conventions when surfacing matches to the main model.
- Token Savior Recall (https://github.com/Mibayy/token-savior) — adjacent project with progressive-disclosure layers (`memory_index` → `memory_search` → `memory_get`). Different shape (MCP server, symbol-indexed memory) but solves an overlapping problem.
- Hermes Agent (https://github.com/NousResearch/hermes-agent) — uses LLM summarization for cross-session recall. Different scope (cross-session vs in-turn) but informs the prompt-template design for `file-summarize`.
