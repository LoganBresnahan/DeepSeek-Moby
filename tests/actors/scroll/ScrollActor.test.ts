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
    manager = new EventStateManager();
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
