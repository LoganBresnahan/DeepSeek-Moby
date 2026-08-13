import type * as vscode from 'vscode';
import { HttpClient, HttpError, createStreamReader, DEFAULT_REQUEST_TIMEOUT_MS } from './utils/httpClient';
import { ConfigManager } from './utils/config';
import { logger } from './utils/logger';
import { tracer } from './tracing';
import { TokenCounter, EstimationTokenCounter, DynamicTokenCounter, countRequestTokens, countRequestChars } from './services/tokenCounter';
import { ContextBuilder, ContextResult, SnapshotSummary } from './context/contextBuilder';
import { getCapabilities, DEFAULT_MODEL_ID, isReasonerModel as isReasonerModelFromRegistry, resolveThinkingSelection } from './models/registry';
import type { ModelThinkingOptions } from './models/registry';

/**
 * Does any message carry an `image_url` content part? Used to exclude
 * image-bearing requests from token calibration — see `crossValidateTokens`.
 */
export function hasImageContent(messages: Array<Record<string, unknown>>): boolean {
  return messages.some(msg =>
    Array.isArray(msg.content) &&
    (msg.content as Array<{ type?: unknown }>).some(part => part?.type === 'image_url')
  );
}

export type MessageContent = string | Array<{
  type: 'text';
  text: string;
} | {
  type: 'image_url';
  image_url: { url: string };
}>;

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: MessageContent;
  timestamp?: Date;
  tokens?: number;
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  /** Event store ID — used by ContextBuilder for token count caching */
  eventId?: string;
}

// JSON Schema fragment for tool parameter descriptions. Loose by design —
// the full JSON Schema spec is recursive (objects nest properties, arrays
// nest item schemas), and pinning the exact shape here would force every
// tool definition to widen its own type. The model-facing schema validator
// is what actually enforces correctness.
export type ToolParamSchema = {
  type: string;
  description?: string;
  enum?: string[];
  items?: ToolParamSchema;
  properties?: Record<string, ToolParamSchema>;
  required?: string[];
  minItems?: number;
};

export interface ToolFunction {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParamSchema>;
    required?: string[];
    /** Any other JSON-Schema keys pass through to the wire untouched —
     *  MCP servers legitimately send `$defs`, `additionalProperties`, etc. */
    [key: string]: unknown;
  };
}

