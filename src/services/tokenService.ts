/**
 * TokenService - Exact token counting via WASM tokenizer.
 *
 * Supports multiple vocabularies keyed by model family. Each DeepSeek model
 * generation (V3, V4, etc.) may use a different tokenizer vocabulary.
 * The WASM binary (BPE logic) is shared — only the vocab data differs.
 *
 * Vocab files are stored as Brotli-compressed JSON in assets/vocabs/:
 *   deepseek-v3.json.br  — V3 (deepseek-chat) and R1 (deepseek-reasoner)
 *   deepseek-v4.json.br  — V4 (when released)
 *
 * Memory: < 2 MB JS heap per tokenizer, ~20-25 MB WASM linear memory each.
 * Init: ~300 ms per vocab (one-time, lazy on first use).
 * Per-count: ~0.02 ms.
 */

import * as zlib from 'zlib';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import type { TokenCounter } from './tokenCounter';
import type { DeepSeekTokenizer } from 'deepseek-moby-wasm';
import { getCapabilities } from '../models/registry';

/** Per-message overhead: role tokens, formatting, separators */
const MESSAGE_OVERHEAD_TOKENS = 4;

/** System prompt wrapper overhead (BOS token, role tokens, etc.) */
const SYSTEM_OVERHEAD_TOKENS = 8;

/** Default vocab used for TokenService bootstrap (before any model is selected) */
const DEFAULT_VOCAB = 'deepseek-v3';

export class TokenService implements TokenCounter {
  private static instance: TokenService;

  /** Loaded tokenizers keyed by vocab name (e.g., 'deepseek-v3') */
  private tokenizers = new Map<string, DeepSeekTokenizer>();
  /** In-flight init promises to avoid double-loading */
  private initPromises = new Map<string, Promise<void>>();
  /** The currently active vocab name (set by selectModel) */
  private activeVocab: string = DEFAULT_VOCAB;
  private extensionPath: string;
  /** Cached WASM module (loaded once, shared by all tokenizer instances) */
  private wasmModule: typeof import('deepseek-moby-wasm') | null = null;

  readonly isExact = true;

  private constructor(extensionPath: string) {
    this.extensionPath = extensionPath;
  }

  static getInstance(extensionPath?: string): TokenService {
    if (!TokenService.instance) {
      if (!extensionPath) {
        throw new Error('TokenService.getInstance() requires extensionPath on first call');
      }
      TokenService.instance = new TokenService(extensionPath);
    }
    return TokenService.instance;
  }

  /**
   * Initialize the tokenizer for the default vocab.
   * Call during extension activation.
   */
  async initialize(): Promise<void> {
    await this.loadVocab(this.activeVocab);
  }

  /**
   * Select the active tokenizer for a model.
   *
   * Pulls the vocab name from the model's registry capability. Models that
   * don't declare a `tokenizer` (custom local models like Qwen, Llama, etc.)
   * skip the WASM vocab load — `DynamicTokenCounter` routes them to the
   * estimation counter automatically.
   *
   * Returns true if an exact WASM vocab is active for this model, false
   * if the caller should fall back to estimation.
   */
  async selectModel(modelId: string): Promise<boolean> {
    const vocabName = getCapabilities(modelId).tokenizer;
    if (!vocabName) {
      // No exact vocab for this model — estimation will handle counting.
      logger.debug(`[TokenService] No tokenizer declared for "${modelId}" — using estimation counter.`);
      return false;
    }
    if (vocabName === this.activeVocab && this.tokenizers.has(vocabName)) {
      return true; // Already active and loaded
    }
    this.activeVocab = vocabName;
    await this.loadVocab(vocabName);
    return true;
  }

  /**
   * Load a vocab file and create a tokenizer instance.
   * No-op if already loaded.
   */
  private async loadVocab(vocabName: string): Promise<void> {
    if (this.tokenizers.has(vocabName)) return;

    // Prevent double-loading
    if (this.initPromises.has(vocabName)) {
      return this.initPromises.get(vocabName)!;
    }

    const promise = this._doLoadVocab(vocabName);
    this.initPromises.set(vocabName, promise);

    try {
      await promise;
    } finally {
      this.initPromises.delete(vocabName);
    }
  }

