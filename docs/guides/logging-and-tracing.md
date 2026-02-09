# Logging and Tracing Guide

This guide explains how to use the logging and tracing system in the DeepSeek Moby extension. It covers the three-tier architecture, API reference, common patterns, and troubleshooting.

---

## Table of Contents

1. [Overview](#overview)
2. [When to Use Each Tier](#when-to-use-each-tier)
3. [Extension Logger (Tier 1)](#extension-logger-tier-1)
4. [TraceCollector (Tier 2)](#tracecollector-tier-2)
5. [Webview Logging (Tier 3)](#webview-logging-tier-3)
6. [Cross-Boundary Tracing](#cross-boundary-tracing)
7. [Export Formats](#export-formats)
8. [Configuration](#configuration)
9. [Common Patterns](#common-patterns)
10. [Troubleshooting](#troubleshooting)

---

## Overview

The logging system has **three tiers** spanning both the VS Code extension (Node.js) and the webview (browser):

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           Extension (Node.js)                                    │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │  Tier 1: Extension Logger (src/utils/logger.ts)                         │    │
│  │  • Output: VS Code Output Channel ("DeepSeek Moby")                     │    │
│  │  • Purpose: Human-readable logs for users and developers                │    │
│  │  • Also emits traces to TraceCollector                                  │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │  Tier 2: TraceCollector (src/tracing/TraceCollector.ts)                 │    │
│  │  • Output: In-memory ring buffer (exportable)                           │    │
│  │  • Purpose: Structured events for AI debugging and analysis             │    │
│  │  • Receives events from Extension Logger + Webview                      │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
                                      ▲
                                      │ postMessage (traceEvents)
                                      │
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           Webview (Browser)                                      │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │  Tier 3a: WebviewTracer (media/tracing/WebviewTracer.ts)                │    │
│  │  • Output: Syncs to TraceCollector every 5 seconds                      │    │
│  │  • Purpose: Structured traces for actors, state, rendering              │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │  Tier 3b: createLogger (media/logging/createLogger.ts)                  │    │
│  │  • Output: Browser console                                              │    │
│  │  • Purpose: Component-level debugging during development                │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │  Tier 3c: EventStateLogger (media/state/EventStateLogger.ts)            │    │
│  │  • Output: Browser console with grouping                                │    │
│  │  • Purpose: Pub/sub system debugging                                    │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## When to Use Each Tier

| Scenario | Tier | Method |
|----------|------|--------|
| API request started | 1 | `logger.apiRequest()` |
| API response received | 1 | `logger.apiResponse()` |
| Tool executed | 1 | `logger.toolCall()`, `logger.toolResult()` |
| Shell command run | 1 | `logger.shellExecuting()`, `logger.shellResult()` |
| Need to trace async flow | 2 | `tracer.startSpan()`, `tracer.endSpan()` |
| Need correlation across requests | 2 | `tracer.startFlow()` |
| Actor lifecycle (create, bind, unbind) | 3a | `webviewTracer.traceActorBind()` |
| State publication | 3a | `webviewTracer.tracePublish()` |
| Component debugging (development) | 3b | `log.debug()`, `log.warn()` |
| Pub/sub flow debugging | 3c | EventStateLogger (automatic) |

**Rule of thumb:**
- **Human reads it** → Extension Logger (Tier 1)
- **Machine analyzes it** → TraceCollector (Tier 2)
- **Debugging webview** → WebviewTracer or createLogger (Tier 3)

---

## Extension Logger (Tier 1)

### Location
[src/utils/logger.ts](../../src/utils/logger.ts)

### Import
```typescript
import { logger } from '../utils/logger';
```

### Log Levels

| Level | Priority | Use Case |
|-------|----------|----------|
| `DEBUG` | 0 | Verbose diagnostics (cache hits, state changes) |
| `INFO` | 1 | Normal operations (requests, tool calls) |
| `WARN` | 2 | Non-fatal issues (tool failures, blocked commands) |
| `ERROR` | 3 | Failures requiring attention |
| `OFF` | 4 | Disable all logging |

### Basic Methods

```typescript
logger.debug(message: string, details?: string);
logger.info(message: string, details?: string);
logger.warn(message: string, details?: string);
logger.error(message: string, details?: string);
```

### Specialized Methods

#### Session Events
```typescript
logger.sessionStart(sessionId: string, title: string);
logger.sessionSwitch(sessionId: string);
logger.sessionClear();
```

#### API Events
```typescript
// Returns span ID for correlation
const spanId = logger.apiRequest(model: string, messageCount: number, hasImages?: boolean);

// Call during streaming (batched internally)
logger.apiStreamChunk(chunkSize: number, contentType?: 'text' | 'thinking' | 'tool');

// Milestones during streaming
logger.apiStreamProgress(milestone: 'first-token' | 'thinking-start' | 'thinking-end' | 'content-start');

// End the request
logger.apiResponse(tokenCount: number);
logger.apiError(error: string, details?: string);
logger.apiAborted();

// Get correlation ID for child operations
const correlationId = logger.getCurrentApiCorrelationId();
```

#### Tool Events
```typescript
const spanId = logger.toolCall(toolName: string);
logger.toolResult(toolName: string, success: boolean);
```

#### Shell Events
```typescript
const spanId = logger.shellExecuting(command: string);
logger.shellResult(command: string, success: boolean, output?: string);
```

#### Web Search Events
```typescript
const spanId = logger.webSearchRequest(query: string, searchDepth: string);
logger.webSearchResult(resultCount: number, durationMs: number);
logger.webSearchCached(query: string);
logger.webSearchError(error: string);
logger.webSearchCacheCleared();
```

#### Settings Events
```typescript
logger.settingsChanged(setting: string, value: any);
logger.modelChanged(model: string);
```

### Output Format

```
:vscode | Moby: 2026-02-09T14:32:15.123Z [INFO] → Request: 5 messages
      Model: deepseek-chat
:vscode | Moby: 2026-02-09T14:32:17.456Z [INFO] ← Response: 342 tokens
```

---

## TraceCollector (Tier 2)

### Location
[src/tracing/TraceCollector.ts](../../src/tracing/TraceCollector.ts)

### Import
```typescript
import { tracer } from '../tracing';
```

### Core Concepts

**Correlation ID**: Links related events (e.g., request → response → tool calls)

**Span**: Represents an async operation with start and end events

**Trace Event**: A single point-in-time event

### API Reference

#### Starting a Flow
```typescript
// Generate a correlation ID for a request flow
const correlationId = tracer.startFlow();
// Returns: "flow-1707484335123-abc123"
```

#### Spans (Async Operations)
```typescript
// Start a span
const spanId = tracer.startSpan(
  'api.request',           // category
  'chat',                  // operation name
  {
    correlationId,         // optional, auto-generated if omitted
    parentId: parentSpan,  // optional, for nested operations
    executionMode: 'async', // 'sync' | 'async' | 'callback'
    level: 'info',         // 'debug' | 'info' | 'warn' | 'error'
    data: { model, count } // optional payload
  }
);

// End a span
tracer.endSpan(spanId, {
  status: 'completed',     // 'completed' | 'failed'
  error: undefined,        // error message if failed
  data: { tokenCount }     // additional result data
});
```

#### Simple Traces (Sync Operations)
```typescript
tracer.trace(
  'session.switch',        // category
  'clear',                 // operation
  {
    correlationId,
    executionMode: 'sync',
    level: 'info',
    data: { sessionId }
  }
);
```

#### Importing External Events
```typescript
// Import webview events with original timestamp preserved
tracer.importEvent(
  'actor.bind',
  'MessageTurnActor',
  {
    originalId: 'wv-evt-123',
    timestamp: '2026-02-09T14:32:15.123Z',
    originalRelativeTime: 1234.5,
    correlationId,
    data: { turnId }
  }
);
```

#### Querying Events
```typescript
// Get all events for a correlation ID
const events = tracer.getTrace(correlationId);

// Get all events in buffer
const allEvents = tracer.getAll();

// Get events by category
const apiEvents = tracer.getByCategory('api.request');

// Get events by level (and above)
const warnings = tracer.getByLevel('warn');

// Get pending (unclosed) spans
const pending = tracer.getPendingSpans();
```

#### Export
```typescript
// Export as formatted JSON
const json = tracer.export('json');

// Export as line-delimited JSON (one event per line)
const jsonl = tracer.export('jsonl');

// Export as human-readable with aggregation
const pretty = tracer.export('pretty');
```

#### Statistics
```typescript
const stats = tracer.getStats();
// {
//   eventCount: 1234,
//   estimatedMemoryBytes: 456789,
//   correlationCount: 45,
//   pendingSpanCount: 2,
//   oldestEventTime: "2026-02-09T14:00:00.000Z",
//   newestEventTime: "2026-02-09T14:32:15.123Z"
// }
```

#### Management
```typescript
tracer.clear();           // Clear all events
tracer.resetTimer();      // Reset relative time counter
tracer.dispose();         // Clean up (stops timers)
```

### Trace Categories

| Category | Source | Description |
|----------|--------|-------------|
| `user.input` | Both | User typed/submitted message |
| `user.click` | Webview | User clicked UI element |
| `user.selection` | Both | User selected option |
| `api.request` | Extension | Outbound API call started |
| `api.stream` | Extension | Streaming chunk received |
| `api.response` | Extension | API call completed |
| `tool.call` | Extension | Tool execution started |
| `tool.result` | Extension | Tool execution completed |
| `shell.execute` | Extension | Shell command started |
| `shell.result` | Extension | Shell command completed |
| `state.publish` | Webview | Pub/sub state published |
| `state.subscribe` | Webview | Subscription handler triggered |
| `actor.create` | Webview | Actor instantiated |
| `actor.destroy` | Webview | Actor destroyed |
| `actor.bind` | Webview | Pool actor bound to turn |
| `actor.unbind` | Webview | Pool actor released |
| `bridge.send` | Both | postMessage sent |
| `bridge.receive` | Both | postMessage received |
| `render.turn` | Webview | Turn rendered |
| `render.segment` | Webview | Segment updated |
| `session.create` | Extension | New session created |
| `session.load` | Extension | Session loaded from history |
| `session.switch` | Extension | Session switched |
| `file.read` | Extension | File read operation |
| `file.write` | Extension | File write operation |
| `file.diff` | Extension | Diff shown |

---

## Webview Logging (Tier 3)

### 3a. WebviewTracer

#### Location
[media/tracing/WebviewTracer.ts](../../media/tracing/WebviewTracer.ts)

#### Import
```typescript
import { webviewTracer } from '../tracing';
```

#### Initialization
```typescript
// In chat.ts, after getting vscode API
webviewTracer.initialize(vscode);
```

#### Convenience Methods
```typescript
// Actor lifecycle
webviewTracer.traceActorCreate(actorId, actorType);
webviewTracer.traceActorDestroy(actorId);
webviewTracer.traceActorBind(actorId, turnId);
webviewTracer.traceActorUnbind(actorId, turnId);

// State changes
webviewTracer.tracePublish(actorId, keys, chainDepth);
webviewTracer.traceSubscribe(actorId, key, handlerName);

// Bridge messages
webviewTracer.traceBridgeSend(messageType, data);
webviewTracer.traceBridgeReceive(messageType, data);

// Rendering
webviewTracer.traceRenderTurn(turnId, role);
webviewTracer.traceRenderSegment(segmentId, segmentType);

// User actions
webviewTracer.traceUserClick(elementId, elementType);
webviewTracer.traceUserInput(inputType, data);
```

#### Raw Trace/Span API
```typescript
// Same pattern as TraceCollector
const spanId = webviewTracer.startSpan('actor.bind', actorId, { data: { turnId } });
webviewTracer.endSpan(spanId, { status: 'completed' });

webviewTracer.trace('user.click', 'sendButton', { level: 'info' });
```

#### Cross-Boundary Correlation
```typescript
// Extension sends correlationId in startResponse message
// WebviewTracer uses it automatically for all traces
webviewTracer.setExtensionCorrelationId(correlationId);

// Get current correlation ID
const id = webviewTracer.getExtensionCorrelationId();
```

### 3b. createLogger (Component Logger)

#### Location
[media/logging/createLogger.ts](../../media/logging/createLogger.ts)

#### Import
```typescript
import { createLogger } from '../logging';
```

#### Usage
```typescript
const log = createLogger('VirtualList');

log.debug('Binding actor to turn:', turnId);  // [VirtualList] Binding actor to turn: turn-1
log.info('Pool initialized with', poolSize, 'actors');
log.warn('Pool exhaustion detected');
log.error('Failed to create actor:', error);
```

#### Log Level Control
```typescript
import { setLogLevel, LogLevel, enableDebugMode, disableDebugMode } from '../logging';

// Set global level (affects all webview loggers)
setLogLevel(LogLevel.DEBUG);   // Show everything
setLogLevel(LogLevel.WARN);    // Only warnings and errors (production default)

// Convenience functions
enableDebugMode();   // Sets DEBUG
disableDebugMode();  // Sets WARN
```

#### Production Behavior

In production builds, `console.debug`, `console.log`, and `console.info` are **stripped by esbuild**. Only `console.warn` and `console.error` remain.

### 3c. EventStateLogger

#### Location
[media/state/EventStateLogger.ts](../../media/state/EventStateLogger.ts)

This logger is used internally by the EventStateManager for pub/sub debugging. It's automatically integrated - you don't need to call it directly.

#### Enable Debug Mode
```typescript
import { logger } from '../state';

logger.enableDebug();  // Shows all pub/sub activity in console
```

---

## Cross-Boundary Tracing

### How It Works

1. **Extension starts API flow** → `tracer.startFlow()` generates correlation ID
2. **Extension sends `startResponse`** → includes `correlationId` in message
3. **Webview receives message** → sets correlation ID on WebviewTracer
4. **Webview emits events** → all traces include the extension's correlation ID
5. **Webview syncs to extension** → events are merged into TraceCollector
6. **Export trace** → unified timeline from both sources

### Timeline Alignment

The extension and webview have independent `performance.now()` baselines. On export:

1. Events are sorted by ISO timestamp (`timestamp` field)
2. `relativeTime` is recalculated from the earliest event
3. Exported traces show a unified timeline starting at 0ms

### WSL2 Clock Drift

If running in WSL2, the extension (Linux) and webview (Windows/Chromium) may have different system clocks. See [Troubleshooting](#troubleshooting) for details.

---

## Export Formats

### JSON
```json
[
  {
    "id": "span-1707484335123-abc123",
    "correlationId": "flow-1707484335123-xyz789",
    "timestamp": "2026-02-09T14:32:15.123Z",
    "relativeTime": 0,
    "source": "extension",
    "category": "api.request",
    "operation": "chat",
    "executionMode": "async",
    "level": "info",
    "status": "started",
    "data": { "model": "deepseek-chat", "messageCount": 5 }
  }
]
```

### JSONL (Line-Delimited JSON)
```
{"id":"span-1707484335123-abc123","correlationId":"flow-1707484335123-xyz789",...}
{"id":"span-1707484335123-abc123-end","correlationId":"flow-1707484335123-xyz789",...}
{"id":"evt-1707484335456-def456","correlationId":"flow-1707484335123-xyz789",...}
```

### Pretty (Human-Readable with Aggregation)
```
     0.0ms 2026-02-09T14:32:15.123Z > [extension] [api.request] chat {"model":"deepseek-chat"}
    15.3ms 2026-02-09T14:32:15.138Z   [extension] [api.stream] chunk {"chunkNumber":1}
           ... 47 similar api.stream events (15.3-2150.8ms) - see JSONL for full data
  2150.8ms 2026-02-09T14:32:17.273Z   [extension] [api.stream] chunk {"chunkNumber":48}
  2151.2ms 2026-02-09T14:32:17.274Z < [extension] [api.request] chat (2151.2ms) {"tokenCount":342}
```

---

## Configuration

### Extension Logger

**VS Code Setting:** `deepseek.logLevel`

```json
{
  "deepseek.logLevel": "DEBUG"  // DEBUG | INFO | WARN | ERROR | OFF
}
```

### TraceCollector

```typescript
tracer.configure({
  maxBufferSize: 10000,    // Max events before oldest are dropped
  maxAgeMs: 1800000,       // Drop events older than 30 minutes (0 = disabled)
  maxPayloadSize: 1000,    // Truncate data payloads > 1KB
  warnAtMemoryMB: 50,      // Warn when memory exceeds 50MB
  minLevel: 'info',        // Minimum level to trace
  enabled: true,           // Enable/disable tracing
  logToOutput: false       // Also log to extension output channel
});
```

### WebviewTracer

```typescript
webviewTracer.configure({
  enabled: true,
  minLevel: 'info',
  maxBufferSize: 500,
  syncIntervalMs: 5000  // Sync to extension every 5 seconds
});
```

### Webview Log Level

```typescript
import { setLogLevel, LogLevel } from '../logging';

setLogLevel(LogLevel.WARN);  // Production default
setLogLevel(LogLevel.DEBUG); // Development
```

---

## Common Patterns

### Tracing an API Request Flow

```typescript
// In chatProvider.ts

// 1. Start the flow
const correlationId = logger.apiRequest(model, messages.length, hasImages);

// 2. Pass correlation ID to webview
webview.postMessage({
  type: 'startResponse',
  correlationId: logger.getCurrentApiCorrelationId()
});

// 3. Log streaming progress
logger.apiStreamProgress('first-token');
for (const chunk of stream) {
  logger.apiStreamChunk(chunk.length, 'text');
}
logger.apiStreamProgress('content-start');

// 4. End the flow
logger.apiResponse(totalTokens);
```

### Tracing Actor Lifecycle in Webview

```typescript
// In VirtualListActor.ts

private bindActorToTurn(turnId: string): void {
  const actor = this.acquireActor();

  webviewTracer.traceActorBind(actor.id, turnId);

  actor.bind({ turnId, ... });
}

private releaseActor(actor: MessageTurnActor, turnId: string): void {
  webviewTracer.traceActorUnbind(actor.id, turnId);

  actor.reset();
  this.releaseToPool(actor);
}
```

### Component Logging

```typescript
// In any webview component

import { createLogger } from '../logging';

const log = createLogger('ModelSelector');

export class ModelSelectorActor {
  constructor() {
    log.info('Initialized');
  }

  selectModel(model: string) {
    log.debug('Model selected:', model);
    // ...
    if (error) {
      log.error('Failed to select model:', error);
    }
  }
}
```

---

## Troubleshooting

### Logs Not Appearing in Output Channel

1. Check log level: `deepseek.logLevel` setting may be too high
2. Open the correct channel: View → Output → "DeepSeek Moby"
3. Verify logger is imported correctly

### Traces Not Being Collected

1. Check if tracing is enabled: `tracer.enabled`
2. Check minimum level: traces below `minLevel` are ignored
3. Buffer may be full: check `tracer.getStats().eventCount`

### Webview Events Missing from Export

1. Events sync every 5 seconds - wait or call `webviewTracer.forceSync()`
2. Check if webview was reloaded (clears buffer)
3. Verify `webviewTracer.initialize(vscode)` was called

### WSL2 Clock Drift

**Symptom:** Large time gaps between extension and webview events

**Cause:** WSL2's clock can drift from the Windows host clock

**Diagnosis:**
```
[WARN] [Trace] Time drift detected: extension=2026-02-09T05:39:27.790Z webview=2026-02-09T05:52:02.771Z diff=-754981ms
```

**Fix:**
```bash
# Sync WSL2 clock with Windows host
sudo hwclock -s

# Or sync with NTP server
sudo ntpdate time.windows.com

# Permanent fix
sudo timedatectl set-ntp true
```

### Memory Warning in Traces

**Symptom:** `[TraceCollector] High memory usage: 52.3MB (threshold: 50MB)`

**Fix:**
```typescript
// Increase threshold or reduce buffer
tracer.configure({
  maxBufferSize: 5000,     // Reduce buffer size
  maxAgeMs: 900000,        // Drop events > 15 minutes old
  maxPayloadSize: 500      // Smaller payloads
});

// Or clear old traces
tracer.clear();
```

### Console Flooded with Debug Messages

**Fix:** Set production log level
```typescript
import { setLogLevel, LogLevel } from '../logging';
setLogLevel(LogLevel.WARN);
```

Or in browser DevTools, uncheck "Verbose" in the Console filter.

---

## Related Documentation

- [Logging System Architecture](../architecture/reference/logging-system.md) - Detailed audit of logging infrastructure
- [Tracing System Integration](../architecture/integration/tracing-system.md) - Cross-boundary tracing design
- [Tracing Implementation Plan](../plans/tracing-and-ui-testing.md) - Full implementation plan with phases

---

## Summary

| Tier | Component | Output | Use For |
|------|-----------|--------|---------|
| 1 | Extension Logger | VS Code Output | Human-readable logs |
| 2 | TraceCollector | In-memory buffer | AI debugging, export |
| 3a | WebviewTracer | Syncs to Tier 2 | Actor/state tracing |
| 3b | createLogger | Browser console | Component debugging |
| 3c | EventStateLogger | Browser console | Pub/sub debugging |

**Key Points:**
- Extension Logger (Tier 1) automatically emits traces to TraceCollector (Tier 2)
- WebviewTracer (Tier 3a) syncs to TraceCollector every 5 seconds
- Use `correlationId` to link events across the extension/webview boundary
- Export with `tracer.export('pretty')` for human reading, `tracer.export('jsonl')` for machine analysis
