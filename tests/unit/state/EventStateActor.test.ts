/**
 * Tests for EventStateActor
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventStateActor } from '../../../media/state/EventStateActor';
import { EventStateManager } from '../../../media/state/EventStateManager';
import type { ActorConfig, StateChangeEvent } from '../../../media/state/types';
import { resetUniqueIdCounter } from '../../../media/utils/uniqueId';

/**
 * Concrete test implementation of EventStateActor
 */
class TestActor extends EventStateActor {
  public testValue = 0;
  public receivedValues: Array<{ key: string; value: unknown }> = [];

  constructor(config: Omit<ActorConfig, 'publications' | 'subscriptions'> & {
    publications?: ActorConfig['publications'];
    subscriptions?: ActorConfig['subscriptions'];
  }) {
    super({
      ...config,
      publications: config.publications ?? {
        'test.value': () => this.testValue
      },
      subscriptions: config.subscriptions ?? {
        'external.message': (value: unknown, key: string) => {
          this.receivedValues.push({ key, value });
        }
      }
    });
  }

  // Expose protected methods for testing
  public testPublish(state: Record<string, unknown>): void {
    this.publish(state);
  }

  public testActorScope(key: string): string {
    return this.actorScope(key);
  }

  public testTypeScope(key: string): string {
    return this.typeScope(key);
  }

  public testGlobalScope(key: string): string {
    return this.globalScope(key);
  }

  public setTestValue(value: number): void {
    this.testValue = value;
    this.publish({ 'test.value': value });
  }
}

describe('EventStateActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;

  beforeEach(() => {
    resetUniqueIdCounter();
    manager = new EventStateManager();
    element = document.createElement('div');
  });

  afterEach(() => {
    manager.resetStyles();
  });

  describe('construction', () => {
    it('generates unique actor ID', async () => {
      const actor1 = new TestActor({ manager, element: document.createElement('div') });
      const actor2 = new TestActor({ manager, element: document.createElement('div') });

      // Wait for registration
      await new Promise(resolve => queueMicrotask(resolve));

      expect(actor1.getId()).not.toBe(actor2.getId());

      actor1.destroy();
      actor2.destroy();
    });

    it('uses element ID in actor ID when present', async () => {
      element.id = 'my-element';
      const actor = new TestActor({ manager, element });

      await new Promise(resolve => queueMicrotask(resolve));

      expect(actor.getId()).toContain('my-element');

      actor.destroy();
    });

    it('registers with manager after microtask', async () => {
      expect(manager.getActorCount()).toBe(0);

      const actor = new TestActor({ manager, element });

      // Not yet registered
      expect(manager.getActorCount()).toBe(0);

      // Wait for microtask
      await new Promise(resolve => queueMicrotask(resolve));

      expect(manager.getActorCount()).toBe(1);

      actor.destroy();
    });

    it('returns correct element', async () => {
      const actor = new TestActor({ manager, element });

      expect(actor.getElement()).toBe(element);

      await new Promise(resolve => queueMicrotask(resolve));
      actor.destroy();
    });
  });

  describe('scoping helpers', () => {
    it('actorScope creates actor-specific key', async () => {
      const actor = new TestActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      const scoped = actor.testActorScope('status');

      expect(scoped).toBe(`${actor.getId()}.status`);

      actor.destroy();
    });

    it('typeScope creates type-based key', async () => {
      const actor = new TestActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      const scoped = actor.testTypeScope('active');

      expect(scoped).toBe('test.active');

      actor.destroy();
    });

    it('globalScope creates global key', async () => {
      const actor = new TestActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      const scoped = actor.testGlobalScope('theme');

      expect(scoped).toBe('global.theme');

      actor.destroy();
    });
  });

  describe('publication', () => {
    it('publishes initial state on registration', async () => {
      const actor = new TestActor({ manager, element });
      actor.testValue = 42;

      await new Promise(resolve => queueMicrotask(resolve));

      expect(manager.getState('test.value')).toBe(42);

      actor.destroy();
    });

    it('publishes state changes', async () => {
      const actor = new TestActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      actor.setTestValue(100);

      expect(manager.getState('test.value')).toBe(100);

      actor.destroy();
    });

    it('does not publish unchanged values', async () => {
      const actor = new TestActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      actor.setTestValue(50);

      const handleStateSpy = vi.spyOn(manager, 'handleStateChange');

      // Try to publish same value
      actor.setTestValue(50);

      // Should not have called handleStateChange for same value
      expect(handleStateSpy).not.toHaveBeenCalled();

      handleStateSpy.mockRestore();
      actor.destroy();
    });

    it('rejects unauthorized publication keys', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const actor = new TestActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      // Try to publish unauthorized key
      actor.testPublish({ 'unauthorized.key': 'value' });

      expect(errorSpy).toHaveBeenCalled();

      errorSpy.mockRestore();
      actor.destroy();
    });
  });

  describe('subscription', () => {
    it('receives subscribed state changes', async () => {
      const actor = new TestActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      manager.handleExternalMessage('message', 'hello');

      expect(actor.receivedValues).toContainEqual({
        key: 'external.message',
        value: 'hello'
      });

      actor.destroy();
    });

    it('does not receive own publications', async () => {
      // Create actor that subscribes to its own key
      const selfSubscribingActor = new TestActor({
        manager,
        element,
        publications: {
          'test.self': () => 'value'
        },
        subscriptions: {
          'test.self': (value: unknown, key: string) => {
            selfSubscribingActor.receivedValues.push({ key, value });
          }
        }
      });

      await new Promise(resolve => queueMicrotask(resolve));

      // Publish to own key
      selfSubscribingActor.testPublish({ 'test.self': 'new-value' });

      // Should not receive own publication
      expect(selfSubscribingActor.receivedValues).toHaveLength(0);

      selfSubscribingActor.destroy();
    });

    it('handles wildcard subscriptions', async () => {
      const wildcardActor = new TestActor({
        manager,
        element,
        publications: {},
        subscriptions: {
          'streaming.*': (value: unknown, key: string) => {
            wildcardActor.receivedValues.push({ key, value });
          }
        }
      });

      await new Promise(resolve => queueMicrotask(resolve));

      // Create a publisher
      const publisher = document.createElement('div');
      manager.register({
        actorId: 'publisher',
        element: publisher,
        publicationKeys: ['streaming.active', 'streaming.content'],
        subscriptionKeys: []
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

      expect(wildcardActor.receivedValues).toContainEqual({
        key: 'streaming.active',
        value: true
      });
      expect(wildcardActor.receivedValues).toContainEqual({
        key: 'streaming.content',
        value: 'hello'
      });

      wildcardActor.destroy();
    });
  });

  describe('lifecycle', () => {
    it('unregisters from manager on destroy', async () => {
      const actor = new TestActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      expect(manager.getActorCount()).toBe(1);

      actor.destroy();

      expect(manager.getActorCount()).toBe(0);
    });

    it('removes event listener on destroy', async () => {
      const actor = new TestActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      const removeEventListenerSpy = vi.spyOn(element, 'removeEventListener');

      actor.destroy();

      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        'state-changed',
        expect.any(Function)
      );

      removeEventListenerSpy.mockRestore();
    });
  });

  describe('DOM change detection', () => {
    it('can be disabled via config', async () => {
      const actor = new TestActor({
        manager,
        element,
        enableDOMChangeDetection: false
      });

      await new Promise(resolve => queueMicrotask(resolve));

      // If DOM observation was enabled, modifying element would trigger publish
      // We just verify the actor doesn't throw when disabled
      element.innerHTML = '<div>test</div>';

      actor.destroy();
    });
  });
});
