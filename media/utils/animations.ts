/**
 * Animation Utilities
 *
 * Shared animation system for consistent, smooth transitions across actors.
 * Provides CSS-based animations with JavaScript control for timing.
 */

// Animation duration constants (in ms)
export const DURATIONS = {
  fast: 150,
  normal: 250,
  slow: 400,
  bubble: 300
} as const;

// Easing functions
export const EASINGS = {
  ease: 'ease',
  easeIn: 'ease-in',
  easeOut: 'ease-out',
  easeInOut: 'ease-in-out',
  // Smooth bubble effect
  bubble: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  // Gentle spring
  spring: 'cubic-bezier(0.68, -0.55, 0.265, 1.55)'
} as const;

/**
 * Global animation styles to inject once
 */
export const animationStyles = `
/* ========================================
   Animation System - Global Styles
   ======================================== */

/* CSS Variables for animation timing */
:root {
  --anim-fast: 150ms;
  --anim-normal: 250ms;
  --anim-slow: 400ms;
  --anim-bubble: 300ms;
  --ease-bubble: cubic-bezier(0.34, 1.56, 0.64, 1);
  --ease-spring: cubic-bezier(0.68, -0.55, 0.265, 1.55);
}

/* ----------------------------------------
   Fade Animations
   ---------------------------------------- */

.anim-fade-in {
  animation: fadeIn var(--anim-normal) ease forwards;
}

.anim-fade-out {
  animation: fadeOut var(--anim-normal) ease forwards;
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes fadeOut {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}

/* ----------------------------------------
   Slide Animations
   ---------------------------------------- */

.anim-slide-down {
  animation: slideDown var(--anim-normal) ease forwards;
  transform-origin: top center;
}

.anim-slide-up {
  animation: slideUp var(--anim-normal) ease forwards;
  transform-origin: top center;
}

@keyframes slideDown {
  from {
    opacity: 0;
    transform: translateY(-10px) scaleY(0.95);
  }
  to {
    opacity: 1;
    transform: translateY(0) scaleY(1);
  }
}

@keyframes slideUp {
  from {
    opacity: 1;
    transform: translateY(0) scaleY(1);
  }
  to {
    opacity: 0;
    transform: translateY(-10px) scaleY(0.95);
  }
}

/* ----------------------------------------
   Bubble/Pop Animations (for dropdowns)
   ---------------------------------------- */

.anim-bubble-in {
  animation: bubbleIn var(--anim-bubble) var(--ease-bubble) forwards;
  transform-origin: top center;
}

.anim-bubble-out {
  animation: bubbleOut var(--anim-fast) ease-out forwards;
  transform-origin: top center;
}

@keyframes bubbleIn {
  0% {
    opacity: 0;
    transform: scale(0.8) translateY(-8px);
  }
  50% {
    opacity: 1;
    transform: scale(1.02) translateY(2px);
  }
  100% {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

@keyframes bubbleOut {
  from {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
  to {
    opacity: 0;
    transform: scale(0.95) translateY(-5px);
  }
}

/* ----------------------------------------
   Message/Content Animations
   ---------------------------------------- */

.anim-message-in {
  animation: messageIn var(--anim-normal) ease forwards;
}

@keyframes messageIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* ----------------------------------------
   Paper Print Effect (content pushed up)
   ---------------------------------------- */

.anim-print-line {
  animation: printLine var(--anim-fast) ease-out forwards;
}

@keyframes printLine {
  from {
    opacity: 0.7;
    transform: translateY(3px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* ----------------------------------------
   Surface/Border Animations
   ---------------------------------------- */

.anim-surface-pulse {
  animation: surfacePulse 2s ease-in-out infinite;
}

@keyframes surfacePulse {
  0%, 100% {
    box-shadow: 0 -2px 8px rgba(var(--vscode-foreground-rgb, 128, 128, 128), 0.05);
  }
  50% {
    box-shadow: 0 -2px 12px rgba(var(--vscode-foreground-rgb, 128, 128, 128), 0.1);
  }
}

/* Active printing surface effect */
.anim-printing-surface {
  position: relative;
}

.anim-printing-surface::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(
    90deg,
    transparent,
    var(--vscode-focusBorder, #007acc),
    transparent
  );
  animation: printingLine 1.5s ease-in-out infinite;
  /* Ensure animation bar appears behind content, not on top */
  z-index: 0;
  pointer-events: none;
}

@keyframes printingLine {
  0%, 100% {
    opacity: 0.3;
    transform: scaleX(0.5);
  }
  50% {
    opacity: 0.7;
    transform: scaleX(1);
  }
}

/* ----------------------------------------
   Dropdown Hover Interactions
   ---------------------------------------- */

/* Jiggle animation for hover feedback */
.anim-jiggle {
  animation: jiggle 0.4s ease-in-out;
}

@keyframes jiggle {
  0%, 100% {
    transform: translateX(0);
  }
  10%, 30%, 50%, 70%, 90% {
    transform: translateX(-2px);
  }
  20%, 40%, 60%, 80% {
    transform: translateX(2px);
  }
}

/* Hover-ready state (cursor is over header) */
.anim-hover-ready {
  cursor: pointer;
  transition: background-color var(--anim-fast) ease;
}

.anim-hover-ready:hover {
  background-color: var(--vscode-list-hoverBackground, rgba(255,255,255,0.05));
}

/* ----------------------------------------
   Dropdown Expand/Collapse
   ---------------------------------------- */

.anim-expand {
  animation: expand var(--anim-normal) ease forwards;
  overflow: hidden;
}

.anim-collapse {
  animation: collapse var(--anim-normal) ease forwards;
  overflow: hidden;
}

@keyframes expand {
  from {
    max-height: 0;
    opacity: 0;
  }
  to {
    max-height: 1000px;
    opacity: 1;
  }
}

@keyframes collapse {
  from {
    max-height: 1000px;
    opacity: 1;
  }
  to {
    max-height: 0;
    opacity: 0;
  }
}

/* ----------------------------------------
   Utility Classes
   ---------------------------------------- */

/* Reduce motion for accessibility */
@media (prefers-reduced-motion: reduce) {
  .anim-fade-in,
  .anim-fade-out,
  .anim-slide-down,
  .anim-slide-up,
  .anim-bubble-in,
  .anim-bubble-out,
  .anim-message-in,
  .anim-print-line,
  .anim-expand,
  .anim-collapse,
  .anim-jiggle {
    animation-duration: 0.01ms !important;
  }

  .anim-surface-pulse,
  .anim-printing-surface::after {
    animation: none !important;
  }
}
`;

