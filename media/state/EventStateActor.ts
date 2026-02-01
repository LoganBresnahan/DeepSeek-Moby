/**
 * EventStateActor
 *
 * Base class for all actors in the event state system.
 * Actors can publish state and subscribe to state changes.
 */

import { EventStateManager } from './EventStateManager';
import { EventStateLogger } from './EventStateLogger';
import { deepEqual, deepClone, pick, uniqueId, wildcardMatch } from '../utils';
import type {
  ActorConfig,
  StateChangeEvent,
  GlobalState,
  PublicationMap,
  SubscriptionMap
} from './types';

export abstract class EventStateActor {
  /** Unique identifier for this actor */
  protected readonly actorId: string;

  /** DOM element this actor is bound to */
  protected readonly element: HTMLElement;

  /** Reference to the manager */
  protected readonly manager: EventStateManager;

  /** Logger instance */
  protected readonly logger: EventStateLogger;

  /** Keys this actor publishes (frozen for security) */
  private readonly publicationKeys: readonly string[];

  /** Keys/patterns this actor subscribes to (frozen for security) */
  private readonly subscriptionKeys: readonly string[];

  /** Publication getter functions */
  private readonly publications: PublicationMap;

  /** Subscription handler functions */
  private readonly subscriptions: SubscriptionMap;

  /** Cached published state (for change detection) */
  private publishedState: GlobalState = {};

  /** MutationObserver for DOM change detection */
  private domObserver?: MutationObserver;

  /** Current publication chain (for reactive publications) */
  private currentPublicationChain: string[] = [];

  /** Flag to prevent publishing from inside publication getters */
  private isReadingPublications = false;

  /** Bound event handler (for cleanup) */
  private boundStateChangedHandler: (event: Event) => void;

  constructor(config: ActorConfig) {
    this.element = config.element;
    this.manager = config.manager;
    this.logger = new EventStateLogger();

    // Generate unique actor ID
    // Always include class name to ensure uniqueness even when sharing elements
    // Note: Strip leading underscore from class name (added by some transpilers)
    const className = this.constructor.name.replace(/^_/, '');
    const elementId = config.element.id;
    this.actorId = elementId
      ? `${elementId}-${className}`
      : uniqueId(`${className}-`);

    // Don't override element.id if it exists (multiple actors may share an element)
    if (!config.element.id) {
      this.element.id = this.actorId;
    }

    // Store frozen copies of keys for security
    this.publicationKeys = Object.freeze([...Object.keys(config.publications)]);
    this.subscriptionKeys = Object.freeze([
      ...Object.keys(config.subscriptions),
      // Also include derived subscription keys from wildcard patterns
    ]);
    this.publications = config.publications;
    this.subscriptions = config.subscriptions;

    // Bind event handler
    this.boundStateChangedHandler = this.handleStateChanged.bind(this);

    // Setup event listener for state changes
    this.element.addEventListener('state-changed', this.boundStateChangedHandler);

    // Setup DOM observation if enabled
    if (config.enableDOMChangeDetection !== false) {
      this.setupDOMObserver();
    }

    // Defer registration until after derived class constructor completes
    // This ensures publication getters can access derived class properties
    queueMicrotask(() => this.register());
  }

  // ============================================
  // Scoping Helpers
  // ============================================

  /**
   * Create a key scoped to this specific actor instance
   * e.g., actorScope('status') => 'StreamingActor-1.status'
   */
  protected actorScope(key: string): string {
    return `${this.actorId}.${key}`;
  }

  /**
   * Create a key scoped to the actor type
   * e.g., typeScope('active') => 'streaming.active'
   */
  protected typeScope(key: string): string {
    const typeName = this.constructor.name
      .replace(/^_/, '')  // Strip leading underscore (added by some transpilers)
      .replace('Actor', '')
      .toLowerCase();
    return `${typeName}.${key}`;
  }

  /**
   * Create a global key
   * e.g., globalScope('theme') => 'global.theme'
   */
  protected globalScope(key: string): string {
    return `global.${key}`;
  }

  // ============================================
  // Registration
  // ============================================

  /**
   * Register this actor with the manager
   */
  private register(): void {
    const initialState = this.readPublishedState();
    this.publishedState = deepClone(initialState);

    this.manager.register(
      {
        actorId: this.actorId,
        element: this.element,
        publicationKeys: this.publicationKeys,
        subscriptionKeys: this.subscriptionKeys
      },
      initialState
    );
  }

  // ============================================
  // Publication
  // ============================================

