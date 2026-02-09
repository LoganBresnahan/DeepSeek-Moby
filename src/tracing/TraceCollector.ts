/**
 * TraceCollector
 *
 * Unified tracing system for the extension.
 * Collects structured trace events for debugging and AI-agent observability.
 */

import {
  TraceEvent,
  TraceCategory,
  TraceSubscriber,
  SpanOptions,
  SpanResult,
  TraceOptions,
  ExportFormat,
  TraceCollectorConfig,
  TraceLevel,
  TraceBufferStats
} from './types';

/**
 * Log output callback type.
 * Used for optional integration with external loggers.
 */
type LogOutputCallback = (level: TraceLevel, message: string, details?: string) => void;

/** Level priority for filtering */
const LEVEL_PRIORITY: Record<TraceLevel, number> = {
  'debug': 0,
  'info': 1,
  'warn': 2,
  'error': 3
};

/**
 * Generates a unique ID for events and flows.
 */
function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * TraceCollector singleton for collecting and managing trace events.
 */
export class TraceCollector {
  private static instance: TraceCollector;

  private buffer: TraceEvent[] = [];
  private correlations = new Map<string, string[]>();
  private subscribers: TraceSubscriber[] = [];
  private spanStack = new Map<string, TraceEvent>();
  private startTime: number;

  private config: TraceCollectorConfig = {
    maxBufferSize: 10000,
    logToOutput: false,
    minLevel: 'info',
    enabled: true,
    maxAgeMs: 0,              // No time-based eviction by default
    maxPayloadSize: 1000,     // Truncate data payloads > 1KB
    warnAtMemoryMB: 0         // No memory warning by default
  };

  private logOutput: LogOutputCallback | null = null;
  private evictionTimer: ReturnType<typeof setInterval> | null = null;
  private memoryWarningEmitted = false;

  private constructor() {
    this.startTime = performance.now();
  }

  /**
   * Get the singleton instance.
   */
  public static getInstance(): TraceCollector {
    if (!TraceCollector.instance) {
      TraceCollector.instance = new TraceCollector();
    }
    return TraceCollector.instance;
  }

  /**
   * Configure the trace collector.
   */
  configure(options: Partial<TraceCollectorConfig>): void {
    const oldMaxAgeMs = this.config.maxAgeMs;
    this.config = { ...this.config, ...options };

    // Handle time-based eviction timer
    if (this.config.maxAgeMs > 0 && oldMaxAgeMs !== this.config.maxAgeMs) {
      this.startEvictionTimer();
    } else if (this.config.maxAgeMs === 0 && this.evictionTimer) {
      this.stopEvictionTimer();
    }
  }

  /**
   * Start the time-based eviction timer.
   */
  private startEvictionTimer(): void {
    this.stopEvictionTimer();
    // Check every 10% of maxAgeMs, minimum 1 second, maximum 60 seconds
    const interval = Math.max(1000, Math.min(60000, this.config.maxAgeMs / 10));
    this.evictionTimer = setInterval(() => this.evictOldEvents(), interval);
  }

  /**
   * Stop the time-based eviction timer.
   */
  private stopEvictionTimer(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
  }

  /**
   * Evict events older than maxAgeMs.
   */
  private evictOldEvents(): void {
    if (this.config.maxAgeMs <= 0 || this.buffer.length === 0) return;

    const cutoffTime = Date.now() - this.config.maxAgeMs;
    const cutoffISO = new Date(cutoffTime).toISOString();

    // Find index of first event that's young enough to keep
    let evictCount = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      if (this.buffer[i].timestamp >= cutoffISO) {
        break;
      }
      evictCount++;
    }

