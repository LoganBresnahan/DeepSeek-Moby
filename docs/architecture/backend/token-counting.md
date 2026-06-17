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

`TokenService` is **multi-vocab**: the shared WASM binary (BPE logic) is loaded once, and per-model vocabularies are loaded on demand keyed by model family — `deepseek-v3` (V3 chat + R1 reasoner) and `deepseek-v4` (V4 thinking models). V4 shares V3's BPE base but adds ~465 new special tokens, so V4 entries select the `deepseek-v4` vocab for exact counts on those tokens. Models whose registry entry declares no `tokenizer` (custom/local models) fall back to estimation.

**Why WASM:**
- Each loaded vocab's data (~128K vocab, ~127K merge rules) lives in WASM linear memory — outside V8's GC heap and 4 GB limit
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
|  1. Read <vocab>.json.br (~1.4 MB) from disk     |
|  2. Brotli decompress -> ~7.8 MB JSON string     |
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
|  in model window?   |    |  vs API prompt_tokens  |
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

Three implementations:

| Implementation | `isExact` | Used When |
|----------------|-----------|-----------|
| `TokenService` | `true` | WASM loaded and the active model declares a `tokenizer` vocab |
| `EstimationTokenCounter` | `false` | WASM failed to load, custom model with no `tokenizer`, or unit tests |
| `DynamicTokenCounter` | delegates | The top-level counter `DeepSeekClient` injects — dispatches per-call to WASM or estimation based on the active model |

`DynamicTokenCounter` is what `DeepSeekClient` actually constructs and passes into `ContextBuilder` and `countRequestTokens()`. On each call it calls `getActive()`: if the active model's registry entry declares a `tokenizer` **and** a WASM counter is available, it delegates to the exact `TokenService`; otherwise it delegates to the shared `EstimationTokenCounter`. Its `isExact` reflects whichever it currently resolves to.

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

