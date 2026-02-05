/**
 * HeaderActor
 *
 * Lightweight actor that updates header display elements in light DOM.
 * Subscribes to session state and updates existing UI elements accordingly.
 *
 * NOTE: This actor does NOT use Shadow DOM. It receives references to
 * pre-existing elements and updates them when state changes.
 *
 * This is a minimal version - the old HeaderShadowActor was refactored when
 * its functionality moved to separate actors (ModelSelectorShadowActor,
 * HistoryShadowActor, etc).
 *
 * Publications:
 * - (none)
 *
 * Subscriptions:
 * - session.model: string - updates model name display
 * - session.title: string - updates title display (if element exists)
 */

import { EventStateActor } from '../../state/EventStateActor';
import { EventStateManager } from '../../state/EventStateManager';
import type { ActorConfig } from '../../state/types';

export interface HeaderState {
  model: string;
  title: string;
}

export interface HeaderElements {
  /** Element to display model name (e.g., "Chat (V3)") */
  modelNameEl: HTMLElement;
  /** Optional element to display session title */
  titleEl?: HTMLElement;
}

export class HeaderActor extends EventStateActor {
  // Internal state
  private _model = 'deepseek-chat';
  private _title = 'New Chat';

  // DOM elements (passed in, not owned)
  private _modelNameEl: HTMLElement | null = null;
  private _titleEl: HTMLElement | null = null;

  constructor(manager: EventStateManager, element: HTMLElement, elements: HeaderElements) {
    const config: ActorConfig = {
      manager,
      element,
      publications: {},
      subscriptions: {
        'session.model': (value: unknown) => this.handleModelChange(value as string),
        'session.title': (value: unknown) => this.handleTitleChange(value as string)
      },
      enableDOMChangeDetection: false
    };

    super(config);

    // Store element references (passed in from caller)
    this._modelNameEl = elements.modelNameEl;
    this._titleEl = elements.titleEl ?? null;
  }

  // ============================================
  // Subscription Handlers
  // ============================================

  private handleModelChange(model: string): void {
    if (!model) return;

    this._model = model;
    this.updateModelDisplay();
  }

  private handleTitleChange(title: string): void {
    this._title = title || 'New Chat';
    this.updateTitleDisplay();
  }

  // ============================================
  // UI Updates
  // ============================================

  private updateModelDisplay(): void {
    if (!this._modelNameEl) return;

    // Convert model ID to display name
    const displayName = this.getModelDisplayName(this._model);
    this._modelNameEl.textContent = displayName;
  }

  private updateTitleDisplay(): void {
    if (!this._titleEl) return;
    this._titleEl.textContent = this._title;
  }

  private getModelDisplayName(modelId: string): string {
    switch (modelId) {
      case 'deepseek-chat':
        return 'Chat (V3)';
      case 'deepseek-reasoner':
        return 'Reasoner (R1)';
      default:
        // Handle unknown models gracefully
        return modelId.replace('deepseek-', '').replace(/-/g, ' ');
    }
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Get current state
   */
  getState(): HeaderState {
    return {
      model: this._model,
      title: this._title
    };
  }

  /**
   * Force refresh displays (useful after element content is externally modified)
   */
  refreshDisplays(): void {
    this.updateModelDisplay();
    this.updateTitleDisplay();
  }

  // ============================================
  // Lifecycle
  // ============================================

  destroy(): void {
    this._modelNameEl = null;
    this._titleEl = null;
    super.destroy();
  }
}
