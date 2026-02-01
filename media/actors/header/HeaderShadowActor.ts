/**
 * HeaderShadowActor
 *
 * Shadow DOM version of HeaderActor.
 * Actor OWNS its DOM instead of wrapping existing elements.
 *
 * Features:
 * - Session title (editable)
 * - Model selector dropdown
 * - Action buttons (New Chat, History)
 * - More menu with Export, Clear, Delete actions
 * - Streaming indicator
 *
 * Publications:
 * - header.menuOpen: boolean - whether the menu dropdown is open
 *
 * Subscriptions:
 * - session.title: string - current session title
 * - session.model: string - current model
 * - streaming.active: boolean - streaming state (disable controls)
 */

import { ShadowActor } from '../../state/ShadowActor';
import { EventStateManager } from '../../state/EventStateManager';
import { headerShadowStyles } from './shadowStyles';

export interface HeaderState {
  title: string;
  model: string;
  menuOpen: boolean;
  streaming: boolean;
}

export type HeaderAction =
  | 'newChat'
  | 'clearChat'
  | 'exportChat'
  | 'deleteChat'
  | 'showHistory';

export type ActionHandler = (action: HeaderAction) => void;
export type ModelChangeHandler = (model: string) => void;
export type TitleChangeHandler = (title: string) => void;

export class HeaderShadowActor extends ShadowActor {
  // Internal state
  private _title = 'New Chat';
  private _model = 'deepseek-chat';
  private _menuOpen = false;
  private _streaming = false;
  private _editing = false;

  // Handlers
  private _onAction: ActionHandler | null = null;
  private _onModelChange: ModelChangeHandler | null = null;
  private _onTitleChange: TitleChangeHandler | null = null;

  // DOM elements (cached after render)
  private _titleEl: HTMLElement | null = null;
  private _modelSelect: HTMLSelectElement | null = null;
  private _menuDropdown: HTMLElement | null = null;
  private _streamingIndicator: HTMLElement | null = null;

  // Bound handler for outside clicks
  private _boundCloseMenu: (() => void) | null = null;

  constructor(manager: EventStateManager, element: HTMLElement) {
    super({
      manager,
      element,
      styles: headerShadowStyles,
      publications: {
        'header.menuOpen': () => this._menuOpen
      },
      subscriptions: {
        'session.title': (value: unknown) => this.handleTitleChange(value as string),
        'session.model': (value: unknown) => this.handleModelChange(value as string),
        'streaming.active': (value: unknown) => this.handleStreamingChange(value as boolean)
      }
    });

    // Render the header
    this.renderHeader();

    // Setup outside click handler for menu
    this._boundCloseMenu = () => this.closeMenu();
    document.addEventListener('click', this._boundCloseMenu);
  }

  // ============================================
  // Rendering
  // ============================================

  private renderHeader(): void {
    this.render(`
      <div class="header-container">
        <div class="header-left">
          <span class="title editable" title="Click to rename">${this.escapeHtml(this._title)}</span>
          <div class="model-selector">
            <select class="model-select">
              <option value="deepseek-chat">DeepSeek Chat</option>
              <option value="deepseek-reasoner">DeepSeek Reasoner (R1)</option>
            </select>
          </div>
          <div class="streaming-indicator">
            <span class="streaming-dot"></span>
            <span>Generating...</span>
          </div>
        </div>
        <div class="header-right">
          <button class="btn" title="New Chat" data-action="newChat">➕</button>
          <button class="btn" title="History" data-action="showHistory">📋</button>
          <div class="menu">
            <button class="btn menu-toggle" title="More">⋯</button>
            <div class="menu-dropdown">
              <div class="menu-item" data-action="exportChat">📤 Export Chat</div>
              <div class="menu-item" data-action="clearChat">🗑️ Clear Chat</div>
              <div class="menu-divider"></div>
              <div class="menu-item danger" data-action="deleteChat">❌ Delete Session</div>
            </div>
          </div>
        </div>
      </div>
    `);

    // Cache DOM elements
    this._titleEl = this.query('.title');
    this._modelSelect = this.query('.model-select') as HTMLSelectElement;
    this._menuDropdown = this.query('.menu-dropdown');
    this._streamingIndicator = this.query('.streaming-indicator');

    // Set initial model
    if (this._modelSelect) {
      this._modelSelect.value = this._model;
    }

    // Setup event handlers
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Title click for editing
    this.delegate('click', '.title.editable', () => {
      this.startEditTitle();
    });

    // Model select change
    this.delegate('change', '.model-select', (e) => {
      const select = e.target as HTMLSelectElement;
      this._model = select.value;
      this._onModelChange?.(this._model);
    });

    // Action buttons
    this.delegate('click', '[data-action]', (e) => {
      const action = (e.target as HTMLElement).closest('[data-action]')?.getAttribute('data-action') as HeaderAction;
      if (action && action !== 'menuToggle') {
        this.handleAction(action);
      }
    });

    // Menu toggle (separate to handle stopPropagation)
    this.delegate('click', '.menu-toggle', (e) => {
      e.stopPropagation();
      this.toggleMenu();
    });

    // Prevent menu clicks from closing
    this.delegate('click', '.menu-dropdown', (e) => {
      e.stopPropagation();
    });
  }

