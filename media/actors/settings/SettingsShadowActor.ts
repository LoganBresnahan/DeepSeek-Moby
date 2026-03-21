/**
 * SettingsShadowActor
 *
 * Shadow DOM actor for the settings dropdown.
 * Contains all configuration options: logging, system prompt,
 * web search, history, and debug tools.
 *
 * Publications:
 * - settings.popup.visible: boolean - whether the popup is open
 *
 * Subscriptions:
 * - settings.popup.open: boolean - request to open/close popup
 * - settings.values: SettingsValues - current settings from extension
 * - settings.defaultPrompt: { model: string, prompt: string } - default prompt preview
 */

import { PopupShadowActor, PopupConfig } from '../../state/PopupShadowActor';
import { EventStateManager } from '../../state/EventStateManager';
import type { VSCodeAPI } from '../../state/types';
import { settingsShadowStyles } from './shadowStyles';

// ============================================
// Types
// ============================================

export interface SettingsValues {
  logLevel: string;
  webviewLogLevel: string;
  tracingEnabled: boolean;
  logColors: boolean;
  allowAllCommands: boolean;
  systemPrompt: string;
  searchDepth: string;
  creditsPerPrompt: number;
  maxResultsPerSearch: number;
  cacheDuration: number;
  autoSaveHistory: boolean;
}

export interface DefaultPrompt {
  model: string;
  prompt: string;
}

// ============================================
// SettingsShadowActor
// ============================================

export class SettingsShadowActor extends PopupShadowActor {
  // Settings state
  private _logLevel = 'WARN';
  private _webviewLogLevel = 'WARN';
  private _tracingEnabled = true;
  private _logColors = true;
  private _allowAllCommands = false;
  private _systemPrompt = '';
  private _searchDepth = 'basic';
  private _creditsPerPrompt = 1;
  private _maxResultsPerSearch = 5;
  private _cacheDuration = 15;
  private _autoSaveHistory = true;

  // Preview state
  private _defaultPromptVisible = false;
  private _defaultPromptModel = '';
  private _defaultPromptContent = '';

  constructor(manager: EventStateManager, element: HTMLElement, vscode: VSCodeAPI) {
    const config: PopupConfig = {
      manager,
      element,
      vscode,
      header: 'Settings',
      position: 'bottom-right',
      width: '350px',
      maxHeight: '500px',
      publications: {},
      subscriptions: {
        'settings.values': (value: unknown) => this.handleSettingsUpdate(value as SettingsValues),
        'settings.defaultPrompt': (value: unknown) => this.handleDefaultPrompt(value as DefaultPrompt)
      },
      additionalStyles: settingsShadowStyles,
      openRequestKey: 'settings.popup.open',
      visibleStateKey: 'settings.popup.visible'
    };

    super(config);
  }

  // ============================================
  // Abstract Method Implementations
  // ============================================

  protected renderPopupContent(): string {
    return `
      <!-- Debug Section -->
      <div class="settings-section">
        <div class="settings-section-title">Debug</div>
        <div class="settings-btn-row">
          <button class="settings-action-btn" data-action="testStatus">Test Info</button>
          <button class="settings-action-btn" data-action="testWarning">Test Warning</button>
          <button class="settings-action-btn" data-action="testError">Test Error</button>
        </div>
      </div>

      <div class="settings-divider"></div>

      <!-- Reset Section -->
      <div class="settings-section">
        <button class="settings-action-btn settings-danger-btn" data-action="resetDefaults">Reset All to Defaults</button>
      </div>
    `;
  }

  private renderDefaultPromptPreview(): string {
    return `
      <div class="settings-preview" data-preview>
        <div class="settings-preview-header">
          <span>Default prompt for <strong>${this.escapeHtml(this._defaultPromptModel)}</strong>:</span>
          <button class="settings-close-btn" data-action="closePreview">&times;</button>
        </div>
        <pre class="settings-preview-content">${this.escapeHtml(this._defaultPromptContent)}</pre>
      </div>
    `;
  }