  /**
   * Read current published state by calling all publication getters
   */
  protected readPublishedState(keys?: string[]): GlobalState {
    const keysToRead = keys || [...this.publicationKeys];
    const state: GlobalState = {};

    this.isReadingPublications = true;
    try {
      for (const key of keysToRead) {
        const getter = this.publications[key];
        if (getter) {
          try {
            state[key] = getter.call(this);
          } catch (error) {
            this.logger.publicationError(this.actorId, key, error);
          }
        }
      }
    } finally {
      this.isReadingPublications = false;
    }

    return state;
  }

  /**
   * Publish state changes to the manager
   */
  protected publish(stateChanges: GlobalState): void {
    // Prevent publishing from inside a publication getter
    if (this.isReadingPublications) {
      this.logger.publishInsideGetter(this.actorId);
      return;
    }

    // Validate all keys are authorized
    const invalidKeys = Object.keys(stateChanges).filter(
      key => !this.publicationKeys.includes(key)
    );
    if (invalidKeys.length > 0) {
      this.logger.unauthorizedPublication(this.actorId, invalidKeys);
      return;
    }

    // Find actual changes (deep equality)
    const changedKeys = Object.keys(stateChanges).filter(
      key => !deepEqual(this.publishedState[key], stateChanges[key])
    );

    if (changedKeys.length === 0) return;

    // Update local cache
    for (const key of changedKeys) {
      this.publishedState[key] = deepClone(stateChanges[key]);
    }

    const stateToSend = pick(stateChanges, changedKeys as (keyof typeof stateChanges)[]);

    // Dispatch to manager
    this.manager.handleStateChange({
      source: this.actorId,
      state: stateToSend,
      changedKeys,
      publicationChain: this.currentPublicationChain,
      timestamp: Date.now()
    });
  }

  // ============================================
  // Subscription
  // ============================================

  /**
   * Handle state change event from manager
   */
  private handleStateChanged(event: Event): void {
    const detail = (event as CustomEvent<StateChangeEvent>).detail;
    const { source, state, changedKeys, publicationChain } = detail;

    // Ignore own changes
    if (source === this.actorId) return;

    // Store chain for any reactive publications
    this.currentPublicationChain = publicationChain;

    // Pause DOM observer during subscription updates
    this.domObserver?.disconnect();

    try {
      for (const key of changedKeys) {
        // Check if we have a direct handler
        let handler = this.subscriptions[key];

        // If not, check wildcard patterns
        if (!handler) {
          for (const pattern of Object.keys(this.subscriptions)) {
            if (pattern.includes('*') && wildcardMatch(key, pattern)) {
              handler = this.subscriptions[pattern];
              break;
            }
          }
        }

        if (handler) {
          try {
            handler.call(this, state[key], key);
          } catch (error) {
            this.logger.subscriptionError(this.actorId, key, error);
          }
        }
      }
    } finally {
      this.resumeDOMObserver();
      this.currentPublicationChain = [];
    }
  }

  // ============================================
  // DOM Observation
  // ============================================

  /**
   * Setup MutationObserver for automatic DOM change detection
   */
  private setupDOMObserver(): void {
    this.domObserver = new MutationObserver(() => {
      this.handleDOMChange();
    });

    this.startDOMObserver();
  }

  /**
   * Start observing DOM changes
   */
  private startDOMObserver(): void {
    if (this.domObserver) {
      this.domObserver.observe(this.element, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      });
    }
  }

  /**
   * Resume DOM observer after subscription updates
   */
  private resumeDOMObserver(): void {
    this.startDOMObserver();
  }

  /**
   * Handle DOM mutations
   */
  private handleDOMChange(): void {
    const latestState = this.readPublishedState();

    const changedKeys = [...this.publicationKeys].filter(
      key => !deepEqual(this.publishedState[key], latestState[key])
    );

    if (changedKeys.length > 0) {
      this.publish(pick(latestState, changedKeys as (keyof typeof latestState)[]));
    }
  }

  // ============================================
  // Lifecycle
  // ============================================

  /**
   * Destroy this actor and clean up resources
   */
  destroy(): void {
    // Stop DOM observation
    this.domObserver?.disconnect();
    this.domObserver = undefined;

    // Remove event listener
    this.element.removeEventListener('state-changed', this.boundStateChangedHandler);

    // Unregister from manager
    this.manager.unregister(this.actorId);

    // Clear state
    this.publishedState = {};
    this.currentPublicationChain = [];
  }

  /**
   * Get the actor's ID
   */
  getId(): string {
    return this.actorId;
  }

  /**
   * Get the actor's element
   */
  getElement(): HTMLElement {
    return this.element;
  }
}
