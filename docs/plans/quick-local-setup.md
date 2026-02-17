# Quick Local Setup — Running DeepSeek Moby Against Local Models

**Status:** Research Complete

**Depends on:** Nothing (independent feature)

---

## Goal

Allow users to point the extension at a local DeepSeek-compatible API instead of the cloud `api.deepseek.com`. Two sub-goals:

1. **Custom base URL** — User runs their own inference server (Ollama, vLLM, etc.) and points the extension at it.
2. **Local web search** — Replace or disable Tavily when running locally.

---

## Part 1: Local DeepSeek API

### Current State

All base URLs are **hardcoded** with no user configuration:

| Service | URL | File | Line |
|---------|-----|------|------|
| DeepSeek API | `https://api.deepseek.com` | `src/deepseekClient.ts` | ~102 |
| DeepSeek Beta (FIM) | `https://api.deepseek.com/beta` | `src/deepseekClient.ts` | ~102 |
| Tavily | `https://api.tavily.com` | `src/clients/tavilyClient.ts` | ~25 |

API keys are stored in VS Code's `context.secrets` vault. No environment variable support.

### What Can Serve DeepSeek Locally?

| Feature | Ollama | vLLM | llama.cpp | LM Studio | SGLang |
|---------|--------|------|-----------|-----------|--------|
| **Ease of setup** | Excellent | Moderate | Hard | Excellent | Moderate |
| **`reasoning_content` separate field** | No (`<think>` tags inline) | Yes (with `--enable-reasoning`) | No (`<think>` tags inline) | No (`<think>` tags inline) | Yes |
| **`tool_calls` in API response** | No | Yes (with `--tool-call-parser`) | Limited | Limited | Partial |
| **Full 671B model** | Technically yes (slow) | Yes (multi-GPU) | Yes (huge RAM) | No | Yes (multi-GPU) |
| **Distilled R1 models** | Yes | Yes | Yes | Yes | Yes |
| **Quantization** | GGUF (Q2-Q8) | AWQ/GPTQ/FP16 | GGUF (Q2-Q8) | GGUF (Q2-Q8) | FP16/BF16 |
| **Default endpoint** | `localhost:11434/v1` | `localhost:8000/v1` | `localhost:8080/v1` | `localhost:1234/v1` | varies |

### Available Models & Hardware Requirements

**Distilled R1 Models (what most people will actually run):**

| Model | Q4_K_M VRAM | Q8_0 VRAM | FP16 VRAM |
|-------|-------------|-----------|-----------|
| R1-Distill-1.5B | ~1.5 GB | ~2.5 GB | ~3 GB |
| R1-Distill-7B | ~5 GB | ~8 GB | ~14 GB |
| R1-Distill-8B | ~5.5 GB | ~9 GB | ~16 GB |
| R1-Distill-14B | ~9 GB | ~15 GB | ~28 GB |
| R1-Distill-32B | ~20 GB | ~34 GB | ~64 GB |
| R1-Distill-70B | ~40 GB | ~70 GB | ~140 GB |

**Full 671B MoE Models (enterprise/multi-GPU):**

| Quantization | VRAM/RAM | Typical Setup |
|---|---|---|
| FP16/BF16 | ~1.2 TB | 8x A100 80GB or 8x H100 |
| FP8 | ~650 GB | 8x A100 80GB |
| Q4_K_M (GGUF) | ~300-350 GB | 4-5x A100 80GB or 400GB+ system RAM |

**Consumer sweet spots:**
- **RTX 4090 (24GB):** R1-Distill-32B at Q4 (excellent quality)
- **RTX 3090/4080 (16-24GB):** R1-Distill-14B at Q4-Q8
- **16GB VRAM:** R1-Distill-14B at Q4, R1-Distill-7B at Q8
- **8GB VRAM:** R1-Distill-7B at Q4
- **Mac M-series (32GB unified):** R1-Distill-32B at Q4

### Critical API Differences: Local vs Cloud

This is the part that matters most. The extension relies on specific API behaviors.