  // ============================================
  // Subscription Handlers
  // ============================================

  private handleTitleChange(title: string): void {
    this._title = title || 'New Chat';
    this.updateTitleDisplay();
  }

  private handleModelChange(model: string): void {
    this._model = model;
    if (this._modelSelect && this._modelSelect.value !== model) {
      this._modelSelect.value = model;
    }
  }

  private handleStreamingChange(streaming: boolean): void {
    this._streaming = streaming;
    this.updateDisabledState();
    this.updateStreamingIndicator();
  }

  // ============================================
  // UI Updates
  // ============================================

  private updateTitleDisplay(): void {
    if (this._titleEl && !this._editing) {
      this._titleEl.textContent = this._title;
    }
  }

  private updateDisabledState(): void {
    if (this._modelSelect) {
      this._modelSelect.disabled = this._streaming;
    }

    // Disable action buttons during streaming
    this.queryAll<HTMLButtonElement>('.btn').forEach(btn => {
      btn.disabled = this._streaming;
    });
  }

  private updateStreamingIndicator(): void {
    if (this._streamingIndicator) {
      this._streamingIndicator.classList.toggle('active', this._streaming);
    }
  }

  // ============================================
  // Title Editing
  // ============================================

  private startEditTitle(): void {
    if (this._streaming || this._editing || !this._titleEl) return;

    this._editing = true;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'title-input';
    input.value = this._title;

    // Replace span with input
    this._titleEl.replaceWith(input);

    input.focus();
    input.select();

    // Handle save/cancel
    const save = () => {
      const newTitle = input.value.trim() || 'New Chat';
      this._title = newTitle;
      this._onTitleChange?.(newTitle);

      // Replace input with span
      const span = document.createElement('span');
      span.className = 'title editable';
      span.title = 'Click to rename';
      span.textContent = newTitle;

      input.replaceWith(span);
      this._titleEl = span;
      this._editing = false;
    };

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        input.blur();
      } else if (e.key === 'Escape') {
        input.value = this._title;
        input.blur();
      }
    });
  }

  // ============================================
  // Menu
  // ============================================

  private toggleMenu(): void {
    this._menuOpen = !this._menuOpen;
    this._menuDropdown?.classList.toggle('open', this._menuOpen);

    this.publish({
      'header.menuOpen': this._menuOpen
    });
  }

  private closeMenu(): void {
    if (this._menuOpen) {
      this._menuOpen = false;
      this._menuDropdown?.classList.remove('open');

      this.publish({
        'header.menuOpen': false
      });
    }
  }

  // ============================================
  // Actions
  // ============================================

  private handleAction(action: HeaderAction): void {
    this.closeMenu();

    if (this._streaming) return;

    this._onAction?.(action);
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Set action handler
   */
  onAction(handler: ActionHandler): void {
    this._onAction = handler;
  }

  /**
   * Set model change handler
   */
  onModelChange(handler: ModelChangeHandler): void {
    this._onModelChange = handler;
  }

  /**
   * Set title change handler
   */
  onTitleChange(handler: TitleChangeHandler): void {
    this._onTitleChange = handler;
  }

  /**
   * Set title programmatically
   */
  setTitle(title: string): void {
    this._title = title || 'New Chat';
    this.updateTitleDisplay();
  }

  /**
   * Set model programmatically
   */
  setModel(model: string): void {
    this._model = model;
    if (this._modelSelect) {
      this._modelSelect.value = model;
    }
  }

  /**
   * Escape HTML
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Get current state
   */
  getState(): HeaderState {
    return {
      title: this._title,
      model: this._model,
      menuOpen: this._menuOpen,
      streaming: this._streaming
    };
  }

  // ============================================
  // Lifecycle
  // ============================================

  destroy(): void {
    // Remove document listener
    if (this._boundCloseMenu) {
      document.removeEventListener('click', this._boundCloseMenu);
    }

    this._titleEl = null;
    this._modelSelect = null;
    this._menuDropdown = null;
    this._streamingIndicator = null;
    this._onAction = null;
    this._onModelChange = null;
    this._onTitleChange = null;

    super.destroy();
  }
}
