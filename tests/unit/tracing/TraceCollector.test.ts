/**
 * Tests for TraceCollector
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TraceCollector } from '../../../src/tracing/TraceCollector';
import type { TraceEvent, TraceCategory } from '../../../src/tracing/types';

describe('TraceCollector', () => {
  let collector: TraceCollector;

  beforeEach(() => {
    // Create a fresh instance for each test
    collector = new (TraceCollector as any)();
    collector.configure({ enabled: true, minLevel: 'debug' });
  });

  describe('startFlow', () => {
    it('generates unique flow IDs', () => {
      const flow1 = collector.startFlow();
      const flow2 = collector.startFlow();

      expect(flow1).toMatch(/^flow-\d+-[a-z0-9]+$/);
      expect(flow2).toMatch(/^flow-\d+-[a-z0-9]+$/);
      expect(flow1).not.toBe(flow2);
    });
  });

  describe('trace', () => {
    it('records a simple trace event', () => {
      collector.trace('user.input', 'submit');

      const events = collector.getAll();
      expect(events).toHaveLength(1);
      expect(events[0].category).toBe('user.input');
      expect(events[0].operation).toBe('submit');
      expect(events[0].status).toBe('completed');
      expect(events[0].executionMode).toBe('sync');
    });

    it('includes optional data', () => {
      collector.trace('api.request', 'sendMessage', {
        data: { messageCount: 5, model: 'deepseek-chat' }
      });

      const events = collector.getAll();
      expect(events[0].data).toEqual({ messageCount: 5, model: 'deepseek-chat' });
    });

    it('uses provided correlationId', () => {
      const correlationId = 'my-correlation-id';
      collector.trace('user.click', 'button', { correlationId });

      const events = collector.getAll();
      expect(events[0].correlationId).toBe(correlationId);
    });

    it('respects minLevel filter', () => {
      collector.configure({ minLevel: 'warn' });

      collector.trace('user.input', 'debug-event', { level: 'debug' });
      collector.trace('user.input', 'info-event', { level: 'info' });
      collector.trace('user.input', 'warn-event', { level: 'warn' });
      collector.trace('user.input', 'error-event', { level: 'error' });

      const events = collector.getAll();
      expect(events).toHaveLength(2);
      expect(events.map(e => e.operation)).toEqual(['warn-event', 'error-event']);
    });

    it('returns empty string when disabled', () => {
      collector.configure({ enabled: false });
      const id = collector.trace('user.input', 'test');
      expect(id).toBe('');
      expect(collector.getAll()).toHaveLength(0);
    });
  });

  describe('startSpan / endSpan', () => {
    it('records start and end events for a span', () => {
      const spanId = collector.startSpan('api.request', 'streamChat');

      expect(spanId).toMatch(/^span-\d+-[a-z0-9]+$/);

      const startEvents = collector.getAll();
      expect(startEvents).toHaveLength(1);
      expect(startEvents[0].status).toBe('started');
      expect(startEvents[0].operation).toBe('streamChat');

      collector.endSpan(spanId, { status: 'completed' });

      const allEvents = collector.getAll();
      expect(allEvents).toHaveLength(2);
      expect(allEvents[1].status).toBe('completed');
      expect(allEvents[1].duration).toBeGreaterThanOrEqual(0);
    });

    it('tracks failed spans', () => {
      const spanId = collector.startSpan('api.request', 'streamChat');
      collector.endSpan(spanId, { status: 'failed', error: 'Rate limit exceeded' });

      const events = collector.getAll();
      expect(events[1].status).toBe('failed');
      expect(events[1].error).toBe('Rate limit exceeded');
    });

    it('merges result data with start data', () => {
      const spanId = collector.startSpan('api.request', 'streamChat', {
        data: { model: 'deepseek-chat' }
      });
      collector.endSpan(spanId, {
        status: 'completed',
        data: { tokens: 500 }
      });

      const events = collector.getAll();
      expect(events[1].data).toEqual({ model: 'deepseek-chat', tokens: 500 });
    });

    it('handles nested spans with parentId', () => {
      const parentSpan = collector.startSpan('api.request', 'streamChat');
      const childSpan = collector.startSpan('api.stream', 'chunk', {
        parentId: parentSpan,
        correlationId: collector.getAll()[0].correlationId
      });

      const events = collector.getAll();
      expect(events[1].parentId).toBe(parentSpan);
    });

    it('handles empty spanId gracefully', () => {
      // Should not throw
      collector.endSpan('');
      expect(collector.getAll()).toHaveLength(0);
    });

    it('handles unknown spanId gracefully', () => {
      // Should not throw, but logs warning
      collector.endSpan('unknown-span-id');
      expect(collector.getAll()).toHaveLength(0);
    });
  });

  describe('subscribe', () => {
    it('notifies subscribers of new events', () => {
      const events: TraceEvent[] = [];
      collector.subscribe(e => events.push(e));

      collector.trace('user.input', 'test1');
      collector.trace('user.click', 'test2');

      expect(events).toHaveLength(2);
      expect(events[0].operation).toBe('test1');
      expect(events[1].operation).toBe('test2');
    });

    it('returns unsubscribe function', () => {
      const events: TraceEvent[] = [];
      const unsubscribe = collector.subscribe(e => events.push(e));

      collector.trace('user.input', 'before');
      unsubscribe();
      collector.trace('user.input', 'after');

      expect(events).toHaveLength(1);
      expect(events[0].operation).toBe('before');
    });

    it('handles subscriber errors gracefully', () => {
      collector.subscribe(() => {
        throw new Error('Subscriber error');
      });

      // Should not throw
      expect(() => collector.trace('user.input', 'test')).not.toThrow();
    });
  });

  describe('getTrace', () => {
    it('returns all events for a correlation ID', () => {
      const correlationId = collector.startFlow();

      collector.trace('user.input', 'submit', { correlationId });
      const spanId = collector.startSpan('api.request', 'stream', { correlationId });
      collector.endSpan(spanId, { status: 'completed' });

      const trace = collector.getTrace(correlationId);
      expect(trace).toHaveLength(3);
      expect(trace.every(e => e.correlationId === correlationId)).toBe(true);
    });

    it('returns empty array for unknown correlation ID', () => {
      const trace = collector.getTrace('unknown-correlation');
      expect(trace).toEqual([]);
    });
  });

  describe('getByCategory', () => {
    it('filters events by category', () => {
      collector.trace('user.input', 'type');
      collector.trace('api.request', 'send');
      collector.trace('user.click', 'submit');
      collector.trace('api.response', 'receive');

      const userEvents = collector.getByCategory('user.input');
      expect(userEvents).toHaveLength(1);
      expect(userEvents[0].operation).toBe('type');

      const apiRequests = collector.getByCategory('api.request');
      expect(apiRequests).toHaveLength(1);
    });
  });

  describe('getByLevel', () => {
    it('filters events by minimum level', () => {
      collector.trace('user.input', 'debug', { level: 'debug' });
      collector.trace('user.input', 'info', { level: 'info' });
      collector.trace('user.input', 'warn', { level: 'warn' });
      collector.trace('user.input', 'error', { level: 'error' });

      const warnAndAbove = collector.getByLevel('warn');
      expect(warnAndAbove).toHaveLength(2);
      expect(warnAndAbove.map(e => e.operation)).toEqual(['warn', 'error']);
    });
  });

  describe('getPendingSpans', () => {
    it('returns spans that have not been ended', () => {
      const span1 = collector.startSpan('api.request', 'request1');
      const span2 = collector.startSpan('api.request', 'request2');
      collector.endSpan(span1, { status: 'completed' });

      const pending = collector.getPendingSpans();
      expect(pending).toHaveLength(1);
      expect(pending[0].operation).toBe('request2');
    });
  });

  describe('export', () => {
    beforeEach(() => {
      collector.trace('user.input', 'test1');
      collector.trace('api.request', 'test2');
    });

    it('exports as JSON', () => {
      const exported = collector.export('json');
      const parsed = JSON.parse(exported);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].operation).toBe('test1');
    });

    it('exports as JSONL', () => {
      const exported = collector.export('jsonl');
      const lines = exported.split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).operation).toBe('test1');
      expect(JSON.parse(lines[1]).operation).toBe('test2');
    });

    it('exports as pretty format', () => {
      const exported = collector.export('pretty');
      expect(exported).toContain('[user.input]');
      expect(exported).toContain('test1');
      expect(exported).toContain('[api.request]');
      expect(exported).toContain('test2');
    });

    it('returns empty for empty buffer', () => {
      collector.clear();
      expect(collector.export('json')).toBe('[]');
      expect(collector.export('jsonl')).toBe('');
      expect(collector.export('pretty')).toBe('');
    });
  });

  describe('chronological export', () => {
    it('sorts events by timestamp regardless of insertion order', () => {
      collector.clear();

      // Insert events with out-of-order timestamps via importEvent
      const t2 = '2026-02-09T02:50:00.000Z';
      const t1 = '2026-02-09T02:49:00.000Z'; // Earlier than t2
      const t3 = '2026-02-09T02:51:00.000Z';

      collector.importEvent('user.click', 'second', {
        originalId: 'evt-2',
        timestamp: t2
      });
      collector.importEvent('user.input', 'first', {
        originalId: 'evt-1',
        timestamp: t1
      });
      collector.importEvent('api.request', 'third', {
        originalId: 'evt-3',
        timestamp: t3
      });

      const exported = collector.export('json');
      const parsed = JSON.parse(exported);

      // Should be sorted chronologically
      expect(parsed[0].operation).toBe('first');
      expect(parsed[1].operation).toBe('second');
      expect(parsed[2].operation).toBe('third');
    });

    it('recalculates relativeTime from earliest event', () => {
      collector.clear();

      const t1 = '2026-02-09T02:49:00.000Z';
      const t2 = '2026-02-09T02:49:30.000Z'; // 30 seconds later
      const t3 = '2026-02-09T02:50:00.000Z'; // 60 seconds later

      // Insert in reverse chronological order
      collector.importEvent('api.request', 'third', {
        originalId: 'evt-3',
        timestamp: t3
      });
      collector.importEvent('user.input', 'first', {
        originalId: 'evt-1',
        timestamp: t1
      });
      collector.importEvent('user.click', 'second', {
        originalId: 'evt-2',
        timestamp: t2
      });

      const exported = collector.export('json');
      const parsed = JSON.parse(exported);

      // First event should have relativeTime 0
      expect(parsed[0].relativeTime).toBe(0);
      expect(parsed[0].operation).toBe('first');

      // Second event should be 30 seconds (30000ms) from first
      expect(parsed[1].relativeTime).toBe(30000);
      expect(parsed[1].operation).toBe('second');

      // Third event should be 60 seconds (60000ms) from first
      expect(parsed[2].relativeTime).toBe(60000);
      expect(parsed[2].operation).toBe('third');
    });

    it('produces unified timeline with mixed extension and webview events', () => {
      collector.clear();

      // Simulate: extension event, then webview event with EARLIER timestamp
      // This mimics the real scenario where webview events are imported later
      // but actually happened earlier
      const extensionTime = '2026-02-09T02:50:00.000Z';
      const webviewTime = '2026-02-09T02:49:55.000Z'; // 5 seconds BEFORE extension

      // Extension event added first (but happened later)
      collector.trace('api.request', 'extension-event', {
        data: { source: 'extension' }
      });

      // Manually set timestamp for testing (normally trace uses current time)
      const events = collector.getAll();
      (events[0] as any).timestamp = extensionTime;

      // Import webview event (happened earlier but received later)
      collector.importEvent('actor.create', 'webview-event', {
        originalId: 'wv-evt-123',
        timestamp: webviewTime,
        data: { source: 'webview' }
      });

      const exported = collector.export('json');
      const parsed = JSON.parse(exported);

      // Webview event should come first despite being added second
      expect(parsed[0].operation).toBe('webview-event');
      expect(parsed[0].source).toBe('webview');
      expect(parsed[0].relativeTime).toBe(0);

      // Extension event should come second
      expect(parsed[1].operation).toBe('extension-event');
      expect(parsed[1].source).toBe('extension');
      expect(parsed[1].relativeTime).toBe(5000); // 5 seconds after webview event
    });

    it('handles JSONL format with chronological order', () => {
      collector.clear();

      const t2 = '2026-02-09T02:50:00.000Z';
      const t1 = '2026-02-09T02:49:00.000Z';

      collector.importEvent('api.request', 'second', {
        originalId: 'evt-2',
        timestamp: t2
      });
      collector.importEvent('user.input', 'first', {
        originalId: 'evt-1',
        timestamp: t1
      });

      const exported = collector.export('jsonl');
      const lines = exported.split('\n');

      expect(JSON.parse(lines[0]).operation).toBe('first');
      expect(JSON.parse(lines[1]).operation).toBe('second');
    });

    it('handles pretty format with chronological order', () => {
      collector.clear();

      const t2 = '2026-02-09T02:50:00.000Z';
      const t1 = '2026-02-09T02:49:00.000Z';

      collector.importEvent('api.request', 'second', {
        originalId: 'evt-2',
        timestamp: t2
      });
      collector.importEvent('user.input', 'first', {
        originalId: 'evt-1',
        timestamp: t1
      });

      const exported = collector.export('pretty');
      const lines = exported.split('\n');

      // First line should contain 'first' operation
      expect(lines[0]).toContain('first');
      // Second line should contain 'second' operation
      expect(lines[1]).toContain('second');
    });
  });

  describe('buffer management', () => {
    it('respects maxBufferSize', () => {
      collector.configure({ maxBufferSize: 5 });

      for (let i = 0; i < 10; i++) {
        collector.trace('user.input', `event-${i}`);
      }

      const events = collector.getAll();
      expect(events).toHaveLength(5);
      expect(events[0].operation).toBe('event-5');
      expect(events[4].operation).toBe('event-9');
    });

    it('clear removes all events', () => {
      collector.trace('user.input', 'test1');
      collector.trace('user.input', 'test2');
      collector.startSpan('api.request', 'pending');

      collector.clear();

      expect(collector.getAll()).toHaveLength(0);
      expect(collector.getPendingSpans()).toHaveLength(0);
    });
  });

  describe('size property', () => {
    it('returns buffer size', () => {
      expect(collector.size).toBe(0);

      collector.trace('user.input', 'test1');
      expect(collector.size).toBe(1);

      collector.trace('user.input', 'test2');
      expect(collector.size).toBe(2);
    });
  });

  describe('enabled property', () => {
    it('can disable and enable tracing', () => {
      collector.enabled = false;
      collector.trace('user.input', 'disabled');
      expect(collector.size).toBe(0);

      collector.enabled = true;
      collector.trace('user.input', 'enabled');
      expect(collector.size).toBe(1);
    });
  });

  describe('payload truncation', () => {
    it('truncates large data payloads', () => {
      collector.configure({ maxPayloadSize: 100 });

      const largeData = { content: 'x'.repeat(500) };
      collector.trace('user.input', 'test', { data: largeData });

      const events = collector.getAll();
      expect(events[0].data).toHaveProperty('_truncated', true);
      expect(events[0].data).toHaveProperty('_originalSize');
      expect(events[0].data).toHaveProperty('preview');
    });

    it('does not truncate small payloads', () => {
      collector.configure({ maxPayloadSize: 1000 });

      const smallData = { content: 'small' };
      collector.trace('user.input', 'test', { data: smallData });

      const events = collector.getAll();
      expect(events[0].data).toEqual(smallData);
      expect(events[0].data).not.toHaveProperty('_truncated');
    });

    it('respects maxPayloadSize of 0 (no limit)', () => {
      collector.configure({ maxPayloadSize: 0 });

      const largeData = { content: 'x'.repeat(5000) };
      collector.trace('user.input', 'test', { data: largeData });

      const events = collector.getAll();
      expect(events[0].data).toEqual(largeData);
    });
  });

  describe('correlation map cleanup', () => {
    it('cleans up correlation entries when buffer evicts events', () => {
      collector.configure({ maxBufferSize: 3 });

      const correlationId = collector.startFlow();
      collector.trace('user.input', 'event1', { correlationId });
      collector.trace('user.input', 'event2', { correlationId });

      // These new events should evict the old ones
      collector.trace('user.input', 'new1');
      collector.trace('user.input', 'new2');
      collector.trace('user.input', 'new3');

      // The correlation should be cleaned up or reduced
      const trace = collector.getTrace(correlationId);
      expect(trace.length).toBeLessThan(2);
    });
  });

  describe('getStats', () => {
    it('returns buffer statistics', () => {
      collector.trace('user.input', 'test1');
      collector.startSpan('api.request', 'pending');

      const stats = collector.getStats();

      expect(stats.eventCount).toBe(2);
      expect(stats.estimatedMemoryBytes).toBeGreaterThan(0);
      expect(stats.correlationCount).toBeGreaterThan(0);
      expect(stats.pendingSpanCount).toBe(1);
      expect(stats.oldestEventTime).toBeDefined();
      expect(stats.newestEventTime).toBeDefined();
    });

    it('returns empty stats for empty buffer', () => {
      const stats = collector.getStats();

      expect(stats.eventCount).toBe(0);
      expect(stats.estimatedMemoryBytes).toBe(0);
      expect(stats.oldestEventTime).toBeUndefined();
      expect(stats.newestEventTime).toBeUndefined();
    });
  });

  describe('estimateMemoryBytes', () => {
    it('estimates memory usage', () => {
      collector.trace('user.input', 'test1');
      collector.trace('user.input', 'test2', { data: { large: 'x'.repeat(100) } });

      const memory = collector.estimateMemoryBytes();
      expect(memory).toBeGreaterThan(600); // At least 300 bytes per event
    });

    it('returns 0 for empty buffer', () => {
      expect(collector.estimateMemoryBytes()).toBe(0);
    });
  });

  describe('dispose', () => {
    it('clears buffer and stops timers', () => {
      collector.configure({ maxAgeMs: 60000 });
      collector.trace('user.input', 'test');

      collector.dispose();

      expect(collector.size).toBe(0);
    });
  });

  describe('time-based eviction', () => {
    it('evicts old events when maxAgeMs is set', async () => {
      // Use a very short maxAgeMs for testing
      collector.configure({ maxAgeMs: 50 });

      collector.trace('user.input', 'old-event');

      // Wait for the event to become old
      await new Promise(resolve => setTimeout(resolve, 100));

      // Manually trigger eviction (normally done by timer)
      (collector as any).evictOldEvents();

      expect(collector.size).toBe(0);
    });

    it('keeps recent events', async () => {
      collector.configure({ maxAgeMs: 1000 });

      collector.trace('user.input', 'recent-event');

      // Immediately trigger eviction
      (collector as any).evictOldEvents();

      expect(collector.size).toBe(1);
    });
  });

  describe('importEvent', () => {
    it('preserves original timestamp from webview', () => {
      const originalTimestamp = '2026-02-09T02:49:10.409Z';

      collector.importEvent('actor.create', 'TestActor', {
        originalId: 'wv-evt-123',
        timestamp: originalTimestamp,
        data: { type: 'actor' }
      });

      const events = collector.getAll();
      expect(events).toHaveLength(1);
      expect(events[0].timestamp).toBe(originalTimestamp);
      expect(events[0].source).toBe('webview');
      expect(events[0].category).toBe('actor.create');
      expect(events[0].operation).toBe('TestActor');
    });

    it('includes metadata about the imported event', () => {
      collector.importEvent('actor.bind', 'TestActor', {
        originalId: 'wv-evt-456',
        timestamp: '2026-02-09T02:50:00.000Z',
        originalRelativeTime: 1234.5,
        data: { turnId: 'turn-1' }
      });

      const events = collector.getAll();
      expect(events[0].data).toEqual({
        turnId: 'turn-1',
        _importedFrom: 'webview',
        _originalId: 'wv-evt-456',
        _originalRelativeTime: 1234.5
      });
    });

    it('generates imported- prefixed ID', () => {
      collector.importEvent('state.publish', 'keys', {
        originalId: 'wv-evt-789',
        timestamp: '2026-02-09T02:51:00.000Z'
      });

      const events = collector.getAll();
      expect(events[0].id).toMatch(/^imported-\d+-[a-z0-9]+$/);
    });

    it('calculates relativeTime from first event', () => {
      // First, add an extension event
      collector.trace('user.input', 'local-event');

      const events1 = collector.getAll();
      const firstTimestamp = events1[0].timestamp;

      // Import a webview event 5 seconds later
      const laterTimestamp = new Date(new Date(firstTimestamp).getTime() + 5000).toISOString();
      collector.importEvent('actor.create', 'WebviewActor', {
        originalId: 'wv-evt-abc',
        timestamp: laterTimestamp
      });

      const events = collector.getAll();
      expect(events).toHaveLength(2);
      // The imported event's relativeTime should be ~5000ms after first event
      expect(events[1].relativeTime).toBeCloseTo(5000, -2); // Within 100ms tolerance
    });

    it('respects minLevel filter', () => {
      collector.configure({ minLevel: 'warn' });

      collector.importEvent('actor.create', 'TestActor', {
        originalId: 'wv-evt-debug',
        timestamp: '2026-02-09T02:52:00.000Z',
        level: 'debug'
      });

      expect(collector.size).toBe(0);

      collector.importEvent('actor.create', 'TestActor', {
        originalId: 'wv-evt-warn',
        timestamp: '2026-02-09T02:52:01.000Z',
        level: 'warn'
      });

      expect(collector.size).toBe(1);
    });

    it('preserves status from webview event', () => {
      collector.importEvent('actor.bind', 'TestActor', {
        originalId: 'wv-evt-started',
        timestamp: '2026-02-09T02:53:00.000Z',
        status: 'started'
      });

      const events = collector.getAll();
      expect(events[0].status).toBe('started');
    });
  });

  describe('pretty format aggregation', () => {
    it('shows all events when group size is 1-2', () => {
      collector.clear();

      collector.importEvent('user.input', 'event1', {
        originalId: 'evt-1',
        timestamp: '2026-02-09T03:00:00.000Z'
      });
      collector.importEvent('user.input', 'event2', {
        originalId: 'evt-2',
        timestamp: '2026-02-09T03:00:01.000Z'
      });

      const exported = collector.export('pretty');
      const lines = exported.split('\n');

      // Both events should be shown (no aggregation)
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('event1');
      expect(lines[1]).toContain('event2');
      expect(exported).not.toContain('similar');
    });

    it('collapses consecutive events with same category when 3+', () => {
      collector.clear();

      // Add 5 events with the same category
      for (let i = 1; i <= 5; i++) {
        collector.importEvent('actor.bind', `event${i}`, {
          originalId: `evt-${i}`,
          timestamp: `2026-02-09T03:00:0${i}.000Z`
        });
      }

      const exported = collector.export('pretty');
      const lines = exported.split('\n');

      // Should have: first event, collapse indicator, last event = 3 lines
      expect(lines).toHaveLength(3);

      // First line should show first event
      expect(lines[0]).toContain('event1');

      // Second line should be the collapse indicator
      expect(lines[1]).toContain('3 similar');
      expect(lines[1]).toContain('actor.bind');
      expect(lines[1]).toContain('see JSONL for full data');

      // Third line should show last event
      expect(lines[2]).toContain('event5');
    });

    it('shows time range in collapse indicator', () => {
      collector.clear();

      collector.importEvent('state.publish', 'start', {
        originalId: 'evt-1',
        timestamp: '2026-02-09T03:00:00.000Z'
      });
      collector.importEvent('state.publish', 'middle1', {
        originalId: 'evt-2',
        timestamp: '2026-02-09T03:00:00.100Z'
      });
      collector.importEvent('state.publish', 'middle2', {
        originalId: 'evt-3',
        timestamp: '2026-02-09T03:00:00.200Z'
      });
      collector.importEvent('state.publish', 'end', {
        originalId: 'evt-4',
        timestamp: '2026-02-09T03:00:00.500Z'
      });

      const exported = collector.export('pretty');

      // Should contain time range (0.0ms to 500.0ms)
      expect(exported).toContain('0.0-500.0ms');
    });

    it('creates separate groups for different categories', () => {
      collector.clear();

      // First group: 3 actor.bind events
      for (let i = 1; i <= 3; i++) {
        collector.importEvent('actor.bind', `bind${i}`, {
          originalId: `bind-${i}`,
          timestamp: `2026-02-09T03:00:0${i}.000Z`
        });
      }

      // Second group: 1 api.request event
      collector.importEvent('api.request', 'request1', {
        originalId: 'req-1',
        timestamp: '2026-02-09T03:00:04.000Z'
      });

      // Third group: 3 state.publish events
      for (let i = 1; i <= 3; i++) {
        collector.importEvent('state.publish', `pub${i}`, {
          originalId: `pub-${i}`,
          timestamp: `2026-02-09T03:00:0${4 + i}.000Z`
        });
      }

      const exported = collector.export('pretty');
      const lines = exported.split('\n');

      // Group 1: first, collapse, last = 3 lines
      // Group 2: single event = 1 line
      // Group 3: first, collapse, last = 3 lines
      // Total = 7 lines
      expect(lines).toHaveLength(7);

      // Verify group 1 (actor.bind)
      expect(lines[0]).toContain('bind1');
      expect(lines[1]).toContain('1 similar');
      expect(lines[1]).toContain('actor.bind');
      expect(lines[2]).toContain('bind3');

      // Verify group 2 (api.request) - not collapsed
      expect(lines[3]).toContain('request1');

      // Verify group 3 (state.publish)
      expect(lines[4]).toContain('pub1');
      expect(lines[5]).toContain('1 similar');
      expect(lines[5]).toContain('state.publish');
      expect(lines[6]).toContain('pub3');
    });

    it('preserves full data in JSON export', () => {
      collector.clear();

      // Add 5 events that would be collapsed in pretty
      for (let i = 1; i <= 5; i++) {
        collector.importEvent('actor.bind', `event${i}`, {
          originalId: `evt-${i}`,
          timestamp: `2026-02-09T03:00:0${i}.000Z`,
          data: { turnId: `turn-${i}` }
        });
      }

      const json = collector.export('json');
      const parsed = JSON.parse(json);

      // JSON should have all 5 events
      expect(parsed).toHaveLength(5);
      expect(parsed.map((e: any) => e.operation)).toEqual([
        'event1', 'event2', 'event3', 'event4', 'event5'
      ]);
    });

    it('handles single event', () => {
      collector.clear();

      collector.importEvent('user.click', 'single', {
        originalId: 'evt-1',
        timestamp: '2026-02-09T03:00:00.000Z'
      });

      const exported = collector.export('pretty');
      const lines = exported.split('\n');

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('single');
    });

    it('handles empty buffer', () => {
      collector.clear();

      const exported = collector.export('pretty');
      expect(exported).toBe('');
    });
  });

  describe('export format validation', () => {
    it('JSONL produces valid JSON on each line', () => {
      collector.clear();

      // Add events with various data types and special characters
      collector.importEvent('user.input', 'message with "quotes"', {
        originalId: 'evt-1',
        timestamp: '2026-02-09T03:00:00.000Z',
        data: { content: 'Hello\nWorld', special: '<>&"' }
      });
      collector.importEvent('api.request', 'request', {
        originalId: 'evt-2',
        timestamp: '2026-02-09T03:00:01.000Z',
        data: { nested: { a: 1, b: [1, 2, 3] } }
      });
      collector.importEvent('actor.bind', 'unicode-test', {
        originalId: 'evt-3',
        timestamp: '2026-02-09T03:00:02.000Z',
        data: { emoji: '🎉', chinese: '中文' }
      });

      const exported = collector.export('jsonl');
      const lines = exported.split('\n');

      expect(lines).toHaveLength(3);

      // Each line should be valid JSON
      for (let i = 0; i < lines.length; i++) {
        expect(() => JSON.parse(lines[i])).not.toThrow();
        const parsed = JSON.parse(lines[i]);
        expect(parsed).toHaveProperty('id');
        expect(parsed).toHaveProperty('timestamp');
        expect(parsed).toHaveProperty('category');
      }
    });

    it('JSONL handles events with no data payload', () => {
      collector.clear();

      collector.importEvent('user.click', 'button', {
        originalId: 'evt-1',
        timestamp: '2026-02-09T03:00:00.000Z'
        // No data field
      });

      const exported = collector.export('jsonl');
      const parsed = JSON.parse(exported);

      expect(parsed.data).toHaveProperty('_importedFrom', 'webview');
    });

    it('JSON produces valid parseable array', () => {
      collector.clear();

      for (let i = 0; i < 5; i++) {
        collector.importEvent('actor.bind', `event-${i}`, {
          originalId: `evt-${i}`,
          timestamp: `2026-02-09T03:00:0${i}.000Z`
        });
      }

      const exported = collector.export('json');

      // Should be valid JSON array
      expect(() => JSON.parse(exported)).not.toThrow();
      const parsed = JSON.parse(exported);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(5);
    });

    it('pretty format includes all required fields', () => {
      collector.clear();

      collector.importEvent('api.request', 'test-op', {
        originalId: 'evt-1',
        timestamp: '2026-02-09T03:00:00.000Z',
        data: { key: 'value' }
      });

      const exported = collector.export('pretty');

      // Should contain timestamp
      expect(exported).toContain('2026-02-09T03:00:00.000Z');
      // Should contain source
      expect(exported).toContain('[webview]');
      // Should contain category
      expect(exported).toContain('[api.request]');
      // Should contain operation
      expect(exported).toContain('test-op');
      // Should contain relativeTime
      expect(exported).toMatch(/\d+\.\d+ms/);
    });

    it('pretty format shows status indicators', () => {
      collector.clear();

      // Started event
      const spanId = collector.startSpan('api.request', 'started-op');
      // Completed event
      collector.endSpan(spanId, { status: 'completed' });

      // Failed event (create a separate span for this)
      const failSpanId = collector.startSpan('tool.call', 'failed-op');
      collector.endSpan(failSpanId, { status: 'failed', error: 'Test error' });

      const exported = collector.export('pretty');
      const lines = exported.split('\n');

      // Find lines with status indicators
      const startedLine = lines.find(l => l.includes('started-op') && l.includes('>'));
      const completedLine = lines.find(l => l.includes('started-op') && l.includes('<'));
      const failedLine = lines.find(l => l.includes('failed-op') && l.includes('!'));

      expect(startedLine).toBeDefined();
      expect(completedLine).toBeDefined();
      expect(failedLine).toBeDefined();
      expect(failedLine).toContain('ERROR: Test error');
    });

    it('pretty format shows duration for completed spans', () => {
      collector.clear();

      const spanId = collector.startSpan('api.request', 'timed-op');
      // Small delay to ensure duration > 0
      collector.endSpan(spanId, { status: 'completed' });

      const exported = collector.export('pretty');

      // Should contain duration in parentheses
      expect(exported).toMatch(/\(\d+\.\d+ms\)/);
    });
  });
});