#### 1. `reasoning_content` (R1 models) — BREAKING DIFFERENCE

The cloud API returns `reasoning_content` as a **separate field**:
```json
{ "choices": [{ "delta": { "reasoning_content": "Let me think...", "content": "" } }] }
```

The extension reads this directly (`deepseekClient.ts` lines ~357-362):
```typescript
if (delta?.reasoning_content && onReasoning) {
  fullReasoning += delta.reasoning_content;
  onReasoning(delta.reasoning_content);
}
```

**Ollama, llama.cpp, LM Studio** do NOT return a separate field. Instead, thinking tokens appear inline in `content` wrapped in `<think>...</think>` tags:
```json
{ "choices": [{ "delta": { "content": "<think>Let me think...</think>The answer is..." } }] }
```

**vLLM and SGLang** DO return `reasoning_content` as a separate field (matching the cloud API), but only when configured with the right flags (`--enable-reasoning` for vLLM).

**Solution needed:** A `<think>` tag parser that strips thinking from `content` and routes it to the reasoning display. Auto-detect: if `reasoning_content` field is present, use it (cloud/vLLM/SGLang). If not, fall back to parsing `<think>` tags from `content` (Ollama/llama.cpp/LM Studio).

#### 2. `tool_calls` (V3 chat model) — ONLY AFFECTS V3

The cloud API returns structured `tool_calls` in the OpenAI format for V3 (chat model). Local servers vary in their support for this. However, **this is largely irrelevant for most local users** because:

- **R1 doesn't use `tool_calls` at all** — not on the cloud API, not locally. R1's agentic capabilities (shell commands, code edits) work through text tags (`<shell>`, code blocks) that the extension parses from the model's `content` output. This is pure text parsing, no API feature needed.
- **Distilled R1 models on consumer hardware get the full R1 experience:** reasoning, shell command execution, code block output, diff management — all of it works because it's all text-based.
- The `tool_calls` API feature only matters for users running the full 671B V3 model, which requires enterprise multi-GPU hardware anyway.

**For the rare user running V3 locally:**

| Server | `tool_calls` support | Fallback |
|--------|---------------------|----------|
| Ollama | Not for DeepSeek models | DSML parser (already implemented) |
| vLLM | Yes with `--tool-call-parser` | Native works |
| llama.cpp | Grammar-constrained only | DSML parser |
| LM Studio | Experimental | DSML parser |

The existing DSML parser (`src/utils/dsmlParser.ts`) already handles the fallback case where tool calls appear in content text rather than the structured `tool_calls` field.

#### 3. FIM (Fill-in-Middle) Completions — DIFFERENT ENDPOINTS

Cloud API uses `https://api.deepseek.com/beta/completions`. Ollama uses a different endpoint format (`/api/generate` with `suffix` param). vLLM supports the standard completions endpoint. Best to disable FIM for local initially.

#### 4. Prompt Caching Metrics — NON-BREAKING

Cloud API returns `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`. Local servers don't. Already handled as optional fields — non-issue.

#### 5. Model Names — DIFFERENT

| Context | Chat Model | Reasoning Model |
|---------|-----------|----------------|
| Cloud API | `deepseek-chat` | `deepseek-reasoner` |
| Ollama | `deepseek-v3:latest` | `deepseek-r1:32b` |
| vLLM | `deepseek-ai/DeepSeek-V3` | `deepseek-ai/DeepSeek-R1-Distill-Qwen-32B` |

Users need to configure model names when using local servers.

### Minimum Viable Implementation

The simplest path: **one new setting** — a custom base URL.

```json
"deepseek.apiEndpoint": {
  "type": "string",
  "default": "https://api.deepseek.com",
  "description": "API base URL. Examples: http://localhost:11434/v1 (Ollama), http://localhost:8000/v1 (vLLM), http://localhost:1234/v1 (LM Studio)"
}
```

**Changes required:**
1. Add `deepseek.apiEndpoint` setting to `package.json`
2. Read it in `ConfigManager` (`src/utils/config.ts`)
3. Pass to `DeepSeekClient` constructor instead of hardcoded URL
4. Make API key optional when endpoint is not `api.deepseek.com`

