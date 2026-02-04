/**
 * EventStateManager
 *
 * Central coordinator for global state in the actor system.
 * Manages actor registration, state updates, and broadcasts.
 */

import { deepEqual, deepClone, wildcardMatch } from '../utils';
import { EventStateLogger } from './EventStateLogger';
import type { ActorRegistration, StateChangeEvent, GlobalState } from './types';
import { shadowBaseStyles, interleavedBaseStyles } from './sharedStyles';

export class EventStateManager {
  /** Global state store */
  private globalState: GlobalState = {};

  /** Registered actors */
  private actors: Map<string, ActorRegistration> = new Map();

  /** Subscription index: exact key → Set of actor IDs (O(1) lookup) */
  private exactSubscriptions: Map<string, Set<string>> = new Map();

  /** Subscription index: wildcard pattern → Set of actor IDs (O(w) where w = wildcard count) */
  private wildcardSubscriptions: Map<string, Set<string>> = new Map();

  /** Maximum publication chain depth before warning/blocking */
  private maxChainDepth = 10;

  /** Logger instance */
  private logger: EventStateLogger;

  /** CSS injection tracking */
  private injectedStyles: Set<string> = new Set();
  private styleElement: HTMLStyleElement | null = null;

  /** Adopted stylesheets cache: CSS string hash → CSSStyleSheet */
  private stylesheetCache: Map<string, CSSStyleSheet> = new Map();

  /** Pre-parsed shared base stylesheets */
  private _shadowBaseSheet: CSSStyleSheet | null = null;
  private _interleavedBaseSheet: CSSStyleSheet | null = null;

  constructor() {
    this.logger = new EventStateLogger();
    this.logger.managerInit();
  }

  /**
   * Inject CSS styles for a light DOM actor.
   * Styles are merged into a single <style> element in document.head.
   * Safe to call multiple times - only injects once per actorId.
   *
   * @param actorId - Unique identifier for the actor
   * @param styles - CSS string to inject
   * @returns true if styles were injected, false if already existed
   */
  injectStyles(actorId: string, styles: string): boolean {
    // SSR safety
    if (typeof document === 'undefined') return false;

    // Already injected
    if (this.injectedStyles.has(actorId)) return false;

    // Lazy create merged style element
    if (!this.styleElement) {
      this.styleElement = document.createElement('style');
      this.styleElement.id = 'actor-styles';
      this.styleElement.setAttribute('data-managed-by', 'EventStateManager');
      document.head.appendChild(this.styleElement);
    }

    // Append with comment marker for debugging
    this.styleElement.textContent += `\n/* === ${actorId} === */\n${styles}\n`;
    this.injectedStyles.add(actorId);
    return true;
  }

  /**
   * Check if styles for an actor have been injected.
   */
  hasStyles(actorId: string): boolean {
    return this.injectedStyles.has(actorId);
  }

  /**
   * Reset style injection state (for testing).
   * Removes the shared style element and clears tracking.
   */
  resetStyles(): void {
    if (this.styleElement) {
      this.styleElement.remove();
      this.styleElement = null;
    }
    this.injectedStyles.clear();
  }

  /**
   * Get injected style content (for testing).
   */
  getStyleContent(): string {
    return this.styleElement?.textContent ?? '';
  }

  // ============================================
  // Adopted StyleSheets Management
  // ============================================

  /**
   * Get or create a CSSStyleSheet from CSS string.
   * Caches parsed stylesheets to avoid duplicate parsing.
   *
   * This is the core of the adoptedStyleSheets optimization:
   * - Parse CSS once, share the CSSStyleSheet object across multiple shadow roots
   * - Reduces memory usage (one parsed CSSOM tree vs N copies)
   * - Eliminates redundant CSS parsing
   *
   * @param css - CSS string to parse
   * @param cacheKey - Optional cache key (defaults to CSS string hash)
   * @returns CSSStyleSheet that can be adopted by shadow roots
   */
  getStyleSheet(css: string, cacheKey?: string): CSSStyleSheet {
    const key = cacheKey ?? this.hashString(css);

    let sheet = this.stylesheetCache.get(key);
    if (!sheet) {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      this.stylesheetCache.set(key, sheet);
    }

    return sheet;
  }

