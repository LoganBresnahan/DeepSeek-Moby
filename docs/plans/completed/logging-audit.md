# Logging & Tracing Audit

Full audit of all logging and tracing across the extension. Includes both the initial findings and the fixes applied.

---

## Architecture Overview

Three-tier system, two runtimes:

| Tier | Runtime | Mechanism | Buffer | Sync |
|------|---------|-----------|--------|------|
| 1 - Extension Logger | Node.js | `logger.info/debug/warn/error` | 5,000 ring buffer | Immediate (output channel) |
| 2 - TraceCollector | Node.js | `tracer.trace/startSpan/endSpan` | 10,000 ring buffer | Immediate (in-memory) |
| 3a - WebviewTracer | Browser | `WebviewTracer.trace` | 500 ring buffer | Batch every 5s via postMessage |
| 3b - WebviewLogBuffer | Browser | `createLogger('Name')` | 5,000 ring buffer | Batch every 5s (offset 2.5s) |

**UnifiedLogExporter** merges all tiers. Two export commands:
- **Export Logs (AI)** — LLM-optimized, compact
- **Export Logs (Full)** — Human-readable, full detail

---

## Inconsistencies Found & Fixes Applied

### 1. Debug Level Underused on Extension Side (FIXED)

**Before:** Only 17 of 309 extension logger calls (5.5%) used `debug`. Routine per-item flow was logged at `info`, making exported logs noisy.

**Fix:** Downgraded ~65 routine `logger.info` calls to `logger.debug` across `diffManager.ts` and `fileContextManager.ts`. Kept lifecycle boundaries (mode change, accept/reject, search complete, context injection summary) at `info`.

**After:** ~92 `debug` calls vs ~160 `info` calls (30% debug). Much better signal-to-noise in default log exports.

### 2. Trace Category Bloat (FIXED)

**Before:** 27 categories defined in `TraceCategory`, only 10 used (37%). 17 categories were speculative.

**Fix:** Pruned to 14 extension-side categories and 10 webview-side categories. Removed: `user.selection`, `tool.result`, `shell.result`, `state.subscribe` (ext), `actor.*` (ext), `bridge.*` (ext), `render.*`, `session.load`, `webview.dispose`, `file.read`, `file.write`, `file.diff`. Added `file.context` for the new fileContextManager traces. Kept `user.input` (heavily used in test suite as generic test category).

**After:** 14 extension categories, 10 webview categories. All actively used or have existing convenience methods.

### 3. DiffManager Disproportionately Verbose (FIXED)

**Before:** 80 logger calls, most at `info` level. Routine tab operations, overlay debug counters, and per-file focus logs all at `info`.

**Fix:** Downgraded ~40 routine logs to `debug`:
- Tab open/close/focus operations
- Overlay debug counters (`closingDiffsInProgress`)
- File creation/superseded markers
- Debounce timer lifecycle
- Buffer flush notifications
- QuickPick accept/reject
- File resolver strategy steps

Kept at `info`: `setEditMode`, `acceptSpecificDiff`, `rejectSpecificDiff`, `acceptAll`/`rejectAll`, `auto-apply` summary, `handleAutoShowDiff` lifecycle start/end.

### 4. No Webview Tracing for UI Events (FIXED)

**Before:** Zero `webviewTracer.trace()` calls in actors. The webview only logged, never traced.

**Fix:** Added targeted traces (not per-event flood):
- `VirtualMessageGatewayActor`: `bridge.receive` trace for 5 lifecycle message types (startResponse, endResponse, toolCallsStart, toolCallsEnd, iterationStart). Streaming tokens excluded.
- `CommandsShadowActor`: `user.click` trace on command execution with commandId data.
- `CommandRulesModalActor`: `user.click` traces for add/delete/reset rule actions.

**After:** 5 `webviewTracer.trace()` calls across 3 files. Low-frequency, high-value events only.

### 5. fileContextManager Has No Trace Events (FIXED)

