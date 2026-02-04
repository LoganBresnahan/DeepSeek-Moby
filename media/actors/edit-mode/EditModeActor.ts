/**
 * EditModeActor
 *
 * Manages edit mode state (manual/ask/auto) for the application.
 * This is the single source of truth for edit mode.
 *
 * Publications:
 * - edit.mode: EditMode - current edit mode ('manual' | 'ask' | 'auto')
 *
 * Subscriptions:
 * - edit.mode.set: EditMode - request to change edit mode (from extension messages)
 */

import { EventStateActor } from '../../state/EventStateActor';
import { EventStateManager } from '../../state/EventStateManager';
import type { ActorConfig } from '../../state/types';

export type EditMode = 'manual' | 'ask' | 'auto';

const VALID_MODES: EditMode[] = ['manual', 'ask', 'auto'];

export class EditModeActor extends EventStateActor {
  private _mode: EditMode = 'manual';

  constructor(manager: EventStateManager, element: HTMLElement) {
    const config: ActorConfig = {
      manager,
      element,
      publications: {
        'edit.mode': () => this._mode
      },
      subscriptions: {
        'edit.mode.set': (value: unknown) => this.handleModeSet(value as EditMode)
      },
      enableDOMChangeDetection: false
    };

    super(config);

    // Publish initial state
    this.publish({ 'edit.mode': this._mode });
  }

  // ============================================
  // Subscription Handlers
  // ============================================

  private handleModeSet(mode: EditMode): void {
    if (this.isValidMode(mode)) {
      this.setMode(mode);
    }
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Set the edit mode
   */
  setMode(mode: EditMode): void {
    if (!this.isValidMode(mode)) {
      console.warn(`[EditModeActor] Invalid mode: ${mode}`);
      return;
    }

    if (mode === this._mode) return;

    this._mode = mode;
    this.publish({ 'edit.mode': this._mode });
  }

  /**
   * Get the current edit mode
   */
  getMode(): EditMode {
    return this._mode;
  }

  /**
   * Check if a mode is valid
   */
  isValidMode(mode: unknown): mode is EditMode {
    return typeof mode === 'string' && VALID_MODES.includes(mode as EditMode);
  }

  /**
   * Get all valid modes
   */
  getValidModes(): readonly EditMode[] {
    return VALID_MODES;
  }
}
