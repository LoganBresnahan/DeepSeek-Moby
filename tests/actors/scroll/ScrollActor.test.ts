/**
 * Unit tests for ScrollActor
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushMicrotasks } from '../../setup';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { ScrollActor } from '../../../media/actors/scroll/ScrollActor';

describe('ScrollActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: ScrollActor;

  beforeEach(() => {
    manager = new EventStateManager({ batchBroadcasts: false });
    element = document.createElement('div');
    element.id = 'scroll-container';
    document.body.appendChild(element);

    actor = new ScrollActor(manager, element);
  });

  afterEach(() => {
    actor.destroy();
    manager.resetStyles();
    document.body.innerHTML = '';
  });

  describe('initialization', () => {
    it('registers with the manager', async () => {
      await flushMicrotasks();
      expect(manager.hasActor('scroll-container-ScrollActor')).toBe(true);
    });

    it('starts with auto-scroll enabled', () => {
      const state = actor.getState();
      expect(state.autoScroll).toBe(true);
      expect(state.userScrolled).toBe(false);
      expect(state.nearBottom).toBe(true);
    });

    it('initializes without style injection (no scroll button styles needed)', () => {
      expect(manager.hasStyles('scroll')).toBe(false);
    });
  });

  describe('scrollToBottom', () => {
    it('sets scroll position', () => {
      actor.scrollToBottom();

      // Verify state is updated
      expect(actor.isAtBottom()).toBe(true);
      expect(actor.hasUserScrolled()).toBe(false);
    });

    it('resets user scrolled state', () => {
      actor.disableAutoScroll();
      actor.scrollToBottom();

      expect(actor.hasUserScrolled()).toBe(false);
      expect(actor.isAutoScrollEnabled()).toBe(true);
    });

    it('publishes state changes when nearBottom changes', () => {
      // First disable auto-scroll to simulate user scrolling away
      actor.disableAutoScroll();

      // Clear spy history
      const spy = vi.spyOn(manager, 'handleStateChange');
      spy.mockClear();

      // Now scroll to bottom - this should publish autoScroll and userScrolled changes
      actor.scrollToBottom();

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            'scroll.autoScroll': true
          })
        })
      );
    });
  });

  describe('scrollToBottomIfNeeded', () => {
    it('scrolls when auto-scroll is enabled', () => {
      const scrollToBottomSpy = vi.spyOn(actor, 'scrollToBottom');
      actor.scrollToBottomIfNeeded();

      expect(scrollToBottomSpy).toHaveBeenCalled();
    });

    it('does not scroll when auto-scroll is disabled', () => {
      actor.disableAutoScroll();
      const scrollToBottomSpy = vi.spyOn(actor, 'scrollToBottom');
      actor.scrollToBottomIfNeeded();

      expect(scrollToBottomSpy).not.toHaveBeenCalled();
    });
  });

  describe('enableAutoScroll', () => {
    it('enables auto-scroll', () => {
      actor.disableAutoScroll();
      actor.enableAutoScroll();

      expect(actor.isAutoScrollEnabled()).toBe(true);
      expect(actor.hasUserScrolled()).toBe(false);
    });

    it('publishes state', () => {
      actor.disableAutoScroll();
      const spy = vi.spyOn(manager, 'handleStateChange');
      actor.enableAutoScroll();

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            'scroll.autoScroll': true
          })
        })
      );
    });
  });

  describe('disableAutoScroll', () => {
    it('disables auto-scroll', () => {
      actor.disableAutoScroll();

      expect(actor.isAutoScrollEnabled()).toBe(false);
    });

    it('publishes state', () => {
      const spy = vi.spyOn(manager, 'handleStateChange');
      actor.disableAutoScroll();

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            'scroll.autoScroll': false
          })
        })
      );
    });
  });

  describe('streaming subscription', () => {
    it('resets scroll state when streaming starts', () => {
      actor.disableAutoScroll();

      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.active': true },
        changedKeys: ['streaming.active'],
        publicationChain: [],
        timestamp: Date.now()
      });

      expect(actor.hasUserScrolled()).toBe(false);
      expect(actor.isAutoScrollEnabled()).toBe(true);
    });

    it('resets user scrolled when streaming ends', () => {
      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.active': true },
        changedKeys: ['streaming.active'],
        publicationChain: [],
        timestamp: Date.now()
      });

      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.active': false },
        changedKeys: ['streaming.active'],
        publicationChain: [],
        timestamp: Date.now()
      });

      expect(actor.hasUserScrolled()).toBe(false);
    });
  });

  describe('message count subscription', () => {
    it('scrolls on new message when auto-scroll enabled', () => {
      const scrollToBottomSpy = vi.spyOn(actor, 'scrollToBottom');

      manager.handleStateChange({
        source: 'message-actor',
        state: { 'message.count': 1 },
        changedKeys: ['message.count'],
        publicationChain: [],
        timestamp: Date.now()
      });

      expect(scrollToBottomSpy).toHaveBeenCalled();
    });

    it('does not scroll on new message when auto-scroll disabled', () => {
      actor.disableAutoScroll();
      const scrollToBottomSpy = vi.spyOn(actor, 'scrollToBottom');

      manager.handleStateChange({
        source: 'message-actor',
        state: { 'message.count': 1 },
        changedKeys: ['message.count'],
        publicationChain: [],
        timestamp: Date.now()
      });

      expect(scrollToBottomSpy).not.toHaveBeenCalled();
    });
  });

  describe('getState', () => {
    it('returns current state', () => {
      const state = actor.getState();

      expect(state).toHaveProperty('autoScroll');
      expect(state).toHaveProperty('userScrolled');
      expect(state).toHaveProperty('nearBottom');
    });
  });

  describe('isAtBottom', () => {
    it('returns nearBottom state', () => {
      expect(actor.isAtBottom()).toBe(true);
    });
  });

  describe('hasUserScrolled', () => {
    it('returns userScrolled state', () => {
      expect(actor.hasUserScrolled()).toBe(false);
    });
  });

  describe('isAutoScrollEnabled', () => {
    it('returns autoScroll state', () => {
      expect(actor.isAutoScrollEnabled()).toBe(true);

      actor.disableAutoScroll();
      expect(actor.isAutoScrollEnabled()).toBe(false);
    });
  });

  describe('sticky-scroll follow & re-engage (regression)', () => {
    // happy-dom (like jsdom) does no layout, so scrollHeight/clientHeight default
    // to 0. We control them directly to simulate the viewport's distance from the
    // bottom: distanceFromBottom = scrollHeight - (scrollTop + clientHeight).
    const CLIENT_HEIGHT = 500;
    const SCROLL_HEIGHT = 1000;

    /** Position the viewport `distanceFromBottom` pixels above the absolute bottom. */
    function setScrollGeometry(el: HTMLElement, distanceFromBottom: number): void {
      Object.defineProperty(el, 'scrollHeight', { value: SCROLL_HEIGHT, configurable: true });
      Object.defineProperty(el, 'clientHeight', { value: CLIENT_HEIGHT, configurable: true });
      // scrollTop = scrollHeight - clientHeight - distanceFromBottom
      el.scrollTop = SCROLL_HEIGHT - CLIENT_HEIGHT - distanceFromBottom;
    }

    function startStreaming(): void {
      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.active': true },
        changedKeys: ['streaming.active'],
        publicationChain: [],
        timestamp: Date.now()
      });
    }

    /** Simulate a user drag-up: first sit near the bottom, then move up. Only a
     *  scrollTop *decrease* reads as a drag-up, so the baseline scroll matters. */
    function userScrollUpTo(distanceFromBottom: number): void {
      setScrollGeometry(element, 0);
      element.dispatchEvent(new Event('scroll')); // baseline near bottom (high scrollTop)
      setScrollGeometry(element, distanceFromBottom);
      element.dispatchEvent(new Event('scroll')); // moved up (scrollTop decreased)
    }

    it('follows content growth to the bottom while engaged during streaming (bug 1)', async () => {
      startStreaming();
      // Engaged after streaming start. Give the container a real height, then grow
      // content via a DOM mutation (a dropdown host / new text container appearing) —
      // the follow must pin to the bottom regardless of the discrete jump.
      setScrollGeometry(element, 0);
      element.appendChild(document.createElement('div'));
      await flushMicrotasks();
      await new Promise(resolve => setTimeout(resolve, 30));

      expect(element.scrollTop).toBe(SCROLL_HEIGHT);
      expect(actor.isAutoScrollEnabled()).toBe(true);
    });

    it('does not follow content growth after the user scrolls up (bug 1 / R2)', async () => {
      startStreaming();
      userScrollUpTo(400); // drag up, disengage
      expect(actor.isAutoScrollEnabled()).toBe(false);

      const before = element.scrollTop;
      element.appendChild(document.createElement('div'));
      await flushMicrotasks();
      await new Promise(resolve => setTimeout(resolve, 30));

      // Stayed put — content growth must not yank a reading user to the bottom.
      expect(element.scrollTop).toBe(before);
      expect(actor.isAutoScrollEnabled()).toBe(false);
    });

    it('mouse movement no longer disengages auto-scroll', () => {
      startStreaming();
      element.dispatchEvent(new Event('mousemove'));

      expect(actor.isAutoScrollEnabled()).toBe(true);
      expect(actor.hasUserScrolled()).toBe(false);
    });

    it('disengages when the user drags up away from the bottom', () => {
      startStreaming();
      userScrollUpTo(400);

      expect(actor.isAutoScrollEnabled()).toBe(false);
      expect(actor.hasUserScrolled()).toBe(true);
    });

    it('re-engages when a user scroll returns within 100px of the bottom', () => {
      startStreaming();
      userScrollUpTo(400);
      expect(actor.isAutoScrollEnabled()).toBe(false);

      // Scroll back down to 40px from the bottom (within the 100px band).
      setScrollGeometry(element, 40);
      element.dispatchEvent(new Event('scroll'));

      expect(actor.isAutoScrollEnabled()).toBe(true);
      expect(actor.hasUserScrolled()).toBe(false);
      expect(actor.isAtBottom()).toBe(true);
    });

    it('does not re-engage when a user scroll lands far from the bottom (300px)', () => {
      startStreaming();
      userScrollUpTo(400);

      setScrollGeometry(element, 300);
      element.dispatchEvent(new Event('scroll'));

      expect(actor.isAutoScrollEnabled()).toBe(false);
      expect(actor.hasUserScrolled()).toBe(true);
    });

    it('does not yank to the bottom when the user drags up during the trail debounce window', async () => {
      startStreaming();
      setScrollGeometry(element, 0); // at bottom, engaged
      // Content grows → a trailScroll is queued on a 16ms debounce.
      element.appendChild(document.createElement('div'));
      await flushMicrotasks(); // let the mutation handler queue the timer

      // Before the timer fires, the user drags up and disengages.
      userScrollUpTo(400);
      expect(actor.isAutoScrollEnabled()).toBe(false);
      const before = element.scrollTop;

      // The queued trailScroll now fires — it must re-check engagement and NOT scroll.
      await new Promise(resolve => setTimeout(resolve, 30));

      expect(element.scrollTop).toBe(before);
      expect(actor.isAutoScrollEnabled()).toBe(false);
    });

    it('keeps the drag-up baseline in sync after a numeric scroll request', () => {
      startStreaming();
      setScrollGeometry(element, 0); // at bottom
      element.dispatchEvent(new Event('scroll')); // baseline near bottom, engaged
      expect(actor.isAutoScrollEnabled()).toBe(true);

      // A programmatic scroll-request jumps UP to 200px from the bottom (scrollTop 300).
      manager.handleStateChange({
        source: 'req',
        state: { 'scroll.request': { position: 300 } },
        changedKeys: ['scroll.request'],
        publicationChain: [],
        timestamp: Date.now()
      });
      // The scroll event the jump triggers must not be misread as a user drag-up.
      element.dispatchEvent(new Event('scroll'));

      expect(actor.isAutoScrollEnabled()).toBe(true);
    });

    it('does not re-engage on passive content resize alone while disengaged', async () => {
      startStreaming();
      userScrollUpTo(400); // disengaged, reading well above the bottom

      // A passive content-resize must not re-arm the follow; only a scroll gesture does.
      element.appendChild(document.createElement('span'));
      await flushMicrotasks();
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(actor.isAutoScrollEnabled()).toBe(false);
      expect(actor.hasUserScrolled()).toBe(true);
    });
  });

  describe('scroll event listener', () => {
    it('attaches scroll listener to element', () => {
      const addEventListenerSpy = vi.spyOn(element, 'addEventListener');

      actor.destroy();
      ScrollActor.resetStylesInjected();
      actor = new ScrollActor(manager, element);

      expect(addEventListenerSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
    });

    it('removes scroll listener on destroy', () => {
      const removeEventListenerSpy = vi.spyOn(element, 'removeEventListener');
      actor.destroy();

      expect(removeEventListenerSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
    });
  });
});