  /**
   * Get the shared base stylesheet for ShadowActor.
   * Lazily created on first access.
   */
  getShadowBaseSheet(): CSSStyleSheet {
    if (!this._shadowBaseSheet) {
      this._shadowBaseSheet = new CSSStyleSheet();
      this._shadowBaseSheet.replaceSync(shadowBaseStyles);
    }
    return this._shadowBaseSheet;
  }

  /**
   * Get the shared base stylesheet for InterleavedShadowActor.
   * Lazily created on first access.
   */
  getInterleavedBaseSheet(): CSSStyleSheet {
    if (!this._interleavedBaseSheet) {
      this._interleavedBaseSheet = new CSSStyleSheet();
      this._interleavedBaseSheet.replaceSync(interleavedBaseStyles);
    }
    return this._interleavedBaseSheet;
  }

  /**
   * Clear stylesheet cache (for testing).
   */
  resetStyleSheets(): void {
    this.stylesheetCache.clear();
    this._shadowBaseSheet = null;
    this._interleavedBaseSheet = null;
  }

  /**
   * Get stylesheet cache size (for testing/debugging).
   */
  getStyleSheetCacheSize(): number {
    return this.stylesheetCache.size;
  }

  /**
   * Simple string hash for cache keys.
   * Uses djb2 algorithm - fast and good distribution for CSS strings.
   */
  private hashString(str: string): string {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash = hash & hash; // Convert to 32-bit integer
    }
    return 'css_' + Math.abs(hash).toString(36);
  }

  /**
   * Register an actor with the manager
   */
  register(actor: ActorRegistration, initialState: GlobalState): void {
    this.actors.set(actor.actorId, actor);

    // Build subscription index for O(1) lookup
    for (const pattern of actor.subscriptionKeys) {
      if (pattern.includes('*')) {
        // Wildcard pattern - store separately
        if (!this.wildcardSubscriptions.has(pattern)) {
          this.wildcardSubscriptions.set(pattern, new Set());
        }
        this.wildcardSubscriptions.get(pattern)!.add(actor.actorId);
      } else {
        // Exact key - O(1) indexable
        if (!this.exactSubscriptions.has(pattern)) {
          this.exactSubscriptions.set(pattern, new Set());
        }
        this.exactSubscriptions.get(pattern)!.add(actor.actorId);
      }
    }

    this.logger.actorRegister(
      actor.actorId,
      actor.publicationKeys,
      actor.subscriptionKeys
    );

    // Process initial state
    const changedKeys = this.updateGlobalState(initialState);
    if (changedKeys.length > 0) {
      // Broadcast initial state to other actors
      this.broadcast(actor.actorId, changedKeys, []);
    }
  }

  /**
   * Unregister an actor from the manager
   */
  unregister(actorId: string): void {
    const actor = this.actors.get(actorId);

    // Clean up subscription index
    if (actor) {
      for (const pattern of actor.subscriptionKeys) {
        if (pattern.includes('*')) {
          this.wildcardSubscriptions.get(pattern)?.delete(actorId);
          // Clean up empty sets
          if (this.wildcardSubscriptions.get(pattern)?.size === 0) {
            this.wildcardSubscriptions.delete(pattern);
          }
        } else {
          this.exactSubscriptions.get(pattern)?.delete(actorId);
          // Clean up empty sets
          if (this.exactSubscriptions.get(pattern)?.size === 0) {
            this.exactSubscriptions.delete(pattern);
          }
        }
      }
    }

    this.actors.delete(actorId);
    this.logger.actorUnregister(actorId, this.actors.size);
  }

  /**
   * Get a state value by key
   */
  getState(key: string): unknown {
    return this.globalState[key];
  }

  /**
   * Get all state (deep cloned)
   */
  getAllState(): GlobalState {
    return deepClone(this.globalState);
  }

  /**
   * Handle state change from an actor
   */
  handleStateChange(event: StateChangeEvent): void {
    const { source, state, publicationChain } = event;

    // Loop prevention: Check if source already in chain
    if (publicationChain.includes(source)) {
      this.logger.circularDependency([...publicationChain, source]);
      return;
    }

    // Chain depth protection
    if (publicationChain.length >= this.maxChainDepth) {
      this.logger.longChainWarning(publicationChain.length, publicationChain);
      return;
    }

    // Update global state
    const changedKeys = this.updateGlobalState(state);

    if (changedKeys.length > 0) {
      this.logger.stateChangeFlow(source, changedKeys, publicationChain.length);
      this.broadcast(source, changedKeys, publicationChain);
    }
  }

  /**
   * Handle external message from VS Code extension
   * Routes the message to appropriate state changes
   */
  handleExternalMessage(type: string, data: Record<string, unknown>): void {
    // Create a synthetic state change event
    const stateKey = `external.${type}`;

    this.handleStateChange({
      source: 'vscode-extension',
      state: { [stateKey]: data },
      changedKeys: [stateKey],
      publicationChain: [],
      timestamp: Date.now()
    });
  }

  /**
   * Publish state directly from outside the actor system.
   * Use this to inject state from external sources (like VS Code postMessage).
   *
   * @param key - State key to publish
   * @param value - Value to publish
   * @param source - Optional source identifier (defaults to 'external')
   */
  publishDirect(key: string, value: unknown, source = 'external'): void {
    this.handleStateChange({
      source,
      state: { [key]: value },
      changedKeys: [key],
      publicationChain: [],
      timestamp: Date.now()
    });
  }

  /**
   * Update global state with new values
   * Returns array of keys that actually changed
   */
  private updateGlobalState(state: GlobalState): string[] {
    const changedKeys: string[] = [];

    for (const [key, value] of Object.entries(state)) {
      if (!deepEqual(this.globalState[key], value)) {
        this.globalState[key] = deepClone(value);
        changedKeys.push(key);
      }
    }

    return changedKeys;
  }

  /**
   * Broadcast state changes to subscribed actors
   *
   * Uses indexed subscriptions for O(1) exact key lookup.
   * Wildcard patterns are O(w) where w = number of wildcard patterns (typically small).
   * This replaces the previous O(n) scan of all actors.
   */
  private broadcast(source: string, changedKeys: string[], chain: string[]): void {
    const newChain = [...chain, source];

    // Collect subscribers: actorId → Set of relevant keys
    const subscriberKeys = new Map<string, Set<string>>();

    for (const key of changedKeys) {
      // O(1) exact subscription lookup
      const exactSubscribers = this.exactSubscriptions.get(key);
      if (exactSubscribers) {
        for (const actorId of exactSubscribers) {
          if (actorId === source) continue; // Skip source actor
          if (!subscriberKeys.has(actorId)) {
            subscriberKeys.set(actorId, new Set());
          }
          subscriberKeys.get(actorId)!.add(key);
        }
      }

      // O(w) wildcard pattern check - iterate wildcard patterns, not all actors
      for (const [pattern, subscribers] of this.wildcardSubscriptions) {
        if (wildcardMatch(key, pattern)) {
          for (const actorId of subscribers) {
            if (actorId === source) continue; // Skip source actor
            if (!subscriberKeys.has(actorId)) {
              subscriberKeys.set(actorId, new Set());
            }
            subscriberKeys.get(actorId)!.add(key);
          }
        }
      }
    }

    // Dispatch to each subscriber with their relevant keys
    for (const [actorId, keysSet] of subscriberKeys) {
      const actor = this.actors.get(actorId);
      if (!actor) continue; // Actor may have been unregistered

      const relevantKeys = Array.from(keysSet);
      this.logger.broadcastToActor(actorId, relevantKeys);
      this.dispatchToActor(actor, {
        source,
        state: this.getStateForKeys(relevantKeys),
        changedKeys: relevantKeys,
        publicationChain: newChain,
        timestamp: Date.now()
      });
    }
  }

  /**
   * Dispatch state change event to an actor's element
   */
  private dispatchToActor(actor: ActorRegistration, event: StateChangeEvent): void {
    const customEvent = new CustomEvent('state-changed', {
      detail: event,
      bubbles: false,
      cancelable: false
    });
    actor.element.dispatchEvent(customEvent);
  }

  /**
   * Get state for specific keys (deep cloned)
   */
  private getStateForKeys(keys: string[]): GlobalState {
    const state: GlobalState = {};
    for (const key of keys) {
      state[key] = deepClone(this.globalState[key]);
    }
    return state;
  }

  /**
   * Get number of registered actors
   */
  getActorCount(): number {
    return this.actors.size;
  }

  /**
   * Check if an actor is registered
   */
  hasActor(actorId: string): boolean {
    return this.actors.has(actorId);
  }

  /**
   * Get logger for configuration
   */
  getLogger(): EventStateLogger {
    return this.logger;
  }
}
