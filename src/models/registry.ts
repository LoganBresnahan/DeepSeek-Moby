/**
 * Model capability registry.
 *
 * Single source of truth for per-model facts (API behavior, transport support,
 * limits). Replaces scattered `isReasonerModel()` / hardcoded model-string
 * comparisons across the codebase.
 *
 * Phase 1 scope: declare capabilities, provide lookup. Behavior-preserving.
 * Phase 2+ will add capability layer + transport adapters that consume this.
 * See [docs/plans/model-capability-registry.md](../../docs/plans/model-capability-registry.md).
 */

export type ToolCalling = 'native' | 'none';
export type ReasoningTokens = 'inline' | 'none';
export type EditProtocol = 'native-tool' | 'search-replace';
export type ShellProtocol = 'xml-shell' | 'native-tool' | 'none';
export type RequestFormat = 'openai' | 'anthropic';
export type ReasoningEffort = 'high' | 'max';
export type ReasoningEcho = 'required' | 'optional' | 'none';
export type PromptStyle = 'minimal' | 'standard';

/** Request-body fields Moby constructs itself. `extraParams` may not set these
 *  — overriding `messages` or `model` corrupts the request, and overriding the
 *  token fields bypasses clamping and the context reserve that is computed
 *  from them. */
export const RESERVED_REQUEST_KEYS = [
  'model', 'messages', 'stream', 'tools', 'max_tokens', 'max_completion_tokens',
];

export interface ModelCapabilities {
  // How the model expresses intent.
  toolCalling: ToolCalling;
  reasoningTokens: ReasoningTokens;
  editProtocol: EditProtocol[];
  shellProtocol: ShellProtocol;

  // API quirks.
  supportsTemperature: boolean;

  // Limits.
  /** Default value sent as `max_tokens` if the user hasn't overridden
   *  via the maxTokens slider. Also the fallback for the slider's upper
   *  bound when `maxOutputTokensCap` is absent (V3 behavior). */
  maxOutputTokens: number;
  /** Upper bound for the per-model maxTokens slider. Defaults to
   *  `maxOutputTokens` when omitted — matches V3 where the default and
   *  cap coincided. V4 sets this to 384000 so the slider reaches the
   *  real API cap even though the practical default is much lower.
   *  See [docs/plans/deepseek-v4-integration.md](../../docs/plans/deepseek-v4-integration.md). */
  maxOutputTokensCap?: number;

  /** Total context window (input + output) in tokens. Drives ContextBuilder's
   *  conversation-history budget and the tool-loop's "approaching budget" guard.
   *  V3 family is 128_000; V4 (Pro and Flash) is 1_048_576 (1M). Optional —
   *  ContextBuilder falls back to 128_000 when a model (e.g. a custom entry)
   *  doesn't declare one. */
  contextWindow?: number;

  // VS Code config key for the user-adjustable per-model max tokens override.
  // Historical naming — preserved to avoid breaking existing user settings.
  maxTokensConfigKey: string;

  // Infrastructure.
  streaming: boolean;
  apiEndpoint: string;
  /**
   * Per-model API key. When present, bypasses the global `moby.apiKey`
   * secret. Used mainly by custom models that target local runners
   * ("ollama" placeholder for Ollama, etc.) or hosted providers with
   * their own credentials.
   */
  apiKey?: string;
  /**
   * Tokenizer identifier for exact token counting via WASM. When present,
   * the matching vocab is loaded from `assets/vocabs/<tokenizer>.json.br`.
   * When absent, token counting falls back to `EstimationTokenCounter`
   * which auto-calibrates from `usage.prompt_tokens` after each API call.
   *
   * The fallback keeps custom/local models functional without bundling
   * every possible tokenizer vocab. For users who need exact counts on
   * a custom model, they can point the field at a vocab we ship that
   * closely matches their model's tokenizer.
   *
   * V4 shares V3's BPE base (same 128K vocab, same merges, same
   * pre-tokenizer/decoder/normalizer) but adds ~465 new special tokens
   * (`<think>`, `</think>`, `｜DSML｜`, file/repo markers, multimodal
   * placeholders). V3 vocab counts V4 user-text correctly but
   * under-tokenizes V4-emitted special tokens — pick `'deepseek-v4'`
   * for V4 entries to get exact counts on those.
   */
  tokenizer?: 'deepseek-v3' | 'deepseek-v4';
  requestFormat: RequestFormat;

  // ── V4-era axes (see docs/plans/deepseek-v4-integration.md) ─────────