This alone gets vLLM and SGLang users working immediately (they match the cloud API format).

### Full Implementation (Ollama/llama.cpp compatibility)

For Ollama/llama.cpp/LM Studio users, additional work:

1. **`<think>` tag parser** — Parse `<think>...</think>` from `content` and route to `onReasoning` callback. This would live in the streaming handler in `deepseekClient.ts`. Auto-detect based on whether `reasoning_content` field is present (if not, fall back to tag parsing).

2. **Model name override** — Let users specify what model name to send:
   ```json
   "deepseek.customModelName": {
     "type": "string",
     "default": "",
     "description": "Override model name sent in API requests (e.g., deepseek-r1:32b for Ollama). Leave empty to use the standard model selector."
   }
   ```

3. **Optional API key** — Skip the API key prompt/validation when pointing at a local endpoint.

### "Premade API" Concept

The idea: give users a ready-to-go local API setup.

**Simplest version (Ollama):**
```bash
# One command to install + serve
ollama pull deepseek-r1:32b
# API is now live at http://localhost:11434/v1/chat/completions
```

**More complete version (vLLM):**
```bash
python -m vllm.serve deepseek-ai/DeepSeek-R1-Distill-Qwen-32B \
  --enable-reasoning \
  --port 8000
# API is now live at http://localhost:8000/v1/chat/completions
# Returns reasoning_content as separate field
```

**Could we ship a Docker setup?** Yes — a `docker-compose.yml` that runs Ollama (or vLLM) with the right model pre-pulled. But this is scope creep for now. Better to document the setup steps and focus on the extension-side compatibility.

**Verdict:** It's NOT as simple as "just change the URL" because of the `reasoning_content` and `tool_calls` differences. But with a `<think>` tag parser (the main new code), we can support all major local servers.

---

## Part 2: Local Web Search

### Current State

Tavily is the only search provider. The client is cleanly isolated:

- `src/clients/tavilyClient.ts` — HTTP client, calls `POST https://api.tavily.com/search`
- `src/providers/webSearchManager.ts` — State management, caching, formatting

`WebSearchManager` depends on `TavilyClient` through only two methods: `.search()` and `.isConfigured()`.

### Tavily's API Contract (What Any Adapter Must Match)

**Request:**
```typescript
POST /search
{
  api_key: string,
  query: string,
  search_depth: 'basic' | 'advanced',
  include_answer: boolean,
  max_results: number
}
```

**Response:**
```typescript
{
  results: Array<{
    title: string,
    url: string,
    content: string,  // Extracted page text
    score: number      // 0-1 relevance
  }>,
  answer?: string,     // AI-synthesized summary
  query: string,
  response_time: number
}
```

### Alternative Providers

#### SearXNG — Self-Hosted Meta Search (RECOMMENDED for local)

**What:** Free, self-hosted meta search engine. Aggregates 70+ search engines (Google, Bing, DuckDuckGo, etc.). Docker one-liner: `docker run -p 8080:8080 searxng/searxng`.

**API:** Built-in JSON API via `GET /search?q=query&format=json`. No API key needed. Must enable `json` format in `settings.yml`.

**Response:**
```json
{
  "query": "...",
  "results": [
    { "title": "...", "url": "...", "content": "...", "score": 8.5, "engine": "google" }
  ],
  "answers": [],
  "suggestions": []
}
```

