# Logging System Architecture

This document provides a comprehensive audit of the logging infrastructure and defines the logging strategy for the DeepSeek Moby extension.

---

## System Overview

We have **three logging pieces** spanning two runtime environments:

| Piece | Environment | Output | File |
|--------|-------------|--------|------|
| **Extension Logger** | VS Code Extension (Node.js) | VS Code Output Channel | `src/utils/logger.ts` |
| **Shared webview logging** | Webview (Browser) | Browser Console + buffer synced to extension | `media/logging/` (`logLevel.ts`, `createLogger.ts`, `WebviewLogBuffer.ts`) |
| **EventState Logger** | Webview (Browser) | Browser Console | `media/state/EventStateLogger.ts` |

The Extension Logger also integrates the tracing system (`src/tracing/`) for span timing and correlation IDs. The webview's `media/logging/` module owns the global log level and a `createLogger()` component-logger factory; `EventStateLogger` delegates its level control to that shared module.

---

## 1. Extension Logger (`src/utils/logger.ts`)

### Purpose
Logs all extension-side activity to VS Code's Output panel ("DeepSeek Moby" channel).

### Log Levels

```typescript
type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'OFF';
```

| Level | Priority | Use Case |
|-------|----------|----------|
| DEBUG | 0 | Verbose diagnostic info (diff matching, overlay states) |
| INFO | 1 | Normal operations (API requests, tool calls, session events) |
| WARN | 2 | Non-fatal issues (tool failures, blocked commands) |
| ERROR | 3 | Failures requiring attention (API errors, execution failures) |
| OFF | 4 | Disable all logging |

