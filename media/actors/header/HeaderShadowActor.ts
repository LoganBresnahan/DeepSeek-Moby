/**
 * HeaderShadowActor (Minimal Version)
 *
 * Lightweight actor that updates header display elements.
 * Subscribes to session state and updates the UI accordingly.
 *
 * This is a refactored minimal version - the old version duplicated
 * functionality that now exists in separate actors (ModelSelectorShadowActor,
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

export class HeaderShadowActor extends EventStateActor {
  // Internal state
  private _model = 'deepseek-chat';
  private _title = 'New Chat';

  // DOM elements (found in light DOM, not owned)
  private _modelNameEl: HTMLElement | null = null;
  private _titleEl: HTMLElement | null = null;

  constructor(manager: EventStateManager, element: HTMLElement) {
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

    // Find existing DOM elements to update
    this.findElements();
  }

  // ============================================
  // Element Discovery
  // ============================================

  private findElements(): void {
    // Model name is in the header button
    this._modelNameEl = document.getElementById('currentModelName');

    // Title element - currently doesn't exist in the UI but could be added
    // If we want to add session title display, add an element with id="sessionTitle"
    this._titleEl = document.getElementById('sessionTitle');

    if (!this._modelNameEl) {
      console.warn('[HeaderShadowActor] #currentModelName element not found');
    }
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
   * Force refresh element references (useful if DOM changes)
   */
  refreshElements(): void {
    this.findElements();
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
