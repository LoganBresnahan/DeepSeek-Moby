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

## Capability axis additions

```ts
interface ModelCapabilities {
  // ... existing fields ...

  /** Roles this model can serve as a subagent. Empty/absent = main-only.
   *  A model can declare multiple roles; the routing layer picks based
   *  on user assignment in settings. */
  subagentRoles?: Array<'search-digest' | 'file-summarize' | 'tool-classify'>;
}
```

```jsonc
// Example user settings.json:
"moby.subagents": {
  "search-digest":  "deepseek-v4-flash",
  "file-summarize": "deepseek-v4-flash",
  "tool-classify":  "deepseek-v4-flash"
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

### Phase 1 — Cloud-V3 subagent for `search-digest` only ✅ Smallest viable slice

**Goal:** prove the routing pattern on one role, with one model (V3 / `deepseek-v4-flash`), no new infrastructure.

**Why search-digest first:** highest leverage (every grep on a real codebase blows context), smallest blast radius (the digest can be wrong without breaking the main model — it just has fewer matches to consider, and the model can re-grep with a tighter query).

**Why V3 / V4-flash first:** same provider as main models. No new endpoint config. Same `DeepSeekClient` infrastructure. Validates the routing pattern *before* introducing local-model variability.

**Work:**
- New `src/subagents/` module structure with `router.ts`, `roles/searchDigest.ts`, `types.ts`.
- Add `subagentRoles?: Array<...>` to `ModelCapabilities`. Set `subagentRoles: ['search-digest']` on V3 / V4-flash entries.
- Add `moby.subagents` setting schema in `package.json` with default `{"search-digest": "off"}` (off until user opts in).
- Wire `SubagentRouter` into `executeToolCall` ([workspaceTools.ts:337](../../src/tools/workspaceTools.ts#L337)) — after grep returns, check threshold + route if enabled.
- Use `DeepSeekClient` with structured output (JSON mode) for the sub call.
- Tests: 6–8 unit tests covering threshold logic, schema validation, fallback on validation failure, formatter output shape.
- Manual-test backlog: 3 entries — large grep gets digested, small grep doesn't, sub failure falls back gracefully.

**Acceptance:** with `moby.subagents.search-digest = "deepseek-v4-flash"`, a grep returning 30+ results gets routed through V4-flash and the main model sees a 5–10 result digest instead. Same task completes in fewer main-model tokens. No regression with `"off"`.

### Phase 2 — `file-summarize` + `tool-classify`

**Goal:** broaden the role set to cover the other two high-leverage cases.

**Work:**
- Add `roles/fileSummarize.ts` and `roles/toolClassify.ts` modules following the same shape.
- Wire `file-summarize` into `read_file` (size-gated) and add explicit `summarize_file` tool to the workspace tool set (gated behind `lspTools` style capability or its own flag).
- Wire `tool-classify` into `run_shell` result formatting.
- Add `moby.subagents.file-summarize` and `moby.subagents.tool-classify` settings.
- Decision point: should `tool-classify` be opt-in even when configured? Likely yes for first ship — easy to silently drop a critical line of stderr.
- Tests: 8–10 more covering both new roles.

**Acceptance:** large file reads return summaries with suggested ranges; shell results return classifications with signal lines. Both behind explicit setting; off by default.

### Phase 3 — Local-model support as subagent backend

**Goal:** let users run subagents on local hardware (Ollama, LM Studio, llama.cpp) for privacy / cost.

**Why this comes after Phase 1+2:** the routing pattern needs to be stable and validated with cloud models first. Adding local model variability (cold-start latency, GPU contention, quality variance) on top of an unproven routing layer makes failures hard to attribute.

**Work:**
- Custom-model support landing in [model-capability-registry F1+F3](completed/model-capability-registry.md#f1--wire-apiendpoint-through-deepseekclient) is a hard prerequisite. Without `apiEndpoint` config, local models can't be reached.
- Verify each role's prompt template still produces valid structured output on a 14B-class local model. Likely candidates: Qwen2.5-14B-Coder, DeepSeek-Coder-V2-Lite. Smaller models often need stricter schemas or example-laden prompts to avoid mode collapse.
- Add a "warm-up" hook on extension activate: if a local subagent is configured, send a minimal prompt to start the model load. Cold start (20–60s on a 14B) shouldn't appear on the user's first real call.
- Failure mode handling: structured-output validation failures are more likely with smaller models. Tighten the fallback path — log the bad output for debugging, fall back to raw input, surface a one-time notification recommending a different model if failures persist.
- Documentation: a short guide for "running Qwen 14B as your search-digest subagent on local hardware."

**Acceptance:** user with Ollama running Qwen-14B-Coder configures `moby.subagents.search-digest = "qwen2.5-coder-14b-local"`, search digestion works at a quality bar comparable to V4-flash, no main-loop latency regression after warm-up.

### Phase 4 — Per-turn tool subsetting (cross-cuts with context-cleanup)

**Goal:** stop advertising every tool on every turn. The full tools array is ~1850 tokens regardless of what the user asked — `delete_file`, `run_shell`, `edit_file` schemas are dead weight on a "what does X do?" question.

**Why this lives here:** the routing infrastructure that makes subagents work (intent classification before the main model runs) is the same infrastructure that decides which tools to advertise. A `tool-classify` role (already in Phase 2 above) can do double duty: classify the user's intent, then attach only the relevant tool subset to the main model's request.

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

### Phase 5 — Optional MCP extraction (parked; revisit after Phase 3 lands)

**Goal:** extract the subagent routing layer as an MCP server for cross-editor reuse.

**Why parked:** building a polished MCP server is its own product surface. Time spent on packaging, multi-client compatibility, configuration UX is time not spent validating the underlying idea inside Moby. Once Phase 3 ships and the routing pattern has earned its keep, extraction becomes an option rather than a bet.

**MCP-specific design constraint to flag for later:** MCP servers default to running per-client (one process per editor instance). For a 14B local model this is unworkable — you can't load 8GB of weights per VS Code window. The eventual MCP server has to be designed as a *thin protocol layer* that connects to a *persistent daemon* holding the model. That's a non-default MCP architecture.

**Decision criteria for un-parking:**
- Phase 3 has been in real use for ~2 months with positive signal.
- At least one external user request for a non-Moby integration of the same routing pattern.
- A clear separation between "Moby-specific orchestrator integration" (stays in Moby) and "generic subagent routing" (extracts cleanly).

If those conditions don't hold, Phase 5 stays parked indefinitely and that's fine — the Moby-internal version is providing the value.

## What we are NOT doing in this plan

- **Bundling local LLMs with the extension.** Distribution friction (4–8GB model files) and quality concerns make this wrong for a general-purpose VS Code extension. Users who want local subagents bring their own runner.
- **Edits via subagent.** Editing code requires reasoning the small models handle poorly. Edit tools (`edit_file`, `write_file`, `delete_file`) stay on the main model.
- **Multi-step planning via subagent.** Same reason — small models lose the thread on multi-iteration tool loops. Planning stays on main.
- **Allowing the main model to choose to delegate.** Tool-routing first; the explicit `delegate_to_subagent` escape hatch can be added later if needed (see "Why tool-routing" above).
- **Cross-turn subagent memory.** Subagents are stateless per call. If a sub needs context, it's passed in as part of the input. No subagent-level conversation history.
- **A UI for monitoring subagent calls.** Useful for debugging, but a later concern. Subagent activity initially logs through the existing extension Logger and shows up in tool dropdowns just like any other tool result.
- **Cost / quota tracking per role.** Cloud subagents incur API spend. Tracking this is a follow-up — first prove the spend is worth it.

## Risks and mitigation

- **Bad summary corrupts main agent's reasoning.** The main model acts on the digest as if it were ground truth. If the digest drops the relevant grep match, the main model concludes incorrectly. *Mitigation:* (1) include `totalSeen` in every digest so the main model knows it's a sample, (2) log the raw input for debugging, (3) start with `search-digest` (lowest blast radius) and ship `tool-classify` (highest blast radius) only behind opt-in.
- **Two-layer error compounds debugging.** A wrong action could be "sub hallucinated → main believed it" — twice the failure surface. *Mitigation:* every subagent call is logged with input + output + validation result. Trace exporter ([Moby's existing tracer](../../src/tracing/TraceCollector.ts)) gets new entries for sub calls so users can see exactly what happened.
- **Schema validation failures.** Smaller models drift from JSON schemas. *Mitigation:* zod-based validation on every output; fall back to raw input on failure; instrument failure rates and surface a notification if a configured subagent fails > 30% of calls.
- **Latency tax.** Routing through a sub adds a network round-trip (cloud) or model-load latency (local cold start). *Mitigation:* skip routing under threshold (most grep calls have < 10 results and bypass the sub); warm up local models on activate; benchmark to confirm net wall-time is lower.
- **Cost accounting.** Two API calls per affected tool result instead of one. *Mitigation:* V4-flash is ~10× cheaper than V4-pro per token, and the digest is much shorter than the saved main-context tokens. Net cost should drop, not rise. Validate empirically after Phase 1.
- **Concurrency on a single GPU (local case).** Two parallel subagent calls queue, not parallelize. *Mitigation:* serialize subagent calls per backend; document the limitation. Most main loops are sequential anyway (tool calls execute one at a time today).
- **Routing decisions are surprising to users.** "Why is my grep result different from `grep` in a terminal?" *Mitigation:* tool result formatter explicitly notes when a digest was used, with the raw match count. Settings UI makes role assignments visible.
- **Drift between role schemas and prompt templates.** If we change the schema without updating the prompt, the model produces what we asked for and we reject it as invalid. *Mitigation:* schema and prompt template live in the same module, with a unit test that the schema is the ground truth for what the formatter expects.

## Why this approach over alternatives

**A. Static deterministic slicing instead of subagent reasoning.** Tree-sitter / LSP can extract function bodies and document outlines without an LLM. For `file-summarize`, this is largely sufficient and is being addressed in [lsp-integration.md](lsp-integration.md). Subagents add value where reasoning *about relevance* is needed: digesting grep matches by meaning, classifying noisy stderr, picking which lines of a stack trace are actionable. The two approaches are complementary — LSP for "what is this," subagents for "what matters here." Don't pick one or the other; deploy both.

**B. Bundle a tiny local model in the extension.** Discussed and rejected — distribution weight, resource contention, quality variance for a default that has to work for everyone. Local subagents are an opt-in advanced configuration, not a bundled default.

**C. Bolt on token-savior or claude-mem instead of building.** They're good tools, but solve adjacent problems with their own opinions. token-savior's progressive disclosure assumes a symbol-indexed world; claude-mem focuses on persistent memory across sessions. Building Moby-specific subagent routing keeps us aligned with our existing primitives (capability registry, tool dispatch, transport adapters) and adds ~600 LOC of focused code instead of importing thousands.

**D. Use Anthropic's `clear_tool_uses` context-management header.** Mentioned in [docs/plans/context-management.md](completed/context-management.md). Different lever — that header *forgets* old tool use after a threshold. Subagents *prevent* the verbose stuff from entering main context in the first place. Both useful, both compatible.

The chosen approach (**tool-routing with role-assigned subagents, cloud-first then local**) builds on existing registry plumbing, ships incrementally, validates each piece before the next, and leaves the door open for future delegation/MCP layers without committing to them now.

## Open questions

- **Tool-classify default state.** Ship off-by-default (safe) or on-by-default for V4 (more impact)? Probably off-by-default first; flip to on once Phase 1+2 have ~1 month of clean operation.
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