/**
 * Animation helper class
 */
export class AnimationHelper {
  private static stylesInjected = false;

  /**
   * Inject animation styles into the document
   */
  static injectStyles(): void {
    if (AnimationHelper.stylesInjected) return;
    if (typeof document === 'undefined') return;

    const style = document.createElement('style');
    style.setAttribute('data-animations', 'global');
    style.textContent = animationStyles;
    document.head.appendChild(style);
    AnimationHelper.stylesInjected = true;
  }

  /**
   * Animate an element appearing
   */
  static animateIn(
    element: HTMLElement,
    type: 'fade' | 'slide' | 'bubble' | 'message' = 'fade'
  ): Promise<void> {
    return new Promise((resolve) => {
      const className = {
        fade: 'anim-fade-in',
        slide: 'anim-slide-down',
        bubble: 'anim-bubble-in',
        message: 'anim-message-in'
      }[type];

      element.classList.add(className);

      const duration = type === 'bubble' ? DURATIONS.bubble : DURATIONS.normal;
      setTimeout(() => {
        element.classList.remove(className);
        resolve();
      }, duration);
    });
  }

  /**
   * Animate an element disappearing
   */
  static animateOut(
    element: HTMLElement,
    type: 'fade' | 'slide' | 'bubble' = 'fade'
  ): Promise<void> {
    return new Promise((resolve) => {
      const className = {
        fade: 'anim-fade-out',
        slide: 'anim-slide-up',
        bubble: 'anim-bubble-out'
      }[type];

      element.classList.add(className);

      const duration = type === 'bubble' ? DURATIONS.fast : DURATIONS.normal;
      setTimeout(() => {
        element.classList.remove(className);
        resolve();
      }, duration);
    });
  }

