/**
 * ToolbarShadowActor
 *
 * Shadow DOM toolbar with unified 3x2 button grid:
 * - Row 1: Web Search, Send/Stop
 * - Row 2: Plan, Edit Mode
 * - Row 3: Files, Attach
 *
 * Note: Commands button moved to header bar
 *
 * Publications:
 * - toolbar.editMode: 'manual' | 'ask' | 'auto'
 * - toolbar.webSearchEnabled: boolean
 * - toolbar.filesModalOpen: boolean
 * - toolbar.planEnabled: boolean
 * - toolbar.sendClicked: boolean (pulse to trigger send)
 *
 * Subscriptions:
 * - streaming.active: boolean - toggle send/stop buttons
 */

import { ShadowActor } from '../../state/ShadowActor';
import { EventStateManager } from '../../state/EventStateManager';
import { toolbarShadowStyles } from './shadowStyles';

export type EditMode = 'manual' | 'ask' | 'auto';

export interface ToolbarState {
  editMode: EditMode;
  webSearchEnabled: boolean;
  filesModalOpen: boolean;
  planEnabled: boolean;
  streaming: boolean;
}

export type EditModeHandler = (mode: EditMode) => void;
export type WebSearchHandler = (enabled: boolean, settings?: WebSearchSettings) => void;
export type FilesHandler = () => void;
export type PlanHandler = (enabled: boolean) => void;
export type SendHandler = () => void;
export type StopHandler = () => void;
export type AttachHandler = () => void;

export interface WebSearchSettings {
  creditsPerPrompt: number;
  maxResultsPerSearch: number;
  searchDepth: 'basic' | 'advanced';
}

interface VSCodeAPI {
  postMessage(message: unknown): void;
}

// Icons
const ICONS = {
  files: `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M14.5 3H7.71l-.85-.85L6.51 2H1.5l-.5.5v11l.5.5h13l.5-.5v-10L14.5 3zm-.51 8.49V13h-12V7h4.49l.35-.15.86-.86H14v1.5l-.01 4zm0-6.49h-6.5l-.35.15-.86.86H2v-3h4.29l.85.85.36.15H14l-.01 1-.01 1z"/>
  </svg>`,
  edit: `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <text x="8" y="11" font-size="10" font-weight="bold" text-anchor="middle" fill="currentColor">M</text>
  </svg>`,
  plan: `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <text x="8" y="11" font-size="10" font-weight="bold" text-anchor="middle" fill="currentColor">P</text>
  </svg>`,
  search: `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <circle cx="6" cy="6" r="5.5" fill="none" stroke="currentColor" stroke-width="1"/>
    <path d="M0.5 6h11" stroke="currentColor" stroke-width="0.8" fill="none"/>
    <ellipse cx="6" cy="6" rx="2.5" ry="5.5" fill="none" stroke="currentColor" stroke-width="0.8"/>
    <path d="M10 10l4.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`,
  attach: `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M4.5 3a2.5 2.5 0 0 1 5 0v9a1.5 1.5 0 0 1-3 0V5a.5.5 0 0 1 1 0v7a.5.5 0 0 0 1 0V3a1.5 1.5 0 1 0-3 0v9a2.5 2.5 0 0 0 5 0V5a.5.5 0 0 1 1 0v7a3.5 3.5 0 1 1-7 0V3z"/>
  </svg>`,
  send: `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M1.724 1.053a.5.5 0 0 1 .545-.108l13 5.5a.5.5 0 0 1 0 .91l-13 5.5a.5.5 0 0 1-.69-.575l1.557-5.28-1.557-5.28a.5.5 0 0 1 .145-.467zM3.882 7.5l-1.06 3.593L12.14 8 2.822 4.907 3.882 8.5H8a.5.5 0 0 1 0 1H3.882z"/>
  </svg>`,
  stop: `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <rect x="3" y="3" width="10" height="10" rx="1"/>
  </svg>`
};

const EDIT_MODES: EditMode[] = ['manual', 'ask', 'auto'];
const EDIT_MODE_LABELS: Record<EditMode, string> = {
  manual: 'Manual',
  ask: 'Ask before applying',
  auto: 'Auto-apply'
};
const EDIT_MODE_LETTERS: Record<EditMode, string> = {
  manual: 'M',
  ask: 'Q',
  auto: 'A'
};

