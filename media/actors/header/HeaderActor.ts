/**
 * HeaderActor
 *
 * Handles the chat header with model selector, session title, and controls.
 *
 * Publications:
 * - header.menuOpen: boolean - whether the menu dropdown is open
 *
 * Subscriptions:
 * - session.title: string - current session title
 * - session.model: string - current model
 * - streaming.active: boolean - streaming state (disable controls)
 */

import { EventStateActor } from '../../state/EventStateActor';
import { EventStateManager } from '../../state/EventStateManager';
import type { ActorConfig } from '../../state/types';
import { headerStyles as styles } from './styles';

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

export class HeaderActor extends EventStateActor {
  private static stylesInjected = false;

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

  // DOM elements
  private _titleEl: HTMLElement | null = null;
  private _modelSelect: HTMLSelectElement | null = null;
  private _menuDropdown: HTMLElement | null = null;

  constructor(manager: EventStateManager, element: HTMLElement) {
    const config: ActorConfig = {
      manager,
      element,
      publications: {
        'header.menuOpen': () => this._menuOpen
      },
      subscriptions: {
        'session.title': (value: unknown) => this.handleTitleChange(value as string),
        'session.model': (value: unknown) => this.handleModelChange(value as string),
        'streaming.active': (value: unknown) => this.handleStreamingChange(value as boolean)
      },
      enableDOMChangeDetection: false
    };

    super(config);
    this.injectStyles();
    this.setupDOM();
    this.bindEvents();
  }

  /**
   * Inject CSS styles (once per class)
   */
  private injectStyles(): void {
    if (HeaderActor.stylesInjected) return;
    if (typeof document === 'undefined') return;

    const style = document.createElement('style');
    style.setAttribute('data-actor', 'header');
    style.textContent = styles;
    document.head.appendChild(style);
    HeaderActor.stylesInjected = true;
  }

  /**
   * Setup DOM structure
   */
  private setupDOM(): void {
    const element = this.getElement();
    element.className = 'header-container';

    element.innerHTML = `
      <div class="header-left">
        <span class="header-title editable" title="Click to rename">${this.escapeHtml(this._title)}</span>
        <div class="header-model-selector">
          <select class="header-model-select">
            <option value="deepseek-chat">DeepSeek Chat</option>
            <option value="deepseek-reasoner">DeepSeek Reasoner (R1)</option>
          </select>
        </div>
      </div>
      <div class="header-right">
        <button class="header-button" title="New Chat" data-action="newChat">➕</button>
        <button class="header-button" title="History" data-action="showHistory">📋</button>
        <div class="header-menu">
          <button class="header-button header-menu-toggle" title="More">⋯</button>
          <div class="header-menu-dropdown">
            <div class="header-menu-item" data-action="exportChat">📤 Export Chat</div>
            <div class="header-menu-item" data-action="clearChat">🗑️ Clear Chat</div>
            <div class="header-menu-divider"></div>
            <div class="header-menu-item danger" data-action="deleteChat">❌ Delete Session</div>
          </div>
        </div>
      </div>
    `;

    this._titleEl = element.querySelector('.header-title');
    this._modelSelect = element.querySelector('.header-model-select');
    this._menuDropdown = element.querySelector('.header-menu-dropdown');

    // Set initial model
    if (this._modelSelect) {
      this._modelSelect.value = this._model;
    }
  }

  /**
   * Bind event handlers
   */
  private bindEvents(): void {
    const element = this.getElement();

    // Title click for editing
    this._titleEl?.addEventListener('click', () => this.startEditTitle());

    // Model select
    this._modelSelect?.addEventListener('change', (e) => {
      const select = e.target as HTMLSelectElement;
      this._model = select.value;
      this._onModelChange?.(this._model);
    });

    // Action buttons
    element.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = (e.currentTarget as HTMLElement).getAttribute('data-action') as HeaderAction;
        if (action) {
          this.handleAction(action);
        }
      });
    });

    // Menu toggle
    element.querySelector('.header-menu-toggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMenu();
    });

    // Close menu on outside click
    document.addEventListener('click', () => this.closeMenu());
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
    this.getElement().querySelectorAll('.header-button').forEach(btn => {
      (btn as HTMLButtonElement).disabled = this._streaming;
    });
  }

  // ============================================
  // Title Editing
  // ============================================

  private startEditTitle(): void {
    if (this._streaming || this._editing || !this._titleEl) return;

    this._editing = true;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'header-title-input';
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
      span.className = 'header-title editable';
      span.title = 'Click to rename';
      span.textContent = newTitle;
      span.addEventListener('click', () => this.startEditTitle());

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

  /**
   * Destroy and cleanup
   */
  destroy(): void {
    this._titleEl = null;
    this._modelSelect = null;
    this._menuDropdown = null;
    this._onAction = null;
    this._onModelChange = null;
    this._onTitleChange = null;
    super.destroy();
  }

  /**
   * Reset styles injection flag and remove style tag (for testing)
   */
  static resetStylesInjected(): void {
    HeaderActor.stylesInjected = false;
    if (typeof document !== 'undefined') {
      const styleTag = document.querySelector('style[data-actor="header"]');
      if (styleTag) {
        styleTag.remove();
      }
    }
  }
}