  /** Selectable thinking levels, in display order. Keys are the labels the
   *  model selector renders; values are request params merged into the body
   *  when that level is active. Absent = the model has no level control.
   *
   *  Declared rather than enumerated because providers disagree on both the
   *  values AND the shape: DeepSeek V4 wants a `thinking` wrapper alongside
   *  `reasoning_effort`, Kimi K3 wants `reasoning_effort` bare at the top
   *  level (its K2.x predecessor used `thinking`, K3 dropped it). A closed
   *  union fused to one vendor's wire format can express neither.
   *  See [docs/plans/thinking-modes-and-levels.md]. */
  thinkingLevels?: Record<string, Record<string, unknown>>;

  /** Which {@link thinkingLevels} key applies when the user hasn't chosen. */
  defaultThinkingLevel?: string;

  /** Thinking mode rejects `temperature`/`top_p`/`presence_penalty`/
   *  `frequency_penalty` — true for the DeepSeek V4 family. Gated on the
   *  RESOLVED mode, not on the model, so a non-thinking turn on a dual-mode
   *  model keeps its sampling params. */
  noSamplingParamsWhenThinking?: boolean;

  /** Name of the max-output-tokens request field. OpenAI's reasoning models
   *  require `max_completion_tokens` and REJECT `max_tokens`; Kimi K3
   *  documents the same field. Defaults to `'max_tokens'`.
   *
   *  Named rather than aliased because the two are **not** interchangeable:
   *  `max_completion_tokens` is spent on the reasoning trace as well as the
   *  visible answer, so the same number means less usable output on a
   *  reasoning model. See [ADR 0017](../../docs/architecture/decisions/0017-declared-provider-differences.md). */
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';

  /** Request params merged into EVERY request for this model — the escape
   *  hatch for provider fields Moby doesn't model. A named capability is only
   *  warranted when Moby's own code must read the value (it renders a control,
   *  computes the number, or branches on it); everything else belongs here and
   *  Moby never needs to know it exists.
   *
   *  Merged BEFORE the thinking params, so a live control always beats static
   *  config — otherwise an `extraParams.reasoning_effort` would silently
   *  deaden the effort pill, which is the dead-control bug this design exists
   *  to prevent. Structural keys are rejected at validation, not silently
   *  dropped: see {@link RESERVED_REQUEST_KEYS}. */
  extraParams?: Record<string, unknown>;

  /** Wire model id, when it differs from the registry key. The V4 entries are
   *  keyed `…-thinking` for historical reasons but the API expects the bare
   *  `deepseek-v4-flash` / `-pro`. Explicit beats the old implicit suffix
   *  strip, which silently coupled renaming an entry to changing the wire. */
  wireModelId?: string;

  /** Pin the request temperature to exactly this value, overriding both the
   *  global `moby.temperature` and `supportsTemperature`. For providers that
   *  accept only one temperature (Kimi rejects anything but 1) — a boolean
   *  can't express "must be exactly N". */
  temperatureFixedValue?: number;

  /** The provider's own request params for turning reasoning OFF, merged
   *  into the body when the resolved mode is off (the user's pill, or a
   *  subagent role forcing `thinkingMode: 'disabled'`). There is no portable
   *  OpenAI-compatible knob — DeepSeek V4 takes `{"thinking": {"type":
   *  "disabled"}}`, Qwen-style backends `{"enable_thinking": false}` — so the
   *  entry declares it and we never guess (a wrong guess is a 400).
   *
   *  **Absence is meaningful**: it declares the model CANNOT be turned off,
   *  which is a real capability (Kimi K3 always thinks). The selector renders
   *  the Off control only when this is present, so a control can never exist
   *  without params behind it. */
  disableThinkingParam?: Record<string, unknown>;

  /** Whether `reasoning_content` must be echoed back in subsequent
   *  requests when serializing assistant turns that contained tool_calls.
   *  V4-thinking returns 400 if not. Default `'none'` means strip from
   *  history before re-sending (current chat-model behavior). */
  reasoningEcho?: ReasoningEcho;

  /** System-prompt flavor. `'minimal'` is calibrated for thinking-style
   *  models that infer intent from phrasing; it strips the explicit
   *  reference-vs-edit decision tree and most numbered file-modification
   *  rules, leaving only load-bearing guardrails. `'standard'` (the
   *  default) is today's prompt — kept for V3 / non-thinking / custom
   *  models that benefit from explicit instructions.
   *
   *  See [docs/plans/deepseek-v4-integration.md] Phase 3.5 for the
   *  content split and empirical comparison protocol. */
  promptStyle?: PromptStyle;

