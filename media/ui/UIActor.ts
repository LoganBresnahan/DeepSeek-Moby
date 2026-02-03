/**
 * UIActor Base Class
 *
 * Base class for actors that use the UI framework.
 * Integrates with EventStateManager for pub/sub.
 *
 * Example usage:
 *
 * ```typescript
 * class MyActor extends UIActor {
 *   constructor(manager: EventStateManager, element: HTMLElement) {
 *     super(manager, element, 'my-actor');
 *   }
 *
 *   protected getView(): UINode {
 *     return ui.dropdown(
 *       ui.dropdownHeader('My Component', { expanded: this.state.expanded }),
 *       ui.list(this.state.items.map(item => ui.text(item))),
 *       { expanded: this.state.expanded, onToggle: 'toggle' }
 *     );
 *   }
 *
 *   protected getStyles(): string {
 *     return `
 *       .dropdown { margin: 8px 0; }
 *     `;
 *   }
 *
 *   protected getHandlers(): Record<string, (e: Event, el: HTMLElement) => void> {
 *     return {
 *       toggle: () => {
 *         this.setState({ expanded: !this.state.expanded });
 *       }
 *     };
 *   }
 * }
 * ```
 */

import { EventStateManager } from '../state/EventStateManager';
import type { StateChangeEvent, ActorRegistration } from '../state/types';
import type { UINode } from './types';
import { render, baseStyles, bindEvents } from './render';

/**
 * Base state interface - extend this in your actor
 */
export interface UIActorState {
  [key: string]: unknown;
}

/**
 * Base class for UI actors
 */
export abstract class UIActor<S extends UIActorState = UIActorState> {
  protected readonly _manager: EventStateManager;
  protected readonly _element: HTMLElement;
  protected readonly _actorId: string;
  protected _shadowRoot: ShadowRoot | null = null;
  protected _container: HTMLElement | null = null;
  protected _state: S;
  private _rafId: number | null = null;
  private _renderPending = false;

  constructor(
    manager: EventStateManager,
    element: HTMLElement,
    actorId: string,
    initialState: S
  ) {
    this._manager = manager;
    this._element = element;
    this._actorId = actorId;
    this._state = initialState;

    this.register();
  }

  /**
   * Get current state
   */
  get state(): Readonly<S> {
    return this._state;
  }

  /**
   * Update state and trigger re-render
   */
  protected setState(updates: Partial<S>): void {
    const prevState = this._state;
    this._state = { ...this._state, ...updates };

    // Check if state actually changed
    if (this.shouldUpdate(prevState, this._state)) {
      this.scheduleRender();
      this.onStateChange(prevState, this._state);
    }
  }

  /**
   * Override to customize state comparison
   */
  protected shouldUpdate(prevState: S, nextState: S): boolean {
    // Simple shallow comparison
    for (const key in nextState) {
      if (prevState[key] !== nextState[key]) return true;
    }
    return false;
  }

  /**
   * Override to handle state changes (e.g., publish to EventStateManager)
   */
  protected onStateChange(_prevState: S, _nextState: S): void {
    // Override in subclass
  }

  /**
   * Override to return the view definition
   */
  protected abstract getView(): UINode;

  /**
   * Override to return additional styles
   */
  protected getStyles(): string {
    return '';
  }

  /**
   * Override to return event handlers
   */
  protected getHandlers(): Record<string, (e: Event, el: HTMLElement) => void> {
    return {};
  }

  /**
   * Override to specify publication keys
   */
  protected getPublicationKeys(): string[] {
    return [];
  }

  /**
   * Override to specify subscription keys
   */
  protected getSubscriptionKeys(): string[] {
    return [];
  }

  /**
   * Override to handle subscribed state changes
   */
  protected handleSubscription(_event: StateChangeEvent): void {
    // Override in subclass
  }

  /**
   * Schedule a render for next animation frame
   */
  protected scheduleRender(): void {
    if (this._renderPending) return;
    this._renderPending = true;

    this._rafId = requestAnimationFrame(() => {
      this._renderPending = false;
      this.render();
    });
  }

  /**
   * Force immediate render
   */
  protected render(): void {
    this.ensureContainer();
    if (!this._shadowRoot) return;

    const view = this.getView();
    const html = render(view);
    const styles = baseStyles + this.getStyles();

    // Update content
    const contentEl = this._shadowRoot.getElementById('content');
    if (contentEl) {
      contentEl.innerHTML = html;
    } else {
      this._shadowRoot.innerHTML = `
        <style>${styles}</style>
        <div id="content">${html}</div>
      `;
    }

    // Bind events
    bindEvents(this._shadowRoot, this.getHandlers());

    // Lifecycle hook
    this.onAfterRender();
  }

  /**
   * Override for post-render logic
   */
  protected onAfterRender(): void {
    // Override in subclass
  }

  /**
   * Create Shadow DOM container if needed
   */
  protected ensureContainer(): void {
    if (this._container) return;

    this._container = document.createElement('div');
    this._container.setAttribute('data-actor', this._actorId);
    this._container.setAttribute('data-ui-framework', 'true');
    this._shadowRoot = this._container.attachShadow({ mode: 'open' });
    this._element.appendChild(this._container);
  }

  /**
   * Register with EventStateManager
   */
  protected register(): void {
    const registration: ActorRegistration = {
      actorId: this._actorId,
      element: this._element,
      publicationKeys: this.getPublicationKeys(),
      subscriptionKeys: this.getSubscriptionKeys(),
    };

    this._manager.register(registration, {});

    // Listen for state changes
    if (this.getSubscriptionKeys().length > 0) {
      this._element.addEventListener('state-changed', ((e: CustomEvent<StateChangeEvent>) => {
        this.handleSubscription(e.detail);
      }) as EventListener);
    }
  }

  /**
   * Publish state to EventStateManager
   */
  protected publish(state: Record<string, unknown>): void {
    this._manager.handleStateChange({
      source: this._actorId,
      state,
      changedKeys: Object.keys(state),
      publicationChain: [],
      timestamp: Date.now(),
    });
  }

  /**
   * Show the container
   */
  show(): void {
    this._container?.removeAttribute('hidden');
  }

  /**
   * Hide the container
   */
  hide(): void {
    this._container?.setAttribute('hidden', '');
  }

  /**
   * Remove from DOM
   */
  clear(): void {
    if (this._container) {
      this._container.remove();
      this._container = null;
      this._shadowRoot = null;
    }
  }

  /**
   * Cleanup
   */
  destroy(): void {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
    }
    this.clear();
    this._manager.unregister(this._actorId);
  }
}
