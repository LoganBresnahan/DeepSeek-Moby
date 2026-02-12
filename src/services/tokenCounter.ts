/**
 * Token counting abstraction layer.
 *
 * Implementations:
 * - EstimationTokenCounter: Character-based estimation with API calibration (Phase 1)
 * - TokenService: Exact counts via WASM tokenizer (Phase 3, future)
 *
 * The ContextBuilder depends on this interface, not on concrete implementations.
 */

/** Per-message overhead: role tokens, formatting, separators */
const MESSAGE_OVERHEAD_TOKENS = 4;

/** System prompt wrapper overhead (BOS token, role tokens, etc.) */
const SYSTEM_OVERHEAD_TOKENS = 8;

export interface TokenCounter {
  /** Count tokens in a raw text string */
  count(text: string): number;

  /** Count tokens for a message including role/formatting overhead */
  countMessage(role: string, content: string): number;

  /** Whether this counter provides exact counts (WASM) vs estimates */
  readonly isExact: boolean;
}

/**
 * Estimation-based token counter. Zero dependencies.
 *
 * Uses a default ratio of ~0.3 tokens per character (DeepSeek's byte-level BPE
 * averages higher than OpenAI's ~0.25). Self-calibrates against real API usage
 * data over time, converging to +/-5% accuracy within 5-10 messages.
 */
/** Per tool call entry: id, type, function {} wrapper formatting */
const TOOL_CALL_OVERHEAD = 8;

/**
 * Count tokens for an entire API request — messages, tool metadata, tool definitions.
 * Counts everything the API counts, not just message content text.
 */
export function countRequestTokens(
  counter: TokenCounter,
  requestMessages: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string }>;
    tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
    tool_call_id?: string;
  }>,
  systemPrompt?: string,
  tools?: Array<{ type: string; function: { name: string; description: string; parameters: unknown } }>
): number {
  let total = 0;

  // System prompt
  if (systemPrompt) {
    total += counter.countMessage('system', systemPrompt);
  }

  // Messages — content + all structured fields
  for (const msg of requestMessages) {
    // Content text
    const text = typeof msg.content === 'string'
      ? msg.content
      : msg.content.map(c => c.type === 'text' && c.text ? c.text : '[image]').join('');
    total += counter.countMessage(msg.role, text);

    // Tool call metadata (assistant messages that invoke tools)
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += counter.count(tc.function.name);
        total += counter.count(tc.function.arguments);
        total += TOOL_CALL_OVERHEAD;
      }
    }

    // Tool result linkage
    if (msg.tool_call_id) {
      total += counter.count(msg.tool_call_id);
    }
  }

  // Tool definitions in request body
  if (tools && tools.length > 0) {
    total += counter.count(JSON.stringify(tools));
  }

  return total;
}

export class EstimationTokenCounter implements TokenCounter {
  private calibrationRatio = 0.3;
  private samples: number[] = [];
  private static readonly MAX_SAMPLES = 20;

  readonly isExact = false;

  count(text: string): number {
    return Math.ceil(text.length * this.calibrationRatio);
  }

  countMessage(role: string, content: string): number {
    const overhead = role === 'system' ? SYSTEM_OVERHEAD_TOKENS : MESSAGE_OVERHEAD_TOKENS;
    return this.count(content) + overhead;
  }

  /**
   * Calibrate the ratio using actual token counts from the API.
   *
   * Called after every API response that includes usage data.
   * Uses a rolling average of the last 20 samples.
   *
   * @param charCount - Total character count of the input text
   * @param actualTokens - Actual token count from API usage.prompt_tokens
   */
  calibrate(charCount: number, actualTokens: number): void {
    if (charCount === 0 || actualTokens === 0) { return; }
    const ratio = actualTokens / charCount;
    this.samples.push(ratio);
    if (this.samples.length > EstimationTokenCounter.MAX_SAMPLES) {
      this.samples.shift();
    }
    this.calibrationRatio = this.samples.reduce((a, b) => a + b) / this.samples.length;
  }

  /** Current calibration ratio (for diagnostics/logging) */
  get ratio(): number {
    return this.calibrationRatio;
  }

  /** Number of calibration samples collected */
  get sampleCount(): number {
    return this.samples.length;
  }
}