// Switch the active vocab to match the restored model (initialize() only
// loaded the default deepseek-v3 vocab).
if (useWasm) { await tokenService.selectModel(deepSeekClient.getModel()); }
```

### Init Steps

1. Dynamic `import('deepseek-moby-wasm')` — loads the WASM JS glue (once, shared across all vocabs)
2. Read `<vocabName>.json.br` (e.g. `deepseek-v3.json.br`, ~1.4 MB) from `dist/assets/vocabs/` (prod) or `packages/moby-wasm/assets/vocabs/` (dev fallback). The single-file `tokenizer.json.br` is a legacy fallback path used only for the default (`deepseek-v3`) vocab.
3. `zlib.brotliDecompressSync()` — Node.js built-in, zero dependencies
4. Pass JSON string to `DeepSeekTokenizer` constructor — Rust parses into WASM linear memory
5. Total: ~433 ms measured per vocab

`initialize()` loads only the default vocab (`deepseek-v3`). `selectModel(modelId)` lazily loads and switches the active vocab when the model changes — looking up the vocab name via `getCapabilities(modelId).tokenizer`, returning `false` (caller should use estimation) when the model declares none.

### API

| Method | Description |
|--------|-------------|
| `count(text)` | Exact token count for the active vocab via WASM BPE. Throws if not initialized. |
| `countMessage(role, content)` | `count(content)` + role overhead (4 or 8 tokens) |
| `selectModel(modelId)` | Switch/lazy-load the active vocab for a model; returns `false` if the model declares no `tokenizer` |
| `encode(text)` | Returns `Uint32Array` of token IDs |
| `decode(ids)` | Token IDs back to text |
| `activeVocabName` / `loadedVocabs` | Current active vocab name / list of loaded vocab names |
| `vocabSize` | Vocab size of the **active** tokenizer (128,000 for the V3 vocab) |
| `isReady` | Whether the active vocab's tokenizer is loaded |
| `dispose()` | Calls `tokenizer.free()` on every loaded vocab to release WASM memory |

### Graceful Degradation

If WASM fails to load (missing binary, unsupported platform, etc.), the extension falls back to `EstimationTokenCounter`. The client checks `tokenService.isReady` and passes either the WASM service or `undefined` (which triggers estimation mode internally).

Even when WASM loads fine, `DynamicTokenCounter` routes any model whose registry entry declares no `tokenizer` (custom/local models — Qwen, Llama, LM Studio, Ollama, etc.) to `EstimationTokenCounter` on a per-call basis. So estimation is a normal-operation path, not only a hard-failure fallback.

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

The calibration is driven by `crossValidateTokens()` in DeepSeekClient — it passes the total request character count and the API's reported token count. It runs **after every API response unconditionally**, feeding the shared `EstimationTokenCounter` even when the active model is on the WASM path — so if the user later switches to an estimation-only custom model, its counter already has real calibration samples instead of the default ratio.

### When It's Used

- **Custom / local models**: Any model whose registry entry declares no `tokenizer` (Qwen, Llama, LM Studio, Ollama, etc.) uses estimation in normal operation — `DynamicTokenCounter` routes to it, and it auto-calibrates from `usage.prompt_tokens`
- **WASM failure fallback**: If the WASM binary fails to load at activation
- **Unit tests**: No WASM needed in vitest — tests use `EstimationTokenCounter` directly

---

## countRequestTokens

Counts tokens for an entire API request — not just message content, but everything the API counts. Defined in [src/services/tokenCounter.ts](../../../src/services/tokenCounter.ts).

```typescript
export function countRequestTokens(
  counter: TokenCounter,
  // Relaxed to Record<string, unknown> so serializer additions (e.g.
  // reasoning_content for V4-thinking) don't churn the signature; only
  // role/content/tool_calls/tool_call_id are read.
  requestMessages: Array<Record<string, unknown>>,
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
3. Logs `[TokenCV]` with the delta and percentage (tagged `[WASM]` or `[estimation]` per the active counter)
4. Always calibrates the shared `EstimationTokenCounter` via `calibrate()` — regardless of whether WASM or estimation is currently active

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

Budget management for the model's context window (128K for V3, 1M for V4). Defined in [src/context/contextBuilder.ts](../../../src/context/contextBuilder.ts). The window and output reserve come from `getCapabilities(model)`, so the budget can't drift from the model's real capabilities; `FALLBACK_CONTEXT_WINDOW = 128_000` is used only when a model (e.g. a custom entry) declares no window.

### Strategy

1. Count system prompt tokens (fixed cost)
2. Calculate available budget: `(totalContext - outputReserve) × safetyMultiplier - systemTokens`, where `totalContext = caps.contextWindow ?? 128_000` and `outputReserve = caps.maxOutputTokens`
3. Fill from **newest messages backward** until budget exhausted
4. If oldest messages were dropped and a snapshot summary exists, inject it

### Model Budgets

`Max Output` below is `maxOutputTokens` (the registry default sent as `max_tokens` and used as the budget's output reserve). V4 models also expose a higher slider cap of 384,000 via `maxOutputTokensCap`. `deepseek-v4-pro-thinking` is the `DEFAULT_MODEL_ID`.

| Model | Total Context | Max Output | Available for Input |
|-------|--------------|------------|-------------------|
| deepseek-chat | 128,000 | 8,192 | ~119,808 |
| deepseek-reasoner | 128,000 | 65,536 | ~62,464 |
| deepseek-v4-flash-thinking | 1,048,576 | 65,536 | ~983,040 |
| deepseek-v4-pro-thinking | 1,048,576 | 65,536 | ~983,040 |

### Safety Margin

When using estimation (`isExact = false`), applies a 10% safety margin to avoid overflowing the context window. WASM counts don't need this.

### Token Count Cache

ContextBuilder maintains an in-memory `Map<string, number>` that caches token counts keyed by stable IDs. This avoids re-tokenizing unchanged content on each `build()` call. Two types of content are cached:

**Event messages** — keyed by `eventId` (from the event store):
- Messages with an `eventId` field are eligible for caching
- On first encounter, the message is tokenized and the count is stored: `eventId → tokenCount`
- On subsequent `build()` calls, cached messages skip the `countMessage()` call entirely
- Messages without `eventId` (e.g., tool messages created during the current request) are always tokenized fresh

**Snapshot summaries** — keyed by `snapshotId`:
- `getLatestSnapshotSummary()` returns a `SnapshotSummary` object containing the summary text, a pre-computed `tokenCount`, and the `snapshotId`
- On first encounter, the pre-computed count from the snapshot is stored in the cache
- On subsequent requests (same snapshot), the cached count is used directly — no tokenization at all
- When a new snapshot is created (different `snapshotId`), it gets its own cache entry

**Why in-memory (not DB):**
- Cache dies on extension restart — no staleness risk if the tokenizer changes
- No migration needed — just a `Map` on the class instance
- Both event IDs and snapshot IDs are immutable — content never changes for a given ID

**Logging:** `logger.debug('[Context] Token cache: X hits, Y misses')` when cache hits occur.

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

- **Trigger:** `src/providers/requestOrchestrator.ts` — the `[Snapshot] Proactive trigger` block (around lines 930-958)
- **ContextBuilder:** `src/context/contextBuilder.ts`

---

## Memory & Performance

### Memory

| Component | JS Heap | WASM / External |
|-----------|---------|-----------------|
| TokenService wrapper + glue | ~0.5 MB | — |
| WASM linear memory (vocab + merges) | — | ~20-25 MB per loaded vocab |
| Temporary: JSON string during init | ~7.8 MB (freed) | — |
| **Steady state** | **~0.5 MB** | **~20-25 MB per loaded vocab** |

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
| `assets/vocabs/deepseek-v3.json.br` | ~1.40 MB |
| `assets/vocabs/deepseek-v4.json.br` | ~1.37 MB |
| **Total VSIX** | **~5.3 MB compressed** |

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
2. `brotli -q 11 -o assets/vocabs/<vocab>.json.br tokenizer.json` (e.g. `deepseek-v4.json.br`)
3. Drop it under `packages/moby-wasm/assets/vocabs/` (webpack copies the whole `vocabs/` dir to `dist/assets/vocabs/`)
4. Point the model's registry `tokenizer` field at the new vocab name
5. No Rust code changes needed — same HuggingFace JSON format, shared BPE binary

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
| [packages/moby-wasm/assets/vocabs/](../../../packages/moby-wasm/assets/vocabs/) | Per-model Brotli-compressed vocabs: `deepseek-v3.json.br` (~1.40 MB), `deepseek-v4.json.br` (~1.37 MB) |
| [webpack.config.js](../../../webpack.config.js) | CopyPlugin + function external for WASM |
| [tests/unit/services/tokenCounter.test.ts](../../../tests/unit/services/tokenCounter.test.ts) | EstimationTokenCounter + countRequestTokens tests |
| [tests/unit/services/tokenService.test.ts](../../../tests/unit/services/tokenService.test.ts) | TokenService tests (WASM mocked) |
| [tests/unit/context/contextBuilder.test.ts](../../../tests/unit/context/contextBuilder.test.ts) | ContextBuilder budget tests |

---

## Related Documentation

- [Tokenizer Plan](../../plans/completed/tokenizer.md) — Original implementation plan with design rationale
- [Chat Streaming](../integration/chat-streaming.md) — Request lifecycle where cross-validation runs
- [Backend Architecture](backend-architecture.md) — ChatProvider orchestrator