  /** Phase 4.5 — when `true`, the orchestrator routes tool-calling turns
   *  through a single streaming pipeline that accumulates `delta.tool_calls`
   *  chunks alongside content + reasoning_content. Replaces the
   *  `runToolLoop` (non-streaming) + `streamAndIterate` (streaming) split
   *  for this model. When `false`, the existing two-phase path runs.
   *
   *  Default: `false` everywhere. Canary flip on V4-flash-thinking lands
   *  in a separate small PR after the infrastructure validates end-to-end.
   *  R1 (`shellProtocol: 'xml-shell'`) never sets this — its path doesn't
   *  use `runToolLoop` to begin with.
   *
   *  See [docs/plans/deepseek-v4-integration.md] Phase 4.5. */
  streamingToolCalls?: boolean;

  /** Whether the LSP-backed navigation tools (`outline`, `get_symbol_source`)
   *  are exposed to this model. Defaults to false. Native-tool models can
   *  use them; R1 (`xml-shell` transport) cannot. Custom models opt in per
   *  registry entry. See [docs/plans/lsp-integration.md]. */
  lspTools?: boolean;

  /** Subagent roles this model can serve when configured via `moby.subagents`.
   *  Loose `string[]` so the registry stays decoupled from the subagents
   *  feature module — the canonical role names live in
   *  [src/subagents/types.ts]. Empty / absent = main-only model (default).
   *  See [docs/plans/subagents.md]. */
  subagentRoles?: string[];

  /** Model accepts image content parts (OpenAI `image_url` blocks). Gates
   *  which models may serve the `image-describe` role — DeepSeek's first-party
   *  API is text-only, so this is opt-in per custom-model entry.
   *  See [docs/plans/image-describe-subagent.md]. */
  acceptsImages?: boolean;
}

