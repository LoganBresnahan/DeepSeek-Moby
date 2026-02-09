/**
 * WebviewTracer
 *
 * Collects trace events from the webview and syncs them to the extension.
 * Provides unified observability across the extension/webview boundary.
 */

import type {
  WebviewTraceEvent,
  WebviewTraceCategory,
  WebviewTraceOptions,
  WebviewSpanOptions,
  WebviewSpanResult,
  WebviewTracerConfig,
  WebviewTraceSubscriber,
  TraceLevel
} from './types';
import type { VSCodeAPI } from '../state/types';

/** Level priority for filtering */
const LEVEL_PRIORITY: Record<TraceLevel, number> = {
  'debug': 0,
  'info': 1,
  'warn': 2,
  'error': 3
};

/**
 * Generate a unique ID for events.
 */
function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * WebviewTracer singleton for collecting webview trace events.
 */
export class WebviewTracer {
  private static instance: WebviewTracer;

  private buffer: WebviewTraceEvent[] = [];
  private spanStack = new Map<string, WebviewTraceEvent>();
  private subscribers: WebviewTraceSubscriber[] = [];
  private startTime: number;
  private vscode: VSCodeAPI | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;

  private config: WebviewTracerConfig = {
    enabled: true,
    minLevel: 'info',
    maxBufferSize: 500,
    syncIntervalMs: 5000  // Sync every 5 seconds
  };

  private constructor() {
    this.startTime = performance.now();
  }

  /**
   * Get the singleton instance.
   */
  public static getInstance(): WebviewTracer {
    if (!WebviewTracer.instance) {
      WebviewTracer.instance = new WebviewTracer();
    }
    return WebviewTracer.instance;
  }

  /**
   * Initialize with VS Code API for syncing to extension.
   */
  initialize(vscode: VSCodeAPI): void {
    this.vscode = vscode;

    // Start auto-sync if configured
    if (this.config.syncIntervalMs > 0) {
      this.startSyncTimer();
    }
  }

  /**
   * Configure the tracer.
   */
  configure(options: Partial<WebviewTracerConfig>): void {
    const oldSyncInterval = this.config.syncIntervalMs;
    this.config = { ...this.config, ...options };

    // Handle sync timer changes
    if (this.config.syncIntervalMs !== oldSyncInterval) {
      if (this.config.syncIntervalMs > 0) {
        this.startSyncTimer();
      } else {
        this.stopSyncTimer();
      }
    }
  }

  /**
   * Start the auto-sync timer.
   */
  private startSyncTimer(): void {
    this.stopSyncTimer();
    this.syncTimer = setInterval(() => this.syncToExtension(), this.config.syncIntervalMs);
  }

  /**
   * Stop the auto-sync timer.
   */
  private stopSyncTimer(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  /**
   * Check if a trace at given level should be recorded.
   */
  private shouldTrace(level: TraceLevel): boolean {
    if (!this.config.enabled) return false;
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.config.minLevel];
  }

  /**
   * Generate a correlation ID for a new flow.
   */
  startFlow(): string {
    return generateId('wv-flow');
  }

  /**
   * Start a span for an async operation.
   */
  startSpan(
    category: WebviewTraceCategory,
    operation: string,
    options: WebviewSpanOptions = {}
  ): string {
    const level = options.level || 'info';
    if (!this.shouldTrace(level)) {
      return '';
    }

    const id = generateId('wv-span');
    const event: WebviewTraceEvent = {
      id,
      correlationId: options.correlationId || this.startFlow(),
      parentId: options.parentId,
      timestamp: new Date().toISOString(),
      relativeTime: performance.now() - this.startTime,
      source: 'webview',
      category,
      operation,
      executionMode: options.executionMode || 'async',
      level,
      status: 'started',
      data: options.data
    };

    this.spanStack.set(id, event);
    this.emit(event);
    return id;
  }

  /**
   * End a span.
   */
  endSpan(spanId: string, result?: WebviewSpanResult): void {
    if (!spanId) return;

    const startEvent = this.spanStack.get(spanId);
    if (!startEvent) {
      console.warn(`[WebviewTracer] Attempted to end unknown span: ${spanId}`);
      return;
    }

    const now = performance.now() - this.startTime;
    const endEvent: WebviewTraceEvent = {
      ...startEvent,
      id: `${spanId}-end`,
      timestamp: new Date().toISOString(),
      relativeTime: now,
      duration: now - startEvent.relativeTime,
      status: result?.status || 'completed',
      error: result?.error,
      data: result?.data ? { ...startEvent.data, ...result.data } : startEvent.data
    };

    this.spanStack.delete(spanId);
    this.emit(endEvent);
  }

  /**
   * Record a simple trace event.
   */
  trace(
    category: WebviewTraceCategory,
    operation: string,
    options: WebviewTraceOptions = {}
  ): string {
    const level = options.level || 'info';
    if (!this.shouldTrace(level)) {
      return '';
    }

    const id = generateId('wv-evt');
    const event: WebviewTraceEvent = {
      id,
      correlationId: options.correlationId || 'standalone',
      timestamp: new Date().toISOString(),
      relativeTime: performance.now() - this.startTime,
      source: 'webview',
      category,
      operation,
      executionMode: options.executionMode || 'sync',
      level,
      status: 'completed',
      data: options.data
    };

    this.emit(event);
    return id;
  }

