# Model capability registry + transport abstraction

**Status:** Phase 1 + Phase 2 shipped; Phase 3 parked; follow-ups in progress
**Date:** 2026-04-21 (original) / 2026-04-23 (status update)

## Context

Today, model-specific branching is scattered across the codebase via `isReasonerModel()` checks and hardcoded `'deepseek-chat'` / `'deepseek-reasoner'` string comparisons. Nine branches across at least five files carry model assumptions in their logic ([src/deepseekClient.ts](../../src/deepseekClient.ts), [src/providers/requestOrchestrator.ts](../../src/providers/requestOrchestrator.ts), [src/providers/chatProvider.ts](../../src/providers/chatProvider.ts), [src/events/ConversationManager.ts](../../src/events/ConversationManager.ts), [src/views/statusBar.ts](../../src/views/statusBar.ts)).

This has two costs today:

1. **Adding `create_file` / `delete_file` to Chat.** The planned work is straightforward (add schemas, dispatch to fs helpers), but with the current structure, each new tool adds another `!isReasonerModel()` check. The hole gets deeper.

2. **ADR 0004's B-pattern is implemented once for R1.** When we add Chat tool-result feedback (absolute paths of files touched), we'd replicate the pattern in a second place — not because the pattern differs, but because there's no shared point to add it.

And one cost coming soon: custom model support (CLAUDE.md, planned). A user adding "Qwen 2.5 Coder running locally in Ollama" needs a place to declare that model's capabilities. Today there isn't one; capability is inferred from a model name string.

The architectural observation: models vary on **orthogonal axes** — native tool calling or not, separate reasoning channel or not, which edit protocols they use — not on a single chat/reasoner binary. Current code collapses this variation into one bit.

## Decision

Introduce three concepts:

1. **Capability** — a function the extension can perform (read file, create file, edit file, delete file, run shell, web search). One implementation each.
2. **Transport** — an adapter that turns a model's output into capability calls. Native-tool transport parses `tool_calls`. Shell transport parses `<shell>…</shell>`. SEARCH/REPLACE transport parses `# File:` + diff blocks.
3. **Model registry** — declares, per model, which transports are wired and what the model's operational limits are.

Transport adapters are the only place that differs between models. The capability layer is model-agnostic. Model selection becomes a registry lookup, not a string comparison.

### Why not just fix the branches with a capability function?

A minimal version would keep the ad-hoc architecture and just replace `isReasonerModel()` with `supportsNativeTools(model)`. That fixes the hardcoded strings but leaves two problems:

- Capability functions would still live in disparate places ([workspaceTools.ts](../../src/tools/workspaceTools.ts) dispatches tools, [reasonerShellExecutor.ts](../../src/tools/reasonerShellExecutor.ts) parses shell, [diffManager.ts](../../src/providers/diffManager.ts) handles diffs). Adding `create_file` still means touching several files and deciding whose job it is.
- The B-pattern (ADR 0004 absolute-path feedback) would still be implemented per-transport rather than once at the capability boundary.

A proper capability layer pays off over the minimal version in Phase 2+ when we actually start adding tools.

## Model registry shape

```ts
interface ModelCapabilities {
  // Transport axes — how the model expresses intent
  toolCalling: 'native' | 'none';
  reasoningTokens: 'inline' | 'none';
  editProtocol: Array<'native-tool' | 'search-replace'>;  // ordered preference
  shellProtocol: 'xml-shell' | 'none';

  // Operational axes
  maxOutputTokens: number;
  streaming: boolean;

  // Infrastructure
  apiEndpoint: string;             // e.g. 'https://api.deepseek.com/v1'
  apiKey?: string;                 // per-model override; falls back to global
  requestFormat: 'openai' | 'anthropic';
}
```

Three concrete registrations for comparison:

```ts
'deepseek-chat': {
  toolCalling: 'native',
  reasoningTokens: 'none',
  editProtocol: ['native-tool'],
  shellProtocol: 'none',
  maxOutputTokens: 8192,
  streaming: true,
  apiEndpoint: 'https://api.deepseek.com/v1',
  requestFormat: 'openai',
},

'deepseek-reasoner': {
  toolCalling: 'none',                  // API rejects `tools` on this endpoint
  reasoningTokens: 'inline',            // separate reasoning_content channel
  editProtocol: ['search-replace'],
  shellProtocol: 'xml-shell',
  maxOutputTokens: 65536,
  streaming: true,
  apiEndpoint: 'https://api.deepseek.com/v1',
  requestFormat: 'openai',
},

'qwen2.5-coder:7b-instruct': {          // Hypothetical — not yet supported
  toolCalling: 'native',
  reasoningTokens: 'none',
  editProtocol: ['native-tool'],
  shellProtocol: 'none',
  maxOutputTokens: 4096,
  streaming: true,
  apiEndpoint: 'http://localhost:11434/v1',   // Ollama's OpenAI-compat endpoint
  apiKey: 'ollama',                           // placeholder; Ollama ignores auth
  requestFormat: 'openai',
},
```

