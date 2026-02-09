# Tracing System Architecture

Cross-boundary tracing for unified observability across extension and webview.

---

## Overview

The tracing system provides structured event collection for debugging and AI-agent observability. It captures events from both the VS Code extension (Node.js) and the webview (browser), correlating them into a unified timeline.

**Key capabilities:**
- Structured trace events with categories, levels, and correlation IDs
- Cross-boundary correlation linking extension and webview events
- Ring buffer with configurable size and time-based eviction
- Multiple export formats (JSON, JSONL, Pretty)
- Memory monitoring and payload truncation

---

## System Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              VS Code Extension Host                              │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                         TraceCollector (Singleton)                       │    │
│  │                                                                          │    │
│  │  • Ring buffer (max 10,000 events)                                       │    │
│  │  • Correlation registry (correlationId → event IDs)                      │    │
│  │  • Span stack (for async operation tracking)                             │    │
│  │  • Memory monitoring (estimateMemoryBytes, warnAtMemoryMB)               │    │
│  │  • Export formats: JSON, JSONL, Pretty                                   │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                          ▲                                                       │
│                          │ mergeWebviewEvents()                                  │
│                          │                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                         chatProvider.ts                                  │    │
│  │                                                                          │    │
│  │  • Handles traceEvents messages from webview                             │    │
│  │  • Sends traceCalibration on webviewReady                                │    │
│  │  • Sends requestTraceSync on visibility change                           │    │
│  │  • Sends traceSyncAck after receiving events                             │    │
│  │  • Passes correlationId in startResponse message                         │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                          ▲                                                       │
│                          │ postMessage                                           │
└──────────────────────────┼──────────────────────────────────────────────────────┘
                           │
┌──────────────────────────┼──────────────────────────────────────────────────────┐
│                          ▼                        Webview (Browser)              │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                         WebviewTracer (Singleton)                        │    │
│  │                                                                          │    │
│  │  • Local event buffer (syncs to extension periodically)                  │    │
│  │  • Receives correlationId from extension for cross-boundary linking      │    │
│  │  • Receives calibration data for time alignment                          │    │
│  │  • Tracks pending sync count for acknowledgment                          │    │
│  │  • Auto-sync on init, visibility change, and 5-second interval           │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                          ▲                                                       │
│                          │ setTracer()                                           │
│                          │                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                       EventStateManager                                  │    │
│  │                                                                          │    │
│  │  • Calls tracer on: register, unregister, handleStateChange, broadcast   │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                          ▲                                                       │
│                          │                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                    VirtualMessageGatewayActor                            │    │
│  │                                                                          │    │
│  │  • Sets correlationId on WebviewTracer when startResponse received       │    │
│  │  • Traces actor bind/unbind events via VirtualListActor                  │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Key Files

| File | Purpose |
|------|---------|
| `src/tracing/types.ts` | TraceEvent, TraceCategory, TraceCollectorConfig types |
| `src/tracing/TraceCollector.ts` | Extension-side singleton tracer with ring buffer |
| `src/utils/logger.ts` | Enhanced logger that emits traces for API, tool, shell, session events |
| `src/providers/chatProvider.ts` | Bridge between extension and webview traces |
| `media/tracing/types.ts` | WebviewTraceEvent, WebviewTraceCategory types |
| `media/tracing/WebviewTracer.ts` | Webview-side singleton tracer |
| `media/state/EventStateManager.ts` | Pub/sub manager with tracer integration |

---

## Message Flow (Extension ↔ Webview)

```
Extension                              Webview
    │                                      │
    │  ◄────── webviewReady ──────────────│  (webview initialized)
    │                                      │
    │  ─────── traceCalibration ─────────►│  (extensionStartTime, correlationId)
    │                                      │
    │  ─────── startResponse ────────────►│  (includes correlationId)
    │                                      │
    │         ... streaming ...            │
    │                                      │
    │  ◄────── traceEvents ───────────────│  (batched webview events)
    │                                      │
    │  ─────── traceSyncAck ─────────────►│  (confirms receipt)
    │                                      │
    │  ─────── requestTraceSync ─────────►│  (on visibility change)
    │                                      │
    │  ◄────── traceEvents ───────────────│  (immediate sync)
    │                                      │
```

---

## Cross-Boundary Correlation

Events from both extension and webview share correlation IDs for unified timeline:

1. **Extension starts API flow** → generates `correlationId` via `tracer.startFlow()`
2. **Extension sends `startResponse`** → includes `correlationId` in message
3. **Webview receives `startResponse`** → `VirtualMessageGatewayActor` sets `correlationId` on `WebviewTracer`
4. **Webview emits events** → uses extension's `correlationId` as fallback
5. **Webview syncs to extension** → `TraceCollector.mergeWebviewEvents()` aligns timestamps
6. **Export trace** → chronologically sorted events from both sources