**Adapter complexity:** Low. Direct field mapping, normalize score (divide by 10 or similar), map `answers[0]` to `answer`. No AI-synthesized answer (the LLM doesn't need it — it synthesizes its own).

#### Serper.dev — Google SERP API (Cloud Only)

**What:** Cloud service proxying actual Google results. Free tier: 2,500 queries/month.

**API:** `POST https://google.serper.dev/search` with `X-API-KEY` header.

**Response:** Results in `organic` array, URL in `link`, content in `snippet`, no score (position-based), answer in `answerBox.answer`.

**Adapter complexity:** Low. Rename fields, derive score from position.

**Not self-hostable** — cloud only. Good alternative for users who want better results than Tavily.

#### Brave Search API (Cloud Only)

**What:** Cloud service using Brave's independent search index. Free tier: 2,000 queries/month.

**API:** `GET https://api.search.brave.com/res/v1/web/search?q=query` with `X-Subscription-Token` header.

**Adapter complexity:** Low-medium. Deeper nesting, summary is a token array that needs joining.

#### Other Options Evaluated

| Provider | Self-Hosted | Has JSON API | Viable | Notes |
|----------|:-----------:|:------------:|:------:|-------|
| Whoogle | Yes | No | No | HTML-only output, no API |
| YaCy | Yes | Yes | No | P2P, empty index out of box |
| Jina AI | No | Yes | Partial | Good extraction but cloud-only |
| Stract | Yes | Yes | No | Requires building your own web index |

### Recommended Design: SearchClient Interface

The narrow coupling between `WebSearchManager` and `TavilyClient` makes this a clean abstraction:

```typescript
// src/clients/searchClient.ts
export interface SearchClient {
  search(query: string, options?: {
    searchDepth?: 'basic' | 'advanced';
    maxResults?: number;
  }): Promise<SearchResponse>;
  isConfigured(): Promise<boolean>;
}

export interface SearchResponse {
  results: Array<{ title: string; url: string; content: string; score: number }>;
  answer?: string;
  query: string;
  responseTime: number;
}
```

**Factory:**
```typescript
function createSearchClient(context: vscode.ExtensionContext, provider: string): SearchClient {
  switch (provider) {
    case 'tavily':  return new TavilySearchClient(context);
    case 'searxng': return new SearXNGSearchClient(context);
    case 'serper':  return new SerperSearchClient(context);
    case 'brave':   return new BraveSearchClient(context);
    case 'none':    return new NullSearchClient();
    default:        return new TavilySearchClient(context);
  }
}
```

**NullSearchClient** — returns `isConfigured() = false` always. No API calls, no prompts. For users who want zero search overhead.

### New Settings

```json
"deepseek.searchProvider": {
  "type": "string",
  "default": "tavily",
  "enum": ["tavily", "searxng", "serper", "brave", "none"],
  "description": "Web search provider. Use 'searxng' for self-hosted, 'none' to disable."
},
"deepseek.searxngUrl": {
  "type": "string",
  "default": "http://localhost:8080",
  "description": "SearXNG instance URL (only used when searchProvider is 'searxng')"
}
```

### Files Affected

| File | Change |
|------|--------|
| `src/clients/searchClient.ts` | New: interface + factory (~50 lines) |
| `src/clients/tavilyClient.ts` | Refactor to implement `SearchClient` (~20 lines changed) |
| `src/clients/searxngSearchClient.ts` | New: SearXNG adapter (~60 lines) |
| `src/clients/nullSearchClient.ts` | New: no-op client (~20 lines) |
| `src/providers/webSearchManager.ts` | Constructor takes `SearchClient` instead of `TavilyClient` |
| `src/extension.ts` | Use factory based on setting |
| `package.json` | Add settings |

Optional later: `serperSearchClient.ts` (~60 lines), `braveSearchClient.ts` (~70 lines).

---

## Implementation Priority

### Phase 1: Custom Base URL (Minimal Viable)

**Effort:** Small — one new setting, pass it through to client constructor.

1. Add `deepseek.apiEndpoint` setting to `package.json`
2. Read in `ConfigManager`
3. Pass to `DeepSeekClient` constructor
4. Make API key optional for non-cloud endpoints
5. Allow custom model names via `deepseek.customModelName`

**Who this unblocks:** vLLM and SGLang users (full API compatibility).

### Phase 2: `<think>` Tag Parser

**Effort:** Medium — streaming parser + auto-detection.

1. In the streaming handler, detect whether `reasoning_content` field is present
2. If not present, scan `content` for `<think>...</think>` tags
3. Route extracted thinking to `onReasoning` callback
4. Strip tags from `content` before sending to `onContent` callback

**Who this unblocks:** Ollama, llama.cpp, LM Studio users (the majority of local users).

### Phase 3: SearchClient Abstraction + SearXNG

**Effort:** Medium — interface + factory + one adapter.

1. Create `SearchClient` interface
2. Refactor `TavilyClient` to implement it
3. Add `NullSearchClient` (immediate value — disable search cleanly)
4. Add `SearXNGSearchClient`
5. Wire factory in `extension.ts`

**Who this unblocks:** Self-hosted users who want web search without Tavily.

### Phase 4: Polish & Additional Providers (Optional)

- Serper adapter
- Brave adapter
- FIM endpoint adaptation for local servers
- Docker compose template for "premade API"
- Settings UI for endpoint configuration

---

## Decisions To Make

| Question | Options | Recommendation |
|----------|---------|----------------|
| Should we auto-detect local vs cloud? | A) Auto-detect from URL, B) Explicit setting | **A** — if URL is not `api.deepseek.com`, assume local. Simpler UX. |
| Should `<think>` parsing be automatic? | A) Auto-detect, B) Explicit `reasoningParser` setting | **A** — try `reasoning_content` first, fall back to `<think>` tags. No setting needed. |
| Should we support FIM locally? | A) Yes, B) Disable for local | **B for now** — FIM endpoints vary too much across servers. Disable gracefully. |
| Model name: override or free-text? | A) Free-text input, B) Enum + override | **A** — users know their model names. Don't try to enumerate all possible local models. |
| API key when local? | A) Still require, B) Optional | **B** — most local servers have no auth. Skip the prompt. |