export interface Tool {
  type: 'function';
  function: ToolFunction;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatResponse {
  content: string;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  /** API's `finish_reason`. Surfaced so streaming callers can branch on
   *  `'tool_calls'` (execute and continue the loop) vs `'stop'` (turn done).
   *  Phase 4.5 — only meaningful for the streaming-tool-calls path. */
  finish_reason?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

/** Resolved thinking state for a single request. */
interface ResolvedThinking {
  /** Whether the model will reason on this turn. Drives the `reasoning_content`
   *  echo and the sampling-param gates, both of which are wrong if read off
   *  static capabilities on a dual-mode model. */
  on: boolean;
  /** Selected level key; null when off or when the model grades no levels. */
  level: string | null;
  /** Params to merge into the request body. */
  params: Record<string, unknown>;
}

export interface ChatOptions {
  tools?: Tool[];
  jsonMode?: boolean;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * Per-call override of the model's thinking state. Beats the user's
   * per-model setting — sub-roles (e.g. web-search-digest) pass `'disabled'`
   * so digestion doesn't pay the reasoning-token latency tax, and that must
   * hold whatever the main model's pill says.
   *
   * The params actually sent come from the model's own `thinkingLevels` /
   * `disableThinkingParam` declarations, so this is meaningful for any model
   * that declares them — not just DeepSeek V4. A model that declares no
   * off-knob cannot be disabled; see {@link DeepSeekClient.resolveThinking}.
   */
  thinkingMode?: 'enabled' | 'disabled';
  /**
   * Phase 4.5 — fired the moment a tool call's metadata (`id` + `function.name`)
   * arrives in the stream, well before its argument deltas finish accumulating.
   * The callback gets a partially-filled ToolCall: `id` and `function.name` are
   * populated, `function.arguments` is empty (still streaming). Used by the
   * orchestrator to render the tool name immediately so users see "the model
   * committed to write_file" instead of staring at a silent gap between
   * reasoning and tool dispatch.
   */
  onToolCallStreaming?: (toolCall: ToolCall) => void;
}

export class DeepSeekClient {
  // Per-endpoint HttpClient cache so we don't rebuild on every request.
  // Populated lazily; keyed by the base URL string from the model registry.
  private httpClients: Map<string, HttpClient> = new Map();
  // Pinned DeepSeek base URL for provider-specific endpoints like /user/balance
  // that don't live under the OpenAI-compat chat-completions path. F7 will
  // gate this so non-DeepSeek models don't hit it at all.
  private readonly deepseekProviderBase = 'https://api.deepseek.com';
  private config: ConfigManager;
  private context: vscode.ExtensionContext;
  private modelOverride: string | null = null;
  // Shared estimation counter — keeps calibration state across model switches.
  private estimationCounter: EstimationTokenCounter;
  // Optional WASM counter; null if unavailable (vocab failed to load, etc.).
  private wasmCounter: TokenCounter | null;
  // Dispatches per-call based on the active model's declared tokenizer.
  private tokenCounter: TokenCounter;
  private contextBuilder: ContextBuilder;

  constructor(context: vscode.ExtensionContext, tokenCounter?: TokenCounter) {
    this.context = context;
    this.config = ConfigManager.getInstance();
    this.estimationCounter = new EstimationTokenCounter();
    // Treat any "exact" counter passed in as the WASM one; estimation-only
    // callers pass undefined and we'll never use a WASM path.
    this.wasmCounter = tokenCounter && tokenCounter.isExact ? tokenCounter : null;
    this.tokenCounter = new DynamicTokenCounter(
      this.estimationCounter,
      () => ({
        exact: this.wasmCounter,
        wantsExact: !!getCapabilities(this.getModel()).tokenizer,
      })
    );
    this.contextBuilder = new ContextBuilder(this.tokenCounter);
  }

  /**
   * Request timeout in ms. Clamped to a sane floor because a too-small value
   * makes every request fail in a way that looks like a network problem —
   * reasoning models routinely need tens of seconds before the first byte.
   */
  private readRequestTimeoutMs(): number {
    const raw = this.config.get<number>('requestTimeoutMs');
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_REQUEST_TIMEOUT_MS;
    return Math.max(5000, Math.floor(raw));
  }

  /** Get (or lazily create) the HttpClient for a given base URL. */
  private getHttpClientFor(baseURL: string): HttpClient {
    let client = this.httpClients.get(baseURL);
    if (!client) {
      client = new HttpClient({
        baseURL,
        // Resolved per request, not pinned here — clients are cached per
        // endpoint, so a fixed value would freeze whatever the setting was
        // when this endpoint was first used.
        timeout: () => this.readRequestTimeoutMs(),
        headers: { 'Content-Type': 'application/json' }
      });
      this.httpClients.set(baseURL, client);
    }
    return client;
  }

  /** Get the HttpClient for the currently active model's endpoint. */
  private getHttpClient(): HttpClient {
    const caps = getCapabilities(this.getModel());
    return this.getHttpClientFor(caps.apiEndpoint);
  }

  async isApiKeyConfigured(): Promise<boolean> {
    // Per-model secret takes precedence — if the user set one via the
    // settings popup, it satisfies "configured" regardless of globals.
    const perModelKey = await this.context.secrets.get(`moby.customModelKey.${this.getModel()}`);
    if (perModelKey) return true;

    const caps = getCapabilities(this.getModel());
    if (caps.apiKey) return true;

    const key = await this.context.secrets.get('moby.apiKey');
    return !!key || !!process.env.DEEPSEEK_API_KEY;
  }

  private async getApiKey(): Promise<string> {
    // Precedence (highest to lowest):
    //   1. Per-model secret set via `moby.setCustomModelApiKey` — the preferred
    //      path for custom models (hosted providers with real keys).
    //   2. Registry `apiKey` (declared in `moby.customModels` JSON) — used
    //      mainly by local runners that accept any placeholder string.
    //   3. Global `moby.apiKey` secret — the legacy DeepSeek path.
    //   4. `DEEPSEEK_API_KEY` env var — CI / containers / testing.
    const perModelKey = await this.context.secrets.get(`moby.customModelKey.${this.getModel()}`);
    if (perModelKey) return perModelKey;

    const caps = getCapabilities(this.getModel());
    if (caps.apiKey) return caps.apiKey;

    const apiKey = await this.context.secrets.get('moby.apiKey');
    if (apiKey) return apiKey;

    const envKey = process.env.DEEPSEEK_API_KEY;
    if (envKey) return envKey;

    throw new Error('API key is not configured for this model. For custom models use "Moby: Set Custom Model API Key" (or the Set key button in the settings popup). For DeepSeek use "DeepSeek Moby: Set API Key".');
  }

  /** Whether a per-model secret exists for a given model id. Used by the settings UI. */
  async hasPerModelKey(modelId: string): Promise<boolean> {
    const key = await this.context.secrets.get(`moby.customModelKey.${modelId}`);
    return !!key;
  }

  getModel(): string {
    // Use override if set (for immediate model changes before config propagates)
    return this.modelOverride ?? this.config.get<string>('model') ?? DEFAULT_MODEL_ID;
  }

  setModel(model: string): void {
    // Set override for immediate effect, VS Code config may have propagation delay
    this.modelOverride = model;
  }

  isReasonerModel(): boolean {
    return isReasonerModelFromRegistry(this.getModel());
  }

  /** Upper bound for max_tokens the active model will accept. Uses
   *  `maxOutputTokensCap` (the API cap) when declared, falling back to
   *  `maxOutputTokens` (the practical default) for V3 / older models
   *  where the two coincided. */
  getModelMaxTokens(): number {
    const caps = getCapabilities(this.getModel());
    return caps.maxOutputTokensCap ?? caps.maxOutputTokens;
  }

  /** Read the per-model maxTokens from VS Code config. Falls back to the
   *  practical default (`maxOutputTokens`), NOT the API cap — the cap is
   *  only relevant as the upper clamp bound. */
  private getConfigMaxTokens(): number {
    const caps = getCapabilities(this.getModel());
    return this.config.get<number>(caps.maxTokensConfigKey) ?? caps.maxOutputTokens;
  }

  /**
   * Clamp max_tokens to the model's valid range [1, modelMax].
   * `modelMax` comes from `getModelMaxTokens()` which uses the cap, so a
   * user who dragged the slider up to the model's true API cap (e.g.
   * 384K on V4) isn't silently clamped back to the practical default.
   */
  private clampMaxTokens(maxTokens: number): number {
    const modelMax = this.getModelMaxTokens();
    const clamped = Math.max(1, Math.min(maxTokens, modelMax));
    if (clamped !== maxTokens) {
      logger.info(`max_tokens clamped: ${maxTokens} → ${clamped} (model limit: ${modelMax})`);
    }
    return clamped;
  }

  /**
   * Serialize in-memory {@link Message} records into the OpenAI-compatible
   * wire shape. Responsible for one subtle V4-era rule:
   *
   *   When the active model has `reasoningEcho: 'required'` (V4-thinking
   *   family), every assistant message MUST carry the `reasoning_content`
   *   field — even if its value is the empty string. Omitting the field
   *   produces a 400:
   *     "The `reasoning_content` in the thinking mode must be passed
   *      back to the API."
   *   We saw this on a long tool loop where one mid-loop response had no
   *   reasoning_content at all (model emitted 0 chars); the next request
   *   omitted the field on that history entry and the API rejected.
   *
   *   For every other model (V3 chat/reasoner, custom OpenAI-compat models)
   *   we drop `reasoning_content` on the way out — it's DeepSeek-proprietary
   *   and a forward-compat safety against other providers rejecting unknown
   *   fields.
   *
   * Returns an array because the caller `unshift`s the system prompt on it.
   */
  private serializeMessagesForRequest(
    messages: Message[],
    modelId: string,
    thinkingOn: boolean
  ): Array<Record<string, unknown>> {
    const caps = getCapabilities(modelId);
    // Gated on the resolved mode as well as the capability: `reasoningEcho` is
    // a property of thinking mode, and on a dual-mode model the same id serves
    // both. Stamping the field on a non-thinking request claims a mode we're
    // not in.
    const echo = caps.reasoningEcho === 'required' && thinkingOn;
    return messages.map(m => {
      const wire: Record<string, unknown> = {
        role: m.role,
        content: m.content,
        ...(m.tool_call_id && { tool_call_id: m.tool_call_id }),
        ...(m.tool_calls && { tool_calls: m.tool_calls })
      };
      if (echo && m.role === 'assistant') {
        // Field must be present on every assistant message; empty string
        // is the documented placeholder when the model returned no
        // reasoning for this turn.
        wire.reasoning_content = m.reasoning_content ?? '';
      }
      return wire;
    });
  }

  /**
   * Resolve the thinking state for one request. Called BEFORE message
   * serialization and before the temperature gate, because both of those
   * depend on the answer — that ordering is the whole point of the helper.
   *
   * Precedence: a caller's forced `'disabled'` (every subagent role) beats
   * the user's per-model setting, so routed sub-calls stay cheap regardless
   * of what the main model's pill says.
   *
   * We never invent params. A model that declares no way to turn itself off
   * cannot be turned off — the intent is honoured as closely as the model
   * allows (its cheapest declared level) instead of guessing at a knob,
   * because a wrong guess is a 400 rather than a slow answer.
   */
  private resolveThinking(modelId: string, thinkingModeOverride?: 'enabled' | 'disabled'): ResolvedThinking {
    const caps = getCapabilities(modelId);
    const modelOptions = this.config.get<Record<string, ModelThinkingOptions>>('modelOptions') ?? {};
    const selection = resolveThinkingSelection(modelId, modelOptions[modelId], thinkingModeOverride);

    if (selection.unknownRequest) {
      logger.warn(
        `[Thinking] ${modelId} → unknown level "${selection.unknownRequest}"; falling back to "${selection.level}"`
      );
    }

    if (!selection.on) {
      return { on: false, level: null, params: { ...caps.disableThinkingParam } };
    }

    if ((thinkingModeOverride === 'disabled' || modelOptions[modelId]?.thinking === 'off') && !selection.canDisable) {
      // Observable on purpose: a subagent role paying a reasoning tax it asked
      // to skip should be answerable from a log export, not by reading a wire
      // capture.
      logger.info(
        `[Thinking] ${modelId} → cannot be disabled; ` +
        (selection.level ? `using cheapest declared level "${selection.level}"` : 'reasoning runs unchanged')
      );
    }

    if (!selection.level) return { on: true, level: null, params: {} };
    return { on: true, level: selection.level, params: { ...caps.thinkingLevels?.[selection.level] } };
  }

  /**
   * Merge the resolved thinking params into the request body and apply the
   * model's wire id. No-op for a model that declares neither.
   */
  private applyThinkingMode(
    requestBody: Record<string, unknown>,
    modelId: string,
    thinking: ResolvedThinking
  ): void {
    const caps = getCapabilities(modelId);

    if (caps.wireModelId) requestBody.model = caps.wireModelId;
    Object.assign(requestBody, thinking.params);

    // Gated on the RESOLVED mode, not the model: a non-thinking turn on a
    // dual-mode model keeps its sampling params. Unconditional deletes here
    // would silently undo the temperature the gate above correctly added.
    if (thinking.on && caps.noSamplingParamsWhenThinking) {
      delete requestBody.temperature;
      delete requestBody.top_p;
      delete requestBody.presence_penalty;
      delete requestBody.frequency_penalty;
    }

    if (Object.keys(thinking.params).length > 0) {
      logger.info(
        `[Thinking] ${modelId} → model=${requestBody.model}, ` +
        `${thinking.on ? `level=${thinking.level ?? 'default'}` : 'disabled'}, ` +
        `params=${JSON.stringify(thinking.params)}`
      );
    }
  }

  // Standard chat completion
  async chat(messages: Message[], systemPrompt?: string, options?: ChatOptions): Promise<ChatResponse> {
    let callSpan: string | null = null;
    try {
      const apiKey = await this.getApiKey();
      const model = this.getModel();
      const temperature = options?.temperature ?? this.config.get<number>('temperature') ?? 0.7;
      const rawMaxTokens = options?.maxTokens ?? this.getConfigMaxTokens();
      const maxTokens = this.clampMaxTokens(rawMaxTokens);

      // Resolved first: the serializer and the temperature gate below both
      // depend on whether this particular request reasons.
      const thinking = this.resolveThinking(model, options?.thinkingMode);
      const requestMessages = this.serializeMessagesForRequest(messages, model, thinking.on);

      if (systemPrompt) {
        requestMessages.unshift({ role: 'system', content: systemPrompt });
      }

      // The max-output field name is provider-declared: OpenAI's reasoning
      // models reject `max_tokens` and require `max_completion_tokens`.
      const requestBody: any = {
        model,
        messages: requestMessages,
        [getCapabilities(model).maxTokensParam ?? 'max_tokens']: maxTokens,
        stream: false
      };

      const caps = getCapabilities(model);
      // A fixed value beats the boolean: some providers accept exactly one
      // temperature (Kimi: "only 1 is allowed") — a per-model pin keeps the
      // global moby.temperature usable for every other model.
      if (caps.temperatureFixedValue !== undefined) {
        requestBody.temperature = caps.temperatureFixedValue;
        // Observable on purpose: "did the pin actually engage" must be
        // answerable from a log export (M40.3), not by guessing at the wire.
        if (caps.temperatureFixedValue !== temperature) {
          logger.info(`[Temperature] Pinned to ${caps.temperatureFixedValue} for ${model} (global setting is ${temperature})`);
        }
      } else if (caps.supportsTemperature && !(thinking.on && caps.noSamplingParamsWhenThinking)) {
        // The second clause is per-request, not per-model: V4 rejects
        // temperature only while thinking. With thinking off it takes it.
        requestBody.temperature = temperature;
      }

      // Add JSON mode if requested
      if (options?.jsonMode) {
        requestBody.response_format = { type: 'json_object' };
      }

      if (options?.tools && options.tools.length > 0 && caps.toolCalling === 'native') {
        requestBody.tools = options.tools;
      }

      // Provider fields Moby doesn't model. Merged BEFORE the thinking params
      // so a live control can't be deadened by static config; structural keys
      // are rejected at validation, so nothing here can clobber the request
      // shape. See ADR 0017.
      if (caps.extraParams) Object.assign(requestBody, caps.extraParams);

      // Merge the resolved thinking params + wire model id. No-op for a model
      // that declares neither.
      this.applyThinkingMode(requestBody, model, thinking);

      // Per-call span. Mirrors streamChat — gives runToolLoop's non-streaming
      // probe its own trace event instead of being invisible inside the outer
      // turn span.
      const callCorrelationId = logger.getCurrentApiCorrelationId();
      const iteration = logger.getCurrentIteration();
      callSpan = tracer.startSpan('api.request', 'call', {
        correlationId: callCorrelationId,
        executionMode: 'async',
        data: { model, iteration, messageCount: requestMessages.length, hasTools: !!requestBody.tools }
      });
      // performance.now() is monotonic and immune to system-clock adjustments
      // (WSL2 sleep/resume can briefly jump Date.now() forward and back, which
      // produced negative durations in earlier logs). Date.now() stays the
      // source of wall-clock log timestamps elsewhere.
      const callStartTime = performance.now();

      const response = await this.getHttpClient().post<{
        choices: Array<{
          message: { content?: string; reasoning_content?: string; tool_calls?: ToolCall[] };
          finish_reason?: string;
        }>;
        usage?: ChatResponse['usage'];
      }>('/chat/completions', requestBody, {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        },
        // ADR 0008 follow-up: without this, Stop could not cancel a
        // non-streaming probe — the abort only reached streamChat, and an
        // aborted runToolLoop probe stayed parked until the timeout.
        signal: options?.signal
      });

      const choice = response.data.choices[0];
      const message = choice.message;
      const content = message.content || '';
      const reasoning_content = message.reasoning_content;
      const tool_calls = message.tool_calls;
      const usage = response.data.usage;
      const finishReason = choice.finish_reason;

      // Cross-validate our token count against the API's
      // Note: systemPrompt is already unshifted into requestMessages above
      this.crossValidateTokens(requestMessages, usage, requestBody.tools);

      const callDuration = Math.round(performance.now() - callStartTime);
      logger.info(
        `[ApiCall] model=${model} iter=${iteration || 1} mode=non-stream ` +
        `finish=${finishReason ?? 'unknown'} ` +
        `prompt=${usage?.prompt_tokens?.toLocaleString() ?? '?'} ` +
        `completion=${usage?.completion_tokens?.toLocaleString() ?? '?'} ` +
        `tool_calls=${tool_calls?.length ?? 0} ` +
        `reasoning=${reasoning_content ? reasoning_content.length + ' chars' : '0'} ` +
        `duration=${callDuration}ms`
      );
      tracer.endSpan(callSpan, {
        status: 'completed',
        data: {
          model,
          iteration,
          finishReason,
          promptTokens: usage?.prompt_tokens,
          completionTokens: usage?.completion_tokens,
          toolCalls: tool_calls?.length ?? 0,
          reasoningChars: reasoning_content?.length ?? 0,
          durationMs: callDuration
        }
      });

      return { content, reasoning_content, tool_calls, usage };
    } catch (error: unknown) {
      const httpError = error as HttpError;
      if (callSpan) {
        tracer.endSpan(callSpan, { status: 'failed', error: httpError.message });
      }
      const errorData = httpError.response?.data as { error?: { message?: string } } | undefined;
      logger.apiError('DeepSeek API error', errorData?.error?.message || httpError.message);
      throw this.handleError(httpError);
    }
  }

  // Streaming chat completion with reasoning support
  async streamChat(
    messages: Message[],
    onToken: (token: string) => void,
    systemPrompt?: string,
    onReasoning?: (token: string) => void,
    options?: ChatOptions
  ): Promise<ChatResponse> {
    // Declared outside the try so the outer catch can close it on failure.
    let iterSpan: string | null = null;
    try {
      const apiKey = await this.getApiKey();
      const model = this.getModel();
      const temperature = options?.temperature ?? this.config.get<number>('temperature') ?? 0.7;
      const rawMaxTokens = options?.maxTokens ?? this.getConfigMaxTokens();
      const maxTokens = this.clampMaxTokens(rawMaxTokens);

      // Resolved first — see the note in `chat()`.
      const thinking = this.resolveThinking(model, options?.thinkingMode);
      const requestMessages = this.serializeMessagesForRequest(messages, model, thinking.on);

      if (systemPrompt) {
        requestMessages.unshift({ role: 'system', content: systemPrompt });
      }

      // The max-output field name is provider-declared: OpenAI's reasoning
      // models reject `max_tokens` and require `max_completion_tokens`.
      const requestBody: any = {
        model,
        messages: requestMessages,
        [getCapabilities(model).maxTokensParam ?? 'max_tokens']: maxTokens,
        stream: true
      };

      const caps = getCapabilities(model);
      // A fixed value beats the boolean: some providers accept exactly one
      // temperature (Kimi: "only 1 is allowed") — a per-model pin keeps the
      // global moby.temperature usable for every other model.
      if (caps.temperatureFixedValue !== undefined) {
        requestBody.temperature = caps.temperatureFixedValue;
        // Observable on purpose: "did the pin actually engage" must be
        // answerable from a log export (M40.3), not by guessing at the wire.
        if (caps.temperatureFixedValue !== temperature) {
          logger.info(`[Temperature] Pinned to ${caps.temperatureFixedValue} for ${model} (global setting is ${temperature})`);
        }
      } else if (caps.supportsTemperature && !(thinking.on && caps.noSamplingParamsWhenThinking)) {
        // The second clause is per-request, not per-model: V4 rejects
        // temperature only while thinking. With thinking off it takes it.
        requestBody.temperature = temperature;
      }

      // Add JSON mode if requested
      if (options?.jsonMode) {
        requestBody.response_format = { type: 'json_object' };
      }

      // Phase 4.5 — streaming with tools. When the active model has
      // `streamingToolCalls: true`, the orchestrator passes its tools array
      // here and streams the model's tool-call deltas back. Tool definitions
      // are only included when both `tools` is non-empty AND the model
      // supports native tool calling (the orchestrator gates the latter).
      if (options?.tools && options.tools.length > 0 && caps.toolCalling === 'native') {
        requestBody.tools = options.tools;
      }

      // Provider fields Moby doesn't model. Merged BEFORE the thinking params
      // so a live control can't be deadened by static config; structural keys
      // are rejected at validation, so nothing here can clobber the request
      // shape. See ADR 0017.
      if (caps.extraParams) Object.assign(requestBody, caps.extraParams);

      // Merge the resolved thinking params + wire model id. No-op for a model
      // that declares neither.
      this.applyThinkingMode(requestBody, model, thinking);

      const response = await this.getHttpClient().post<ReadableStream<Uint8Array>>('/chat/completions', requestBody, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'text/event-stream'
        },
        responseType: 'stream',
        signal: options?.signal
      });

      const stream = createStreamReader(response.data);

      // Per-call observability: open a child span on the outer turn correlation
      // so each tool-loop iteration shows up as its own request in the trace UI
      // (the outer `api.request:chat` span only fires once per turn).
      const iterCorrelationId = logger.getCurrentApiCorrelationId();
      const iteration = logger.getCurrentIteration();
      iterSpan = tracer.startSpan('api.request', 'iteration', {
        correlationId: iterCorrelationId,
        executionMode: 'async',
        data: { model, iteration, messageCount: requestMessages.length }
      });
      // Monotonic clock — see comment in chat() above for why.
      const iterStartTime = performance.now();

      // Hoisted out of the Promise so the post-await summary log can read them.
      let finishReason: string | undefined;
      let reasoningChunks = 0;
      let contentChunks = 0;

      // Phase 4.5 — per-index tool-call accumulator. Each delta arrives with
      // `index`, optional `id`/`type`/`function.name` (typically only on the
      // first delta for a given index), and an incremental `function.arguments`
      // string that concatenates across deltas. We tolerate any arrival order
      // and only `JSON.parse` arguments at the end (mid-stream args are usually
      // invalid JSON). Multiple parallel tool calls are interleaved by index.
      const toolCallAcc = new Map<number, {
        id: string;
        type: 'function';
        name: string;
        argumentsStr: string;
      }>();

      const finalizeToolCalls = (): ToolCall[] | undefined => {
        if (toolCallAcc.size === 0) return undefined;
        // Sort by index so emitted ToolCalls match wire order.
        const ordered = [...toolCallAcc.entries()].sort((a, b) => a[0] - b[0]);
        return ordered.map(([, acc]) => ({
          id: acc.id,
          type: acc.type,
          function: { name: acc.name, arguments: acc.argumentsStr },
        }));
      };

      const result = await new Promise<ChatResponse>((resolve, reject) => {
        let fullResponse = '';
        let fullReasoning = '';
        let usage: ChatResponse['usage'];
        let resolved = false;  // Prevent double resolution

        // Inactivity timeout - resolve if no data for 30 seconds
        const INACTIVITY_TIMEOUT_MS = 30000;
        let inactivityTimer: NodeJS.Timeout | null = null;

        const clearInactivityTimer = () => {
          if (inactivityTimer) {
            clearTimeout(inactivityTimer);
            inactivityTimer = null;
          }
        };

        const resetInactivityTimer = () => {
          clearInactivityTimer();
          inactivityTimer = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            if (fullResponse || fullReasoning || toolCallAcc.size > 0) {
              // Mid-stream stall with partial data: return what we have.
              resolve({
                content: fullResponse,
                reasoning_content: fullReasoning || undefined,
                tool_calls: finalizeToolCalls(),
                finish_reason: finishReason,
                usage: usage || {
                  prompt_tokens: this.estimateTokens(JSON.stringify(requestMessages)),
                  completion_tokens: this.estimateTokens(fullResponse),
                  total_tokens: 0
                }
              });
            } else {
              // Zero bytes ever. This branch used to do NOTHING — and since
              // the timer only re-arms on data, the promise then hung until
              // the user hit Stop ("a hung stream never self-terminates",
              // release-gate bug #2). Headers arriving means the HTTP-layer
              // timeout is already cleared, so this is the only watchdog
              // left on the connection.
              const err = new Error(
                `Stream produced no data for ${INACTIVITY_TIMEOUT_MS / 1000}s — giving up`
              ) as HttpError;
              err.code = 'ECONNABORTED';
              reject(err);
            }
          }, INACTIVITY_TIMEOUT_MS);
        };

        // Start the inactivity timer
        resetInactivityTimer();

        // SSE line framing. fetch's ReadableStream hands us arbitrary byte
        // chunks: a single `data:` frame can be split across two chunks, and a
        // multibyte UTF-8 character can straddle a chunk boundary. Decode with
        // a streaming decoder (which holds an incomplete trailing code point
        // until the next chunk) and buffer any partial trailing line until its
        // terminating newline arrives. Without this, a frame split on a network
        // boundary was silently dropped: the truncated tail failed JSON.parse
        // and the head of the next chunk no longer started with `data: `.
        const decoder = new TextDecoder('utf-8');
        let sseBuffer = '';

        const processSseLine = (rawLine: string) => {
          if (resolved) return;
          const line = rawLine.trim();  // tolerate trailing \r (CRLF) / stray ws
          if (line === '' || !line.startsWith('data: ')) return;
          const data = line.slice(6);

          if (data === '[DONE]') {
            if (!resolved) {
              resolved = true;
              clearInactivityTimer();
              resolve({
                content: fullResponse,
                reasoning_content: fullReasoning || undefined,
                tool_calls: finalizeToolCalls(),
                finish_reason: finishReason,
                usage: usage || {
                  prompt_tokens: this.estimateTokens(JSON.stringify(requestMessages)),
                  completion_tokens: this.estimateTokens(fullResponse),
                  total_tokens: 0
                }
              });
            }
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices[0];
            const delta = choice?.delta;

            // Handle reasoning content (for deepseek-reasoner / V4-thinking).
            // Always accumulate; the streaming callback is optional UI plumbing
            // but the assembled result must include everything the model emitted.
            if (delta?.reasoning_content) {
              fullReasoning += delta.reasoning_content;
              reasoningChunks++;
              if (onReasoning) onReasoning(delta.reasoning_content);
            }

            // Handle regular content
            if (delta?.content) {
              fullResponse += delta.content;
              contentChunks++;
              onToken(delta.content);
            }

            // Phase 4.5 — accumulate tool-call deltas per-index. The
            // first delta for a given index typically carries
            // id/type/function.name; subsequent deltas only extend
            // function.arguments. We never `JSON.parse` here — mid-
            // stream args are usually invalid; the caller parses once
            // we hand back the assembled ToolCall[].
            if (Array.isArray(delta?.tool_calls)) {
              for (const tcDelta of delta.tool_calls as Array<{
                index?: number;
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: string };
              }>) {
                const idx = tcDelta.index ?? 0;
                let acc = toolCallAcc.get(idx);
                if (!acc) {
                  acc = { id: '', type: 'function', name: '', argumentsStr: '' };
                  toolCallAcc.set(idx, acc);
                }
                const hadIdAndName = !!(acc.id && acc.name);
                if (tcDelta.id) acc.id = tcDelta.id;
                if (tcDelta.function?.name) acc.name = tcDelta.function.name;
                if (typeof tcDelta.function?.arguments === 'string') {
                  acc.argumentsStr += tcDelta.function.arguments;
                }
                // Fire onToolCallStreaming once per index, the first
                // moment we have BOTH id and name. Args may still be
                // empty — the orchestrator uses this to render the
                // tool name immediately rather than waiting for the
                // full stream to resolve.
                if (!hadIdAndName && acc.id && acc.name && options?.onToolCallStreaming) {
                  options.onToolCallStreaming({
                    id: acc.id,
                    type: acc.type,
                    function: { name: acc.name, arguments: '' },
                  });
                }
              }
            }

            if (choice?.finish_reason) {
              finishReason = choice.finish_reason;
            }

            // Capture usage if present
            if (parsed.usage) {
              usage = parsed.usage;
            }
          } catch (e) {
            // Ignore parsing errors for partial data
          }
        };

