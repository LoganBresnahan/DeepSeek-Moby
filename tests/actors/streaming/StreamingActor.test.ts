/**
 * Unit tests for StreamingActor
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { StreamingActor } from '../../../media/actors/streaming/StreamingActor';
import type { StateChangeEvent } from '../../../media/state/types';
import { flushMicrotasks } from '../../setup';

describe('StreamingActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: StreamingActor;

  beforeEach(() => {
    // Reset styles injection
    StreamingActor.resetStylesInjected();

    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'streaming-root';
    document.body.appendChild(element);

    actor = new StreamingActor(manager, element);
  });

  afterEach(() => {
    actor.destroy();
    document.body.innerHTML = '';
  });

  describe('initialization', () => {
    it('registers with the manager', async () => {
      await flushMicrotasks();
      expect(manager.hasActor('streaming-root-StreamingActor')).toBe(true);
    });

    it('starts with inactive state', () => {
      expect(actor.isActive).toBe(false);
      expect(actor.content).toBe('');
      expect(actor.thinking).toBe('');
      expect(actor.messageId).toBe(null);
    });

    it('publishes initial state', async () => {
      await flushMicrotasks();
      expect(manager.getState('streaming.active')).toBe(false);
      expect(manager.getState('streaming.content')).toBe('');
    });
  });

  describe('startStream', () => {
    it('sets active state', () => {
      actor.startStream('msg-123');

      expect(actor.isActive).toBe(true);
      expect(actor.messageId).toBe('msg-123');
    });

    it('resets content and thinking', () => {
      // Add some content first
      actor.startStream('msg-1');
      actor.handleContentChunk('old content');

      // Start new stream
      actor.startStream('msg-2');

      expect(actor.content).toBe('');
      expect(actor.thinking).toBe('');
    });

    it('publishes changed streaming state', () => {
      const spy = vi.spyOn(manager, 'handleStateChange');

      actor.startStream('msg-123', 'deepseek-reasoner');

      // Only changed keys are published (content/thinking stay '' so not included)
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            'streaming.active': true,
            'streaming.messageId': 'msg-123',
            'streaming.model': 'deepseek-reasoner'
          })
        })
      );
    });

    it('notifies subscribers', () => {
      // Create a subscriber
      const subscriber = document.createElement('div');
      const received: StateChangeEvent[] = [];
      subscriber.addEventListener('state-changed', ((e: CustomEvent<StateChangeEvent>) => {
        received.push(e.detail);
      }) as EventListener);

      manager.register({
        actorId: 'test-subscriber',
        element: subscriber,
        publicationKeys: [],
        subscriptionKeys: ['streaming.*']
      }, {});

      actor.startStream('msg-123');

      expect(received.length).toBeGreaterThan(0);
      expect(received[0].changedKeys).toContain('streaming.active');
    });
  });

  describe('handleContentChunk', () => {
    it('accumulates content', () => {
      actor.startStream('msg-123');

      actor.handleContentChunk('Hello ');
      expect(actor.content).toBe('Hello ');

      actor.handleContentChunk('world!');
      expect(actor.content).toBe('Hello world!');
    });

    it('publishes content changes', () => {
      actor.startStream('msg-123');

      actor.handleContentChunk('Hello');

      expect(manager.getState('streaming.content')).toBe('Hello');
    });

    it('ignores chunks when not active', () => {
      // Not started
      actor.handleContentChunk('ignored');
      expect(actor.content).toBe('');

      // Start and end
      actor.startStream('msg-123');
      actor.endStream();

      actor.handleContentChunk('also ignored');
      expect(actor.content).toBe('');
    });
  });

  describe('handleThinkingChunk', () => {
    it('accumulates thinking content', () => {
      actor.startStream('msg-123', 'deepseek-reasoner');

      actor.handleThinkingChunk('Let me think...');
      expect(actor.thinking).toBe('Let me think...');

      actor.handleThinkingChunk(' Step 1:');
      expect(actor.thinking).toBe('Let me think... Step 1:');
    });

    it('publishes thinking changes', () => {
      actor.startStream('msg-123', 'deepseek-reasoner');

      actor.handleThinkingChunk('Reasoning...');

      expect(manager.getState('streaming.thinking')).toBe('Reasoning...');
    });

    it('ignores chunks when not active', () => {
      actor.handleThinkingChunk('ignored');
      expect(actor.thinking).toBe('');
    });
  });

  describe('endStream', () => {
    it('sets inactive state', () => {
      actor.startStream('msg-123');
      actor.handleContentChunk('Hello');
      actor.endStream();

      expect(actor.isActive).toBe(false);
    });

    it('preserves content and message ID', () => {
      actor.startStream('msg-123');
      actor.handleContentChunk('Hello world');
      actor.endStream();

      expect(actor.content).toBe('Hello world');
      expect(actor.messageId).toBe('msg-123');
    });

    it('publishes inactive state', () => {
      actor.startStream('msg-123');
      actor.endStream();

      expect(manager.getState('streaming.active')).toBe(false);
    });
  });

  describe('abortStream', () => {
    it('clears all state', () => {
      actor.startStream('msg-123');
      actor.handleContentChunk('Hello');
      actor.handleThinkingChunk('Thinking');
      actor.abortStream();

      expect(actor.isActive).toBe(false);
      expect(actor.content).toBe('');
      expect(actor.thinking).toBe('');
      expect(actor.messageId).toBe(null);
    });

    it('publishes cleared state', () => {
      actor.startStream('msg-123');
      actor.handleContentChunk('Hello');
      actor.abortStream();

      expect(manager.getState('streaming.active')).toBe(false);
      expect(manager.getState('streaming.content')).toBe('');
      expect(manager.getState('streaming.messageId')).toBe(null);
    });
  });

  describe('getState', () => {
    it('returns current state snapshot', () => {
      actor.startStream('msg-123', 'deepseek-chat');
      actor.handleContentChunk('Hello');
      actor.handleThinkingChunk('Thinking');

      const state = actor.getState();

      expect(state).toEqual({
        active: true,
        content: 'Hello',
        thinking: 'Thinking',
        messageId: 'msg-123',
        model: 'deepseek-chat'
      });
    });
  });

  describe('DOM indicator', () => {
    it('creates indicator when streaming starts', () => {
      actor.startStream('msg-123');

      const indicator = element.querySelector('.streaming-indicator');
      expect(indicator).toBeTruthy();
      expect(indicator?.classList.contains('active')).toBe(true);
    });

    it('deactivates indicator when streaming ends', () => {
      actor.startStream('msg-123');
      actor.endStream();

      const indicator = element.querySelector('.streaming-indicator');
      expect(indicator?.classList.contains('active')).toBe(false);
    });

    it('contains three dots', () => {
      actor.startStream('msg-123');

      const dots = element.querySelectorAll('.streaming-dot');
      expect(dots.length).toBe(3);
    });
  });
});