The hypothetical Qwen entry demonstrates why the registry helps. Qwen's capability profile is nearly identical to Chat's — native tools, no reasoning channel. The registry tells the orchestrator this, and no other code needs to know Qwen exists. A fourth model (say, QwQ with reasoning tokens *and* tools) would be another registry entry; the capability/transport split handles the new combination without code changes.

## Capability layer

New directory `src/capabilities/`:

```
capabilities/
  files.ts       — readFile, createFile, editFile, deleteFile
  search.ts      — searchFiles, grepContent, listDirectory, getFileInfo
  shell.ts       — executeShellCommand (R1 only today, model-agnostic API)
  web.ts         — webSearch
  types.ts       — CapabilityResult<T>
```

Each capability returns a `CapabilityResult` shape:

```ts
interface CapabilityResult<T = void> {
  status: 'success' | 'failure' | 'rejected';
  data?: T;
  error?: string;
  filesAffected?: Array<{
    absolutePath: string;
    action: 'created' | 'modified' | 'deleted';
  }>;
}
```

This is where the **ADR 0004 B-pattern becomes model-agnostic**. Every tool-result formatter (native-tool result, shell result, SEARCH/REPLACE result) reads `filesAffected` and appends the absolute-path section. One impl, three consumers.

Capability functions are thin — they don't own approval UI. DiffManager still owns approval flows; capabilities call into DiffManager for `editFile` / `createFile` when the edit mode requires it. The capability layer is the **vocabulary**, not the **orchestration**.

## Transport adapters

Existing logic, relocated and unified under a common interface:

```ts
interface Transport {
  name: 'native-tool' | 'shell' | 'search-replace';
  parseStreamChunk(chunk: string): ParsedAction[];
  formatResult(result: CapabilityResult): string;  // injected back to model
}
```

