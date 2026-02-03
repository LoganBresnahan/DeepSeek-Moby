/**
 * Tests for animations utility
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DURATIONS,
  EASINGS,
  animationStyles,
  AnimationHelper
} from '../../../media/utils/animations';

describe('DURATIONS', () => {
  it('exports animation duration constants', () => {
    expect(DURATIONS.fast).toBe(150);
    expect(DURATIONS.normal).toBe(250);
    expect(DURATIONS.slow).toBe(400);
    expect(DURATIONS.bubble).toBe(300);
  });
});

describe('EASINGS', () => {
  it('exports easing function strings', () => {
    expect(EASINGS.ease).toBe('ease');
    expect(EASINGS.easeIn).toBe('ease-in');
    expect(EASINGS.easeOut).toBe('ease-out');
    expect(EASINGS.easeInOut).toBe('ease-in-out');
    expect(EASINGS.bubble).toBe('cubic-bezier(0.34, 1.56, 0.64, 1)');
    expect(EASINGS.spring).toBe('cubic-bezier(0.68, -0.55, 0.265, 1.55)');
  });
});

describe('animationStyles', () => {
  it('contains CSS animation definitions', () => {
    expect(animationStyles).toContain('@keyframes fadeIn');
    expect(animationStyles).toContain('@keyframes fadeOut');
    expect(animationStyles).toContain('@keyframes slideDown');
    expect(animationStyles).toContain('@keyframes bubbleIn');
    expect(animationStyles).toContain('@keyframes jiggle');
  });

  it('contains CSS variables', () => {
    expect(animationStyles).toContain('--anim-fast');
    expect(animationStyles).toContain('--anim-normal');
    expect(animationStyles).toContain('--ease-bubble');
  });

  it('contains reduced motion media query', () => {
    expect(animationStyles).toContain('@media (prefers-reduced-motion: reduce)');
  });
});

describe('AnimationHelper', () => {
  beforeEach(() => {
    AnimationHelper.resetStylesInjected();
  });

  afterEach(() => {
    AnimationHelper.resetStylesInjected();
  });

  describe('injectStyles', () => {
    it('injects styles into document head', () => {
      AnimationHelper.injectStyles();

      const styleTag = document.querySelector('style[data-animations="global"]');
      expect(styleTag).toBeTruthy();
    });

    it('only injects styles once', () => {
      AnimationHelper.injectStyles();
      AnimationHelper.injectStyles();
      AnimationHelper.injectStyles();

      const styleTags = document.querySelectorAll('style[data-animations="global"]');
      expect(styleTags.length).toBe(1);
    });
  });

  describe('animateIn', () => {
    it('adds animation class and removes after duration', async () => {
      vi.useFakeTimers();
      const element = document.createElement('div');

      const promise = AnimationHelper.animateIn(element, 'fade');

      expect(element.classList.contains('anim-fade-in')).toBe(true);

      vi.advanceTimersByTime(DURATIONS.normal);
      await promise;

      expect(element.classList.contains('anim-fade-in')).toBe(false);
      vi.useRealTimers();
    });

    it('uses correct class for each animation type', () => {
      const element = document.createElement('div');

      AnimationHelper.animateIn(element, 'fade');
      expect(element.classList.contains('anim-fade-in')).toBe(true);
      element.className = '';

      AnimationHelper.animateIn(element, 'slide');
      expect(element.classList.contains('anim-slide-down')).toBe(true);
      element.className = '';

      AnimationHelper.animateIn(element, 'bubble');
      expect(element.classList.contains('anim-bubble-in')).toBe(true);
      element.className = '';

      AnimationHelper.animateIn(element, 'message');
      expect(element.classList.contains('anim-message-in')).toBe(true);
    });
  });

  describe('animateOut', () => {
    it('adds animation class and removes after duration', async () => {
      vi.useFakeTimers();
      const element = document.createElement('div');

      const promise = AnimationHelper.animateOut(element, 'fade');

      expect(element.classList.contains('anim-fade-out')).toBe(true);

      vi.advanceTimersByTime(DURATIONS.normal);
      await promise;

      expect(element.classList.contains('anim-fade-out')).toBe(false);
      vi.useRealTimers();
    });
  });

  describe('animateRemove', () => {
    it('animates out then removes element', async () => {
      vi.useFakeTimers();
      const parent = document.createElement('div');
      const element = document.createElement('div');
      parent.appendChild(element);

      expect(parent.contains(element)).toBe(true);

      const promise = AnimationHelper.animateRemove(element, 'fade');

      vi.advanceTimersByTime(DURATIONS.normal);
      await promise;

      expect(parent.contains(element)).toBe(false);
      vi.useRealTimers();
    });
  });

  describe('animateExpand', () => {
    it('adds expand class', async () => {
      vi.useFakeTimers();
      const element = document.createElement('div');

      const promise = AnimationHelper.animateExpand(element);
      expect(element.classList.contains('anim-expand')).toBe(true);

      vi.advanceTimersByTime(DURATIONS.normal);
      await promise;

      expect(element.classList.contains('anim-expand')).toBe(false);
      vi.useRealTimers();
    });
  });

  describe('animateCollapse', () => {
    it('adds collapse class', async () => {
      vi.useFakeTimers();
      const element = document.createElement('div');

      const promise = AnimationHelper.animateCollapse(element);
      expect(element.classList.contains('anim-collapse')).toBe(true);

      vi.advanceTimersByTime(DURATIONS.normal);
      await promise;

      expect(element.classList.contains('anim-collapse')).toBe(false);
      vi.useRealTimers();
    });
  });

  describe('printingSurface', () => {
    it('enables printing surface class', () => {
      const element = document.createElement('div');

      AnimationHelper.enablePrintingSurface(element);

      expect(element.classList.contains('anim-printing-surface')).toBe(true);
    });

    it('disables printing surface class', () => {
      const element = document.createElement('div');
      element.classList.add('anim-printing-surface');

      AnimationHelper.disablePrintingSurface(element);

      expect(element.classList.contains('anim-printing-surface')).toBe(false);
    });
  });

  describe('jiggle', () => {
    it('applies jiggle animation inline', () => {
      vi.useFakeTimers();
      const element = document.createElement('div');

      AnimationHelper.jiggle(element);

      expect(element.style.animation).toContain('jiggle');

      vi.advanceTimersByTime(900);

      expect(element.style.animation).toBe('');
      vi.useRealTimers();
    });
  });

  describe('injectJiggleKeyframes', () => {
    it('injects keyframes into shadow root', () => {
      const host = document.createElement('div');
      const shadowRoot = host.attachShadow({ mode: 'open' });

      AnimationHelper.injectJiggleKeyframes(shadowRoot);

      const style = shadowRoot.querySelector('style[data-jiggle]');
      expect(style).toBeTruthy();
      expect(style?.textContent).toContain('@keyframes jiggle');
    });

    it('only injects once per shadow root', () => {
      const host = document.createElement('div');
      const shadowRoot = host.attachShadow({ mode: 'open' });

      AnimationHelper.injectJiggleKeyframes(shadowRoot);
      AnimationHelper.injectJiggleKeyframes(shadowRoot);
      AnimationHelper.injectJiggleKeyframes(shadowRoot);

      const styles = shadowRoot.querySelectorAll('style[data-jiggle]');
      expect(styles.length).toBe(1);
    });
  });

  describe('setupHoverExpand', () => {
    it('returns cleanup function', () => {
      const header = document.createElement('div');
      const body = document.createElement('div');
      const container = document.createElement('div');

      const cleanup = AnimationHelper.setupHoverExpand(header, body, container);

      expect(typeof cleanup).toBe('function');
      cleanup();
    });

    it('adds hover-ready class to header', () => {
      const header = document.createElement('div');
      const body = document.createElement('div');
      const container = document.createElement('div');

      AnimationHelper.setupHoverExpand(header, body, container);

      expect(header.classList.contains('anim-hover-ready')).toBe(true);
    });

    it('cleanup removes hover-ready class', () => {
      const header = document.createElement('div');
      const body = document.createElement('div');
      const container = document.createElement('div');

      const cleanup = AnimationHelper.setupHoverExpand(header, body, container);
      cleanup();

      expect(header.classList.contains('anim-hover-ready')).toBe(false);
    });
  });

  describe('resetStylesInjected', () => {
    it('allows re-injection after reset', () => {
      AnimationHelper.injectStyles();
      let styleTags = document.querySelectorAll('style[data-animations="global"]');
      expect(styleTags.length).toBe(1);

      AnimationHelper.resetStylesInjected();
      styleTags = document.querySelectorAll('style[data-animations="global"]');
      expect(styleTags.length).toBe(0);

      AnimationHelper.injectStyles();
      styleTags = document.querySelectorAll('style[data-animations="global"]');
      expect(styleTags.length).toBe(1);
    });
  });
});
