/**
 * ScrollActor
 *
 * Manages auto-scroll behavior during streaming.
 * Tracks user scroll position and provides scroll-to-bottom functionality.
 *
 * Publications:
 * - scroll.autoScroll: boolean - whether auto-scroll is enabled
 * - scroll.userScrolled: boolean - whether user has scrolled up
 * - scroll.nearBottom: boolean - whether scroll is near bottom
 *
 * Subscriptions:
 * - streaming.active: boolean - track streaming state
 * - message.count: number - scroll on new messages
 */

import { EventStateActor } from '../../state/EventStateActor';
import { EventStateManager } from '../../state/EventStateManager';
import type { ActorConfig } from '../../state/types';

export interface ScrollState {
  autoScroll: boolean;
  userScrolled: boolean;
  nearBottom: boolean;
}

/**
 * Scroll request payload for pub/sub scroll control
 */
export interface ScrollRequest {
  /** Target position: 'bottom' for scroll to bottom, or a number for specific scrollTop */
  position: 'bottom' | number;
  /** Whether to use smooth scrolling */
  smooth?: boolean;
}

export class ScrollActor extends EventStateActor {
  // Internal state
  private _autoScroll = true;
  private _userScrolled = false;
  private _nearBottom = true;
  private _isStreaming = false;

  // Scroll threshold (pixels from bottom to consider "near bottom")
  private readonly SCROLL_THRESHOLD = 100;

  // Scroll container reference
  private _scrollContainer: HTMLElement | null = null;

  // Event handlers
  private _scrollHandler: (() => void) | null = null;

  // ResizeObserver for trailing scroll during content growth
  private _resizeObserver: ResizeObserver | null = null;

  // MutationObserver to watch for new children (shadow DOM hosts)
  private _mutationObserver: MutationObserver | null = null;

  // Track last scroll height to detect growth
  private _lastScrollHeight = 0;

  // Track last scrollTop so a scroll event can tell a user drag-up (scrollTop
  // decreased) apart from content growth pushing the bottom away (scrollTop steady).
  // Programmatic follow only ever scrolls DOWN, so it never reads as a drag-up.
  private _lastScrollTop = 0;

  // Debounce timer for scroll trailing
  private _trailTimer: ReturnType<typeof setTimeout> | null = null;


  constructor(manager: EventStateManager, element: HTMLElement) {
    const config: ActorConfig = {
      manager,
      element,
      publications: {
        'scroll.autoScroll': () => this._autoScroll,
        'scroll.userScrolled': () => this._userScrolled,
        'scroll.nearBottom': () => this._nearBottom
      },
      subscriptions: {
        'streaming.active': (value: unknown) => this.handleStreamingActive(value as boolean),
        'message.count': () => this.handleMessageCount(),
        'scroll.request': (value: unknown) => this.handleScrollRequest(value as ScrollRequest | null)
      },
      enableDOMChangeDetection: false
    };

    super(config);
    this.setupScrollTracking();
  }

