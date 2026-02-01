/**
 * InterleavedShadowActor
 *
 * Base class for actors that create dynamic, shadow-encapsulated containers
 * during message streaming. Each container has its own Shadow DOM for
 * complete style isolation.
 *
 * Used by: ThinkingActor, ShellActor, ToolCallsActor, PendingChangesActor
 *
 * Architecture:
 * - The actor's root element is a mounting point in the chat flow
 * - Each container (thinking iteration, shell segment, etc.) is a separate
 *   shadow host with its own encapsulated styles
 * - Containers are created dynamically as content streams in
 * - No z-index coordination needed between containers
 *
 * Container Structure:
 *   <div id="thinking-1-123456" data-actor="thinking">  <!-- shadow host -->
 *     #shadow-root (open)
 *       <style>...container styles...</style>
 *       <div class="container">
 *         <!-- container content -->
 *       </div>
 *   </div>
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_shadow_DOM
 */

import { EventStateActor } from './EventStateActor';
import { EventStateManager } from './EventStateManager';
import type { ActorConfig, PublicationMap, SubscriptionMap } from './types';

export interface ShadowContainer {
  /** Unique identifier for this container */
  id: string;
  /** The shadow host element (lives in light DOM) */
  host: HTMLElement;
  /** The shadow root */
  shadow: ShadowRoot;
  /** The content container inside the shadow */
  content: HTMLElement;
  /** Timestamp when container was created */
  createdAt: number;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

export interface InterleavedShadowConfig {
  manager: EventStateManager;
  /** Parent element where containers will be appended */
  element: HTMLElement;
  publications: PublicationMap;
  subscriptions: SubscriptionMap;
  /** Actor name for debugging and data attributes */
  actorName: string;
  /**
   * CSS styles for each container's shadow DOM.
   * These styles are injected into EVERY container's shadow root.
   */
  containerStyles: string;
  /**
   * Optional base styles for the actor's host wrapper.
   * Default makes the host transparent (display: contents).
   */
  hostStyles?: string;
  /**
   * Shadow DOM mode for containers. Default is 'open'.
   */
  shadowMode?: 'open' | 'closed';
}

export abstract class InterleavedShadowActor extends EventStateActor {
  /** Actor name for debugging */
  protected readonly actorName: string;

  /** Styles injected into each container's shadow root */
  protected readonly containerStyles: string;

  /** Shadow mode for containers */
  protected readonly shadowMode: 'open' | 'closed';

  /** Map of container ID to container */
  protected containers: Map<string, ShadowContainer> = new Map();

  /** Counter for generating unique IDs */
  protected idCounter = 0;

  /** Track animation class removal timeouts for cleanup */
  private animationTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /** Instance counter for debugging and testing */
  private static _instanceCount = 0;
  protected readonly instanceId: number;

  constructor(config: InterleavedShadowConfig) {
    const actorConfig: ActorConfig = {
      manager: config.manager,
      element: config.element,
      publications: config.publications,
      subscriptions: config.subscriptions,
      enableDOMChangeDetection: false
    };

    super(actorConfig);

    // Generate instance ID for debugging
    InterleavedShadowActor._instanceCount++;
    this.instanceId = InterleavedShadowActor._instanceCount;

    this.actorName = config.actorName;
    this.containerStyles = this.buildContainerStyles(config.containerStyles);
    this.shadowMode = config.shadowMode ?? 'open';

    // Mark the parent element for debugging
    this.element.setAttribute('data-interleaved-actor', this.actorName);
  }

  /**
   * Build the full container styles including base styles.
   */
  private buildContainerStyles(customStyles: string): string {
    const baseStyles = `
      /* Base container styles */
      :host {
        display: block;
        position: relative;
      }

      :host([hidden]) {
        display: none;
      }

      .container {
        /* Reset for predictable styling */
        box-sizing: border-box;
      }

      /* Animation classes */
      :host(.anim-bubble-in) {
        animation: bubbleIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
      }

      :host(.anim-fade-out) {
        animation: fadeOut 0.2s ease forwards;
      }

      @keyframes bubbleIn {
        from {
          opacity: 0;
          transform: scale(0.95) translateY(-5px);
        }
        to {
          opacity: 1;
          transform: scale(1) translateY(0);
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

      /* Ensure VS Code theme variables work */
      *, *::before, *::after {
        box-sizing: border-box;
      }
    `;

    return baseStyles + '\n' + customStyles;
  }

