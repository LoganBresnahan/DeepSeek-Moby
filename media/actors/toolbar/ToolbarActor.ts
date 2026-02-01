/**
 * ToolbarActor
 *
 * Manages the input toolbar buttons (Files, Edit Mode, Help, Search).
 * Wraps existing DOM elements from chatProvider.ts HTML.
 *
 * Features:
 * - Files button: Opens file selection modal
 * - Edit Mode button: Cycles through manual/ask/auto modes
 * - Help button: Opens commands modal
 * - Search button: Toggles web search / opens settings modal
 *
 * Publications:
 * - toolbar.editMode: 'manual' | 'ask' | 'auto'
 * - toolbar.webSearchEnabled: boolean
 * - toolbar.filesModalOpen: boolean
 * - toolbar.commandsModalOpen: boolean
 *
 * Subscriptions:
 * - streaming.active: boolean - disable buttons during streaming
 */

import { EventStateActor } from '../../state/EventStateActor';
import { EventStateManager } from '../../state/EventStateManager';
import type { ActorConfig } from '../../state/types';

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

export interface WebSearchSettings {
  searchesPerPrompt: number;
  searchDepth: 'basic' | 'advanced';
}

interface VSCodeAPI {
  postMessage(message: unknown): void;
}

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

export class ToolbarActor extends EventStateActor {
  // DOM elements
  private _filesBtn: HTMLButtonElement | null = null;
  private _editModeBtn: HTMLButtonElement | null = null;
  private _editModeIcon: SVGElement | null = null;
  private _helpBtn: HTMLButtonElement | null = null;
  private _searchBtn: HTMLButtonElement | null = null;

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

  // Active modals
  private _commandsModal: HTMLElement | null = null;
  private _webSearchModal: HTMLElement | null = null;

  // Handlers
  private _onEditModeChange: EditModeHandler | null = null;
  private _onWebSearchToggle: WebSearchHandler | null = null;
  private _onFilesOpen: FilesHandler | null = null;
  private _onCommand: CommandHandler | null = null;
  private _vscode: VSCodeAPI | null = null;

  // Bound handlers for cleanup
  private _boundOutsideClick: ((e: MouseEvent) => void) | null = null;

  constructor(manager: EventStateManager, element: HTMLElement, vscode?: VSCodeAPI) {
    const config: ActorConfig = {
      manager,
      element,
      publications: {
        'toolbar.editMode': () => this._editMode,
        'toolbar.webSearchEnabled': () => this._webSearchEnabled,
        'toolbar.filesModalOpen': () => this._filesModalOpen,
        'toolbar.commandsModalOpen': () => this._commandsModalOpen
      },
      subscriptions: {
        'streaming.active': (value: unknown) => this.handleStreamingChange(value as boolean)
      },
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

    this._filesBtn = doc.getElementById('filesBtn') as HTMLButtonElement;
    this._editModeBtn = doc.getElementById('editModeBtn') as HTMLButtonElement;
    this._editModeIcon = doc.getElementById('editModeIcon') as unknown as SVGElement;
    this._helpBtn = doc.getElementById('helpBtn') as HTMLButtonElement;
    this._searchBtn = doc.getElementById('searchBtn') as HTMLButtonElement;

    console.log('[ToolbarActor] Bound to elements:', {
      filesBtn: !!this._filesBtn,
      editModeBtn: !!this._editModeBtn,
      helpBtn: !!this._helpBtn,
      searchBtn: !!this._searchBtn
    });
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    // Files button
    if (this._filesBtn) {
      this._filesBtn.addEventListener('click', this.handleFilesClick.bind(this));
    }

    // Edit mode button
    if (this._editModeBtn) {
      this._editModeBtn.addEventListener('click', this.handleEditModeClick.bind(this));
    }

    // Help button
    if (this._helpBtn) {
      this._helpBtn.addEventListener('click', this.handleHelpClick.bind(this));
    }

    // Search button
    if (this._searchBtn) {
      this._searchBtn.addEventListener('click', this.handleSearchClick.bind(this));
    }

    // Global click handler for closing modals
    this._boundOutsideClick = this.handleOutsideClick.bind(this);
    document.addEventListener('click', this._boundOutsideClick);
  }

  // ============================================
  // Subscription Handlers
  // ============================================

  private handleStreamingChange(streaming: boolean): void {
    this._streaming = streaming;
    // Buttons are not disabled during streaming to allow interrupt
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
      // Toggle off
      this._webSearchEnabled = false;
      this._searchBtn?.classList.remove('active');
      this._onWebSearchToggle?.(false);
      this._vscode?.postMessage({ type: 'toggleWebSearch', enabled: false });
    } else {
      // Show settings modal
      this.closeAllModals();
      this.showWebSearchModal();
    }

    this.publish({ 'toolbar.webSearchEnabled': this._webSearchEnabled });
  }

  private handleOutsideClick(e: MouseEvent): void {
    const target = e.target as Element;

    // Close commands modal
    if (this._commandsModal && !target.closest('.commands-modal') && !target.closest('.help-btn')) {
      this.closeCommandsModal();
    }

    // Close web search modal
    if (this._webSearchModal && !target.closest('.web-search-modal') && !target.closest('.search-btn')) {
      this.closeWebSearchModal();
    }
  }