---

## Time Alignment

The extension and webview have independent `performance.now()` baselines. To align:

1. Extension sends `traceCalibration` with its current ISO timestamp
2. Webview stores calibration data
3. On merge, extension adjusts webview event timestamps relative to calibration point
4. Exported traces show unified wall-clock timestamps with normalized `relativeTime`

---

## Trace Event Schema

```typescript
interface TraceEvent {
  // Identification
  id: string;                     // Unique event ID
  correlationId: string;          // Links related events (request → response)
  parentId?: string;              // For nested operations

  // Timing
  timestamp: string;              // ISO 8601 wall-clock time
  relativeTime: number;           // ms since tracer start
  duration?: number;              // For completed spans

  // Classification
  source: 'extension' | 'webview';
  category: TraceCategory;
  operation: string;

  // Execution mode
  executionMode: 'sync' | 'async' | 'callback';

  // Level (for filtering)
  level: 'debug' | 'info' | 'warn' | 'error';

  // Payload
  data?: Record<string, unknown>;

  // Status (for spans)
  status?: 'started' | 'completed' | 'failed';
  error?: string;
}
```

---

## Trace Categories

| Category | Source | Description |
|----------|--------|-------------|
| `api.request` | Extension | Outbound API call started |
| `api.stream` | Extension | Streaming token/chunk received |
| `api.response` | Extension | API call completed |
| `tool.call` | Extension | Tool execution started |
| `tool.result` | Extension | Tool execution completed |
| `shell.execute` | Extension | Shell command started |
| `shell.result` | Extension | Shell command completed |
| `state.publish` | Webview | Pub/sub state published |
| `state.subscribe` | Webview | Subscription handler triggered |
| `actor.create` | Webview | Actor instantiated |
| `actor.bind` | Webview | Pool actor bound to turn |
| `actor.unbind` | Webview | Pool actor released |
| `bridge.send` | Both | postMessage sent |
| `bridge.receive` | Both | postMessage received |
| `render.turn` | Webview | Turn rendered |
| `session.create` | Extension | New session created |
| `session.load` | Extension | Session loaded from history |

---

## Export Formats

| Format | Description | Use Case |
|--------|-------------|----------|
| `json` | Pretty-printed JSON array | Programmatic analysis, debugging |
| `jsonl` | One JSON object per line | LLM analysis, log processing |
| `pretty` | Human-readable with aggregation | Quick visual inspection |

### Pretty Format with Aggregation

The `pretty` format collapses consecutive repeated events for readability while preserving complete data in JSON/JSONL exports.

**Example output:**

```
     0.0ms 2026-02-09T03:21:15.123Z > [extension] [api.request] deepseek-chat
     0.1ms 2026-02-09T03:21:15.124Z < [webview] [actor.bind] turn-1
           ... 45 similar actor.bind events (0.1-25.0ms) - see JSONL for full data
    25.0ms 2026-02-09T03:21:15.148Z < [webview] [actor.bind] turn-47
    25.1ms 2026-02-09T03:21:15.149Z < [extension] [api.stream] first-token
   150.0ms 2026-02-09T03:21:15.273Z < [extension] [api.response] complete (150.0ms)
```

**Aggregation algorithm:**

1. Events are grouped by consecutive `category` (e.g., `actor.bind`, `state.publish`)
2. Groups with **1-2 events**: All events shown individually
3. Groups with **3+ events**: First event, collapse indicator, last event
4. Different categories always start a new group

**Collapse indicator format:**
```
... {count} similar {category} events ({startTime}-{endTime}ms) - see JSONL for full data
```

**Why this approach:**
- **No data loss**: Full event data preserved in JSON/JSONL exports
- **Readability**: High-frequency events (actor binds, state publishes) don't flood the output
- **Debugging**: First and last events preserved to show when a burst started/ended
- **Clear indicator**: Points users to JSONL for complete data

---

## Configuration

```typescript
interface TraceCollectorConfig {
  maxBufferSize: number;     // Ring buffer size (default: 10,000)
  maxAgeMs: number;          // Time-based eviction (0 = disabled)
  maxPayloadSize: number;    // Truncate data > N bytes (default: 1000)
  warnAtMemoryMB: number;    // Emit warning at N MB (0 = disabled)
  minLevel: TraceLevel;      // Minimum level to record (default: 'info')
  enabled: boolean;          // Master enable/disable
  logToOutput: boolean;      // Also log to VS Code Output channel
}
```

---

## Memory Management

### Ring Buffer
- Fixed-size buffer drops oldest events when full
- Correlation map cleaned up when events are evicted