---

## What Local Users Actually Get

Be honest with users about the tradeoffs:

| Feature | Cloud (api.deepseek.com) | Local (Ollama + R1-Distill-32B) | Local (vLLM + full 671B) |
|---------|------------------------|-------------------------------|-------------------------|
| Reasoning (R1) | Full quality | Good (distilled, Q4) | Full quality |
| Shell commands (R1) | Full support | Full support | Full support |
| Code edits via code blocks (R1) | Full support | Full support | Full support |
| Tool calling (V3 only) | Full support | N/A (V3 needs enterprise HW) | Full support |
| Web search | Tavily | SearXNG or disabled | SearXNG or disabled |
| Speed | Fast (cloud GPUs) | Depends on hardware | Fast (if enough GPUs) |
| Privacy | Data sent to DeepSeek | Fully local | Fully local |
| Cost | Per-token pricing | Hardware + electricity | Significant hardware |

**The honest pitch:** Local R1 distilled models on consumer hardware get the **full R1 agentic experience** — reasoning, shell commands, code edits, diff management. This is the primary agentic workflow already. V3's structured tool calling (file reads, web search tool, etc.) requires the full 671B model on enterprise hardware, but that's a separate model with a separate use case. Most users running R1 locally will have a very similar experience to the cloud.

---

## Part 3: Model-Agnostic Architecture (The Path Forward)

**This is the long-term direction.** DeepSeek is the starting point, but the extension should evolve into a model-agnostic coding assistant — "Moby" — that works with any LLM backend. The local setup work in Parts 1-2 is the first step toward this.

### The Key Insight: Two Interaction Modes, Not Two Models

The extension currently has two code paths tied to DeepSeek model names (`deepseek-chat` and `deepseek-reasoner`). But these aren't really about DeepSeek — they're two fundamentally different **interaction modes** that any model could use:

#### Mode 1: Tool Loop (currently V3)

```
Send messages + tool definitions → model returns tool_calls → execute → feed result back → loop
```

The model uses structured function calling (OpenAI `tool_calls` format) to invoke extension-defined tools: `apply_code_edit`, `web_search`, `read_file`, `shell_execute`, etc.