  // ============================================
  // Container Management
  // ============================================

  /**
   * Create a new shadow-encapsulated container.
   * The container will be appended to the parent element at the current position.
   *
   * @param idPrefix - Prefix for the container ID (e.g., 'thinking', 'shell')
   * @param options - Additional options for the container
   * @returns The created container
   */
  protected createContainer(
    idPrefix: string,
    options?: {
      /** Additional CSS classes for the host element */
      hostClasses?: string[];
      /** Additional data attributes for the host element */
      dataAttributes?: Record<string, string>;
      /** Initial HTML content for the container */
      initialContent?: string;
      /** Metadata to store with the container */
      metadata?: Record<string, unknown>;
      /** Skip bubble animation */
      skipAnimation?: boolean;
    }
  ): ShadowContainer {
    this.idCounter++;
    const id = `${idPrefix}-${this.idCounter}-${Date.now()}`;

    // Create host element
    const host = document.createElement('div');
    host.id = id;
    host.setAttribute('data-actor', this.actorName);
    host.setAttribute('data-container-id', id);

    // Add custom classes
    if (options?.hostClasses?.length) {
      host.classList.add(...options.hostClasses);
    }

    // Add animation class unless skipped
    if (!options?.skipAnimation) {
      host.classList.add('anim-bubble-in');
    }

    // Add custom data attributes
    if (options?.dataAttributes) {
      Object.entries(options.dataAttributes).forEach(([key, value]) => {
        host.setAttribute(`data-${key}`, value);
      });
    }

    // Create shadow root
    const shadow = host.attachShadow({ mode: this.shadowMode });

    // Inject styles
    const styleElement = document.createElement('style');
    styleElement.textContent = this.containerStyles;
    shadow.appendChild(styleElement);

    // Create content container
    const content = document.createElement('div');
    content.className = 'container';
    if (options?.initialContent) {
      content.innerHTML = options.initialContent;
    }
    shadow.appendChild(content);

    // Append to parent element
    this.element.appendChild(host);

    // Remove animation class after animation completes
    if (!options?.skipAnimation) {
      const timeout = setTimeout(() => {
        host.classList.remove('anim-bubble-in');
        this.animationTimeouts.delete(id);
      }, 300);
      this.animationTimeouts.set(id, timeout);
    }

    // Create and store container reference
    const container: ShadowContainer = {
      id,
      host,
      shadow,
      content,
      createdAt: Date.now(),
      metadata: options?.metadata
    };

    this.containers.set(id, container);
    return container;
  }

  /**
   * Get a container by ID.
   */
  protected getContainer(id: string): ShadowContainer | undefined {
    return this.containers.get(id);
  }

  /**
   * Get the most recently created container.
   */
  protected getCurrentContainer(): ShadowContainer | undefined {
    let latest: ShadowContainer | undefined;
    this.containers.forEach(container => {
      if (!latest || container.createdAt > latest.createdAt) {
        latest = container;
      }
    });
    return latest;
  }

  /**
   * Get all containers.
   */
  protected getAllContainers(): ShadowContainer[] {
    return Array.from(this.containers.values());
  }

  /**
   * Get container count.
   */
  protected getContainerCount(): number {
    return this.containers.size;
  }

  // ============================================
  // Container Content Updates
  // ============================================

  /**
   * Update a container's content (replaces existing content).
   */
  protected updateContainerContent(id: string, html: string): void {
    const container = this.containers.get(id);
    if (container) {
      container.content.innerHTML = html;
    }
  }

  /**
   * Append HTML to a container's content.
   */
  protected appendToContainer(id: string, html: string): void {
    const container = this.containers.get(id);
    if (container) {
      container.content.insertAdjacentHTML('beforeend', html);
    }
  }

  /**
   * Query within a specific container's shadow DOM.
   */
  protected queryInContainer<T extends Element>(
    containerId: string,
    selector: string
  ): T | null {
    const container = this.containers.get(containerId);
    return container?.shadow.querySelector<T>(selector) ?? null;
  }

  /**
   * Query all within a specific container's shadow DOM.
   */
  protected queryAllInContainer<T extends Element>(
    containerId: string,
    selector: string
  ): NodeListOf<T> | null {
    const container = this.containers.get(containerId);
    return container?.shadow.querySelectorAll<T>(selector) ?? null;
  }

