# Custom models

Moby talks to DeepSeek by default, but the same engine works with any OpenAI-compatible API. This lets you point it at a local runner (Ollama, LM Studio, llama.cpp), a proxy/router (LiteLLM), or a hosted provider (OpenAI, together.ai, etc.).

**The fastest route is `Moby: Add Custom Model`** — it offers dated stencils for
Ollama, LM Studio, llama.cpp, vLLM, OpenAI, Kimi, Gemini, GLM, Groq, and
OpenRouter, and writes a correct entry for you. Read on if you want to
hand-write one or understand what the fields mean.

You declare custom models in VS Code settings via `moby.customModels`. Each entry describes *one model* and its capabilities. Moby reads the file at activation, merges the entries into its model registry, and shows them alongside built-ins in the model dropdown.

## Quick start: Ollama

1. Install and start [Ollama](https://ollama.com/), pull a model:
   ```sh
   ollama pull qwen3-coder:30b
   ```
2. Open your VS Code `settings.json` (User or Workspace) and add:
   ```jsonc
   "moby.customModels": [
     {
       "id": "qwen3-coder:30b",
       "name": "Qwen3 Coder 30B (Ollama)",
       "toolCalling": "native",
       "reasoningTokens": "none",
       "editProtocol": ["native-tool"],
       "shellProtocol": "none",
       "supportsTemperature": true,
       "maxOutputTokens": 8192,
       "contextWindow": 262144,
       "maxTokensConfigKey": "maxTokensCustomQwen",
       "streaming": true,
       "apiEndpoint": "http://localhost:11434/v1",
       "apiKey": "ollama",
       "requestFormat": "openai"
     }
   ]
   ```
3. Open Moby. Your new model appears in the model dropdown. Select it.

Model ID + endpoint together point the HTTP client at the right runner. No rebuild needed — settings changes reload the registry on the fly.

## Other OpenAI-compat runners

All of these work with the same JSON shape — change `apiEndpoint` (and `id` to match the model you loaded).

### LM Studio
```jsonc
{
  "id": "your-model-name-in-lm-studio",
  "apiEndpoint": "http://localhost:1234/v1",
  "apiKey": "lm-studio",
  // ... rest same as Ollama entry
}
```

### llama.cpp server
```jsonc
{
  "id": "model-served-by-llama-cpp",
  "apiEndpoint": "http://localhost:8080/v1",
  "apiKey": "llamacpp",
  // ...
}
```

### LiteLLM (proxy for many providers)
If you want Moby to reach multiple hosted providers (Anthropic, OpenAI, Together, etc.) through one endpoint, run [LiteLLM](https://github.com/BerriAI/litellm) and point Moby at its proxy:
```jsonc
{
  "id": "claude-sonnet-via-litellm",
  "apiEndpoint": "http://localhost:4000/v1",
  "apiKey": "sk-litellm-master-key",
  // ...
}
```

### Hosted OpenAI
```jsonc
{
  "id": "gpt-5.6",
  "apiEndpoint": "https://api.openai.com/v1",
  "maxTokensParam": "max_completion_tokens",  // reasoning models REJECT max_tokens
  "reasoningTokens": "inline",
  // ...
}
```

**Security note:** Putting an API key in `settings.json` means it's in plain text on disk (and in your dotfiles backups if you sync settings). For local runners this is fine — the key is a placeholder. For hosted providers with real billing (OpenAI, Anthropic), prefer the **Moby: Set Custom Model API Key** command, which stores the key in VS Code's SecretStorage (secret key `moby.customModelKey.<id>`) instead of `settings.json`. That per-model secret takes precedence over the plaintext `apiKey` in `moby.customModels` and the global `moby.apiKey` secret, so you can leave `apiKey` out of the JSON entirely. Alternatively, run LiteLLM as a local proxy so the real key only lives in the LiteLLM config and Moby only holds a per-machine proxy token.

## Field reference

| Field | Values | What it controls |
|---|---|---|
| `id` | string | Model ID sent in the request body. Must not collide with any built-in (`deepseek-v4-pro-thinking`, `deepseek-v4-flash-thinking`, `deepseek-chat`, `deepseek-reasoner`). |
| `name` | string | Display name in the model selector dropdown. |
| `toolCalling` | `"native"` \| `"none"` | Does the model support OpenAI-format function calling? Chat-style models → `"native"`. Pure reasoning models (R1-style) → `"none"`. |
| `reasoningTokens` | `"inline"` \| `"none"` | Does the API return a separate `reasoning_content` channel (R1, QwQ)? Most models → `"none"`. |
| `editProtocol` | `["native-tool"]` \| `["search-replace"]` \| `["native-tool", "search-replace"]` | How the model is expected to express file edits. Tool-calling models → `["native-tool"]`. |
| `shellProtocol` | `"xml-shell"` \| `"native-tool"` \| `"none"` | How the model expresses shell commands. R1 uses `"xml-shell"` (`<shell>…</shell>` tags in content). Native-tool models use `"native-tool"` (a `run_shell` tool in the tools array). Almost always `"native-tool"` for custom models with `toolCalling: "native"`. |
| `thinkingLevels` | object (optional) | Selectable reasoning levels, in display order. Keys become the labels in the model picker; values are the request params sent when that level is active. See [Declaring reasoning](#declaring-reasoning) below. |
| `defaultThinkingLevel` | string (optional) | Which `thinkingLevels` key applies when the user hasn't picked one. Must name a declared level. |
| `disableThinkingParam` | object (optional) | Your provider's params for turning reasoning **off**. **Absence is meaningful**: it declares the model cannot be turned off, and the picker then renders no Off control rather than one that does nothing. |
| `noSamplingParamsWhenThinking` | boolean (optional) | The provider rejects `temperature`/`top_p`/`presence_penalty`/`frequency_penalty` **while reasoning**. Applied per request, so a non-thinking turn on the same model keeps them. Use `supportsTemperature: false` instead when the provider never accepts temperature at all. |
| `maxTokensParam` | `"max_tokens"` \| `"max_completion_tokens"` | Which field carries the max-output value. OpenAI's reasoning models **reject** `max_tokens`. Not a pure rename — `max_completion_tokens` is spent on the reasoning trace as well as the answer, so the same number buys less visible output. Defaults to `"max_tokens"`. |
| `extraParams` | object (optional) | Params merged into **every** request — the escape hatch for provider fields Moby doesn't model (`safety_settings`, `service_tier`, a router's provider preferences). Moby never interprets them. Cannot set `model`, `messages`, `stream`, `tools`, `max_tokens`, or `max_completion_tokens`. |
| `wireModelId` | string (optional) | Model id to send on the wire when it differs from `id`. Rarely needed. |
| `temperatureFixedValue` | number (optional) | Pin temperature to exactly this value, overriding the global setting. For providers that accept only one (some reject anything but `1`). |
| `acceptsImages` | boolean (optional) | Model accepts image content parts. Required for the `image-describe` subagent role. |
| `reasoningEcho` | `"required"` \| `"optional"` \| `"none"` | Whether `reasoning_content` must be echoed back in subsequent requests after tool calls. V4-thinking requires `"required"` or the API 400s. Defaults to `"none"`. |
| `promptStyle` | `"minimal"` \| `"standard"` | System-prompt flavor. `"minimal"` drops the reference-vs-edit decision tree and most numbered rules — calibrated for thinking-style models that infer intent. `"standard"` (default) is the full prompt for V3 / non-thinking / custom models. |
| `streamingToolCalls` | boolean | Route through a single streaming pipeline that accumulates `delta.tool_calls` alongside content. Eliminates duplicate generation on no-tool turns. Set `true` for all native-tool models unless your runner has buggy SSE tool-call streaming. Defaults to `false`. |
| `maxOutputTokensCap` | number (optional) | Upper bound for the per-model maxTokens slider. When absent, the slider max falls back to `maxOutputTokens` (V3 behavior where default and cap coincide). V4 sets this to 384000 to match the real API cap. |
| `contextWindow` | number (optional) | Total context window (input + output) in tokens. Drives ContextBuilder's conversation-history budget. Falls back to 128000 when omitted. |
| `supportsTemperature` | boolean | Whether to send `temperature` in the request. Reasoning models often reject it. |
| `maxOutputTokens` | number | Hard cap on completion tokens. Match what the model actually supports. |
| `maxTokensConfigKey` | string | A unique VS Code setting name for the per-model max-tokens override (e.g. `"maxTokensCustomQwen"`). Invented per-entry. |
| `streaming` | boolean | Use SSE streaming responses. Almost always `true` for OpenAI-compat. |
| `apiEndpoint` | string | Base URL for the OpenAI-compat API. The client appends `/chat/completions`. |
| `apiKey` | string (optional) | API key. Overridden by a per-model SecretStorage key (set via **Moby: Set Custom Model API Key**) when one exists; if both are omitted, falls back to the global `moby.apiKey` secret (then the `DEEPSEEK_API_KEY` env var). Local runners usually accept any non-empty string. |
| `tokenizer` | `"deepseek-v3"` \| `"deepseek-v4"` (optional) | Reuse a bundled tokenizer for exact counting. Pick `"deepseek-v4"` for V4-derived models (its vocab adds ~465 special tokens the V3 vocab under-counts). Omit for other custom models (Moby falls back to character-based estimation that auto-calibrates from real API usage within a few messages). |
| `lspTools` | boolean (optional) | Expose the LSP-backed navigation tools (`outline`, `get_symbol_source`) to this model. Defaults to `false`; native-tool models can opt in. |
| `subagentRoles` | string[] (optional) | Subagent roles this model may serve when wired up via `moby.subagents` (e.g. `["web-search-digest"]`). Empty/absent = main-loop only. |
| `requestFormat` | `"openai"` | Wire format. Only `"openai"` is supported today. |

## Declaring reasoning

Providers disagree about reasoning more than about anything else — not just the
values, but the *shape* of the request. Rather than Moby guessing, each entry
declares its own vocabulary: `thinkingLevels` maps a level name to the params
that level sends, and `disableThinkingParam` holds whatever turns reasoning off.
Moby merges them verbatim and never invents a knob, because a wrong guess is a
400 rather than a slow answer.

Four real shapes, all expressed the same way:

```jsonc
// Kimi K3 — bare top-level field, and NO off switch (it always reasons)
"thinkingLevels": {
  "low":  { "reasoning_effort": "low" },
  "high": { "reasoning_effort": "high" },
  "max":  { "reasoning_effort": "max" }
},
"defaultThinkingLevel": "max"

// DeepSeek V4 — a wrapper object alongside the effort
"thinkingLevels": {
  "high": { "thinking": { "type": "enabled" }, "reasoning_effort": "high" }
},
"disableThinkingParam": { "thinking": { "type": "disabled" } }

// OpenAI — "off" is itself a level value
"disableThinkingParam": { "reasoning_effort": "none" }

// A Qwen3 served by vLLM — the knob lives in the chat template, nested two deep
"disableThinkingParam": { "chat_template_kwargs": { "enable_thinking": false } }
```

The model picker renders one pill per declared level, and an Off pill only when
`disableThinkingParam` is present — so a control can never exist without params
behind it. Level labels come from the key, so declaring `"medium"` renders
*Medium* with no code change on Moby's side.

Users override the active level in `moby.modelOptions`:

```jsonc
"moby.modelOptions": {
  "kimi-k3": { "thinking": "on", "thinkingLevel": "low" }
}
```

Two keys rather than one so that turning reasoning off and back on remembers the
level. A `thinkingLevel` the model doesn't declare is ignored with a warning
rather than sent.

**If your model returns reasoning**, also set `reasoningTokens: "inline"` — and
check whether the provider requires `reasoning_content` echoed back on later
requests (`reasoningEcho: "required"`). That one is easy to miss: the symptom is
a 400 on the *second* iteration of a tool loop, not the first, so a quick test
looks fine.

## What falls back to estimation

Token counting for custom models uses the estimation counter (character-based heuristic, auto-calibrates from `usage.prompt_tokens` returned by the endpoint). Counts are within ±5% after ~5-10 messages, ±10% on cold start. This is a tradeoff: we avoid shipping a separate tokenizer vocab per model.

If your model happens to use the same tokenizer as DeepSeek V3 or V4, you can set `"tokenizer": "deepseek-v3"` (or `"deepseek-v4"` for V4-derived models) to get exact counts. Otherwise leave it out.

## What doesn't yet work

- **Stats modal balance display** — the balance widget calls DeepSeek's `/user/balance` endpoint, which doesn't exist elsewhere. It returns `null` for non-DeepSeek models and the modal just hides the line. A richer "estimated cost from `usage` tokens" display is planned (see [model-capability-registry plan](../plans/completed/model-capability-registry.md) F7).

## Troubleshooting

**The model doesn't appear in the dropdown.**
- Check Output → DeepSeek Moby for `[Registry] Loaded N custom model(s)` or `[Registry] Custom model rejected — ...` messages. The rejection text identifies which field is invalid.
- Make sure the `id` doesn't collide with any built-in (`deepseek-v4-pro-thinking`, `deepseek-v4-flash-thinking`, `deepseek-chat`, `deepseek-reasoner`).

**Requests fail with 401 / 403.**
- Check the `apiKey`. Local runners usually ignore it but still need *something* non-empty.
- For hosted providers, verify the key works against the same endpoint via `curl`.

**Requests fail with 404.**
- Your `apiEndpoint` is probably wrong. The base URL should be the OpenAI-compat root (ending in `/v1` for most runners, or just the hostname for DeepSeek). Moby appends `/chat/completions` itself.

**The model selector shows the name but switching to it doesn't stream.**
- Likely the endpoint doesn't actually speak OpenAI format. Some runners need a specific path prefix; check their docs.
- Verify `streaming: true` is correct for the runner.
