# Modular web search providers

**Status:** Plan — not yet implemented
**Date:** 2026-04-23

## Context

Web search today is Tavily-only but already supports three dispatch strategies, selected by the `mode` setting:

- **`mode: 'auto'` + Chat (tool-calling model).** We add a `webSearchTool` schema to the API request ([src/tools/workspaceTools.ts:125](../../src/tools/workspaceTools.ts#L125)), conditionally at [src/providers/requestOrchestrator.ts:2482](../../src/providers/requestOrchestrator.ts#L2482). The model calls `web_search({ query })` when it decides it needs to; the tool routes to Tavily.
- **`mode: 'auto'` + R1 (no tool-calling API).** R1 can't emit `tool_calls`, so we teach it via prompt to emit `<web_search>…</web_search>` XML tags ([src/tools/reasonerShellExecutor.ts:690](../../src/tools/reasonerShellExecutor.ts#L690)). We parse the tags, run Tavily, inject results back into the next iteration.
- **`mode: 'manual'` + toolbar toggle on.** We pre-fetch Tavily results for the user's message and prepend them to the system prompt ([src/providers/requestOrchestrator.ts:1157](../../src/providers/requestOrchestrator.ts#L1157)) before the turn runs. The model never decides; we always search.

The plumbing lives in [src/clients/tavilyClient.ts](../../src/clients/tavilyClient.ts) (HTTP client) and [src/providers/webSearchManager.ts](../../src/providers/webSearchManager.ts) (caching, credit bookkeeping, per-mode gating). Settings live under `moby.webSearch.*`; the Tavily API key in SecretStorage under `moby.tavilyApiKey`. Toolbar shows a web-search toggle; settings popup shows a "Tavily API Key" button with a status dot.

This design worked when Tavily was the only provider and DeepSeek was the only model family. With custom-model support shipped ([model-capability-registry.md](./model-capability-registry.md)), two new situations have appeared:

1. **Users who can't or won't use Tavily.** Self-hosted / offline-friendly users who add Ollama, LM Studio, or llama.cpp backends typically want a matching local-first web search. Tavily is cloud-only and paid. SearXNG is the obvious peer — self-hosted, free, no API key.
2. **Custom models with their own native `web_search` tools.** Groq and Kimi expose a built-in browse tool at the provider level. If we send our `webSearchTool` schema, the model uses our tool (Tavily under the hood) — which works, but bypasses the native search the user's custom provider was chosen for. A user who switched to Groq *specifically* for its native search gets Tavily instead.

The architectural observation matches the model one: **web search has two orthogonal axes.** The *provider* (Tavily / SearXNG) decides where search queries go. The *dispatch strategy* (manual-inject / auto-via-tool-schema / auto-via-XML-tags) is already set by the `toolCalling` capability of the active model. Our plumbing conflates "provider" with "Tavily" and hardcodes the dispatch decision based on R1 vs Chat rather than the registry.

## Decision

Introduce a `WebSearchProvider` abstraction that mirrors the shape of the model-capability registry:

1. **Provider registry.** Keyed by provider id. Each entry declares its config shape, secret storage key, and implementation class. Two providers to start: `tavily` (already exists) and `searxng` (new).
2. **Dispatcher.** `webSearchManager` becomes a thin layer over the provider registry. It resolves the configured provider, passes through settings, and surfaces a single `search(query)` interface to the rest of the extension. No other file should know which provider is active.
3. **Model-native dispatch opt-out.** Model capability registry gains a `webSearch: 'provider-tool' | 'provider-xml' | 'model-native' | 'none'` axis. The first two are today's behaviors expressed as registry values; `model-native` is new.

The registry lookup replaces the implicit "Tavily for everyone" and "dispatch is R1-vs-Chat" assumptions.

## Provider registry shape

```ts
interface WebSearchProviderDefinition {
  id: 'tavily' | 'searxng';
  displayName: string;

  // How the user configures this provider.
  configShape: {
    endpoint?: { required: boolean; default?: string };  // SearXNG needs this; Tavily is hardcoded
    apiKey?:   { required: boolean; secretKey: string }; // Tavily yes, SearXNG no
    // Per-provider extras (SearXNG engines list, etc.) live inside the provider.
  };

  // Runtime bounds — settings UI uses these for slider ranges.
  limits: {
    maxResultsPerSearch: { min: number; max: number; default: number };
    searchDepth?: Array<'basic' | 'advanced'>;  // providers without depth modes omit this
  };

  // Implementation factory.
  createClient(context: vscode.ExtensionContext, endpoint?: string): WebSearchClient;
}

interface WebSearchClient {
  isConfigured(): Promise<boolean>;
  search(query: string, opts: SearchOptions): Promise<WebSearchResponse>;
}
```

Two concrete registrations for comparison:

```ts
'tavily': {
  displayName: 'Tavily',
  configShape: {
    apiKey: { required: true, secretKey: 'moby.tavilyApiKey' }
  },
  limits: {
    maxResultsPerSearch: { min: 1, max: 20, default: 5 },
    searchDepth: ['basic', 'advanced']
  },
  createClient: (ctx) => new TavilyClient(ctx)
},

'searxng': {
  displayName: 'SearXNG',
  configShape: {
    endpoint: { required: true, default: 'http://localhost:8080' }
    // no apiKey — public/private instance, auth handled in endpoint URL if needed
  },
  limits: {
    maxResultsPerSearch: { min: 1, max: 20, default: 10 }
    // no searchDepth — SearXNG doesn't expose the same "basic vs advanced" axis
  },
  createClient: (_ctx, endpoint) => new SearxngClient(endpoint!)
},
```

## Model capability axis: `webSearch`

Added to `ModelCapabilities`:

```ts
webSearch?: 'provider-tool' | 'provider-xml' | 'model-native' | 'none';
```

Semantics:

- `provider-tool` — we inject `webSearchTool` into the API tool schema; the model calls it; we route the call through the configured provider (Tavily, SearXNG, etc.). This is today's Chat behavior in `auto` mode.
- `provider-xml` — we teach the model via prompt to emit `<web_search>…</web_search>` tags; we parse them and route through the configured provider. This is today's R1 behavior in `auto` mode. Used for models that lack tool-calling.
- `model-native` — the model's provider has its own web_search tool (Groq, Kimi, OpenAI, etc.). The user chooses per-turn whether to use the model's native search or our configured provider — the popup offers both, defaulting to native when we have a translator for this provider and to provider when we don't. See "Native vs. provider — user choice" below.
- `none` — web search is disabled for this model regardless of user toggle. Toolbar toggle and popup both disable.
- `undefined` (absent) — defaults pick themselves based on `toolCalling`: `'native'` → `'provider-tool'`; `'none'` → `'provider-xml'`. Backwards-compatible for existing registrations.

The axis is independent of `manual` mode. Manual-inject continues to pre-fetch via the configured provider for *any* model (including `model-native` and `none`) — it's a user-forced search, not a model capability.

Concrete registrations:

```ts
'deepseek-chat':     { toolCalling: 'native', webSearch: 'provider-tool' }, // tool schema
'deepseek-reasoner': { toolCalling: 'none',   webSearch: 'provider-xml'  }, // <web_search> tags
// custom model templates:
'groq-llama-3.3-70b':  { toolCalling: 'native', webSearch: 'model-native' }, // Groq's own browse
'kimi-moonshot-v1':    { toolCalling: 'native', webSearch: 'model-native' }, // Kimi's own browse
'ollama-qwen-coder':   { toolCalling: 'native', webSearch: 'provider-tool' }, // tool schema → Tavily/SearXNG
'ollama-llama-local':  { toolCalling: 'none',   webSearch: 'provider-xml'  }, // <web_search> tags
'openai-gpt-4o-mini':  { toolCalling: 'native', webSearch: 'model-native' }, // OpenAI's browse tool
```

### Why make the dispatch strategy a registry value instead of deriving it from `toolCalling`?

Because `toolCalling: 'native'` alone doesn't tell you whether our `webSearchTool` schema should ship. Groq has `toolCalling: 'native'` AND its own `web_search`; shipping ours alongside theirs confuses the model and wastes Tavily calls. The registry lets us say "yes this model accepts tool calls, but keep hands off `web_search` — the model has its own."

### Why not drop `provider-xml` and always prefer tool-calling?

Because some capable models (R1, many local base models tuned for instruction-following but not tool-calling) simply can't emit `tool_calls` over the OpenAI API. The XML-tag path is how they participate in agentic search. Removing it would strip web search from R1 and from every non-tool-calling local model.

### Native vs. provider — user choice for `model-native` models

Earlier drafts disabled the web-search UI entirely when a model declared `webSearch: 'model-native'`. Rejected — users have real reasons to prefer our provider even on native-capable models:

- **Privacy / consistency.** A user who picked SearXNG for local-first reasons loses that the moment the model silently uses whatever backend (Bing, Brave, Tavily) the provider picked for them.
- **Debugging.** "Is the model retrieving stale results, or is the search itself bad?" is easier to answer when you can swap the search layer.
- **Coverage gaps.** Our native-enable support varies by provider (see "Open questions"). For providers we can't easily enable native on (OpenAI's Responses API, Anthropic's versioned tool), the provider path is the *only* way to get web search at all; the native option wouldn't even appear.

So for `model-native` models, the popup offers **two choices**:

1. **Use model's built-in search** (default when we have a translator for this provider).
2. **Use [active provider] instead** — routes through Tavily or SearXNG like any non-native model, via our existing `provider-tool` or `provider-xml` dispatch.

The registry entry gains a `nativeWebSearchEnable` field declaring how to trigger native for this provider (e.g. `{ kind: 'tool-type', value: 'browser_search' }` for Groq-shape, `{ kind: 'parameter', name: 'use_search' }` for flag-shape). If the field is absent, the "built-in search" option is hidden and the provider path is the only choice — graceful fallback for providers we haven't implemented yet.

Default rule: if `nativeWebSearchEnable` exists → default to native. Else → default to provider.

This framing solves the per-provider translation problem (see "Open questions") by letting us implement native support incrementally. Groq-shape first; other providers only when a user actually asks.

## Config shape (settings.json)

Current:
```jsonc
"moby.webSearch.searchDepth": "basic",
"moby.webSearch.maxResultsPerSearch": 5,
"moby.webSearch.cacheDuration": 15,
"moby.webSearch.enabled": false
```

New (additive — existing keys keep working):
```jsonc
"moby.webSearch.provider": "tavily",            // "tavily" | "searxng"
"moby.webSearch.searxng.endpoint": "http://localhost:8080",
// shared across providers:
"moby.webSearch.maxResultsPerSearch": 5,
"moby.webSearch.cacheDuration": 15,
"moby.webSearch.enabled": false,
// tavily-specific:
"moby.webSearch.tavily.searchDepth": "basic"
```

Provider-specific keys get namespaced. Shared keys stay flat.

## Settings UI changes

### 1. Web-search popup becomes provider-aware

The web-search popup (the button to the left of send) already houses mode + basic/advanced + per-prompt credits for Tavily. It becomes **dynamic per active provider**: a shared top section (provider picker, mode, enable toggle) followed by a provider-specific section that renders whatever knobs the active provider defines.

- **Tavily section** — basic/advanced search depth (current UI); credits-per-prompt; max results.
- **SearXNG section** — endpoint field; engine selection (checkboxes: google, bing, duckduckgo, brave, etc., with a sensible default set); max results. No search-depth equivalent — SearXNG doesn't expose that axis.
- **Future providers** — declare their own config shape in the registry entry; popup renders it.

The split comes from the provider registry's `configShape`. Popup reads the active provider from the registry, renders the matching section, and dispatches its writes to the right settings keys (`moby.webSearch.tavily.*` or `moby.webSearch.searxng.*`).

**Test-connection button.** Each provider section includes a "Test connection" button that pings the endpoint (`/search?q=test` for SearXNG, a minimal Tavily query for Tavily) and flashes green/red with the result. Cheaper than the first real turn failing mid-stream, especially when setting up SearXNG for the first time.

### 2. Per-provider buttons in the settings popup keep their own labels

The existing "Tavily API Key" button stays labelled "Tavily API Key". When SearXNG ships, it gets its own row ("SearXNG Endpoint") with its own status dot. Each provider's config is independently visible — useful because users may flip between providers (e.g. laptop off-network → SearXNG via local instance; on-network → Tavily). No "generic" label, no hiding which service is being used.

### 3. Native-vs-provider choice for `model-native` models

When the active model declares `webSearch: 'model-native'`, the popup shows a **"Search via"** picker at the top with two options:

- **Model's built-in search** (e.g., "Groq's built-in search", "OpenAI browse"). Available only when the registry entry has a `nativeWebSearchEnable` definition for the provider.
- **[active provider]** — "Tavily" or "SearXNG", depending on `moby.webSearch.provider`. Always available.

The default is native-when-translator-exists, provider otherwise. User override persists across turns via a per-model setting (`moby.webSearch.modelNativePreference.<modelId>`).

The rest of the popup (engine checkboxes for SearXNG, depth toggle for Tavily, etc.) renders beneath, grayed out when "model's built-in" is selected — those knobs apply to our provider path, not to the model's internal search.

For `webSearch: 'none'` models, both toolbar toggle and popup disable with a tooltip.

## Phased rollout

### Phase 1 — Provider abstraction (no behavior change)

- Extract `WebSearchClient` interface.
- Move `TavilyClient` behind the interface without touching its behavior.
- Introduce `WEB_SEARCH_PROVIDERS` registry with Tavily as the sole entry.
- `webSearchManager` dispatches through the registry. External callers unchanged.
- Settings still hardcode `provider: 'tavily'`.

Ship this standalone. Zero user-visible change. Refactor only.

### Phase 2 — SearXNG provider

- Introduce `src/clients/webSearchProviderRegistry.ts` (new file) — maps `moby.webSearch.provider` to a `WebSearchProvider` instance.
- Add `src/clients/searxngClient.ts` (new file) implementing the `WebSearchProvider` interface.
- Give `src/clients/tavilyClient.ts` a small shim so it implements the same interface. Don't rename or move it.
- Register both in the provider registry.
- `webSearchManager` becomes a thin dispatcher over the registry — no other file should know which provider is active.
- Add `moby.webSearch.provider`, `moby.webSearch.searxng.endpoint`, and `moby.webSearch.searxng.engines` to `package.json` contributes.
- **Web-search popup becomes provider-aware** — renders a shared top section plus a provider-specific section driven by the registry's `configShape`. Tavily section shows basic/advanced + credits; SearXNG section shows endpoint + engine checkboxes.
- **Test-connection button** in each provider section pings the endpoint with a minimal query and flashes green/red.
- Settings popup gets a "SearXNG Endpoint" row next to "Tavily API Key" — each with its own status dot.

After Phase 2, users can pick between Tavily and SearXNG. Dispatch strategy is still hardcoded (tool schema for Chat, XML tags for R1); that moves into the registry in Phase 3.

### Phase 3 — Model-native dispatch (capability registry)

#### `nativeWebSearchEnable` — shape and what lives where

"Enable native search on a chat-completions endpoint" is **one small-bounded-set of request-body shapes + declarative values per model**, not per-provider code. Matches how `toolCalling`, `editProtocol`, and `shellProtocol` already work.

**The code side** — a single function in a dedicated file `src/clients/nativeWebSearchEnable.ts` (not buried inside any model-specific client) that takes an outbound chat-completions request body and mutates it per the registry value:

```ts
// src/models/registry.ts
interface NativeWebSearchEnable {
  kind: 'tool-type' | 'builtin-function' | 'top-level-flag' | 'plugin-list';
  // Per-kind fields — validator enforces that the right ones are populated.
  toolType?: string;     // for 'tool-type'
  functionName?: string; // for 'builtin-function'
  field?: string;        // for 'top-level-flag'
  value?: unknown;       // for 'top-level-flag'
  plugins?: string[];    // for 'plugin-list'
}

// src/clients/nativeWebSearchEnable.ts
function applyNativeWebSearchEnable(body: ChatCompletionRequest, e: NativeWebSearchEnable): ChatCompletionRequest {
  switch (e.kind) {
    case 'tool-type':
      return { ...body, tools: [...(body.tools ?? []), { type: e.toolType! }] };
    case 'builtin-function':
      return { ...body, tools: [...(body.tools ?? []), { type: 'builtin_function', function: { name: e.functionName! } }] };
    case 'top-level-flag':
      return { ...body, [e.field!]: e.value };
    case 'plugin-list':
      return { ...body, plugins: e.plugins };
  }
}
```

Four cases. Each handles a known pattern in how hosted providers expose native search over an OpenAI-compatible chat-completions endpoint. New providers that fit any existing `kind` need zero code changes — just new template entries. A genuinely new shape needs one new `kind` (small PR), which should be rare.

**The config side** — each `moby.customModels` entry declares its own `nativeWebSearchEnable` value:

```jsonc
// Groq — non-standard tool type in `tools`
{
  "id": "groq-llama-3.3-70b",
  "toolCalling": "native",
  "webSearch": "model-native",
  "nativeWebSearchEnable": { "kind": "tool-type", "toolType": "browser_search" }
}

// Kimi — builtin_function shape
{
  "id": "kimi-moonshot-v1",
  "toolCalling": "native",
  "webSearch": "model-native",
  "nativeWebSearchEnable": {
    "kind": "builtin-function",
    "functionName": "$web_search"
  }
}

// Hypothetical top-level-flag provider
{
  "id": "someprovider-x",
  "toolCalling": "native",
  "webSearch": "model-native",
  "nativeWebSearchEnable": {
    "kind": "top-level-flag",
    "field": "web_search",
    "value": true
  }
}
```

**User experience** — templates do the typing. `Moby: Add Custom Model` includes pre-filled entries for Groq / Kimi / other known-shape providers. Users never author `nativeWebSearchEnable` JSON by hand unless they're adding a provider we don't have a template for; in that case they copy an existing template and tweak.

**What we're NOT building** — a response-parsing layer. Providers return search results in varying shapes (inline citations in a custom field, server-side tool events, etc.), but if we're not rendering citations in the UI we can ignore all of it. The model composes `content` using the results it retrieved; we stream `content` as-is. Citation rendering is an opt-in feature for a later phase — it would add a parallel `nativeWebSearchResponseDecoder` axis, defined per-kind the same way.

**What still requires a bigger ticket (out of Phase 3)** — providers whose native search requires a different endpoint (OpenAI Responses API at `/v1/responses`) or a completely different request format (Anthropic's versioned server-side tool). Those aren't chat-completions request-body tweaks; they need a new transport layer, which is Phase 4+ work if anyone actually asks.

#### Phase 3 work

- **File reorganization first.** Rename `src/deepseekClient.ts` → `src/clients/llmClient.ts`. Extract any DeepSeek-specific quirks (`reasoning_content` handling, etc.) into a new `src/clients/deepseekClient.ts` that calls `llmClient`. Mechanical find-and-replace for imports across ~15–20 files, TypeScript flags anything missed. Do this before any new functionality lands so Phase 3 additions arrive in their final homes.
- Add `webSearch: 'provider-tool' | 'provider-xml' | 'model-native' | 'none'` to `ModelCapabilities`, with default derived from `toolCalling`.
- Add optional `nativeWebSearchEnable: NativeWebSearchEnable` to `ModelCapabilities` (shape above). Validator in `validateCustomModelEntry` enforces the per-kind required fields.
- Add the per-model preference setting: `moby.webSearch.modelNativePreference: { [modelId]: 'native' | 'provider' }`. Popup writes here when the user toggles the "Search via" picker.
- Implement `applyNativeWebSearchEnable` in **its own file** at `src/clients/nativeWebSearchEnable.ts` (not inside `llmClient.ts` or `deepseekClient.ts`). Pure request-body transformer with the four `kind`s. Called by `llmClient` just before the HTTP send.
- In [requestOrchestrator.ts](../../src/providers/requestOrchestrator.ts), replace the hardcoded "include `webSearchTool` in auto mode" check ([line 2482](../../src/providers/requestOrchestrator.ts#L2482)) with a lookup on the active model's `webSearch` axis:
  - `provider-tool` → ship our `webSearchTool` schema, route calls through the active provider. Unchanged from today's Chat behavior.
  - `provider-xml` → prompt teaches `<web_search>` tags, parser routes through the active provider. Unchanged from today's R1 behavior. Extract the prompt section at [reasonerShellExecutor.ts:690](../../src/tools/reasonerShellExecutor.ts#L690) out of R1-specific code since it's now a transport, not a model detail.
  - `model-native` + preference `'native'` + `nativeWebSearchEnable` present → call `applyNativeWebSearchEnable` on the request; don't ship our `webSearchTool`.
  - `model-native` + preference `'provider'` (or `nativeWebSearchEnable` absent) → fall through to the `provider-tool` or `provider-xml` path (based on `toolCalling`), routing through our active provider.
  - `none` → skip all web-search plumbing; disable toolbar toggle and popup.
- Update custom-model templates to declare `webSearch: 'model-native'` where applicable. Include `nativeWebSearchEnable` only for Groq-shape templates. Leave it off for OpenAI Responses-API and Anthropic entries — those users fall back to the provider path automatically.
- Web-search popup gets the "Search via" picker at the top when `webSearch === 'model-native'`.

After Phase 3, the dispatch strategy is registry-driven and the user controls native-vs-provider per model. Nothing regresses for DeepSeek (both options map to the existing paths). Groq/Kimi users get their provider's native search without our `webSearchTool` layered on top. OpenAI/Anthropic native-search users get a working fallback via the provider path; their native integration becomes a focused follow-up (new transport) only if anyone requests it.

### Phase 4 — Polish and cleanup (optional)

- Cache results per provider (different response shapes, different cache keys).
- Per-provider credit tracking if Tavily stays paid and SearXNG stays free — surface only for providers where it's meaningful.
- `webSearch: 'none'` UI treatment (disabled toggle + tooltip).
- Handle the `native` + unconfigured-provider edge case: model calls `web_search`, no provider is set up, return a structured error so the model can say "I can't search the web right now."

## Alternatives considered

**A. Keep Tavily-only, add SearXNG as a parallel path.** Fastest but doubles the config surface and makes a third provider (Brave? Kagi? direct Bing?) harder. Rejected — the modularization work is small enough that doing it once is cheaper than adding one-off branches.

**B. Auto-mode only, drop manual-inject entirely.** We already have two auto paths (tool-schema for Chat, XML tags for R1). Could remove `manual` mode and only ever let the model decide. Rejected — manual-inject is useful when the user wants to guarantee a search runs (e.g. "look up the latest X") without relying on the model's judgment, especially on smaller local models whose tool-call reliability is sketchy.

**C. Per-model web-search provider override.** Model X always uses Tavily, model Y always uses SearXNG. Too much config for too little benefit — users will pick one provider and stick with it. The axis we care about is `native` vs `inject`, not "which provider per model."

## Model-scope notes

- Provider abstraction is **model-agnostic**. `tavily` and `searxng` work the same regardless of which model is active. They're part of the tool surface, not a model detector. (See [ADR 0004](../architecture/decisions/0004-r1-path-semantics-guards.md) for the policy on tool-surface vs detector-style guards.)
- The `webSearch` capability axis is **model-specific** by definition. Belongs in the model registry, not in the web-search code.
- Native-tool dispatch path goes through [workspaceTools.ts](../../src/tools/workspaceTools.ts) alongside `read_file` / `apply_code_edit` — same mechanism, different tool name. No special-casing in the orchestrator beyond registering the schema.

## File organization policy

Today's layout has two files whose names no longer match their responsibilities:

- `src/deepseekClient.ts` — sits at the root rather than under `src/clients/`. Despite the name, it's already the **generic OpenAI-compatible chat-completions client**: hits whatever endpoint the active model declares, handles streaming, resolves per-model API keys, dispatches tokenizers. Almost no actual DeepSeek-specific code remains.
- `src/clients/tavilyClient.ts` — genuinely Tavily-only today, but this is only because no second search provider exists yet. Phase 2 introduces one, which forces the split.

The policy going forward:

1. **Generic dispatch code lives in generic files.** Nothing in `llmClient.ts`, `webSearchProviderRegistry.ts`, or `nativeWebSearchEnable.ts` knows which specific model or search provider it's serving. They dispatch by registry lookup.
2. **Provider-specific quirks live in provider-named files.** `deepseekClient.ts`, `tavilyClient.ts`, `searxngClient.ts` — each is a thin layer that knows its one provider's weirdness and nothing else. If DeepSeek's only remaining quirk is `reasoning_content`, that's all that file should contain.
3. **Consistent layout under `src/clients/`.** Both LLM and search clients live there. Today's root-level `src/deepseekClient.ts` is an artifact of when it was the only one.
4. **Generic files don't import specific-provider files.** `llmClient.ts` takes a request body and sends it; it doesn't `import from './deepseekClient'`. `webSearchProviderRegistry.ts` looks up a class by id, it doesn't import `tavilyClient.ts`.

Target layout after Phases 2–3:

```
src/clients/
  llmClient.ts                   # Generic OpenAI-compatible chat-completions client.
                                 # Today's src/deepseekClient.ts, renamed and trimmed.
  deepseekClient.ts              # Thin wrapper for DeepSeek-only quirks (reasoning_content
                                 # handling, etc.). Calls llmClient. May be empty at first.
  nativeWebSearchEnable.ts       # Pure request-body transformer for `applyNativeWebSearchEnable`.
                                 # No HTTP. Called by llmClient before send.

  tavilyClient.ts                # Tavily-specific HTTP. Implements WebSearchProvider interface.
  searxngClient.ts               # SearXNG-specific HTTP. Implements WebSearchProvider interface.
  webSearchProviderRegistry.ts   # Maps `moby.webSearch.provider` → client instance.
                                 # Called by webSearchManager.
```

### Timing — refactor with the next forcing function, not preemptively

Splitting `deepseekClient.ts` today, before a second LLM client exists, is indirection without payoff. Same for `tavilyClient.ts`. But the splits become cheap and worthwhile the moment the corresponding phase adds a second implementation:

- **Phase 2 forces the search split.** Introduces `webSearchProviderRegistry.ts` + `searxngClient.ts`. `tavilyClient.ts` gets a small shim to implement the new `WebSearchProvider` interface and stays where it is.
- **Phase 3 forces the LLM split.** `applyNativeWebSearchEnable` should not live in a file named for a specific model. Ship it alongside a rename of `src/deepseekClient.ts` → `src/clients/llmClient.ts`, with any DeepSeek-only quirks extracted to a new `src/clients/deepseekClient.ts`.

The renames are mechanical — `grep -rn deepseekClient` across the codebase, update imports, done. TypeScript catches anything missed. Roughly 15–20 files touched in a single PR.

## The per-provider native-enable translation problem

"Turn on the model's native web search" is not one API call. Each provider exposes it differently, and some don't expose it through OpenAI-compatible chat completions at all. Three layers:

**1. No universal "enable native search" request shape.**

- **OpenAI** — native browse lives on the Responses API (`/v1/responses`), a different endpoint with a different request schema. To enable it for an OpenAI model we'd need to route this one feature through a completely different code path, with different request/response handling. That's a fork, not a translation.
- **Anthropic** — native search is a versioned server-side tool (`web_search_20250305`) inside the Anthropic-format request. Requires the Anthropic request format, not OpenAI.
- **Groq / Kimi / OpenRouter variants** — use OpenAI-compatible chat completions, but enable built-in search via provider-specific parameters. Could be `{ tools: [{ type: "browser_search" }] }`, or a top-level flag like `"use_search": true`, or a `"plugins": [...]` array. Each provider names the switch differently.
- **Local models (Ollama etc.)** — never applicable; these never have native search.

One `webSearch: 'model-native'` value maps to at least four distinct translations, two of which require different endpoints and request shapes entirely.

**2. Response shapes differ, but this matters less.**

Providers return search results inline with different shapes — citations, tool-use blocks, grounding metadata. We'd only need to parse them if we wanted to *render* citations in the UI. If we let the model's text use the results and just forward the text, we can ignore this layer for now.

**3. User's chosen provider gets ignored under native.**

A user who picked SearXNG for privacy and then uses a native-search turn is silently using whatever backend the provider wired up (Bing for OpenAI, Brave for some, unspecified for others).

### Resolution: user choice + incremental native support

Rather than building a universal translator up front, the design lets users choose native vs. provider per model, and we implement native support incrementally:

- **Groq-shape providers first.** Phase 3 ships native-enable for the common case: OpenAI-compatible chat completions + a single provider-specific parameter. Registry entries for those providers gain a `nativeWebSearchEnable` definition; our request builder reads it and adds the right parameter when the user's preference is "model's built-in."
- **Anthropic/OpenAI-Responses punted.** Models whose native search requires a non-chat endpoint or a non-OpenAI request format don't get a translator in Phase 3. Their registry entries can still declare `webSearch: 'model-native'`, but without `nativeWebSearchEnable`; the popup falls back to provider-only, and the user gets web search through Tavily/SearXNG as if the model were a normal tool-calling model. No loss of functionality, just no native path. We build those translators only if users ask.
- **Privacy + override stays intact.** Users who prefer SearXNG/Tavily on *every* model — including ones with working native support — get the toggle in the popup to force the provider path.

This sidesteps the Phase-3-scope explosion. We get a working native integration for providers we care about without building a universal adapter that anticipates every vendor.

## Open questions

- **Response-side citations rendering.** Several providers return citation metadata in custom response fields alongside `content` (grounding arrays, tool-use blocks, etc.). Not needed for web search to *work* — the model uses what it retrieved when composing `content` — but could be a nice UX (inline citations in the rendered answer). Deferred; if added, would introduce a `nativeWebSearchResponseDecoder` axis defined per-`kind` the same way as `nativeWebSearchEnable`.
- **Different-endpoint providers.** OpenAI Responses API and Anthropic can't be expressed as chat-completions request-body tweaks; they need a new transport. Punted from Phase 3 entirely; Phase 4+ work only if a user actually asks. Users of those models still get web search in Phase 3 via the provider fallback.

## Out of scope

- MCP-based web search (separate plan, [mcp.md](./mcp.md) if/when we go down that road).
- Voice search, image search, shopping search — narrow specializations. Only general web search is covered.
- Replacing Tavily's result format. We keep what we have; SearXNG results get mapped into the same shape at the client boundary.

## Related

- [model-capability-registry.md](./model-capability-registry.md) — Phase 3 here needs the `webSearch` axis added to that registry.
- [custom-models.md](../guides/custom-models.md) — once native-tool dispatch ships, the guide should document the `webSearch` field in custom-model entries.
- [ADR 0004](../architecture/decisions/0004-r1-path-semantics-guards.md) — same "tool-surface improvements are model-agnostic" policy applies.