  // ============================================
  // Container Visibility
  // ============================================

  /**
   * Hide a container without removing it.
   */
  protected hideContainer(id: string): void {
    const container = this.containers.get(id);
    if (container) {
      container.host.setAttribute('hidden', '');
    }
  }

  /**
   * Show a hidden container.
   */
  protected showContainer(id: string): void {
    const container = this.containers.get(id);
    if (container) {
      container.host.removeAttribute('hidden');
    }
  }

  /**
   * Add a class to a container's host element.
   */
  protected addContainerClass(id: string, ...classes: string[]): void {
    const container = this.containers.get(id);
    if (container) {
      container.host.classList.add(...classes);
    }
  }

  /**
   * Remove a class from a container's host element.
   */
  protected removeContainerClass(id: string, ...classes: string[]): void {
    const container = this.containers.get(id);
    if (container) {
      container.host.classList.remove(...classes);
    }
  }

  /**
   * Toggle a class on a container's host element.
   */
  protected toggleContainerClass(id: string, className: string, force?: boolean): void {
    const container = this.containers.get(id);
    if (container) {
      container.host.classList.toggle(className, force);
    }
  }

  // ============================================
  // Container Removal
  // ============================================

  /**
   * Remove a container with optional fade-out animation.
   */
  protected removeContainer(id: string, animate = false): void {
    const container = this.containers.get(id);
    if (!container) return;

    // Clear any pending animation timeout
    const timeout = this.animationTimeouts.get(id);
    if (timeout) {
      clearTimeout(timeout);
      this.animationTimeouts.delete(id);
    }

    if (animate) {
      container.host.classList.add('anim-fade-out');
      setTimeout(() => {
        container.host.remove();
        this.containers.delete(id);
      }, 200);
    } else {
      container.host.remove();
      this.containers.delete(id);
    }
  }

  /**
   * Remove all containers.
   */
  protected clearContainers(animate = false): void {
    if (animate) {
      this.containers.forEach((container, id) => {
        this.removeContainer(id, true);
      });
    } else {
      // Clear animation timeouts
      this.animationTimeouts.forEach(timeout => clearTimeout(timeout));
      this.animationTimeouts.clear();

      // Remove all containers
      this.containers.forEach(container => {
        container.host.remove();
      });
      this.containers.clear();
    }
    this.idCounter = 0;
  }

  // ============================================
  // Event Handling
  // ============================================

  /**
   * Set up event delegation within a container's shadow DOM.
   *
   * @param containerId - ID of the container
   * @param eventType - Event type to listen for
   * @param selector - CSS selector to match against event targets
   * @param handler - Handler called when a matching element triggers the event
   */
  protected delegateInContainer<K extends keyof HTMLElementEventMap>(
    containerId: string,
    eventType: K,
    selector: string,
    handler: (event: HTMLElementEventMap[K], matchedElement: HTMLElement) => void
  ): void {
    const container = this.containers.get(containerId);
    if (!container) return;

    container.content.addEventListener(eventType, (event) => {
      const target = event.target as HTMLElement;
      const matched = target.closest<HTMLElement>(selector);
      if (matched && container.content.contains(matched)) {
        handler(event as HTMLElementEventMap[K], matched);
      }
    });
  }

  /**
   * Add an event listener to a specific element within a container.
   */
  protected addListenerInContainer<K extends keyof HTMLElementEventMap>(
    containerId: string,
    selector: string,
    eventType: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions
  ): void {
    const element = this.queryInContainer<HTMLElement>(containerId, selector);
    if (element) {
      element.addEventListener(eventType, handler as EventListener, options);
    }
  }

  // ============================================
  // Lifecycle
  // ============================================

  /**
   * Clean up all containers and the base actor.
   */
  destroy(): void {
    this.clearContainers();
    super.destroy();
  }

  // ============================================
  // Static Helpers (for testing)
  // ============================================

  /**
   * Get container style string (for testing).
   */
  getContainerStylesForTesting(): string {
    return this.containerStyles;
  }

  /**
   * Reset instance counter (for testing).
   */
  static resetInstanceCount(): void {
    InterleavedShadowActor._instanceCount = 0;
  }

  /**
   * Get current instance count (for testing).
   */
  static getInstanceCount(): number {
    return InterleavedShadowActor._instanceCount;
  }
}