**What makes this model-agnostic:**
- The tool definitions are extension-owned, not model-specific
- The `tool_calls` response format is the OpenAI standard — supported by GPT-4o, Llama 3, Qwen 2.5, Mistral, Gemini, and most models served through Ollama/vLLM
- The orchestration logic (`runToolLoop()`) doesn't care which model generated the tool calls
- Any model with function calling support works here

**Models that fit this mode:** GPT-4o, Claude (via adapter), Llama 3.x, Qwen 2.5, Mistral, DeepSeek V3, Gemini, Cohere Command R+

#### Mode 2: Iteration Loop (currently R1)

```
Send messages → model streams text with embedded action tags → parse tags → execute → feed result back → loop
```

The model outputs plain text with embedded tags (`<shell>`, code blocks with `# File:` headers) that the extension parses and executes. No structured API feature needed — it's all text parsing.

**What makes this model-agnostic:**
- The `<shell>` tag format is prompt-engineered via the system prompt, not an API feature
- Any model with decent instruction following can be prompted to use these tags
- The `<think>` reasoning display is becoming a de facto standard across reasoning models
- The orchestration logic (`streamAndIterate()`) just looks for text patterns — it doesn't care which model produced them
- Code block output with `# File: path` headers is a common pattern any coding model can produce

**Models that fit this mode:** DeepSeek R1 (distills), QwQ, Llama reasoning variants, any model prompted to use structured tags. Also works as a fallback for models that don't support tool calling.

### What's Actually DeepSeek-Specific

Very little, once you look at it:

| Component | DeepSeek-specific? | How to generalize |
|-----------|-------------------|-------------------|
| `reasoning_content` API field | Yes (DeepSeek extension to OpenAI spec) | Already need `<think>` tag parser for Ollama. Once built, covers all reasoning models. |
| `<shell>` tag format | No — prompt-engineered | System prompt template per model. Tag format is configurable. |
| `# File: path` code blocks | No — common convention | Already universal. |
| Tool definitions | No — extension-owned | Fully agnostic. |
| API format | OpenAI-compatible | Most providers use this. Anthropic is the exception. |
| `isReasonerModel()` check | Yes — checks for `deepseek-reasoner` | Replace with capability detection. |
| System prompts | Tuned for DeepSeek | Need per-model templates — the hardest part. |

### Architecture: ModelProvider Interface

The abstraction boundary is between **model provider** (API details) and **interaction mode** (tool loop vs iteration loop).

```typescript
// src/providers/models/types.ts

interface ModelCapabilities {
  toolCalling: boolean;    // Can the model return structured tool_calls?
  reasoning: boolean;       // Does the model produce thinking/reasoning output?
  streaming: boolean;       // Does the API support SSE streaming?
  fim: boolean;             // Does the model support fill-in-middle completions?
}

interface StreamChunk {
  content?: string;         // Regular content text
  reasoning?: string;       // Thinking/reasoning text (from reasoning_content OR <think> tags)
  toolCalls?: ToolCall[];   // Structured tool calls (OpenAI format)
  done: boolean;            // Stream complete
}

interface ModelProvider {
  // Core chat
  chat(messages: Message[], options: ChatOptions): AsyncIterable<StreamChunk>;

  // What this model can do
  capabilities: ModelCapabilities;

  // Provider-specific config
  config: ProviderConfig;

  // Optional: FIM completions
  complete?(prompt: string, suffix: string, options: CompletionOptions): AsyncIterable<StreamChunk>;

  // Connection test
  isConfigured(): Promise<boolean>;
}
```

The `StreamChunk` is the key abstraction — it normalizes the differences:
- DeepSeek cloud returns `reasoning_content` as a field → provider puts it in `chunk.reasoning`
- Ollama returns `<think>` tags inline → provider parses them out, puts thinking in `chunk.reasoning`, clean content in `chunk.content`
- OpenAI returns tool calls → provider puts them in `chunk.toolCalls`
- Anthropic returns content blocks → provider maps them to the same shape

### Provider Implementations