        stream.on('data', (chunk: Buffer) => {
          // Reset inactivity timer on each data chunk
          resetInactivityTimer();

          // Append decoded text (the decoder retains a partial trailing code
          // point) and process only complete, newline-terminated lines; the
          // trailing partial line stays in sseBuffer for the next chunk.
          sseBuffer += decoder.decode(chunk, { stream: true });

          while (true) {
            const newlineIdx = sseBuffer.indexOf('\n');
            if (newlineIdx === -1) break;
            const line = sseBuffer.slice(0, newlineIdx);
            sseBuffer = sseBuffer.slice(newlineIdx + 1);
            processSseLine(line);
            if (resolved) {
              sseBuffer = '';
              break;
            }
          }
        });

        stream.on('error', (error: Error) => {
          if (!resolved) {
            resolved = true;
            clearInactivityTimer();
            reject(this.handleError(error as HttpError));
          }
        });

        stream.on('end', () => {
          // Flush any bytes the streaming decoder is still holding, then
          // process a final line that arrived without a trailing newline.
          sseBuffer += decoder.decode();
          if (sseBuffer.length > 0) {
            processSseLine(sseBuffer);
            sseBuffer = '';
          }

          // Always resolve if we have data, even if [DONE] wasn't received
          if (!resolved) {
            resolved = true;
            clearInactivityTimer();
            if (fullResponse || fullReasoning || toolCallAcc.size > 0) {
              resolve({
                content: fullResponse,
                reasoning_content: fullReasoning || undefined,
                tool_calls: finalizeToolCalls(),
                finish_reason: finishReason,
                usage: usage || {
                  prompt_tokens: this.estimateTokens(JSON.stringify(requestMessages)),
                  completion_tokens: this.estimateTokens(fullResponse),
                  total_tokens: 0
                }
              });
            } else {
              reject(new Error('No response received from DeepSeek'));
            }
          }
        });
      });

      // Cross-validate our token count against the API's
      // Note: systemPrompt is already unshifted into requestMessages above.
      // Pass the tools too — the probe path always did, and validating one
      // side with tools and the other without made the same turn's two calls
      // disagree by the entire tools-JSON share (the "probe over-counts"
      // half of the token-over-count bug).
      this.crossValidateTokens(requestMessages, result.usage, requestBody.tools);

      const iterDuration = Math.round(performance.now() - iterStartTime);
      // Single per-iteration summary line. Lets us answer "why did the loop end?"
      // and "did the model emit any reasoning?" without scraping multiple log lines.
      logger.info(
        `[ApiCall] model=${model} iter=${iteration || 1} ` +
        `finish=${finishReason ?? 'unknown'} ` +
        `prompt=${result.usage?.prompt_tokens?.toLocaleString() ?? '?'} ` +
        `completion=${result.usage?.completion_tokens?.toLocaleString() ?? '?'} ` +
        `reasoning_chunks=${reasoningChunks} ` +
        `content_chunks=${contentChunks} ` +
        `duration=${iterDuration}ms`
      );
      tracer.endSpan(iterSpan, {
        status: 'completed',
        data: {
          model,
          iteration,
          finishReason,
          promptTokens: result.usage?.prompt_tokens,
          completionTokens: result.usage?.completion_tokens,
          reasoningChunks,
          contentChunks,
          durationMs: iterDuration
        }
      });

      return result;
    } catch (error: unknown) {
      const httpError = error as HttpError;
      if (iterSpan) {
        tracer.endSpan(iterSpan, { status: 'failed', error: httpError.message });
      }
      logger.apiError('DeepSeek stream error', httpError.message);
      throw this.handleError(httpError);
    }
  }

  // Chat with tools/function calling
  async chatWithTools(
    messages: Message[],
    tools: Tool[],
    systemPrompt?: string
  ): Promise<ChatResponse> {
    if (getCapabilities(this.getModel()).toolCalling !== 'native') {
      throw new Error(`Function calling is not supported with model "${this.getModel()}"`);
    }
    return this.chat(messages, systemPrompt, { tools });
  }

  // Chat with JSON output mode
  async chatWithJsonOutput(
    messages: Message[],
    systemPrompt?: string
  ): Promise<ChatResponse> {
    // Ensure system prompt mentions JSON
    const jsonSystemPrompt = systemPrompt
      ? `${systemPrompt}\n\nRespond with valid JSON only.`
      : 'Respond with valid JSON only.';

    return this.chat(messages, jsonSystemPrompt, { jsonMode: true });
  }

  // Token estimation for chat history (uses calibrating estimation counter)
  estimateTokens(text: string): number {
    return this.tokenCounter.count(text);
  }

  /**
   * Build an optimized context window that fits within the model's token budget.
   * Drops oldest messages first, optionally injects a snapshot summary.
   */
  async buildContext(
    messages: Message[],
    systemPrompt?: string,
    snapshotSummary?: SnapshotSummary
  ): Promise<ContextResult> {
    return this.contextBuilder.build(messages, systemPrompt, this.getModel(), snapshotSummary);
  }

  /**
   * Calibrate the token estimator using actual API usage data.
   * Always feeds the shared EstimationTokenCounter, even when the active
   * model is using the WASM path — so if the user switches to a custom
   * model later, its estimation counter already has calibration samples.
   */
  calibrateTokenEstimation(inputCharCount: number, actualPromptTokens: number): void {
    this.estimationCounter.calibrate(inputCharCount, actualPromptTokens);
    logger.info(
      `[TokenCounter] Calibrated: ratio=${this.estimationCounter.ratio.toFixed(4)}, ` +
      `samples=${this.estimationCounter.sampleCount}`
    );
  }

  /**
   * Cross-validate our token count against the API's usage.prompt_tokens.
   * Counts everything in the request: content, tool calls, tool definitions.
   * Logs the delta as a percentage. Also calibrates the estimation counter.
   */
  private crossValidateTokens(
    // Accepts any record shape so serializer additions (e.g. `reasoning_content`
    // for V4-thinking) flow through without updating this signature. Token
    // counting only reads role/content/tool_calls/tool_call_id.
    requestMessages: Array<Record<string, unknown>>,
    usage: ChatResponse['usage'],
    tools?: Tool[]
  ): void {
    if (!usage?.prompt_tokens) { return; }

    // systemPrompt is already in requestMessages (unshifted before the API call),
    // so we pass undefined — countRequestTokens will count it via the messages loop.
    const ourCount = countRequestTokens(this.tokenCounter, requestMessages, undefined, tools);
    const apiCount = usage.prompt_tokens;
    const delta = apiCount - ourCount;
    const deltaPercent = apiCount > 0 ? ((delta / apiCount) * 100).toFixed(1) : '0.0';

    logger.info(
      `[TokenCV] ours=${ourCount.toLocaleString()} api=${apiCount.toLocaleString()} ` +
      `delta=${delta > 0 ? '+' : ''}${delta} (${deltaPercent}%) ` +
      `[${this.tokenCounter.isExact ? 'WASM' : 'estimation'}]`
    );

    // An image-bearing request is not a usable calibration sample. The two
    // halves of this function disagree about images by three orders of
    // magnitude: `countRequestTokens` scores an image as the literal
    // '[image]' (~2 tokens) while the char count below would stringify the
    // whole base64 data URI (~21,600 chars). Neither models what the API
    // actually bills, so feeding either to the calibrator wrecks a counter
    // that was otherwise tracking within a few percent — observed 2026-08-03,
    // one image route drove ratio to 0.0499 (~10x off) and every later
    // estimate from that client with it.
    if (hasImageContent(requestMessages)) {
      logger.debug('[TokenCounter] Skipped calibration — image content is not modellable by a text tokenizer');
      return;
    }

    // Calibrate the shared estimation counter with actual data. Do this for
    // every response — even when the active model uses WASM — so that any
    // future model switch to an estimation-only model starts with real
    // samples instead of the default ratio.
    //
    // The numerator must cover what `prompt_tokens` bills — messages AND
    // tool-call metadata AND the tools JSON — or every tool-bearing sample
    // inflates the ratio by the uncounted share. See countRequestChars.
    const charCount = countRequestChars(requestMessages, tools);
    this.calibrateTokenEstimation(charCount, apiCount);
  }

  /**
   * Name the provider the ACTIVE model actually talks to. A user on Kimi,
   * Ollama or Groq who gets "check your DeepSeek API key" is being pointed
   * at a key that has nothing to do with the failure. Sub-clients are
   * isolated per modelId, so `this.getModel()` is the right context here.
   */
  private describeActiveProvider(): { isDeepSeek: boolean; label: string; keyHint: string } {
    const modelId = this.getModel();
    const endpoint = getCapabilities(modelId).apiEndpoint;
    if (endpoint === this.deepseekProviderBase) {
      return {
        isDeepSeek: true,
        label: 'DeepSeek',
        keyHint: 'Please check your DeepSeek API key in settings.'
      };
    }
    let host = endpoint;
    try {
      host = new URL(endpoint).host;
    } catch { /* keep the raw endpoint string */ }
    return {
      isDeepSeek: false,
      label: `${host} (model "${modelId}")`,
      keyHint: `Set the key for "${modelId}" via "Moby: Set Custom Model API Key".`
    };
  }

  private handleError(error: HttpError): Error {
    const provider = this.describeActiveProvider();
    if (error.response) {
      switch (error.response.status) {
        case 401:
          return new Error(`Invalid API key for ${provider.label}. ${provider.keyHint}`);
        case 429:
          return new Error('Rate limit exceeded. Please wait before making more requests.');
        case 500:
          return new Error(`${provider.label} API server error. Please try again later.`);
        default: {
          const errorData = error.response.data as { error?: { message?: string } } | undefined;
          return new Error(`API error: ${errorData?.error?.message || error.message}`);
        }
      }
    }
    if (error.code === 'ENOTFOUND') {
      return new Error(`Cannot connect to ${provider.label}. Check your internet connection.`);
    }
    return new Error(error.message || 'Unknown error occurred');
  }

  // Fetch account balance from DeepSeek API.
  // DeepSeek-specific endpoint — non-DeepSeek models (local Ollama, OpenAI,
  // Anthropic, etc.) don't expose /user/balance. We bail early for those;
  // F7 will properly gate the stats modal by capability.
  async getBalance(): Promise<{ available: boolean; balance: string; currency: string } | null> {
    // Only DeepSeek's own API exposes /user/balance. Custom models pointed
    // at other endpoints (Ollama, OpenAI, etc.) should not trigger this call.
    if (getCapabilities(this.getModel()).apiEndpoint !== this.deepseekProviderBase) {
      return null;
    }
    try {
      const apiKey = await this.getApiKey();
      const response = await this.getHttpClientFor(this.deepseekProviderBase).get<{
        is_available: boolean;
        balance_infos: Array<{ currency: string; total_balance: string }>;
      }>('/user/balance', {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });

      const data = response.data;
      if (data.balance_infos && data.balance_infos.length > 0) {
        // Prefer USD, fall back to first available
        const usdBalance = data.balance_infos.find((b) => b.currency === 'USD');
        const balanceInfo = usdBalance || data.balance_infos[0];
        return {
          available: data.is_available,
          balance: balanceInfo.total_balance,
          currency: balanceInfo.currency
        };
      }
      return null;
    } catch (error: unknown) {
      const httpError = error as HttpError;
      logger.apiError('Failed to fetch balance', httpError.message);
      return null;
    }
  }

  dispose() {
    // Cleanup if needed
  }
}
