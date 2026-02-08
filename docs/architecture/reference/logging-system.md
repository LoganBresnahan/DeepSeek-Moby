# Logging System Architecture

This document provides a comprehensive audit of the logging infrastructure and defines the logging strategy for the DeepSeek Moby extension.

---

## System Overview

We have **two distinct loggers** for different runtime environments:

| Logger | Environment | Output | File |
|--------|-------------|--------|------|
| **Extension Logger** | VS Code Extension (Node.js) | VS Code Output Channel | `src/utils/logger.ts` |
| **EventState Logger** | Webview (Browser) | Browser Console | `media/state/EventStateLogger.ts` |

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
- Setting: `deepseek.logLevel` (default: `INFO`)
- Colors: Disabled (VS Code Output channels don't support ANSI)

### Specialized Methods

| Category | Method | Level | Use Case |
|----------|--------|-------|----------|
| **Session** | `sessionStart(id, title)` | INFO | New session created |
| | `sessionSwitch(id)` | INFO | User switched sessions |
| | `sessionClear()` | INFO | Session cleared |
| **API** | `apiRequest(model, count, hasImages)` | INFO | Outbound API call |
| | `apiResponse(tokens, ms)` | INFO | Response received |
| | `apiError(error, details)` | ERROR | API failure |
| | `apiAborted()` | INFO | User cancelled request |
| **Tools** | `toolCall(name)` | INFO | Tool invocation |
| | `toolResult(name, success)` | INFO/WARN | Tool completion |
| **Shell** | `shellExecuting(command)` | INFO | R1 shell command started |
| | `shellResult(cmd, success, output)` | INFO/WARN | Shell completion |
| **Code** | `codeApplied(success, file)` | INFO/WARN | Code change applied |
| | `diffShown(file)` | INFO | Diff view opened |
| **Web Search** | `webSearchRequest(query, depth)` | INFO | Tavily search started |
| | `webSearchResult(count, ms)` | INFO | Search completed |
| | `webSearchCached(query)` | DEBUG | Cache hit |
| | `webSearchError(error)` | ERROR | Search failed |
| | `webSearchCacheCleared()` | INFO | Cache invalidated |
| **Settings** | `settingsChanged(setting, value)` | DEBUG | Config changed |
| | `modelChanged(model)` | INFO | Model selection changed |

### Current Usage

| File | Calls | Primary Categories |
|------|-------|-------------------|
| `src/providers/chatProvider.ts` | ~196 | All categories |
| `src/utils/diff.ts` | 29 | DEBUG - diff algorithm tracing |
| `src/tools/reasonerShellExecutor.ts` | 4 | Shell execution |
| `src/extension.ts` | 3 | Activation, show/dispose |
| `src/deepseekClient.ts` | 5 | API errors |
| `src/events/ConversationManager.ts` | 2 | Database/storage errors |
| `src/providers/completionProvider.ts` | 1 | Completion errors |
| `src/utils/formatting.ts` | 1 | Formatter warnings |

### Test Coverage: ✅ 45 TESTS (`tests/unit/utils/logger.test.ts`)

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

```typescript
interface LoggerConfig {
  logLevel: LogLevel;       // Default: ERROR
  showTimestamps: boolean;  // Default: false
  useGroups: boolean;       // Default: true (console.group)
  flatMode: boolean;        // Default: false
  logGlobalState: boolean;  // Default: false
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

### Test Coverage: ✅ COMPREHENSIVE (51 tests)

---

## 3. Console Logging Audit (Bypassing Loggers)

### Extension Side - ✅ ALL FIXED

All extension-side `console.*` calls have been migrated to use the logger:

| File | Status | Migration |
|------|--------|-----------|
| `src/deepseekClient.ts` | ✅ Fixed | 5 `console.error` → `logger.apiError()` |
| `src/extension.ts` | ✅ Fixed | `console.log` → `logger.info()` |
| `src/providers/completionProvider.ts` | ✅ Fixed | `console.error` → `logger.error()` |
| `src/events/ConversationManager.ts` | ✅ Fixed | Database errors use proper logging |
| `src/utils/formatting.ts` | ✅ Fixed | `console.warn` → `logger.warn()` |

**Total: 10 console calls migrated to logger ✅**

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

## 5. Missing Functionality

### Extension Logger Gaps

1. **No event emission** - Cannot hook into logs for testing/tracing
2. **No structured logging** - Messages are strings, not objects
3. **No correlation IDs** - Can't trace a request through the system
4. **No performance metrics** - Basic timing only

### Recommended Additions

```typescript
// Add to src/utils/logger.ts

// Event types for trace collection
export interface LogEvent {
  timestamp: number;
  level: LogLevel;
  category: string;
  message: string;
  details?: Record<string, unknown>;
  correlationId?: string;
}

// Event emission for testing
private eventHandlers: ((event: LogEvent) => void)[] = [];

public on(handler: (event: LogEvent) => void): void {
  this.eventHandlers.push(handler);
}

public off(handler: (event: LogEvent) => void): void {
  this.eventHandlers = this.eventHandlers.filter(h => h !== handler);
}

// New specialized methods needed
public completionRequest(prompt: string, model: string) {}
public completionResponse(tokens: number, durationMs: number) {}
public completionError(error: string) {}
public storageError(operation: string, error: string) {}
public balanceFetched(remaining: number) {}
public balanceError(error: string) {}
```

---

## 6. Test Plan for Extension Logger

### Unit Tests (`tests/unit/utils/logger.test.ts`)

```typescript
describe('Logger', () => {
  describe('configuration', () => {
    it('has default INFO level');
    it('respects deepseek.logLevel setting');
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
4. ✅ Replace `console.error` in `ChatStorage.ts` with `logger.error()`
5. ✅ Replace `console.warn` in `formatting.ts` with `logger.warn()`
6. ✅ Replace `console.error` in `completionProvider.ts` with `logger.error()`

### Phase 2: Add Extension Logger Tests ✅ COMPLETE
1. ✅ Created `tests/unit/utils/logger.test.ts` (45 tests)
2. ✅ Created `tests/__mocks__/vscode.ts` for VS Code API mocking
3. ✅ Updated `vitest.config.ts` with vscode module alias
4. ✅ All log levels and methods tested

### Phase 3: Add Event Emission (for E2E Testing) - FUTURE
1. Add `LogEvent` interface
2. Add `on()/off()` methods for event handlers
3. Emit events from all log calls
4. Update E2E test framework to capture events

### Phase 4: Add Correlation IDs
1. Generate request IDs for API calls
2. Pass IDs through tool execution
3. Include in all related log entries
4. Enable request tracing in Output channel

---

## 8. Log Output Examples

### INFO Level (Default)
```
14:32:15 INFO  → Request: 5 messages
         Model: deepseek-chat
14:32:17 INFO  ← Response: 342 tokens in 2.14s
14:32:17 INFO  Tool call: shell_execute
14:32:18 INFO  Shell executing: ls -la
14:32:18 INFO  Shell completed: ls -la
14:32:18 INFO  Tool result: shell_execute succeeded
```

### DEBUG Level
```
14:32:15 DEBUG Setting changed: editMode = manual
14:32:15 INFO  → Request: 5 messages
14:32:17 INFO  ← Response: 342 tokens in 2.14s
14:32:17 DEBUG DiffEngine: Parsing blocks from response
14:32:17 DEBUG Found block: search=5 lines, replace=8 lines
14:32:17 DEBUG Exact match applied at line 42
14:32:17 DEBUG 🌐 Web search (cached): "React hooks tutorial"
```

### ERROR Level
```
14:32:15 ERROR API error: Rate limit exceeded
         Status: 429
         Retry-After: 60
14:32:45 ERROR Shell failed: rm -rf /
         Command blocked by safety filter
```

---

## 9. VS Code Configuration

```json
{
  "deepseek.logLevel": {
    "type": "string",
    "enum": ["DEBUG", "INFO", "WARN", "ERROR", "OFF"],
    "default": "INFO",
    "description": "Minimum log level for the DeepSeek Moby output channel"
  }
}
```

---

## 10. Summary

| Aspect | Extension Logger | EventState Logger |
|--------|------------------|-------------------|
| Location | `src/utils/logger.ts` | `media/state/EventStateLogger.ts` |
| Output | VS Code Output Channel | Browser Console |
| Default Level | INFO | ERROR |
| Test Coverage | ✅ 45 tests | ✅ 51 tests |
| Console Bypasses | ✅ All fixed | N/A (intentional) |
| Event Emission | ❌ Future work | ❌ Future work |

### Completed
1. ✅ Fixed all 10 console.log/error bypasses
2. ✅ Created extension logger tests (45 tests)
3. ✅ Created VS Code mock infrastructure for vitest

### Future Enhancements
1. Add event emission for E2E testing support
2. Add correlation IDs for request tracing
3. Add structured logging for better analysis
