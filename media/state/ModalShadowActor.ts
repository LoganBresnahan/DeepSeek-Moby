/**
 * ModalShadowActor
 *
 * Base class for modal actors that display centered overlays with
 * backdrop blur, animations, and standard modal behavior.
 *
 * Features:
 * - Backdrop with blur effect
 * - Slide-up animation on open
 * - Escape key to close
 * - Backdrop click to close
 * - Focus management
 * - Standard open/close pub/sub pattern
 *
 * Extending classes must implement:
 * - renderModalContent(): string - Returns the modal body HTML
 * - setupModalEvents(): void - Binds modal-specific event handlers
 *
 * CSS Structure:
 *   .modal-backdrop (full-screen blur overlay)
 *     .modal-container (centered modal box)
 *       .modal-header
 *         .modal-title
 *         .modal-close
 *       .modal-body
 *         [custom content from renderModalContent()]
 *       .modal-footer (optional)
 *
 * @see ShadowActor
 */

import { ShadowActor, ShadowActorConfig } from './ShadowActor';
import { EventStateManager } from './EventStateManager';
import type { PublicationMap, SubscriptionMap, VSCodeAPI } from './types';

// ============================================
// Base Modal Styles (shared by all modals)
// ============================================

export const modalBaseStyles = `
  /* Modal backdrop - full-screen blur overlay */
  .modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    opacity: 0;
    visibility: hidden;
    transition: opacity 0.2s ease, visibility 0.2s ease;
  }

  .modal-backdrop.visible {
    opacity: 1;
    visibility: visible;
  }

  /* Modal container - centered box */
  .modal-container {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, #454545));
    border-radius: 8px;
    width: 90%;
    max-width: 600px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    overflow: hidden;
    transform: translateY(-20px);
    opacity: 0;
    transition: transform 0.2s ease, opacity 0.2s ease;
  }

  .modal-backdrop.visible .modal-container {
    transform: translateY(0);
    opacity: 1;
  }

  /* Modal header */
  .modal-header {
    padding: 16px;
    border-bottom: 1px solid var(--vscode-panel-border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-shrink: 0;
  }

  .modal-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    font-size: 14px;
  }

  .modal-title-icon {
    font-size: 16px;
  }

  .modal-close {
    background: none;
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    padding: 4px 8px;
    font-size: 16px;
    opacity: 0.7;
    border-radius: 4px;
    transition: opacity 0.15s, background-color 0.15s;
  }

  .modal-close:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground);
  }

  /* Modal body */
  .modal-body {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }

  /* Modal footer (optional) */
  .modal-footer {
    padding: 12px 16px;
    border-top: 1px solid var(--vscode-panel-border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-shrink: 0;
  }

  /* Search input (common in modals) */
  .modal-search {
    padding: 12px 16px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }

  .modal-search-input {
    width: 100%;
    padding: 8px 12px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, #3c3c3c));
    border-radius: 4px;
    color: var(--vscode-input-foreground);
    font-size: 13px;
    outline: none;
    transition: border-color 0.15s;
  }

  .modal-search-input:focus {
    border-color: var(--vscode-focusBorder, #007acc);
  }

  .modal-search-input::placeholder {
    color: var(--vscode-input-placeholderForeground);
  }

  /* Common button styles */
  .modal-btn {
    padding: 6px 12px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    transition: background-color 0.15s, opacity 0.15s;
  }

  .modal-btn-primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
  }

  .modal-btn-primary:hover {
    background: var(--vscode-button-hoverBackground);
  }

  .modal-btn-secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
  }

  .modal-btn-secondary:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .modal-btn-danger {
    background: transparent;
    color: var(--vscode-errorForeground, #f48771);
    border: 1px solid var(--vscode-errorForeground, #f48771);
  }

  .modal-btn-danger:hover {
    background: var(--vscode-errorForeground, #f48771);
    color: var(--vscode-editor-background);
  }

  /* Empty state */
  .modal-empty {
    padding: 32px 16px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
  }

  /* Loading state */
  .modal-loading {
    padding: 32px 16px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
  }

  .modal-loading::after {
    content: '';
    display: inline-block;
    width: 16px;
    height: 16px;
    margin-left: 8px;
    border: 2px solid var(--vscode-foreground);
    border-top-color: transparent;
    border-radius: 50%;
    animation: modal-spin 0.8s linear infinite;
  }

  @keyframes modal-spin {
    to { transform: rotate(360deg); }
  }
`;

