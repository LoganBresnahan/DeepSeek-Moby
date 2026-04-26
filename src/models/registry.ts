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
   */
  tokenizer?: 'deepseek-v3';
  requestFormat: RequestFormat;

  // ── V4-era axes (see docs/plans/deepseek-v4-integration.md) ─────────

  /** Inject `{"thinking": {"type": "enabled"}}` into the request body.
   *  Only V4 thinking variants set this. `deepseekClient` also strips any
   *  Moby-side `-thinking` suffix from the model id before sending, so the
   *  upstream DeepSeek API sees the bare `deepseek-v4-flash` / `-pro`. */
  sendThinkingParam?: boolean;

  /** Default reasoning effort for thinking-capable models. User override
   *  lives in `moby.modelOptions.<id>.reasoningEffort`. */
  reasoningEffort?: ReasoningEffort;

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
}

export const MODEL_REGISTRY: Record<string, ModelCapabilities> = {
  'deepseek-chat': {
    toolCalling: 'native',
    reasoningTokens: 'none',
    editProtocol: ['native-tool', 'search-replace'],
    shellProtocol: 'native-tool',
    supportsTemperature: true,
    maxOutputTokens: 8192,
    maxTokensConfigKey: 'maxTokensChatModel',
    streaming: true,
    apiEndpoint: 'https://api.deepseek.com',
    tokenizer: 'deepseek-v3',
    requestFormat: 'openai',
  },
  'deepseek-reasoner': {
    toolCalling: 'none',
    reasoningTokens: 'inline',
    editProtocol: ['search-replace'],
    shellProtocol: 'xml-shell',
    supportsTemperature: false,
    maxOutputTokens: 65536,
    maxTokensConfigKey: 'maxTokensReasonerModel',
    streaming: true,
    apiEndpoint: 'https://api.deepseek.com',
    tokenizer: 'deepseek-v3',
    requestFormat: 'openai',
  },

  // ── V4 preview (2026-04-24) ─────────────────────────────────────────
  // Each upstream model is represented by TWO registry entries — one for
  // non-thinking, one for thinking. The `-thinking` suffix is a Moby-side
  // identifier stripped before the API call; upstream sees the bare
  // `deepseek-v4-flash` / `deepseek-v4-pro`. Keeps the user's cost/quality
  // decision at model-pick time (same pattern as chat vs reasoner today)
  // and avoids dynamic capability resolution mid-session.

  'deepseek-v4-flash': {
    toolCalling: 'native',
    reasoningTokens: 'none',
    editProtocol: ['native-tool', 'search-replace'],
    shellProtocol: 'native-tool',
    supportsTemperature: true,
    maxOutputTokens: 32768,           // practical default
    maxOutputTokensCap: 384000,       // real API cap
    maxTokensConfigKey: 'maxTokensV4Flash',
    streaming: true,
    apiEndpoint: 'https://api.deepseek.com',
    tokenizer: 'deepseek-v3',          // V4 uses same vocab + new specials; see plan
    requestFormat: 'openai',
  },
  'deepseek-v4-flash-thinking': {
    toolCalling: 'native',
    reasoningTokens: 'inline',
    editProtocol: ['native-tool', 'search-replace'],
    shellProtocol: 'native-tool',
    supportsTemperature: false,        // thinking mode rejects temperature/top_p
    maxOutputTokens: 65536,
    maxOutputTokensCap: 384000,
    maxTokensConfigKey: 'maxTokensV4FlashThinking',
    streaming: true,
    apiEndpoint: 'https://api.deepseek.com',
    tokenizer: 'deepseek-v3',
    requestFormat: 'openai',
    sendThinkingParam: true,
    reasoningEffort: 'high',
    reasoningEcho: 'required',
    promptStyle: 'minimal',
  },
  'deepseek-v4-pro': {
    toolCalling: 'native',
    reasoningTokens: 'none',
    editProtocol: ['native-tool', 'search-replace'],
    shellProtocol: 'native-tool',
    supportsTemperature: true,
    maxOutputTokens: 32768,
    maxOutputTokensCap: 384000,
    maxTokensConfigKey: 'maxTokensV4Pro',
    streaming: true,
    apiEndpoint: 'https://api.deepseek.com',
    tokenizer: 'deepseek-v3',
    requestFormat: 'openai',
  },
  'deepseek-v4-pro-thinking': {
    toolCalling: 'native',
    reasoningTokens: 'inline',
    editProtocol: ['native-tool', 'search-replace'],
    shellProtocol: 'native-tool',
    supportsTemperature: false,
    maxOutputTokens: 65536,
    maxOutputTokensCap: 384000,
    maxTokensConfigKey: 'maxTokensV4ProThinking',
    streaming: true,
    apiEndpoint: 'https://api.deepseek.com',
    tokenizer: 'deepseek-v3',
    requestFormat: 'openai',
    sendThinkingParam: true,
    reasoningEffort: 'max',            // pro defaults to max — paying for quality
    reasoningEcho: 'required',
    promptStyle: 'minimal',
  },
};