### Payload Truncation
- Data payloads > `maxPayloadSize` are truncated
- Truncated payloads include `_truncated: true` and `_originalSize`

### Memory Monitoring
- `estimateMemoryBytes()` returns approximate buffer size
- `warnAtMemoryMB` triggers console warning at threshold
- Warning resets when memory drops below 80% of threshold

---

## Usage Examples

### Extension Side (logger integration)

```typescript
// Logger methods automatically emit traces
logger.apiRequest('deepseek-chat', 5, false);
// → Emits api.request trace with correlationId

logger.toolCall('read_file');
// → Emits tool.call trace

logger.shellExecuting('ls -la');
// → Emits shell.execute trace
```

### Extension Side (direct tracer)

```typescript
import { tracer } from './tracing/TraceCollector';

// Start a flow for correlation
const correlationId = tracer.startFlow();

// Start an async span
const spanId = tracer.startSpan('api.request', 'deepseek-chat', {
  correlationId,
  data: { messageCount: 5 }
});

// ... async work ...

// End the span
tracer.endSpan(spanId, { status: 'completed', data: { tokens: 342 } });
```

### Webview Side

```typescript
import { WebviewTracer } from './tracing/WebviewTracer';

const tracer = WebviewTracer.getInstance();

// Trace actor lifecycle
tracer.traceActorCreate('MessageTurnActor', { turnId: 'turn-1' });
tracer.traceActorBind('turn-1', 'actor-1');

// Trace state changes
tracer.tracePublish('streaming.content', ['text']);

// Trace user interactions
tracer.traceUserClick('send-button', { messageLength: 42 });
```

---

## Test Coverage

| Test File | Tests | Coverage |
|-----------|-------|----------|
| `tests/unit/tracing/TraceCollector.test.ts` | 50+ | Ring buffer, spans, correlation, export, memory |
| `tests/unit/tracing/WebviewTracer.test.ts` | 37 | Sync, calibration, correlation propagation, time drift diagnostics |

---

## Time Drift Detection

### The Problem

In WSL2 environments, the extension host (running in Linux) and the webview (running in Windows/Chromium) can have different system clocks. WSL2's clock can drift from the Windows host, especially after sleep/hibernate. This causes trace events from the webview to appear minutes ahead of or behind extension events.

### Detection Mechanism

When the webview syncs trace events to the extension, it includes diagnostic timestamps:

```typescript
// WebviewTracer.syncToExtension()
this.vscode.postMessage({
  type: 'traceEvents',
  events: this.buffer,
  webviewSyncTime: new Date().toISOString(),    // Webview's current time
  webviewRelativeTime: performance.now() - this.startTime
});
```

The extension compares its current time with the webview's sync time:

```typescript
// chatProvider.ts - traceEvents handler
if (data.webviewSyncTime) {
  const extensionNow = new Date().toISOString();
  const diffMs = new Date(extensionNow).getTime() - new Date(webviewSyncTime).getTime();
  if (Math.abs(diffMs) > 1000) {
    logger.warn(`[Trace] Time drift detected: extension=${extensionNow} webview=${webviewSyncTime} diff=${diffMs}ms`);
  }
}
```

### Diagnosing Time Drift

Use the **"Moby: Trace Stats"** command to see time alignment diagnostics:

```
=== TIME ALIGNMENT DIAGNOSTICS ===
Current Extension Time: 2026-02-09T05:39:27.790Z

Extension Events:
  First: 2026-02-09T05:39:22.439Z
  Last:  2026-02-09T05:39:27.780Z
  Span:  5.34s

Webview Events:
  First: 2026-02-09T05:52:02.100Z
  Last:  2026-02-09T05:52:02.771Z
  Span:  0.67s

Cross-Boundary Gap:
  Gap: 754320ms (12.57 minutes)
  (Extension last -> Webview first)

*** WARNING: Large time gap detected! ***
```

### Fixing WSL2 Clock Drift

If you see time drift warnings, sync your WSL2 clock:

```bash
# Quick fix - sync hardware clock
sudo hwclock -s

# Or sync with NTP server
sudo ntpdate time.windows.com

# Permanent fix - enable NTP
sudo apt install ntpdate
sudo timedatectl set-ntp true
```

### Why This Matters

- Trace events are sorted by timestamp for the unified timeline
- Clock drift causes webview events to appear out of order
- Large gaps (10+ minutes) indicate environment clock issues, not code bugs
- The `relativeTime` normalization in export helps, but raw timestamps will still be off

---

## Related Documentation

- [Logging System](../reference/logging-system.md) - Logger integration details
- [Message Bridge](./message-bridge.md) - Extension ↔ Webview communication
- [Chat Streaming](./chat-streaming.md) - Streaming flow that generates traces