  /**
   * Animate element removal with cleanup
   */
  static async animateRemove(
    element: HTMLElement,
    type: 'fade' | 'slide' | 'bubble' = 'fade'
  ): Promise<void> {
    await this.animateOut(element, type);
    element.remove();
  }

  /**
   * Animate a dropdown expanding
   */
  static animateExpand(element: HTMLElement): Promise<void> {
    return new Promise((resolve) => {
      element.classList.add('anim-expand');
      setTimeout(() => {
        element.classList.remove('anim-expand');
        resolve();
      }, DURATIONS.normal);
    });
  }

  /**
   * Animate a dropdown collapsing
   */
  static animateCollapse(element: HTMLElement): Promise<void> {
    return new Promise((resolve) => {
      element.classList.add('anim-collapse');
      setTimeout(() => {
        element.classList.remove('anim-collapse');
        resolve();
      }, DURATIONS.normal);
    });
  }

  /**
   * Enable printing surface effect on an element
   */
  static enablePrintingSurface(element: HTMLElement): void {
    element.classList.add('anim-printing-surface');
  }

  /**
   * Disable printing surface effect
   */
  static disablePrintingSurface(element: HTMLElement): void {
    element.classList.remove('anim-printing-surface');
  }

  /**
   * Reset styles injection (for testing)
   */
  static resetStylesInjected(): void {
    AnimationHelper.stylesInjected = false;
    if (typeof document !== 'undefined') {
      const styleTag = document.querySelector('style[data-animations="global"]');
      if (styleTag) {
        styleTag.remove();
      }
    }
  }

  /**
   * Trigger jiggle animation on an element.
   * Uses inline styles to work inside Shadow DOM.
   */
  static jiggle(element: HTMLElement): void {
    // Remove any existing animation
    element.style.animation = 'none';
    // Force reflow to restart animation
    void element.offsetWidth;
    // Apply jiggle animation inline (works in Shadow DOM)
    element.style.animation = 'jiggle 0.9s ease-in-out';

    setTimeout(() => {
      element.style.animation = '';
    }, 900);
  }

  /**
   * Inject jiggle keyframes into a shadow root (call once per shadow root)
   */
  static injectJiggleKeyframes(shadowRoot: ShadowRoot): void {
    // Check if already injected
    if (shadowRoot.querySelector('style[data-jiggle]')) return;

    const style = document.createElement('style');
    style.setAttribute('data-jiggle', 'true');
    style.textContent = `
      @keyframes jiggle {
        0%, 100% { transform: translateX(0); }
        10%, 30%, 50%, 70%, 90% { transform: translateX(-2px); }
        20%, 40%, 60%, 80% { transform: translateX(2px); }
      }
    `;
    shadowRoot.appendChild(style);
  }