export class ToolbarShadowActor extends ShadowActor {
  // State
  private _editMode: EditMode = 'manual';
  private _webSearchEnabled = false;
  private _filesModalOpen = false;
  private _planEnabled = false;
  private _streaming = false;

  // Web search settings
  private _webSearchSettings: WebSearchSettings = {
    creditsPerPrompt: 1,
    maxResultsPerSearch: 5,
    searchDepth: 'basic'
  };

  // Modals (rendered in document.body, outside shadow DOM)
  private _webSearchModal: HTMLElement | null = null;

  // Handlers
  private _onEditModeChange: EditModeHandler | null = null;
  private _onWebSearchToggle: WebSearchHandler | null = null;
  private _onFilesOpen: FilesHandler | null = null;
  private _onPlan: PlanHandler | null = null;
  private _onSend: SendHandler | null = null;
  private _onStop: StopHandler | null = null;
  private _onAttach: AttachHandler | null = null;
  private _vscode: VSCodeAPI | null = null;

  // Bound handlers for cleanup
  private _boundOutsideClick: ((e: MouseEvent) => void) | null = null;

  constructor(manager: EventStateManager, element: HTMLElement, vscode?: VSCodeAPI) {
    super({
      manager,
      element,
      styles: toolbarShadowStyles,
      publications: {
        'toolbar.editMode': () => this._editMode,
        'toolbar.webSearchEnabled': () => this._webSearchEnabled,
        'toolbar.filesModalOpen': () => this._filesModalOpen,
        'toolbar.planEnabled': () => this._planEnabled
      },
      subscriptions: {
        'streaming.active': (value: unknown) => this.handleStreamingChange(value as boolean)
      }
    });

    this._vscode = vscode || null;
    this.renderToolbar();
    this.setupEventHandlers();
    this.setupGlobalHandlers();
  }

  // ============================================
  // Rendering
  // ============================================

  private renderToolbar(): void {
    // Grid layout (2 cols x 3 rows):
    // Row 1: Web Search, Send/Stop
    // Row 2: Plan, Edit Mode
    // Row 3: Files, Attach
    this.render(`
      <div class="toolbar">
        <button class="btn search-btn" title="Web search">
          ${ICONS.search}
        </button>
        <button class="btn send-btn" title="Send message">
          ${ICONS.send}
        </button>
        <button class="btn stop-btn" title="Stop generation" style="display: none;">
          ${ICONS.stop}
        </button>
        <button class="btn plan-btn" title="Plan (coming soon)">
          ${ICONS.plan}
        </button>
        <button class="btn edit-mode-btn" title="Edit mode: Manual">
          ${ICONS.edit}
        </button>
        <button class="btn files-btn" title="Select files for context">
          ${ICONS.files}
        </button>
        <button class="btn attach-btn" title="Attach file">
          ${ICONS.attach}
        </button>
      </div>
    `);
  }

  private setupEventHandlers(): void {
    this.delegate('click', '.search-btn', (e) => this.handleSearchClick(e));
    this.delegate('click', '.send-btn', () => this.handleSendClick());
    this.delegate('click', '.stop-btn', () => this.handleStopClick());
    this.delegate('click', '.plan-btn', () => this.handlePlanClick());
    this.delegate('click', '.edit-mode-btn', () => this.handleEditModeClick());
    this.delegate('click', '.files-btn', (e) => this.handleFilesClick(e));
    this.delegate('click', '.attach-btn', () => this.handleAttachClick());
  }

  private setupGlobalHandlers(): void {
    this._boundOutsideClick = this.handleOutsideClick.bind(this);
    document.addEventListener('click', this._boundOutsideClick);
  }

  // ============================================
  // Button Handlers
  // ============================================

  private handleFilesClick(e: Event): void {
    e.stopPropagation();
    this._filesModalOpen = true;
    this._onFilesOpen?.();
    // FilesShadowActor.onOpen() sends getOpenFiles + fileModalOpened
    this.publish({ 'toolbar.filesModalOpen': true });
  }