```
src/providers/models/
├── types.ts                    # ModelProvider interface, StreamChunk, capabilities
├── registry.ts                 # Provider registry + factory
├── deepseekCloud.ts            # DeepSeek cloud API (current deepseekClient.ts, refactored)
├── openaiCompatible.ts         # Generic OpenAI-compatible (Ollama, vLLM, LM Studio, etc.)
├── openai.ts                   # Native OpenAI (GPT-4o, o1/o3 — if reasoning format differs)
├── anthropic.ts                # Anthropic Claude (different API format entirely)
└── systemPrompts/
    ├── deepseek-reasoner.ts    # R1-specific system prompt template
    ├── generic-iteration.ts    # Generic iteration mode system prompt
    ├── generic-toolcall.ts     # Generic tool calling system prompt
    └── index.ts                # Template selector based on model + capabilities
```

**`deepseekCloud.ts`** — What `deepseekClient.ts` becomes. Handles the `reasoning_content` field natively, both V3 and R1 paths.

**`openaiCompatible.ts`** — The workhorse for local models. Talks to any OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, llama.cpp, etc.). Handles `<think>` tag parsing for reasoning. This single provider covers the majority of local use cases.

**`openai.ts`** — For users who want to use OpenAI models directly. o1/o3 have their own reasoning output format that differs from both DeepSeek and `<think>` tags.

**`anthropic.ts`** — Biggest deviation. Anthropic uses a completely different API format (not OpenAI-compatible), different tool calling structure, and Claude's extended thinking has its own format. Would need the most adaptation work.

### How RequestOrchestrator Changes

The orchestrator already has two paths. The change is replacing model name checks with capability checks:

```typescript
// BEFORE (DeepSeek-specific):
if (this.isReasonerModel()) {
  await this.streamAndIterate(messages, options);
} else {
  await this.runToolLoop(messages, options);
}

// AFTER (capability-based):
if (this.provider.capabilities.toolCalling) {
  await this.runToolLoop(messages, options);  // Any model with function calling
} else {
  await this.streamAndIterate(messages, options);  // Iteration mode as fallback
}

// Reasoning display is independent of interaction mode:
if (this.provider.capabilities.reasoning) {
  // Show thinking panel — works in both modes
}
```

The tool loop and iteration loop code stay almost identical. The only change is where they get their data from — instead of calling `deepseekClient.chat()` directly, they iterate over `provider.chat()` which returns normalized `StreamChunk`s.

### System Prompt: The Hard Part

The API adapter is straightforward. The **system prompt** is where model-specific tuning matters most. The extension's system prompt tells the model:
- What tools are available and how to call them (tool loop mode)
- How to format shell commands with `<shell>` tags (iteration mode)
- How to format code edits with `# File:` headers
- Project context, workspace info, etc.

Different models respond differently to the same instructions. Some are great at structured output, some need more explicit formatting instructions, some hallucinate tool calls.

**Approach:** System prompt templates per model family, with a generic fallback:

```typescript
function getSystemPrompt(provider: ModelProvider, mode: 'tool' | 'iteration'): string {
  // Model-specific template if available
  const template = systemPromptTemplates[provider.config.modelFamily]?.[mode];
  if (template) return template(context);

  // Generic fallback
  return mode === 'tool'
    ? genericToolCallPrompt(context)
    : genericIterationPrompt(context);
}
```

The generic templates should work "well enough" for most models. Model-specific templates are optimizations for known good models (DeepSeek, GPT-4o, Claude, Llama 3, Qwen 2.5).

### Model Selector UX

The current model selector shows `deepseek-chat` and `deepseek-reasoner`. In the agnostic world:

**Option A: Provider + Model two-step**
1. User picks provider (DeepSeek Cloud, Ollama, OpenAI, Anthropic, Custom)
2. Provider determines available models (fetched from API or configured)
3. User picks model from that provider's list

**Option B: Flat model list with capability badges**
1. User configures providers in settings (base URLs, API keys)
2. Model selector shows all available models across providers
3. Each model shows capability badges: [Tools] [Reasoning] [Fast]

Option A is simpler to implement. Option B is better UX long-term.

### Provider Configuration

