/* tslint:disable */
/* eslint-disable */

/**
 * DeepSeek tokenizer wrapper for WASM.
 *
 * Loads the HuggingFace tokenizer.json format and provides
 * encode/decode/count operations callable from JavaScript.
 *
 * All tokenizer data (vocab, merges) lives in WASM linear memory,
 * keeping the JS heap footprint under 2 MB.
 */
export class DeepSeekTokenizer {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Count tokens in text. This is the primary method for context management.
     *
     * Does NOT add special tokens (BOS/EOS) - those are added by the API,
     * not by us. We count the raw content tokens for budget calculation.
     */
    count_tokens(text: string): number;
    /**
     * Decode token IDs back to text.
     */
    decode(ids: Uint32Array, skip_special_tokens: boolean): string;
    /**
     * Encode text to token IDs. Returns a Uint32Array.
     *
     * Useful for advanced context management (e.g., truncating at
     * a token boundary rather than a character boundary).
     */
    encode(text: string, add_special_tokens: boolean): Uint32Array;
    /**
     * Create a tokenizer from the tokenizer.json content.
     *
     * The JSON string is copied from JS into WASM linear memory,
     * parsed by serde_json, and the resulting data structures
     * (vocab HashMap, merge rules Vec) remain in WASM memory.
     *
     * The JS string can be GC'd after this constructor returns.
     */
    constructor(json: string);
    /**
     * Get the vocabulary size (128,000 for DeepSeek V3).
     */
    vocab_size(): number;
}