export const DEFAULT_MODEL_ID = 'deepseek-chat';

// Fallback for unknown model IDs (e.g., stale config, future custom entries
// not yet registered). Chat-shape is the safer default — models generally
// support tool calling more often than inline reasoning channels.
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
  /** Registry default for reasoning_effort (only present on thinking-capable
   *  models). The model selector uses presence of this field to decide
   *  whether to render the High/Max pill sub-control. The current effective
   *  value (override > registry default) is sent as `reasoningEffort` below
   *  by `sendModelList()`. */
  reasoningEffortDefault?: ReasoningEffort;
}

/**
 * Return display metadata for every registered model (built-in + custom).
 * Used by the model selector UI. The `maxTokens` value is the slider's
 * upper bound — `maxOutputTokensCap` when set (V4), else `maxOutputTokens`
 * (V3 behavior where default and cap coincide).
 */
export function getAllRegisteredModels(): RegisteredModelInfo[] {
  const out: RegisteredModelInfo[] = [];
  for (const id of Object.keys(MODEL_REGISTRY)) {
    const caps = MODEL_REGISTRY[id];
    out.push({
      id,
      name: BUILTIN_DISPLAY_NAMES[id] ?? id,
      maxTokens: caps.maxOutputTokensCap ?? caps.maxOutputTokens,
      isCustom: false,
      ...(caps.reasoningEffort !== undefined && { reasoningEffortDefault: caps.reasoningEffort }),
    });
  }
  for (const [id, caps] of CUSTOM_MODELS.entries()) {
    if (MODEL_REGISTRY[id]) continue;
    out.push({
      id,
      name: CUSTOM_MODEL_NAMES.get(id) ?? id,
      maxTokens: caps.maxOutputTokensCap ?? caps.maxOutputTokens,
      isCustom: true,
      ...(caps.reasoningEffort !== undefined && { reasoningEffortDefault: caps.reasoningEffort }),
    });
  }
  return out;
}

const BUILTIN_DISPLAY_NAMES: Record<string, string> = {
  // V3 models — retiring 2026-07-24, hint in the label so users start migrating.
  'deepseek-chat': 'DeepSeek Chat (V3 — retiring Jul 2026)',
  'deepseek-reasoner': 'DeepSeek Reasoner (R1 — retiring Jul 2026)',
  // V4 preview models.
  'deepseek-v4-flash': 'DeepSeek V4 Flash',
  'deepseek-v4-flash-thinking': 'DeepSeek V4 Flash (Thinking)',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  'deepseek-v4-pro-thinking': 'DeepSeek V4 Pro (Thinking)',
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
  if (e.tokenizer !== undefined && e.tokenizer !== 'deepseek-v3') return { ok: false, error: 'tokenizer must be "deepseek-v3" or omitted' };
  if (e.requestFormat !== 'openai') return { ok: false, error: 'requestFormat must be "openai"' };
  // V4-era axes (all optional). Validate shapes when present.
  if (e.maxOutputTokensCap !== undefined) {
    if (typeof e.maxOutputTokensCap !== 'number' || e.maxOutputTokensCap < (e.maxOutputTokens as number)) {
      return { ok: false, error: 'maxOutputTokensCap must be a number ≥ maxOutputTokens when provided' };
    }
  }
  if (e.sendThinkingParam !== undefined && typeof e.sendThinkingParam !== 'boolean') {
    return { ok: false, error: 'sendThinkingParam must be boolean if provided' };
  }
  if (e.reasoningEffort !== undefined && e.reasoningEffort !== 'high' && e.reasoningEffort !== 'max') {
    return { ok: false, error: 'reasoningEffort must be "high" or "max" if provided' };
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
 * the model to emit SEARCH/REPLACE blocks in its text response. Tool-calling
 * models bypass the text channel entirely, so manual mode would look like a
 * dead button.
 *
 * Rule: `editProtocol[0]` (the primary/preferred channel) decides. If it's
 * `search-replace`, manual works. If it's `native-tool`, tools will fire
 * first and manual is blocked. Empty array means the model can't edit at
 * all — manual is a reasonable default because the UX is just prose + code
 * references with no apply semantics.
 */
export function supportsManualMode(modelId: string): boolean {
  const caps = getCapabilities(modelId);
  if (caps.editProtocol.length === 0) return true;
  return caps.editProtocol[0] === 'search-replace';
}