export const MODEL_REGISTRY: Record<string, ModelCapabilities> = {
  'deepseek-chat': {
    toolCalling: 'native',
    reasoningTokens: 'none',
    editProtocol: ['native-tool', 'search-replace'],
    shellProtocol: 'native-tool',
    supportsTemperature: true,
    maxOutputTokens: 8192,
    contextWindow: 128_000,
    maxTokensConfigKey: 'maxTokensChatModel',
    streaming: true,
    apiEndpoint: 'https://api.deepseek.com',
    tokenizer: 'deepseek-v3',
    requestFormat: 'openai',
    // V3 chat interleaves delta.content and delta.tool_calls in the same SSE
    // stream. The streaming pipeline can render text segments and tool dropdowns
    // out of order when chunk delivery isn't deterministic. V3 retires
    // 2026-07-24 — keeping it on the legacy runToolLoop + streamAndIterate
    // split avoids the ordering issue without backporting a fix to a sunsetting
    // model. V4 family has no such issue (separate reasoning channel).
    streamingToolCalls: false,
    lspTools: true,
  },
  'deepseek-reasoner': {
    toolCalling: 'none',
    reasoningTokens: 'inline',
    editProtocol: ['search-replace'],
    shellProtocol: 'xml-shell',
    supportsTemperature: false,
    maxOutputTokens: 65536,
    contextWindow: 128_000,
    maxTokensConfigKey: 'maxTokensReasonerModel',
    streaming: true,
    apiEndpoint: 'https://api.deepseek.com',
    tokenizer: 'deepseek-v3',
    requestFormat: 'openai',
  },

  // ── V4 preview (2026-04-24) ─────────────────────────────────────────
  // ONE entry per upstream model. These are dual-mode models, so thinking
  // on/off and the effort level are per-request state (`thinkingLevels` +
  // `disableThinkingParam`), not separate model ids.
  //
  // An earlier plan called for two entries each, non-thinking and thinking.
  // Abandoned 2026-08-12: it doubles the dropdown per dual-mode model, forces
  // a model switch to change one request param, and can't express a model
  // that grades effort without having two modes at all (Kimi K3). It also
  // carried a trap — a "non-thinking" entry that simply omits the thinking
  // param still thinks, because the API defaults to enabled.
  //
  // The `-thinking` id suffix survives for settings compatibility only; the
  // wire id comes from `wireModelId`.
  // See [docs/plans/thinking-modes-and-levels.md].

  'deepseek-v4-flash-thinking': {
    toolCalling: 'native',
    reasoningTokens: 'inline',
    editProtocol: ['native-tool', 'search-replace'],
    shellProtocol: 'native-tool',
    // V4 accepts temperature in NON-thinking mode; only thinking mode rejects
    // it. That's `noSamplingParamsWhenThinking`, resolved per request, below.
    supportsTemperature: true,
    maxOutputTokens: 65536,
    maxOutputTokensCap: 384000,
    contextWindow: 1_048_576,        // 1M (DeepSeek-V4-Flash)
    maxTokensConfigKey: 'maxTokensV4FlashThinking',
    streaming: true,
    apiEndpoint: 'https://api.deepseek.com',
    tokenizer: 'deepseek-v4',
    requestFormat: 'openai',
    // `low` is documented for DeepSeek's Anthropic-format and Responses-API
    // surfaces but UNCONFIRMED on the OpenAI-format `reasoning_effort` field
    // we send — left undeclared until one real request settles it, so the
    // selector can't offer a level that 400s.
    thinkingLevels: {
      high: { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
      max: { thinking: { type: 'enabled' }, reasoning_effort: 'max' },
    },
    defaultThinkingLevel: 'high',
    disableThinkingParam: { thinking: { type: 'disabled' } },
    noSamplingParamsWhenThinking: true,
    wireModelId: 'deepseek-v4-flash',
    reasoningEcho: 'required',
    promptStyle: 'minimal',
    // Phase 4.5 — single streaming pipeline replaces the chat() probe +
    // streamChat() summary split. Surfaces reasoning_content live during
    // tool decisions instead of dropping it on the floor.
    streamingToolCalls: true,
    lspTools: true,
    // Subagent eligibility — V4-flash is the cheap, fast workhorse for
    // routed digestion. Phase 1 ships `web-search-digest`; more roles
    // appear in subsequent phases.
    subagentRoles: ['web-search-digest'],
  },
  'deepseek-v4-pro-thinking': {
    toolCalling: 'native',
    reasoningTokens: 'inline',
    editProtocol: ['native-tool', 'search-replace'],
    shellProtocol: 'native-tool',
    supportsTemperature: true,         // see the flash entry
    maxOutputTokens: 65536,
    maxOutputTokensCap: 384000,
    contextWindow: 1_048_576,        // 1M (DeepSeek-V4-Pro)
    maxTokensConfigKey: 'maxTokensV4ProThinking',
    streaming: true,
    apiEndpoint: 'https://api.deepseek.com',
    tokenizer: 'deepseek-v4',
    requestFormat: 'openai',
    // See the flash entry for why `low` is undeclared.
    thinkingLevels: {
      high: { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
      max: { thinking: { type: 'enabled' }, reasoning_effort: 'max' },
    },
    defaultThinkingLevel: 'max',       // pro defaults to max — paying for quality
    disableThinkingParam: { thinking: { type: 'disabled' } },
    noSamplingParamsWhenThinking: true,
    wireModelId: 'deepseek-v4-pro',
    reasoningEcho: 'required',
    promptStyle: 'minimal',
    // Phase 4.5 — same as flash-thinking. Pro pays a higher rate per
    // token, so visible reasoning during tool decisions is even more
    // valuable here (the user can see what they're paying for).
    streamingToolCalls: true,
    lspTools: true,
    // Subagent eligibility — Pro is the high-quality option for digestion.
    // Router forces thinkingMode='disabled' on sub calls so the extra
    // reasoning cost only applies to main-loop use.
    subagentRoles: ['web-search-digest'],
  },
};

export const DEFAULT_MODEL_ID = 'deepseek-v4-pro-thinking';

// Fallback for unknown model IDs (e.g., stale config, future custom entries
// not yet registered). V4-pro-thinking is the most capable default — native
// tool calling + inline reasoning + shell access + 1M-token context.
const FALLBACK_CAPABILITIES: ModelCapabilities = MODEL_REGISTRY[DEFAULT_MODEL_ID];

/**
 * Runtime-registered custom models from the `moby.customModels` setting.
 * Populated by `loadCustomModels()` at activation and on config change.
 * Merged with built-in registrations at lookup time.
 */
const CUSTOM_MODELS = new Map<string, ModelCapabilities>();
const CUSTOM_MODEL_NAMES = new Map<string, string>();

export function getCapabilities(modelId: string): ModelCapabilities {
  return CUSTOM_MODELS.get(modelId) ?? MODEL_REGISTRY[modelId] ?? FALLBACK_CAPABILITIES;
}

export function getRegisteredModelIds(): string[] {
  // Built-in IDs first so they sort at the top of selectors; custom IDs after.
  const builtin = Object.keys(MODEL_REGISTRY);
  const custom = [...CUSTOM_MODELS.keys()].filter(id => !MODEL_REGISTRY[id]);
  return [...builtin, ...custom];
}

export interface RegisteredModelInfo {
  id: string;
  name: string;
  maxTokens: number;
  isCustom: boolean;
  /** The model's default output size. `maxTokens` above is the slider's upper
   *  bound (the API ceiling); defaulting a fresh selection to THAT is what
   *  starved the context on a model whose ceiling equals its window. */
  defaultMaxTokens: number;
  /** Level names this model declares, in display order. The selector renders
   *  one pill per entry — so it can never offer a level the model doesn't
   *  have, nor hide one it does. Absent = no level control. */
  thinkingLevels?: string[];
  /** Whether the model declares an off-knob. Gates the Off control: a model
   *  that always reasons (Kimi K3) must not render one. */
  canDisableThinking?: boolean;
  /** Effective thinking state, decorated by `sendModelList()` from the user's
   *  `moby.modelOptions` via the shared {@link resolveThinkingSelection}. */
  thinking?: 'on' | 'off';
  thinkingLevel?: string;
  /** Whether manual edit mode is meaningful for this model. Native-tool
   *  models bypass the text channel for edits (they call `edit_file` /
   *  `write_file`), so manual would render an Apply button on code blocks
   *  the model never emits. The toolbar uses this to hide Manual from the
   *  edit-mode cycle. Mirrors `supportsManualMode(id)`. */
  supportsManualMode: boolean;
  /** Model accepts image content. Drives the image-describe subagent picker,
   *  which lists only vision-capable models. */
  acceptsImages?: boolean;
  /** Roles this model is declared willing to serve. The picker filters on this
   *  as well as `acceptsImages`, because the router requires both — offering a
   *  model that fails one gate surfaces as a placeholder in chat, far from the
   *  setting that caused it. */
  subagentRoles?: string[];
}

/**
 * Return display metadata for every registered model (built-in + custom).
 * Used by the model selector UI. The `maxTokens` value is the slider's
 * upper bound — `maxOutputTokensCap` when set (V4), else `maxOutputTokens`
 * (V3 behavior where default and cap coincide).
 */
/** Per-model user settings under `moby.modelOptions.<id>`, thinking subset. */
export interface ModelThinkingOptions {
  thinking?: 'on' | 'off';
  thinkingLevel?: string;
  /** Deprecated — superseded by `thinkingLevel`, still read so settings
   *  written by 0.8.0 keep working. */
  reasoningEffort?: string;
}

export interface ThinkingSelection {
  /** Levels this model declares, in display order. Empty = no level control. */
  levels: string[];
  /** Whether the model declares any way to stop reasoning. */
  canDisable: boolean;
  /** Effective state for this request. */
  on: boolean;
  /** Effective level; null when off, or when the model grades no levels. */
  level: string | null;
  /** Set when the caller asked for a level this model doesn't declare — the
   *  selection falls back, and the caller may want to say so out loud. */
  unknownRequest?: string;
}

/**
 * Resolve which thinking state applies, from capabilities + user settings +
 * an optional per-call override.
 *
 * Shared deliberately: the request path and the model picker must agree, or
 * the UI shows a level the wire isn't sending. One precedence rule, one place.
 */
export function resolveThinkingSelection(
  modelId: string,
  options?: ModelThinkingOptions,
  override?: 'enabled' | 'disabled'
): ThinkingSelection {
  const caps = getCapabilities(modelId);
  const levels = Object.keys(caps.thinkingLevels ?? {});
  const canDisable = caps.disableThinkingParam !== undefined;

  // A caller's forced 'disabled' (every subagent role) beats the user's pill,
  // so routed sub-calls stay cheap whatever the main model is set to.
  if (override === 'disabled' || options?.thinking === 'off') {
    if (canDisable) return { levels, canDisable, on: false, level: null };
    // The model can't be turned off (Kimi K3 always thinks). Honour the intent
    // as closely as it allows — cheapest declared level — rather than invent a
    // param, which is a 400 instead of merely a slow answer.
    return { levels, canDisable, on: true, level: levels[0] ?? null };
  }

  if (levels.length === 0) return { levels, canDisable, on: true, level: null };

  let level = caps.defaultThinkingLevel ?? levels[0];
  const requested = options?.thinkingLevel ?? options?.reasoningEffort;
  let unknownRequest: string | undefined;
  if (requested !== undefined) {
    if (levels.includes(requested)) level = requested;
    else unknownRequest = requested;
  }
  if (!levels.includes(level)) level = levels[0];

  return { levels, canDisable, on: true, level, ...(unknownRequest && { unknownRequest }) };
}

export function getAllRegisteredModels(): RegisteredModelInfo[] {
  const out: RegisteredModelInfo[] = [];
  for (const id of Object.keys(MODEL_REGISTRY)) {
    const caps = MODEL_REGISTRY[id];
    out.push({
      id,
      name: BUILTIN_DISPLAY_NAMES[id] ?? id,
      maxTokens: caps.maxOutputTokensCap ?? caps.maxOutputTokens,
      defaultMaxTokens: caps.maxOutputTokens,
      isCustom: false,
      supportsManualMode: caps.toolCalling !== 'native',
      ...(caps.acceptsImages !== undefined && { acceptsImages: caps.acceptsImages }),
      ...(caps.subagentRoles !== undefined && { subagentRoles: caps.subagentRoles }),
      ...(caps.thinkingLevels && { thinkingLevels: Object.keys(caps.thinkingLevels) }),
      canDisableThinking: caps.disableThinkingParam !== undefined,
    });
  }
  for (const [id, caps] of CUSTOM_MODELS.entries()) {
    if (MODEL_REGISTRY[id]) continue;
    out.push({
      id,
      name: CUSTOM_MODEL_NAMES.get(id) ?? id,
      maxTokens: caps.maxOutputTokensCap ?? caps.maxOutputTokens,
      defaultMaxTokens: caps.maxOutputTokens,
      isCustom: true,
      supportsManualMode: caps.toolCalling !== 'native',
      ...(caps.acceptsImages !== undefined && { acceptsImages: caps.acceptsImages }),
      ...(caps.subagentRoles !== undefined && { subagentRoles: caps.subagentRoles }),
      ...(caps.thinkingLevels && { thinkingLevels: Object.keys(caps.thinkingLevels) }),
      canDisableThinking: caps.disableThinkingParam !== undefined,
    });
  }
  return out;
}

const BUILTIN_DISPLAY_NAMES: Record<string, string> = {
  // V3-era models. The announced 2026-07-24 retirement date passed with the
  // API still serving both (verified 2026-08-04 — R1 answered a real e2e
  // turn), so the "retiring" label came off rather than stating a stale date.
  'deepseek-chat': 'DeepSeek Chat (V3)',
  'deepseek-reasoner': 'DeepSeek Reasoner (R1)',
  // V4 thinking models. The "-thinking" id suffix is preserved for wire-format
  // compatibility (drives `thinking: { type: 'enabled' }` + reasoning_effort).
  // Display labels drop the "(Thinking)" qualifier — V4 always reasons; the
  // distinction was misleading (non-thinking variants emitted reasoning_content
  // anyway and 400'd on iter 2 when we didn't echo it back).
  'deepseek-v4-flash-thinking': 'DeepSeek V4 Flash',
  'deepseek-v4-pro-thinking': 'DeepSeek V4 Pro',
};

/**
 * Raw shape of a `moby.customModels` entry. Matches the JSON schema in
 * package.json — validated at load time so bad entries are dropped with
 * an explanation rather than crashing the extension.
 */
export interface CustomModelEntry extends ModelCapabilities {
  id: string;
  name: string;
}

export interface LoadResult {
  loaded: number;
  errors: string[];
}

/**
 * Validate a raw config entry against the expected shape. Returns a
 * descriptive error string instead of throwing so we can collect all
 * problems for a single diagnostic message.
 */
export function validateCustomModelEntry(entry: unknown): { ok: true } | { ok: false; error: string } {
  if (!entry || typeof entry !== 'object') {
    return { ok: false, error: 'entry is not an object' };
  }
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== 'string' || !e.id) return { ok: false, error: 'missing or invalid "id"' };
  if (MODEL_REGISTRY[e.id as string]) return { ok: false, error: `"id" (${e.id}) conflicts with a built-in model` };
  if (typeof e.name !== 'string' || !e.name) return { ok: false, error: 'missing or invalid "name"' };
  if (e.toolCalling !== 'native' && e.toolCalling !== 'none') return { ok: false, error: 'toolCalling must be "native" or "none"' };
  if (e.reasoningTokens !== 'inline' && e.reasoningTokens !== 'none') return { ok: false, error: 'reasoningTokens must be "inline" or "none"' };
  if (!Array.isArray(e.editProtocol)) return { ok: false, error: 'editProtocol must be an array' };
  for (const p of e.editProtocol) {
    if (p !== 'native-tool' && p !== 'search-replace') {
      return { ok: false, error: `editProtocol entry must be "native-tool" or "search-replace", got "${p}"` };
    }
  }
  if (e.shellProtocol !== 'xml-shell' && e.shellProtocol !== 'native-tool' && e.shellProtocol !== 'none') return { ok: false, error: 'shellProtocol must be "xml-shell", "native-tool", or "none"' };
  if (typeof e.supportsTemperature !== 'boolean') return { ok: false, error: 'supportsTemperature must be boolean' };
  if (typeof e.maxOutputTokens !== 'number' || e.maxOutputTokens < 128) return { ok: false, error: 'maxOutputTokens must be a number >= 128' };
  if (typeof e.maxTokensConfigKey !== 'string' || !e.maxTokensConfigKey) return { ok: false, error: 'missing maxTokensConfigKey' };
  if (typeof e.streaming !== 'boolean') return { ok: false, error: 'streaming must be boolean' };
  if (typeof e.apiEndpoint !== 'string' || !e.apiEndpoint) return { ok: false, error: 'missing apiEndpoint' };
  if (e.apiKey !== undefined && typeof e.apiKey !== 'string') return { ok: false, error: 'apiKey must be a string if provided' };
  if (e.tokenizer !== undefined && e.tokenizer !== 'deepseek-v3' && e.tokenizer !== 'deepseek-v4') return { ok: false, error: 'tokenizer must be "deepseek-v3", "deepseek-v4", or omitted' };
  if (e.requestFormat !== 'openai') return { ok: false, error: 'requestFormat must be "openai"' };
  // V4-era axes (all optional). Validate shapes when present.
  if (e.maxOutputTokensCap !== undefined) {
    if (typeof e.maxOutputTokensCap !== 'number' || e.maxOutputTokensCap < (e.maxOutputTokens as number)) {
      return { ok: false, error: 'maxOutputTokensCap must be a number ≥ maxOutputTokens when provided' };
    }
  }
  if (e.thinkingLevels !== undefined) {
    if (typeof e.thinkingLevels !== 'object' || e.thinkingLevels === null || Array.isArray(e.thinkingLevels)) {
      return { ok: false, error: 'thinkingLevels must be an object mapping level name → request params' };
    }
    const levels = e.thinkingLevels as Record<string, unknown>;
    if (Object.keys(levels).length === 0) {
      return { ok: false, error: 'thinkingLevels must declare at least one level when provided' };
    }
    for (const [name, params] of Object.entries(levels)) {
      if (typeof params !== 'object' || params === null || Array.isArray(params)) {
        return { ok: false, error: `thinkingLevels."${name}" must be an object of request params` };
      }
    }
  }
  if (e.defaultThinkingLevel !== undefined) {
    if (typeof e.defaultThinkingLevel !== 'string') {
      return { ok: false, error: 'defaultThinkingLevel must be a string if provided' };
    }
    // A default naming a level that doesn't exist would silently fall through
    // to "no params at all" — the failure this whole design exists to prevent.
    const levels = (e.thinkingLevels ?? {}) as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(levels, e.defaultThinkingLevel)) {
      return { ok: false, error: `defaultThinkingLevel "${e.defaultThinkingLevel}" is not a key of thinkingLevels` };
    }
  }
  if (e.maxTokensParam !== undefined &&
      e.maxTokensParam !== 'max_tokens' && e.maxTokensParam !== 'max_completion_tokens') {
    return { ok: false, error: 'maxTokensParam must be "max_tokens" or "max_completion_tokens" if provided' };
  }
  if (e.extraParams !== undefined) {
    if (typeof e.extraParams !== 'object' || e.extraParams === null || Array.isArray(e.extraParams)) {
      return { ok: false, error: 'extraParams must be an object of request params' };
    }
    // Rejected loudly rather than dropped: a config typo that silently
    // replaced `messages` would corrupt every request with no error to notice.
    for (const key of Object.keys(e.extraParams as Record<string, unknown>)) {
      if (RESERVED_REQUEST_KEYS.includes(key)) {
        return {
          ok: false,
          error: `extraParams may not set "${key}" — Moby owns that field. ` +
            (key === 'max_tokens' || key === 'max_completion_tokens'
              ? 'Use the maxTokens slider, and "maxTokensParam" to choose the field name.'
              : 'Reserved: ' + RESERVED_REQUEST_KEYS.join(', ')),
        };
      }
    }
  }
  if (e.noSamplingParamsWhenThinking !== undefined && typeof e.noSamplingParamsWhenThinking !== 'boolean') {
    return { ok: false, error: 'noSamplingParamsWhenThinking must be boolean if provided' };
  }
  if (e.wireModelId !== undefined && (typeof e.wireModelId !== 'string' || !e.wireModelId)) {
    return { ok: false, error: 'wireModelId must be a non-empty string if provided' };
  }
  if (e.temperatureFixedValue !== undefined &&
      (typeof e.temperatureFixedValue !== 'number' || !Number.isFinite(e.temperatureFixedValue))) {
    return { ok: false, error: 'temperatureFixedValue must be a finite number if provided' };
  }
  if (e.disableThinkingParam !== undefined &&
      (typeof e.disableThinkingParam !== 'object' || e.disableThinkingParam === null || Array.isArray(e.disableThinkingParam))) {
    return { ok: false, error: 'disableThinkingParam must be an object of request params if provided' };
  }
  if (e.reasoningEcho !== undefined && e.reasoningEcho !== 'required' && e.reasoningEcho !== 'optional' && e.reasoningEcho !== 'none') {
    return { ok: false, error: 'reasoningEcho must be "required", "optional", or "none" if provided' };
  }
  if (e.promptStyle !== undefined && e.promptStyle !== 'minimal' && e.promptStyle !== 'standard') {
    return { ok: false, error: 'promptStyle must be "minimal" or "standard" if provided' };
  }
  if (e.streamingToolCalls !== undefined && typeof e.streamingToolCalls !== 'boolean') {
    return { ok: false, error: 'streamingToolCalls must be boolean if provided' };
  }
  if (e.lspTools !== undefined && typeof e.lspTools !== 'boolean') {
    return { ok: false, error: 'lspTools must be boolean if provided' };
  }
  if (e.acceptsImages !== undefined && typeof e.acceptsImages !== 'boolean') {
    return { ok: false, error: 'acceptsImages must be boolean if provided' };
  }
  if (e.subagentRoles !== undefined) {
    if (!Array.isArray(e.subagentRoles)) {
      return { ok: false, error: 'subagentRoles must be an array of strings if provided' };
    }
    for (const role of e.subagentRoles) {
      if (typeof role !== 'string') {
        return { ok: false, error: 'subagentRoles entries must be strings' };
      }
    }
  }
  return { ok: true };
}