**Before:** 43 logger calls, 0 tracer calls. File context operations produced no structured trace data.

**Fix:** Added `tracer` import and 4 trace events using new `file.context` category:
- `sendOpenFiles`: file count + tab count
- `fileSearch`: query + result count
- `setSelectedFiles`: file count + paths
- `injectContext`: file count + total chars + paths (most valuable — shows what context the AI received)

---

## Current State (Post-Fix)

### Extension-Side Logger (~307 calls)

| Level | Count | Usage |
|-------|-------|-------|
| `logger.info` | ~160 | Lifecycle boundaries, state changes |
| `logger.debug` | ~92 | Routine per-item flow, internal state |
| `logger.warn` | ~26 | Recoverable anomalies, fallbacks |
| `logger.error` | ~29 | Failures, caught exceptions |
| Specialized | 4 | `apiRequest`, `apiResponse`, `toolCall`, `webSearchRequest` |

### Extension-Side Tracer (~33 calls across 6 files)

| File | Categories Used |
|------|-----------------|
| `utils/logger.ts` | api.request, api.response, api.stream, tool.call, shell.execute |
| `webSearchManager.ts` | api.request, state.publish |
| `requestOrchestrator.ts` | command.check, session.create, session.switch |
| `commandApprovalManager.ts` | command.check, command.approval |
| `chatProvider.ts` | webview.resolve, webview.visible |
| `fileContextManager.ts` | file.context |

### Webview-Side Logger (88 calls across 15 files)

| Level | Count |
|-------|-------|
| `log.debug` | 58 |
| `log.warn` | 20 |
| `log.info` | 6 |
| `log.error` | 4 |

### Webview-Side Tracer (5 calls across 3 files)

| File | Categories Used |
|------|-----------------|
| `VirtualMessageGatewayActor.ts` | bridge.receive |
| `CommandsShadowActor.ts` | user.click |
| `CommandRulesModalActor.ts` | user.click |

### Trace Category Coverage

| Side | Defined | Used | Coverage |
|------|---------|------|----------|
| Extension | 14 | 13 | 93% |
| Webview | 10 | 4 | 40% |

Extension unused: `user.input` (kept for test suite compatibility).
Webview unused: `state.subscribe`, `actor.create`, `actor.destroy`, `actor.bind`, `actor.unbind`, `bridge.send` (convenience methods exist in WebviewTracer, ready for future use).

---

## Strategy Principles (Established)

### 1. Log at the Owner, Not the Router
The ChatProvider message router is a silent pass-through. Each manager logs its own operations.

### 2. Use `debug` for Per-Item Flow, `info` for Lifecycle Boundaries
- `debug`: Each file added to context, each rule checked, each diff hunk parsed, tab open/close
- `info`: Request started, session created, approval gate entered, search completed, mode changed
- `warn`: Fallback used, unexpected state recovered from
- `error`: Operation failed, exception caught

### 3. Trace Events for Cross-System Correlation, Not Local Debugging
Traces capture events that correlate across components: API request -> tool call -> shell execute -> approval -> file context injection -> response.

### 4. High-Frequency Events: Batch or Sample
Any event >10 per second must be batched or sampled. Examples: streaming tokens (1-in-10), scroll (delta-only), gateway message routing (lifecycle types only, not streaming tokens).

### 5. Specialized Methods for Dual-Emit Events
`logger.apiRequest()` etc. produce both human log and structured trace. Extend this pattern for new high-value events.

---

## Summary

| Metric | Before | After |
|--------|--------|-------|
| Extension logger calls | 309 | ~307 |
| Extension debug % | 5.5% | ~30% |
| Extension tracer calls | 29 | ~33 |
| Webview logger calls | 88 | 88 |
| Webview tracer calls | 0 | 5 |
| Extension trace categories | 27 (10 used) | 14 (13 used) |
| Webview trace categories | 14 (0 used) | 10 (4 used) |
| Tests | 1,628 pass | 1,628 pass |
