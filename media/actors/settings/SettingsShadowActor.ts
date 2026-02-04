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
  logColors: boolean;
  allowAllCommands: boolean;
  systemPrompt: string;
  searchDepth: string;
  searchesPerPrompt: number;
  cacheDuration: number;
  autoSaveHistory: boolean;
  maxSessions: number;
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
  private _logLevel = 'INFO';
  private _logColors = true;
  private _allowAllCommands = false;
  private _systemPrompt = '';
  private _searchDepth = 'basic';
  private _searchesPerPrompt = 1;
  private _cacheDuration = 15;
  private _autoSaveHistory = true;
  private _maxSessions = 100;

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
      <!-- Logging Section -->
      <div class="settings-section">
        <div class="settings-section-title">Logging</div>
        <div class="settings-control">
          <label>Log Level</label>
          <select class="settings-select" data-setting="logLevel">
            <option value="DEBUG" ${this._logLevel === 'DEBUG' ? 'selected' : ''}>Debug (verbose)</option>
            <option value="INFO" ${this._logLevel === 'INFO' ? 'selected' : ''}>Info (default)</option>
            <option value="WARN" ${this._logLevel === 'WARN' ? 'selected' : ''}>Warnings only</option>
            <option value="ERROR" ${this._logLevel === 'ERROR' ? 'selected' : ''}>Errors only</option>
            <option value="OFF" ${this._logLevel === 'OFF' ? 'selected' : ''}>Off</option>
          </select>
        </div>
        <div class="settings-control">
          <label>
            <input type="checkbox" data-setting="logColors" ${this._logColors ? 'checked' : ''}>
            Color-coded logs
          </label>
        </div>
        <button class="settings-action-btn" data-action="openLogs">Open Logs</button>
      </div>

      <div class="settings-divider"></div>

      <!-- Reasoner Section -->
      <div class="settings-section">
        <div class="settings-section-title">Reasoner (R1)</div>
        <div class="settings-control">
          <label class="settings-wild-label">
            <input type="checkbox" data-setting="allowAllCommands" ${this._allowAllCommands ? 'checked' : ''}>
            <span class="settings-wild-icon">🐾</span> Walk on the Wild Side
          </label>
          <div class="settings-hint">Allow ALL shell commands. Disables safety blocklist.</div>
        </div>
      </div>

      <div class="settings-divider"></div>

      <!-- System Prompt Section -->
      <div class="settings-section">
        <div class="settings-section-title">System Prompt</div>
        <div class="settings-hint">Custom prompt prepended to all requests. Leave empty for model default.</div>
        <textarea
          class="settings-textarea"
          data-setting="systemPrompt"
          placeholder="Enter custom system prompt..."
          rows="4"
        >${this.escapeHtml(this._systemPrompt)}</textarea>
        <div class="settings-btn-row">
          <button class="settings-action-btn" data-action="savePrompt">Save</button>
          <button class="settings-action-btn" data-action="resetPrompt">Reset to Default</button>
          <button class="settings-action-btn" data-action="showDefault">Show Default</button>
        </div>
        ${this._defaultPromptVisible ? this.renderDefaultPromptPreview() : ''}
      </div>

      <div class="settings-divider"></div>

      <!-- Web Search Section -->
      <div class="settings-section">
        <div class="settings-section-title">Web Search</div>
        <div class="settings-control">
          <label>Search Depth</label>
          <select class="settings-select" data-setting="searchDepth">
            <option value="basic" ${this._searchDepth === 'basic' ? 'selected' : ''}>Basic (faster)</option>
            <option value="advanced" ${this._searchDepth === 'advanced' ? 'selected' : ''}>Advanced (thorough)</option>
          </select>
        </div>
        <div class="settings-control">
          <label>Searches per prompt: <span data-value="searchesPerPrompt">${this._searchesPerPrompt}</span></label>
          <input type="range" class="settings-slider" data-setting="searchesPerPrompt" min="1" max="10" step="1" value="${this._searchesPerPrompt}">
        </div>
        <div class="settings-control">
          <label>Cache duration: <span data-value="cacheDuration">${this._cacheDuration}</span> min</label>
          <input type="range" class="settings-slider" data-setting="cacheDuration" min="0" max="60" step="5" value="${this._cacheDuration}">
        </div>
        <button class="settings-action-btn" data-action="clearSearchCache">Clear Search Cache</button>
      </div>

      <div class="settings-divider"></div>

      <!-- History Section -->
      <div class="settings-section">
        <div class="settings-section-title">History</div>
        <div class="settings-control">
          <label>
            <input type="checkbox" data-setting="autoSaveHistory" ${this._autoSaveHistory ? 'checked' : ''}>
            Auto-save history
          </label>
        </div>
        <div class="settings-control">
          <label>Max sessions: <span data-value="maxSessions">${this._maxSessions}</span></label>
          <input type="range" class="settings-slider" data-setting="maxSessions" min="10" max="500" step="10" value="${this._maxSessions}">
        </div>
        <button class="settings-action-btn settings-danger-btn" data-action="clearHistory">Clear All History</button>
      </div>

      <div class="settings-divider"></div>

      <!-- Debug Section -->
      <div class="settings-section">
        <div class="settings-section-title">Debug</div>
        <div class="settings-btn-row">
          <button class="settings-action-btn" data-action="testStatus">Test Status</button>
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
    if (settings.searchesPerPrompt !== undefined && settings.searchesPerPrompt !== this._searchesPerPrompt) {
      this._searchesPerPrompt = settings.searchesPerPrompt;
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
    if (settings.maxSessions !== undefined && settings.maxSessions !== this._maxSessions) {
      this._maxSessions = settings.maxSessions;
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
      case 'logColors':
        this._logColors = value as boolean;
        this._vscode.postMessage({ type: 'setLogColors', enabled: value });
        break;
      case 'allowAllCommands':
        this._allowAllCommands = value as boolean;
        this._vscode.postMessage({ type: 'setAllowAllCommands', enabled: value });
        break;
      case 'searchDepth':
        this._searchDepth = value as string;
        this._vscode.postMessage({ type: 'setSearchDepth', depth: value });
        break;
      case 'searchesPerPrompt':
        this._searchesPerPrompt = value as number;
        this._vscode.postMessage({ type: 'setSearchesPerPrompt', value });
        break;
      case 'cacheDuration':
        this._cacheDuration = value as number;
        this._vscode.postMessage({ type: 'setCacheDuration', duration: value });
        break;
      case 'autoSaveHistory':
        this._autoSaveHistory = value as boolean;
        this._vscode.postMessage({ type: 'setAutoSaveHistory', enabled: value });
        break;
      case 'maxSessions':
        this._maxSessions = value as number;
        this._vscode.postMessage({ type: 'setMaxSessions', value });
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
      logColors: this._logColors,
      allowAllCommands: this._allowAllCommands,
      systemPrompt: this._systemPrompt,
      searchDepth: this._searchDepth,
      searchesPerPrompt: this._searchesPerPrompt,
      cacheDuration: this._cacheDuration,
      autoSaveHistory: this._autoSaveHistory,
      maxSessions: this._maxSessions
    };
  }
}