/**
 * Load (or reload) custom models from the given raw entries. Entries that
 * fail validation are dropped with an error description; the rest are
 * registered. Replaces any previously loaded custom models.
 */
export function registerCustomModels(rawEntries: unknown[]): LoadResult {
  CUSTOM_MODELS.clear();
  CUSTOM_MODEL_NAMES.clear();
  const errors: string[] = [];

  for (const raw of rawEntries) {
    const v = validateCustomModelEntry(raw);
    if (!v.ok) {
      const id = (raw as { id?: unknown })?.id ?? '<unknown>';
      errors.push(`"${String(id)}": ${v.error}`);
      continue;
    }
    const entry = raw as CustomModelEntry;
    const { id, name, ...caps } = entry;
    CUSTOM_MODELS.set(id, caps as ModelCapabilities);
    CUSTOM_MODEL_NAMES.set(id, name);
  }

  return { loaded: CUSTOM_MODELS.size, errors };
}

/** Visible for tests. Clears runtime-registered custom models. */
export function __resetCustomModelsForTests(): void {
  CUSTOM_MODELS.clear();
  CUSTOM_MODEL_NAMES.clear();
}

/**
 * Visible for tests. Bypasses built-in conflict validation so a test can
 * override a built-in model's capabilities (e.g. flip `streamingToolCalls`
 * off on `deepseek-chat` to exercise the legacy `runToolLoop` path).
 */