  private async _doLoadVocab(vocabName: string): Promise<void> {
    const start = performance.now();

    try {
      // Load WASM module once, reuse for all tokenizer instances
      if (!this.wasmModule) {
        this.wasmModule = await import('deepseek-moby-wasm');
      }
      const { DeepSeekTokenizer: TokenizerClass } = this.wasmModule;

      // Find the vocab file
      const fileName = `${vocabName}.json.br`;
      const distPath = path.join(this.extensionPath, 'dist', 'assets', 'vocabs', fileName);
      const devPath = path.join(this.extensionPath, 'packages', 'moby-wasm', 'assets', 'vocabs', fileName);

      // Backward compat: check old single-file location too
      const legacyDistPath = path.join(this.extensionPath, 'dist', 'assets', 'tokenizer.json.br');
      const legacyDevPath = path.join(this.extensionPath, 'packages', 'moby-wasm', 'assets', 'tokenizer.json.br');

      let compressedPath: string;
      if (fs.existsSync(distPath)) {
        compressedPath = distPath;
      } else if (fs.existsSync(devPath)) {
        compressedPath = devPath;
      } else if (vocabName === DEFAULT_VOCAB && fs.existsSync(legacyDistPath)) {
        compressedPath = legacyDistPath;
      } else if (vocabName === DEFAULT_VOCAB && fs.existsSync(legacyDevPath)) {
        compressedPath = legacyDevPath;
      } else {
        throw new Error(`Vocab file not found: ${fileName}`);
      }

      const compressed = fs.readFileSync(compressedPath);
      const jsonBuffer = zlib.brotliDecompressSync(compressed);
      const json = jsonBuffer.toString('utf-8');

      const tokenizer = new TokenizerClass(json);
      this.tokenizers.set(vocabName, tokenizer);

      const elapsed = performance.now() - start;
      logger.info(
        `[TokenService] Initialized in ${elapsed.toFixed(0)}ms ` +
        `(vocab: ${tokenizer.vocab_size()} tokens)`
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[TokenService] Failed to load vocab "${vocabName}": ${msg}`);
      throw new Error(`WASM tokenizer failed to load vocab "${vocabName}": ${msg}`);
    }
  }

  /** Get the active tokenizer. Throws if not initialized. */
  private getTokenizer(): DeepSeekTokenizer {
    const tokenizer = this.tokenizers.get(this.activeVocab);
    if (!tokenizer) {
      throw new Error(`TokenService not initialized for vocab "${this.activeVocab}". Call initialize() first.`);
    }
    return tokenizer;
  }

  /** Whether at least one tokenizer is loaded and ready. */
  get isReady(): boolean {
    return this.tokenizers.has(this.activeVocab);
  }

  /**
   * Count tokens in a text string. Synchronous — requires initialize() first.
   */
  count(text: string): number {
    return this.getTokenizer().count_tokens(text);
  }

  /**
   * Count tokens for a chat message, including role/formatting overhead.
   */
  countMessage(role: string, content: string): number {
    const overhead = role === 'system' ? SYSTEM_OVERHEAD_TOKENS : MESSAGE_OVERHEAD_TOKENS;
    return this.count(content) + overhead;
  }

  /**
   * Encode text to token IDs. Returns a Uint32Array.
   */
  encode(text: string): Uint32Array {
    return this.getTokenizer().encode(text, false);
  }

  /**
   * Decode token IDs back to text.
   */
  decode(ids: Uint32Array): string {
    return this.getTokenizer().decode(ids, true);
  }

  /** Get vocabulary size for the active tokenizer. */
  get vocabSize(): number {
    return this.getTokenizer().vocab_size();
  }

  /** Get the currently active vocab name. */
  get activeVocabName(): string {
    return this.activeVocab;
  }

  /** Get list of loaded vocab names. */
  get loadedVocabs(): string[] {
    return [...this.tokenizers.keys()];
  }

  /**
   * Release all WASM memory. Call on extension deactivation.
   */
  dispose(): void {
    for (const [name, tokenizer] of this.tokenizers) {
      tokenizer.free();
      logger.debug(`[TokenService] Freed tokenizer: ${name}`);
    }
    this.tokenizers.clear();
    this.initPromises.clear();
    this.wasmModule = null;
  }

  /** Reset singleton (for testing). */
  static resetInstance(): void {
    if (TokenService.instance) {
      TokenService.instance.dispose();
    }
    TokenService.instance = undefined as any;
  }
}