// ============================================
// Configuration
// ============================================

export interface ModalConfig {
  manager: EventStateManager;
  element: HTMLElement;
  vscode: VSCodeAPI;

  /** Modal title text */
  title: string;

  /** Icon for the title (emoji or text) */
  titleIcon?: string;

  /** Search placeholder text (if modal has search) */
  searchPlaceholder?: string;

  /** Whether the modal has a search bar */
  hasSearch?: boolean;

  /** Whether the modal has a footer */
  hasFooter?: boolean;

  /** Custom max-width for the modal */
  maxWidth?: string;

  /** Custom max-height for the modal */
  maxHeight?: string;

  /** Publications specific to this modal */
  publications: PublicationMap;

  /** Subscriptions specific to this modal */
  subscriptions: SubscriptionMap;

  /** Additional styles for this modal */
  additionalStyles?: string;

  /** The open request key to subscribe to (e.g., 'files.modal.open') */
  openRequestKey: string;

  /** The visible state key to publish (e.g., 'files.modal.visible') */
  visibleStateKey: string;
}

// ============================================
// ModalShadowActor Base Class
// ============================================

export abstract class ModalShadowActor extends ShadowActor {
  protected _visible = false;
  protected _vscode: VSCodeAPI;
  protected _config: ModalConfig;

  // Bound handlers for cleanup
  private _boundHandleKeydown: (e: KeyboardEvent) => void;
  private _boundHandleOutsideClick: (e: MouseEvent) => void;

  constructor(config: ModalConfig) {
    // Build combined styles
    const combinedStyles = modalBaseStyles + (config.additionalStyles || '');

    // Build combined publications (add visible state)
    const publications: PublicationMap = {
      ...config.publications,
      [config.visibleStateKey]: () => this._visible
    };

    // Build combined subscriptions (add open request handler)
    const subscriptions: SubscriptionMap = {
      ...config.subscriptions,
      [config.openRequestKey]: (value: unknown) => this.handleOpenRequest(value as boolean)
    };

    // Build shadow actor config
    const shadowConfig: ShadowActorConfig = {
      manager: config.manager,
      element: config.element,
      styles: combinedStyles,
      publications,
      subscriptions
    };

    super(shadowConfig);

    this._vscode = config.vscode;
    this._config = config;

    // Bind handlers
    this._boundHandleKeydown = this.handleKeydown.bind(this);
    this._boundHandleOutsideClick = this.handleOutsideClick.bind(this);

    // Render initial structure
    this.renderModalStructure();
    this.setupBaseEvents();
    this.setupModalEvents();
  }

  // ============================================
  // Abstract Methods (must be implemented)
  // ============================================

  /**
   * Render the modal body content.
   * Called after the modal structure is created.
   */
  protected abstract renderModalContent(): string;

  /**
   * Set up modal-specific event handlers.
   * Called once during construction.
   */
  protected abstract setupModalEvents(): void;

  /**
   * Called when the modal opens (optional override).
   */
  protected onOpen(): void {
    // Override in subclass if needed
  }

  /**
   * Called when the modal closes (optional override).
   */
  protected onClose(): void {
    // Override in subclass if needed
  }

  // ============================================
  // Rendering
  // ============================================

  private renderModalStructure(): void {
    const { title, titleIcon, hasSearch, searchPlaceholder, hasFooter, maxWidth, maxHeight } = this._config;

    const containerStyle = [
      maxWidth ? `max-width: ${maxWidth};` : '',
      maxHeight ? `max-height: ${maxHeight};` : ''
    ].filter(Boolean).join(' ');

    this.render(`
      <div class="modal-backdrop" data-modal-backdrop>
        <div class="modal-container" ${containerStyle ? `style="${containerStyle}"` : ''} data-modal-container>
          <div class="modal-header">
            <div class="modal-title">
              ${titleIcon ? `<span class="modal-title-icon">${titleIcon}</span>` : ''}
              <span>${this.escapeHtml(title)}</span>
            </div>
            <button class="modal-close" data-action="close" title="Close (Esc)">✕</button>
          </div>
          ${hasSearch ? `
            <div class="modal-search">
              <input
                type="text"
                class="modal-search-input"
                placeholder="${this.escapeHtml(searchPlaceholder || 'Search...')}"
                data-search-input
              />
            </div>
          ` : ''}
          <div class="modal-body" data-modal-body>
            ${this.renderModalContent()}
          </div>
          ${hasFooter ? `
            <div class="modal-footer" data-modal-footer>
              ${this.renderFooterContent()}
            </div>
          ` : ''}
        </div>
      </div>
    `);
  }