export function __setCustomModelForTests(id: string, caps: ModelCapabilities, name?: string): void {
  CUSTOM_MODELS.set(id, caps);
  if (name) CUSTOM_MODEL_NAMES.set(id, name);
}

/**
 * Is the given model a "reasoner-style" model (inline reasoning channel,
 * no native tool calling, shell-protocol-driven agentic work)?
 *
 * Thin alias retained for Phase 1 migration. Prefer checking specific
 * capability axes (`caps.toolCalling`, `caps.shellProtocol`, etc.) in
 * new code.
 */
export function isReasonerModel(modelId: string): boolean {
  const caps = getCapabilities(modelId);
  return caps.shellProtocol === 'xml-shell' && caps.toolCalling === 'none';
}

/**
 * Whether manual edit mode is usable with the given model.
 *
 * Manual mode renders code blocks with an **Apply** button — which requires
 * the model to emit SEARCH/REPLACE blocks in its text response. Native-tool
 * models bypass the text channel for edits entirely (they call `edit_file`
 * / `write_file`), so manual would render an Apply button on code blocks
 * the model never emits.
 *
 * Rule: any model with `toolCalling: 'native'` is excluded — V3 chat, V4
 * family, native-tool custom models. Models with `toolCalling: 'none'`
 * (R1, custom shell-only models) keep manual mode.
 */
export function supportsManualMode(modelId: string): boolean {
  const caps = getCapabilities(modelId);
  return caps.toolCalling !== 'native';
}
