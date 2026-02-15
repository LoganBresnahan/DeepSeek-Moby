# Token Counting Architecture

Exact token counting for context window management using DeepSeek's native tokenizer compiled to WebAssembly.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture Diagram](#architecture-diagram)
3. [TokenCounter Interface](#tokencounter-interface)
4. [TokenService (WASM)](#tokenservice-wasm)
5. [EstimationTokenCounter (Fallback)](#estimationtokencounter-fallback)
6. [countRequestTokens](#countrequesttokens)
7. [Cross-Validation](#cross-validation)
8. [ContextBuilder](#contextbuilder)
9. [Memory & Performance](#memory--performance)
10. [WASM Build Pipeline](#wasm-build-pipeline)
11. [Key Files](#key-files)

---

## Overview

DeepSeek uses a custom Byte-level BPE tokenizer with a 128K vocabulary — completely different from OpenAI's cl100k_base. We compile DeepSeek's tokenizer to WebAssembly via the HuggingFace `tokenizers` Rust crate, giving us exact token counts with minimal JS heap impact.

**Why WASM:**
- Tokenizer data (128K vocab, 127K merge rules) lives in WASM linear memory — outside V8's GC heap and 4 GB limit
- < 2 MB JS heap cost for wrapper objects
- 3-5x faster encoding than pure JS BPE implementations
- Exact counts vs the +/-10-20% accuracy of character-based estimation

---

## Architecture Diagram

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
        |                             |
        v                             v
+---------------------+    +------------------------+
|  ContextBuilder     |    |  DeepSeekClient        |
|                     |    |                        |
|  Budget management: |    |  Cross-validation:     |
|  Which messages fit |    |  countRequestTokens()  |
|  in 128K context?   |    |  vs API prompt_tokens  |
+---------------------+    +------------------------+
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

## TokenCounter Interface

The abstraction that all consumers depend on. Defined in [src/services/tokenCounter.ts](../../../src/services/tokenCounter.ts).

```typescript
export interface TokenCounter {
  count(text: string): number;
  countMessage(role: string, content: string): number;
  readonly isExact: boolean;
}
```

**Design decisions:**
- All methods are **synchronous** — the WASM tokenizer is initialized eagerly at activation, so no async needed at call sites
- `countMessage()` adds per-message overhead: 4 tokens for regular roles, 8 tokens for system
- `isExact` distinguishes WASM (exact) from estimation (approximate) — used by `ContextBuilder` to apply a safety margin

Two implementations:

| Implementation | `isExact` | Used When |
|----------------|-----------|-----------|
| `TokenService` | `true` | WASM loaded successfully (normal operation) |
| `EstimationTokenCounter` | `false` | WASM failed to load, or in unit tests |

---

## TokenService (WASM)

Singleton service wrapping the WASM tokenizer. Defined in [src/services/tokenService.ts](../../../src/services/tokenService.ts).

### Initialization

Called eagerly during extension activation in [src/extension.ts](../../../src/extension.ts):

```typescript
const tokenService = TokenService.getInstance(context.extensionPath);
try {
  await tokenService.initialize();
} catch { /* falls back to estimation */ }

const useWasm = tokenService.isReady;
deepSeekClient = new DeepSeekClient(context, useWasm ? tokenService : undefined);
```

### Init Steps

1. Dynamic `import('deepseek-moby-wasm')` — loads the WASM JS glue
2. Read `tokenizer.json.br` (1.3 MB) from dist/assets/ or packages/ (dev fallback)
3. `zlib.brotliDecompressSync()` — Node.js built-in, zero dependencies
4. Pass JSON string to `DeepSeekTokenizer` constructor — Rust parses into WASM linear memory
5. Total: ~433 ms measured

### API

| Method | Description |
|--------|-------------|
| `count(text)` | Exact token count via WASM BPE. Throws if not initialized. |
| `countMessage(role, content)` | `count(content)` + role overhead (4 or 8 tokens) |
| `encode(text)` | Returns `Uint32Array` of token IDs |
| `decode(ids)` | Token IDs back to text |
| `vocabSize` | 128,000 for DeepSeek V3 |
| `isReady` | Whether WASM is loaded |
| `dispose()` | Calls `tokenizer.free()` to release WASM memory |

### Graceful Degradation

If WASM fails to load (missing binary, unsupported platform, etc.), the extension falls back to `EstimationTokenCounter`. The client checks `tokenService.isReady` and passes either the WASM service or `undefined` (which triggers estimation mode internally).

---

## EstimationTokenCounter (Fallback)

Character-based estimation with API calibration. Defined in [src/services/tokenCounter.ts](../../../src/services/tokenCounter.ts).

### How It Works

- Default ratio: `0.3` tokens per character (DeepSeek's byte-level BPE averages higher than OpenAI's ~0.25)
- Self-calibrates against `usage.prompt_tokens` from API responses
- Rolling average of last 20 samples converges to +/-5% accuracy within 5-10 messages

### Calibration

```typescript
// Called after every API response with usage data
counter.calibrate(charCount, apiPromptTokens);
// Updates rolling average: ratio = actualTokens / charCount
```

The calibration is driven by `crossValidateTokens()` in DeepSeekClient — it passes the total request character count and the API's reported token count.

### When It's Used

- **Unit tests**: No WASM needed in vitest — tests use `EstimationTokenCounter` directly
- **WASM failure fallback**: If the WASM binary fails to load at activation
- **Never in normal operation**: The extension always tries WASM first

---

## countRequestTokens

Counts tokens for an entire API request — not just message content, but everything the API counts. Defined in [src/services/tokenCounter.ts](../../../src/services/tokenCounter.ts).

```typescript
export function countRequestTokens(
  counter: TokenCounter,
  requestMessages: Array<{ role; content; tool_calls?; tool_call_id? }>,
  systemPrompt?: string,
  tools?: Array<{ type; function: { name; description; parameters } }>
): number
```

### What It Counts

| Component | How |
|-----------|-----|
| System prompt | `countMessage('system', systemPrompt)` |
| Message content | `countMessage(role, text)` per message |
| Multipart content | Extracts text parts, replaces images with `[image]` |
| Tool call function names | `count(tc.function.name)` |
| Tool call arguments | `count(tc.function.arguments)` |
| Tool call overhead | `+8` tokens per tool call (id, type, wrapper) |
| Tool result linkage | `count(msg.tool_call_id)` |
| Tool definitions | `count(JSON.stringify(tools))` |

### Why This Exists

Early cross-validation showed growing deltas (+12% after 8 tool iterations) because we only counted `msg.content` text. The API counts everything — tool definitions, function call metadata, tool_call_ids. This function closes that gap.

---

## Cross-Validation

The `crossValidateTokens()` method in [src/deepseekClient.ts](../../../src/deepseekClient.ts) runs after every `chat()` and `streamChat()` call.

### What It Does

1. Calls `countRequestTokens()` to count everything we sent
2. Compares against `usage.prompt_tokens` from the API response
3. Logs `[TokenCV]` with the delta and percentage
4. If using estimation, calibrates the ratio via `calibrate()`

### Log Format

```
[TokenCV] ours=1,288 api=1,280 delta=-8 (-0.6%) [WASM]
[TokenCV] ours=8,357 api=8,722 delta=+365 (4.2%) [WASM]
```

### Important: System Prompt Handling

The system prompt is unshifted into `requestMessages` before the API call. `crossValidateTokens` passes `undefined` as the systemPrompt parameter to `countRequestTokens` — the system message is counted via the messages loop, not separately. This avoids double-counting.

### Measured Accuracy

| Model | Scenario | Delta |
|-------|----------|-------|
| deepseek-reasoner | No tools | < 1% |
| deepseek-chat | No tools | ~3% |
| deepseek-chat | With tools | 3.5-5% (steady state) |

The remaining gap in tool-calling mode is the API's hidden tool-use instruction preamble (~300 tokens) — text we never send but the API adds internally. This consistently undercounts, which is safe for context budgeting.

---

## ContextBuilder

Budget management for the 128K context window. Defined in [src/context/contextBuilder.ts](../../../src/context/contextBuilder.ts).

### Strategy

1. Count system prompt tokens (fixed cost)
2. Calculate available budget: `(totalContext - maxOutputTokens) × safetyMultiplier - systemTokens`
3. Fill from **newest messages backward** until budget exhausted
4. If oldest messages were dropped and a snapshot summary exists, inject it

### Model Budgets

| Model | Total Context | Max Output | Available for Input |
|-------|--------------|------------|-------------------|
| deepseek-chat | 128,000 | 8,192 | ~119,808 |
| deepseek-reasoner | 128,000 | 16,384 | ~111,616 |

### Safety Margin

When using estimation (`isExact = false`), applies a 10% safety margin to avoid overflowing the context window. WASM counts don't need this.

### Snapshot Summary Injection

When messages are dropped, injects a synthetic user/assistant exchange at the start:
- User: `[Previous conversation context]\n{snapshotSummary}`
- Assistant: `I understand the context from our earlier conversation. Continuing from where we left off.`

### Proactive Context Compression

ContextBuilder's `build()` returns a `contextResult` that includes `tokenCount` and `budget`. After each response, `RequestOrchestrator` uses this ratio to decide whether to proactively summarize:

```
ContextBuilder.build() → contextResult { tokenCount, budget }
         │
         └─► usageRatio = tokenCount / budget
             │
             └─► > 80% → trigger createSnapshot() (LLM summarizer)
                          so the snapshot is ready BEFORE the next
                          request needs ContextBuilder to drop messages
```

This means snapshot summaries are pre-computed and available when ContextBuilder needs them, avoiding on-the-fly summarization during request handling.

- **Trigger:** `src/providers/requestOrchestrator.ts` (lines 334-361)
- **ContextBuilder:** `src/context/contextBuilder.ts`

---

## Memory & Performance

### Memory

| Component | JS Heap | WASM / External |
|-----------|---------|-----------------|
| TokenService wrapper + glue | ~0.5 MB | — |
| WASM linear memory (vocab + merges) | — | ~20-25 MB |
| Temporary: JSON string during init | ~7.5 MB (freed) | — |
| **Steady state** | **~0.5 MB** | **~20-25 MB** |

### Performance

| Operation | Time |
|-----------|------|
| Cold start (read .br + decompress + WASM init) | ~433 ms |
| `count()` — short text (< 100 chars) | ~0.01-0.02 ms |
| `count()` — paragraph (~500 chars) | ~0.02-0.05 ms |
| `countRequestTokens()` — full request | < 1 ms |
| `ContextBuilder.build()` — 100 messages | ~5-10 ms |

### VSIX Size

| File | Size |
|------|------|
| `deepseek_moby_wasm_bg.wasm` | ~1.5 MB |
| `deepseek_moby_wasm.js` (glue) | ~3 KB |
| `tokenizer.json.br` | 1.33 MB |
| **Total VSIX** | **~3.9 MB compressed** |

---

## WASM Build Pipeline

### Prerequisites

```bash
# Rust toolchain + wasm-pack (one-time)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
```

### Build

```bash
# Build WASM (must run BEFORE npm ci)
npm run build:wasm    # cd packages/moby-wasm && wasm-pack build --target nodejs --release

# Then install deps (pkg/ must exist for file: dependency)
npm ci

# Build extension
npx webpack
```

### Webpack Integration

The `file:packages/moby-wasm/pkg` dependency creates a symlink in `node_modules`. Since `vsce` can't follow symlinks, webpack's CopyPlugin copies WASM files to `dist/wasm/` and a function external resolves the import to a relative path:

```javascript
externals: [
  ({ request }, callback) => {
    if (request === 'deepseek-moby-wasm') {
      return callback(null, 'commonjs ./wasm/deepseek_moby_wasm.js');
    }
    callback();
  }
]
```

### Updating the Tokenizer

When DeepSeek releases a new model with a different vocabulary:

1. Download the new `tokenizer.json` from HuggingFace
2. `brotli -q 11 -o assets/tokenizer.json.br assets/tokenizer.json`
3. Replace `packages/moby-wasm/assets/tokenizer.json.br`
4. No Rust code changes needed — same HuggingFace JSON format

---

## Key Files

| File | Description |
|------|-------------|
| [src/services/tokenCounter.ts](../../../src/services/tokenCounter.ts) | `TokenCounter` interface, `EstimationTokenCounter`, `countRequestTokens()` |
| [src/services/tokenService.ts](../../../src/services/tokenService.ts) | `TokenService` singleton — WASM wrapper |
| [src/context/contextBuilder.ts](../../../src/context/contextBuilder.ts) | `ContextBuilder` — budget management |
| [src/deepseekClient.ts](../../../src/deepseekClient.ts) | `crossValidateTokens()` — runtime accuracy logging |
| [src/extension.ts](../../../src/extension.ts) | WASM init + fallback logic at activation |
| [packages/moby-wasm/src/lib.rs](../../../packages/moby-wasm/src/lib.rs) | Rust WASM glue (~50 lines) |
| [packages/moby-wasm/assets/tokenizer.json.br](../../../packages/moby-wasm/assets/) | Brotli-compressed vocabulary (1.33 MB) |
| [webpack.config.js](../../../webpack.config.js) | CopyPlugin + function external for WASM |
| [tests/unit/services/tokenCounter.test.ts](../../../tests/unit/services/tokenCounter.test.ts) | EstimationTokenCounter + countRequestTokens tests |
| [tests/unit/services/tokenService.test.ts](../../../tests/unit/services/tokenService.test.ts) | TokenService tests (WASM mocked) |
| [tests/unit/context/contextBuilder.test.ts](../../../tests/unit/context/contextBuilder.test.ts) | ContextBuilder budget tests |

---

## Related Documentation

- [Tokenizer Plan](../../plans/tokenizer.md) — Original implementation plan with design rationale
- [Chat Streaming](../integration/chat-streaming.md) — Request lifecycle where cross-validation runs
- [Backend Architecture](backend-architecture.md) — ChatProvider orchestrator