  protected setupPopupEvents(): void {
    // Select changes (via delegation)
    this.delegate('change', '.settings-select', (e) => {
      const select = e.target as HTMLSelectElement;
      const setting = select.getAttribute('data-setting');
      if (setting) {
        this.updateSetting(setting, select.value);
      }
    });

    // Checkbox changes (via delegation)
    this.delegate('change', 'input[type="checkbox"]', (e) => {
      const checkbox = e.target as HTMLInputElement;
      const setting = checkbox.getAttribute('data-setting');
      if (setting) {
        this.updateSetting(setting, checkbox.checked);
      }
    });

    // Slider changes (via delegation)
    this.delegate('input', '.settings-slider', (e) => {
      const slider = e.target as HTMLInputElement;
      const setting = slider.getAttribute('data-setting');
      if (setting) {
        const value = parseInt(slider.value, 10);
        this.updateSetting(setting, value);

        // Update display value
        const valueEl = this.query<HTMLElement>(`[data-value="${setting}"]`);
        if (valueEl) {
          valueEl.textContent = value.toString();
        }

        // Update credits info when credits slider changes
        if (setting === 'creditsPerPrompt') {
          const infoEl = this.query<HTMLElement>('[data-credits-info]');
          if (infoEl) {
            const requests = this._searchDepth === 'basic' ? value : Math.floor(value / 2);
            infoEl.textContent = `(${requests} request${requests !== 1 ? 's' : ''})`;
          }
        }
      }
    });

    // Action button clicks (via delegation)
    this.delegate('click', '[data-action]', (e, element) => {
      const action = element.getAttribute('data-action');
      if (action) {
        this.handleAction(action);
      }
    });
  }

  // ============================================
  // Subscription Handlers
  // ============================================

  private handleSettingsUpdate(settings: SettingsValues): void {
    if (!settings) return;

    let changed = false;

    if (settings.logLevel !== undefined && settings.logLevel !== this._logLevel) {
      this._logLevel = settings.logLevel;
      changed = true;
    }
    if (settings.webviewLogLevel !== undefined && settings.webviewLogLevel !== this._webviewLogLevel) {
      this._webviewLogLevel = settings.webviewLogLevel;
      changed = true;
    }
    if (settings.tracingEnabled !== undefined && settings.tracingEnabled !== this._tracingEnabled) {
      this._tracingEnabled = settings.tracingEnabled;
      changed = true;
    }
    if (settings.logColors !== undefined && settings.logColors !== this._logColors) {
      this._logColors = settings.logColors;
      changed = true;
    }
    if (settings.allowAllCommands !== undefined && settings.allowAllCommands !== this._allowAllCommands) {
      this._allowAllCommands = settings.allowAllCommands;
      changed = true;
    }
    if (settings.systemPrompt !== undefined && settings.systemPrompt !== this._systemPrompt) {
      this._systemPrompt = settings.systemPrompt;
      changed = true;
    }
    if (settings.searchDepth !== undefined && settings.searchDepth !== this._searchDepth) {
      this._searchDepth = settings.searchDepth;
      changed = true;
    }
    if (settings.creditsPerPrompt !== undefined && settings.creditsPerPrompt !== this._creditsPerPrompt) {
      this._creditsPerPrompt = settings.creditsPerPrompt;
      changed = true;
    }
    if (settings.maxResultsPerSearch !== undefined && settings.maxResultsPerSearch !== this._maxResultsPerSearch) {
      this._maxResultsPerSearch = settings.maxResultsPerSearch;
      changed = true;
    }
    if (settings.cacheDuration !== undefined && settings.cacheDuration !== this._cacheDuration) {
      this._cacheDuration = settings.cacheDuration;
      changed = true;
    }
    if (settings.autoSaveHistory !== undefined && settings.autoSaveHistory !== this._autoSaveHistory) {
      this._autoSaveHistory = settings.autoSaveHistory;
      changed = true;
    }

    if (changed) {
      this.updateBodyContent(this.renderPopupContent());
    }
  }

  private handleDefaultPrompt(data: DefaultPrompt): void {
    if (!data) return;

    this._defaultPromptModel = data.model || 'current model';
    this._defaultPromptContent = data.prompt || '';
    this._defaultPromptVisible = true;

    // Just update the preview section
    this.updateBodyContent(this.renderPopupContent());
  }

  // ============================================
  // Setting Updates
  // ============================================

