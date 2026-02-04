/**
 * PopupShadowActor
 *
 * Base class for popup/dropdown actors that display contextual menus
 * near a trigger element without a backdrop overlay.
 *
 * Features:
 * - Appears near trigger element
 * - Click outside to close
 * - Escape key to close
 * - Animation on open/close
 * - Multiple popups can coexist (but only one of each type visible)
 *
 * Differences from ModalShadowActor:
 * - No backdrop blur
 * - Not centered - positioned near trigger
 * - Smaller, contextual UI
 * - Other content remains interactive
 *
 * CSS Structure:
 *   .popup-container (positioned dropdown box)
 *     .popup-header (optional)
 *     .popup-body
 *       [custom content from renderPopupContent()]
 *
 * @see ShadowActor
 */

import { ShadowActor, ShadowActorConfig } from './ShadowActor';
import { EventStateManager } from './EventStateManager';
import type { PublicationMap, SubscriptionMap, VSCodeAPI } from './types';

// ============================================
// Base Popup Styles (shared by all popups)
// ============================================

export const popupBaseStyles = `
  /* Host element */
  :host {
    position: relative;
  }

  /* Popup container */
  .popup-container {
    position: absolute;
    top: 100%;
    left: 0;
    margin-top: 4px;
    background: var(--vscode-dropdown-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-widget-border, #454545));
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    min-width: 200px;
    max-height: 400px;
    overflow: hidden;
    z-index: 9000;
    opacity: 0;
    visibility: hidden;
    transform: translateY(-8px);
    transition: opacity 0.15s ease, visibility 0.15s ease, transform 0.15s ease;
  }

  .popup-container.visible {
    opacity: 1;
    visibility: visible;
    transform: translateY(0);
  }

  /* Position variants */
  .popup-container.position-right {
    left: auto;
    right: 0;
  }

  .popup-container.position-top {
    top: auto;
    bottom: 100%;
    margin-top: 0;
    margin-bottom: 4px;
  }

  /* Popup header (optional) */
  .popup-header {
    padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    letter-spacing: 0.5px;
  }

  /* Popup body */
  .popup-body {
    overflow-y: auto;
    max-height: 350px;
  }

  /* Common item styles */
  .popup-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    cursor: pointer;
    font-size: 13px;
    color: var(--vscode-foreground);
    transition: background-color 0.1s;
  }

  .popup-item:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .popup-item.active {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }

  .popup-item.disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .popup-item-icon {
    font-size: 14px;
    width: 20px;
    text-align: center;
  }

  .popup-item-label {
    flex: 1;
  }

  .popup-item-shortcut {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    opacity: 0.7;
  }

  /* Divider */
  .popup-divider {
    height: 1px;
    background: var(--vscode-panel-border);
    margin: 4px 0;
  }

  /* Section headers */
  .popup-section-header {
    padding: 6px 12px 4px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    letter-spacing: 0.5px;
  }

  /* Form controls in popups */
  .popup-form-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    gap: 12px;
  }

  .popup-form-label {
    font-size: 13px;
    color: var(--vscode-foreground);
  }

  .popup-form-value {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    min-width: 40px;
    text-align: right;
  }

  .popup-slider {
    flex: 1;
    max-width: 120px;
    height: 4px;
    -webkit-appearance: none;
    appearance: none;
    background: var(--vscode-scrollbarSlider-background);
    border-radius: 2px;
    cursor: pointer;
  }

  .popup-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--vscode-button-background);
    cursor: pointer;
  }

  .popup-select {
    padding: 4px 8px;
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-widget-border));
    border-radius: 4px;
    color: var(--vscode-dropdown-foreground);
    font-size: 12px;
    cursor: pointer;
  }

  .popup-checkbox {
    width: 16px;
    height: 16px;
    cursor: pointer;
  }

  .popup-textarea {
    width: 100%;
    min-height: 80px;
    padding: 8px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
    border-radius: 4px;
    color: var(--vscode-input-foreground);
    font-size: 12px;
    font-family: inherit;
    resize: vertical;
  }

  .popup-textarea:focus {
    outline: none;
    border-color: var(--vscode-focusBorder);
  }

  .popup-btn {
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 11px;
    cursor: pointer;
    transition: background-color 0.15s;
  }

  .popup-btn-primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
  }

  .popup-btn-primary:hover {
    background: var(--vscode-button-hoverBackground);
  }

  .popup-btn-secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
  }

  .popup-btn-secondary:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }
`;

// ============================================
// Configuration
// ============================================

export type PopupPosition = 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';

export interface PopupConfig {
  manager: EventStateManager;
  element: HTMLElement;
  vscode: VSCodeAPI;

  /** Popup header text (optional) */
  header?: string;

  /** Position relative to trigger */
  position?: PopupPosition;

  /** Custom width */
  width?: string;

  /** Custom max-height */
  maxHeight?: string;

  /** Publications specific to this popup */
  publications: PublicationMap;

