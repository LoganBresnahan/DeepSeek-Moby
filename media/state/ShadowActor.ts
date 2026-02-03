/**
 * ShadowActor
 *
 * Base class for actors that use Shadow DOM for style encapsulation.
 * Extends EventStateActor with Shadow DOM capabilities.
 *
 * Benefits:
 * - True style isolation - no CSS leaks in or out
 * - Simple class names - no prefixing needed
 * - No z-index coordination required
 * - VS Code theming still works (CSS custom properties pierce Shadow DOM)
 *
 * Usage:
 * - Extend this class instead of EventStateActor for UI actors
 * - Pass styles in config - they'll be scoped to this actor only
 * - Use this.shadow to access the shadow root
 * - Use this.query() / this.queryAll() for scoped DOM queries
 *
 * Event Handling:
 * - Events from shadow DOM are retargeted to the host element
 * - Custom events need { composed: true, bubbles: true } to cross shadow boundary
 * - The pub/sub system continues to work - events target the host (this.element)
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_shadow_DOM
 * @see https://javascript.info/shadow-dom-events
 */

import { EventStateActor } from './EventStateActor';
import { EventStateManager } from './EventStateManager';
import type { ActorConfig, PublicationMap, SubscriptionMap } from './types';

export interface ShadowActorConfig {
  manager: EventStateManager;
  element: HTMLElement;
  publications: PublicationMap;
  subscriptions: SubscriptionMap;
  /**
   * CSS styles scoped to this actor's shadow DOM.
   * These styles will ONLY affect elements inside this shadow root.
   */
  styles: string;
  /**
   * Optional initial HTML template for the shadow content.
   */
  template?: string;
  /**
   * Shadow DOM mode. Default is 'open' for inspectability and testing.
   * Use 'closed' only for security-sensitive components.
   */
  shadowMode?: 'open' | 'closed';
  /**
   * Enable DOM change detection via MutationObserver.
   * Default: false (shadow DOM changes are typically controlled)
   */
  enableDOMChangeDetection?: boolean;
}

export abstract class ShadowActor extends EventStateActor {
  /**
   * The shadow root for this actor.
   * Use this for direct shadow DOM access when needed.
   */
  protected readonly shadow: ShadowRoot;

  /**
   * The content container inside the shadow DOM.
   * Most rendering should target this element.
   */
  protected readonly contentRoot: HTMLElement;

  /**
   * Track if styles have been injected (for static style deduplication if needed)
   */
  private static _instanceCount = 0;
  protected readonly instanceId: number;

  constructor(config: ShadowActorConfig) {
    // Build the base actor config
    const actorConfig: ActorConfig = {
      manager: config.manager,
      element: config.element,
      publications: config.publications,
      subscriptions: config.subscriptions,
      enableDOMChangeDetection: config.enableDOMChangeDetection ?? false
    };

    super(actorConfig);

    // Generate instance ID for debugging
    ShadowActor._instanceCount++;
    this.instanceId = ShadowActor._instanceCount;

    // Create Shadow DOM
    const mode = config.shadowMode ?? 'open';
    this.shadow = this.element.attachShadow({ mode });

    // Mark the host element for debugging
    this.element.setAttribute('data-shadow-actor', this.constructor.name);
    this.element.setAttribute('data-shadow-instance', String(this.instanceId));

    // Inject scoped styles into shadow root
    if (config.styles) {
      const styleElement = document.createElement('style');
      styleElement.textContent = this.processStyles(config.styles);
      this.shadow.appendChild(styleElement);
    }

    // Create content container
    this.contentRoot = document.createElement('div');
    this.contentRoot.className = 'shadow-content';
    this.shadow.appendChild(this.contentRoot);

    // Apply initial template if provided
    if (config.template) {
      this.contentRoot.innerHTML = config.template;
    }
  }

  /**
   * Process styles before injection.
   * Adds common base styles and can be overridden for custom processing.
   */
  protected processStyles(styles: string): string {
    // Add base styles that all shadow actors should have
    const baseStyles = `
      /* Base shadow actor styles */
      :host {
        display: block;
      }

      :host([hidden]) {
        display: none;
      }

      .shadow-content {
        display: contents;
      }

      /* Ensure VS Code theme variables are available */
      *, *::before, *::after {
        box-sizing: border-box;
      }
    `;

    return baseStyles + '\n' + styles;
  }

  // ============================================
  // Shadow DOM Query Helpers
  // ============================================

