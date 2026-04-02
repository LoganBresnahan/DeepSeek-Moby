/**
 * WebSearchPopupShadowActor
 *
 * Shadow DOM popup for web search settings.
 * Migrated from inline DOM in ToolbarShadowActor for proper isolation.
 *
 * Publications:
 * - webSearch.popup.visible: boolean
 * - toolbar.webSearchEnabled: boolean
 * - toolbar.webSearchMode: WebSearchMode
 *
 * Subscriptions:
 * - webSearch.popup.open: boolean - request to open/close
 * - webSearch.settings: WebSearchSettings - settings from extension
 * - webSearch.mode: WebSearchMode - mode from extension
 * - webSearch.enabled: boolean - enabled state from extension
 */

import { PopupShadowActor, PopupConfig } from '../../state/PopupShadowActor';
import { EventStateManager } from '../../state/EventStateManager';
import type { VSCodeAPI } from '../../state/types';
import { webSearchShadowStyles } from './shadowStyles';
import { createLogger } from '../../logging';

const log = createLogger('WebSearchPopup');

// ============================================
// Types
// ============================================

export type WebSearchMode = 'off' | 'manual' | 'auto';

export interface WebSearchSettings {
  creditsPerPrompt: number;
  maxResultsPerSearch: number;
  searchDepth: 'basic' | 'advanced';
}

// ============================================
// WebSearchPopupShadowActor
// ============================================

export class WebSearchPopupShadowActor extends PopupShadowActor {
  private _mode: WebSearchMode = 'auto';
  private _enabled = false;
  private _settings: WebSearchSettings = {
    creditsPerPrompt: 1,
    maxResultsPerSearch: 5,
    searchDepth: 'basic'
  };

  constructor(manager: EventStateManager, element: HTMLElement, vscode: VSCodeAPI) {
    const config: PopupConfig = {
      manager,
      element,
      vscode,
      header: 'Web Search',
      position: 'top-left',
      width: '280px',
      publications: {
        'toolbar.webSearchEnabled': () => this._enabled,
        'toolbar.webSearchMode': () => this._mode,
      },
      subscriptions: {
        'webSearch.settings': (value: unknown) => this.handleSettingsUpdate(value as WebSearchSettings),
        'webSearch.mode': (value: unknown) => this.handleModeUpdate(value as WebSearchMode),
        'webSearch.enabled': (value: unknown) => this.handleEnabledUpdate(value as boolean),
      },
      additionalStyles: webSearchShadowStyles,
      openRequestKey: 'webSearch.popup.open',
      visibleStateKey: 'webSearch.popup.visible'
    };

    super(config);
    this.updateBodyContent(this.renderPopupContent());
  }

  // ============================================
  // Popup Lifecycle
  // ============================================

  protected onOpen(): void {
    // Request fresh state from extension (same pattern as Files and SystemPrompt modals)
    this._vscode.postMessage({ type: 'getWebSearchSettings' });
  }

  // ============================================
  // State handlers
  // ============================================

  private handleSettingsUpdate(settings: WebSearchSettings): void {
    this._settings = { ...settings };
    if (this.isVisible()) this.updateBodyContent(this.renderPopupContent());
  }

  private handleModeUpdate(mode: WebSearchMode): void {
    this._mode = mode;
    if (this.isVisible()) this.updateBodyContent(this.renderPopupContent());
  }

  private handleEnabledUpdate(enabled: boolean): void {
    this._enabled = enabled;
    if (this.isVisible()) this.updateBodyContent(this.renderPopupContent());
  }


  // ============================================
  // Rendering
  // ============================================

  protected renderPopupContent(): string {
    const mode = this._mode || 'auto';
    const settings = this._settings || { creditsPerPrompt: 1, maxResultsPerSearch: 5, searchDepth: 'basic' };
    const isAdvanced = settings.searchDepth === 'advanced';
    const creditsMin = isAdvanced ? 2 : 1;
    const creditsMax = isAdvanced ? 10 : 5;
    const creditsStep = isAdvanced ? 2 : 1;
    const credits = settings.creditsPerPrompt;
    const costPerCall = isAdvanced ? 2 : 1;
    const requestCount = Math.floor(credits / costPerCall);
    const isOff = mode === 'off';

    return `
      <div class="ws-mode-options">
        <button class="ws-mode-btn${mode === 'off' ? ' active' : ''}" data-mode="off">Off</button>
        <button class="ws-mode-btn${mode === 'manual' ? ' active' : ''}" data-mode="manual">Forced</button>
        <button class="ws-mode-btn${mode === 'auto' ? ' active' : ''}" data-mode="auto">Auto</button>
      </div>
      <div class="ws-settings${isOff ? ' disabled-section' : ''}">
        <div class="ws-option">
          <label>Credits per prompt: <span data-id="creditsValue">${credits}</span> <span data-id="creditsInfo">(${requestCount} request${requestCount !== 1 ? 's' : ''})</span></label>
          <input type="range" data-id="creditsSlider" min="${creditsMin}" max="${creditsMax}" step="${creditsStep}" value="${credits}"${isOff ? ' disabled' : ''}>
        </div>
        <div class="ws-option">
          <label>Results per request: <span data-id="maxResultsValue">${settings.maxResultsPerSearch}</span></label>
          <input type="range" data-id="maxResultsSlider" min="1" max="20" step="1" value="${settings.maxResultsPerSearch}"${isOff ? ' disabled' : ''}>
        </div>
        <div class="ws-option">
          <label>Search depth:</label>
          <div class="ws-depth-options">
            <button class="ws-depth-btn${!isAdvanced ? ' active' : ''}" data-depth="basic"${isOff ? ' disabled' : ''}>
              <span class="ws-depth-name">Basic</span>
              <span class="ws-depth-credits">1 credit</span>
            </button>
            <button class="ws-depth-btn${isAdvanced ? ' active' : ''}" data-depth="advanced"${isOff ? ' disabled' : ''}>
              <span class="ws-depth-name">Advanced</span>
              <span class="ws-depth-credits">2 credits</span>
            </button>
          </div>
        </div>
        <button class="ws-clear-cache-btn"${isOff ? ' disabled' : ''}>Clear Cache</button>
      </div>
    `;
  }

