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

  describe('CSS injection', () => {
    afterEach(() => {
      manager.resetStyles();
    });

    it('injects styles into document head', () => {
      const css = '.test-class { color: red; }';
      const result = manager.injectStyles('test-actor', css);

      expect(result).toBe(true);

      const styleTag = document.getElementById('actor-styles');
      expect(styleTag).toBeTruthy();
      expect(styleTag?.tagName).toBe('STYLE');
    });

    it('creates shared style element with proper attributes', () => {
      manager.injectStyles('test-actor', '.test { color: blue; }');

      const styleTag = document.getElementById('actor-styles');
      expect(styleTag?.getAttribute('data-managed-by')).toBe('EventStateManager');
    });

    it('includes actor ID comment marker in style content', () => {
      manager.injectStyles('my-actor', '.my-class { font-size: 12px; }');

      const content = manager.getStyleContent();
      expect(content).toContain('/* === my-actor === */');
      expect(content).toContain('.my-class { font-size: 12px; }');
    });

    it('tracks injected styles by actor ID', () => {
      expect(manager.hasStyles('streaming')).toBe(false);

      manager.injectStyles('streaming', '.streaming { display: block; }');

      expect(manager.hasStyles('streaming')).toBe(true);
    });

    it('only injects styles once per actor ID', () => {
      const css1 = '.first { color: red; }';
      const css2 = '.second { color: blue; }';

      const result1 = manager.injectStyles('same-actor', css1);
      const result2 = manager.injectStyles('same-actor', css2);

      expect(result1).toBe(true);
      expect(result2).toBe(false);

      // Should only contain first CSS
      const content = manager.getStyleContent();
      expect(content).toContain('.first { color: red; }');
      expect(content).not.toContain('.second { color: blue; }');
    });

    it('merges styles from multiple actors into single element', () => {
      manager.injectStyles('actor-a', '.a { margin: 0; }');
      manager.injectStyles('actor-b', '.b { padding: 0; }');
      manager.injectStyles('actor-c', '.c { border: 0; }');

      // Should still be only one style element
      const styleTags = document.querySelectorAll('#actor-styles');
      expect(styleTags.length).toBe(1);

      // Should contain all styles
      const content = manager.getStyleContent();
      expect(content).toContain('/* === actor-a === */');
      expect(content).toContain('/* === actor-b === */');
      expect(content).toContain('/* === actor-c === */');
      expect(content).toContain('.a { margin: 0; }');
      expect(content).toContain('.b { padding: 0; }');
      expect(content).toContain('.c { border: 0; }');
    });

    it('resetStyles clears all injected styles', () => {
      manager.injectStyles('actor-a', '.a {}');
      manager.injectStyles('actor-b', '.b {}');

      expect(manager.hasStyles('actor-a')).toBe(true);
      expect(manager.hasStyles('actor-b')).toBe(true);
      expect(document.getElementById('actor-styles')).toBeTruthy();

      manager.resetStyles();

      expect(manager.hasStyles('actor-a')).toBe(false);
      expect(manager.hasStyles('actor-b')).toBe(false);
      expect(document.getElementById('actor-styles')).toBeFalsy();
    });

    it('can re-inject styles after reset', () => {
      manager.injectStyles('test-actor', '.test1 {}');
      manager.resetStyles();

      const result = manager.injectStyles('test-actor', '.test2 {}');

      expect(result).toBe(true);
      expect(manager.hasStyles('test-actor')).toBe(true);
      expect(manager.getStyleContent()).toContain('.test2 {}');
    });

    it('getStyleContent returns empty string when no styles injected', () => {
      expect(manager.getStyleContent()).toBe('');
    });
  });
});