  /** Subscriptions specific to this popup */
  subscriptions: SubscriptionMap;

  /** Additional styles for this popup */
  additionalStyles?: string;

  /** The open request key to subscribe to (e.g., 'commands.popup.open') */
  openRequestKey: string;

  /** The visible state key to publish (e.g., 'commands.popup.visible') */
  visibleStateKey: string;
}

// ============================================
// PopupShadowActor Base Class
// ============================================

export abstract class PopupShadowActor extends ShadowActor {
  protected _visible = false;
  protected _vscode: VSCodeAPI;
  protected _config: PopupConfig;

  // Bound handlers for cleanup
  private _boundHandleKeydown: (e: KeyboardEvent) => void;
  private _boundHandleOutsideClick: (e: MouseEvent) => void;

  constructor(config: PopupConfig) {
    // Build combined styles
    const combinedStyles = popupBaseStyles + (config.additionalStyles || '');

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
    this.renderPopupStructure();
    this.setupBaseEvents();
    this.setupPopupEvents();
  }

  // ============================================
  // Abstract Methods (must be implemented)
  // ============================================

  /**
   * Render the popup body content.
   */
  protected abstract renderPopupContent(): string;

  /**
   * Set up popup-specific event handlers.
   */
  protected abstract setupPopupEvents(): void;

  /**
   * Called when the popup opens (optional override).
   */
  protected onOpen(): void {
    // Override in subclass if needed
  }

  /**
   * Called when the popup closes (optional override).
   */
  protected onClose(): void {
    // Override in subclass if needed
  }

  // ============================================
  // Rendering
  // ============================================

  private renderPopupStructure(): void {
    const { header, position, width, maxHeight } = this._config;

    const positionClasses = this.getPositionClasses(position);
    const containerStyle = [
      width ? `width: ${width};` : '',
      maxHeight ? `max-height: ${maxHeight};` : ''
    ].filter(Boolean).join(' ');

    this.render(`
      <div class="popup-container ${positionClasses}" ${containerStyle ? `style="${containerStyle}"` : ''} data-popup-container>
        ${header ? `<div class="popup-header">${this.escapeHtml(header)}</div>` : ''}
        <div class="popup-body" data-popup-body>
          ${this.renderPopupContent()}
        </div>
      </div>
    `);
  }

  private getPositionClasses(position?: PopupPosition): string {
    const classes: string[] = [];
    if (position?.includes('right')) classes.push('position-right');
    if (position?.includes('top')) classes.push('position-top');
    return classes.join(' ');
  }

  /**
   * Update the popup body content.
   */
  protected updateBodyContent(html: string): void {
    const body = this.query<HTMLElement>('[data-popup-body]');
    if (body) {
      body.innerHTML = html;
    }
  }

  // ============================================
  // Event Handling
  // ============================================

  private setupBaseEvents(): void {
    // Prevent clicks inside popup from closing it
    this.delegate('click', '[data-popup-container]', (e) => {
      e.stopPropagation();
    });
  }

  private handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      this.close();
    }
  }

  private handleOutsideClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;

    // Check if click is inside this popup's shadow DOM
    const path = e.composedPath();
    const clickedInsidePopup = path.some(el => {
      if (el instanceof HTMLElement) {
        return el === this.element || this.shadow.contains(el);
      }
      return false;
    });

    if (!clickedInsidePopup) {
      this.close();
    }
  }

  private handleOpenRequest(open: boolean): void {
    if (open) {
      this.open();
    } else {
      this.close();
    }
  }

  // ============================================
  // Popup Control
  // ============================================

  open(): void {
    if (this._visible) return;

    this._visible = true;

    // Update UI
    const container = this.query<HTMLElement>('[data-popup-container]');
    if (container) {
      container.classList.add('visible');
    }

    // Add event listeners (use capture phase for outside click)
    document.addEventListener('keydown', this._boundHandleKeydown);
    // Delay to prevent the opening click from immediately closing
    setTimeout(() => {
      document.addEventListener('click', this._boundHandleOutsideClick, true);
    }, 0);

    // Call subclass hook
    this.onOpen();

    // Publish state
    this.publish({ [this._config.visibleStateKey]: true });
  }

  close(): void {
    if (!this._visible) return;

    this._visible = false;

    // Update UI
    const container = this.query<HTMLElement>('[data-popup-container]');
    if (container) {
      container.classList.remove('visible');
    }

    // Remove event listeners
    document.removeEventListener('keydown', this._boundHandleKeydown);
    document.removeEventListener('click', this._boundHandleOutsideClick, true);

    // Call subclass hook
    this.onClose();

    // Publish state
    this.publish({ [this._config.visibleStateKey]: false });

    // Reset the request state so the next open request triggers a change
    this.manager.publishDirect(this._config.openRequestKey, false, this.actorId);
  }

  toggle(): void {
    if (this._visible) {
      this.close();
    } else {
      this.open();
    }
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
    document.removeEventListener('click', this._boundHandleOutsideClick, true);
    super.destroy();
  }
}