  /**
   * Setup hover-expand behavior for a dropdown
   * - Jiggles header on mouseenter
   * - Expands after delay if still hovering
   * - Collapses on mouseleave
   *
   * @param header - The clickable header element
   * @param body - The collapsible body element
   * @param container - The parent container that gets 'expanded' class
   * @param options - Configuration options
   * @returns Cleanup function to remove listeners
   */
  static setupHoverExpand(
    header: HTMLElement,
    body: HTMLElement,
    container: HTMLElement,
    options: {
      expandDelay?: number;
      onExpand?: () => void;
      onCollapse?: () => void;
    } = {}
  ): () => void {
    const { expandDelay = 500, onExpand, onCollapse } = options;

    let hoverTimer: ReturnType<typeof setTimeout> | null = null;
    let isHoverExpanded = false;

    const handleMouseEnter = () => {
      // Jiggle feedback
      this.jiggle(header);

      // Start expand timer
      hoverTimer = setTimeout(() => {
        if (!container.classList.contains('expanded')) {
          container.classList.add('expanded');
          container.classList.add('hover-expanded');
          isHoverExpanded = true;
          this.animateIn(body, 'bubble');
          onExpand?.();
        }
      }, expandDelay);
    };

    const handleMouseLeave = () => {
      // Cancel pending expand
      if (hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = null;
      }

      // Only collapse if we expanded via hover (not click)
      if (isHoverExpanded && container.classList.contains('hover-expanded')) {
        container.classList.remove('expanded');
        container.classList.remove('hover-expanded');
        isHoverExpanded = false;
        this.animateOut(body, 'bubble');
        onCollapse?.();
      }
    };

    // Add hover-ready styling
    header.classList.add('anim-hover-ready');

    // Attach listeners to container (so leaving body doesn't trigger collapse)
    container.addEventListener('mouseenter', handleMouseEnter);
    container.addEventListener('mouseleave', handleMouseLeave);

    // Return cleanup function
    return () => {
      if (hoverTimer) {
        clearTimeout(hoverTimer);
      }
      header.classList.remove('anim-hover-ready');
      container.removeEventListener('mouseenter', handleMouseEnter);
      container.removeEventListener('mouseleave', handleMouseLeave);
    };
  }

  /**
   * Smooth height transition when content changes.
   * Captures current height, allows content to change, then animates to new height.
   * Keeps scroll anchored to bottom if user was at bottom.
   *
   * @param container - The element whose height will change
   * @param scrollContainer - Optional scroll container to anchor (defaults to container's parent)
   * @param duration - Animation duration in ms (default 300)
   * @returns A function to call AFTER content has changed to trigger the animation
   */
  static prepareHeightTransition(
    container: HTMLElement,
    scrollContainer?: HTMLElement,
    duration: number = 300
  ): () => void {
    // Capture current state
    const startHeight = container.offsetHeight;
    const scroller = scrollContainer || container.parentElement;

    // Check if scrolled to bottom (with small tolerance)
    const wasAtBottom = scroller
      ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 10
      : false;

    // Return the function to call after content changes
    return () => {
      // Get natural height after content change
      const endHeight = container.offsetHeight;

      // If height didn't change significantly, skip animation
      if (Math.abs(endHeight - startHeight) < 5) return;

      // Set explicit start height
      container.style.height = `${startHeight}px`;
      container.style.overflow = 'hidden';
      container.style.transition = `height ${duration}ms ease-out`;

      // Force reflow
      void container.offsetHeight;

      // Animate to new height
      container.style.height = `${endHeight}px`;

      // Keep scroll at bottom if it was there
      if (wasAtBottom && scroller) {
        const animateScroll = () => {
          scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
        };
        // Run multiple times during animation to keep anchored
        const interval = setInterval(animateScroll, 16);
        setTimeout(() => {
          clearInterval(interval);
          animateScroll();
        }, duration);
      }

      // Cleanup after animation
      setTimeout(() => {
        container.style.height = '';
        container.style.overflow = '';
        container.style.transition = '';
      }, duration + 10);
    };
  }

  /**
   * Wrap a content-changing operation with smooth height transition.
   * Automatically handles the before/after measurement.
   *
   * @param container - The element whose height will change
   * @param contentChanger - Function that changes the content
   * @param scrollContainer - Optional scroll container to anchor
   * @param duration - Animation duration in ms
   */
  static async smoothHeightChange(
    container: HTMLElement,
    contentChanger: () => void | Promise<void>,
    scrollContainer?: HTMLElement,
    duration: number = 300
  ): Promise<void> {
    const finishTransition = this.prepareHeightTransition(container, scrollContainer, duration);
    await contentChanger();
    finishTransition();

    // Wait for animation to complete
    return new Promise(resolve => setTimeout(resolve, duration + 10));
  }
}
