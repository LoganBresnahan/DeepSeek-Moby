/**
 * Tests for EventStateManager
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventStateManager } from '../../../media/state/EventStateManager';
import type { ActorRegistration, StateChangeEvent } from '../../../media/state/types';

describe('EventStateManager', () => {
  let manager: EventStateManager;

  beforeEach(() => {
    manager = new EventStateManager();
  });

  describe('actor registration', () => {
    it('registers an actor', () => {
      const element = document.createElement('div');
      const actor: ActorRegistration = {
        actorId: 'test-actor',
        element,
        publicationKeys: ['test.value'],
        subscriptionKeys: []
      };

      manager.register(actor, { 'test.value': 42 });

      expect(manager.hasActor('test-actor')).toBe(true);
      expect(manager.getActorCount()).toBe(1);
    });

    it('stores initial state from registration', () => {
      const element = document.createElement('div');
      const actor: ActorRegistration = {
        actorId: 'test-actor',
        element,
        publicationKeys: ['test.value'],
        subscriptionKeys: []
      };

      manager.register(actor, { 'test.value': 42 });

      expect(manager.getState('test.value')).toBe(42);
    });

    it('broadcasts initial state to existing subscribers', () => {
      // First actor subscribes to test.*
      const subscriber = document.createElement('div');
      const received: string[] = [];
      subscriber.addEventListener('state-changed', ((e: CustomEvent<StateChangeEvent>) => {
        received.push(...e.detail.changedKeys);
      }) as EventListener);

      manager.register({
        actorId: 'subscriber',
        element: subscriber,
        publicationKeys: [],
        subscriptionKeys: ['test.*']
      }, {});

      // Second actor publishes test.value
      const publisher = document.createElement('div');
      manager.register({
        actorId: 'publisher',
        element: publisher,
        publicationKeys: ['test.value'],
        subscriptionKeys: []
      }, { 'test.value': 42 });

      expect(received).toContain('test.value');
    });

    it('unregisters an actor', () => {
      const element = document.createElement('div');
      manager.register({
        actorId: 'test-actor',
        element,
        publicationKeys: [],
        subscriptionKeys: []
      }, {});

      expect(manager.hasActor('test-actor')).toBe(true);

      manager.unregister('test-actor');

      expect(manager.hasActor('test-actor')).toBe(false);
      expect(manager.getActorCount()).toBe(0);
    });
  });

  describe('state management', () => {
    it('updates state via handleStateChange', () => {
      manager.handleStateChange({
        source: 'test-actor',
        state: { 'test.value': 123 },
        changedKeys: ['test.value'],
        publicationChain: [],
        timestamp: Date.now()
      });

      expect(manager.getState('test.value')).toBe(123);
    });

    it('returns deep cloned state from getAllState', () => {
      manager.handleStateChange({
        source: 'test-actor',
        state: { 'test.obj': { nested: true } },
        changedKeys: ['test.obj'],
        publicationChain: [],
        timestamp: Date.now()
      });

      const state1 = manager.getAllState();
      const state2 = manager.getAllState();

      expect(state1).toEqual(state2);
      expect(state1).not.toBe(state2);
      expect(state1['test.obj']).not.toBe(state2['test.obj']);
    });

    it('only updates keys that actually changed', () => {
      // Initial state
      manager.handleStateChange({
        source: 'actor-a',
        state: { 'test.value': 42 },
        changedKeys: ['test.value'],
        publicationChain: [],
        timestamp: Date.now()
      });

      // Try to "update" with same value - should not trigger broadcast
      const subscriber = document.createElement('div');
      let broadcastCount = 0;
      subscriber.addEventListener('state-changed', () => {
        broadcastCount++;
      });

      manager.register({
        actorId: 'subscriber',
        element: subscriber,
        publicationKeys: [],
        subscriptionKeys: ['test.value']
      }, {});

      manager.handleStateChange({
        source: 'actor-a',
        state: { 'test.value': 42 }, // Same value
        changedKeys: ['test.value'],
        publicationChain: [],
        timestamp: Date.now()
      });

      // No broadcast because value didn't actually change
      expect(broadcastCount).toBe(0);
    });
  });

  describe('broadcasting', () => {
    it('broadcasts to subscribers with matching exact keys', () => {
      const subscriber = document.createElement('div');
      const received: StateChangeEvent[] = [];
      subscriber.addEventListener('state-changed', ((e: CustomEvent<StateChangeEvent>) => {
        received.push(e.detail);
      }) as EventListener);

      manager.register({
        actorId: 'subscriber',
        element: subscriber,
        publicationKeys: [],
        subscriptionKeys: ['streaming.active']
      }, {});

      manager.handleStateChange({
        source: 'publisher',
        state: { 'streaming.active': true },
        changedKeys: ['streaming.active'],
        publicationChain: [],
        timestamp: Date.now()
      });

      expect(received).toHaveLength(1);
      expect(received[0].state['streaming.active']).toBe(true);
    });

    it('broadcasts to subscribers with matching wildcard patterns', () => {
      const subscriber = document.createElement('div');
      const received: string[] = [];
      subscriber.addEventListener('state-changed', ((e: CustomEvent<StateChangeEvent>) => {
        received.push(...e.detail.changedKeys);
      }) as EventListener);

      manager.register({
        actorId: 'subscriber',
        element: subscriber,
        publicationKeys: [],
        subscriptionKeys: ['streaming.*']
      }, {});

      manager.handleStateChange({
        source: 'publisher',
        state: {
          'streaming.active': true,
          'streaming.content': 'hello'
        },
        changedKeys: ['streaming.active', 'streaming.content'],
        publicationChain: [],
        timestamp: Date.now()
      });

      expect(received).toContain('streaming.active');
      expect(received).toContain('streaming.content');
    });

    it('does not broadcast to non-matching subscribers', () => {
      const subscriber = document.createElement('div');
      let receivedCount = 0;
      subscriber.addEventListener('state-changed', () => {
        receivedCount++;
      });

      manager.register({
        actorId: 'subscriber',
        element: subscriber,
        publicationKeys: [],
        subscriptionKeys: ['session.*'] // Different namespace
      }, {});

      manager.handleStateChange({
        source: 'publisher',
        state: { 'streaming.active': true },
        changedKeys: ['streaming.active'],
        publicationChain: [],
        timestamp: Date.now()
      });

      expect(receivedCount).toBe(0);
    });

    it('does not broadcast to the source actor', () => {
      const actor = document.createElement('div');
      let receivedCount = 0;
      actor.addEventListener('state-changed', () => {
        receivedCount++;
      });

      manager.register({
        actorId: 'self-publishing-actor',
        element: actor,
        publicationKeys: ['test.value'],
        subscriptionKeys: ['test.value'] // Subscribes to own key
      }, {});

      manager.handleStateChange({
        source: 'self-publishing-actor',
        state: { 'test.value': 42 },
        changedKeys: ['test.value'],
        publicationChain: [],
        timestamp: Date.now()
      });

      // Should not receive own broadcast
      expect(receivedCount).toBe(0);
    });
  });

  describe('loop prevention', () => {
    it('detects circular dependencies', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      manager.handleStateChange({
        source: 'actor-a',
        state: { foo: 1 },
        changedKeys: ['foo'],
        publicationChain: ['actor-a'], // Already in chain!
        timestamp: Date.now()
      });

      expect(errorSpy).toHaveBeenCalled();
      expect(errorSpy.mock.calls[0][0]).toContain('CIRCULAR');

      errorSpy.mockRestore();
    });

    it('warns on long publication chains', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      manager.handleStateChange({
        source: 'actor-z',
        state: { foo: 1 },
        changedKeys: ['foo'],
        publicationChain: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], // 10 deep
        timestamp: Date.now()
      });

      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('includes source in publication chain for downstream actors', () => {
      const subscriber = document.createElement('div');
      let receivedChain: string[] = [];
      subscriber.addEventListener('state-changed', ((e: CustomEvent<StateChangeEvent>) => {
        receivedChain = e.detail.publicationChain;
      }) as EventListener);

      manager.register({
        actorId: 'subscriber',
        element: subscriber,
        publicationKeys: [],
        subscriptionKeys: ['test.*']
      }, {});

      manager.handleStateChange({
        source: 'publisher',
        state: { 'test.value': 42 },
        changedKeys: ['test.value'],
        publicationChain: ['original-source'],
        timestamp: Date.now()
      });

      expect(receivedChain).toContain('original-source');
      expect(receivedChain).toContain('publisher');
    });
  });

  describe('external messages', () => {
    it('handles external messages from VS Code extension', () => {
      const subscriber = document.createElement('div');
      let receivedKey = '';
      subscriber.addEventListener('state-changed', ((e: CustomEvent<StateChangeEvent>) => {
        receivedKey = e.detail.changedKeys[0];
      }) as EventListener);

      manager.register({
        actorId: 'subscriber',
        element: subscriber,
        publicationKeys: [],
        subscriptionKeys: ['external.*']
      }, {});

      manager.handleExternalMessage('streamChunk', { content: 'hello' });

      expect(receivedKey).toBe('external.streamChunk');
      expect(manager.getState('external.streamChunk')).toEqual({ content: 'hello' });
    });
  });
});
