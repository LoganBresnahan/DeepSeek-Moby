/**
 * TokenService - Exact token counting via WASM tokenizer.
 *
 * Singleton service that lazily loads DeepSeek's native BPE tokenizer
 * compiled to WebAssembly. All tokenizer data (128K vocab, 127K merge rules)
 * lives in WASM linear memory — outside V8's GC heap and 4 GB limit.
 *
 * Memory: < 2 MB JS heap, ~20-25 MB WASM linear memory.
 * Init: ~300 ms (one-time, on first use).
 * Per-count: ~0.02 ms.
 */

import * as zlib from 'zlib';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import type { TokenCounter } from './tokenCounter';
import type { DeepSeekTokenizer } from 'deepseek-moby-wasm';

/** Per-message overhead: role tokens, formatting, separators */
const MESSAGE_OVERHEAD_TOKENS = 4;

/** System prompt wrapper overhead (BOS token, role tokens, etc.) */
const SYSTEM_OVERHEAD_TOKENS = 8;

export class TokenService implements TokenCounter {
  private static instance: TokenService;

  private tokenizer: DeepSeekTokenizer | null = null;
  private initPromise: Promise<void> | null = null;
  private extensionPath: string;

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
   * Initialize the WASM tokenizer. Call during extension activation.
   *
   * Steps:
   * 1. Read the Brotli-compressed tokenizer.json.br (1.4 MB)
   * 2. Decompress with Node.js built-in zlib (~16 ms)
   * 3. Pass JSON to WASM constructor — Rust builds internal structures (~200 ms)
   */
  async initialize(): Promise<void> {
    if (this.tokenizer) { return; }
    if (!this.initPromise) {
      this.initPromise = this._doInitialize();
    }
    return this.initPromise;
  }

  private async _doInitialize(): Promise<void> {
    const start = performance.now();

    try {
      // Dynamic import — the WASM module is loaded only when needed
      const wasmModule = await import('deepseek-moby-wasm');
      const { DeepSeekTokenizer: TokenizerClass } = wasmModule;

      // Read compressed vocabulary (dist/assets/ in production, packages/ in dev)
      const distPath = path.join(this.extensionPath, 'dist', 'assets', 'tokenizer.json.br');
      const devPath = path.join(this.extensionPath, 'packages', 'moby-wasm', 'assets', 'tokenizer.json.br');
      const compressedPath = fs.existsSync(distPath) ? distPath : devPath;
      const compressed = fs.readFileSync(compressedPath);

      // Decompress (Brotli is built into Node.js, zero dependencies)
      const jsonBuffer = zlib.brotliDecompressSync(compressed);
      const json = jsonBuffer.toString('utf-8');

      // Initialize WASM tokenizer — vocab/merges go into WASM linear memory
      this.tokenizer = new TokenizerClass(json);

      const elapsed = performance.now() - start;
      logger.info(
        `[TokenService] Initialized in ${elapsed.toFixed(0)}ms ` +
        `(vocab: ${this.tokenizer!.vocab_size()} tokens)`
      );
    } catch (error) {
      this.initPromise = null; // Allow retry
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[TokenService] Failed to initialize: ${msg}`);
      throw new Error(`WASM tokenizer failed to load: ${msg}`);
    }
  }

  /** Whether the tokenizer is loaded and ready for synchronous calls. */
  get isReady(): boolean {
    return this.tokenizer !== null;
  }

  /**
   * Count tokens in a text string. Synchronous — requires initialize() first.
   * Throws if the tokenizer hasn't been initialized.
   */
  count(text: string): number {
    if (!this.tokenizer) {
      throw new Error('TokenService not initialized. Call initialize() first.');
    }
    return this.tokenizer.count_tokens(text);
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
    if (!this.tokenizer) {
      throw new Error('TokenService not initialized. Call initialize() first.');
    }
    return this.tokenizer.encode(text, false);
  }

  /**
   * Decode token IDs back to text.
   */
  decode(ids: Uint32Array): string {
    if (!this.tokenizer) {
      throw new Error('TokenService not initialized. Call initialize() first.');
    }
    return this.tokenizer.decode(ids, true);
  }

  /** Get vocabulary size (128,000 for DeepSeek V3). */
  get vocabSize(): number {
    if (!this.tokenizer) {
      throw new Error('TokenService not initialized. Call initialize() first.');
    }
    return this.tokenizer.vocab_size();
  }

  /**
   * Release WASM memory. Call on extension deactivation.
   */
  dispose(): void {
    if (this.tokenizer) {
      this.tokenizer.free();
      this.tokenizer = null;
    }
    this.initPromise = null;
  }

  /** Reset singleton (for testing). */
  static resetInstance(): void {
    if (TokenService.instance) {
      TokenService.instance.dispose();
    }
    TokenService.instance = undefined as any;
  }
}
