/**
 * WebSearchPopupShadowActor
 *
 * Shadow DOM popup for web search settings. Renders a shared top section
 * (mode picker, provider picker) plus a provider-specific section driven
 * by the registry's `configShape` equivalent — today hardcoded for Tavily
 * and SearXNG, future providers would extend here.
 *
 * Publications:
 * - webSearch.popup.visible: boolean
 * - toolbar.webSearchEnabled: boolean
 * - toolbar.webSearchMode: WebSearchMode
 *
 * Subscriptions:
 * - webSearch.popup.open: boolean - request to open/close
 * - webSearch.settings: WebSearchSettings - Tavily credit/depth settings
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
export type WebSearchProviderId = 'tavily' | 'searxng';

export interface WebSearchSettings {
  creditsPerPrompt: number;
  maxResultsPerSearch: number;
  searchDepth: 'basic' | 'advanced';
}

export interface SearxngConfig {
  endpoint: string;
  engines: string[];
}

/** Common SearXNG engines. User can still add more by editing
 *  `moby.webSearch.searxng.engines` in settings.json directly. */
const COMMON_SEARXNG_ENGINES = [
  'google',
  'bing',
  'duckduckgo',
  'brave',
  'wikipedia',
  'github',
  'stackoverflow'
];

// ============================================
// WebSearchPopupShadowActor
// ============================================

export class WebSearchPopupShadowActor extends PopupShadowActor {
  private _mode: WebSearchMode = 'auto';
  private _enabled = false;
  private _provider: WebSearchProviderId = 'tavily';
  private _providerStatus: Record<string, boolean> = {};
  private _settings: WebSearchSettings = {
    creditsPerPrompt: 1,
    maxResultsPerSearch: 5,
    searchDepth: 'basic'
  };
  private _searxng: SearxngConfig = { endpoint: '', engines: [] };
  /** Last test-connection result, keyed by provider id. Stored so we can
   *  render it inline beneath the Test button; cleared on next interaction. */
  private _testResults: Partial<Record<WebSearchProviderId, { success: boolean; message: string }>> = {};