  /**
   * Query for a single element within this actor's shadow DOM.
   * This is the shadow-scoped equivalent of document.querySelector().
   */
  protected query<T extends Element>(selector: string): T | null {
    return this.shadow.querySelector<T>(selector);
  }

  /**
   * Query for all matching elements within this actor's shadow DOM.
   * This is the shadow-scoped equivalent of document.querySelectorAll().
   */
  protected queryAll<T extends Element>(selector: string): NodeListOf<T> {
    return this.shadow.querySelectorAll<T>(selector);
  }

  /**
   * Query within the content root specifically.
   */
  protected queryContent<T extends Element>(selector: string): T | null {
    return this.contentRoot.querySelector<T>(selector);
  }

  /**
   * Query all within the content root specifically.
   */
  protected queryAllContent<T extends Element>(selector: string): NodeListOf<T> {
    return this.contentRoot.querySelectorAll<T>(selector);
  }

  // ============================================
  // Rendering Helpers
  // ============================================

  /**
   * Render HTML content into the shadow DOM content root.
   * This replaces all existing content.
   */
  protected render(html: string): void {
    this.contentRoot.innerHTML = html;
  }

  /**
   * Append an element to the shadow DOM content root.
   */
  protected append(element: HTMLElement): void {
    this.contentRoot.appendChild(element);
  }

  /**
   * Prepend an element to the shadow DOM content root.
   */
  protected prepend(element: HTMLElement): void {
    this.contentRoot.prepend(element);
  }

  /**
   * Clear all content from the shadow DOM content root.
   */
  protected clearContent(): void {
    this.contentRoot.innerHTML = '';
  }

  // ============================================
  // Event Helpers
  // ============================================

  /**
   * Dispatch a custom event that can cross the shadow boundary.
   * Use this for events that need to be heard outside the shadow DOM.
   *
   * @param eventName - Name of the custom event
   * @param detail - Event detail data
   * @param options - Additional event options
   */
  protected dispatchComposedEvent<T = unknown>(
    eventName: string,
    detail?: T,
    options?: { bubbles?: boolean; cancelable?: boolean }
  ): boolean {
    const event = new CustomEvent(eventName, {
      detail,
      bubbles: options?.bubbles ?? true,
      composed: true, // Cross shadow boundary
      cancelable: options?.cancelable ?? false
    });
    return this.element.dispatchEvent(event);
  }

  /**
   * Add an event listener within the shadow DOM with automatic cleanup.
   * The listener will be removed when the actor is destroyed.
   *
   * @param selector - CSS selector for the target element(s)
   * @param eventType - Event type (e.g., 'click', 'input')
   * @param handler - Event handler function
   * @param options - AddEventListener options
   */
  protected addShadowListener<K extends keyof HTMLElementEventMap>(
    selector: string,
    eventType: K,
    handler: (event: HTMLElementEventMap[K], element: HTMLElement) => void,
    options?: AddEventListenerOptions
  ): void {
    const elements = this.queryAll<HTMLElement>(selector);
    elements.forEach(el => {
      el.addEventListener(eventType, (e) => handler(e as HTMLElementEventMap[K], el), options);
    });
  }

  /**
   * Set up event delegation on the content root.
   * More efficient than individual listeners for dynamic content.
   *
   * @param eventType - Event type to listen for
   * @param selector - CSS selector to match against event targets
   * @param handler - Handler called when a matching element triggers the event
   */
  protected delegate<K extends keyof HTMLElementEventMap>(
    eventType: K,
    selector: string,
    handler: (event: HTMLElementEventMap[K], matchedElement: HTMLElement) => void
  ): void {
    this.contentRoot.addEventListener(eventType, (event) => {
      const target = event.target as HTMLElement;
      const matched = target.closest<HTMLElement>(selector);
      if (matched && this.contentRoot.contains(matched)) {
        handler(event as HTMLElementEventMap[K], matched);
      }
    });
  }

  // ============================================
  // Lifecycle
  // ============================================

  /**
   * Clean up the shadow DOM and base actor.
   */
  destroy(): void {
    // Clear shadow content
    this.shadow.innerHTML = '';
    super.destroy();
  }

  // ============================================
  // Static Helpers (for testing)
  // ============================================

  /**
   * Reset instance counter (for testing)
   */
  static resetInstanceCount(): void {
    ShadowActor._instanceCount = 0;
  }

  /**
   * Get current instance count (for testing)
   */
  static getInstanceCount(): number {
    return ShadowActor._instanceCount;
  }
}