  /**
   * Setup scroll tracking on the element
   */
  private setupScrollTracking(): void {
    this._scrollContainer = this.element;
    this._lastScrollHeight = this._scrollContainer.scrollHeight;

    this._scrollHandler = () => {
      this.handleScroll();
    };

    this._scrollContainer.addEventListener('scroll', this._scrollHandler);
    this._lastScrollTop = this._scrollContainer.scrollTop;

    // Setup ResizeObserver to detect content height changes
    // This enables smooth trailing during streaming
    this._resizeObserver = new ResizeObserver(() => {
      this.handleContentResize();
    });

    // Observe the container itself
    this._resizeObserver.observe(this._scrollContainer);

    // Also observe existing children (shadow DOM hosts)
    this.observeChildren();

    // Setup MutationObserver to watch for new children being added
    // This catches shadow DOM containers that are added dynamically
    this._mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          // Observe any newly added elements
          mutation.addedNodes.forEach((node) => {
            if (node instanceof HTMLElement) {
              this._resizeObserver?.observe(node);
            }
          });
          // Stop observing removed elements
          mutation.removedNodes.forEach((node) => {
            if (node instanceof HTMLElement) {
              this._resizeObserver?.unobserve(node);
            }
          });
        }
      }
      // Also check scroll height on any DOM change
      this.handleContentResize();
    });

    this._mutationObserver.observe(this._scrollContainer, {
      childList: true,
      subtree: true,
      characterData: true
    });

  }

  /**
   * Observe existing children for resize events
   */
  private observeChildren(): void {
    if (!this._scrollContainer || !this._resizeObserver) return;

    // Observe all direct children (these are shadow DOM hosts)
    Array.from(this._scrollContainer.children).forEach((child) => {
      if (child instanceof HTMLElement) {
        this._resizeObserver!.observe(child);
      }
    });
  }

  /**
   * Handle content resize - trail scroll if at bottom, smooth scroll on shrink
   */
  private handleContentResize(): void {
    if (!this._scrollContainer) return;

    const newScrollHeight = this._scrollContainer.scrollHeight;
    const heightDelta = newScrollHeight - this._lastScrollHeight;
    const heightGrew = heightDelta > 0;
    const heightShrunk = heightDelta < -20; // Significant shrink (more than 20px)
    this._lastScrollHeight = newScrollHeight;

    // Follow growing/shrinking content only while streaming and still engaged
    // (_autoScroll is the single source of truth — it is cleared the moment the
    // user scrolls up and restored when they return near the bottom). We no longer
    // gate on a cached _nearBottom, which went stale when discrete content — a
    // dropdown host, a new text container — was added in one jump rather than
    // token-by-token, so those updates stopped sticking. Re-engaging is handled
    // purely by handleScroll now, so a passive resize never snaps a reading user.
    if (!this._isStreaming || !this._autoScroll) return;

    // Handle content shrinking (jarring collapse) — smooth-scroll to the new bottom.
    if (heightShrunk) {
      this._scrollContainer.scrollTo({
        top: this._scrollContainer.scrollHeight,
        behavior: 'smooth'
      });
      this._nearBottom = true;
      this._lastScrollTop = this._scrollContainer.scrollHeight;
      return;
    }

    if (heightGrew) {
      // Debounce to batch rapid updates during streaming
      if (this._trailTimer) {
        clearTimeout(this._trailTimer);
      }
      this._trailTimer = setTimeout(() => {
        this.trailScroll();
      }, 16); // ~60fps
    }
  }

  /**
   * Smoothly trail the scroll to follow growing content
   */
  private trailScroll(): void {
    // Re-check engagement at fire time: the user may have dragged up during the
    // debounce window after this trail was queued. Without this guard the queued
    // scroll would yank a now-reading user back to the bottom.
    if (!this._scrollContainer || !this._autoScroll) return;

    // Use instant scroll during streaming for responsiveness
    // Smooth scroll can lag behind fast content
    this._scrollContainer.scrollTop = this._scrollContainer.scrollHeight;
    this._lastScrollTop = this._scrollContainer.scrollTop;
    this._nearBottom = true;
  }

  // ============================================
  // Subscription Handlers
  // ============================================

  private handleStreamingActive(active: boolean): void {
    this._isStreaming = active;

    if (active) {
      // Reset scroll state when streaming starts
      this._userScrolled = false;
      this._autoScroll = true;
      this._nearBottom = true;

      // Update lastScrollHeight to current state
      if (this._scrollContainer) {
        this._lastScrollHeight = this._scrollContainer.scrollHeight;
      }

      this.publish({
        'scroll.userScrolled': false,
        'scroll.autoScroll': true,
        'scroll.nearBottom': true
      });

      // Initial scroll to bottom when streaming starts
      this.scrollToBottom();
    } else {
      // Clear any pending trail timer
      if (this._trailTimer) {
        clearTimeout(this._trailTimer);
        this._trailTimer = null;
      }

      // Reset user scrolled flag when streaming ends
      this._userScrolled = false;
      this.publish({ 'scroll.userScrolled': false });
    }

    // Update button visibility

  }

  private handleMessageCount(): void {
    // Scroll to bottom on new message if auto-scroll is enabled
    if (this._autoScroll && !this._userScrolled) {
      this.scrollToBottom();
    }
  }

  private handleScrollRequest(request: ScrollRequest | null): void {
    if (!request || !this._scrollContainer) return;

    if (request.position === 'bottom') {
      this.scrollToBottom(request.smooth);
    } else if (typeof request.position === 'number') {
      if (request.smooth) {
        this._scrollContainer.scrollTo({
          top: request.position,
          behavior: 'smooth'
        });
      } else {
        this._scrollContainer.scrollTop = request.position;
      }
      // Sync the drag-up baseline to this programmatic target so the scroll event
      // it triggers isn't misread as a user drag-up (which would disengage follow).
      this._lastScrollTop = request.position;
    }
  }

  // ============================================
  // Scroll Handling
  // ============================================

  private handleScroll(): void {
    if (!this._scrollContainer) return;

    const scrollTop = this._scrollContainer.scrollTop;
    const prevScrollTop = this._lastScrollTop;
    this._lastScrollTop = scrollTop;

    const nearBottom = this.isNearBottom();
    const wasNearBottom = this._nearBottom;
    this._nearBottom = nearBottom;

    // Auto-scroll intent only flips while streaming.
    if (this._isStreaming) {
      // A genuine user drag-up is the ONLY thing that decreases scrollTop —
      // content growth keeps it steady and programmatic follow only increases it.
      // So scrolling up and away from the bottom is what disengages the follow.
      const draggedUp = scrollTop < prevScrollTop - 1;
      if (draggedUp && !nearBottom && this._autoScroll) {
        this._autoScroll = false;
        this._userScrolled = true;
        this.publish({
          'scroll.autoScroll': false,
          'scroll.userScrolled': true,
          'scroll.nearBottom': false
        });
        return;
      }

      // Returning to within the 100px near-bottom band re-arms the follow. The band
      // is forgiving because while content streams the bottom is a moving target and
      // a fling rarely lands within a few pixels of it.
      if (nearBottom && !this._autoScroll) {
        this._autoScroll = true;
        this._userScrolled = false;
        this._nearBottom = true;
        this.publish({
          'scroll.autoScroll': true,
          'scroll.userScrolled': false,
          'scroll.nearBottom': true
        });
        return;
      }
    }

    if (wasNearBottom !== nearBottom && !this._userScrolled) {
      this.publish({ 'scroll.nearBottom': nearBottom });
    }
  }

  /**
   * Check if scroll position is near the bottom
   */
  private isNearBottom(): boolean {
    if (!this._scrollContainer) return true;

    const { scrollTop, scrollHeight, clientHeight } = this._scrollContainer;
    const scrollBottom = scrollTop + clientHeight;
    return scrollHeight - scrollBottom < this.SCROLL_THRESHOLD;
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Scroll to bottom of container
   */
  scrollToBottom(smooth: boolean = false): void {
    if (!this._scrollContainer) return;

    if (smooth) {
      this._scrollContainer.scrollTo({
        top: this._scrollContainer.scrollHeight,
        behavior: 'smooth'
      });
    } else {
      this._scrollContainer.scrollTop = this._scrollContainer.scrollHeight;
    }

    // Keep the drag-up baseline in sync. For the instant path scrollTop is now the
    // bottom; for smooth it stays at the pre-animation value (which only increases as
    // the animation runs), so neither reads as a user drag-up.
    this._lastScrollTop = this._scrollContainer.scrollTop;
    this._nearBottom = true;
    this._userScrolled = false;
    this._autoScroll = true;

    this.publish({
      'scroll.nearBottom': true,
      'scroll.userScrolled': false,
      'scroll.autoScroll': true
    });

    // Hide the scroll button

  }

  /**
   * Scroll to bottom if user hasn't scrolled up
   */
  scrollToBottomIfNeeded(): void {
    if (this._autoScroll && !this._userScrolled) {
      this.scrollToBottom();
    }
  }

  /**
   * Enable auto-scroll
   */
  enableAutoScroll(): void {
    this._autoScroll = true;
    this._userScrolled = false;
    this.publish({
      'scroll.autoScroll': true,
      'scroll.userScrolled': false
    });
  }

  /**
   * Disable auto-scroll
   */
  disableAutoScroll(): void {
    this._autoScroll = false;
    this.publish({ 'scroll.autoScroll': false });
  }

  /**
   * Get current state
   */
  getState(): ScrollState {
    return {
      autoScroll: this._autoScroll,
      userScrolled: this._userScrolled,
      nearBottom: this._nearBottom
    };
  }

  /**
   * Check if auto-scroll is enabled
   */
  isAutoScrollEnabled(): boolean {
    return this._autoScroll;
  }

  /**
   * Check if user has scrolled up
   */
  hasUserScrolled(): boolean {
    return this._userScrolled;
  }

  /**
   * Check if near bottom
   */
  isAtBottom(): boolean {
    return this._nearBottom;
  }

  /**
   * Destroy and cleanup
   */
  destroy(): void {
    // Clean up scroll handler
    if (this._scrollHandler && this._scrollContainer) {
      this._scrollContainer.removeEventListener('scroll', this._scrollHandler);
    }

    // Clean up ResizeObserver
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }

    // Clean up MutationObserver
    if (this._mutationObserver) {
      this._mutationObserver.disconnect();
      this._mutationObserver = null;
    }

    // Clear any pending timers
    if (this._trailTimer) {
      clearTimeout(this._trailTimer);
      this._trailTimer = null;
    }

    // Remove scroll button
    this._scrollHandler = null;
    this._scrollContainer = null;
    super.destroy();
  }

  /**
   * Reset styles injection flag and remove style tag (for testing)
   */
  static resetStylesInjected(): void {
    ScrollActor.stylesInjected = false;
    if (typeof document !== 'undefined') {
      const styleTag = document.querySelector('style[data-actor="scroll"]');
      if (styleTag) {
        styleTag.remove();
      }
    }
  }
}