  /**
   * Emit an event to the buffer and subscribers.
   */
  private emit(event: WebviewTraceEvent): void {
    // Add to buffer
    this.buffer.push(event);

    // Evict oldest if over limit
    if (this.buffer.length > this.config.maxBufferSize) {
      this.buffer.shift();
    }

    // Notify subscribers
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch (err) {
        console.error('[WebviewTracer] Subscriber error:', err);
      }
    }
  }

  /**
   * Subscribe to trace events.
   */
  subscribe(callback: WebviewTraceSubscriber): () => void {
    this.subscribers.push(callback);
    return () => {
      const index = this.subscribers.indexOf(callback);
      if (index !== -1) {
        this.subscribers.splice(index, 1);
      }
    };
  }

  /**
   * Sync buffered events to the extension.
   */
  syncToExtension(): void {
    if (!this.vscode || this.buffer.length === 0) return;

    // Send events to extension
    this.vscode.postMessage({
      type: 'traceEvents',
      events: this.buffer
    });

    // Clear buffer after sync
    this.buffer = [];
  }

  /**
   * Get all buffered events.
   */
  getAll(): WebviewTraceEvent[] {
    return [...this.buffer];
  }

  /**
   * Get buffer size.
   */
  get size(): number {
    return this.buffer.length;
  }

  /**
   * Check if tracing is enabled.
   */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Enable or disable tracing.
   */
  set enabled(value: boolean) {
    this.config.enabled = value;
  }

  /**
   * Clear the buffer.
   */
  clear(): void {
    this.buffer = [];
    this.spanStack.clear();
  }

  /**
   * Dispose the tracer.
   */
  dispose(): void {
    this.stopSyncTimer();
    this.clear();
    this.vscode = null;
  }

  /**
   * Reset the relative time counter.
   */
  resetTimer(): void {
    this.startTime = performance.now();
  }

  // ============================================
  // Convenience methods for common trace patterns
  // ============================================

  /**
   * Trace a pub/sub publication.
   */
  tracePublish(actorId: string, keys: string[], chainDepth: number = 0): void {
    this.trace('state.publish', actorId, {
      level: 'debug',
      data: { keys, chainDepth }
    });
  }

  /**
   * Trace a subscription handler call.
   */
  traceSubscribe(actorId: string, key: string, handlerName?: string): void {
    this.trace('state.subscribe', actorId, {
      level: 'debug',
      data: { key, handler: handlerName }
    });
  }

  /**
   * Trace actor creation.
   */
  traceActorCreate(actorId: string, actorType: string): void {
    this.trace('actor.create', actorId, {
      level: 'info',
      data: { type: actorType }
    });
  }

  /**
   * Trace actor destruction.
   */
  traceActorDestroy(actorId: string): void {
    this.trace('actor.destroy', actorId, {
      level: 'info'
    });
  }

  /**
   * Trace actor bind (pool actor bound to turn).
   */
  traceActorBind(actorId: string, turnId: string): void {
    this.trace('actor.bind', actorId, {
      level: 'info',
      data: { turnId }
    });
  }

  /**
   * Trace actor unbind (pool actor released).
   */
  traceActorUnbind(actorId: string, turnId: string): void {
    this.trace('actor.unbind', actorId, {
      level: 'info',
      data: { turnId }
    });
  }

  /**
   * Trace bridge message sent to extension.
   */
  traceBridgeSend(messageType: string, data?: Record<string, unknown>): void {
    this.trace('bridge.send', messageType, {
      level: 'debug',
      data
    });
  }

  /**
   * Trace bridge message received from extension.
   */
  traceBridgeReceive(messageType: string, data?: Record<string, unknown>): void {
    this.trace('bridge.receive', messageType, {
      level: 'debug',
      data
    });
  }

  /**
   * Trace turn render.
   */
  traceRenderTurn(turnId: string, role: string): void {
    this.trace('render.turn', turnId, {
      level: 'debug',
      data: { role }
    });
  }

  /**
   * Trace segment update.
   */
  traceRenderSegment(segmentId: string, segmentType: string): void {
    this.trace('render.segment', segmentId, {
      level: 'debug',
      data: { type: segmentType }
    });
  }

  /**
   * Trace user click.
   */
  traceUserClick(elementId: string, elementType?: string): void {
    this.trace('user.click', elementId, {
      level: 'info',
      data: { type: elementType }
    });
  }

  /**
   * Trace user input.
   */
  traceUserInput(inputType: string, data?: Record<string, unknown>): void {
    this.trace('user.input', inputType, {
      level: 'info',
      data
    });
  }
}

// Export singleton instance
export const webviewTracer = WebviewTracer.getInstance();
