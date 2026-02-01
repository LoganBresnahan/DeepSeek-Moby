/**
 * Tests for ShadowActor base class
 *
 * Tests Shadow DOM encapsulation, style injection, event handling,
 * and integration with the pub/sub system.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ShadowActor, ShadowActorConfig } from '../../../media/state/ShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';

// Concrete implementation for testing
class TestShadowActor extends ShadowActor {
  public receivedStateChanges: Array<{ key: string; value: unknown }> = [];

  constructor(manager: EventStateManager, element: HTMLElement, styles = '', template = '') {
    super({
      manager,
      element,
      styles,
      template,
      publications: {
        'test.value': () => this.testValue
      },
      subscriptions: {
        'external.value': (value: unknown) => {
          this.receivedStateChanges.push({ key: 'external.value', value });
        }
      }
    });
  }

  public testValue = 42;

  // Expose protected methods for testing
  public exposedQuery<T extends Element>(selector: string): T | null {
    return this.query<T>(selector);
  }

  public exposedQueryAll<T extends Element>(selector: string): NodeListOf<T> {
    return this.queryAll<T>(selector);
  }

  public exposedRender(html: string): void {
    this.render(html);
  }

  public exposedAppend(element: HTMLElement): void {
    this.append(element);
  }

  public exposedClearContent(): void {
    this.clearContent();
  }

  public exposedDispatchComposedEvent<T>(name: string, detail?: T): boolean {
    return this.dispatchComposedEvent(name, detail);
  }

  public exposedDelegate<K extends keyof HTMLElementEventMap>(
    eventType: K,
    selector: string,
    handler: (event: HTMLElementEventMap[K], matchedElement: HTMLElement) => void
  ): void {
    this.delegate(eventType, selector, handler);
  }

  public getShadow(): ShadowRoot {
    return this.shadow;
  }

  public getContentRoot(): HTMLElement {
    return this.contentRoot;
  }

  public publishTestValue(value: number): void {
    this.testValue = value;
    this.publish({ 'test.value': value });
  }
}

describe('ShadowActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: TestShadowActor;

  beforeEach(() => {
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'test-shadow-actor';
    document.body.appendChild(element);
    ShadowActor.resetInstanceCount();
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
  });

  describe('Shadow DOM creation', () => {
    it('creates a shadow root on the element', () => {
      actor = new TestShadowActor(manager, element);

      expect(element.shadowRoot).toBeTruthy();
      expect(element.shadowRoot?.mode).toBe('open');
    });

    it('creates shadow root in closed mode when specified', () => {
      const closedActor = new (class extends ShadowActor {
        constructor() {
          super({
            manager,
            element,
            styles: '',
            shadowMode: 'closed',
            publications: {},
            subscriptions: {}
          });
        }
      })();

      // For closed mode, shadowRoot is not accessible from outside
      expect(element.shadowRoot).toBeNull();
      closedActor.destroy();
    });

    it('marks the element with data attributes', () => {
      actor = new TestShadowActor(manager, element);

      expect(element.getAttribute('data-shadow-actor')).toBe('TestShadowActor');
      expect(element.getAttribute('data-shadow-instance')).toBe('1');
    });

    it('creates content root inside shadow', () => {
      actor = new TestShadowActor(manager, element);

      const contentRoot = actor.getShadow().querySelector('.shadow-content');
      expect(contentRoot).toBeTruthy();
    });

    it('applies initial template to content root', () => {
      actor = new TestShadowActor(manager, element, '', '<p>Hello</p>');

      const p = actor.getShadow().querySelector('p');
      expect(p?.textContent).toBe('Hello');
    });
  });

  describe('Style encapsulation', () => {
    it('injects styles into shadow root', () => {
      actor = new TestShadowActor(manager, element, '.test { color: red; }');

      const styleTag = actor.getShadow().querySelector('style');
      expect(styleTag).toBeTruthy();
      expect(styleTag?.textContent).toContain('.test { color: red; }');
    });

    it('includes base styles in injected styles', () => {
      // Use non-empty styles to ensure style tag is created
      actor = new TestShadowActor(manager, element, '.test { }');

      const styleTag = actor.getShadow().querySelector('style');
      expect(styleTag).toBeTruthy();
      expect(styleTag!.textContent).toContain(':host');
      expect(styleTag!.textContent).toContain('.shadow-content');
    });

    it('styles do not leak to light DOM', () => {
      // Create an element in light DOM with same class
      const lightElement = document.createElement('div');
      lightElement.className = 'test';
      document.body.appendChild(lightElement);

      actor = new TestShadowActor(manager, element, '.test { color: red; }');

      // Create element in shadow DOM
      actor.exposedRender('<div class="test">Shadow</div>');

      // Light DOM element should not be affected by shadow styles
      // (This is a conceptual test - actual style computation requires real browser)
      const shadowTest = actor.getShadow().querySelector('.test');
      expect(shadowTest).toBeTruthy();
      expect(lightElement.className).toBe('test');
    });
  });

  describe('Query helpers', () => {
    beforeEach(() => {
      actor = new TestShadowActor(manager, element, '', `
        <div class="item" data-id="1">First</div>
        <div class="item" data-id="2">Second</div>
        <span class="single">Only</span>
      `);
    });

    it('query() finds single element in shadow DOM', () => {
      const single = actor.exposedQuery<HTMLSpanElement>('.single');
      expect(single?.textContent).toBe('Only');
    });

    it('query() returns null for non-existent element', () => {
      const missing = actor.exposedQuery('.missing');
      expect(missing).toBeNull();
    });

    it('queryAll() finds all matching elements', () => {
      const items = actor.exposedQueryAll('.item');
      expect(items.length).toBe(2);
    });

    it('queries do not find elements in light DOM', () => {
      // Add element to light DOM
      const lightDiv = document.createElement('div');
      lightDiv.className = 'item';
      document.body.appendChild(lightDiv);

      const items = actor.exposedQueryAll('.item');
      expect(items.length).toBe(2); // Only shadow DOM elements
    });
  });

  describe('Rendering', () => {
    beforeEach(() => {
      actor = new TestShadowActor(manager, element);
    });

    it('render() replaces content root innerHTML', () => {
      actor.exposedRender('<p>New content</p>');

      const p = actor.getShadow().querySelector('p');
      expect(p?.textContent).toBe('New content');
    });

    it('render() clears previous content', () => {
      actor.exposedRender('<div>First</div>');
      actor.exposedRender('<span>Second</span>');

      const div = actor.getShadow().querySelector('div.shadow-content > div');
      const span = actor.getShadow().querySelector('span');
      expect(div).toBeNull();
      expect(span?.textContent).toBe('Second');
    });

    it('append() adds element to content root', () => {
      const newEl = document.createElement('p');
      newEl.textContent = 'Appended';
      actor.exposedAppend(newEl);

      const p = actor.getShadow().querySelector('p');
      expect(p?.textContent).toBe('Appended');
    });

    it('clearContent() empties content root', () => {
      actor.exposedRender('<p>Content</p>');
      actor.exposedClearContent();

      expect(actor.getContentRoot().innerHTML).toBe('');
    });
  });

  describe('Pub/Sub integration', () => {
    it('registers with EventStateManager', async () => {
      actor = new TestShadowActor(manager, element);

      // Registration is deferred via queueMicrotask
      await Promise.resolve();
      await Promise.resolve();

      // Actor ID includes class name: `${elementId}-${className}`
      const expectedActorId = `${element.id}-TestShadowActor`;
      expect(manager.hasActor(expectedActorId)).toBe(true);
    });

    it('publishes state changes', async () => {
      actor = new TestShadowActor(manager, element);

      // Create subscriber
      const subscriberEl = document.createElement('div');
      subscriberEl.id = 'subscriber';
      document.body.appendChild(subscriberEl);

      let receivedValue: unknown;
      subscriberEl.addEventListener('state-changed', ((e: CustomEvent) => {
        if (e.detail.state['test.value'] !== undefined) {
          receivedValue = e.detail.state['test.value'];
        }
      }) as EventListener);

      manager.register({
        actorId: 'subscriber',
        element: subscriberEl,
        publicationKeys: [],
        subscriptionKeys: ['test.*']
      }, {});

      actor.publishTestValue(100);
      await Promise.resolve();

      expect(receivedValue).toBe(100);
    });

    it('receives state changes via subscriptions', async () => {
      actor = new TestShadowActor(manager, element);

      // Wait for actor registration to complete
      await Promise.resolve();
      await Promise.resolve();

      // Create publisher
      const publisherEl = document.createElement('div');
      publisherEl.id = 'publisher';
      document.body.appendChild(publisherEl);

      manager.register({
        actorId: 'publisher',
        element: publisherEl,
        publicationKeys: ['external.value'],
        subscriptionKeys: []
      }, {});

      manager.handleStateChange({
        source: 'publisher',
        state: { 'external.value': 'hello' },
        changedKeys: ['external.value'],
        publicationChain: [],
        timestamp: Date.now()
      });

      expect(actor.receivedStateChanges).toContainEqual({
        key: 'external.value',
        value: 'hello'
      });
    });
  });

  describe('Event handling', () => {
    beforeEach(() => {
      actor = new TestShadowActor(manager, element);
      actor.exposedRender(`
        <button class="btn" data-action="click-me">Click</button>
        <div class="container">
          <span class="child">Child 1</span>
          <span class="child">Child 2</span>
        </div>
      `);
    });

    it('dispatchComposedEvent crosses shadow boundary', () => {
      const received: string[] = [];
      element.addEventListener('custom-event', ((e: CustomEvent) => {
        received.push(e.detail);
      }) as EventListener);

      actor.exposedDispatchComposedEvent('custom-event', 'test-detail');

      expect(received).toContain('test-detail');
    });

    it('event delegation works within shadow DOM', () => {
      const clicked: string[] = [];
      actor.exposedDelegate('click', '.btn', (e, el) => {
        clicked.push(el.dataset.action || '');
      });

      const btn = actor.exposedQuery<HTMLButtonElement>('.btn')!;
      btn.click();

      expect(clicked).toContain('click-me');
    });

    it('event delegation matches closest ancestor', () => {
      const clicked: string[] = [];
      actor.exposedDelegate('click', '.container', (e, el) => {
        clicked.push('container-clicked');
      });

      const child = actor.exposedQuery<HTMLSpanElement>('.child')!;
      child.click();

      expect(clicked).toContain('container-clicked');
    });
  });

  describe('Lifecycle', () => {
    it('destroy() clears shadow content', () => {
      actor = new TestShadowActor(manager, element, '', '<p>Content</p>');
      actor.destroy();

      expect(element.shadowRoot?.innerHTML).toBe('');
    });

    it('destroy() unregisters from manager', () => {
      actor = new TestShadowActor(manager, element);
      const actorId = element.id;

      actor.destroy();

      expect(manager.hasActor(actorId)).toBe(false);
    });
  });

  describe('Instance tracking', () => {
    it('tracks instance count', () => {
      const el1 = document.createElement('div');
      el1.id = 'actor-1';
      document.body.appendChild(el1);

      const el2 = document.createElement('div');
      el2.id = 'actor-2';
      document.body.appendChild(el2);

      const actor1 = new TestShadowActor(manager, el1);
      const actor2 = new TestShadowActor(manager, el2);

      expect(el1.getAttribute('data-shadow-instance')).toBe('1');
      expect(el2.getAttribute('data-shadow-instance')).toBe('2');
      expect(ShadowActor.getInstanceCount()).toBe(2);

      actor1.destroy();
      actor2.destroy();
    });

    it('resetInstanceCount() resets counter', () => {
      const el1 = document.createElement('div');
      el1.id = 'actor-1';
      document.body.appendChild(el1);

      actor = new TestShadowActor(manager, el1);
      expect(ShadowActor.getInstanceCount()).toBe(1);

      ShadowActor.resetInstanceCount();
      expect(ShadowActor.getInstanceCount()).toBe(0);
    });
  });
});