  // ============================================
  // Edit Mode
  // ============================================

  private updateEditModeDisplay(): void {
    if (!this._editModeBtn || !this._editModeIcon) return;

    // Update button class
    this._editModeBtn.classList.remove('state-manual', 'state-ask', 'state-auto');
    if (this._editMode === 'ask') this._editModeBtn.classList.add('state-ask');
    else if (this._editMode === 'auto') this._editModeBtn.classList.add('state-auto');

    // Update tooltip
    this._editModeBtn.title = `Edit mode: ${EDIT_MODE_LABELS[this._editMode]}`;

    // Update icon letter
    const letter = EDIT_MODE_LETTERS[this._editMode];
    this._editModeIcon.innerHTML = `
      <text x="8" y="11" font-size="10" font-weight="bold" text-anchor="middle" fill="currentColor">${letter}</text>
    `;
  }

  // ============================================
  // Commands Modal
  // ============================================

  private showCommandsModal(): void {
    if (!this._helpBtn) return;

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

    // Position above button
    const rect = this._helpBtn.getBoundingClientRect();
    modal.style.bottom = `${window.innerHeight - rect.top + 5}px`;
    modal.style.left = `${rect.left}px`;

    // Close button
    modal.querySelector('.commands-modal-close')?.addEventListener('click', () => {
      this.closeCommandsModal();
    });

    // Command clicks
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
  // Web Search Modal
  // ============================================

  private showWebSearchModal(): void {
    if (!this._searchBtn) return;

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

    // Position above button
    const rect = this._searchBtn.getBoundingClientRect();
    modal.style.bottom = `${window.innerHeight - rect.top + 5}px`;
    modal.style.left = `${rect.left}px`;

    // Close button
    modal.querySelector('.web-search-modal-close')?.addEventListener('click', () => {
      this.closeWebSearchModal();
    });

    // Slider
    modal.querySelector('#searchCountSlider')?.addEventListener('input', (e) => {
      const value = (e.target as HTMLInputElement).value;
      const valueEl = modal.querySelector('#searchCountValue');
      if (valueEl) valueEl.textContent = value;
      this._webSearchSettings.searchesPerPrompt = parseInt(value, 10);
    });

    // Depth buttons
    modal.querySelectorAll('.depth-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        modal.querySelectorAll('.depth-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._webSearchSettings.searchDepth = (btn as HTMLElement).dataset.depth as 'basic' | 'advanced';
      });
    });

    // Enable button
    modal.querySelector('.web-search-enable-btn')?.addEventListener('click', () => {
      this._webSearchEnabled = true;
      this._searchBtn?.classList.add('active');
      this._onWebSearchToggle?.(true, this._webSearchSettings);
      this._vscode?.postMessage({ type: 'toggleWebSearch', enabled: true });
      this._vscode?.postMessage({ type: 'updateWebSearchSettings', settings: this._webSearchSettings });
      this.closeWebSearchModal();

      this.publish({ 'toolbar.webSearchEnabled': true });
    });

    // Clear cache button
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

  /**
   * Set edit mode handler
   */
  onEditModeChange(handler: EditModeHandler): void {
    this._onEditModeChange = handler;
  }

  /**
   * Set web search handler
   */
  onWebSearchToggle(handler: WebSearchHandler): void {
    this._onWebSearchToggle = handler;
  }

  /**
   * Set files open handler
   */
  onFilesOpen(handler: FilesHandler): void {
    this._onFilesOpen = handler;
  }

  /**
   * Set command handler
   */
  onCommand(handler: CommandHandler): void {
    this._onCommand = handler;
  }

  /**
   * Set VS Code API
   */
  setVSCodeAPI(vscode: VSCodeAPI): void {
    this._vscode = vscode;
  }

  /**
   * Set edit mode programmatically
   */
  setEditMode(mode: EditMode): void {
    this._editMode = mode;
    this.updateEditModeDisplay();

    this.publish({ 'toolbar.editMode': mode });
  }

  /**
   * Set web search enabled state
   */
  setWebSearchEnabled(enabled: boolean): void {
    this._webSearchEnabled = enabled;
    this._searchBtn?.classList.toggle('active', enabled);

    this.publish({ 'toolbar.webSearchEnabled': enabled });
  }

  /**
   * Close files modal (called externally when modal closes)
   */
  closeFilesModal(): void {
    this._filesModalOpen = false;
    this._vscode?.postMessage({ type: 'fileModalClosed' });

    this.publish({ 'toolbar.filesModalOpen': false });
  }

  /**
   * Get current state
   */
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

    this._filesBtn = null;
    this._editModeBtn = null;
    this._editModeIcon = null;
    this._helpBtn = null;
    this._searchBtn = null;
    this._onEditModeChange = null;
    this._onWebSearchToggle = null;
    this._onFilesOpen = null;
    this._onCommand = null;
    this._vscode = null;

    super.destroy();
  }
}
