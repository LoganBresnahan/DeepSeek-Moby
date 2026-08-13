/**
 * Templates offered by the "Moby: Add Custom Model" quickPick. Kept in sync
 * with the `examples` array in package.json — package.json is the JSON-schema
 * source of truth for autocomplete, and these are the same templates surfaced
 * through a friendlier UX (no Ctrl+Space required).
 */
export interface CustomModelTemplate {
  label: string;
  description: string;
  detail: string;
  /** 'local' runs the service-location picker wizard after template selection
   *  so the user picks `localhost` vs `host.docker.internal` vs LAN instead
   *  of memorizing networking trivia. 'hosted' skips the picker and uses the
   *  template's baked-in URL verbatim (api.groq.com, api.openai.com, etc.). */
  endpointKind: 'local' | 'hosted';
  /** Default TCP port for the 'local' wizard. Ignored when endpointKind is
   *  'hosted'. Parsed from the template's `apiEndpoint` during setup. */
  defaultPort?: number;
  /** The entry written into `moby.customModels`. Typed loosely on purpose —
   *  `validateCustomModelEntry` is the real gate, and the stencil test proves
   *  every template passes it. */
  entry: Record<string, unknown>;
}

export const CUSTOM_MODEL_TEMPLATES: CustomModelTemplate[] = [
  // ── Stencils ────────────────────────────────────────────────────────
  // Every entry carries the date its facts were checked. Vendor model ids and
  // limits go stale on a scale of months, and a stencil that looks
  // authoritative while being wrong is worse than no stencil — the previous
  // Kimi entry was wrong on the model id, the limits, AND `reasoningEcho`
  // simultaneously, and the last of those 400s on the *second* tool iteration
  // where a smoke test won't catch it.
  //
  // Values marked UNVERIFIED come from vendor docs, not from a turn we ran.
  // See docs/plans/thinking-modes-and-levels.md (phase 7) and ADR 0017.
  {
    // Verified 2026-08-12. Qwen 2.5 Coder 7B replaced: qwen3-coder is the
    // current coding line, and 30B-A3B activates only 3B params/token so it
    // still fits a 16GB card.
    label: 'Ollama — Qwen3 Coder 30B',
    description: 'http://localhost:11434/v1',
    detail: 'Local Ollama — 256K context, native tool calling',
    endpointKind: 'local',
    defaultPort: 11434,
    entry: {
      id: 'qwen3-coder:30b',
      name: 'Qwen3 Coder 30B (Ollama)',
      toolCalling: 'native',
      reasoningTokens: 'none',
      editProtocol: ['native-tool'],
      shellProtocol: 'none',
      supportsTemperature: true,
      maxOutputTokens: 8192,
      // Ollama's own default num_ctx is far smaller than the model's 256K;
      // raise it on the server side (or via extraParams) to actually get it.
      contextWindow: 262144,
      maxTokensConfigKey: 'maxTokensCustomQwen',
      streaming: true,
      apiEndpoint: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      requestFormat: 'openai',
      lspTools: true
    }
  },
  {
    // Placeholder id BY DESIGN — the user replaces it with whatever model
    // they have loaded. Verified 2026-08-12: fields still correct; limits are
    // whatever the loaded model and LM Studio's context slider allow, so no
    // contextWindow is declared (the 128K fallback applies).
    label: 'LM Studio (Local)',
    description: 'http://localhost:1234/v1',
    detail: 'Local LM Studio — replace `id` with your loaded model name',
    endpointKind: 'local',
    defaultPort: 1234,
    entry: {
      id: 'local-model-in-lm-studio',
      name: 'LM Studio (Local)',
      toolCalling: 'native',
      reasoningTokens: 'none',
      editProtocol: ['native-tool'],
      shellProtocol: 'none',
      supportsTemperature: true,
      maxOutputTokens: 4096,
      maxTokensConfigKey: 'maxTokensCustomLMStudio',
      streaming: true,
      apiEndpoint: 'http://localhost:1234/v1',
      apiKey: 'lm-studio',
      requestFormat: 'openai'
    }
  },
  {
    // Placeholder id by design, same as LM Studio. Verified 2026-08-12.
    label: 'llama.cpp Server',
    description: 'http://localhost:8080/v1',
    detail: 'Local llama.cpp — uses SEARCH/REPLACE for edits + <shell> for commands (R1-style)',
    endpointKind: 'local',
    defaultPort: 8080,
    entry: {
      id: 'local-llama-cpp',
      name: 'llama.cpp Server',
      toolCalling: 'none',
      reasoningTokens: 'none',
      editProtocol: ['search-replace'],
      shellProtocol: 'xml-shell',
      supportsTemperature: true,
      maxOutputTokens: 4096,
      maxTokensConfigKey: 'maxTokensCustomLlamaCpp',
      streaming: true,
      apiEndpoint: 'http://localhost:8080/v1',
      apiKey: 'llamacpp',
      requestFormat: 'openai'
    }
  },
  {
    // Verified 2026-08-12. GPT-4o mini replaced by the GPT-5.6 line.
    //
    // The first stencil needing `maxTokensParam`: OpenAI's reasoning models
    // REJECT `max_tokens` outright. UNVERIFIED: whether `reasoning_effort`
    // is honoured on /chat/completions (Moby's endpoint) or only the
    // Responses API, and whether temperature is rejected outright.
    label: 'OpenAI GPT-5.6',
    description: 'https://api.openai.com/v1',
    detail: 'Hosted OpenAI — 1M context, graded reasoning. Set API key via the settings popup.',
    endpointKind: 'hosted',
    entry: {
      id: 'gpt-5.6',
      name: 'OpenAI GPT-5.6',
      toolCalling: 'native',
      reasoningTokens: 'inline',
      editProtocol: ['native-tool'],
      shellProtocol: 'none',
      supportsTemperature: false,
      maxOutputTokens: 128000,
      contextWindow: 1050000,
      maxTokensParam: 'max_completion_tokens',
      maxTokensConfigKey: 'maxTokensCustomOpenAI',
      streaming: true,
      apiEndpoint: 'https://api.openai.com/v1',
      requestFormat: 'openai',
      thinkingLevels: {
        low: { reasoning_effort: 'low' },
        medium: { reasoning_effort: 'medium' },
        high: { reasoning_effort: 'high' },
        xhigh: { reasoning_effort: 'xhigh' }
      },
      defaultThinkingLevel: 'medium',
      // Off is expressed AS a level value here — which is exactly why the
      // off-knob is a param bundle rather than a boolean.
      disableThinkingParam: { reasoning_effort: 'none' },
      lspTools: true,
      acceptsImages: true,
      subagentRoles: ['image-describe']
    }
  },
  {
    // K3 replaces the moonshot-v1-128k pair (chat + vision-preview). It is
    // natively multimodal, so ONE entry serves both the main loop and the
    // image-describe role. Verified 2026-08-12 against vendor docs; a live
    // dev-host turn is M47.
    //
    // Two K3 facts drive fields that look redundant:
    //  - It always reasons. There is no off-knob, so no `disableThinkingParam`
    //    — subagent roles get the cheapest declared level instead.
    //  - It takes `reasoning_effort` bare at the top level. K2.x used a
    //    `thinking` wrapper; K3 dropped it. This is why levels are declared
    //    per model rather than enumerated once.
    label: 'Kimi K3 (Moonshot)',
    description: 'https://api.moonshot.ai/v1',
    detail: 'Hosted Moonshot — 1M context, native vision, always reasoning. Set API key via the settings popup.',
    endpointKind: 'hosted',
    entry: {
      id: 'kimi-k3',
      name: 'Kimi K3 (Moonshot)',
      toolCalling: 'native',
      reasoningTokens: 'inline',
      editProtocol: ['native-tool'],
      shellProtocol: 'none',
      // Temperature is fixed at 1.0 upstream and the docs say to omit it.
      // Omitting is the weaker claim than pinning it via temperatureFixedValue.
      supportsTemperature: false,
      maxOutputTokens: 131072,
      maxOutputTokensCap: 1048576,
      contextWindow: 1048576,
      maxTokensConfigKey: 'maxTokensCustomKimi',
      streaming: true,
      apiEndpoint: 'https://api.moonshot.ai/v1',
      requestFormat: 'openai',
      thinkingLevels: {
        low: { reasoning_effort: 'low' },
        high: { reasoning_effort: 'high' },
        max: { reasoning_effort: 'max' }
      },
      defaultThinkingLevel: 'max',
      // Without this, multi-turn tool loops 400 on iteration 2 with
      // "reasoning_content must be passed back" — the first turn looks fine.
      reasoningEcho: 'required',
      lspTools: true,
      acceptsImages: true,
      subagentRoles: ['image-describe']
    }
  },
  {
    // Verified 2026-08-12. Google's OpenAI-compat endpoint maps effort names
    // onto Gemini's native integer `thinkingBudget` server-side, so we send
    // plain `reasoning_effort` and never see the integer.
    //
    // No `disableThinkingParam`: reasoning cannot be turned off on the 3.x
    // line (2.5 accepted `"none"`). UNVERIFIED: the exact limits for 3.6 —
    // these are 3.5-flash's, which is the closest documented sibling.
    label: 'Gemini 3.6 Flash (Google)',
    description: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    detail: 'Hosted Google — 1M context, native vision. Set API key via the settings popup.',
    endpointKind: 'hosted',
    entry: {
      id: 'gemini-3.6-flash',
      name: 'Gemini 3.6 Flash',
      toolCalling: 'native',
      reasoningTokens: 'inline',
      editProtocol: ['native-tool'],
      shellProtocol: 'none',
      supportsTemperature: true,
      maxOutputTokens: 65536,
      contextWindow: 1048576,
      maxTokensConfigKey: 'maxTokensCustomGemini',
      streaming: true,
      apiEndpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      requestFormat: 'openai',
      thinkingLevels: {
        minimal: { reasoning_effort: 'minimal' },
        low: { reasoning_effort: 'low' },
        medium: { reasoning_effort: 'medium' },
        high: { reasoning_effort: 'high' }
      },
      defaultThinkingLevel: 'medium',
      lspTools: true,
      acceptsImages: true,
      subagentRoles: ['image-describe']
    }
  },
  {
    // Verified 2026-08-12. The third disable mechanism in the survey: a
    // sibling boolean rather than a wrapper or a sentinel level value.
    //
    // UNVERIFIED: the exact model id. Zhipu's own line is `glm-<version>`
    // (glm-4.5, glm-4.6), but resellers publish it as `zai-org/GLM-5.2` and
    // similar — check your provider's model list before the first turn.
    label: 'GLM-5.2 (Zhipu)',
    description: 'https://open.bigmodel.cn/api/paas/v4/',
    detail: 'Hosted Zhipu — 1M context, toggleable reasoning. Set API key via the settings popup.',
    endpointKind: 'hosted',
    entry: {
      id: 'glm-5.2',
      name: 'GLM-5.2 (Zhipu)',
      toolCalling: 'native',
      reasoningTokens: 'inline',
      editProtocol: ['native-tool'],
      shellProtocol: 'none',
      supportsTemperature: true,
      maxOutputTokens: 131072,
      contextWindow: 1000000,
      maxTokensConfigKey: 'maxTokensCustomGLM',
      streaming: true,
      apiEndpoint: 'https://open.bigmodel.cn/api/paas/v4/',
      requestFormat: 'openai',
      thinkingLevels: {
        high: { reasoning_effort: 'high' },
        max: { reasoning_effort: 'max' }
      },
      defaultThinkingLevel: 'high',
      disableThinkingParam: { enable_thinking: false },
      lspTools: true
    }
  },
  {
    // Verified 2026-08-12. OpenRouter fronts hundreds of models behind one
    // key, so the `id` here is an EXAMPLE to swap — and the capability fields
    // (limits, vision, echo) track whichever model you point it at.
    //
    // What does NOT change with the model is the reasoning shape: OpenRouter
    // normalizes reasoning into a nested `reasoning: { effort }` object, and
    // flat `reasoning_effort` is deprecated on their surface. Sending BOTH is
    // a known 400 in other clients — we send exactly what's declared, so
    // there is nothing to collide.
    //
    // UNVERIFIED: how to disable reasoning entirely. `reasoning.exclude` hides
    // the tokens but still reasons, which is not the same thing, so no
    // `disableThinkingParam` is declared rather than guessing at a knob.
    label: 'OpenRouter (any model)',
    description: 'https://openrouter.ai/api/v1',
    detail: 'Hosted OpenRouter — one key, many models. Replace `id` with any OpenRouter model.',
    endpointKind: 'hosted',
    entry: {
      id: 'moonshotai/kimi-k3',
      name: 'Kimi K3 (via OpenRouter)',
      toolCalling: 'native',
      reasoningTokens: 'inline',
      editProtocol: ['native-tool'],
      shellProtocol: 'none',
      supportsTemperature: false,
      maxOutputTokens: 131072,
      contextWindow: 1048576,
      maxTokensConfigKey: 'maxTokensCustomOpenRouter',
      streaming: true,
      apiEndpoint: 'https://openrouter.ai/api/v1',
      requestFormat: 'openai',
      thinkingLevels: {
        low: { reasoning: { effort: 'low' } },
        medium: { reasoning: { effort: 'medium' } },
        high: { reasoning: { effort: 'high' } },
        xhigh: { reasoning: { effort: 'xhigh' } }
      },
      defaultThinkingLevel: 'medium',
      reasoningEcho: 'required',
      // Provider-routing preferences — OpenRouter-specific, and nothing Moby
      // reasons about, so they ride the escape hatch. `allow_fallbacks: true`
      // is OpenRouter's own default: this demonstrates the shape without
      // imposing a routing policy. Replace with your own preferences, e.g.
      // `{"order": ["together", "fireworks"], "allow_fallbacks": false}`.
      extraParams: {
        provider: { allow_fallbacks: true }
      },
      lspTools: true,
      acceptsImages: true
    }
  },
  {
    // Verified 2026-08-12. Placeholder id by design — replace with whatever
    // you passed to `--model`.
    //
    // vLLM is the reference case for BOTH declaration mechanisms. Its docs
    // describe the escape hatch almost verbatim ("parameters that are not
    // part of the OpenAI API... merge them into the JSON payload"), and its
    // reasoning knob is nested two levels deep — a Qwen3 served by vLLM
    // disables thinking via the chat template, not a request field. Neither
    // needed a code change to support.
    //
    // No `extraParams` by default: vLLM's extras are sampling knobs (`top_k`,
    // `repetition_penalty`, `min_p`), and a stencil that pins those is
    // imposing a sampling policy rather than describing a provider.
    label: 'vLLM Server (Local)',
    description: 'http://localhost:8000/v1',
    detail: 'Local vLLM — replace `id` with your served model. Thinking toggle assumes a Qwen3-style chat template.',
    endpointKind: 'local',
    defaultPort: 8000,
    entry: {
      id: 'model-served-by-vllm',
      name: 'vLLM Server (Local)',
      toolCalling: 'native',
      reasoningTokens: 'inline',
      editProtocol: ['native-tool'],
      shellProtocol: 'none',
      supportsTemperature: true,
      maxOutputTokens: 8192,
      maxTokensConfigKey: 'maxTokensCustomVllm',
      streaming: true,
      apiEndpoint: 'http://localhost:8000/v1',
      apiKey: 'vllm',
      requestFormat: 'openai',
      // Two levels of nesting — the fourth structurally distinct off-knob in
      // the survey, after a wrapper, a sibling boolean, and a sentinel value.
      // Drop this field if your served model has no thinking mode.
      disableThinkingParam: { chat_template_kwargs: { enable_thinking: false } },
      lspTools: true
    }
  },
  {
    // Verified 2026-08-12. `llama-3.3-70b-versatile` was DEPRECATED by Groq
    // on 2026-06-17; gpt-oss-120b is the replacement Groq itself names.
    //
    // UNVERIFIED: whether Groq honours `reasoning_effort` for gpt-oss on its
    // OpenAI-compat surface. GPT-OSS grades reasoning natively, so the levels
    // are declared — if a turn 400s, drop `thinkingLevels` rather than
    // guessing at a different field.
    label: 'GPT-OSS 120B (Groq)',
    description: 'https://api.groq.com/openai/v1',
    detail: 'Hosted Groq — fast inference, open-weight. Set API key via the settings popup.',
    endpointKind: 'hosted',
    entry: {
      id: 'openai/gpt-oss-120b',
      name: 'GPT-OSS 120B (Groq)',
      toolCalling: 'native',
      reasoningTokens: 'inline',
      editProtocol: ['native-tool'],
      shellProtocol: 'none',
      supportsTemperature: true,
      maxOutputTokens: 65536,
      contextWindow: 131072,
      maxTokensConfigKey: 'maxTokensCustomGroq',
      streaming: true,
      apiEndpoint: 'https://api.groq.com/openai/v1',
      requestFormat: 'openai',
      thinkingLevels: {
        low: { reasoning_effort: 'low' },
        medium: { reasoning_effort: 'medium' },
        high: { reasoning_effort: 'high' }
      },
      defaultThinkingLevel: 'medium',
      lspTools: true
    }
  }
];