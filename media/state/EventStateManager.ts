/**
 * EventStateManager
 *
 * Central coordinator for global state in the actor system.
 * Manages actor registration, state updates, and broadcasts.
 */

import { deepEqual, deepClone, wildcardMatch } from '../utils';
import { EventStateLogger } from './EventStateLogger';
import type { ActorRegistration, StateChangeEvent, GlobalState } from './types';

export class EventStateManager {
  /** Global state store */
  private globalState: GlobalState = {};

  /** Registered actors */
  private actors: Map<string, ActorRegistration> = new Map();

  /** Maximum publication chain depth before warning/blocking */
  private maxChainDepth = 10;

  /** Logger instance */
  private logger: EventStateLogger;

  /** CSS injection tracking */
  private injectedStyles: Set<string> = new Set();
  private styleElement: HTMLStyleElement | null = null;

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

  /**
   * Register an actor with the manager
   */
  register(actor: ActorRegistration, initialState: GlobalState): void {
    this.actors.set(actor.actorId, actor);
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
   */
  private broadcast(source: string, changedKeys: string[], chain: string[]): void {
    const newChain = [...chain, source];

    for (const [actorId, actor] of this.actors) {
      // Skip the source actor
      if (actorId === source) continue;

      // Find keys this actor cares about (supports wildcards)
      const relevantKeys = changedKeys.filter(key =>
        actor.subscriptionKeys.some(pattern => wildcardMatch(key, pattern))
      );

      if (relevantKeys.length > 0) {
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
