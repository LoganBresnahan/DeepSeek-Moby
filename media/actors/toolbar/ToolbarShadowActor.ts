/**
 * ToolbarShadowActor
 *
 * Shadow DOM toolbar with unified 3x2 button grid:
 * - Row 1: Files, Edit Mode
 * - Row 2: Help, Attach
 * - Row 3: Search, Send/Stop
 *
 * Publications:
 * - toolbar.editMode: 'manual' | 'ask' | 'auto'
 * - toolbar.webSearchEnabled: boolean
 * - toolbar.filesModalOpen: boolean
 * - toolbar.commandsModalOpen: boolean
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
  commandsModalOpen: boolean;
  streaming: boolean;
}

export type EditModeHandler = (mode: EditMode) => void;
export type WebSearchHandler = (enabled: boolean, settings?: WebSearchSettings) => void;
export type FilesHandler = () => void;
export type CommandHandler = (command: string) => void;
export type SendHandler = () => void;
export type StopHandler = () => void;
export type AttachHandler = () => void;

export interface WebSearchSettings {
  searchesPerPrompt: number;
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
  help: `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 13A6 6 0 1 1 8 2a6 6 0 0 1 0 12zm-.5-3h1v1h-1v-1zm.5-7a2.5 2.5 0 0 0-2.5 2.5h1A1.5 1.5 0 1 1 8 8c-.55 0-1 .45-1 1v1h1v-.8c0-.11.09-.2.2-.2h.3a2.5 2.5 0 0 0 0-5z"/>
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
  private _commandsModalOpen = false;
  private _streaming = false;

  // Web search settings
  private _webSearchSettings: WebSearchSettings = {
    searchesPerPrompt: 3,
    searchDepth: 'basic'
  };

  // Command definitions
  private _commands = [
    { section: 'Chat' },
    { id: 'newChat', name: 'New Chat', desc: 'Start a new conversation', icon: '✨' },
    { section: 'History' },
    { id: 'showChatHistory', name: 'Show History', desc: 'View chat history', icon: '📚' },
    { id: 'exportChatHistory', name: 'Export History', desc: 'Export all chats', icon: '📤' },
    { id: 'searchChatHistory', name: 'Search History', desc: 'Search past chats', icon: '🔍' },
    { section: 'Other' },
    { id: 'showStats', name: 'Show Stats', desc: 'View usage statistics', icon: '📊' },
    { id: 'showLogs', name: 'Show Logs', desc: 'View extension logs', icon: '📋' }
  ] as const;

  // Modals (rendered in document.body, outside shadow DOM)
  private _commandsModal: HTMLElement | null = null;
  private _webSearchModal: HTMLElement | null = null;

  // Handlers
  private _onEditModeChange: EditModeHandler | null = null;
  private _onWebSearchToggle: WebSearchHandler | null = null;
  private _onFilesOpen: FilesHandler | null = null;
  private _onCommand: CommandHandler | null = null;
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
        'toolbar.commandsModalOpen': () => this._commandsModalOpen
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
    this.render(`
      <div class="toolbar">
        <button class="btn files-btn" title="Select files for context">
          ${ICONS.files}
        </button>
        <button class="btn edit-mode-btn" title="Edit mode: Manual">
          ${ICONS.edit}
        </button>
        <button class="btn help-btn" title="Commands">
          ${ICONS.help}
        </button>
        <button class="btn attach-btn" title="Attach file">
          ${ICONS.attach}
        </button>
        <button class="btn search-btn" title="Web search">
          ${ICONS.search}
        </button>
        <button class="btn send-btn" title="Send message">
          ${ICONS.send}
        </button>
        <button class="btn stop-btn" title="Stop generation" style="display: none;">
          ${ICONS.stop}
        </button>
      </div>
    `);
  }

  private setupEventHandlers(): void {
    this.delegate('click', '.files-btn', (e) => this.handleFilesClick(e));
    this.delegate('click', '.edit-mode-btn', () => this.handleEditModeClick());
    this.delegate('click', '.help-btn', (e) => this.handleHelpClick(e));
    this.delegate('click', '.search-btn', (e) => this.handleSearchClick(e));
    this.delegate('click', '.attach-btn', () => this.handleAttachClick());
    this.delegate('click', '.send-btn', () => this.handleSendClick());
    this.delegate('click', '.stop-btn', () => this.handleStopClick());
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
    this._vscode?.postMessage({ type: 'getOpenFiles' });
    this._vscode?.postMessage({ type: 'fileModalOpened' });
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

  private handleHelpClick(e: Event): void {
    e.stopPropagation();
    this.closeAllModals();
    this.showCommandsModal();
  }

  private handleSearchClick(e: Event): void {
    e.stopPropagation();

    if (this._webSearchEnabled) {
      this._webSearchEnabled = false;
      this.query<HTMLButtonElement>('.search-btn')?.classList.remove('active');
      this._onWebSearchToggle?.(false);
      this._vscode?.postMessage({ type: 'toggleWebSearch', enabled: false });
    } else {
      this.closeAllModals();
      this.showWebSearchModal();
    }

    this.publish({ 'toolbar.webSearchEnabled': this._webSearchEnabled });
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

    if (this._commandsModal && !target.closest('.commands-modal') && !this.isInsideShadow(target, '.help-btn')) {
      this.closeCommandsModal();
    }

    if (this._webSearchModal && !target.closest('.web-search-modal') && !this.isInsideShadow(target, '.search-btn')) {
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
  // Commands Modal (in document.body)
  // ============================================

  private showCommandsModal(): void {
    const helpBtn = this.query<HTMLButtonElement>('.help-btn');
    if (!helpBtn) return;

    const modal = document.createElement('div');
    modal.className = 'commands-modal';
    modal.innerHTML = `
      <div class="commands-modal-title">
        <span>Commands</span>
        <button class="commands-modal-close">×</button>
      </div>
      <div class="commands-list">
        ${this._commands.map(cmd => {
          if ('section' in cmd && !('id' in cmd)) {
            return `<div class="commands-section-title">${cmd.section}</div>`;
          }
          const c = cmd as { id: string; name: string; desc: string; icon: string };
          return `
            <div class="command-item" data-command="${c.id}">
              <span class="command-icon">${c.icon}</span>
              <div class="command-info">
                <div class="command-name">${c.name}</div>
                <div class="command-desc">${c.desc}</div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    // Position relative to the host element (not the shadow button)
    const rect = this.element.getBoundingClientRect();
    modal.style.bottom = `${window.innerHeight - rect.top + 5}px`;
    modal.style.left = `${rect.left}px`;

    modal.querySelector('.commands-modal-close')?.addEventListener('click', () => {
      this.closeCommandsModal();
    });

    modal.querySelectorAll('.command-item').forEach(item => {
      item.addEventListener('click', () => {
        const commandId = (item as HTMLElement).dataset.command;
        if (commandId) {
          this._onCommand?.(commandId);
          this._vscode?.postMessage({ type: 'executeCommand', command: `deepseek.${commandId}` });
          this.closeCommandsModal();
        }
      });
    });

    document.body.appendChild(modal);
    this._commandsModal = modal;
    this._commandsModalOpen = true;
    this.publish({ 'toolbar.commandsModalOpen': true });
  }

  private closeCommandsModal(): void {
    if (this._commandsModal) {
      this._commandsModal.remove();
      this._commandsModal = null;
    }
    this._commandsModalOpen = false;
    this.publish({ 'toolbar.commandsModalOpen': false });
  }

  // ============================================
  // Web Search Modal (in document.body)
  // ============================================

  private showWebSearchModal(): void {
    const searchBtn = this.query<HTMLButtonElement>('.search-btn');
    if (!searchBtn) return;

    const modal = document.createElement('div');
    modal.className = 'web-search-modal';
    modal.innerHTML = `
      <div class="web-search-modal-title">
        <span>Web Search Settings</span>
        <button class="web-search-modal-close">&times;</button>
      </div>
      <div class="web-search-modal-content">
        <div class="web-search-option">
          <label>Searches per prompt: <span id="searchCountValue">${this._webSearchSettings.searchesPerPrompt}</span></label>
          <input type="range" id="searchCountSlider" min="1" max="20" step="1" value="${this._webSearchSettings.searchesPerPrompt}">
        </div>
        <div class="web-search-option">
          <label>Search depth:</label>
          <div class="search-depth-options">
            <button class="depth-btn ${this._webSearchSettings.searchDepth === 'basic' ? 'active' : ''}" data-depth="basic">
              <span class="depth-name">Basic</span>
              <span class="depth-credits">1 credit</span>
            </button>
            <button class="depth-btn ${this._webSearchSettings.searchDepth === 'advanced' ? 'active' : ''}" data-depth="advanced">
              <span class="depth-name">Advanced</span>
              <span class="depth-credits">2 credits</span>
            </button>
          </div>
        </div>
        <button class="web-search-enable-btn">Enable Web Search</button>
        <button class="web-search-clear-cache-btn">Clear Cache</button>
      </div>
    `;

    const rect = this.element.getBoundingClientRect();
    modal.style.bottom = `${window.innerHeight - rect.top + 5}px`;
    modal.style.left = `${rect.left}px`;

    modal.querySelector('.web-search-modal-close')?.addEventListener('click', () => {
      this.closeWebSearchModal();
    });

    modal.querySelector('#searchCountSlider')?.addEventListener('input', (e) => {
      const value = (e.target as HTMLInputElement).value;
      const valueEl = modal.querySelector('#searchCountValue');
      if (valueEl) valueEl.textContent = value;
      this._webSearchSettings.searchesPerPrompt = parseInt(value, 10);
    });

    modal.querySelectorAll('.depth-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        modal.querySelectorAll('.depth-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._webSearchSettings.searchDepth = (btn as HTMLElement).dataset.depth as 'basic' | 'advanced';
      });
    });

    modal.querySelector('.web-search-enable-btn')?.addEventListener('click', () => {
      this._webSearchEnabled = true;
      this.query<HTMLButtonElement>('.search-btn')?.classList.add('active');
      this._onWebSearchToggle?.(true, this._webSearchSettings);
      this._vscode?.postMessage({ type: 'toggleWebSearch', enabled: true });
      this._vscode?.postMessage({ type: 'updateWebSearchSettings', settings: this._webSearchSettings });
      this.closeWebSearchModal();
      this.publish({ 'toolbar.webSearchEnabled': true });
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
    this.closeCommandsModal();
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

  onCommand(handler: CommandHandler): void {
    this._onCommand = handler;
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
    this._vscode?.postMessage({ type: 'fileModalClosed' });
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
      commandsModalOpen: this._commandsModalOpen,
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
    this._onCommand = null;
    this._onSend = null;
    this._onStop = null;
    this._onAttach = null;
    this._vscode = null;

    super.destroy();
  }
}
