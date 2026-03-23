/**
 * DrawingServerShadowActor
 *
 * Shadow DOM actor for the drawing server popup in the header bar.
 * Shows start/stop controls and QR code + URL when the server is running.
 *
 * Publications:
 * - drawingServer.popup.visible: boolean - whether the popup is open
 *
 * Subscriptions:
 * - drawingServer.popup.open: boolean - request to open/close popup
 * - drawingServer.state: DrawingServerState - server state from extension
 */

import { PopupShadowActor, PopupConfig } from '../../state/PopupShadowActor';
import { EventStateManager } from '../../state/EventStateManager';
import type { VSCodeAPI } from '../../state/types';
import { drawingServerShadowStyles } from './shadowStyles';
import { createLogger } from '../../logging';

const log = createLogger('DrawingServerPopup');

// ============================================
// Types
// ============================================

export interface DrawingServerState {
  running: boolean;
  url?: string;
  qrMatrix?: boolean[][];
  isWSL?: boolean;
  portForwardCmd?: string;
}

// ============================================
// DrawingServerShadowActor
// ============================================

export class DrawingServerShadowActor extends PopupShadowActor {
  private _serverState: DrawingServerState = { running: false };
  private _starting = false;

  constructor(manager: EventStateManager, element: HTMLElement, vscode: VSCodeAPI) {
    const config: PopupConfig = {
      manager,
      element,
      vscode,
      header: 'Drawing Pad',
      position: 'bottom-left',
      width: '260px',
      maxHeight: '500px',
      publications: {},
      subscriptions: {
        'drawingServer.state': (value: unknown) => this.handleStateUpdate(value as DrawingServerState)
      },
      additionalStyles: drawingServerShadowStyles,
      openRequestKey: 'drawingServer.popup.open',
      visibleStateKey: 'drawingServer.popup.visible'
    };

    super(config);

    // Re-render now that instance properties are initialized
    this.updateBodyContent(this.renderPopupContent());
  }

  // ============================================
  // Abstract Method Implementations
  // ============================================

  protected renderPopupContent(): string {
    const state = this._serverState || { running: false };

    if (this._starting) {
      return `
        <div class="ds-description">Starting server...</div>
        <button class="ds-btn ds-btn-start" disabled>Starting...</button>
      `;
    }

    if (state.running) {
      return this.renderRunningState(state);
    }

    return this.renderStoppedState();
  }

  private renderStoppedState(): string {
    return `
      <div class="ds-description">
        Draw on your phone and send to chat.
      </div>
      <button class="ds-btn ds-btn-start" data-action="start">Start Server</button>
    `;
  }

  private renderRunningState(state: DrawingServerState): string {
    let html = '';

    // Status indicator
    html += `
      <div class="ds-status">
        <span class="ds-status-dot"></span>
        Server running${state.isWSL ? ' (WSL2)' : ''}
      </div>
    `;

    // QR code
    if (state.qrMatrix && state.qrMatrix.length > 0) {
      const size = state.qrMatrix.length;
      html += `<div class="ds-qr-container">`;
      html += `<div class="ds-qr" style="grid-template-columns: repeat(${size}, 4px);">`;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const dark = state.qrMatrix[y][x] ? ' dark' : '';
          html += `<div class="ds-qr-cell${dark}"></div>`;
        }
      }
      html += `</div></div>`;
    }

    // URL row with copy button
    if (state.url) {
      html += `
        <div class="ds-url-row">
          <span class="ds-url-text">${this.escapeHtml(state.url)}</span>
          <button class="ds-copy-btn" data-action="copy">Copy</button>
        </div>
      `;
    }

    // WSL2 port forward command
    if (state.isWSL && state.portForwardCmd) {
      html += `
        <div class="ds-wsl-section">
          <div class="ds-wsl-label">Run in Windows PowerShell (Admin):</div>
          <div class="ds-wsl-cmd-row">
            <code class="ds-wsl-cmd">${this.escapeHtml(state.portForwardCmd)}</code>
            <button class="ds-copy-btn" data-action="copy-cmd">Copy</button>
          </div>
        </div>
      `;
    }

    // Stop button
    html += `<button class="ds-btn ds-btn-stop" data-action="stop">Stop Server</button>`;

    return html;
  }

  protected setupPopupEvents(): void {
    // Start/Stop button clicks
    this.delegate('click', '[data-action="start"]', () => {
      log.debug('start server clicked');
      this._starting = true;
      this.updateBodyContent(this.renderPopupContent());
      this._vscode.postMessage({ type: 'startDrawingServer' });
    });

    this.delegate('click', '[data-action="stop"]', () => {
      log.debug('stop server clicked');
      this._vscode.postMessage({ type: 'stopDrawingServer' });
    });

    // Copy URL button
    this.delegate('click', '[data-action="copy"]', (_e, element) => {
      const url = this._serverState.url;
      if (!url) return;

      log.debug(`copy URL: ${url}`);
      this._vscode.postMessage({ type: 'copyToClipboard', text: url });

      // Visual feedback
      element.textContent = 'Copied!';
      element.classList.add('copied');
      setTimeout(() => {
        element.textContent = 'Copy';
        element.classList.remove('copied');
      }, 1500);
    });

    // Copy port forward command
    this.delegate('click', '[data-action="copy-cmd"]', (_e, element) => {
      const cmd = this._serverState.portForwardCmd;
      if (!cmd) return;

      log.debug('copy port forward command');
      this._vscode.postMessage({ type: 'copyToClipboard', text: cmd });

      element.textContent = 'Copied!';
      element.classList.add('copied');
      setTimeout(() => {
        element.textContent = 'Copy';
        element.classList.remove('copied');
      }, 1500);
    });
  }

  // ============================================
  // State Management
  // ============================================

  private handleStateUpdate(state: DrawingServerState): void {
    log.debug(`state update: running=${state.running}, url=${state.url}`);
    this._serverState = state;
    this._starting = false;
    this.updateBodyContent(this.renderPopupContent());

    // Publish button state for other actors
    this.publish({ 'drawingServer.running': state.running });

    // Update header button styling (button is a sibling in the light DOM parent)
    const btn = this.element.parentElement?.querySelector('#drawingServerBtn');
    if (btn) {
      btn.classList.toggle('server-running', state.running);
    }
  }

  // ============================================
  // Public API
  // ============================================

  /** Update the server state (called from external message handler) */
  updateState(state: DrawingServerState): void {
    this.handleStateUpdate(state);
  }

  get isServerRunning(): boolean {
    return this._serverState.running;
  }
}
