/**
 * Tests for animations utility
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