  private updateSetting(setting: string, value: unknown): void {
    switch (setting) {
      case 'logLevel':
        this._logLevel = value as string;
        this._vscode.postMessage({ type: 'setLogLevel', logLevel: value });
        break;
      case 'webviewLogLevel':
        this._webviewLogLevel = value as string;
        this._vscode.postMessage({ type: 'setWebviewLogLevel', logLevel: value });
        break;
      case 'tracingEnabled':
        this._tracingEnabled = value as boolean;
        this._vscode.postMessage({ type: 'setTracingEnabled', enabled: value });
        break;
      case 'logColors':
        this._logColors = value as boolean;
        this._vscode.postMessage({ type: 'setLogColors', enabled: value });
        break;
      case 'allowAllCommands':
        this._allowAllCommands = value as boolean;
        this._vscode.postMessage({ type: 'setAllowAllCommands', enabled: value });
        break;
      case 'searchDepth': {
        this._searchDepth = value as string;
        this._vscode.postMessage({ type: 'setSearchDepth', searchDepth: value });
        // Re-clamp credits to valid range for the new depth mode
        if (this._searchDepth === 'advanced') {
          if (this._creditsPerPrompt < 2) this._creditsPerPrompt = 2;
          if (this._creditsPerPrompt % 2 !== 0) this._creditsPerPrompt = this._creditsPerPrompt + 1;
          if (this._creditsPerPrompt > 10) this._creditsPerPrompt = 10;
        } else {
          if (this._creditsPerPrompt > 5) this._creditsPerPrompt = 5;
        }
        this._vscode.postMessage({ type: 'setCreditsPerPrompt', value: this._creditsPerPrompt });
        // Re-render to update slider min/max/step
        this.updateBodyContent(this.renderPopupContent());
        break;
      }
      case 'creditsPerPrompt':
        this._creditsPerPrompt = value as number;
        this._vscode.postMessage({ type: 'setCreditsPerPrompt', value });
        break;
      case 'maxResultsPerSearch':
        this._maxResultsPerSearch = value as number;
        this._vscode.postMessage({ type: 'setMaxResultsPerSearch', value });
        break;
      case 'cacheDuration':
        this._cacheDuration = value as number;
        this._vscode.postMessage({ type: 'setCacheDuration', duration: value });
        break;
      case 'autoSaveHistory':
        this._autoSaveHistory = value as boolean;
        this._vscode.postMessage({ type: 'setAutoSaveHistory', enabled: value });
        break;
    }
  }

  // ============================================
  // Action Handlers
  // ============================================

  private handleAction(action: string): void {
    switch (action) {
      case 'openLogs':
        this._vscode.postMessage({ type: 'openLogs' });
        break;

      case 'savePrompt': {
        const textarea = this.query<HTMLTextAreaElement>('[data-setting="systemPrompt"]');
        if (textarea) {
          this._systemPrompt = textarea.value;
          this._vscode.postMessage({ type: 'setSystemPrompt', systemPrompt: this._systemPrompt });
          this.showFeedback(action, 'Saved!');
        }
        break;
      }

      case 'resetPrompt': {
        const textarea = this.query<HTMLTextAreaElement>('[data-setting="systemPrompt"]');
        if (textarea) {
          textarea.value = '';
          this._systemPrompt = '';
          this._vscode.postMessage({ type: 'setSystemPrompt', systemPrompt: '' });
          this.showFeedback(action, 'Reset!');
        }
        break;
      }

      case 'showDefault':
        this._vscode.postMessage({ type: 'getDefaultSystemPrompt' });
        break;

      case 'closePreview':
        this._defaultPromptVisible = false;
        this.updateBodyContent(this.renderPopupContent());
        break;

      case 'clearSearchCache':
        this._vscode.postMessage({ type: 'clearSearchCache' });
        this.showFeedback(action, 'Cleared!');
        break;

      case 'clearHistory':
        if (confirm('Clear ALL chat history? This cannot be undone.')) {
          this._vscode.postMessage({ type: 'clearAllHistory' });
        }
        break;

      case 'testStatus':
        this.manager.publishDirect('status.message', { type: 'info', message: 'Test status message' }, this.actorId);
        break;

      case 'testWarning':
        this.manager.publishDirect('status.message', { type: 'warning', message: 'Test warning message' }, this.actorId);
        break;

      case 'testError':
        this.manager.publishDirect('status.message', { type: 'error', message: 'Test error message' }, this.actorId);
        break;

      case 'resetDefaults':
        if (confirm('Reset ALL settings to defaults? This cannot be undone.')) {
          this._vscode.postMessage({ type: 'resetAllSettings' });
        }
        break;
    }
  }

  private showFeedback(action: string, text: string): void {
    const btn = this.query<HTMLButtonElement>(`[data-action="${action}"]`);
    if (btn) {
      const original = btn.textContent;
      btn.textContent = text;
      setTimeout(() => {
        btn.textContent = original;
      }, 1500);
    }
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Get current settings.
   */
  getSettings(): SettingsValues {
    return {
      logLevel: this._logLevel,
      webviewLogLevel: this._webviewLogLevel,
      tracingEnabled: this._tracingEnabled,
      logColors: this._logColors,
      allowAllCommands: this._allowAllCommands,
      systemPrompt: this._systemPrompt,
      searchDepth: this._searchDepth,
      creditsPerPrompt: this._creditsPerPrompt,
      maxResultsPerSearch: this._maxResultsPerSearch,
      cacheDuration: this._cacheDuration,
      autoSaveHistory: this._autoSaveHistory
    };
  }
}
