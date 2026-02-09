/**
 * Tracing System Types
 *
 * Defines the schema for trace events used across the extension and webview.
 * Traces provide structured observability for AI-agent debugging.
 */

/**
 * Categories for trace events.
 * Organized by domain for easy filtering.
 */
export type TraceCategory =
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

/**
 * Source of the trace event.
 */
export type TraceSource = 'extension' | 'webview' | 'bridge';

/**
 * Execution mode for the operation.
 * Helps AI agents understand the flow of async operations.
 */
export type ExecutionMode = 'sync' | 'async' | 'callback';

/**
 * Log level for filtering.
 */
export type TraceLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Status of an operation.
 */
export type TraceStatus = 'started' | 'completed' | 'failed';

/**
 * A single trace event.
 * Designed to be human-readable and LLM-parseable.
 */
export interface TraceEvent {
  // Identification
  /** Unique event ID */
  id: string;
  /** Links related events (e.g., request → response) */
  correlationId: string;
  /** For nested operations */
  parentId?: string;

  // Timing
  /** ISO timestamp for cross-boundary correlation */
  timestamp: string;
  /** High-resolution relative time (performance.now()) for duration calculations */
  relativeTime: number;
  /** Duration in milliseconds for completed operations */
  duration?: number;

  // Classification
  /** Where this event originated */
  source: TraceSource;
  /** Event category for filtering */
  category: TraceCategory;
  /** Specific operation name */
  operation: string;

  // Sync/Async marker
  /** Whether this operation is sync, async, or a callback */
  executionMode: ExecutionMode;

  // Level (for filtering)
  /** Log level for filtering by importance */
  level: TraceLevel;

  // Payload
  /** Additional data about the event */
  data?: Record<string, unknown>;

  // Status (for operations with outcomes)
  /** Operation status */
  status?: TraceStatus;
  /** Error message if failed */
  error?: string;
}

/**
 * Options for starting a span (async operation).
 */
export interface SpanOptions {
  /** Correlation ID to link with other events */
  correlationId?: string;
  /** Parent span ID for nested operations */
  parentId?: string;
  /** Execution mode (defaults to 'async') */
  executionMode?: ExecutionMode;
  /** Additional data */
  data?: Record<string, unknown>;
  /** Log level (defaults to 'info') */
  level?: TraceLevel;
}

/**
 * Options for a simple trace event.
 */
export interface TraceOptions {
  /** Correlation ID to link with other events */
  correlationId?: string;
  /** Execution mode (defaults to 'sync') */
  executionMode?: ExecutionMode;
  /** Log level (defaults to 'info') */
  level?: TraceLevel;
  /** Additional data */
  data?: Record<string, unknown>;
}

/**
 * Options for importing an external event (e.g., from webview).
 * Allows preserving the original timestamp and ID.
 */
export interface ImportEventOptions {
  /** Original event ID (will be prefixed with 'imported-') */
  originalId: string;
  /** Original ISO timestamp to preserve chronological order */
  timestamp: string;
  /** Original relative time from the source */
  originalRelativeTime?: number;
  /** Correlation ID to link with other events */
  correlationId?: string;
  /** Execution mode (defaults to 'sync') */
  executionMode?: ExecutionMode;
  /** Log level (defaults to 'info') */
  level?: TraceLevel;
  /** Additional data */
  data?: Record<string, unknown>;
  /** Operation status */
  status?: TraceStatus;
}

/**
 * Result when ending a span.
 */
export interface SpanResult {
  /** Final status */
  status: 'completed' | 'failed';
  /** Error message if failed */
  error?: string;
  /** Additional result data */
  data?: Record<string, unknown>;
}

/**
 * Callback for trace subscribers.
 */
export type TraceSubscriber = (event: TraceEvent) => void;

/**
 * Export format for traces.
 */
export type ExportFormat = 'json' | 'jsonl' | 'pretty';

/**
 * Configuration for the TraceCollector.
 */
export interface TraceCollectorConfig {
  /** Maximum number of events to keep in the buffer */
  maxBufferSize: number;
  /** Whether to also log traces to the extension logger */
  logToOutput: boolean;
  /** Minimum level to trace (events below this level are ignored) */
  minLevel: TraceLevel;
  /** Whether tracing is enabled */
  enabled: boolean;
  /** Maximum age in milliseconds for events (0 = no time-based eviction) */
  maxAgeMs: number;
  /** Maximum size for data payloads in bytes before truncation (0 = no limit) */
  maxPayloadSize: number;
  /** Warn when estimated memory exceeds this threshold in MB (0 = no warning) */
  warnAtMemoryMB: number;
}

/**
 * Statistics about the trace buffer.
 */
export interface TraceBufferStats {
  /** Number of events in buffer */
  eventCount: number;
  /** Estimated memory usage in bytes */
  estimatedMemoryBytes: number;
  /** Number of correlation IDs tracked */
  correlationCount: number;
  /** Number of pending spans */
  pendingSpanCount: number;
  /** Oldest event timestamp (if any) */
  oldestEventTime?: string;
  /** Newest event timestamp (if any) */
  newestEventTime?: string;
}