    if (evictCount > 0) {
      // Get IDs of events being evicted for correlation cleanup
      const evictedIds = new Set(this.buffer.slice(0, evictCount).map(e => e.id));
      this.buffer.splice(0, evictCount);
      this.cleanupCorrelations(evictedIds);
    }
  }

  /**
   * Clean up correlation map entries for evicted events.
   */
  private cleanupCorrelations(evictedIds: Set<string>): void {
    for (const [correlationId, eventIds] of this.correlations.entries()) {
      const remaining = eventIds.filter(id => !evictedIds.has(id));
      if (remaining.length === 0) {
        this.correlations.delete(correlationId);
      } else if (remaining.length !== eventIds.length) {
        this.correlations.set(correlationId, remaining);
      }
    }
  }

  /**
   * Truncate data payload if it exceeds maxPayloadSize.
   */
  private truncatePayload(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!data || this.config.maxPayloadSize <= 0) return data;

    const serialized = JSON.stringify(data);
    if (serialized.length <= this.config.maxPayloadSize) return data;

    return {
      _truncated: true,
      _originalSize: serialized.length,
      preview: serialized.slice(0, Math.min(200, this.config.maxPayloadSize))
    };
  }

  /**
   * Estimate memory usage of the trace buffer in bytes.
   */
  estimateMemoryBytes(): number {
    // Rough estimate: ~300 bytes base per event + data payload size
    let totalBytes = 0;
    for (const event of this.buffer) {
      totalBytes += 300; // Base object overhead
      if (event.data) {
        totalBytes += JSON.stringify(event.data).length * 2; // UTF-16 string overhead
      }
      if (event.error) {
        totalBytes += event.error.length * 2;
      }
    }
    // Add correlation map overhead
    totalBytes += this.correlations.size * 100;
    return totalBytes;
  }

  /**
   * Check memory usage and emit warning if threshold exceeded.
   */
  private checkMemoryWarning(): void {
    if (this.config.warnAtMemoryMB <= 0) return;

    const memoryBytes = this.estimateMemoryBytes();
    const memoryMB = memoryBytes / (1024 * 1024);

    if (memoryMB >= this.config.warnAtMemoryMB && !this.memoryWarningEmitted) {
      console.warn(`[TraceCollector] High memory usage: ${memoryMB.toFixed(2)}MB (threshold: ${this.config.warnAtMemoryMB}MB)`);
      this.memoryWarningEmitted = true;
    } else if (memoryMB < this.config.warnAtMemoryMB * 0.8) {
      // Reset warning when memory drops below 80% of threshold
      this.memoryWarningEmitted = false;
    }
  }

  /**
   * Get buffer statistics.
   */
  getStats(): TraceBufferStats {
    return {
      eventCount: this.buffer.length,
      estimatedMemoryBytes: this.estimateMemoryBytes(),
      correlationCount: this.correlations.size,
      pendingSpanCount: this.spanStack.size,
      oldestEventTime: this.buffer[0]?.timestamp,
      newestEventTime: this.buffer[this.buffer.length - 1]?.timestamp
    };
  }

  /**
   * Set a callback for logging trace events to an external logger.
   * This avoids circular dependencies with the logger module.
   */
  setLogOutput(callback: LogOutputCallback | null): void {
    this.logOutput = callback;
  }

  /**
   * Check if a trace at given level should be recorded.
   */
  private shouldTrace(level: TraceLevel): boolean {
    if (!this.config.enabled) return false;
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.config.minLevel];
  }

  /**
   * Generate a correlation ID for a new request flow.
   */
  startFlow(): string {
    return generateId('flow');
  }

  /**
   * Start a span for an async operation.
   * Returns a span ID that should be passed to endSpan() when the operation completes.
   */
  startSpan(
    category: TraceCategory,
    operation: string,
    options: SpanOptions = {}
  ): string {
    const level = options.level || 'info';
    if (!this.shouldTrace(level)) {
      return ''; // Return empty string for disabled traces
    }

    const id = generateId('span');
    const correlationId = options.correlationId || this.startFlow();

    const event: TraceEvent = {
      id,
      correlationId,
      parentId: options.parentId,
      timestamp: new Date().toISOString(),
      relativeTime: performance.now() - this.startTime,
      source: 'extension',
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
   * End a span that was started with startSpan().
   */
  endSpan(spanId: string, result?: SpanResult): void {
    if (!spanId) return; // Handle empty span IDs from disabled traces

    const startEvent = this.spanStack.get(spanId);
    if (!startEvent) {
      console.warn(`[TraceCollector] Attempted to end unknown span: ${spanId}`);
      return;
    }

    const now = performance.now() - this.startTime;
    const endEvent: TraceEvent = {
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
   * Record a simple trace event (for sync operations or standalone events).
   */
  trace(
    category: TraceCategory,
    operation: string,
    options: TraceOptions = {}
  ): string {
    const level = options.level || 'info';
    if (!this.shouldTrace(level)) {
      return '';
    }

    const id = generateId('evt');
    const event: TraceEvent = {
      id,
      correlationId: options.correlationId || 'standalone',
      timestamp: new Date().toISOString(),
      relativeTime: performance.now() - this.startTime,
      source: 'extension',
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
  private emit(event: TraceEvent): void {
    // Truncate payload if needed
    if (event.data) {
      event.data = this.truncatePayload(event.data);
    }

    // Add to buffer (ring buffer behavior)
    this.buffer.push(event);

    // Evict oldest if over limit, with correlation cleanup
    if (this.buffer.length > this.config.maxBufferSize) {
      const evicted = this.buffer.shift();
      if (evicted) {
        this.cleanupCorrelations(new Set([evicted.id]));
      }
    }

    // Track correlation
    const existing = this.correlations.get(event.correlationId) || [];
    existing.push(event.id);
    this.correlations.set(event.correlationId, existing);

    // Check memory warning (every 100 events to reduce overhead)
    if (this.buffer.length % 100 === 0) {
      this.checkMemoryWarning();
    }

    // Notify subscribers
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch (err) {
        console.error('[TraceCollector] Subscriber error:', err);
      }
    }

    // Optionally log to output channel
    if (this.config.logToOutput) {
      this.logEvent(event);
    }
  }

  /**
   * Log an event using the configured log output callback.
   */
  private logEvent(event: TraceEvent): void {
    if (!this.logOutput) return;

    const prefix = event.status === 'started' ? '>' : event.status === 'completed' ? '<' : '!';
    const duration = event.duration ? ` (${event.duration.toFixed(1)}ms)` : '';
    const message = `${prefix} [${event.category}] ${event.operation}${duration}`;
    const details = event.data ? JSON.stringify(event.data) : undefined;

    this.logOutput(event.level, message, details);
  }

  /**
   * Subscribe to trace events.
   * Returns an unsubscribe function.
   */
  subscribe(callback: TraceSubscriber): () => void {
    this.subscribers.push(callback);
    return () => {
      const index = this.subscribers.indexOf(callback);
      if (index !== -1) {
        this.subscribers.splice(index, 1);
      }
    };
  }

  /**
   * Get all events for a correlation ID.
   */
  getTrace(correlationId: string): TraceEvent[] {
    const eventIds = this.correlations.get(correlationId) || [];
    return this.buffer.filter(e => eventIds.includes(e.id));
  }

  /**
   * Get all events in the buffer.
   */
  getAll(): TraceEvent[] {
    return [...this.buffer];
  }

  /**
   * Get events filtered by category.
   */
  getByCategory(category: TraceCategory): TraceEvent[] {
    return this.buffer.filter(e => e.category === category);
  }

  /**
   * Get events filtered by level.
   */
  getByLevel(level: TraceLevel): TraceEvent[] {
    const minPriority = LEVEL_PRIORITY[level];
    return this.buffer.filter(e => LEVEL_PRIORITY[e.level] >= minPriority);
  }

  /**
   * Get pending spans (started but not ended).
   */
  getPendingSpans(): TraceEvent[] {
    return Array.from(this.spanStack.values());
  }

  /**
   * Export traces in the specified format.
   * Times are normalized so the first event starts at 0ms.
   */
  export(format: ExportFormat = 'json'): string {
    if (this.buffer.length === 0) {
      return format === 'json' ? '[]' : '';
    }

    // Calculate base time for normalization (first event's relativeTime)
    const baseTime = this.buffer[0].relativeTime;

    switch (format) {
      case 'json':
        // Normalize relativeTime in JSON export
        const normalizedBuffer = this.buffer.map(e => ({
          ...e,
          relativeTime: e.relativeTime - baseTime
        }));
        return JSON.stringify(normalizedBuffer, null, 2);

      case 'jsonl':
        return this.buffer.map(e => JSON.stringify({
          ...e,
          relativeTime: e.relativeTime - baseTime
        })).join('\n');

      case 'pretty':
        return this.buffer.map(e => this.formatEventPretty(e, baseTime)).join('\n');

      default:
        const normalized = this.buffer.map(e => ({
          ...e,
          relativeTime: e.relativeTime - baseTime
        }));
        return JSON.stringify(normalized, null, 2);
    }
  }

  /**
   * Format a single event for pretty printing.
   * @param baseTime - The relativeTime of the first event (for normalization)
   */
  private formatEventPretty(event: TraceEvent, baseTime: number = 0): string {
    const normalizedTime = event.relativeTime - baseTime;
    const statusIcon = event.status === 'started' ? '>' :
                       event.status === 'completed' ? '<' :
                       event.status === 'failed' ? '!' : ' ';
    const duration = event.duration ? ` (${event.duration.toFixed(1)}ms)` : '';
    const error = event.error ? ` ERROR: ${event.error}` : '';
    const data = event.data ? ` ${JSON.stringify(event.data)}` : '';
    const timeStr = `${normalizedTime.toFixed(1)}ms`.padStart(10);

    return `${timeStr} ${event.timestamp} ${statusIcon} [${event.source}] [${event.category}] ${event.operation}${duration}${error}${data}`;
  }

  /**
   * Clear all traces.
   */
  clear(): void {
    this.buffer = [];
    this.correlations.clear();
    this.spanStack.clear();
    this.memoryWarningEmitted = false;
  }

  /**
   * Dispose the trace collector (cleanup timers).
   */
  dispose(): void {
    this.stopEvictionTimer();
    this.clear();
  }

  /**
   * Reset the relative time counter.
   */
  resetTimer(): void {
    this.startTime = performance.now();
  }

  /**
   * Get the current buffer size.
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
}

// Export singleton instance
export const tracer = TraceCollector.getInstance();
