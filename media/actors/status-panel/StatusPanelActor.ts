/**
 * StatusPanelActor
 *
 * Manages the status panel (Moby whale, messages, warnings, errors).
 * Wraps existing DOM elements from chatProvider.ts HTML.
 *
 * Features:
 * - Moby water spurt animation with colors (blue/yellow/red)
 * - Left side: informational messages (auto-clear after 5s)
 * - Right side: warnings/errors (auto-clear after 8-10s)
 * - Resizable separator between left/right
 * - Logs button
 *
 * Publications:
 * - status.hasMessage: boolean
 * - status.hasWarning: boolean
 * - status.hasError: boolean
 *
 * Subscriptions:
 * - (none - receives direct method calls)
 */

import { EventStateActor } from '../../state/EventStateActor';
import { EventStateManager } from '../../state/EventStateManager';
import type { ActorConfig } from '../../state/types';

export interface StatusPanelState {
  message: string;
  warning: string;
  error: string;
}

export type LogsHandler = () => void;

interface VSCodeAPI {
  postMessage(message: unknown): void;
}

export class StatusPanelActor extends EventStateActor {
  // DOM elements
  private _moby: HTMLElement | null = null;
  private _messagesEl: HTMLElement | null = null;
  private _warningsEl: HTMLElement | null = null;
  private _leftPanel: HTMLElement | null = null;
  private _rightPanel: HTMLElement | null = null;
  private _separator: HTMLElement | null = null;
  private _logsBtn: HTMLButtonElement | null = null;

  // State
  private _message = '';
  private _warning = '';
  private _error = '';

  // Timeouts for auto-clear
  private _messageTimeout: ReturnType<typeof setTimeout> | null = null;
  private _warningTimeout: ReturnType<typeof setTimeout> | null = null;

  // Resize state
  private _isResizing = false;
  private _startX = 0;
  private _startLeftWidth = 0;
  private _startRightWidth = 0;

  // Handlers
  private _onLogs: LogsHandler | null = null;
  private _vscode: VSCodeAPI | null = null;

  // Bound handlers for cleanup
  private _boundMouseMove: ((e: MouseEvent) => void) | null = null;
  private _boundMouseUp: (() => void) | null = null;

  constructor(manager: EventStateManager, element: HTMLElement, vscode?: VSCodeAPI) {
    const config: ActorConfig = {
      manager,
      element,
      publications: {
        'status.hasMessage': () => !!this._message,
        'status.hasWarning': () => !!this._warning,
        'status.hasError': () => !!this._error
      },
      subscriptions: {},
      enableDOMChangeDetection: false
    };

    super(config);
    this._vscode = vscode || null;
    this.bindToExistingElements();
    this.setupEventHandlers();
  }

  /**
   * Find and bind to existing DOM elements
   */
  private bindToExistingElements(): void {
    const doc = document;

    this._moby = doc.getElementById('statusPanelMoby');
    this._messagesEl = doc.getElementById('statusPanelMessages');
    this._warningsEl = doc.getElementById('statusPanelWarnings');
    this._separator = doc.getElementById('statusPanelSeparator');
    this._logsBtn = doc.getElementById('statusPanelLogsBtn') as HTMLButtonElement;

    // Find panel containers by class (they don't have IDs)
    const statusPanel = doc.querySelector('.status-panel');
    if (statusPanel) {
      this._leftPanel = statusPanel.querySelector('.status-panel-left');
      this._rightPanel = statusPanel.querySelector('.status-panel-right');
    }

    console.log('[StatusPanelActor] Bound to elements:', {
      moby: !!this._moby,
      messages: !!this._messagesEl,
      warnings: !!this._warningsEl,
      separator: !!this._separator,
      logsBtn: !!this._logsBtn
    });
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    // Logs button
    if (this._logsBtn) {
      this._logsBtn.addEventListener('click', () => {
        this._onLogs?.();
        this._vscode?.postMessage({ type: 'showLogs' });
      });
    }

    // Resizable separator
    if (this._separator && this._leftPanel && this._rightPanel) {
      this._separator.addEventListener('mousedown', this.handleResizeStart.bind(this));

      this._boundMouseMove = this.handleResizeMove.bind(this);
      this._boundMouseUp = this.handleResizeEnd.bind(this);

      document.addEventListener('mousemove', this._boundMouseMove);
      document.addEventListener('mouseup', this._boundMouseUp);
    }
  }

