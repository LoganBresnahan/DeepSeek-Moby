# DeepSeek WASM Tokenizer

**Purpose:** Exact token counting for context window management using DeepSeek's native tokenizer compiled to WebAssembly.

**Status:** Complete — all 5 phases implemented and verified.

---

## Table of Contents

1. [Why WASM](#1-why-wasm)
2. [Architecture Overview](#2-architecture-overview)
3. [The Rust Crate](#3-the-rust-crate)
4. [Compressing the Vocabulary](#4-compressing-the-vocabulary)
5. [Integration with the Extension](#5-integration-with-the-extension)
6. [The TokenCounter Interface](#6-the-tokencounter-interface)
7. [ContextBuilder (Consumer)](#7-contextbuilder-consumer)
8. [Build Pipeline](#8-build-pipeline)
9. [Webpack Configuration](#9-webpack-configuration)
10. [VSIX Packaging](#10-vsix-packaging)
11. [Testing Strategy](#11-testing-strategy)
12. [File Layout](#12-file-layout)
13. [Memory & Performance Budget](#13-memory--performance-budget)
14. [Future Model Support](#14-future-model-support)
15. [Alternatives Considered](#15-alternatives-considered)
16. [Open Questions](#16-open-questions)
17. [CI/CD Pipeline](#17-cicd-pipeline)

---

## 1. Why WASM

DeepSeek uses a custom Byte-level BPE tokenizer with a 128K vocabulary — completely different from OpenAI's cl100k_base. No existing JS tokenizer library supports it. We have two options:

| Approach | JS Heap | Total Memory | Accuracy | Dependencies |
|----------|---------|-------------|----------|-------------|
| Pure JS (`@huggingface/tokenizers`) | 87 MB | ~90 MB | Exact | 8.8 KB lib + 7.5 MB vocab |
| **WASM (Rust HuggingFace tokenizers)** | **< 2 MB** | **~25 MB** | **Exact** | 1.5 MB .wasm + 1.3 MB vocab.br |
| Estimation (chars x 0.3) | 0 | 0 | +/-10-20% | None |

WASM wins because:

- **Memory lives outside V8's GC heap.** The tokenizer's 128K vocabulary entries and 127K merge rules live in WASM linear memory (an `ArrayBuffer` backing store allocated via `mmap`). V8's garbage collector never scans it. The JS heap cost is < 2 MB for wrapper objects.
- **Doesn't count against the 4 GB limit.** The VS Code extension host has a hard 4 GB heap ceiling (V8 pointer compression). WASM linear memory is outside this cage.
- **3-5x faster encoding** than pure JS for the BPE merge algorithm.
- **Proven path.** HuggingFace maintains an official `unstable_wasm` feature flag on their Rust tokenizers crate. Mithril Security published a working implementation years ago. tiktoken (OpenAI) uses the exact same architecture.

---

## 2. Architecture Overview

```
Extension activation
        |
        v
+--------------------------------------------------+
|  TokenService (singleton)                         |
|                                                   |
|  1. Read tokenizer.json.br (1.3 MB from disk)    |
|  2. Brotli decompress -> 7.5 MB JSON string      |
|  3. Pass JSON to WASM constructor                 |
|  4. Rust parses JSON -> HashMap in linear memory  |
|  5. Expose count() / encode() to TypeScript       |
+--------------------------------------------------+
        |
        v
+--------------------------------------------------+
|  ContextBuilder                                   |
|                                                   |
|  tokenService.count(systemPrompt)     -> 1,200    |
|  tokenService.count(message1)         -> 847      |
|  tokenService.count(message2)         -> 2,103    |
|  ...                                              |
|  Total: 34,150 / 128,000 budget                   |
|  Decision: include all messages, no truncation     |
+--------------------------------------------------+
        |
        v
+--------------------------------------------------+
|  DeepSeekClient.streamChat()                      |
|                                                   |
|  Sends optimized message array to API             |
|  Receives usage.prompt_tokens in response         |
|  -> Cross-check against our count (telemetry)     |
+--------------------------------------------------+
```

### Memory Layout

```
V8 GC Heap (4 GB limit)              WASM Linear Memory (outside limit)
+-----------------------+             +-------------------------------+
| Extension code        |             | Rust HashMap<Vec<u8>, u32>    |
| Actors, DOM, state    |             |   128,000 vocab entries       |
| TokenService wrapper  |--refs------>|   127,741 merge rules         |
|   (< 2 MB)           |             |   Pre-tokenizer state         |
|                       |             |   ~20-25 MB total             |
| Other extensions      |             +-------------------------------+
| (Copilot, ESLint...)  |             Allocated via mmap, invisible
+-----------------------+             to GC, not in process.heapUsed
```

---

## 3. The Rust Crate

### Directory

```
packages/
  moby-wasm/
    Cargo.toml
    src/
      lib.rs
    assets/
      tokenizer.json       # 7.48 MB - from HuggingFace (build-time only)
      tokenizer.json.br    # 1.33 MB - Brotli-11 compressed (ships with extension)
    pkg/                   # wasm-pack output (gitignored, build locally)
      package.json
      deepseek_moby_wasm.js
      deepseek_moby_wasm.d.ts
      deepseek_moby_wasm_bg.wasm
      deepseek_moby_wasm_bg.wasm.d.ts
```

### Cargo.toml

```toml
[package]
name = "deepseek-moby-wasm"
version = "0.1.0"
edition = "2021"
description = "DeepSeek V3 tokenizer compiled to WASM"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
wasm-bindgen = "0.2"
js-sys = "0.3"

# HuggingFace tokenizers with WASM support
# - `unstable_wasm` swaps C dependencies (onig regex) for pure Rust (fancy-regex)
# - `default-features = false` disables onig, esaxx_fast (C++ dep), progressbar
tokenizers = { version = "0.21", default-features = false, features = ["unstable_wasm"] }

[dev-dependencies]
wasm-bindgen-test = "0.3"

[profile.release]
opt-level = "z"       # Optimize for binary size (not speed)
lto = true            # Link-time optimization - slower build, smaller binary
codegen-units = 1     # Single codegen unit - better optimization
strip = true          # Strip debug symbols from binary
```

**Why these settings:**
- `opt-level = "z"` -- prioritize small .wasm binary over raw speed. Encoding is already fast enough (~0.02ms) even with size optimization.
- `lto = true` + `codegen-units = 1` -- whole-program optimization. Build takes longer (~60s) but produces a smaller, faster binary.
- `strip = true` -- removes debug info. Saves ~200 KB.
- Expected .wasm size: **~1.2-1.8 MB** (confirmed by existing `tokenizers-wasm` npm package at 1.5 MB).

### src/lib.rs

```rust
use wasm_bindgen::prelude::*;
use tokenizers::Tokenizer;

/// DeepSeek tokenizer wrapper for WASM.
///
/// Loads the HuggingFace tokenizer.json format and provides
/// encode/decode/count operations callable from JavaScript.
///
/// All tokenizer data (vocab, merges) lives in WASM linear memory,
/// keeping the JS heap footprint under 2 MB.
#[wasm_bindgen]
pub struct DeepSeekTokenizer {
    tokenizer: Tokenizer,
}

#[wasm_bindgen]
impl DeepSeekTokenizer {
    /// Create a tokenizer from the tokenizer.json content.
    ///
    /// The JSON string is copied from JS into WASM linear memory,
    /// parsed by serde_json, and the resulting data structures
    /// (vocab HashMap, merge rules Vec) remain in WASM memory.
    ///
    /// The JS string can be GC'd after this constructor returns.
    #[wasm_bindgen(constructor)]
    pub fn new(json: &str) -> Result<DeepSeekTokenizer, JsError> {
        let tokenizer = Tokenizer::from_str(json)
            .map_err(|e| JsError::new(&format!("Failed to load tokenizer: {}", e)))?;
        Ok(DeepSeekTokenizer { tokenizer })
    }

    /// Count tokens in text. This is the primary method for context management.
    ///
    /// Does NOT add special tokens (BOS/EOS) - those are added by the API,
    /// not by us. We count the raw content tokens for budget calculation.
    pub fn count_tokens(&self, text: &str) -> Result<u32, JsError> {
        let encoding = self.tokenizer.encode(text, false)
            .map_err(|e| JsError::new(&format!("Encode failed: {}", e)))?;
        Ok(encoding.get_ids().len() as u32)
    }

    /// Encode text to token IDs. Returns a Uint32Array.
    ///
    /// Useful for advanced context management (e.g., truncating at
    /// a token boundary rather than a character boundary).
    pub fn encode(&self, text: &str, add_special_tokens: bool) -> Result<js_sys::Uint32Array, JsError> {
        let encoding = self.tokenizer.encode(text, add_special_tokens)
            .map_err(|e| JsError::new(&format!("Encode failed: {}", e)))?;
        let ids = encoding.get_ids();
        let array = js_sys::Uint32Array::new_with_length(ids.len() as u32);
        array.copy_from(ids);
        Ok(array)
    }

    /// Decode token IDs back to text.
    pub fn decode(&self, ids: &[u32], skip_special_tokens: bool) -> Result<String, JsError> {
        self.tokenizer.decode(ids, skip_special_tokens)
            .map_err(|e| JsError::new(&format!("Decode failed: {}", e)))
    }

    /// Get the vocabulary size (128,000 for DeepSeek V3).
    pub fn vocab_size(&self) -> u32 {
        self.tokenizer.get_vocab_size(false) as u32
    }
}
```

**Design decisions:**
- `count_tokens()` uses `add_special_tokens: false` -- we count raw content tokens. The API adds BOS/EOS/role tokens itself; those appear in the API's `usage.prompt_tokens` but we don't control them. We account for them with a small fixed overhead per message (~4 tokens for role/formatting).
- `encode()` returns `Uint32Array` -- this is a view into WASM memory, zero-copy on the WASM side. JS gets a typed array it can iterate efficiently.
- No `tokenize()` (string tokens) method -- we don't need token strings for context management, and returning them requires copying strings across the WASM boundary.

---

## 4. Compressing the Vocabulary

### The Problem

DeepSeek V3's `tokenizer.json` is 7.48 MB. Our extension code is under 1 MB. Shipping the raw JSON would 8x the on-disk footprint.

### The Solution: Brotli-11

Compress at build time, decompress at runtime using Node.js built-in `zlib.brotliDecompressSync()`. Zero dependencies.

**Measured compression results** (from actual `tokenizer.json`):

| Format | File Size | Reduction | Node.js Built-in? | Decompress Time |
|--------|-----------|-----------|-------------------|-----------------|
| Raw JSON | 7.48 MB | -- | -- | -- |
| Gzip -9 | 1.84 MB | 75.5% | Yes | ~17 ms |
| Brotli -6 | 1.61 MB | 78.5% | Yes | ~15 ms |
| Zstd -19 | 1.43 MB | 80.9% | **No** | -- |
| **Brotli -11** | **1.33 MB** | **82.2%** | **Yes** | **~16 ms** |

Brotli -11 wins: smallest size, built-in Node.js support, fast decompression.

Zstd compresses slightly worse AND requires a native npm dependency. Not worth it.

### End-to-End Load Timing

**Measured on this machine** (Node.js v25.4.0):

| Step | Time |
|------|------|
| `fs.readFileSync('tokenizer.json.br')` (1.3 MB) | ~2 ms |
| `zlib.brotliDecompressSync()` | ~16 ms |
| `JSON.parse()` (7.5 MB string) | ~60 ms |
| **Total: read + decompress + parse** | **~71 ms** |

For comparison, reading the raw 7.5 MB JSON: **~68 ms**. The decompression is effectively free -- reading less data from disk offsets the CPU cost.

After JSON.parse, the string is passed to the WASM constructor where Rust parses it again into its internal structures. This adds ~100-150 ms. Total cold start: **~220 ms**.

### VSIX Download Impact

A VSIX is a ZIP file (DEFLATE compression). How files compress inside the ZIP:

| File in VSIX | VSIX contribution (DEFLATE'd) | On-disk after install |
|-------------|-------------------------------|---------------------|
| Raw `tokenizer.json` | 1.84 MB | 7.48 MB |
| `tokenizer.json.br` | 1.33 MB | **1.33 MB** |

Pre-compressing with Brotli saves 0.5 MB in download and **6.15 MB on disk**. The on-disk savings are the real win -- users see a 1.3 MB file instead of a 7.5 MB file in their extension folder.

### Build-Time Compression

```bash
# One-time: compress the vocab file
brotli -q 11 -o assets/tokenizer.json.br assets/tokenizer.json

# The raw tokenizer.json stays in the repo for reference/rebuilds
# but only tokenizer.json.br ships in the VSIX
```

This is a build step, not a runtime concern. Brotli -11 takes ~2 seconds to compress. It only needs to run when updating the tokenizer vocabulary (i.e., when DeepSeek releases a new model).

---

## 5. Integration with the Extension

### TokenService (New File: `src/services/tokenService.ts`)

```typescript
import * as vscode from 'vscode';
import * as zlib from 'zlib';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

// Type from the generated WASM bindings
import type { DeepSeekTokenizer } from 'deepseek-moby-wasm';

/**
 * TokenService - Singleton service for exact token counting.
 *
 * Lazily initializes a WASM-based DeepSeek tokenizer on first use.
 * All tokenizer data lives in WASM linear memory (outside V8 heap).
 *
 * Memory cost: < 2 MB JS heap, ~20-25 MB WASM linear memory.
 * Init cost: ~220 ms (one-time, on first count() call).
 * Per-count cost: ~0.02 ms.
 */
export class TokenService {
  private static instance: TokenService;

  private tokenizer: DeepSeekTokenizer | null = null;
  private initPromise: Promise<void> | null = null;
  private extensionPath: string;

  // Per-message overhead: role tokens, formatting, separators.
  // DeepSeek's chat template adds ~4 tokens per message
  // (e.g., <|User|>, <|Assistant|>, newlines).
  private static readonly MESSAGE_OVERHEAD_TOKENS = 4;

  // System prompt wrapper overhead (BOS token, role tokens, etc.)
  private static readonly SYSTEM_OVERHEAD_TOKENS = 8;

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
   * Initialize the WASM tokenizer.
   *
   * Steps:
   * 1. Read the Brotli-compressed tokenizer.json.br (1.3 MB)
   * 2. Decompress with Node.js built-in zlib (16 ms)
   * 3. Parse JSON (60 ms)
   * 4. Pass to WASM constructor - Rust builds internal structures (100-150 ms)
   *
   * Total: ~220 ms. Called lazily on first count().
   */
  private async initialize(): Promise<void> {
    const start = performance.now();

    try {
      // Dynamic import - the WASM module is loaded only when needed
      const { DeepSeekTokenizer } = await import('deepseek-moby-wasm');

      // Read compressed vocabulary
      const compressedPath = path.join(
        this.extensionPath, 'assets', 'tokenizer.json.br'
      );
      const compressed = fs.readFileSync(compressedPath);

      // Decompress (Brotli is built into Node.js, zero dependencies)
      const jsonBuffer = zlib.brotliDecompressSync(compressed);
      const json = jsonBuffer.toString('utf-8');

      // Initialize WASM tokenizer - vocab/merges go into WASM linear memory
      this.tokenizer = new DeepSeekTokenizer(json);

      const elapsed = performance.now() - start;
      logger.info(`[TokenService] Initialized in ${elapsed.toFixed(0)}ms ` +
        `(vocab: ${this.tokenizer.vocab_size()} tokens)`);

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[TokenService] Failed to initialize: ${msg}`);
      throw new Error(`WASM tokenizer failed to load: ${msg}`);
    }
  }

  /**
   * Ensure the tokenizer is loaded. Deduplicates concurrent init calls.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.tokenizer) return;
    if (!this.initPromise) {
      this.initPromise = this.initialize();
    }
    await this.initPromise;
  }

  /**
   * Count tokens in a text string.
   *
   * Returns exact count using DeepSeek's native BPE tokenizer.
   */
  async count(text: string): Promise<number> {
    await this.ensureInitialized();
    return this.tokenizer!.count_tokens(text);
  }

  /**
   * Synchronous count - requires tokenizer to be initialized first.
   * Call ensureInitialized() or count() before using this.
   *
   * Useful in hot paths where you can't await (e.g., UI updates).
   */
  countSync(text: string): number {
    if (!this.tokenizer) {
      throw new Error('TokenService not initialized. Call count() first.');
    }
    return this.tokenizer.count_tokens(text);
  }

  /**
   * Count tokens for a chat message, including role/formatting overhead.
   *
   * DeepSeek's chat template wraps each message with role tokens:
   *   <|User|>{content}<|Assistant|>
   * This adds ~4 tokens per message beyond the content itself.
   */
  async countMessage(role: 'user' | 'assistant' | 'system' | 'tool', content: string): Promise<number> {
    const contentTokens = await this.count(content);
    if (role === 'system') {
      return contentTokens + TokenService.SYSTEM_OVERHEAD_TOKENS;
    }
    return contentTokens + TokenService.MESSAGE_OVERHEAD_TOKENS;
  }

  /**
   * Count tokens for an array of messages.
   */
  async countMessages(messages: Array<{ role: string; content: string }>): Promise<number> {
    let total = 0;
    for (const msg of messages) {
      total += await this.countMessage(
        msg.role as 'user' | 'assistant' | 'system' | 'tool',
        msg.content
      );
    }
    return total;
  }

  /**
   * Check if a text fits within a token budget.
   */
  async fitsInBudget(text: string, budget: number): Promise<boolean> {
    const count = await this.count(text);
    return count <= budget;
  }

  /**
   * Encode text to token IDs.
   *
   * Returns a Uint32Array of token IDs. Useful for:
   * - Truncating text at a token boundary (not mid-token)
   * - Inspecting tokenization for debugging
   * - Building precise context windows
   */
  async encode(text: string): Promise<Uint32Array | null> {
    await this.ensureInitialized();
    if (!this.tokenizer) return null;
    return this.tokenizer.encode(text, false);
  }

  /**
   * Decode token IDs back to text.
   */
  async decode(ids: Uint32Array): Promise<string | null> {
    await this.ensureInitialized();
    if (!this.tokenizer) return null;
    return this.tokenizer.decode(ids, true);
  }

  /**
   * Truncate text to fit within a token budget.
   *
   * Encodes, slices the token array, and decodes back.
   * This ensures truncation happens at a clean token boundary
   * instead of cutting in the middle of a multi-byte character or token.
   */
  async truncateToFit(text: string, maxTokens: number): Promise<string> {
    const ids = await this.encode(text);
    if (!ids || ids.length <= maxTokens) return text;

    const truncatedIds = ids.slice(0, maxTokens);
    const decoded = await this.decode(truncatedIds);
    return decoded ?? text.substring(0, maxTokens * 3); // fallback: ~3 chars/token
  }

  /**
   * Whether the tokenizer is loaded and providing exact counts.
   */
  get isExact(): boolean {
    return this.tokenizer !== null;
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
}
```

### Initialization in extension.ts

```typescript
// In activate():
import { TokenService } from './services/tokenService';

export async function activate(context: vscode.ExtensionContext) {
  // ... existing initialization ...

  // Initialize token service (lazy - doesn't load WASM until first count())
  const tokenService = TokenService.getInstance(context.extensionPath);

  // Pass to ChatProvider, ContextBuilder, etc.
  chatProvider = new ChatProvider(
    context.extensionUri,
    deepSeekClient,
    statusBar,
    conversationManager,
    tavilyClient,
    tokenService          // NEW parameter
  );

  // Cleanup on deactivation
  context.subscriptions.push({
    dispose: () => tokenService.dispose()
  });
}
```

---

## 6. The TokenCounter Interface

Define an interface for token counting. The ContextBuilder depends on this interface, making it testable without WASM.

```typescript
// src/services/tokenCounter.ts

/**
 * Interface for token counting strategies.
 *
 * Implementations:
 * - TokenService: Exact counts via WASM tokenizer (primary)
 * - EstimationTokenCounter: Character-based estimation (for tests)
 *
 * The ContextBuilder depends on this interface, not on the concrete
 * implementation. This means:
 * - Tests use EstimationTokenCounter (no WASM needed in test runner)
 * - Future model changes only affect the counter, not the builder
 */
export interface TokenCounter {
  /** Count tokens in a text string */
  count(text: string): Promise<number>;

  /** Synchronous count (exact if loaded, estimate if not) */
  countSync(text: string): number;

  /** Count tokens for a message including role overhead */
  countMessage(role: string, content: string): Promise<number>;

  /** Whether this counter provides exact counts */
  readonly isExact: boolean;
}

/**
 * Estimation-based token counter. Zero dependencies.
 *
 * Uses DeepSeek's documented ratio of ~0.3 tokens per English character.
 * Optionally calibrates against real API usage data over time.
 */
export class EstimationTokenCounter implements TokenCounter {
  private calibrationRatio = 0.3;
  private samples: number[] = [];
  private static readonly MAX_SAMPLES = 20;
  private static readonly MESSAGE_OVERHEAD = 4;

  readonly isExact = false;

  async count(text: string): Promise<number> {
    return this.countSync(text);
  }

  countSync(text: string): number {
    return Math.ceil(text.length * this.calibrationRatio);
  }

  async countMessage(role: string, content: string): Promise<number> {
    return (await this.count(content)) + EstimationTokenCounter.MESSAGE_OVERHEAD;
  }

  /**
   * Calibrate the ratio using actual token counts from the API.
   *
   * Called after every API response that includes usage data.
   * The ratio self-corrects within 5-10 samples to +/-5% accuracy.
   *
   * @param textLength - Character count of the input text
   * @param actualTokens - Actual token count from API usage
   */
  calibrate(textLength: number, actualTokens: number): void {
    if (textLength === 0) return;
    const ratio = actualTokens / textLength;
    this.samples.push(ratio);
    if (this.samples.length > EstimationTokenCounter.MAX_SAMPLES) {
      this.samples.shift();
    }
    this.calibrationRatio = this.samples.reduce((a, b) => a + b) / this.samples.length;
  }
}
```

The TokenService from section 5 implements this same interface. The key insight: the ContextBuilder never knows or cares whether it's getting exact WASM counts or calibrated estimates.

---

## 7. ContextBuilder (Consumer)

This is the primary consumer of the TokenService. It decides what messages to include in each API call.

```typescript
// src/context/contextBuilder.ts

import { TokenCounter } from '../services/tokenCounter';
import { Message } from '../deepseekClient';

/**
 * Model context limits.
 *
 * DeepSeek V3: 128K total context (input + output).
 * We reserve tokens for the response and a safety buffer.
 */
interface ModelBudget {
  totalContext: number;      // 128,000 for DeepSeek V3
  maxOutputTokens: number;  // 8,192 (chat) or 16,384 (reasoner)
  safetyBuffer: number;     // Estimation error margin (0 if exact)
}

const MODEL_BUDGETS: Record<string, ModelBudget> = {
  'deepseek-chat': {
    totalContext: 128_000,
    maxOutputTokens: 8_192,
    safetyBuffer: 0,     // WASM is exact, no buffer needed
  },
  'deepseek-reasoner': {
    totalContext: 128_000,
    maxOutputTokens: 16_384,
    safetyBuffer: 0,
  },
};

/**
 * When the token counter is estimation-based (not exact), add a safety
 * buffer to avoid overflowing the context window.
 */
const ESTIMATION_SAFETY_MARGIN = 0.10; // 10%

interface ContextResult {
  messages: Message[];
  tokenCount: number;
  budget: number;
  truncated: boolean;
  /** How many messages were dropped from the beginning */
  droppedCount: number;
  /** Summary injected in place of dropped messages (if any) */
  summaryInjected: boolean;
}

/**
 * ContextBuilder - Decides what fits in the context window.
 *
 * Strategy:
 * 1. Count system prompt tokens (fixed cost per request)
 * 2. Count tool definitions tokens (fixed cost when tools are active)
 * 3. Remaining budget = total - output_reserve - system - tools - safety
 * 4. Fill from most recent messages backward until budget exhausted
 * 5. If oldest messages were dropped, optionally inject a snapshot summary
 *
 * This replaces the current approach in deepseekClient.ts where ALL
 * messages are sent regardless of size.
 */
export class ContextBuilder {
  private tokenCounter: TokenCounter;

  constructor(tokenCounter: TokenCounter) {
    this.tokenCounter = tokenCounter;
  }

  /**
   * Build an optimized message array that fits within the model's context.
   *
   * @param messages - Full conversation history (oldest first)
   * @param systemPrompt - The system prompt text
   * @param model - Model name for budget lookup
   * @param snapshotSummary - Optional summary from SnapshotManager for dropped context
   * @returns Optimized message array with token counts
   */
  async build(
    messages: Message[],
    systemPrompt: string | undefined,
    model: string,
    snapshotSummary?: string
  ): Promise<ContextResult> {
    const budget = MODEL_BUDGETS[model] ?? MODEL_BUDGETS['deepseek-chat'];

    // Apply safety margin if using estimation
    const safetyMultiplier = this.tokenCounter.isExact
      ? 1.0
      : (1.0 - ESTIMATION_SAFETY_MARGIN);

    // Step 1: Calculate fixed costs
    const systemTokens = systemPrompt
      ? await this.tokenCounter.countMessage('system', systemPrompt)
      : 0;

    // Step 2: Available budget for conversation messages
    const availableBudget = Math.floor(
      (budget.totalContext - budget.maxOutputTokens) * safetyMultiplier
    ) - systemTokens;

    // Step 3: Count tokens for each message (newest first for priority)
    const messageCosts: Array<{ message: Message; tokens: number }> = [];
    for (const msg of messages) {
      const content = typeof msg.content === 'string'
        ? msg.content
        : msg.content.map(c => c.type === 'text' ? c.text : '[image]').join('');
      const tokens = await this.tokenCounter.countMessage(msg.role, content);
      messageCosts.push({ message: msg, tokens });
    }

    // Step 4: Fill from newest messages backward
    let usedTokens = 0;
    let cutoffIndex = messageCosts.length; // Start including all

    for (let i = messageCosts.length - 1; i >= 0; i--) {
      if (usedTokens + messageCosts[i].tokens > availableBudget) {
        cutoffIndex = i + 1;
        break;
      }
      usedTokens += messageCosts[i].tokens;
      if (i === 0) cutoffIndex = 0; // All messages fit
    }

    // Step 5: Build result
    const includedMessages = messageCosts.slice(cutoffIndex).map(mc => mc.message);
    const droppedCount = cutoffIndex;

    // Step 6: If messages were dropped, inject snapshot summary
    let summaryInjected = false;
    if (droppedCount > 0 && snapshotSummary) {
      const summaryTokens = await this.tokenCounter.countMessage('user', snapshotSummary);
      if (usedTokens + summaryTokens <= availableBudget) {
        // Inject summary as a synthetic "user" message at the beginning
        includedMessages.unshift({
          role: 'user',
          content: `[Previous conversation context]\n${snapshotSummary}`
        });
        // Inject a synthetic assistant acknowledgment
        includedMessages.splice(1, 0, {
          role: 'assistant',
          content: 'I understand the context from our earlier conversation. Continuing from where we left off.'
        });
        usedTokens += summaryTokens;
        summaryInjected = true;
      }
    }

    return {
      messages: includedMessages,
      tokenCount: usedTokens + systemTokens,
      budget: budget.totalContext - budget.maxOutputTokens,
      truncated: droppedCount > 0,
      droppedCount,
      summaryInjected,
    };
  }
}
```

### Usage in DeepSeekClient

The ContextBuilder replaces the current direct message-forwarding in `streamChat()`:

```typescript
// BEFORE (current code in deepseekClient.ts - no context management):
const requestMessages = [...messages].map(m => ({
  role: m.role,
  content: m.content,
}));

// AFTER (with ContextBuilder):
const contextResult = await this.contextBuilder.build(
  messages,
  systemPrompt,
  this.getModel(),
  latestSnapshot?.summary
);

logger.info(`[Context] ${contextResult.tokenCount}/${contextResult.budget} tokens, ` +
  `${contextResult.droppedCount} messages dropped, ` +
  `summary: ${contextResult.summaryInjected}`);

const requestMessages = contextResult.messages.map(m => ({
  role: m.role,
  content: m.content,
}));
```

---

## 8. Build Pipeline

### Prerequisites (One-Time Setup)

```bash
# Install Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install wasm-pack
cargo install wasm-pack

# Add WASM target
rustup target add wasm32-unknown-unknown
```

### Build Commands

```bash
# Build the WASM binary (outputs to packages/moby-wasm/pkg/)
cd packages/moby-wasm
wasm-pack build --target nodejs --release

# Post-build: optimize the WASM binary further (optional, saves ~100-200 KB)
# Requires: cargo install wasm-opt  (or install binaryen)
wasm-opt -Oz -o pkg/deepseek_moby_wasm_bg.wasm pkg/deepseek_moby_wasm_bg.wasm

# Compress the vocabulary file (only when updating the tokenizer)
brotli -q 11 -f -o assets/tokenizer.json.br assets/tokenizer.json
```

### npm Scripts (root package.json additions)

```json
{
  "scripts": {
    "build:wasm": "cd packages/moby-wasm && wasm-pack build --target nodejs --release",
    "build:media": "node scripts/build-media.js",
    "compile": "npm run build:media && webpack",
    "package": "npm run build:media && webpack --mode production --devtool hidden-source-map"
  },
  "dependencies": {
    "deepseek-moby-wasm": "file:packages/moby-wasm/pkg"
  }
}
```

**Note:** `build:wasm` is NOT part of the normal `compile` pipeline. The `pkg/` directory is **gitignored** -- developers must build it locally before the extension will work.

### First-Time Setup

```bash
# 1. Install Rust + wasm-pack (one-time)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
rustup target add wasm32-unknown-unknown
cargo install wasm-pack

# 2. Build WASM then install deps (two commands)
npm run build:wasm   # works before npm ci — just shells out wasm-pack
npm ci               # now pkg/ exists, file: dependency resolves
```

**Why this order:** `package.json` declares `"deepseek-moby-wasm": "file:packages/moby-wasm/pkg"`. When `npm ci` runs, it tries to read `pkg/package.json` to resolve the dependency. If `pkg/` doesn't exist yet, `npm ci` fails. Running `npm run build:wasm` first creates `pkg/`. This works because `npm run` doesn't resolve dependencies — it just reads the `scripts` section and shells out the command.

After the initial build, `pkg/` persists on disk. You only need to rebuild when:
- Updating the Rust glue code in `src/lib.rs`
- Upgrading the `tokenizers` crate version
- Updating the `tokenizer.json` for a new model

---

## 9. Webpack Configuration

The WASM module needs special handling in webpack. `wasm-pack --target nodejs` outputs a JS glue file that uses `require('fs')` and `require('path')` to load the `.wasm` binary. Since `node_modules/deepseek-moby-wasm` is a symlink (from `file:` dependency) that `vsce` can't follow, we copy everything to `dist/` and resolve the import to a relative path.

```javascript
// webpack.config.js (actual implementation)
const CopyPlugin = require('copy-webpack-plugin');

const config = {
  // ... existing config ...

  externals: [
    { vscode: 'commonjs vscode' },
    { '@signalapp/sqlcipher': 'commonjs @signalapp/sqlcipher' },
    // WASM tokenizer — resolve to co-located copy in dist/wasm/
    ({ request }, callback) => {
      if (request === 'deepseek-moby-wasm') {
        return callback(null, 'commonjs ./wasm/deepseek_moby_wasm.js');
      }
      callback();
    }
  ],

  plugins: [
    new CopyPlugin({
      patterns: [
        // Compressed vocabulary for WASM tokenizer
        { from: 'packages/moby-wasm/assets/tokenizer.json.br', to: 'assets/tokenizer.json.br' },
        // WASM module (JS glue + binary)
        { from: 'packages/moby-wasm/pkg/deepseek_moby_wasm.js', to: 'wasm/deepseek_moby_wasm.js' },
        { from: 'packages/moby-wasm/pkg/deepseek_moby_wasm_bg.wasm', to: 'wasm/deepseek_moby_wasm_bg.wasm' }
      ]
    })
  ],
};
```

**Key difference from the original plan:** We use a function external (not object) to resolve `deepseek-moby-wasm` to `commonjs ./wasm/deepseek_moby_wasm.js` — a relative path within `dist/`. This ensures the WASM JS glue finds its `.wasm` binary in the same directory. The original plan used `commonjs deepseek-moby-wasm` which would try to resolve via `node_modules` (a symlink that `vsce` can't follow).

---

## 10. VSIX Packaging

### .vscodeignore Updates

Since everything needed is copied to `dist/` by webpack's CopyPlugin, we simply exclude the entire `packages/` directory:

```
# WASM tokenizer — all needed files are copied to dist/ by webpack
packages/**
```

This is simpler than the original plan's per-file exclusions. The `dist/` directory (which `vsce` includes by default) contains:
- `dist/wasm/deepseek_moby_wasm.js` — JS glue
- `dist/wasm/deepseek_moby_wasm_bg.wasm` — WASM binary
- `dist/assets/tokenizer.json.br` — Compressed vocabulary

### Size Impact

| File | Size |
|------|------|
| `deepseek_moby_wasm_bg.wasm` | ~1.5 MB |
| `deepseek_moby_wasm.js` (glue) | ~3 KB |
| `deepseek_moby_wasm.d.ts` | ~1 KB |
| `tokenizer.json.br` | 1.33 MB |
| **Total addition to VSIX** | **~2.8 MB** |

For comparison: GitHub Copilot is 19 MB. Pylance is 29 MB. Our total extension would be ~4 MB.

---

## 11. Testing Strategy

### Unit Tests for TokenService

```typescript
// tests/unit/services/tokenService.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the WASM module for unit tests (no actual WASM in test runner)
vi.mock('deepseek-moby-wasm', () => ({
  DeepSeekTokenizer: class MockTokenizer {
    constructor(json: string) {
      JSON.parse(json); // Verify JSON is parseable
    }

    count_tokens(text: string): number {
      // Simplified mock: ~0.3 tokens per char
      return Math.ceil(text.length * 0.3);
    }

    encode(text: string, _addSpecial: boolean): Uint32Array {
      return new Uint32Array([1, 2, 3]);
    }

    decode(_ids: Uint32Array, _skipSpecial: boolean): string {
      return 'decoded text';
    }

    vocab_size(): number {
      return 128000;
    }

    free(): void {}
  }
}));

describe('TokenService', () => {
  it('should lazy-initialize on first count()', async () => {
    // ...
  });

  it('should fall back to estimation if WASM fails', async () => {
    // ...
  });

  it('should add message overhead to content count', async () => {
    // ...
  });

  it('should truncate text at token boundaries', async () => {
    // ...
  });

  it('should dispose WASM memory on cleanup', () => {
    // ...
  });
});
```

### Unit Tests for ContextBuilder

```typescript
// tests/unit/context/contextBuilder.test.ts
import { describe, it, expect } from 'vitest';
import { ContextBuilder } from '../../src/context/contextBuilder';
import { EstimationTokenCounter } from '../../src/services/tokenCounter';

describe('ContextBuilder', () => {
  it('should include all messages when within budget', async () => {
    const counter = new EstimationTokenCounter();
    const builder = new ContextBuilder(counter);

    const result = await builder.build(
      [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' }
      ],
      'You are a helpful assistant.',
      'deepseek-chat'
    );

    expect(result.truncated).toBe(false);
    expect(result.droppedCount).toBe(0);
    expect(result.messages).toHaveLength(2);
  });

  it('should drop oldest messages when over budget', async () => {
    const counter = new EstimationTokenCounter();
    const builder = new ContextBuilder(counter);

    // Fill with many long messages that exceed budget
    const messages = Array.from({ length: 100 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: 'x'.repeat(5000) // ~1,500 tokens each at 0.3 ratio
    }));

    const result = await builder.build(messages, undefined, 'deepseek-chat');

    expect(result.truncated).toBe(true);
    expect(result.droppedCount).toBeGreaterThan(0);
    expect(result.tokenCount).toBeLessThanOrEqual(result.budget);
  });

  it('should inject snapshot summary when messages are dropped', async () => {
    // ...
  });

  it('should apply safety margin for estimation-based counter', async () => {
    // ...
  });

  it('should not apply safety margin for exact counter', async () => {
    // ...
  });
});
```

### Integration Test: WASM Loads Correctly

This test requires the actual built WASM. Run separately from the normal vitest suite.

```typescript
// tests/integration/moby-wasm.test.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as zlib from 'zlib';
import * as path from 'path';

describe('WASM Tokenizer Integration', () => {
  it('should load compressed vocab and count tokens', async () => {
    const { DeepSeekTokenizer } = await import('deepseek-moby-wasm');

    const compressed = fs.readFileSync(
      path.join(__dirname, '../../packages/moby-wasm/assets/tokenizer.json.br')
    );
    const json = zlib.brotliDecompressSync(compressed).toString('utf-8');
    const tokenizer = new DeepSeekTokenizer(json);

    expect(tokenizer.count_tokens('Hello')).toBe(1);
    expect(tokenizer.vocab_size()).toBe(128000);

    tokenizer.free();
  });
});
```

---

## 12. File Layout

Complete file layout after implementation:

```
deepseek-vscode-extension/
|
+-- packages/
|   +-- moby-wasm/
|       +-- Cargo.toml                               # Rust crate config
|       +-- Cargo.lock                               # Locked dependencies
|       +-- src/
|       |   +-- lib.rs                               # WASM glue (~50 lines)
|       +-- assets/
|       |   +-- tokenizer.json                       # 7.48 MB (gitignored, build-time only)
|       |   +-- tokenizer.json.br                    # 1.33 MB (ships with extension)
|       +-- pkg/                                     # wasm-pack output (gitignored, build locally)
|           +-- package.json
|           +-- deepseek_moby_wasm.js           # ~3 KB JS glue
|           +-- deepseek_moby_wasm.d.ts         # TypeScript types
|           +-- deepseek_moby_wasm_bg.wasm      # ~1.5 MB WASM binary
|           +-- deepseek_moby_wasm_bg.wasm.d.ts
|
+-- src/
|   +-- services/
|   |   +-- tokenService.ts                          # TokenService singleton
|   |   +-- tokenCounter.ts                          # Interface + EstimationTokenCounter
|   +-- context/
|   |   +-- contextBuilder.ts                        # ContextBuilder (budget management)
|   +-- deepseekClient.ts                            # Modified: uses ContextBuilder
|   +-- extension.ts                                 # Modified: initializes TokenService
|
+-- tests/
|   +-- unit/
|   |   +-- services/
|   |   |   +-- tokenService.test.ts
|   |   |   +-- tokenCounter.test.ts
|   |   +-- context/
|   |       +-- contextBuilder.test.ts
|   +-- integration/
|       +-- moby-wasm.test.ts                   # Requires built WASM
|
+-- webpack.config.js                                # Modified: externals + CopyPlugin
+-- .vscodeignore                                    # Modified: include WASM assets
+-- package.json                                     # Modified: file: dependency + build:wasm
```

---

## 13. Memory & Performance Budget

### Memory (Measured / Projected)

| Component | JS Heap (`heapUsed`) | WASM / External | Total RSS |
|-----------|---------------------|-----------------|-----------|
| WASM instance + glue | ~0.5 MB | -- | -- |
| WASM linear memory (vocab + merges) | -- | ~20-25 MB | -- |
| Temporary: JSON string during init | ~7.5 MB (freed after) | -- | -- |
| **Steady state** | **~0.5 MB** | **~20-25 MB** | **~25 MB** |

Compare to pure JS `@huggingface/tokenizers`: 87 MB JS heap (all GC-managed).

### Performance (Measured / Projected)

| Operation | Time |
|-----------|------|
| Cold start (read .br + decompress + parse + WASM init) | ~220 ms |
| `count_tokens()` -- short text (< 100 chars) | ~0.01-0.02 ms |
| `count_tokens()` -- paragraph (~500 chars) | ~0.02-0.05 ms |
| `count_tokens()` -- large context (~10K tokens) | ~5-8 ms |
| `countMessages()` -- 50 messages | ~1-3 ms |
| ContextBuilder.build() -- 100 messages | ~5-10 ms |

The 220 ms cold start happens once (lazy, on first use). All subsequent operations are sub-millisecond for typical message sizes.

### Compared to Current Code

Currently, `estimateTokens()` in `deepseekClient.ts:584` is:
```typescript
estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);  // ~0.001 ms, +/-20% accuracy
}
```

The WASM tokenizer is ~20x slower per call (0.02 ms vs 0.001 ms) but the difference is invisible -- both are far below the threshold of perceptibility. The accuracy improvement (exact vs +/-20%) is the real value.

---

## 14. Future Model Support

### When DeepSeek V4 Ships

If DeepSeek V4 uses a new tokenizer vocabulary:

1. Download the new `tokenizer.json` from HuggingFace
2. Run `brotli -q 11 -o tokenizer.json.br tokenizer.json`
3. Replace `assets/tokenizer.json.br`
4. No Rust code changes needed -- same HuggingFace JSON format

The WASM binary doesn't change. Only the vocabulary file changes. This is a 2-minute update.

### Multiple Model Support

If you need to support multiple models with different tokenizers simultaneously:

```typescript
class TokenService {
  private tokenizers = new Map<string, DeepSeekTokenizer>();

  async getForModel(model: string): Promise<DeepSeekTokenizer> {
    if (!this.tokenizers.has(model)) {
      const json = this.loadVocab(model); // tokenizer-{model}.json.br
      const tokenizer = new DeepSeekTokenizer(json);
      this.tokenizers.set(model, tokenizer);
    }
    return this.tokenizers.get(model)!;
  }
}
```

Each model's tokenizer adds ~25 MB of WASM linear memory. For 2-3 models, this is fine.

### Non-DeepSeek Models

The WASM tokenizer loads any HuggingFace `tokenizer.json` format. If the extension ever supports other providers (OpenAI, Anthropic, Llama), you can add their vocabulary files without changing the Rust code. The HuggingFace format is the industry standard.

---

## 15. Alternatives Considered

### Pure JS (`@huggingface/tokenizers`)

- **Pro:** Zero build complexity, `npm install` and done.
- **Con:** 87 MB JS heap, all GC-managed. Competes with other extensions for the 4 GB limit.
- **Verdict:** Works, but wasteful. WASM is strictly better for memory.

### Estimation Only (chars x 0.3)

- **Pro:** Zero dependencies, zero memory, self-calibrates with API feedback.
- **Con:** +/-10-20% accuracy. Can't count before the first API call. Can't truncate at token boundaries. Can't build a precise token usage UI.
- **Verdict:** Not accurate enough for a polished UX. We keep `EstimationTokenCounter` for unit tests (lightweight, no WASM needed in test runner) but NOT as a runtime fallback. The extension always uses WASM.

### Hybrid (Estimation First, WASM Later)

- **Pro:** Unblocks ContextBuilder immediately. Add WASM as an upgrade.
- **Con:** Two code paths to maintain. Ambiguity about which counter is active.
- **Verdict:** No longer needed. WASM is always built (required for development). The `TokenCounter` interface still exists for testability — tests pass `EstimationTokenCounter` to `ContextBuilder` instead of needing real WASM in the test runner.

### Pre-Built npm Package (`tokenizers-wasm`)

- Published by Mithril Security, last updated 4+ years ago.
- Stale, unmaintained, may not work with latest `wasm-bindgen`.
- **Verdict:** Don't depend on an abandoned package. Building our own is ~50 lines of Rust.

---

## 16. Open Questions

### Q1: Warm-up Strategy

Should we pre-warm the tokenizer during extension activation, or wait for the first message?

- **Pre-warm:** 220 ms added to activation time. User never sees a delay on first message.
- **Lazy:** Zero activation cost. First message has a 220 ms delay (imperceptible -- the API call takes 1-5 seconds anyway).
- **Leaning:** Lazy. The API call latency completely masks the tokenizer init.

### Q2: Tokenizer for System Prompt + Tools

The API's `usage.prompt_tokens` includes tokens from the system prompt and tool definitions. Should the ContextBuilder count these precisely, or use a fixed estimate?

- The system prompt is relatively static (changes only when settings change).
- Tool definitions are fixed per-session.
- **Leaning:** Count precisely once per session, cache the result. Recount only when system prompt or tools change.

### Q3: Token Count Cross-Validation

Should we compare our count against the API's `usage.prompt_tokens` on every request and log discrepancies?

- Useful for catching bugs (wrong tokenizer version, miscounted overhead).
- Useful for tuning the `MESSAGE_OVERHEAD_TOKENS` constant.
- Small logging cost.
- **Leaning:** Yes, as a trace event. Log the delta as a percentage.

### Q4: Worker Thread

Should the tokenizer run in a Node.js Worker thread to avoid blocking the extension host?

- `count_tokens()` takes 0.02 ms for typical messages -- not worth the thread overhead.
- `ContextBuilder.build()` with 100 messages takes ~5-10 ms -- borderline.
- Worker thread adds complexity (message passing, serialization).
- **Leaning:** No. The operations are fast enough on the main thread. Revisit if profiling shows jank.

### Q5: Commit the pkg/ Directory?

Should the WASM build output be committed to git?

- **Commit:** Contributors don't need Rust. The pkg/ is only ~1.5 MB. Simple. `npm ci` always works.
- **Don't commit:** Binary files in git is messy. Developer must build locally. CI builds fresh.
- **Decision: Don't commit.** Developer is required to have Rust installed and build WASM locally. This ensures the build pipeline is understood and tested. CI also builds fresh. The `pkg/` directory persists locally after first build — only needs rebuilding when Rust code or vocab changes.

---

## 17. CI/CD Pipeline

### Design

WASM is cross-platform by design -- one `.wasm` binary runs everywhere (Linux, macOS, Windows, x64, arm64). Combined with `@signalapp/sqlcipher` shipping prebuilt binaries for all 6 platforms inside its npm package, we need only a **single Ubuntu runner** to produce a universal VSIX.

Since `pkg/` is gitignored, **CI must build WASM fresh** using Rust + wasm-pack.

### GitHub Actions Workflow

```yaml
# .github/workflows/release.yml
name: Build and Release

on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22.x'
          cache: 'npm'

      # ---- Rust + WASM (must run BEFORE npm ci) ----
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: wasm32-unknown-unknown

      - uses: jetli/wasm-pack-action@v0.4.0

      - name: Build WASM tokenizer
        run: npm run build:wasm
      # ---- End WASM ----

      - name: Install dependencies
        run: npm ci

      - name: Lint
        run: npm run lint --if-present

      - name: Build extension
        run: npm run package

      - name: Run tests
        run: xvfb-run -a npm test

      - name: Package VSIX
        run: npx @vscode/vsce package

      - name: Verify VSIX contains WASM assets
        run: |
          echo "=== VSIX binary assets ==="
          unzip -l *.vsix | grep -E '\.(wasm|node|br)$'

      - uses: actions/upload-artifact@v4
        with:
          name: deepseek-moby-vsix
          path: '*.vsix'
          retention-days: 30

  publish:
    needs: build
    runs-on: ubuntu-latest
    if: startsWith(github.ref, 'refs/tags/v')
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: deepseek-moby-vsix

      - name: Publish to Marketplace
        run: npx @vscode/vsce publish --packagePath *.vsix
        env:
          VSCE_PAT: ${{ secrets.VSCE_PAT }}
```

### Key Design Decisions

- **Single Ubuntu runner** -- WASM is universal, sqlcipher prebuilds cover all 6 platforms. No matrix needed.
- **`jetli/wasm-pack-action`** -- Downloads pre-built wasm-pack binary (~2 seconds vs ~3 minutes for `cargo install`).
- **WASM built BEFORE `npm ci`** -- The `file:packages/moby-wasm/pkg` dependency requires `pkg/` to exist before npm can resolve it.
- **Verify step** -- `unzip -l *.vsix | grep wasm` catches the mistake of forgetting to include WASM/vocab in the VSIX.
- **`pkg/` is NOT committed** -- Both CI and local dev build WASM from source. Ensures the Rust build pipeline is always tested.

### SQLCipher: No Special Handling Needed

`@signalapp/sqlcipher` ships all 6 platform prebuilds inside its npm package. `npm ci` on any platform pulls all prebuilds. At runtime, `node-gyp-build` selects the correct `.node` binary. End users install the VSIX and everything just works -- no compilers, no system SQLite, no Rust.

---

## Implementation Order

1. **Phase 1: Interface + Estimation** ✅ -- Built `TokenCounter` interface, `EstimationTokenCounter` (char × 0.3 ratio, self-calibrating rolling average of 20 samples), and `ContextBuilder` (fills from newest messages backward, injects snapshot summary when truncating). All synchronous — no async methods on the interface. Wired into `DeepSeekClient`.

2. **Phase 2: WASM Crate** ✅ -- Set up `packages/moby-wasm/` with Rust crate using `tokenizers` v0.21 (`unstable_wasm` feature). `lib.rs` exposes `DeepSeekTokenizer` with `count_tokens()`, `encode()`, `decode()`, `vocab_size()`, `free()`. Brotli-11 compressed vocab: 7.48 MB → 1.33 MB. Build: `wasm-pack build --target nodejs --release`.

3. **Phase 3: TokenService** ✅ -- Singleton wrapping the WASM module. Eager init during extension activation (not lazy). Implements `TokenCounter` interface. If WASM fails, extension falls back to `EstimationTokenCounter`. Init: ~433 ms measured. `isReady` / `isExact` flags for runtime detection.

4. **Phase 4: Webpack + VSIX** ✅ -- Webpack externals use a function to resolve `deepseek-moby-wasm` to `commonjs ./wasm/deepseek_moby_wasm.js`. CopyPlugin copies WASM binary, JS glue, and compressed vocab to `dist/`. `.vscodeignore` excludes `packages/**` (everything needed is in dist/). VSIX verified: 3.9 MB compressed, 9.5 MB uncompressed.

5. **Phase 5: Cross-Validation** ✅ -- `crossValidateTokens()` in `DeepSeekClient` runs after every `chat()` and `streamChat()` call. Uses `countRequestTokens()` helper that counts everything the API counts: system prompt, message content, tool call metadata (function name, arguments, overhead), tool_call_id linkage, and tool definitions (JSON.stringify). Logs `[TokenCV]` with delta percentage. Auto-calibrates `EstimationTokenCounter` when WASM isn't available.

### Measured Cross-Validation Results

| Model | Scenario | Delta Range | Notes |
|-------|----------|-------------|-------|
| deepseek-reasoner | No tools | -0.6% to -0.8% | Near-perfect accuracy |
| deepseek-chat | No tools | +3.1% | Small fixed overhead |
| deepseek-chat | Tool-calling (early) | +13-16% | API's hidden tool preamble |
| deepseek-chat | Tool-calling (steady) | +3.5-4.9% | Stabilizes as context grows |

The remaining ~300 token fixed overhead in tool-calling mode is the API's internal tool-use instruction preamble — invisible to us, but counted in `usage.prompt_tokens`. This consistently undercounts (safe for budgeting).

## Resolved Open Questions

| Question | Decision | Rationale |
|----------|----------|-----------|
| Q1: Warm-up | **Eager** | Init during `activate()`, not lazy. 433ms is acceptable at startup. |
| Q2: System + tools | **Count precisely** | `countRequestTokens()` counts everything including tools. |
| Q3: Cross-validation | **Yes, always** | `[TokenCV]` logs on every request. Data-driven overhead tuning. |
| Q4: Worker thread | **No** | Operations are sub-millisecond. Not worth the complexity. |
| Q5: Commit pkg/ | **No** | `pkg/` is gitignored. Developer builds locally. CI builds fresh. |
