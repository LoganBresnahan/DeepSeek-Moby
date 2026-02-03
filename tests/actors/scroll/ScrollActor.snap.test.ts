/**
 * Snapshot tests for ScrollActor
 * Captures state snapshots for regression detection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { ScrollActor } from '../../../media/actors/scroll/ScrollActor';

describe('ScrollActor Snapshots', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: ScrollActor;

  beforeEach(() => {
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'scroll-container';
    element.style.height = '200px';
    element.style.overflow = 'auto';
    document.body.appendChild(element);

    const content = document.createElement('div');
    content.style.height = '500px';
    element.appendChild(content);

    actor = new ScrollActor(manager, element);
  });

  afterEach(() => {
    actor.destroy();
    manager.resetStyles();
    document.body.innerHTML = '';
  });

  describe('injected styles', () => {
    it('injects styles via EventStateManager', () => {
      // Manager should have scroll styles registered
      expect(manager.hasStyles('scroll')).toBe(true);

      // Shared style element should exist
      const styleTag = document.getElementById('actor-styles');
      expect(styleTag).toBeTruthy();
      expect(styleTag?.getAttribute('data-managed-by')).toBe('EventStateManager');

      // Should contain scroll styles (marked with comment)
      expect(manager.getStyleContent()).toContain('/* === scroll === */');
    });
  });
});

describe('ScrollActor State Snapshots', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: ScrollActor;

  beforeEach(() => {
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'scroll-container';
    element.style.height = '200px';
    element.style.overflow = 'auto';
    document.body.appendChild(element);

    const content = document.createElement('div');
    content.style.height = '500px';
    element.appendChild(content);

    actor = new ScrollActor(manager, element);
  });

  afterEach(() => {
    actor.destroy();
    manager.resetStyles();
    document.body.innerHTML = '';
  });

  it('captures initial state', () => {
    expect(actor.getState()).toMatchSnapshot();
  });

  it('captures state with auto-scroll disabled', () => {
    actor.disableAutoScroll();
    expect(actor.getState()).toMatchSnapshot();
  });

  it('captures state during streaming with user scroll', () => {
    // Start streaming
    manager.handleStateChange({
      source: 'streaming-actor',
      state: { 'streaming.active': true },
      changedKeys: ['streaming.active'],
      publicationChain: [],
      timestamp: Date.now()
    });

    // Simulate user scrolling up
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));

    expect(actor.getState()).toMatchSnapshot();
  });
});