  // ============================================
  // Resize Handlers
  // ============================================

  private handleResizeStart(e: MouseEvent): void {
    if (!this._leftPanel || !this._rightPanel) return;

    this._isResizing = true;
    this._startX = e.clientX;

    const leftRect = this._leftPanel.getBoundingClientRect();
    const rightRect = this._rightPanel.getBoundingClientRect();
    this._startLeftWidth = leftRect.width;
    this._startRightWidth = rightRect.width;

    e.preventDefault();
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  }

  private handleResizeMove(e: MouseEvent): void {
    if (!this._isResizing || !this._leftPanel || !this._rightPanel) return;

    const deltaX = e.clientX - this._startX;
    const totalFlexWidth = this._startLeftWidth + this._startRightWidth;

    let newLeftWidth = this._startLeftWidth + deltaX;
    let newRightWidth = this._startRightWidth - deltaX;

    // Constrain to 20%-80%
    const minWidth = totalFlexWidth * 0.2;
    const maxWidth = totalFlexWidth * 0.8;

    if (newLeftWidth < minWidth) {
      newLeftWidth = minWidth;
      newRightWidth = totalFlexWidth - minWidth;
    } else if (newLeftWidth > maxWidth) {
      newLeftWidth = maxWidth;
      newRightWidth = totalFlexWidth - maxWidth;
    }

    newRightWidth = Math.max(minWidth, Math.min(maxWidth, newRightWidth));
    newLeftWidth = totalFlexWidth - newRightWidth;

    this._leftPanel.style.flex = `${newLeftWidth} 1 0`;
    this._rightPanel.style.flex = `${newRightWidth} 1 0`;
  }

  private handleResizeEnd(): void {
    if (this._isResizing) {
      this._isResizing = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }
  }

  // ============================================
  // Moby Animation
  // ============================================