  private handleEditModeClick(): void {
    const currentIndex = EDIT_MODES.indexOf(this._editMode);
    const nextIndex = (currentIndex + 1) % EDIT_MODES.length;
    const newMode = EDIT_MODES[nextIndex];

    this._editMode = newMode;
    this.updateEditModeDisplay();

    this._onEditModeChange?.(newMode);
    this._vscode?.postMessage({ type: 'setEditMode', mode: newMode });
    this.publish({ 'toolbar.editMode': newMode });
  }

  private handlePlanClick(): void {
    this._planEnabled = !this._planEnabled;
    this.query<HTMLButtonElement>('.plan-btn')?.classList.toggle('active', this._planEnabled);
    this._onPlan?.(this._planEnabled);
    this._vscode?.postMessage({ type: 'togglePlan', enabled: this._planEnabled });
    this.publish({ 'toolbar.planEnabled': this._planEnabled });
  }

  private handleSearchClick(e: Event): void {
    e.stopPropagation();
    this.closeAllModals();
    this.showWebSearchModal();
  }

  private handleAttachClick(): void {
    this._onAttach?.();
  }

  private handleSendClick(): void {
    this._onSend?.();
  }

  private handleStopClick(): void {
    this._onStop?.();
    this._vscode?.postMessage({ type: 'stopGeneration' });
  }

  private handleOutsideClick(e: MouseEvent): void {
    const target = e.target as Element;

    // Use data attributes for modal detection (cleaner than class names)
    if (this._webSearchModal && !target.closest('[data-modal="web-search"]') && !this.isInsideShadow(target, '.search-btn')) {
      this.closeWebSearchModal();
    }
  }

  /**
   * Check if target is inside a shadow element matching selector
   */
  private isInsideShadow(target: Element, selector: string): boolean {
    const btn = this.query(selector);
    return btn?.contains(target) || target === btn;
  }

  // ============================================
  // Streaming State
  // ============================================

  private handleStreamingChange(streaming: boolean): void {
    this._streaming = streaming;

    const sendBtn = this.query<HTMLButtonElement>('.send-btn');
    const stopBtn = this.query<HTMLButtonElement>('.stop-btn');

    if (sendBtn && stopBtn) {
      sendBtn.style.display = streaming ? 'none' : 'flex';
      stopBtn.style.display = streaming ? 'flex' : 'none';
    }
  }

  // ============================================
  // Edit Mode
  // ============================================

  private updateEditModeDisplay(): void {
    const editBtn = this.query<HTMLButtonElement>('.edit-mode-btn');
    if (!editBtn) return;

    editBtn.classList.remove('state-manual', 'state-ask', 'state-auto');
    if (this._editMode === 'ask') editBtn.classList.add('state-ask');
    else if (this._editMode === 'auto') editBtn.classList.add('state-auto');

    editBtn.title = `Edit mode: ${EDIT_MODE_LABELS[this._editMode]}`;

    const svg = editBtn.querySelector('svg');
    if (svg) {
      svg.innerHTML = `<text x="8" y="11" font-size="10" font-weight="bold" text-anchor="middle" fill="currentColor">${EDIT_MODE_LETTERS[this._editMode]}</text>`;
    }
  }

  // ============================================
  // Web Search Modal (in document.body)
  // ============================================