  // ============================================
  // Event handlers
  // ============================================

  protected setupPopupEvents(): void {
    // Mode buttons
    this.delegate('click', '.ws-mode-btn', (_e, element) => {
      const newMode = (element as HTMLElement).dataset.mode as WebSearchMode;
      log.debug(`mode change: ${newMode}`);

      this._mode = newMode;
      this._vscode.postMessage({ type: 'setWebSearchMode', mode: newMode });
      this.publish({ 'toolbar.webSearchMode': newMode });

      // Forced (manual) mode: auto-enable search
      // Off or Auto mode: auto-disable manual toggle
      if (newMode === 'manual' && !this._enabled) {
        this._enabled = true;
        this._vscode.postMessage({ type: 'toggleWebSearch', enabled: true });
        this._vscode.postMessage({ type: 'updateWebSearchSettings', settings: this._settings });
        this.publish({ 'toolbar.webSearchEnabled': true });
      } else if (newMode !== 'manual' && this._enabled) {
        this._enabled = false;
        this._vscode.postMessage({ type: 'toggleWebSearch', enabled: false });
        this.publish({ 'toolbar.webSearchEnabled': false });
      }

      this.updateBodyContent(this.renderPopupContent());
    });

    // Credits slider
    this.delegateInput('[data-id="creditsSlider"]', (value) => {
      const numValue = parseInt(value, 10);
      this._settings.creditsPerPrompt = numValue;
      this._vscode.postMessage({ type: 'setCreditsPerPrompt', value: numValue });

      const el = this.query('[data-id="creditsValue"]');
      if (el) el.textContent = value;
      const cost = this._settings.searchDepth === 'advanced' ? 2 : 1;
      const requests = Math.floor(numValue / cost);
      const info = this.query('[data-id="creditsInfo"]');
      if (info) info.textContent = `(${requests} request${requests !== 1 ? 's' : ''})`;
    });

    // Results slider
    this.delegateInput('[data-id="maxResultsSlider"]', (value) => {
      const numValue = parseInt(value, 10);
      this._settings.maxResultsPerSearch = numValue;
      this._vscode.postMessage({ type: 'setMaxResultsPerSearch', value: numValue });

      const el = this.query('[data-id="maxResultsValue"]');
      if (el) el.textContent = value;
    });

    // Depth buttons
    this.delegate('click', '.ws-depth-btn', (_e, element) => {
      const newDepth = (element as HTMLElement).dataset.depth as 'basic' | 'advanced';
      this._settings.searchDepth = newDepth;

      // Re-clamp credits
      const isAdv = newDepth === 'advanced';
      const newMin = isAdv ? 2 : 1;
      const newMax = isAdv ? 10 : 5;
      let clamped = this._settings.creditsPerPrompt;
      if (clamped < newMin) clamped = newMin;
      if (clamped > newMax) clamped = newMax;
      if (isAdv && clamped % 2 !== 0) clamped = Math.min(clamped + 1, newMax);
      this._settings.creditsPerPrompt = clamped;

      this._vscode.postMessage({ type: 'setSearchDepth', searchDepth: newDepth });
      this._vscode.postMessage({ type: 'setCreditsPerPrompt', value: clamped });

      this.updateBodyContent(this.renderPopupContent());
    });

    // Clear cache
    this.delegate('click', '.ws-clear-cache-btn', () => {
      this._vscode.postMessage({ type: 'clearSearchCache' });
      this.close();
    });
  }

  // ============================================
  // Helpers
  // ============================================

  /** Delegate input events on range sliders */
  private delegateInput(selector: string, handler: (value: string) => void): void {
    this.shadowRoot?.addEventListener('input', (e) => {
      const target = (e.target as HTMLElement)?.closest(selector);
      if (target) handler((target as HTMLInputElement).value);
    });
  }
}