  constructor(manager: EventStateManager, element: HTMLElement, vscode: VSCodeAPI) {
    const config: PopupConfig = {
      manager,
      element,
      vscode,
      header: 'Web Search',
      position: 'top-left',
      width: '320px',
      publications: {
        'toolbar.webSearchEnabled': () => this._enabled,
        'toolbar.webSearchMode': () => this._mode,
      },
      subscriptions: {
        'webSearch.settings': (value: unknown) => this.handleSettingsUpdate(value as WebSearchSettings),
        'webSearch.mode': (value: unknown) => this.handleModeUpdate(value as WebSearchMode),
        'webSearch.enabled': (value: unknown) => this.handleEnabledUpdate(value as boolean),
        'webSearch.provider': (value: unknown) => this.handleProviderUpdate(value as WebSearchProviderId),
        'webSearch.providerStatus': (value: unknown) => this.handleProviderStatusUpdate(value as Record<string, boolean>),
        'webSearch.searxng': (value: unknown) => this.handleSearxngUpdate(value as SearxngConfig),
        'webSearch.testResult': (value: unknown) => this.handleTestResult(value as { provider: WebSearchProviderId; success: boolean; message: string }),
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
    this._testResults = {};
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

  private handleProviderUpdate(provider: WebSearchProviderId): void {
    this._provider = provider;
    if (this.isVisible()) this.updateBodyContent(this.renderPopupContent());
  }

  private handleProviderStatusUpdate(status: Record<string, boolean>): void {
    this._providerStatus = status;
    if (this.isVisible()) this.updateBodyContent(this.renderPopupContent());
  }

  private handleSearxngUpdate(cfg: SearxngConfig): void {
    this._searxng = { endpoint: cfg.endpoint ?? '', engines: cfg.engines ?? [] };
    if (this.isVisible()) this.updateBodyContent(this.renderPopupContent());
  }

  private handleTestResult(r: { provider: WebSearchProviderId; success: boolean; message: string }): void {
    this._testResults[r.provider] = { success: r.success, message: r.message };
    if (this.isVisible()) this.updateBodyContent(this.renderPopupContent());
  }

  // ============================================
  // Rendering
  // ============================================

  protected renderPopupContent(): string {
    // IMPORTANT: this method is invoked during `super()` — before our own
    // field initializers have run. Every field access here must tolerate
    // `undefined` via optional chaining or safe defaults. A TypeError here
    // silently cascades and breaks every popup in the app (tested the
    // hard way during the custom-models work).
    const mode = this._mode ?? 'auto';
    const provider = this._provider ?? 'tavily';
    const isOff = mode === 'off';
    const providerConfigured = this._providerStatus?.[provider] ?? false;

    return `
      <div class="ws-mode-options">
        <button class="ws-mode-btn${mode === 'off' ? ' active' : ''}" data-mode="off">Off</button>
        <button class="ws-mode-btn${mode === 'manual' ? ' active' : ''}" data-mode="manual">Forced</button>
        <button class="ws-mode-btn${mode === 'auto' ? ' active' : ''}" data-mode="auto">Auto</button>
      </div>

      <div class="ws-settings${isOff ? ' disabled-section' : ''}">
        <div class="ws-option">
          <label>Provider:</label>
          <div class="ws-provider-options">
            <button class="ws-provider-btn${provider === 'tavily' ? ' active' : ''}" data-provider="tavily"${isOff ? ' disabled' : ''}>
              <span class="ws-provider-name">Tavily</span>
              <span class="ws-provider-hint">Hosted · API key</span>
            </button>
            <button class="ws-provider-btn${provider === 'searxng' ? ' active' : ''}" data-provider="searxng"${isOff ? ' disabled' : ''}>
              <span class="ws-provider-name">SearXNG</span>
              <span class="ws-provider-hint">Self-hosted · free</span>
            </button>
          </div>
        </div>

        ${provider === 'tavily' ? this.renderTavilySection(isOff) : this.renderSearxngSection(isOff)}

        <div class="ws-option ws-test-row">
          <button class="ws-test-btn"${(isOff || !providerConfigured) ? ' disabled' : ''} title="${providerConfigured ? 'Run a small test query against this provider' : 'Provider not configured'}">Test connection</button>
          ${this.renderTestResult()}
        </div>

        <button class="ws-clear-cache-btn"${isOff ? ' disabled' : ''}>Clear Cache</button>
      </div>
    `;
  }

  private renderTavilySection(isOff: boolean): string {
    // Defensive defaults — may be called during super(), see renderPopupContent.
    const settings = this._settings ?? { creditsPerPrompt: 1, maxResultsPerSearch: 5, searchDepth: 'basic' as const };
    const isAdvanced = settings.searchDepth === 'advanced';
    const creditsMin = isAdvanced ? 2 : 1;
    const creditsMax = isAdvanced ? 10 : 5;
    const creditsStep = isAdvanced ? 2 : 1;
    const credits = settings.creditsPerPrompt;
    const costPerCall = isAdvanced ? 2 : 1;
    const requestCount = Math.floor(credits / costPerCall);

    return `
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
    `;
  }

  private renderSearxngSection(isOff: boolean): string {
    const searxng = this._searxng ?? { endpoint: '', engines: [] };
    const settings = this._settings ?? { creditsPerPrompt: 1, maxResultsPerSearch: 5, searchDepth: 'basic' as const };
    const endpoint = searxng.endpoint || '(not set)';
    const configured = !!searxng.endpoint;
    const enabledEngines = new Set(searxng.engines ?? []);

    return `
      <div class="ws-option">
        <label>Endpoint:</label>
        <div class="ws-endpoint-row">
          <code class="ws-endpoint-value${configured ? '' : ' unset'}" title="${this.escapeHtml(endpoint)}">${this.escapeHtml(endpoint)}</code>
          <button class="ws-endpoint-btn"${isOff ? ' disabled' : ''}>Change</button>
        </div>
      </div>
      <div class="ws-option">
        <label>Results per request: <span data-id="maxResultsValue">${settings.maxResultsPerSearch}</span></label>
        <input type="range" data-id="maxResultsSlider" min="1" max="20" step="1" value="${settings.maxResultsPerSearch}"${isOff ? ' disabled' : ''}>
      </div>
      <div class="ws-option">
        <label>Engines:</label>
        <div class="ws-engines">
          ${COMMON_SEARXNG_ENGINES.map(name => `
            <label class="ws-engine-item">
              <input type="checkbox" data-engine="${name}"${enabledEngines.has(name) ? ' checked' : ''}${isOff ? ' disabled' : ''}>
              <span>${name}</span>
            </label>
          `).join('')}
        </div>
        <div class="ws-engines-hint">Leave all unchecked to use your SearXNG instance's default engine set.</div>
      </div>
    `;
  }

  private renderTestResult(): string {
    const provider = this._provider ?? 'tavily';
    const r = this._testResults?.[provider];
    if (!r) return '';
    return `<span class="ws-test-result ${r.success ? 'ok' : 'err'}">${this.escapeHtml(r.message)}</span>`;
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

    // Provider picker
    this.delegate('click', '.ws-provider-btn', (_e, element) => {
      const next = (element as HTMLElement).dataset.provider as WebSearchProviderId;
      if (!next || next === this._provider) return;
      this._provider = next;
      this._testResults = {};
      this._vscode.postMessage({ type: 'setWebSearchProvider', provider: next });
      this.updateBodyContent(this.renderPopupContent());
    });

    // SearXNG endpoint — delegates to the command palette for the input box
    this.delegate('click', '.ws-endpoint-btn', () => {
      this._vscode.postMessage({ type: 'executeCommand', command: 'moby.setSearxngEndpoint' });
      this.close();
    });

    // Engine checkboxes (SearXNG). Rebuild the array from current checkbox state.
    this.delegate('change', '.ws-engines input[type="checkbox"]', () => {
      const engines = Array.from(
        this.shadowRoot?.querySelectorAll<HTMLInputElement>('.ws-engines input[type="checkbox"]:checked') ?? []
      ).map(el => el.dataset.engine!).filter(Boolean);
      this._searxng.engines = engines;
      this._vscode.postMessage({ type: 'setSearxngEngines', engines });
    });

    // Test connection
    this.delegate('click', '.ws-test-btn', async () => {
      const btn = this.query<HTMLButtonElement>('.ws-test-btn');
      if (!btn || btn.disabled) return;
      const requestId = `test-${Date.now()}`;
      delete this._testResults[this._provider];
      btn.disabled = true;
      btn.textContent = 'Testing…';
      this._vscode.postMessage({
        type: 'testWebSearchProvider',
        provider: this._provider,
        requestId
      });
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

    // Depth buttons (Tavily only, but the handler is safe on the SearXNG view too)
    this.delegate('click', '.ws-depth-btn', (_e, element) => {
      const newDepth = (element as HTMLElement).dataset.depth as 'basic' | 'advanced';
      this._settings.searchDepth = newDepth;

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

  private delegateInput(selector: string, handler: (value: string) => void): void {
    this.shadowRoot?.addEventListener('input', (e) => {
      const target = (e.target as HTMLElement)?.closest(selector);
      if (target) handler((target as HTMLInputElement).value);
    });
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
