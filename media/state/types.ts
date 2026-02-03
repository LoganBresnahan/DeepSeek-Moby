/**
 * Type definitions for the Event State Management system
 */

import type { EventStateManager } from './EventStateManager';

/**
 * Global state object - key-value pairs
 */
export type GlobalState = Record<string, unknown>;

/**
 * Publication getter function - returns the current value for a key
 */
export type PublicationGetter = () => unknown;

/**
 * Subscription handler function - called when a subscribed key changes
 * @param value - The new value
 * @param key - The key that changed (useful for wildcard subscriptions)
 */
export type SubscriptionHandler = (value: unknown, key: string) => void;

/**
 * Map of publication keys to their getter functions
 */
export type PublicationMap = Record<string, PublicationGetter>;

/**
 * Map of subscription keys/patterns to their handler functions
 */
export type SubscriptionMap = Record<string, SubscriptionHandler>;

/**
 * Actor registration info stored by the manager
 */
export interface ActorRegistration {
  /** Unique identifier for this actor */
  actorId: string;

  /** DOM element this actor is bound to */
  element: HTMLElement;

  /** Keys this actor publishes (immutable) */
  publicationKeys: readonly string[];

  /** Keys/patterns this actor subscribes to (immutable) */
  subscriptionKeys: readonly string[];
}

/**
 * State change event dispatched to actors
 */
export interface StateChangeEvent {
  /** Actor ID that originated this change */
  source: string;

  /** Changed state key-value pairs */
  state: GlobalState;

  /** Keys that changed */
  changedKeys: string[];

  /** Chain of actor IDs that led to this change (for loop prevention) */
  publicationChain: string[];

  /** Timestamp of the change */
  timestamp: number;
}

/**
 * Configuration for creating an actor
 */
export interface ActorConfig {
  /** DOM element this actor is bound to */
  element: HTMLElement;

  /** Reference to the EventStateManager */
  manager: EventStateManager;

  /** Map of publication keys to getter functions */
  publications: PublicationMap;

  /** Map of subscription keys/patterns to handler functions */
  subscriptions: SubscriptionMap;

  /** Enable MutationObserver for automatic DOM change detection (default: true) */
  enableDOMChangeDetection?: boolean;
}

/**
 * Logger configuration
 */
export interface LoggerConfig {
  /** Log level (0=DEBUG, 1=INFO, 2=WARN, 3=ERROR, 4=SILENT) */
  logLevel: LogLevel;

  /** Show timestamps in logs */
  showTimestamps: boolean;

  /** Use collapsible console groups */
  useGroups: boolean;

  /** Flat mode - no groups, pure chronological */
  flatMode: boolean;

  /** Log global state after changes */
  logGlobalState: boolean;
}

/**
 * Log levels
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4
}

/**
 * VS Code API interface (subset we use)
 */
export interface VSCodeAPI {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

/**
 * Declare the global VS Code API acquisition function
 */
declare global {
  function acquireVsCodeApi(): VSCodeAPI;

  interface Window {
    /** Test manager exposed for visual regression tests */
    testManager?: EventStateManager;
  }
}

// ============================================
// Dropdown Event Types (for DropdownFocusActor)
// ============================================

/**
 * Types of dropdowns that can emit hover/click events
 */
export type DropdownType = 'thinking' | 'shell' | 'code';

/**
 * Event published when a dropdown header is hovered
 */
export interface DropdownHoverEvent {
  /** Type of dropdown */
  type: DropdownType;
  /** Unique identifier for this dropdown instance */
  dropdownId: string;
  /** Container/segment ID from the originating actor */
  containerId: string;
  /** ID of the shadow host element (use document.getElementById to resolve) */
  hostElementId: string;
  /** Current content of the dropdown body */
  bodyContent: string;
  /** Label text shown in the header */
  headerLabel: string;
  /** Mouse event that triggered the hover */
  mouseEvent: {
    clientX: number;
    clientY: number;
  };
  /** Whether the dropdown is currently expanded */
  isExpanded: boolean;
}

/**
 * Event published when a dropdown header is clicked
 */
export interface DropdownClickEvent {
  /** Type of dropdown */
  type: DropdownType;
  /** Unique identifier for this dropdown instance */
  dropdownId: string;
  /** Container/segment ID from the originating actor */
  containerId: string;
  /** ID of the shadow host element (use document.getElementById to resolve) */
  hostElementId: string;
  /** Current content of the dropdown body */
  bodyContent: string;
  /** Label text shown in the header */
  headerLabel: string;
  /** Current scroll position of the chat container */
  scrollTop: number;
}

/**
 * Event published when dropdown content updates (during streaming)
 */
export interface DropdownContentUpdate {
  /** Type of dropdown */
  type: DropdownType;
  /** Unique identifier for this dropdown instance */
  dropdownId: string;
  /** Container/segment ID from the originating actor */
  containerId: string;
  /** Updated body content */
  bodyContent: string;
}
