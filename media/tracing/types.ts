/**
 * Webview Tracing Types
 *
 * Mirrors the extension-side trace types for unified tracing.
 * Events are collected in the webview and synced to the extension.
 */

/**
 * Categories for webview trace events.
 */
export type WebviewTraceCategory =
  // State Management
  | 'state.publish'     // Pub/sub publication
  | 'state.subscribe'   // Subscription triggered

  // Actor Lifecycle
  | 'actor.create'      // Actor instantiated
  | 'actor.destroy'     // Actor destroyed
  | 'actor.bind'        // Pool actor bound to turn
  | 'actor.unbind'      // Pool actor released

  // Message Bridge
  | 'bridge.send'       // postMessage to extension
  | 'bridge.receive'    // Message received from extension

  // UI Rendering
  | 'render.turn'       // Turn rendered
  | 'render.segment'    // Segment updated
  | 'render.scroll'     // Scroll position

  // User Actions
  | 'user.input'        // User typed/submitted
  | 'user.click'        // User clicked UI element
  | 'user.selection';   // User selected option

/**
 * Execution mode for the operation.
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
 * A webview trace event.
 * Compatible with extension TraceEvent for unified timeline.
 */
export interface WebviewTraceEvent {
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
  /** High-resolution relative time (performance.now()) */
  relativeTime: number;
  /** Duration in milliseconds for completed operations */
  duration?: number;

  // Classification
  /** Source is always 'webview' for these events */
  source: 'webview';
  /** Event category for filtering */
  category: WebviewTraceCategory;
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
 * Options for simple trace events.
 */
export interface WebviewTraceOptions {
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
 * Options for starting a span.
 */
export interface WebviewSpanOptions extends WebviewTraceOptions {
  /** Parent span ID for nested operations */
  parentId?: string;
}

/**
 * Result when ending a span.
 */
export interface WebviewSpanResult {
  /** Final status */
  status: 'completed' | 'failed';
  /** Error message if failed */
  error?: string;
  /** Additional result data */
  data?: Record<string, unknown>;
}

/**
 * Configuration for the WebviewTracer.
 */
export interface WebviewTracerConfig {
  /** Whether tracing is enabled */
  enabled: boolean;
  /** Minimum level to trace */
  minLevel: TraceLevel;
  /** Maximum events to buffer before sync */
  maxBufferSize: number;
  /** Auto-sync interval in ms (0 = manual sync only) */
  syncIntervalMs: number;
}

/**
 * Callback for trace subscribers.
 */
export type WebviewTraceSubscriber = (event: WebviewTraceEvent) => void;