**Relocations:**
- Native-tool parser lives today in `executeToolCall` ([workspaceTools.ts:178](../../src/tools/workspaceTools.ts#L178)) and the orchestrator's post-exec handling ([requestOrchestrator.ts:2589](../../src/providers/requestOrchestrator.ts#L2589)). Move to `src/transports/nativeTool.ts`.
- Shell parser lives in [reasonerShellExecutor.ts](../../src/tools/reasonerShellExecutor.ts). Most of it already has the right shape; just move.
- SEARCH/REPLACE parser is split across `ContentTransformBuffer` (detection) and DiffManager (apply). Detection logic extracts to `src/transports/searchReplace.ts`; apply logic stays in DiffManager. Both models use this transport today.

## Phases

### Phase 1 — Registry only ✅ Shipped

**Goal:** consolidate model branching through a lookup. No behavior change.

**What landed:**
- [src/models/registry.ts](../../src/models/registry.ts) with `ModelCapabilities` interface + `deepseek-chat` / `deepseek-reasoner` entries, `getCapabilities()`, `getRegisteredModelIds()`, `isReasonerModel()` alias.
- All nine `isReasonerModel()` call sites + five hardcoded model-string sites route through the registry.
- 9 unit tests in [tests/unit/models/registry.test.ts](../../tests/unit/models/registry.test.ts).

### Phase 2 — Capability layer + Chat's create/delete ✅ Shipped

**Goal:** Chat gets `create_file` and `delete_file`. The B-pattern lands once, applies to all transports.

**What landed:**
- [src/capabilities/types.ts](../../src/capabilities/types.ts) + [src/capabilities/files.ts](../../src/capabilities/files.ts) with `createFile` + `deleteFile` capabilities returning `CapabilityResult` + the `formatFilesAffected` B-pattern formatter.
- Tool schemas `create_file` + `delete_file` wired in [workspaceTools.ts](../../src/tools/workspaceTools.ts).
- Orchestrator dispatch for all three edit tools routes through the capabilities and appends the absolute-path feedback. Delete in ask mode queues a "pending deletion" in the Pending Changes dropdown (same UX shape as edits) rather than a modal.
- WSL / remote-fs trash fallback: `deleteFile` retries with `useTrash: false` when the provider doesn't support trash.
- DiffManager register methods (`registerToolCreatedFile`, `registerToolDeletedFile`, `registerPendingDeletion`) complete the capability↔UI plumbing.
- Accept/reject outcomes now flow back from DiffManager → chatProvider → DB so status writes match reality (fixed a desync where failed deletes were recorded as `applied`).
- Chat system prompt updated with the edit-tools section + rules for file modifications (incl. the "delete is terminal" rule after observing post-delete `apply_code_edit` over-eagerness).

**What we did NOT do** (and why it's fine):
- Did not migrate R1's shell heredoc path onto the `createFile` capability. R1's existing absolute-path feedback (via `formatShellResultsForContext`) already satisfies the B-pattern for the shell transport; unification is cleanup-only and was parked.
- Did not extract the existing parsers into `src/transports/*` — that's Phase 3.

### Phase 3 — Transport adapter unification (parked, deferred behind follow-ups)

Relocate the three ad-hoc parsers into `src/transports/*` with a common interface. Valuable when adding a third transport (e.g., Anthropic's tool-use format if we support Claude). Until then, the current modules work fine; moving them is cleanup-only.

**Explicit priority call (2026-04-23):** the F1–F4 follow-ups below take priority over Phase 3. None of them need transport abstraction — all OpenAI-compatible endpoints (Ollama, LM Studio, llama.cpp, LiteLLM) use the existing native-tool transport, and custom model capabilities are expressed via registry entries, not new parsers. Phase 3 stays parked until a genuinely new wire format appears (Anthropic-style `tool_use` blocks, a future DeepSeek protocol variant, etc.). If no fourth transport ever materializes, Phase 3 can stay parked forever and that's fine — cleanup without a triggering need is premature work.

## Local model implications

Does this architecture open the door for local models? **Yes — substantially.**

Today, adding a local model would require hardcoding another model string across 5+ files, branching the orchestrator on capabilities that aren't declared anywhere, and hoping the model's actual behavior matches our assumptions.

After **Phase 1**, adding a local model is one registry entry:

```ts
'custom-qwen-local': {
  toolCalling: 'native',
  editProtocol: ['native-tool'],
  apiEndpoint: 'http://localhost:11434/v1',
  apiKey: 'ollama',
  // ...
}
```

**Phase 2** makes this even better — a local model that only supports `native-tool` editing automatically gets all the Chat tools (including the forthcoming create_file/delete_file) via its declared transport. Zero new code per model.

**What Phase 1+2 does NOT give us:**
- **A UI to add models.** The registry is code-level for now. A settings UI is a follow-up (likely: a JSON field in VS Code settings mapping into registry entries).
- **Capability detection.** We don't probe endpoints to verify they support what they claim. Users declare; we trust. Intentional — detection is unreliable for local runners (Ollama has dropped tool support in various versions; we don't want to be the ones guessing). Mis-declared capabilities produce clear errors rather than silent fallbacks.
- **Per-model auth storage.** The interface supports per-model `apiKey` but the settings/storage for it is future work.

So: Phase 1+2 lays the foundation. A "Custom Models" settings UI becomes a cleanly scoped third PR (not this plan).

## Alternatives considered

**A. Skip the refactor, add Chat tools against current structure.** Fastest to user value. Rejected because every subsequent model-specific change compounds the hardcoded-string cost. The refactor is ~1 week; the deferred cost accrues forever.

**B. Minimal capability lookup (no transport abstraction).** Just replace `isReasonerModel()` with `getCapabilities(model).toolCalling === 'native'`. Fixes the strings, doesn't fix the "code lives wherever" problem. Rejected as false economy — we'd still pay the capability-layer cost in Phase 2 but with no Phase 1 scaffolding to show for it.

**C. Detect capabilities at runtime.** Probe the endpoint: "does this model accept `tools`?" Rejected as unreliable — probing gives ambiguous results, local runners silently drop unsupported features, and we'd be shipping the complexity forever. Declaring capabilities is honest; detecting them is hope.

**D. Full transport abstraction in Phase 1.** Do the relocation in Phase 1. Rejected — Phase 1 is supposed to be risk-free (no behavior change). Mixing relocation with registry introduction makes Phase 1 a bigger review. Phase 3 is there to do this properly when it earns its keep.

## Risks

- **DiffManager rewiring** (Phase 2) — the existing code has complex state around approvals, edit modes, and diff tabs. Risk of subtle regression. Mitigation: Phase 2 adds capability *alongside* existing paths, then migrates call sites one at a time.
- **Hydration regression** — if the registry changes what gets persisted per turn, ADR 0003's fidelity test catches it, but watch carefully.
- **Phase 1 looking pointless until Phase 2** — Phase 1 is pure plumbing. Worth the review cost only if Phase 2 is committed to landing shortly after. Don't land Phase 1 if Phase 2 is weeks away.

## Non-goals

- Changing current Chat/R1 behavior visible to users.
- Actually shipping Qwen support (the registration above is a design example).
- A UI for users to add custom models (separate PR).
- Dropping R1 support (still gated on Chat parity per ADR 0004).

## Follow-ups after Phase 2

These are the concrete next steps to turn Phase 1+2 plumbing into shipping custom-model support. Order matters — each unlocks the next.

### F1 — Wire `apiEndpoint` through DeepSeekClient

**Status:** Not started.

Today [`DeepSeekClient`](../../src/deepseekClient.ts) hardcodes `baseURL: 'https://api.deepseek.com'` in its constructor (`httpClient = new HttpClient({ baseURL: ... })`). The `ModelCapabilities.apiEndpoint` field exists in the registry but isn't consumed.

**Work:**
- On each request, look up `getCapabilities(this.getModel()).apiEndpoint` and construct the URL from there (or construct the `HttpClient` lazily per-request if the endpoint changed).
- Same treatment for `apiKey`: read per-model `apiKey` from registry first, fall back to the global `moby.apiKey` secret.
- Verify paths: the current code uses `/chat/completions`, which is correct for OpenAI-compat endpoints (Ollama's `/v1/chat/completions`, LM Studio's `/v1/chat/completions`, LiteLLM proxies). Ensure the registry `apiEndpoint` expects `/v1` (or equivalent) baked in so we just append the rest.

**Scope:** ~15–30 LOC + 1–2 tests. Unblocks everything else.

### F2 — Token counter fallback for unknown tokenizers

**Status:** Not started. Design decision needed.

We ship `deepseek-v3.json.br` (~1.3 MB brotli-compressed tokenizer vocab) loaded into the WASM counter. Different model families (Qwen, Llama, Mistral, Claude) have different tokenizers; counting with the DeepSeek vocab is off by 20–40% for them.

Options considered:

| Option | Pros | Cons |
|---|---|---|
| **A. Estimation fallback** | Zero new bytes, already have `EstimationTokenCounter` + calibration via `usage.prompt_tokens` from the API | Less accurate until calibrated |
| **B. Bundle more vocabs** | Accurate everywhere | Ships more bytes (~1 MB per tokenizer); unbounded as model count grows |
| **C. Download on demand** | Smallest baseline | Requires network + caching + failure handling |
| **D. Live API counting only** | No vocab at all; trust `usage.prompt_tokens` | First request uses rough guess; errors if API doesn't return `usage` |

**Chosen direction: A + D combined.** For any model whose tokenizer isn't in our registry of known-matching tokenizers (currently just `deepseek-v3.json.br`), fall back to `EstimationTokenCounter`. The existing `calibrateTokenEstimation(charCount, actualPromptTokens)` path already auto-tunes the char→token ratio from real API responses, so the counter self-corrects after a few calls.

**Work:**
- Add an optional `tokenizer?: 'deepseek-v3'` field to `ModelCapabilities` (null / undefined → estimation).
- `TokenService` / `ContextBuilder` read this field and choose WASM vs estimation at session start.
- Audit places that assume WASM is always available — a couple of log lines in `deepseekClient.ts` mention `[WASM]`; update them to report the active counter.

**Scope:** ~30–50 LOC + 2–3 tests. No new assets shipped.

### F3 — Custom Models settings UI (JSON-first)

**Status:** Not started.

Expose a VS Code setting `moby.customModels` whose value is a JSON array matching the `ModelCapabilities` shape (plus a stable `id`/`name` for display). Entries get merged into the registry at startup and show up in the model selector dropdown alongside the built-in models.

**Example config:**
```jsonc
"moby.customModels": [
  {
    "id": "qwen2.5-coder-local",
    "name": "Qwen 2.5 Coder (Ollama)",
    "toolCalling": "native",
    "reasoningTokens": "none",
    "editProtocol": ["native-tool"],
    "shellProtocol": "none",
    "supportsTemperature": true,
    "maxOutputTokens": 8192,
    "maxTokensConfigKey": "maxTokensCustomQwen",
    "streaming": true,
    "apiEndpoint": "http://localhost:11434/v1",
    "apiKey": "ollama",
    "requestFormat": "openai"
  }
]
```

**Work:**
- Schema in `package.json` (`contributes.configuration`) with full JSON schema for autocomplete + validation in the settings editor.
- `src/models/registry.ts` gains `loadCustomModels()` that reads the setting, validates, and returns a merged map.
- Model-selector actor lists registry entries (rather than hardcoded strings) so custom models appear.
- Per-model API-key handling — either inline in the JSON (simple, less secure) or via a `moby.customModels.<id>.apiKey` secret lookup (safer, more machinery). Lean toward secret lookup; the JSON field just declares *that* an API key is needed.

**Scope:** ~150–250 LOC. Gated on F1 + F2 landing first.

### F4 — OpenAI-compatible router compatibility

**Status:** Documentation / verification, not new code.

None of these require integration work — they just need F1 to land so users can point `apiEndpoint` anywhere:

- **[Ollama](https://ollama.com/)** — native OpenAI-compat at `http://localhost:11434/v1`
- **[LM Studio](https://lmstudio.ai/)** — `http://localhost:1234/v1`
- **[llama.cpp server](https://github.com/ggerganov/llama.cpp)** — `http://localhost:8080/v1`
- **[LiteLLM](https://github.com/BerriAI/litellm)** — proxy that routes one endpoint to many providers (Anthropic, OpenAI, local, etc.). If a user wants Moby to reach 5 providers, LiteLLM in front of them is the standard answer.

**Work (post-F1):** add a short section to `README` / `docs/guides/` showing a sample `moby.customModels` entry for each runner. No code changes needed if F1 + F2 are done.

### F5 — ADR on R1 status

**Status:** Deferred until Chat parity is validated in the wild.

Per ADR 0004's decision chain: once Chat has tool parity with R1 (which Phase 2 largely achieves), we decide whether R1 stays as a power-user option, gets marked experimental, or gets dropped. That's an ADR, not a code change.

### F6 — Telemetry (lowest priority)

Log which transport each model actually uses per turn, so we can validate that declared capabilities match observed behavior. Only worth building if mis-declarations start causing user-facing bugs.

### F7 — Stats modal for non-DeepSeek models

**Status:** Parked until F3 ships and users actually configure non-DeepSeek endpoints.

[`StatsModalActor`](../../media/actors/stats/StatsModalActor.ts) + `DeepSeekClient.getBalance()` ([src/deepseekClient.ts:523](../../src/deepseekClient.ts#L523)) call DeepSeek's `/user/balance` endpoint — a DeepSeek-specific surface. No equivalent exists for Ollama (no balance — it's local), OpenAI (balance via a different endpoint), or Anthropic (different billing model). Once custom models ship (F3), this call will fail or show stale DeepSeek balance while the user is actually using Qwen/Llama/etc.

**Options to consider (not picking now):**
- Hide the balance section when the active model isn't DeepSeek.
- Add a `billingProvider?: 'deepseek' | 'openai' | 'anthropic' | 'none'` axis to `ModelCapabilities` and branch the modal accordingly.
- Replace the balance widget with a session-local "estimated cost" calculated from `usage.prompt_tokens` + `usage.completion_tokens` × user-declared per-model pricing. Works uniformly for any endpoint that returns `usage`.

Decision deferred until F3 ships and we have real user configs to pressure-test against.

### F8 — Local web-search alternative to Tavily

**Status:** Parked — long-term "owning the stack" direction.

[`TavilyClient`](../../src/clients/tavilyClient.ts) hits a hosted service. For users who want a fully local / self-hosted stack (matching local models), we'd need a plug-in alternative. Candidates:
- **[SearXNG](https://docs.searxng.org/)** — self-hostable metasearch engine with a JSON API. Matches Tavily's shape reasonably well.
- Brave Search API, Jina AI Reader, or user-provided-proxy options as hosted alternatives.

Shape of the eventual change: `WebSearchManager` reads a provider type from settings (`moby.webSearch.provider`: `tavily` | `searxng` | custom) and dispatches to a provider-specific client implementing a small `WebSearchProvider` interface. Same decoupling pattern as model capabilities — the orchestrator asks for "search the web for X" and doesn't care which backend answers.

Not blocking the model-registry work. Separate plan when it becomes a priority.

## Order of work

1. **F1 first.** Unblocks F3 and F4 by itself.
2. **F2 in parallel.** Independent from F1; both need to land before F3 is useful.
3. **F3** once F1+F2 are stable. This is the user-facing deliverable.
4. **F4** = docs immediately after F3.
5. **F5, F6, F7** parked until real usage drives the need (F7 specifically gates on F3 shipping).
6. **F8** is a separate plan — out-of-band from the registry work.
7. **Phase 3** stays parked indefinitely (see Phase 3 section above).