  private showWebSearchModal(): void {
    const searchBtn = this.query<HTMLButtonElement>('.search-btn');
    if (!searchBtn) return;

    const isAdvanced = this._webSearchSettings.searchDepth === 'advanced';
    const creditsMin = isAdvanced ? 2 : 1;
    const creditsMax = isAdvanced ? 10 : 5;
    const creditsStep = isAdvanced ? 2 : 1;
    const credits = this._webSearchSettings.creditsPerPrompt;
    const costPerCall = isAdvanced ? 2 : 1;
    const requestCount = Math.floor(credits / costPerCall);

    const modal = document.createElement('div');
    modal.className = 'web-search-modal';
    modal.setAttribute('data-modal', 'web-search');
    modal.innerHTML = `
      <div class="web-search-modal-title">
        <span>Web Search Settings</span>
        <button class="web-search-modal-close">&times;</button>
      </div>
      <div class="web-search-modal-content">
        <div class="web-search-option">
          <label>Credits per prompt: <span id="creditsValue">${credits}</span> <span id="creditsInfo">(${requestCount} request${requestCount !== 1 ? 's' : ''})</span></label>
          <input type="range" id="creditsSlider" min="${creditsMin}" max="${creditsMax}" step="${creditsStep}" value="${credits}">
        </div>
        <div class="web-search-option">
          <label>Results per request: <span id="maxResultsValue">${this._webSearchSettings.maxResultsPerSearch}</span></label>
          <input type="range" id="maxResultsSlider" min="1" max="20" step="1" value="${this._webSearchSettings.maxResultsPerSearch}">
        </div>
        <div class="web-search-option">
          <label>Search depth:</label>
          <div class="search-depth-options">
            <button class="depth-btn ${!isAdvanced ? 'active' : ''}" data-depth="basic">
              <span class="depth-name">Basic</span>
              <span class="depth-credits">1 credit</span>
            </button>
            <button class="depth-btn ${isAdvanced ? 'active' : ''}" data-depth="advanced">
              <span class="depth-name">Advanced</span>
              <span class="depth-credits">2 credits</span>
            </button>
          </div>
        </div>
        <div class="web-search-toggle-row">
          <button class="web-search-enable-btn${this._webSearchEnabled ? ' disabled' : ''}">Enable</button>
          <button class="web-search-disable-btn${!this._webSearchEnabled ? ' disabled' : ''}">Disable</button>
        </div>
        <button class="web-search-clear-cache-btn">Clear Cache</button>
      </div>
    `;

    const rect = this.element.getBoundingClientRect();
    modal.style.bottom = `${window.innerHeight - rect.top + 5}px`;
    modal.style.left = `${rect.left}px`;

    modal.querySelector('.web-search-modal-close')?.addEventListener('click', () => {
      this.closeWebSearchModal();
    });

    // Credits slider
    modal.querySelector('#creditsSlider')?.addEventListener('input', (e) => {
      const value = parseInt((e.target as HTMLInputElement).value, 10);
      const valueEl = modal.querySelector('#creditsValue');
      const infoEl = modal.querySelector('#creditsInfo');
      if (valueEl) valueEl.textContent = value.toString();
      const cost = this._webSearchSettings.searchDepth === 'advanced' ? 2 : 1;
      const requests = Math.floor(value / cost);
      if (infoEl) infoEl.textContent = `(${requests} request${requests !== 1 ? 's' : ''})`;
      this._webSearchSettings.creditsPerPrompt = value;
      this._vscode?.postMessage({ type: 'setCreditsPerPrompt', value });
    });

    // Results slider
    modal.querySelector('#maxResultsSlider')?.addEventListener('input', (e) => {
      const value = parseInt((e.target as HTMLInputElement).value, 10);
      const valueEl = modal.querySelector('#maxResultsValue');
      if (valueEl) valueEl.textContent = value.toString();
      this._webSearchSettings.maxResultsPerSearch = value;
      this._vscode?.postMessage({ type: 'setMaxResultsPerSearch', value });
    });

    // Depth toggle buttons
    modal.querySelectorAll('.depth-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        modal.querySelectorAll('.depth-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const newDepth = (btn as HTMLElement).dataset.depth as 'basic' | 'advanced';
        this._webSearchSettings.searchDepth = newDepth;

        // Update credits slider range/step/value
        const slider = modal.querySelector('#creditsSlider') as HTMLInputElement;
        const newIsAdvanced = newDepth === 'advanced';
        const newMin = newIsAdvanced ? 2 : 1;
        const newMax = newIsAdvanced ? 10 : 5;
        const newStep = newIsAdvanced ? 2 : 1;
        slider.min = newMin.toString();
        slider.max = newMax.toString();
        slider.step = newStep.toString();

        // Re-clamp credits
        let clamped = this._webSearchSettings.creditsPerPrompt;
        if (clamped < newMin) clamped = newMin;
        if (clamped > newMax) clamped = newMax;
        if (newIsAdvanced && clamped % 2 !== 0) clamped = Math.min(clamped + 1, newMax);
        slider.value = clamped.toString();
        this._webSearchSettings.creditsPerPrompt = clamped;

        // Update display
        const valueEl = modal.querySelector('#creditsValue');
        const infoEl = modal.querySelector('#creditsInfo');
        if (valueEl) valueEl.textContent = clamped.toString();
        const cost = newIsAdvanced ? 2 : 1;
        const requests = Math.floor(clamped / cost);
        if (infoEl) infoEl.textContent = `(${requests} request${requests !== 1 ? 's' : ''})`;

        this._vscode?.postMessage({ type: 'setSearchDepth', searchDepth: newDepth });
        this._vscode?.postMessage({ type: 'setCreditsPerPrompt', value: clamped });
      });
    });

    // Enable button
    modal.querySelector('.web-search-enable-btn')?.addEventListener('click', () => {
      this._webSearchEnabled = true;
      this.query<HTMLButtonElement>('.search-btn')?.classList.add('active');
      this._onWebSearchToggle?.(true, this._webSearchSettings);
      this._vscode?.postMessage({ type: 'toggleWebSearch', enabled: true });
      this._vscode?.postMessage({ type: 'updateWebSearchSettings', settings: this._webSearchSettings });
      this.closeWebSearchModal();
      this.publish({ 'toolbar.webSearchEnabled': true });
    });

    // Disable button
    modal.querySelector('.web-search-disable-btn')?.addEventListener('click', () => {
      this._webSearchEnabled = false;
      this.query<HTMLButtonElement>('.search-btn')?.classList.remove('active');
      this._onWebSearchToggle?.(false);
      this._vscode?.postMessage({ type: 'toggleWebSearch', enabled: false });
      this.closeWebSearchModal();
      this.publish({ 'toolbar.webSearchEnabled': false });
    });

    modal.querySelector('.web-search-clear-cache-btn')?.addEventListener('click', () => {
      this._vscode?.postMessage({ type: 'clearSearchCache' });
      this.closeWebSearchModal();
    });

    document.body.appendChild(modal);
    this._webSearchModal = modal;
  }

  private closeWebSearchModal(): void {
    if (this._webSearchModal) {
      this._webSearchModal.remove();
      this._webSearchModal = null;
    }
  }

  private closeAllModals(): void {
    this.closeWebSearchModal();
  }

  // ============================================
  // Public API
  // ============================================

  onEditModeChange(handler: EditModeHandler): void {
    this._onEditModeChange = handler;
  }

  onWebSearchToggle(handler: WebSearchHandler): void {
    this._onWebSearchToggle = handler;
  }

  onFilesOpen(handler: FilesHandler): void {
    this._onFilesOpen = handler;
  }

  onPlan(handler: PlanHandler): void {
    this._onPlan = handler;
  }

  onSend(handler: SendHandler): void {
    this._onSend = handler;
  }

  onStop(handler: StopHandler): void {
    this._onStop = handler;
  }

  onAttach(handler: AttachHandler): void {
    this._onAttach = handler;
  }

  setVSCodeAPI(vscode: VSCodeAPI): void {
    this._vscode = vscode;
  }

  setEditMode(mode: EditMode): void {
    this._editMode = mode;
    this.updateEditModeDisplay();
    this.publish({ 'toolbar.editMode': mode });
  }

  setWebSearchEnabled(enabled: boolean): void {
    this._webSearchEnabled = enabled;
    this.query<HTMLButtonElement>('.search-btn')?.classList.toggle('active', enabled);
    this.publish({ 'toolbar.webSearchEnabled': enabled });
  }

  closeFilesModal(): void {
    this._filesModalOpen = false;
    // FilesShadowActor.onClose() sends fileModalClosed
    this.publish({ 'toolbar.filesModalOpen': false });
  }

  isStreaming(): boolean {
    return this._streaming;
  }

  getState(): ToolbarState {
    return {
      editMode: this._editMode,
      webSearchEnabled: this._webSearchEnabled,
      filesModalOpen: this._filesModalOpen,
      planEnabled: this._planEnabled,
      streaming: this._streaming
    };
  }

  // ============================================
  // Lifecycle
  // ============================================

  destroy(): void {
    this.closeAllModals();

    if (this._boundOutsideClick) {
      document.removeEventListener('click', this._boundOutsideClick);
    }

    this._onEditModeChange = null;
    this._onWebSearchToggle = null;
    this._onFilesOpen = null;
    this._onPlan = null;
    this._onSend = null;
    this._onStop = null;
    this._onAttach = null;
    this._vscode = null;

    super.destroy();
  }
}
