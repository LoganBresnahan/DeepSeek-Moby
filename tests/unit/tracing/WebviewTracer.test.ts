/**
 * Tests for WebviewTracer
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebviewTracer } from '../../../media/tracing/WebviewTracer';
import type { WebviewTraceEvent } from '../../../media/tracing/types';

describe('WebviewTracer', () => {
  let tracer: WebviewTracer;

  beforeEach(() => {
    // Create a fresh instance for each test
    tracer = new (WebviewTracer as any)();
    tracer.configure({ enabled: true, minLevel: 'debug' });
  });

  describe('startFlow', () => {
    it('generates unique flow IDs', () => {
      const flow1 = tracer.startFlow();
      const flow2 = tracer.startFlow();

      expect(flow1).toMatch(/^wv-flow-\d+-[a-z0-9]+$/);
      expect(flow2).toMatch(/^wv-flow-\d+-[a-z0-9]+$/);
      expect(flow1).not.toBe(flow2);
    });
  });

  describe('trace', () => {
    it('records a simple trace event', () => {
      tracer.trace('user.input', 'submit');

      const events = tracer.getAll();
      expect(events).toHaveLength(1);
      expect(events[0].category).toBe('user.input');
      expect(events[0].operation).toBe('submit');
      expect(events[0].source).toBe('webview');
      expect(events[0].status).toBe('completed');
    });

    it('includes optional data', () => {
      tracer.trace('state.publish', 'keys', {
        data: { keys: ['streaming.active', 'streaming.content'] }
      });

      const events = tracer.getAll();
      expect(events[0].data).toEqual({ keys: ['streaming.active', 'streaming.content'] });
    });

    it('uses provided correlationId', () => {
      const correlationId = 'my-correlation-id';
      tracer.trace('actor.create', 'myActor', { correlationId });

      const events = tracer.getAll();
      expect(events[0].correlationId).toBe(correlationId);
    });

    it('respects minLevel filter', () => {
      tracer.configure({ minLevel: 'warn' });

      tracer.trace('user.input', 'debug-event', { level: 'debug' });
      tracer.trace('user.input', 'info-event', { level: 'info' });
      tracer.trace('user.input', 'warn-event', { level: 'warn' });
      tracer.trace('user.input', 'error-event', { level: 'error' });

      const events = tracer.getAll();
      expect(events).toHaveLength(2);
      expect(events.map(e => e.operation)).toEqual(['warn-event', 'error-event']);
    });

    it('returns empty string when disabled', () => {
      tracer.configure({ enabled: false });
      const id = tracer.trace('user.input', 'test');
      expect(id).toBe('');
      expect(tracer.getAll()).toHaveLength(0);
    });
  });

  describe('startSpan / endSpan', () => {
    it('records start and end events for a span', () => {
      const spanId = tracer.startSpan('bridge.send', 'postMessage');

      expect(spanId).toMatch(/^wv-span-\d+-[a-z0-9]+$/);

      const startEvents = tracer.getAll();
      expect(startEvents).toHaveLength(1);
      expect(startEvents[0].status).toBe('started');
      expect(startEvents[0].operation).toBe('postMessage');

      tracer.endSpan(spanId, { status: 'completed' });

      const allEvents = tracer.getAll();
      expect(allEvents).toHaveLength(2);
      expect(allEvents[1].status).toBe('completed');
      expect(allEvents[1].duration).toBeGreaterThanOrEqual(0);
    });

    it('tracks failed spans', () => {
      const spanId = tracer.startSpan('bridge.send', 'postMessage');
      tracer.endSpan(spanId, { status: 'failed', error: 'Connection lost' });

      const events = tracer.getAll();
      expect(events[1].status).toBe('failed');
      expect(events[1].error).toBe('Connection lost');
    });

    it('merges result data with start data', () => {
      const spanId = tracer.startSpan('render.turn', 'turn-1', {
        data: { role: 'assistant' }
      });
      tracer.endSpan(spanId, {
        status: 'completed',
        data: { height: 500 }
      });

      const events = tracer.getAll();
      expect(events[1].data).toEqual({ role: 'assistant', height: 500 });
    });

    it('handles empty spanId gracefully', () => {
      // Should not throw
      tracer.endSpan('');
      expect(tracer.getAll()).toHaveLength(0);
    });

    it('handles unknown spanId gracefully', () => {
      // Should not throw, but logs warning
      tracer.endSpan('unknown-span-id');
      expect(tracer.getAll()).toHaveLength(0);
    });
  });

  describe('subscribe', () => {
    it('notifies subscribers of new events', () => {
      const events: WebviewTraceEvent[] = [];
      tracer.subscribe(e => events.push(e));

      tracer.trace('user.click', 'button');
      tracer.trace('state.publish', 'keys');

      expect(events).toHaveLength(2);
      expect(events[0].operation).toBe('button');
      expect(events[1].operation).toBe('keys');
    });

    it('returns unsubscribe function', () => {
      const events: WebviewTraceEvent[] = [];
      const unsubscribe = tracer.subscribe(e => events.push(e));

      tracer.trace('user.input', 'before');
      unsubscribe();
      tracer.trace('user.input', 'after');

      expect(events).toHaveLength(1);
      expect(events[0].operation).toBe('before');
    });

    it('handles subscriber errors gracefully', () => {
      tracer.subscribe(() => {
        throw new Error('Subscriber error');
      });

      // Should not throw
      expect(() => tracer.trace('user.input', 'test')).not.toThrow();
    });
  });

  describe('buffer management', () => {
    it('respects maxBufferSize', () => {
      tracer.configure({ maxBufferSize: 5 });

      for (let i = 0; i < 10; i++) {
        tracer.trace('user.input', `event-${i}`);
      }

      const events = tracer.getAll();
      expect(events).toHaveLength(5);
      expect(events[0].operation).toBe('event-5');
      expect(events[4].operation).toBe('event-9');
    });

    it('clear removes all events', () => {
      tracer.trace('user.input', 'test1');
      tracer.trace('user.input', 'test2');
      tracer.startSpan('bridge.send', 'pending');

      tracer.clear();

      expect(tracer.getAll()).toHaveLength(0);
    });
  });

  describe('size property', () => {
    it('returns buffer size', () => {
      expect(tracer.size).toBe(0);

      tracer.trace('user.input', 'test1');
      expect(tracer.size).toBe(1);

      tracer.trace('user.input', 'test2');
      expect(tracer.size).toBe(2);
    });
  });

  describe('enabled property', () => {
    it('can disable and enable tracing', () => {
      tracer.enabled = false;
      tracer.trace('user.input', 'disabled');
      expect(tracer.size).toBe(0);

      tracer.enabled = true;
      tracer.trace('user.input', 'enabled');
      expect(tracer.size).toBe(1);
    });
  });

  describe('convenience methods', () => {
    it('tracePublish traces state publications', () => {
      tracer.tracePublish('testActor', ['key1', 'key2'], 0);

      const events = tracer.getAll();
      expect(events).toHaveLength(1);
      expect(events[0].category).toBe('state.publish');
      expect(events[0].operation).toBe('testActor');
      expect(events[0].data).toEqual({ keys: ['key1', 'key2'], chainDepth: 0 });
    });

    it('traceSubscribe traces subscription handlers', () => {
      tracer.traceSubscribe('testActor', 'streaming.active', 'onStreamingChange');

      const events = tracer.getAll();
      expect(events).toHaveLength(1);
      expect(events[0].category).toBe('state.subscribe');
      expect(events[0].operation).toBe('testActor');
      expect(events[0].data).toEqual({ key: 'streaming.active', handler: 'onStreamingChange' });
    });

    it('traceActorCreate traces actor creation', () => {
      tracer.traceActorCreate('actor-1', 'MessageTurnActor');

      const events = tracer.getAll();
      expect(events).toHaveLength(1);
      expect(events[0].category).toBe('actor.create');
      expect(events[0].operation).toBe('actor-1');
      expect(events[0].data).toEqual({ type: 'MessageTurnActor' });
    });

    it('traceActorDestroy traces actor destruction', () => {
      tracer.traceActorDestroy('actor-1');

      const events = tracer.getAll();
      expect(events).toHaveLength(1);
      expect(events[0].category).toBe('actor.destroy');
      expect(events[0].operation).toBe('actor-1');
    });

    it('traceActorBind traces actor binding', () => {
      tracer.traceActorBind('actor-1', 'turn-5');

      const events = tracer.getAll();
      expect(events).toHaveLength(1);
      expect(events[0].category).toBe('actor.bind');
      expect(events[0].operation).toBe('actor-1');
      expect(events[0].data).toEqual({ turnId: 'turn-5' });
    });

    it('traceActorUnbind traces actor unbinding', () => {
      tracer.traceActorUnbind('actor-1', 'turn-5');

      const events = tracer.getAll();
      expect(events).toHaveLength(1);
      expect(events[0].category).toBe('actor.unbind');
      expect(events[0].operation).toBe('actor-1');
      expect(events[0].data).toEqual({ turnId: 'turn-5' });
    });

  });

  describe('syncToExtension', () => {
    it('sends events via vscode.postMessage', () => {
      const mockVscode = {
        postMessage: vi.fn(),
        getState: vi.fn(),
        setState: vi.fn()
      };

      tracer.initialize(mockVscode);
      // Note: initialize now sends a 'webviewReady' message
      expect(mockVscode.postMessage).toHaveBeenCalledWith({ type: 'webviewReady' });

      tracer.trace('user.input', 'test1');
      tracer.trace('user.input', 'test2');

      tracer.syncToExtension();

      // 2 calls total: webviewReady + traceEvents
      expect(mockVscode.postMessage).toHaveBeenCalledTimes(2);
      expect(mockVscode.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'traceEvents',
          events: expect.arrayContaining([
            expect.objectContaining({ operation: 'test1' }),
            expect.objectContaining({ operation: 'test2' })
          ])
        })
      );
    });

    it('clears buffer after sync', () => {
      const mockVscode = {
        postMessage: vi.fn(),
        getState: vi.fn(),
        setState: vi.fn()
      };

      tracer.initialize(mockVscode);
      tracer.trace('user.input', 'test1');

      expect(tracer.size).toBe(1);
      tracer.syncToExtension();
      expect(tracer.size).toBe(0);
    });

    it('does nothing without vscode API', () => {
      tracer.trace('user.input', 'test1');

      // Should not throw
      expect(() => tracer.syncToExtension()).not.toThrow();
      expect(tracer.size).toBe(1); // Buffer not cleared
    });

    it('includes time drift diagnostic fields in sync message', () => {
      const mockVscode = {
        postMessage: vi.fn(),
        getState: vi.fn(),
        setState: vi.fn()
      };

      tracer.initialize(mockVscode);
      mockVscode.postMessage.mockClear();

      tracer.trace('user.input', 'test');
      tracer.syncToExtension();

      // Verify sync message includes diagnostic fields for clock drift detection
      expect(mockVscode.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'traceEvents',
          webviewSyncTime: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
          webviewRelativeTime: expect.any(Number)
        })
      );

      // Verify webviewRelativeTime is reasonable (should be small, not negative)
      const call = mockVscode.postMessage.mock.calls[0][0];
      expect(call.webviewRelativeTime).toBeGreaterThanOrEqual(0);
      expect(call.webviewRelativeTime).toBeLessThan(10000); // Less than 10 seconds
    });
  });

  describe('dispose', () => {
    it('clears buffer and nulls vscode reference', () => {
      const mockVscode = {
        postMessage: vi.fn(),
        getState: vi.fn(),
        setState: vi.fn()
      };

      tracer.initialize(mockVscode);
      // Note: initialize sends a 'webviewReady' message
      expect(mockVscode.postMessage).toHaveBeenCalledWith({ type: 'webviewReady' });
      mockVscode.postMessage.mockClear(); // Reset call count

      tracer.trace('user.input', 'test');

      tracer.dispose();

      expect(tracer.size).toBe(0);
      // Sync should do nothing after dispose
      tracer.trace('user.input', 'after-dispose');
      tracer.syncToExtension();
      expect(mockVscode.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('cross-boundary correlation', () => {
    it('uses extension correlationId when set', () => {
      tracer.setExtensionCorrelationId('flow-123');

      tracer.trace('actor.bind', 'TestActor');

      const events = tracer.getAll();
      expect(events[0].correlationId).toBe('flow-123');
    });

    it('falls back to standalone when no extension correlationId', () => {
      tracer.setExtensionCorrelationId(null);

      tracer.trace('actor.bind', 'TestActor');

      const events = tracer.getAll();
      expect(events[0].correlationId).toBe('standalone');
    });

    it('handles calibration data', () => {
      const timestamp = '2026-02-09T03:00:00.000Z';
      tracer.handleCalibration(timestamp, 'flow-456');

      expect(tracer.getExtensionCorrelationId()).toBe('flow-456');

      // Events should use the calibrated correlationId
      tracer.trace('actor.create', 'TestActor');
      const events = tracer.getAll();
      expect(events[0].correlationId).toBe('flow-456');
    });

    it('handles sync acknowledgment', () => {
      // Should not throw
      expect(() => tracer.handleSyncAck(5)).not.toThrow();
    });

    it('forces sync on request', () => {
      const mockVscode = {
        postMessage: vi.fn(),
        getState: vi.fn(),
        setState: vi.fn()
      };

      tracer.initialize(mockVscode);
      mockVscode.postMessage.mockClear(); // Clear webviewReady call

      tracer.trace('actor.bind', 'TestActor');
      tracer.forceSync();

      expect(mockVscode.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'traceEvents',
          events: expect.arrayContaining([
            expect.objectContaining({ operation: 'TestActor' })
          ])
        })
      );
    });

    it('propagates correlationId to startSpan', () => {
      tracer.setExtensionCorrelationId('flow-789');

      const spanId = tracer.startSpan('api.request', 'fetch');

      const events = tracer.getAll();
      expect(events[0].correlationId).toBe('flow-789');
    });
  });
});