  /**
   * Override to provide footer content.
   */
  protected renderFooterContent(): string {
    return '';
  }

  /**
   * Update the modal body content.
   */
  protected updateBodyContent(html: string): void {
    const body = this.query<HTMLElement>('[data-modal-body]');
    if (body) {
      body.innerHTML = html;
    }
  }

  /**
   * Update the footer content.
   */
  protected updateFooterContent(html: string): void {
    const footer = this.query<HTMLElement>('[data-modal-footer]');
    if (footer) {
      footer.innerHTML = html;
    }
  }

  // ============================================
  // Event Handling
  // ============================================

  private setupBaseEvents(): void {
    // Close button
    this.delegate('click', '[data-action="close"]', () => {
      this.close();
    });

    // Backdrop click
    this.delegate('click', '[data-modal-backdrop]', (e) => {
      if ((e.target as HTMLElement).hasAttribute('data-modal-backdrop')) {
        this.close();
      }
    });

    // Search input (if present)
    this.delegate('input', '[data-search-input]', (e) => {
      const value = (e.target as HTMLInputElement).value;
      this.handleSearch(value);
    });
  }

  /**
   * Override to handle search input.
   */
  protected handleSearch(query: string): void {
    // Override in subclass if modal has search
  }

  private handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      this.handleEscapeKey();
    }
  }

  /**
   * Override to customize Escape key behavior.
   * Default: close the modal.
   */
  protected handleEscapeKey(): void {
    this.close();
  }

  private handleOutsideClick(e: MouseEvent): void {
    // Can be overridden by subclasses for dropdown menus, etc.
    this.handleDocumentClick(e);
  }

  /**
   * Override to handle document clicks (for closing dropdowns, etc.).
   */
  protected handleDocumentClick(e: MouseEvent): void {
    // Override in subclass if needed
  }

  private handleOpenRequest(open: boolean): void {
    if (open) {
      this.open();
    } else {
      this.close();
    }
  }

  // ============================================
  // Modal Control
  // ============================================

  open(): void {
    if (this._visible) return;

    this._visible = true;

    // Update UI
    const backdrop = this.query<HTMLElement>('[data-modal-backdrop]');
    if (backdrop) {
      backdrop.classList.add('visible');
    }

    // Clear and focus search if present
    const searchInput = this.query<HTMLInputElement>('[data-search-input]');
    if (searchInput) {
      searchInput.value = '';
      // Focus after animation
      setTimeout(() => searchInput.focus(), 200);
    }

    // Add event listeners
    document.addEventListener('keydown', this._boundHandleKeydown);
    document.addEventListener('click', this._boundHandleOutsideClick);

    // Call subclass hook
    this.onOpen();

    // Publish state
    this.publish({ [this._config.visibleStateKey]: true });
  }

  close(): void {
    if (!this._visible) return;

    this._visible = false;

    // Update UI
    const backdrop = this.query<HTMLElement>('[data-modal-backdrop]');
    if (backdrop) {
      backdrop.classList.remove('visible');
    }

    // Remove event listeners
    document.removeEventListener('keydown', this._boundHandleKeydown);
    document.removeEventListener('click', this._boundHandleOutsideClick);

    // Call subclass hook
    this.onClose();

    // Publish state
    this.publish({ [this._config.visibleStateKey]: false });

    // Reset the request state so the next open request triggers a change
    this.manager.publishDirect(this._config.openRequestKey, false, this.actorId);
  }

  // ============================================
  // Utilities
  // ============================================

  protected escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  isVisible(): boolean {
    return this._visible;
  }

  // ============================================
  // Lifecycle
  // ============================================

  destroy(): void {
    document.removeEventListener('keydown', this._boundHandleKeydown);
    document.removeEventListener('click', this._boundHandleOutsideClick);
    super.destroy();
  }
}
