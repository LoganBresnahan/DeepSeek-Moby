/**
 * InterleavedContentActor
 *
 * Base class for actors that create dynamic content in the chat flow.
 * Provides common functionality for:
 * - Creating container elements dynamically
 * - Positioning elements inline with the response flow
 * - Tracking containers by ID
 * - Common clear/destroy logic
 * - CSS injection pattern
 *
 * Used by: ShellActor, ToolCallsActor, ThinkingActor, PendingChangesActor
 */

import { EventStateActor } from './EventStateActor';
import { EventStateManager } from './EventStateManager';
import type { ActorConfig, PublicationMap, SubscriptionMap } from './types';

export interface InterleavedContainer {
  id: string;
  element: HTMLElement;
  createdAt: number;
}

export interface InterleavedContentConfig {
  manager: EventStateManager;
  element: HTMLElement;
  publications: PublicationMap;
  subscriptions: SubscriptionMap;
  actorName: string;
  containerClassName: string;
  styles: string;
}

export abstract class InterleavedContentActor extends EventStateActor {
  private static _stylesInjectedFor: Set<string> = new Set();

  protected readonly actorName: string;
  protected readonly containerClassName: string;
  protected readonly styles: string;

  // Track all containers created by this actor
  protected containers: Map<string, InterleavedContainer> = new Map();

  // Counter for generating unique IDs
  protected idCounter = 0;

  constructor(config: InterleavedContentConfig) {
    const actorConfig: ActorConfig = {
      manager: config.manager,
      element: config.element,
      publications: config.publications,
      subscriptions: config.subscriptions,
      enableDOMChangeDetection: false
    };

    super(actorConfig);

    this.actorName = config.actorName;
    this.containerClassName = config.containerClassName;
    this.styles = config.styles;

    this.injectStyles();
  }

  /**
   * Inject CSS styles (once per actor class)
   */
  private injectStyles(): void {
    if (InterleavedContentActor._stylesInjectedFor.has(this.actorName)) return;
    if (typeof document === 'undefined') return;

    const style = document.createElement('style');
    style.setAttribute('data-actor', this.actorName);
    style.textContent = this.styles;
    document.head.appendChild(style);
    InterleavedContentActor._stylesInjectedFor.add(this.actorName);
  }

  // ============================================
  // Container Management
  // ============================================

  /**
   * Create a new container element and append it to the parent.
   * The container will appear at the current position in the chat flow.
   * Automatically applies bubble-in animation for smooth appearance.
   *
   * @param idPrefix - Prefix for the container ID (e.g., 'shell', 'tools', 'thinking')
   * @param additionalClasses - Additional CSS classes to add
   * @param dataAttributes - Additional data attributes to set
   * @returns The container ID and element
   */
  protected createContainer(
    idPrefix: string,
    additionalClasses?: string[],
    dataAttributes?: Record<string, string>
  ): InterleavedContainer {
    this.idCounter++;
    const id = `${idPrefix}-${this.idCounter}-${Date.now()}`;

    const element = document.createElement('div');
    element.id = id;
    // Add bubble animation class for smooth entry
    element.className = [
      this.containerClassName,
      'anim-bubble-in',
      ...(additionalClasses || [])
    ].filter(Boolean).join(' ');
    element.setAttribute('data-actor', this.actorName);

    // Set additional data attributes
    if (dataAttributes) {
      Object.entries(dataAttributes).forEach(([key, value]) => {
        element.setAttribute(`data-${key}`, value);
      });
    }

    // Append to parent - this positions it at the current location in the chat flow
    this.element.appendChild(element);

    // Remove animation class after animation completes
    setTimeout(() => {
      element.classList.remove('anim-bubble-in');
    }, 300); // Match DURATIONS.bubble

    const container: InterleavedContainer = {
      id,
      element,
      createdAt: Date.now()
    };

    this.containers.set(id, container);
    return container;
  }

  /**
   * Get a container by ID
   */
  protected getContainer(id: string): InterleavedContainer | undefined {
    return this.containers.get(id);
  }

  /**
   * Get the most recently created container
   */
  protected getCurrentContainer(): InterleavedContainer | undefined {
    let latest: InterleavedContainer | undefined;
    this.containers.forEach(container => {
      if (!latest || container.createdAt > latest.createdAt) {
        latest = container;
      }
    });
    return latest;
  }

  /**
   * Remove a container from the DOM and tracking
   */
  protected removeContainer(id: string): void {
    const container = this.containers.get(id);
    if (container) {
      container.element.remove();
      this.containers.delete(id);
    }
  }

  /**
   * Update a container's content
   */
  protected updateContainerContent(id: string, html: string): void {
    const container = this.containers.get(id);
    if (container) {
      container.element.innerHTML = html;
    }
  }

  /**
   * Hide a container without removing it
   */
  protected hideContainer(id: string): void {
    const container = this.containers.get(id);
    if (container) {
      container.element.style.display = 'none';
    }
  }

  /**
   * Show a hidden container
   */
  protected showContainer(id: string): void {
    const container = this.containers.get(id);
    if (container) {
      container.element.style.display = '';
    }
  }

  /**
   * Get all container IDs
   */
  protected getContainerIds(): string[] {
    return Array.from(this.containers.keys());
  }

  /**
   * Get container count
   */
  protected getContainerCount(): number {
    return this.containers.size;
  }

  // ============================================
  // Lifecycle
  // ============================================

  /**
   * Clear all containers from the DOM
   */
  clearContainers(): void {
    this.containers.forEach(container => {
      container.element.remove();
    });
    this.containers.clear();
    this.idCounter = 0;
  }

  /**
   * Destroy the actor and clean up
   */
  destroy(): void {
    this.clearContainers();
    super.destroy();
  }

  // ============================================
  // Static Helpers (for testing)
  // ============================================

  /**
   * Reset styles injection for a specific actor (for testing)
   */
  static resetStylesInjectedFor(actorName: string): void {
    InterleavedContentActor._stylesInjectedFor.delete(actorName);
    if (typeof document !== 'undefined') {
      const styleTag = document.querySelector(`style[data-actor="${actorName}"]`);
      if (styleTag) {
        styleTag.remove();
      }
    }
  }

  /**
   * Reset all styles injection (for testing)
   */
  static resetAllStylesInjected(): void {
    if (typeof document !== 'undefined') {
      InterleavedContentActor._stylesInjectedFor.forEach(actorName => {
        const styleTag = document.querySelector(`style[data-actor="${actorName}"]`);
        if (styleTag) {
          styleTag.remove();
        }
      });
    }
    InterleavedContentActor._stylesInjectedFor.clear();
  }
}