  /**
   * Trigger Moby water spurt animation
   */
  private triggerMobySpurt(color: 'blue' | 'yellow' | 'red'): void {
    if (!this._moby) return;

    // Remove existing color classes
    this._moby.classList.remove('spurt-blue', 'spurt-yellow', 'spurt-red', 'spurting');

    // Add color class
    this._moby.classList.add(`spurt-${color}`);

    // Force reflow
    void this._moby.offsetWidth;

    // Trigger animation
    this._moby.classList.add('spurting');

    // Remove after animation
    setTimeout(() => {
      this._moby?.classList.remove('spurting');
    }, 700);
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Show an informational message (blue spurt, left side)
   */
  showMessage(message: string): void {
    if (!this._messagesEl) return;

    // Clear existing timeout
    if (this._messageTimeout) {
      clearTimeout(this._messageTimeout);
      this._messageTimeout = null;
    }

    this._message = message;
    this._messagesEl.textContent = message;
    this._messagesEl.title = message;

    this.triggerMobySpurt('blue');

    this.publish({ 'status.hasMessage': true });

    // Auto-clear after 5 seconds
    this._messageTimeout = setTimeout(() => {
      this.clearMessage();
    }, 5000);
  }

  /**
   * Show a warning message (yellow spurt, right side)
   */
  showWarning(message: string): void {
    if (!this._warningsEl || !this._rightPanel) return;

    // Clear existing timeout
    if (this._warningTimeout) {
      clearTimeout(this._warningTimeout);
      this._warningTimeout = null;
    }

    this._warning = message;
    this._error = '';

    this._warningsEl.textContent = message;
    this._warningsEl.title = message;
    this._warningsEl.classList.remove('error');
    this._warningsEl.classList.add('warning');

    this._rightPanel.classList.remove('error-bg');
    this._rightPanel.classList.add('warning-bg');

    this.triggerMobySpurt('yellow');

    this.publish({
      'status.hasWarning': true,
      'status.hasError': false
    });

    // Auto-clear after 8 seconds
    this._warningTimeout = setTimeout(() => {
      this.clearWarning();
    }, 8000);
  }

  /**
   * Show an error message (red spurt, right side)
   */
  showError(message: string): void {
    if (!this._warningsEl || !this._rightPanel) return;

    // Clear existing timeout
    if (this._warningTimeout) {
      clearTimeout(this._warningTimeout);
      this._warningTimeout = null;
    }

    this._error = message;
    this._warning = '';

    this._warningsEl.textContent = message;
    this._warningsEl.title = message;
    this._warningsEl.classList.remove('warning');
    this._warningsEl.classList.add('error');

    this._rightPanel.classList.remove('warning-bg');
    this._rightPanel.classList.add('error-bg');

    this.triggerMobySpurt('red');

    this.publish({
      'status.hasError': true,
      'status.hasWarning': false
    });

    // Auto-clear after 10 seconds
    this._warningTimeout = setTimeout(() => {
      this.clearError();
    }, 10000);
  }

  /**
   * Clear the info message
   */
  clearMessage(): void {
    if (this._messageTimeout) {
      clearTimeout(this._messageTimeout);
      this._messageTimeout = null;
    }

    this._message = '';
    if (this._messagesEl) {
      this._messagesEl.textContent = '';
      this._messagesEl.title = '';
    }

    this.publish({ 'status.hasMessage': false });
  }

  /**
   * Clear warning/error
   */
  clearWarning(): void {
    if (this._warningTimeout) {
      clearTimeout(this._warningTimeout);
      this._warningTimeout = null;
    }

    this._warning = '';
    this._error = '';

    if (this._warningsEl) {
      this._warningsEl.textContent = '';
      this._warningsEl.title = '';
      this._warningsEl.classList.remove('warning', 'error');
    }

    if (this._rightPanel) {
      this._rightPanel.classList.remove('warning-bg', 'error-bg');
    }

    this.publish({
      'status.hasWarning': false,
      'status.hasError': false
    });
  }

  /**
   * Alias for clearWarning (errors use same slot)
   */
  clearError(): void {
    this.clearWarning();
  }

  /**
   * Clear all status messages
   */
  clearAll(): void {
    this.clearMessage();
    this.clearWarning();
  }

  /**
   * Set logs handler
   */
  onLogs(handler: LogsHandler): void {
    this._onLogs = handler;
  }

  /**
   * Set VS Code API
   */
  setVSCodeAPI(vscode: VSCodeAPI): void {
    this._vscode = vscode;
  }

  /**
   * Get current state
   */
  getState(): StatusPanelState {
    return {
      message: this._message,
      warning: this._warning,
      error: this._error
    };
  }

  // ============================================
  // Lifecycle
  // ============================================

  destroy(): void {
    // Clear timeouts
    if (this._messageTimeout) clearTimeout(this._messageTimeout);
    if (this._warningTimeout) clearTimeout(this._warningTimeout);

    // Remove document listeners
    if (this._boundMouseMove) {
      document.removeEventListener('mousemove', this._boundMouseMove);
    }
    if (this._boundMouseUp) {
      document.removeEventListener('mouseup', this._boundMouseUp);
    }

    this._moby = null;
    this._messagesEl = null;
    this._warningsEl = null;
    this._leftPanel = null;
    this._rightPanel = null;
    this._separator = null;
    this._logsBtn = null;
    this._onLogs = null;
    this._vscode = null;

    super.destroy();
  }
}