```json
{
  "moby.providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "(stored in secrets)"
    },
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "models": {
        "deepseek-r1:32b": { "capabilities": { "reasoning": true, "toolCalling": false } },
        "qwen2.5:14b": { "capabilities": { "reasoning": false, "toolCalling": true } }
      }
    },
    "openai": {
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "(stored in secrets)"
    }
  },
  "moby.activeProvider": "deepseek",
  "moby.activeModel": "deepseek-reasoner",
  "moby.searchProvider": "tavily"
}
```

Capabilities could be auto-detected for known models (DeepSeek R1 → reasoning, GPT-4o → tool calling) and manually configured for unknown ones.

### Migration Path: DeepSeek Moby → Moby

This doesn't have to be a big bang. The refactoring is incremental:

**Step 1: Custom base URL** (Part 1 of this doc)
- Add `deepseek.apiEndpoint` setting
- Pass to `DeepSeekClient` instead of hardcoded URL
- Still DeepSeek-branded, but local models work

**Step 2: `<think>` tag parser**
- Add fallback parsing in the streaming handler
- Auto-detect: `reasoning_content` field present → use it, otherwise → parse `<think>` tags
- Enables Ollama/llama.cpp/LM Studio

**Step 3: SearchClient abstraction** (Part 2 of this doc)
- Interface + factory pattern for web search
- NullSearchClient + SearXNG adapter
- Decouples from Tavily

**Step 4: ModelProvider interface** (this section)
- Extract `deepseekClient.ts` into `deepseekCloud.ts` implementing `ModelProvider`
- Create `openaiCompatible.ts` for local/generic servers
- RequestOrchestrator switches from `deepseekClient.method()` to `provider.method()`
- `isReasonerModel()` becomes `provider.capabilities.toolCalling`

**Step 5: Additional providers**
- `openai.ts` for native OpenAI
- `anthropic.ts` for Claude (different API format — most work)
- System prompt templates per model family

**Step 6: Rebrand**
- Rename settings namespace from `deepseek.*` to `moby.*` (with migration)
- Update display names, icons, command prefixes
- Extension ID change if needed

Steps 1-3 are the local setup work. Step 4 is the key architectural pivot. Steps 5-6 are the finish line.

### What Stays the Same

Most of the extension is already model-agnostic and doesn't change:

- **DiffManager** — doesn't care what model generated the code
- **WebSearchManager** — just needs search results, doesn't care about the model
- **FileContextManager** — workspace file operations, model-independent
- **SettingsManager** — gains new settings but the pattern is the same
- **All webview actors** — rendering layer, completely model-agnostic
- **EventStateManager** — pub/sub framework, unchanged
- **ConversationManager / EventStore** — persistence, unchanged
- **ContextBuilder** — needs to know token limits per model, but the building logic is the same

The changes are concentrated in:
- `deepseekClient.ts` → `providers/models/` (provider abstraction)
- `requestOrchestrator.ts` (capability checks instead of model name checks)
- `chatProvider.ts` (provider wiring, model selector)
- `extension.ts` (provider initialization)
- System prompts (per-model templates)

### Risks

| Risk | Mitigation |
|------|------------|
| **System prompt reliability varies wildly across models** | Start with known-good models (DeepSeek, GPT-4o, Llama 3, Qwen 2.5). Generic fallback for others. Mark untested models as "experimental." |
| **Tool calling quality varies** | The DSML parser already handles non-structured fallback. Iteration mode works as a universal fallback for any model. |
| **Anthropic API is fundamentally different** | Treat it as a separate provider with more adapter code. Don't let it drive the architecture — it's the exception, not the rule. |
| **Too many configuration options** | Good defaults. Auto-detect capabilities for known models. Only show advanced config when users explicitly opt in. |
| **Feature matrix confusion** | Clear documentation: "These features work with all models. These features require tool calling. These features require reasoning." |
| **Regression risk during refactor** | Step 4 (ModelProvider extraction) can be done without changing behavior. Extract interface, wrap existing code, verify tests pass, then add new providers. |
