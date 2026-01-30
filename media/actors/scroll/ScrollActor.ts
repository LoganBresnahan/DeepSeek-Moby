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
import { scrollStyles as styles } from './styles';

export interface ScrollState {
  autoScroll: boolean;
  userScrolled: boolean;
  nearBottom: boolean;
}

export class ScrollActor extends EventStateActor {
  private static stylesInjected = false;

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
        'message.count': () => this.handleMessageCount()
      },
      enableDOMChangeDetection: false
    };

    super(config);
    this.injectStyles();
    this.setupScrollTracking();
  }

  /**
   * Inject CSS styles (once per class)
   */
  private injectStyles(): void {
    if (ScrollActor.stylesInjected) return;
    if (typeof document === 'undefined') return;

    const style = document.createElement('style');
    style.setAttribute('data-actor', 'scroll');
    style.textContent = styles;
    document.head.appendChild(style);
    ScrollActor.stylesInjected = true;
  }

  /**
   * Setup scroll tracking on the element
   */
  private setupScrollTracking(): void {
    this._scrollContainer = this.element;

    this._scrollHandler = () => {
      this.handleScroll();
    };

    this._scrollContainer.addEventListener('scroll', this._scrollHandler);
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
      this.publish({
        'scroll.userScrolled': false,
        'scroll.autoScroll': true
      });
    } else {
      // Reset user scrolled flag when streaming ends
      this._userScrolled = false;
      this.publish({ 'scroll.userScrolled': false });
    }
  }

  private handleMessageCount(): void {
    // Scroll to bottom on new message if auto-scroll is enabled
    if (this._autoScroll && !this._userScrolled) {
      this.scrollToBottom();
    }
  }

  // ============================================
  // Scroll Handling
  // ============================================

  private handleScroll(): void {
    const nearBottom = this.isNearBottom();
    const wasNearBottom = this._nearBottom;

    this._nearBottom = nearBottom;

    // Only track user scroll during streaming
    if (this._isStreaming) {
      // If user scrolled away from bottom, disable auto-scroll
      if (!nearBottom && wasNearBottom) {
        this._userScrolled = true;
        this._autoScroll = false;
        this.publish({
          'scroll.userScrolled': true,
          'scroll.autoScroll': false
        });
      }
      // If user scrolled back to bottom, re-enable auto-scroll
      else if (nearBottom && this._userScrolled) {
        this._userScrolled = false;
        this._autoScroll = true;
        this.publish({
          'scroll.userScrolled': false,
          'scroll.autoScroll': true
        });
      }
    }

    if (wasNearBottom !== nearBottom) {
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

    this._nearBottom = true;
    this._userScrolled = false;
    this._autoScroll = true;

    this.publish({
      'scroll.nearBottom': true,
      'scroll.userScrolled': false,
      'scroll.autoScroll': true
    });
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
    if (this._scrollHandler && this._scrollContainer) {
      this._scrollContainer.removeEventListener('scroll', this._scrollHandler);
    }
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
