# Unified Tracing System & Automated UI Testing

## Overview

This plan addresses two interconnected needs:

1. **Tracing System** - A structured event log for AI-agent debugging
2. **Automated UI Testing** - Feature walkthrough with speed modes (ai/human)

The tracing system is the **foundation** for UI testing - tests emit traces, and traces enable debugging.

---

## Phase 0: Logging System Audit & Fixes

Before building the tracing system, we need to audit and fix the existing logging infrastructure. The tracing system **extends** the loggers, so they must be reliable first.

### Current State

| Logger | Location | Output | Tested |
|--------|----------|--------|--------|
| **Extension Logger** | `src/utils/logger.ts` | VS Code Output Channel | ✅ 384-line test file |
| **EventStateLogger** | `media/state/EventStateLogger.ts` | Browser console | ✅ 451-line test file |

### Audit Findings

#### Extension Logger (`src/utils/logger.ts`)

**✅ Working Correctly:**
- Log level filtering (DEBUG, INFO, WARN, ERROR, OFF)
- Timestamp format (`HH:MM:SS` wall clock)
- Colors correctly disabled (VS Code Output Channel doesn't support ANSI)
- All specialized methods tested

**❌ Issues Found:**
1. **No sync/async marking** - Async operations like `apiRequest` aren't distinguished from sync ops
2. **No correlation IDs** - Request → response pairs aren't linked
3. **No automatic duration tracking** - `apiResponse` takes `durationMs` as parameter but caller must track

#### EventStateLogger (`media/state/EventStateLogger.ts`)

**✅ Working Correctly:**
- Log level filtering
- Specialized methods for actor lifecycle and state changes
- Flat mode and groups work correctly

**❌ Issues Found:**
1. **Timestamps off by default** - `showTimestamps: false` in default config
2. **Relative time only** - Uses `performance.now() - startTime`, no wall clock
3. **startTime resets on configure()** - Calling configure() resets elapsed time to 0 (time bug!)
4. **Can't correlate with extension logs** - Different time bases make cross-boundary debugging impossible
5. **Uses console.log for info level** - Should use console.info for proper devtools filtering

### The Time Bug

**Extension Logger** uses wall clock time:
```typescript
// Output: "14:32:15 INFO → Request..."
const now = new Date();
return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
```

**EventStateLogger** uses relative elapsed time:
```typescript
// Output: "[1234.5ms] 🔍 EventState: Actor registered..."
const elapsed = performance.now() - this.startTime;
return `[${elapsed.toFixed(1)}ms] `;
```

**Problem:** You cannot correlate events between extension and webview because they use incompatible time formats. When debugging a flow that crosses the extension→webview boundary, timestamps don't align.

**Additional Bug:** `configure()` resets `startTime`, so all subsequent timestamps restart from 0:
```typescript
configure(options: Partial<LoggerConfig>): void {
  this.config = { ...this.config, ...options };
  this.startTime = performance.now();  // <-- Resets on every configure!
}
```

### Fixes Required

#### Phase 0A: Timestamp Consistency

1. **Add wall clock option to EventStateLogger**
   - Add `useWallClock: boolean` to LoggerConfig
   - When true, format as `HH:MM:SS.mmm` (with milliseconds for precision)
   - Keep relative time as option for performance profiling

2. **Don't reset startTime on configure()**
   - Only reset startTime in constructor
   - Add explicit `resetTimer()` method if manual reset needed

3. **Enable timestamps by default**
   - Change `showTimestamps: false` → `showTimestamps: true`
   - Use wall clock by default for cross-boundary correlation

#### Phase 0B: Console Method Consistency

Currently EventStateLogger uses `console.log` for all levels:
```typescript
debug(message: string, ...args: unknown[]): void {
  this.log(LogLevel.DEBUG, '🔍', message, ...args);  // calls console.log
}
```

**Fix:** Use appropriate console methods for browser devtools filtering:
```typescript
private log(level: LogLevel, icon: string, message: string, ...args: unknown[]): void {
  if (!this.shouldLog(level)) return;

  const prefix = `${this.getTimestamp()}${icon} ${this.componentName}:`;

  switch (level) {
    case LogLevel.DEBUG:
      console.debug(prefix, message, ...args);  // <- Filterable in devtools
      break;
    case LogLevel.INFO:
      console.info(prefix, message, ...args);   // <- Filterable in devtools
      break;
    case LogLevel.WARN:
      console.warn(prefix, message, ...args);   // <- Shows warning style
      break;
    case LogLevel.ERROR:
      console.error(prefix, message, ...args);  // <- Shows error style
      break;
  }
}
```

#### Phase 0C: Test Coverage Gaps

Add tests for:
1. `configure()` NOT resetting startTime (after fix)
2. Wall clock timestamp format (after fix)
3. Console method usage (debug uses console.debug, etc.)

### Implementation Order

| Step | Description | Status |
|------|-------------|--------|
| 0A-1 | Add `useWallClock` option to LoggerConfig types | ✅ Complete |
| 0A-2 | Implement wall clock formatting in EventStateLogger | ✅ Complete |
| 0A-3 | Fix startTime reset bug in configure() | ✅ Complete |
| 0A-4 | Enable timestamps by default | ✅ Complete |
| 0B-1 | Use console.debug/info/warn/error appropriately | ✅ Complete |
| 0C-1 | Add tests for new behavior | ✅ Complete |
| 0C-2 | Update existing tests if needed | ✅ Complete |

**All Phase 0 items completed and tests passing (942 tests).**

---

## Part 1: Unified Tracing System

### Goal

Create a structured event stream that:
- Documents **every action** in the system in order
- Marks operations as **sync** or **async**
- Provides **correlation IDs** to link related operations
- Bridges **Extension ↔ Webview** into a unified timeline
- Enables AI agents to understand "what just happened" from a trace dump

### Trace Event Schema

```typescript
interface TraceEvent {
  // Identification
  id: string;                     // Unique event ID (uuid or incremental)
  correlationId: string;          // Links related events (e.g., request → response)
  parentId?: string;              // For nested operations

  // Timing
  timestamp: number;              // High-resolution timestamp
  duration?: number;              // For completed operations

  // Classification
  source: 'extension' | 'webview' | 'bridge';
  category: TraceCategory;        // See below
  operation: string;              // Specific operation name

  // Sync/Async marker (your idea!)
  executionMode: 'sync' | 'async' | 'callback';

  // Level (for filtering)
  level: 'debug' | 'info' | 'warn' | 'error';

  // Payload
  data?: Record<string, unknown>;

  // Status (for operations with outcomes)
  status?: 'started' | 'completed' | 'failed';
  error?: string;
}

type TraceCategory =
  // User Actions
  | 'user.input'        // User typed/submitted
  | 'user.click'        // User clicked UI element
  | 'user.selection'    // User selected option

  // API Layer
  | 'api.request'       // Outbound to DeepSeek/Tavily
  | 'api.stream'        // Streaming tokens
  | 'api.response'      // Complete response

  // Tool Execution
  | 'tool.call'         // Tool invoked
  | 'tool.result'       // Tool completed
  | 'shell.execute'     // Shell command
  | 'shell.result'      // Shell output

  // State Management
  | 'state.publish'     // Pub/sub publication
  | 'state.subscribe'   // Subscription triggered

  // Actor Lifecycle
  | 'actor.create'      // Actor instantiated
  | 'actor.destroy'     // Actor destroyed
  | 'actor.bind'        // Pool actor bound to turn
  | 'actor.unbind'      // Pool actor released

  // Message Bridge
  | 'bridge.send'       // postMessage to webview
  | 'bridge.receive'    // Message received

  // UI Rendering
  | 'render.turn'       // Turn rendered
  | 'render.segment'    // Segment updated
  | 'render.scroll'     // Scroll position

  // Session
  | 'session.create'
  | 'session.load'
  | 'session.switch'

  // Files
  | 'file.read'
  | 'file.write'
  | 'file.diff';
```

### Trace Collector Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            TraceCollector (Singleton)                        │
│                                                                              │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────────┐  │
│  │  Event Buffer    │  │  Correlation     │  │  Exporters               │  │
│  │  (ring buffer)   │  │  Registry        │  │  - Console               │  │
│  │  max: 10000      │  │  (correlationId  │  │  - File (JSON/JSONL)     │  │
│  │  events          │  │   → events[])    │  │  - Test Assertions       │  │
│  └──────────────────┘  └──────────────────┘  └──────────────────────────┘  │
│                                                                              │
│  Methods:                                                                    │
│  - trace(event) → id                                                         │
│  - startSpan(category, operation) → spanId                                   │
│  - endSpan(spanId, result?)                                                  │
│  - getTrace(correlationId) → TraceEvent[]                                    │
│  - export(format) → string | TraceEvent[]                                    │
│  - subscribe(callback) → unsubscribe                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Extension-Side Implementation

```typescript
// src/tracing/TraceCollector.ts

export class TraceCollector {
  private static instance: TraceCollector;
  private buffer: TraceEvent[] = [];
  private maxSize = 10000;
  private correlations = new Map<string, string[]>();
  private subscribers: ((event: TraceEvent) => void)[] = [];
  private spanStack: Map<string, TraceEvent> = new Map();

  // Generate correlation ID for a request flow
  startFlow(): string {
    return `flow-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  // Start a span (for async operations)
  startSpan(
    category: TraceCategory,
    operation: string,
    options: {
      correlationId?: string;
      parentId?: string;
      executionMode?: 'sync' | 'async' | 'callback';
      data?: Record<string, unknown>;
    } = {}
  ): string {
    const id = `span-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const event: TraceEvent = {
      id,
      correlationId: options.correlationId || this.startFlow(),
      parentId: options.parentId,
      timestamp: performance.now(),
      source: 'extension',
      category,
      operation,
      executionMode: options.executionMode || 'async',
      level: 'info',
      status: 'started',
      data: options.data
    };

    this.spanStack.set(id, event);
    this.emit(event);
    return id;
  }

  // End a span
  endSpan(spanId: string, result?: { status: 'completed' | 'failed'; error?: string; data?: Record<string, unknown> }) {
    const startEvent = this.spanStack.get(spanId);
    if (!startEvent) return;

    const endEvent: TraceEvent = {
      ...startEvent,
      id: `${spanId}-end`,
      timestamp: performance.now(),
      duration: performance.now() - startEvent.timestamp,
      status: result?.status || 'completed',
      error: result?.error,
      data: { ...startEvent.data, ...result?.data }
    };

    this.spanStack.delete(spanId);
    this.emit(endEvent);
  }

  // Simple trace (for sync operations)
  trace(
    category: TraceCategory,
    operation: string,
    options: {
      correlationId?: string;
      executionMode?: 'sync' | 'async' | 'callback';
      level?: 'debug' | 'info' | 'warn' | 'error';
      data?: Record<string, unknown>;
    } = {}
  ): void {
    const event: TraceEvent = {
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      correlationId: options.correlationId || 'standalone',
      timestamp: performance.now(),
      source: 'extension',
      category,
      operation,
      executionMode: options.executionMode || 'sync',
      level: options.level || 'info',
      data: options.data
    };

    this.emit(event);
  }

  private emit(event: TraceEvent) {
    // Add to buffer
    this.buffer.push(event);
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }

    // Track correlations
    if (event.correlationId !== 'standalone') {
      const existing = this.correlations.get(event.correlationId) || [];
      existing.push(event.id);
      this.correlations.set(event.correlationId, existing);
    }

    // Notify subscribers
    this.subscribers.forEach(cb => cb(event));
  }

  // Export for AI analysis
  exportForAI(correlationId?: string): string {
    const events = correlationId
      ? this.buffer.filter(e => e.correlationId === correlationId)
      : this.buffer.slice(-100); // Last 100 by default

    return events.map(e => {
      const mode = e.executionMode === 'sync' ? '[SYNC]' : e.executionMode === 'async' ? '[ASYNC]' : '[CALLBACK]';
      const status = e.status ? ` (${e.status})` : '';
      const duration = e.duration ? ` [${e.duration.toFixed(1)}ms]` : '';
      return `${e.timestamp.toFixed(1)}ms ${mode} ${e.category}.${e.operation}${status}${duration}`;
    }).join('\n');
  }
}
```

### Webview-Side Implementation

```typescript
// media/tracing/WebviewTracer.ts

export class WebviewTracer {
  private collector: TraceEvent[] = [];
  private subscribers: ((event: TraceEvent) => void)[] = [];

  // Trace pub/sub operations
  tracePubSub(
    type: 'publish' | 'subscribe',
    actorId: string,
    keys: string[],
    executionMode: 'sync' | 'async' = 'sync'
  ) {
    this.emit({
      id: `ws-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      correlationId: 'webview-state',
      timestamp: performance.now(),
      source: 'webview',
      category: type === 'publish' ? 'state.publish' : 'state.subscribe',
      operation: actorId,
      executionMode,
      level: 'debug',
      data: { keys }
    });
  }

  // Trace actor lifecycle
  traceActor(
    type: 'create' | 'destroy' | 'bind' | 'unbind',
    actorId: string,
    data?: Record<string, unknown>
  ) {
    this.emit({
      id: `ws-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      correlationId: 'webview-actors',
      timestamp: performance.now(),
      source: 'webview',
      category: `actor.${type}` as TraceCategory,
      operation: actorId,
      executionMode: 'sync',
      level: 'info',
      data
    });
  }

  // Send trace to extension for unified collection
  flushToExtension(vscode: VSCodeAPI) {
    if (this.collector.length === 0) return;

    vscode.postMessage({
      type: 'traceEvents',
      events: this.collector
    });

    this.collector = [];
  }
}
```

### Integration with Existing Loggers

The tracing system **wraps** the existing loggers, not replaces them:

```typescript
// Enhanced logger.ts
public apiRequest(model: string, messageCount: number, hasImages: boolean = false) {
  // Existing log output
  const imageInfo = hasImages ? ' (with images)' : '';
  this.log('INFO', `→ Request: ${messageCount} messages${imageInfo}`, `Model: ${model}`, 'api');

  // NEW: Emit trace event
  tracer.trace('api.request', 'deepseek-chat', {
    executionMode: 'async',
    data: { model, messageCount, hasImages }
  });
}
```

---

## Part 2: Automated UI Testing Tool

### Goal

Create a test runner that:
- Walks through **all features** one by one
- Has two speed modes: **ai** (fast) and **human** (realistic timing)
- Emits traces for debugging
- Can be run headlessly or visually

### Speed Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| **ai** | Execute as fast as possible, respecting only external dependencies (API calls) | CI/CD, quick validation |
| **human** | Simulate realistic human timing (typing speed, reading time, click delays) | Visual demos, debugging |

```typescript
interface SpeedConfig {
  // AI mode: minimal delays
  ai: {
    typeDelay: 0,           // Instant typing
    clickDelay: 10,         // 10ms between clicks
    readDelay: 0,           // No reading time
    transitionDelay: 50,    // Wait for animations
    apiTimeout: 30000       // External API timeout
  };

  // Human mode: realistic timing
  human: {
    typeDelay: 50,          // 50ms per character (realistic typing)
    clickDelay: 300,        // 300ms between clicks
    readDelay: 1000,        // 1s reading time after responses
    transitionDelay: 500,   // Wait for visual transitions
    apiTimeout: 30000       // Same API timeout
  };
}
```

### Test Runner Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              UITestRunner                                    │
│                                                                              │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────────┐  │
│  │  Feature Tests   │  │  Speed Controller│  │  Mock LLM Client         │  │
│  │  - greeting      │  │  - ai mode       │  │  - Pattern matching      │  │
│  │  - code-gen      │  │  - human mode    │  │  - Canned responses      │  │
│  │  - tool-chain    │  │  - custom speeds │  │  - Streaming simulation  │  │
│  │  - edit-modes    │  │                  │  │                          │  │
│  │  - history       │  │                  │  │                          │  │
│  └──────────────────┘  └──────────────────┘  └──────────────────────────┘  │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                         Test Executor                                 │  │
│  │                                                                       │  │
│  │  for (feature of features) {                                          │  │
│  │    await runFeatureTest(feature, speedMode);                          │  │
│  │  }                                                                    │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                         TraceCollector                                │  │
│  │                  (Records all operations for debugging)               │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Feature Test Format

```typescript
// tests/ui/features/greeting.feature.ts

export const greetingFeature: UIFeatureTest = {
  name: 'greeting',
  description: 'Basic greeting exchange',

  steps: [
    {
      action: 'type',
      target: '#messageInput',
      value: 'Hello, how are you?',
      description: 'User types greeting'
    },
    {
      action: 'click',
      target: '#sendBtn',
      description: 'User sends message'
    },
    {
      action: 'waitFor',
      condition: 'streaming.complete',
      timeout: 30000,
      description: 'Wait for AI response'
    },
    {
      action: 'assert',
      type: 'contains',
      target: '.message-content',
      value: ['help', 'assist', 'how can I'],
      description: 'Response contains greeting'
    }
  ],

  // Mock response for this feature
  mockResponses: [
    {
      trigger: /hello|hi|hey/i,
      response: "Hello! I'm doing great, thank you for asking. How can I help you today?",
      streaming: true
    }
  ]
};
```

### Feature Test Catalog

```typescript
// tests/ui/features/index.ts

export const featureTests: UIFeatureTest[] = [
  // Basic Interactions
  greetingFeature,
  codeGenerationFeature,
  multiTurnConversationFeature,

  // Tool Execution
  fileReadFeature,
  fileWriteFeature,
  shellCommandFeature,
  toolChainFeature,

  // Edit Modes
  manualEditModeFeature,
  askEditModeFeature,
  autoEditModeFeature,

  // Streaming & Thinking
  streamingDisplayFeature,
  thinkingIterationsFeature,
  streamInterruptFeature,

  // Session Management
  newSessionFeature,
  loadHistoryFeature,
  switchSessionFeature,

  // UI Components
  modelSelectorFeature,
  filePickerFeature,
  commandsDropdownFeature,
  settingsFeature,

  // Error Handling
  apiErrorFeature,
  networkTimeoutFeature,
  toolFailureFeature
];
```

### Running Tests

```typescript
// tests/ui/runner.ts

async function runUITests(options: {
  mode: 'ai' | 'human';
  features?: string[];    // Run specific features, or all if undefined
  visual?: boolean;       // Open browser for visual debugging
  traceOutput?: string;   // File path for trace export
}) {
  const runner = new UITestRunner({
    speedMode: options.mode,
    traceEnabled: true
  });

  const features = options.features
    ? featureTests.filter(f => options.features!.includes(f.name))
    : featureTests;

  console.log(`Running ${features.length} UI feature tests in ${options.mode} mode...`);

  const results: TestResult[] = [];

  for (const feature of features) {
    console.log(`  ▶ ${feature.name}: ${feature.description}`);

    const result = await runner.runFeature(feature);
    results.push(result);

    if (result.passed) {
      console.log(`    ✓ Passed (${result.duration}ms)`);
    } else {
      console.log(`    ✗ Failed: ${result.error}`);
      console.log(`    Trace: ${result.traceId}`);
    }
  }

  // Export traces for debugging
  if (options.traceOutput) {
    const traces = runner.exportTraces();
    fs.writeFileSync(options.traceOutput, JSON.stringify(traces, null, 2));
  }

  // Summary
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\nResults: ${passed} passed, ${failed} failed`);

  return { passed, failed, results };
}
```

### CLI Interface

```bash
# Run all tests in AI mode (fast)
npm run test:ui -- --mode=ai

# Run all tests in human mode (realistic timing)
npm run test:ui -- --mode=human

# Run specific features
npm run test:ui -- --mode=ai --features=greeting,code-gen,tool-chain

# Visual mode with trace output
npm run test:ui -- --mode=human --visual --trace=./test-trace.json
```

---

## Implementation Phases

### Phase 0: Logging Audit Fixes (PREREQUISITE) ✅ COMPLETE

1. ✅ Add `useWallClock: boolean` option to `LoggerConfig` in `media/state/types.ts`
2. ✅ Update `EventStateLogger.getTimestamp()` to support wall clock format
3. ✅ Fix `configure()` to NOT reset `startTime` (added `resetTimer()` for explicit reset)
4. ✅ Change default `showTimestamps: true` and `useWallClock: true`
5. ✅ Use `console.debug/info/warn/error` instead of just `console.log`
6. ✅ Add tests for new behavior (34 tests passing)
7. ✅ Updated Extension Logger format: `:vscode | Moby: ISO_TIMESTAMP [LEVEL] message`
8. ✅ Committed

### Phase 1: Tracing Foundation ✅ COMPLETE

**Core Implementation:**
1. ✅ Create `src/tracing/types.ts` (TraceEvent, TraceCategory, TraceBufferStats)
2. ✅ Create `src/tracing/TraceCollector.ts` (38 tests)
3. ✅ Integrate with existing `logger.ts` (logger now emits traces for API, tool, shell, session, web search)
4. ✅ Key operations in `chatProvider.ts` traced via logger integration

**Memory & Performance Features:**
5. ✅ Ring buffer with configurable `maxBufferSize` (default: 10,000 events)
6. ✅ Time-based eviction with `maxAgeMs` config option
7. ✅ Payload truncation with `maxPayloadSize` (default: 1KB) to prevent large payloads
8. ✅ Memory estimation with `estimateMemoryBytes()` and `warnAtMemoryMB` threshold
9. ✅ Correlation map cleanup when events are evicted

**Streaming Traces:**
10. ✅ Added streaming chunk traces (`api.stream` category)
11. ✅ Added streaming progress milestones (`first-token`, `thinking-start`, `content-start`)
12. ✅ Batched chunk traces (every 10th chunk) to reduce noise

**Export Commands:**
13. ✅ Commands dropdown with Export Trace, Copy Trace, View Trace, Trace Stats, Clear Trace
14. ✅ Export formats: JSON, JSONL, Pretty
15. ✅ `getStats()` method for buffer statistics

**Duration Fix:**
16. ✅ Removed `durationMs` from data payload - now using tracer's internal timing consistently

### Phase 2: Webview Tracing ✅ COMPLETE

1. ✅ Created `media/tracing/WebviewTracer.ts` - Singleton tracer with startSpan/endSpan/trace methods
2. ✅ Created `media/tracing/types.ts` - WebviewTraceEvent, WebviewTraceCategory, and config types
3. ✅ Created `media/tracing/index.ts` - Module exports
4. ✅ Integrated with `EventStateManager` - setTracer/getTracer, traces for register/unregister/handleStateChange/broadcast
5. ✅ Added trace emission to `VirtualListActor` - bind/unbind traces in bindActorToTurn(), updateVisibility(), clear()
6. ✅ Added bridge for webview → extension trace sync - postMessage handler in chatProvider.ts
7. ✅ Added convenience methods: tracePublish, traceSubscribe, traceActorCreate, traceActorBind, traceActorUnbind, traceBridgeSend, traceRenderTurn, traceUserClick
8. ✅ Added comprehensive tests for WebviewTracer (30 tests passing)

### Phase 3: Mock LLM Client

1. Create `tests/ui/mocks/MockDeepSeekClient.ts`
2. Pattern-based response matching
3. Streaming simulation
4. Tool call triggers

### Phase 4: UI Test Runner

1. Create `tests/ui/runner.ts`
2. Speed controller implementation
3. Test executor with step actions
4. Assertion library for UI state

### Phase 5: Feature Tests

1. Create feature test format
2. Implement 5-10 core feature tests
3. CI integration
4. Visual debugging mode

---

## Example Trace Output (For AI Debugging)

```
0.0ms [ASYNC] user.input.submit (started)
0.1ms [SYNC] bridge.send.sendMessage
0.2ms [ASYNC] api.request.deepseek-chat (started)
15.3ms [ASYNC] api.stream.token data="Hello"
15.8ms [SYNC] state.publish keys=["streaming.content"]
16.0ms [SYNC] render.segment type="text"
25.1ms [ASYNC] api.stream.token data=" there!"
25.5ms [SYNC] state.publish keys=["streaming.content"]
25.7ms [SYNC] render.segment type="text"
150.2ms [ASYNC] api.response.complete (completed) [150.0ms]
150.5ms [SYNC] state.publish keys=["streaming.active"]
150.8ms [SYNC] actor.unbind actor="turn-1"
151.0ms [ASYNC] user.input.submit (completed) [151.0ms]
```

This trace shows:
- User submitted at t=0
- API call started async
- Tokens streamed with sync state updates
- Each state update triggers sync render
- Total request took 151ms

---

## Summary

| Component | Purpose |
|-----------|---------|
| **TraceCollector** | Unified event stream with correlation IDs and sync/async marking |
| **WebviewTracer** | Webview-side tracing that syncs to extension |
| **MockDeepSeekClient** | Deterministic LLM responses for testing |
| **UITestRunner** | Feature test executor with speed modes |
| **Feature Tests** | Catalog of UI scenarios to validate |

The tracing system provides the **observability** needed for AI-agent debugging, while the UI testing tool uses that infrastructure to validate all features systematically.

---

## Review: Performance & Memory Considerations

### Current Implementation

The TraceCollector uses a **ring buffer** with a fixed maximum size:

```typescript
private config: TraceCollectorConfig = {
  maxBufferSize: 10000,  // Max events before oldest are dropped
  // ...
};
```

When the buffer exceeds `maxBufferSize`, the oldest event is removed (`shift()`).

### Memory Analysis

**Per-event memory estimate:**

| Field | Typical Size |
|-------|-------------|
| `id` (string) | ~30 bytes |
| `correlationId` (string) | ~30 bytes |
| `timestamp` (ISO string) | ~24 bytes |
| `relativeTime` (number) | 8 bytes |
| `duration` (number, optional) | 8 bytes |
| `source`, `category`, `operation` (strings) | ~50 bytes |
| `executionMode`, `level`, `status` (strings) | ~20 bytes |
| `data` (object, varies) | 0-500 bytes |
| Object overhead | ~50 bytes |
| **Total per event** | **~220-720 bytes** |

**Buffer memory at capacity:**

| Events | Min Memory | Max Memory (with data) |
|--------|------------|------------------------|
| 1,000 | ~220 KB | ~720 KB |
| 10,000 (default) | ~2.2 MB | ~7.2 MB |
| 50,000 | ~11 MB | ~36 MB |
| 100,000 | ~22 MB | ~72 MB |

### Risk Assessment

**Is 10,000 events realistic?**

A typical user session might generate:
- 1 API request = ~5-10 trace events (request start, stream tokens, response end)
- 1 tool execution = ~3-5 events
- State changes = 2-5 per user action

**Rough estimates:**
- Light session (10 messages): ~100-200 events
- Medium session (50 messages with tools): ~500-1000 events
- Heavy session (100+ messages, many tools): ~2000-5000 events

**Conclusion:** 10,000 events is a reasonable default that covers most sessions without memory pressure.

### Will This Crash VS Code?

**Unlikely with current settings.** VS Code extensions typically have access to the Node.js heap (default ~1.5GB). A 7MB trace buffer is negligible.

**However, risks exist if:**
1. `maxBufferSize` is increased significantly (>100,000)
2. `data` payloads are large (e.g., full file contents, base64 images)
3. Correlation map grows unbounded (not currently an issue - cleared with buffer)
4. Subscribers have memory leaks

### Should We Auto-Remove Old Entries?

**Current behavior:** Yes, via ring buffer. Oldest events are automatically dropped when buffer is full.

**Potential improvements:**

| Strategy | Pros | Cons |
|----------|------|------|
| **Time-based eviction** | Removes stale data even if buffer not full | Loses context for long debugging sessions |
| **Category-based limits** | Prevent one category (e.g., `state.publish`) from dominating | More complex, may lose important events |
| **Importance-based retention** | Keep errors/warnings longer than debug | Requires priority system |
| **Session-scoped buffers** | Clear on new chat session | Loses cross-session debugging |
| **Lazy export** | Write to disk periodically, keep only recent in memory | Adds I/O, file management complexity |

### Recommendations (All Implemented ✅)

1. ✅ **Keep current ring buffer** - Simple, effective, proven pattern

2. ✅ **Time-based eviction** - Added `maxAgeMs` config option:
   ```typescript
   tracer.configure({ maxAgeMs: 30 * 60 * 1000 }); // 30 minutes
   ```

3. ✅ **Payload size limit** - Added `maxPayloadSize` config (default: 1000 bytes):
   ```typescript
   // Payloads larger than maxPayloadSize are auto-truncated
   tracer.configure({ maxPayloadSize: 1000 });
   // Results in: { _truncated: true, _originalSize: 5000, preview: "..." }
   ```

4. ✅ **Memory monitoring** - Added `warnAtMemoryMB` config and `estimateMemoryBytes()`:
   ```typescript
   tracer.configure({ warnAtMemoryMB: 50 }); // Warn at 50MB
   const stats = tracer.getStats(); // Get buffer statistics
   ```

5. **Default to disabled in production** - Still pending (low priority):
   ```typescript
   // Could add to settings
   tracer.configure({ enabled: isDevelopment });
   ```

### Open Questions

1. **Should tracing be off by default?** Currently enabled. Users may not know it's running.

2. **Should we persist traces across VS Code restarts?** Currently lost on restart. Could write to disk for crash debugging.

3. **Should webview traces sync to extension?** Plan mentions this but not implemented. Would double memory usage.

4. ~~**What about correlation map cleanup?** Currently grows unbounded. Should we evict old correlation IDs?~~ **RESOLVED:** Correlation map is now cleaned up when events are evicted.

### Log Volume & Human Readability

**Problem:** At the `info` level, trace output generates an overwhelming number of entries. A single API request with streaming can produce 100+ events (actor bind/unbind, state publishes, stream chunks). This is far too much for a human to read through when debugging.

**Observations from real traces:**
- Actor bind/unbind events fire rapidly during scroll (dozens per second)
- State publish events fire for every keystroke and UI interaction
- Webview → extension sync batches events but still creates many entries
- A 6-minute streaming response generated 41,000+ tokens across 11,000+ chunks

**Potential solutions:**

| Approach | Description | Trade-offs |
|----------|-------------|------------|
| **Batched summaries** | Collapse repeated events into "N events of type X in Yms" | Loses individual timing, simpler to read |
| **Sampling** | Only log every Nth event of high-frequency types | May miss important events |
| **Hierarchical logs** | Summarize at request level, expand on demand | Requires viewer tooling |
| **Smarter filtering** | Only log state *changes*, not all publishes | Reduces noise significantly |
| **Category budgets** | Limit events per category per time window | Prevents any category from dominating |
| **Human-focused export** | Separate "pretty" format that aggregates | Keep detailed JSONL, summarized text |

**Recommended next steps:**
1. Add aggregation to `pretty` export format (e.g., "47 actor.bind events" instead of 47 lines)
2. Consider `minLevel: 'warn'` as default, with explicit enable for debugging
3. Add category-specific sampling (e.g., `state.publish` only logs on actual value change)
4. Explore a "trace viewer" UI that can collapse/expand event groups

### Action Items (If Needed)

| Priority | Item | Effort | Status |
|----------|------|--------|--------|
| ~~Low~~ | ~~Add `maxAgeMs` config option~~ | ~~Small~~ | ✅ Done |
| ~~Low~~ | ~~Add data payload truncation~~ | ~~Small~~ | ✅ Done |
| ~~Medium~~ | ~~Add memory usage warning~~ | ~~Small~~ | ✅ Done |
| ~~Low~~ | ~~Correlation map cleanup~~ | ~~Medium~~ | ✅ Done |
| Medium | Add "tracing enabled" user setting | Small | Pending |
| Medium | Aggregated pretty export format | Medium | Pending |
| Low | Category-specific sampling/filtering | Medium | Pending |
| Future | Trace viewer UI with collapsible groups | Large | Pending |
| Future | Disk persistence for crash debugging | Large | Pending |

For now, the current implementation is safe for typical usage. Monitor real-world usage patterns before adding complexity.
