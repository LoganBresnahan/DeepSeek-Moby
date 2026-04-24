# Custom models

Moby talks to DeepSeek by default, but the same engine works with any OpenAI-compatible API. This lets you point it at a local runner (Ollama, LM Studio, llama.cpp), a proxy/router (LiteLLM), or a hosted provider (OpenAI, together.ai, etc.).

You declare custom models in VS Code settings via `moby.customModels`. Each entry describes *one model* and its capabilities. Moby reads the file at activation, merges the entries into its model registry, and shows them alongside built-ins in the model dropdown.

## Quick start: Ollama

1. Install and start [Ollama](https://ollama.com/), pull a model:
   ```sh
   ollama pull qwen2.5-coder:7b-instruct
   ```
2. Open your VS Code `settings.json` (User or Workspace) and add:
   ```jsonc
   "moby.customModels": [
     {
       "id": "qwen2.5-coder:7b-instruct",
       "name": "Qwen 2.5 Coder 7B (Ollama)",
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
  "id": "gpt-4o-mini",
  "apiEndpoint": "https://api.openai.com/v1",
  "apiKey": "sk-...",
  // ...
}
```

**Security note:** Putting an API key in `settings.json` means it's in plain text on disk (and in your dotfiles backups if you sync settings). For local runners this is fine — the key is a placeholder. For hosted providers with real billing (OpenAI, Anthropic), consider using LiteLLM as a local proxy so the real key only lives in the LiteLLM config, and Moby only holds a per-machine proxy token.

## Field reference

| Field | Values | What it controls |
|---|---|---|
| `id` | string | Model ID sent in the request body. Must not collide with a built-in (`deepseek-chat`, `deepseek-reasoner`). |
| `name` | string | Display name in the model selector dropdown. |
| `toolCalling` | `"native"` \| `"none"` | Does the model support OpenAI-format function calling? Chat-style models → `"native"`. Pure reasoning models (R1-style) → `"none"`. |
| `reasoningTokens` | `"inline"` \| `"none"` | Does the API return a separate `reasoning_content` channel (R1, QwQ)? Most models → `"none"`. |
| `editProtocol` | `["native-tool"]` \| `["search-replace"]` \| `["native-tool", "search-replace"]` | How the model is expected to express file edits. Tool-calling models → `["native-tool"]`. |
| `shellProtocol` | `"xml-shell"` \| `"none"` | R1's `<shell>…</shell>` fallback. Almost always `"none"` for custom models. |
| `supportsTemperature` | boolean | Whether to send `temperature` in the request. Reasoning models often reject it. |
| `maxOutputTokens` | number | Hard cap on completion tokens. Match what the model actually supports. |
| `maxTokensConfigKey` | string | A unique VS Code setting name for the per-model max-tokens override (e.g. `"maxTokensCustomQwen"`). Invented per-entry. |
| `streaming` | boolean | Use SSE streaming responses. Almost always `true` for OpenAI-compat. |
| `apiEndpoint` | string | Base URL for the OpenAI-compat API. The client appends `/chat/completions`. |
| `apiKey` | string (optional) | API key. Omit to fall back to the global `moby.apiKey` secret. Local runners usually accept any non-empty string. |
| `tokenizer` | `"deepseek-v3"` (optional) | Reuse a bundled tokenizer for exact counting. Omit for custom models (Moby falls back to character-based estimation that auto-calibrates from real API usage within a few messages). |
| `requestFormat` | `"openai"` | Wire format. Only `"openai"` is supported today. |

## What falls back to estimation

Token counting for custom models uses the estimation counter (character-based heuristic, auto-calibrates from `usage.prompt_tokens` returned by the endpoint). Counts are within ±5% after ~5-10 messages, ±10% on cold start. This is a tradeoff: we avoid shipping a separate tokenizer vocab per model.

If your model happens to use the same tokenizer as DeepSeek V3, you can set `"tokenizer": "deepseek-v3"` to get exact counts. Otherwise leave it out.

## What doesn't yet work

- **Stats modal balance display** — the balance widget calls DeepSeek's `/user/balance` endpoint, which doesn't exist elsewhere. It returns `null` for non-DeepSeek models and the modal just hides the line. A richer "estimated cost from `usage` tokens" display is planned (see [model-capability-registry plan](../plans/model-capability-registry.md) F7).
- **Per-model secure API-key storage.** Keys live in `moby.customModels` plaintext today. F3 follow-up work will move them to VS Code's SecretStorage.

## Troubleshooting

**The model doesn't appear in the dropdown.**
- Check Output → DeepSeek Moby for `[Registry] Loaded N custom model(s)` or `[Registry] Custom model rejected — ...` messages. The rejection text identifies which field is invalid.
- Make sure the `id` doesn't collide with `deepseek-chat` or `deepseek-reasoner`.

**Requests fail with 401 / 403.**
- Check the `apiKey`. Local runners usually ignore it but still need *something* non-empty.
- For hosted providers, verify the key works against the same endpoint via `curl`.

**Requests fail with 404.**
- Your `apiEndpoint` is probably wrong. The base URL should be the OpenAI-compat root (ending in `/v1` for most runners, or just the hostname for DeepSeek). Moby appends `/chat/completions` itself.

**The model selector shows the name but switching to it doesn't stream.**
- Likely the endpoint doesn't actually speak OpenAI format. Some runners need a specific path prefix; check their docs.
- Verify `streaming: true` is correct for the runner.