### Configuration
- Setting: `moby.logLevel` (package.json default: `WARN`; the logger falls back to `INFO` only if the setting is unset)
- Colors: Disabled (VS Code Output channels don't support ANSI)

### Specialized Methods

| Category | Method | Level | Use Case |
|----------|--------|-------|----------|
| **Session** | `sessionStart(id, title)` | INFO | New session created |
| | `sessionSwitch(id)` | INFO | User switched sessions |
| | `sessionFork(parentId, forkId, atSeq)` | INFO | Session forked at a sequence |
| | `sessionClear()` | INFO | Session cleared |
| **API** | `apiRequest(model, count, hasImages)` | INFO | Outbound API call (mints correlation ID, returns span ID) |
| | `apiResponse(tokens, _ms?)` | INFO | Response received (`_ms` arg deprecated/ignored; span timing used) |
| | `apiStreamChunk(size, type)` | DEBUG | Streaming chunk (traced, batched) |
| | `apiStreamProgress(milestone)` | INFO | Streaming milestone (first-token, thinking-start/end, content-start) |
| | `apiError(error, details)` | ERROR | API failure |
| | `apiAborted()` | INFO | User cancelled request |
| | `getCurrentApiCorrelationId()` / `getCurrentCorrelationId()` | — | Read the active request's correlation ID |
| | `setIteration(n)` / `getCurrentIteration()` | — | Track R1 multi-iteration flows |
| **Tools** | `toolCall(name)` | INFO | Tool invocation (returns span ID) |
| | `toolResult(name, success)` | INFO/WARN | Tool completion |
| **Shell** | `shellExecuting(command)` | INFO | R1 shell command started |
| | `shellResult(cmd, success, output)` | INFO/WARN | Shell completion |
| **Code** | `codeApplied(success, file)` | INFO/WARN | Code change applied |
| | `diffShown(file)` | INFO | Diff view opened |
| **Web Search** | `webSearchRequest(query, depth)` | INFO | Web search started (Tavily or SearXNG provider) |
| | `webSearchResult(count, ms)` | INFO | Search completed |
| | `webSearchCached(query)` | DEBUG | Cache hit |
| | `webSearchError(error)` | ERROR | Search failed |
| | `webSearchCacheCleared()` | INFO | Cache invalidated |
| **Settings** | `settingsChanged(setting, value)` | DEBUG | Config changed |
| | `modelChanged(model)` | INFO | Model selection changed |
| **Buffer** | `getLogBuffer()` / `clearLogBuffer()` / `logBufferSize` | — | Structured ring buffer of `LogBufferEntry` (50,000 max) for export |

### Current Usage

| File | Calls | Primary Categories |
|------|-------|-------------------|
| `src/providers/chatProvider.ts` | ~52 | All categories |
| `src/utils/diff.ts` | 30 | DEBUG - diff algorithm tracing |
| `src/tools/reasonerShellExecutor.ts` | 8 | Shell execution |
| `src/extension.ts` | ~20 | Activation, show/dispose |
| `src/deepseekClient.ts` | ~14 | API requests/errors |
| `src/events/ConversationManager.ts` | ~18 | Session lifecycle + storage |
| `src/utils/formatting.ts` | 1 | Formatter warnings |

### Test Coverage: ✅ 54 TESTS (`tests/unit/utils/logger.test.ts`)

---

## 2. EventState Logger (`media/state/EventStateLogger.ts`)

### Purpose
Logs webview-side Event State Management system activity to the browser console.

### Log Levels

```typescript
enum LogLevel {
  DEBUG = 0,  // Verbose pub/sub flow
  INFO = 1,   // Normal operations
  WARN = 2,   // Long chains, unusual patterns
  ERROR = 3,  // Failures, circular dependencies
  SILENT = 4  // Disable all
}
```

### Configuration

The log level is **global** (owned by `media/logging/logLevel.ts`, default `WARN`), not held on the `EventStateLogger` instance. The instance config (`Omit<LoggerConfig, 'logLevel'>`) carries the formatting options:

```typescript
interface LoggerConfig {
  logLevel: LogLevel;       // GLOBAL - lives in media/logging, default: WARN
  showTimestamps: boolean;  // Instance default: true
  useWallClock: boolean;    // Instance default: true (HH:MM:SS.mmm; correlates with extension logs)
  useGroups: boolean;       // Instance default: true (console.group)
  flatMode: boolean;        // Instance default: false
  logGlobalState: boolean;  // Instance default: false
}
```

### Specialized Methods

| Method | Level | Use Case |
|--------|-------|----------|
| `managerInit()` | INFO | Manager created |
| `actorRegister(id, pubs, subs)` | DEBUG | Actor registered |
| `actorUnregister(id, remaining)` | DEBUG | Actor destroyed |
| `stateChangeFlow(source, keys, depth)` | DEBUG | State published |
| `broadcastToActor(id, keys)` | DEBUG | Actor notified |
| `circularDependency(chain)` | ERROR | Infinite loop detected |
| `longChainWarning(depth, chain)` | WARN | Deep cascade |
| `subscriptionError(id, key, error)` | ERROR | Handler threw |
| `publicationError(id, key, error)` | ERROR | Getter threw |
| `unauthorizedPublication(id, keys)` | ERROR | Invalid publish |
| `publishInsideGetter(id)` | ERROR | Publish in getter |
| `showState(state, label)` | DEBUG | State table |

### Current Usage

| File | Calls |
|------|-------|
| `media/state/EventStateManager.ts` | 7 |
| `media/state/EventStateActor.ts` | 4 |

### Test Coverage: ✅ COMPREHENSIVE (37 tests, `tests/unit/state/EventStateLogger.test.ts`)

---

## 3. Console Logging Audit (Bypassing Loggers)

### Extension Side - ✅ ALL FIXED

All extension-side `console.*` calls have been migrated to use the logger:

| File | Status | Migration |
|------|--------|-----------|
| `src/deepseekClient.ts` | ✅ Fixed | `console.error` → `logger.apiError()` (0 `console.error` remain) |
| `src/extension.ts` | ✅ Fixed | `console.log` → `logger.info()` |
| `src/events/ConversationManager.ts` | ✅ Fixed | Session lifecycle + storage use proper logging |
| `src/utils/formatting.ts` | ✅ Fixed | `console.warn` → `logger.warn()` |

All extension-side `console.*` calls have been migrated to the logger. ✅

### Webview Side - Acceptable

Most webview console logging is diagnostic output for the browser DevTools:
- Actor initialization messages
- Inspector debugging
- Development mode tools

The EventStateLogger intentionally uses `console.*` methods since that's the only output available in browser context.

---

## 4. Logging Level Strategy

### When to Use Each Level

#### DEBUG
- Algorithm tracing (diff matching steps)
- State changes in EventStateManager
- Actor registration/unregistration
- Cache operations
- Overlay state tracking

#### INFO
- User-initiated actions (send message, switch session)
- API requests/responses (with timing)
- Tool execution start/end
- Shell command execution
- Model changes
- Feature usage (web search, code apply)

#### WARN
- Tool execution failed but recoverable
- Shell command blocked by safety checks
- Code apply failed (non-matching search block)
- Long publication chains (potential performance)
- Formatter fallback to basic

#### ERROR
- API failures (network, auth, rate limit)
- Unhandled exceptions
- Circular dependencies in state
- Storage failures
- Critical configuration errors

---

## 5. Tracing & Structured Logging (shipped)

The four classic "gaps" — event emission, structured logging, correlation IDs, and timing — are now implemented via the tracing integration in `src/tracing/`:

1. **Event-emission hook** — the logger registers `tracer.setLogOutput(...)`, so every trace flows back through the logger's output (`src/utils/logger.ts:97`).
2. **Structured logging** — a ring buffer of `LogBufferEntry` objects (`{ timestamp, level, message, details }`, max 50,000) backs every log call and is exposed via `getLogBuffer()` / `clearLogBuffer()` / `logBufferSize` (`src/utils/logger.ts:9-14`, `537-572`).
3. **Correlation IDs** — `apiRequest()` mints a correlation ID via `tracer.startFlow()`; `getCurrentApiCorrelationId()` / `getCurrentCorrelationId()` expose it, and `deepseekClient.ts`, `chatProvider.ts`, and `requestOrchestrator.ts` thread it into downstream traces.
4. **Span timing** — `apiRequest`/`toolCall`/`shellExecuting`/`webSearchRequest` open spans via `tracer.startSpan()` and close them on the corresponding result/error call; duration is computed by the tracer (the `apiResponse` `durationMs` arg is deprecated and ignored).

### Remaining ideas

- A typed `on()/off()` listener API on the logger itself (today the only hook is the tracer's single `setLogOutput` callback).
- Additional specialized helpers (e.g. balance fetch, generic storage error) are not yet present.

---

## 6. Test Plan for Extension Logger

### Unit Tests (`tests/unit/utils/logger.test.ts`)

```typescript
describe('Logger', () => {
  describe('configuration', () => {
    it('has default INFO level');
    it('respects moby.logLevel setting');
    it('updates level on configuration change');
  });

  describe('log level filtering', () => {
    it('DEBUG logs when level is DEBUG');
    it('DEBUG does not log when level is INFO');
    it('INFO logs when level is INFO or DEBUG');
    it('WARN logs when level is WARN or lower');
    it('ERROR always logs unless OFF');
    it('OFF disables all logging');
  });

  describe('formatting', () => {
    it('includes timestamp');
    it('includes level indicator');
    it('handles multiline details');
    it('truncates long output');
  });

  describe('session methods', () => {
    it('sessionStart logs with session category');
    it('sessionSwitch logs session ID');
    it('sessionClear logs session category');
  });

  describe('API methods', () => {
    it('apiRequest logs model and message count');
    it('apiRequest indicates images when present');
    it('apiResponse logs token count and duration');
    it('apiError logs error with details');
    it('apiAborted logs cancellation');
  });

  describe('tool methods', () => {
    it('toolCall logs tool name');
    it('toolResult logs success state');
  });

  describe('shell methods', () => {
    it('shellExecuting logs command');
    it('shellResult logs success with output');
    it('shellResult logs failure');
  });

  describe('code methods', () => {
    it('codeApplied logs success with file');
    it('codeApplied logs failure');
    it('diffShown logs file path');
  });

  describe('web search methods', () => {
    it('webSearchRequest logs query and depth');
    it('webSearchResult logs count and duration');
    it('webSearchCached logs at DEBUG level');
    it('webSearchError logs error');
    it('webSearchCacheCleared logs cache clear');
  });

  describe('settings methods', () => {
    it('settingsChanged logs at DEBUG level');
    it('modelChanged logs model name');
  });

  describe('output channel', () => {
    it('show() reveals the output channel');
    it('clear() clears the output channel');
    it('dispose() disposes the output channel');
  });

  describe('singleton', () => {
    it('getInstance returns same instance');
  });
});
```

---

## 7. Implementation Status

### Phase 1: Fix Console.log Bypasses ✅ COMPLETE
1. ✅ Add logger import to `deepseekClient.ts`
2. ✅ Replace all `console.error` calls with `logger.apiError()`
3. ✅ Replace `console.log` in `extension.ts` with `logger.info()`
4. ✅ Replace `console.error` in the persistence layer (`src/events/ConversationManager.ts`) with proper logging
5. ✅ Replace `console.warn` in `formatting.ts` with `logger.warn()`

### Phase 2: Add Extension Logger Tests ✅ COMPLETE
1. ✅ Created `tests/unit/utils/logger.test.ts` (54 tests)
2. ✅ Created `tests/__mocks__/vscode.ts` for VS Code API mocking
3. ✅ Updated `vitest.config.ts` with vscode module alias
4. ✅ All log levels and methods tested

### Phase 3: Event Emission & Tracing ✅ SHIPPED
1. ✅ Tracer integration via `tracer.setLogOutput(...)` routes traces back through the logger
2. ✅ Structured ring buffer (`LogBufferEntry`) backs every log call
3. ✅ Spans (`tracer.startSpan`/`endSpan`) capture timing for API/tool/shell/web-search operations

### Phase 4: Correlation IDs ✅ SHIPPED
1. ✅ `apiRequest()` mints a correlation ID via `tracer.startFlow()`
2. ✅ IDs are threaded through tool/iteration execution
3. ✅ Related traces carry the correlation ID
4. ✅ `deepseekClient`, `chatProvider`, and `requestOrchestrator` consume `getCurrentApiCorrelationId()` / `getCurrentCorrelationId()` for request tracing

---

## 8. Log Output Examples

Each line is formatted as `:vscode | Moby: <ISO-8601 timestamp> [LEVEL] <message>`, with `details` indented on following lines.

### INFO Level
```
:vscode | Moby: 2026-02-08T22:45:23.732Z [INFO] → Request: 5 messages
      Model: deepseek-chat
:vscode | Moby: 2026-02-08T22:45:25.871Z [INFO] ← Response: 342 tokens
:vscode | Moby: 2026-02-08T22:45:25.880Z [INFO] Tool call: shell_execute
:vscode | Moby: 2026-02-08T22:45:25.901Z [INFO] Shell executing: ls -la
:vscode | Moby: 2026-02-08T22:45:26.142Z [INFO] Shell completed: ls -la
:vscode | Moby: 2026-02-08T22:45:26.150Z [INFO] Tool result: shell_execute succeeded
```

### DEBUG Level
```
:vscode | Moby: 2026-02-08T22:45:23.700Z [DEBUG] Setting changed: editMode = manual
:vscode | Moby: 2026-02-08T22:45:23.732Z [INFO] → Request: 5 messages
:vscode | Moby: 2026-02-08T22:45:25.871Z [INFO] ← Response: 342 tokens
:vscode | Moby: 2026-02-08T22:45:25.890Z [DEBUG] DiffEngine: Parsing blocks from response
:vscode | Moby: 2026-02-08T22:45:25.895Z [DEBUG] Found block: search=5 lines, replace=8 lines
:vscode | Moby: 2026-02-08T22:45:25.900Z [DEBUG] Exact match applied at line 42
:vscode | Moby: 2026-02-08T22:45:25.910Z [DEBUG] 🌐 Web search (cached): "React hooks tutorial"
```

### ERROR Level
```
:vscode | Moby: 2026-02-08T22:45:23.732Z [ERROR] API error: Rate limit exceeded
      Status: 429
      Retry-After: 60
:vscode | Moby: 2026-02-08T22:45:45.100Z [ERROR] Shell failed: rm -rf /
      Command blocked by safety filter
```

---

## 9. VS Code Configuration

```json
{
  "moby.logLevel": {
    "type": "string",
    "enum": ["DEBUG", "INFO", "WARN", "ERROR", "OFF"],
    "default": "WARN",
    "description": "Extension Output: Minimum log level to display in Output channel"
  }
}
```

The webview console has a separate setting, `moby.webviewLogLevel` (default `WARN`, enum `["DEBUG", "INFO", "WARN", "ERROR"]`), which drives the global level in `media/logging/`.

---

## 10. Summary

| Aspect | Extension Logger | EventState Logger |
|--------|------------------|-------------------|
| Location | `src/utils/logger.ts` | `media/state/EventStateLogger.ts` |
| Output | VS Code Output Channel | Browser Console |
| Default Level | WARN (`moby.logLevel`; falls back to INFO if unset) | WARN (global, in `media/logging/`) |
| Test Coverage | ✅ 54 tests | ✅ 37 tests |
| Console Bypasses | ✅ All fixed | N/A (intentional) |
| Correlation IDs / Tracing | ✅ Shipped (`src/tracing/`) | ❌ N/A |
| Structured buffer | ✅ Ring buffer (`LogBufferEntry`) | ✅ `WebviewLogBuffer` (synced to extension) |

### Completed
1. ✅ Fixed all extension-side console.log/error bypasses
2. ✅ Created extension logger tests (54 tests)
3. ✅ Created VS Code mock infrastructure for vitest
4. ✅ Shipped tracing: correlation IDs, span timing, and a structured ring buffer

### Future Enhancements
1. Add a typed `on()/off()` listener API on the logger (beyond the tracer callback)
2. Add additional specialized helpers (balance/storage) as needed
