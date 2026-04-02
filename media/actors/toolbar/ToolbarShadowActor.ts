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
export type WebSearchMode = 'off' | 'manual' | 'auto';

export interface ToolbarState {
  editMode: EditMode;
  webSearchEnabled: boolean;
  webSearchMode: WebSearchMode;
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
  private _webSearchMode: WebSearchMode = 'auto';
  private _webSearchEnabled = false;
  private _webSearchConfigured = true;
  private _apiKeyConfigured = true;
  private _filesModalOpen = false;
  private _planEnabled = false;
  private _streaming = false;

  // Handlers
  private _onEditModeChange: EditModeHandler | null = null;
  private _onWebSearchToggle: WebSearchHandler | null = null;
  private _onFilesOpen: FilesHandler | null = null;
  private _onPlan: PlanHandler | null = null;
  private _onSend: SendHandler | null = null;
  private _onStop: StopHandler | null = null;
  private _onAttach: AttachHandler | null = null;
  private _onSearch: (() => void) | null = null;
  private _vscode: VSCodeAPI | null = null;

  constructor(manager: EventStateManager, element: HTMLElement, vscode?: VSCodeAPI) {
    super({
      manager,
      element,
      styles: toolbarShadowStyles,
      publications: {
        'toolbar.editMode': () => this._editMode,
        'toolbar.webSearchEnabled': () => this._webSearchEnabled,
        'toolbar.webSearchMode': () => this._webSearchMode,
        'toolbar.filesModalOpen': () => this._filesModalOpen,
        'toolbar.planEnabled': () => this._planEnabled
      },
      subscriptions: {
        'streaming.active': (value: unknown) => this.handleStreamingChange(value as boolean),
        'plans.activeCount': (value: unknown) => this.handlePlanCountChange(value as number)
      }
    });

    this._vscode = vscode || null;
    this.renderToolbar();
    this.setupEventHandlers();
    this.setupGlobalHandlers();

    // Apply initial button states (before settings arrive from extension)
    this.updateSearchButtonDisplay();
    this.updateSendButtonDisplay();
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
        <button class="btn plan-btn" title="Plans">
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
    // No global handlers needed — popups handle their own outside click detection
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
    this._onPlan?.(true);
  }

  private handleSearchClick(e: Event): void {
    e.stopPropagation();
    this._onSearch?.();
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

      // Re-apply API key disabled state when send button becomes visible again
      if (!streaming) {
        this.updateSendButtonDisplay();
      }
    }

    // Disable edit mode and plan buttons during streaming
    const editBtn = this.query<HTMLButtonElement>('.edit-mode-btn');
    const planBtn = this.query<HTMLButtonElement>('.plan-btn');
    if (editBtn) {
      editBtn.disabled = streaming;
      editBtn.style.opacity = streaming ? '0.4' : '';
      editBtn.style.pointerEvents = streaming ? 'none' : '';
    }
    if (planBtn) {
      planBtn.disabled = streaming;
      planBtn.style.opacity = streaming ? '0.4' : '';
      planBtn.style.pointerEvents = streaming ? 'none' : '';
    }
  }

  private handlePlanCountChange(count: number): void {
    this._planEnabled = count > 0;
    const planBtn = this.query<HTMLButtonElement>('.plan-btn');
    if (planBtn) {
      planBtn.classList.toggle('active', this._planEnabled);
      planBtn.title = count > 0 ? `Plans (${count} active)` : 'Plans';
    }
    this.publish({ 'toolbar.planEnabled': this._planEnabled });
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
  // Web Search Display
  // ============================================

  private updateSearchButtonDisplay(): void {
    const searchBtn = this.query<HTMLButtonElement>('.search-btn');
    if (!searchBtn) return;

    searchBtn.classList.remove('active', 'mode-auto', 'mode-manual', 'disabled');

    if (!this._webSearchConfigured) {
      searchBtn.classList.add('disabled');
      searchBtn.title = 'Web search: Tavily API key not set';
      searchBtn.disabled = true;
      return;
    }

    searchBtn.disabled = false;

    if (this._webSearchMode === 'auto') {
      searchBtn.classList.add('mode-auto');
      searchBtn.title = 'Web search: Auto (LLM decides)';
    } else if (this._webSearchMode === 'manual') {
      searchBtn.classList.add('active', 'mode-manual');
      searchBtn.title = 'Web search: Forced (every message)';
    } else {
      searchBtn.title = 'Web search: Off';
    }
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

  onSearch(handler: () => void): void {
    this._onSearch = handler;
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
    // In auto/off mode, ignore enabled state — only manual (forced) mode uses it
    if (this._webSearchMode !== 'manual') {
      this._webSearchEnabled = false;
    } else {
      this._webSearchEnabled = enabled;
    }
    this.updateSearchButtonDisplay();
    this.publish({ 'toolbar.webSearchEnabled': this._webSearchEnabled });
  }

  setWebSearchMode(mode: WebSearchMode): void {
    this._webSearchMode = mode;
    this.updateSearchButtonDisplay();
    this.publish({ 'toolbar.webSearchMode': mode });
  }

  setWebSearchConfigured(configured: boolean): void {
    this._webSearchConfigured = configured;
    this.updateSearchButtonDisplay();
  }

  setApiKeyConfigured(configured: boolean): void {
    this._apiKeyConfigured = configured;
    this.updateSendButtonDisplay();
  }

  private updateSendButtonDisplay(): void {
    const sendBtn = this.query<HTMLButtonElement>('.send-btn');
    if (!sendBtn) return;

    if (!this._apiKeyConfigured) {
      sendBtn.disabled = true;
      sendBtn.classList.add('disabled');
      sendBtn.title = 'Send: DeepSeek API key not set';
    } else {
      sendBtn.disabled = false;
      sendBtn.classList.remove('disabled');
      sendBtn.title = 'Send message';
    }
  }

  closeFilesModal(): void {
    this._filesModalOpen = false;
    // FilesShadowActor.onClose() sends fileModalClosed
    this.publish({ 'toolbar.filesModalOpen': false });
  }

  isStreaming(): boolean {
    return this._streaming;
  }

  /** Get a button element from the toolbar's shadow DOM (for triggerElement wiring) */
  getButton(selector: string): HTMLElement | null {
    return this.query<HTMLElement>(selector);
  }

  getState(): ToolbarState {
    return {
      editMode: this._editMode,
      webSearchEnabled: this._webSearchEnabled,
      webSearchMode: this._webSearchMode,
      filesModalOpen: this._filesModalOpen,
      planEnabled: this._planEnabled,
      streaming: this._streaming
    };
  }

  // ============================================
  // Lifecycle
  // ============================================

  destroy(): void {
    this._onEditModeChange = null;
    this._onWebSearchToggle = null;
    this._onFilesOpen = null;
    this._onPlan = null;
    this._onSend = null;
    this._onStop = null;
    this._onAttach = null;
    this._onSearch = null;
    this._vscode = null;

    super.destroy();
  }
}
