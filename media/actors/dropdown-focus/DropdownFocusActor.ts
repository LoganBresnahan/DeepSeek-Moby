/**
 * DropdownFocusActor
 *
 * Manages sticky hover and modal popup behavior for dropdowns during streaming.
 *
 * Problem: When lots of data is streaming, users can't click dropdowns because
 * they scroll away too fast.
 *
 * Solution:
 * 1. Sticky Hover: When hovering a dropdown during streaming, create a "ghost"
 *    that stays near the cursor as the chat scrolls.
 * 2. Modal Popup: When clicking, show the dropdown content in a modal overlay
 *    that floats above the scrolling chat.
 *
 * Architecture:
 * This actor uses pure pub/sub - it subscribes to hover/click events published
 * by ThinkingShadowActor, ShellShadowActor, and MessageShadowActor.
 * It never reaches into their shadow roots.
 *
 * Subscriptions:
 * - streaming.active: boolean - track streaming state
 * - thinking.dropdown.hover/click/contentUpdate - thinking dropdown events
 * - shell.dropdown.hover/click/contentUpdate - shell dropdown events
 * - message.codeBlock.hover/click - code block events
 *
 * Publications:
 * - dropdownFocus.hoveredId: string | null - currently hovered dropdown
 * - dropdownFocus.modalId: string | null - currently open modal dropdown
 * - dropdownFocus.hasModal: boolean - whether a modal is open
 * - scroll.request: ScrollRequest | null - scroll requests sent to ScrollActor
 */

import { EventStateActor } from '../../state/EventStateActor';
import { EventStateManager } from '../../state/EventStateManager';
import { dropdownFocusStyles } from './shadowStyles';
import type { DropdownHoverEvent, DropdownClickEvent, DropdownContentUpdate, DropdownType } from '../../state/types';
import type { ScrollRequest } from '../scroll/ScrollActor';

export interface DropdownInfo {
  /** Unique identifier for this dropdown */
  id: string;
  /** Type of dropdown */
  type: DropdownType;
  /** ID of the shadow host element (resolve via document.getElementById) */
  hostElementId: string;
  /** Current content of the dropdown body */
  bodyContent: string;
  /** Label text shown in the header */
  headerLabel: string;
  /** Scroll position when dropdown was clicked */
  originalScrollTop: number;
}

export interface DropdownFocusState {
  /** Whether streaming is active */
  streaming: boolean;
  /** Currently hovered dropdown ID */
  hoveredDropdownId: string | null;
  /** Currently open modal dropdown ID */
  modalDropdownId: string | null;
}

export class DropdownFocusActor extends EventStateActor {
  // State
  private _streaming = false;
  private _currentHover: DropdownInfo | null = null;
  private _modalDropdown: DropdownInfo | null = null;

  // DOM elements
  private _ghostElement: HTMLElement | null = null;
  private _modalOverlay: HTMLElement | null = null;
  private _chatContainer: HTMLElement;

  // Style injection tracking
  private _stylesInjected = false;

  // Pending scroll request (for pub/sub scroll control)
  private _pendingScrollRequest: ScrollRequest | null = null;

  // Delayed ghost clear timer (allows mouse to move from header to ghost)
  private _ghostClearTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(manager: EventStateManager, chatContainer: HTMLElement) {
    super({
      manager,
      element: chatContainer,
      publications: {
        'dropdownFocus.hoveredId': () => this._currentHover?.id ?? null,
        'dropdownFocus.modalId': () => this._modalDropdown?.id ?? null,
        'dropdownFocus.hasModal': () => this._modalDropdown !== null,
        // Scroll requests published to ScrollActor
        'scroll.request': () => this._pendingScrollRequest
      },
      subscriptions: {
        // Streaming state
        'streaming.active': (value: unknown) => this.handleStreamingChange(value as boolean),

        // Thinking dropdown events
        'thinking.dropdown.hover': (value: unknown) => this.handleDropdownHover(value as DropdownHoverEvent | null),
        'thinking.dropdown.click': (value: unknown) => this.handleDropdownClick(value as DropdownClickEvent | null),
        'thinking.dropdown.contentUpdate': (value: unknown) => this.handleContentUpdate(value as DropdownContentUpdate | null),

        // Shell dropdown events
        'shell.dropdown.hover': (value: unknown) => this.handleDropdownHover(value as DropdownHoverEvent | null),
        'shell.dropdown.click': (value: unknown) => this.handleDropdownClick(value as DropdownClickEvent | null),
        'shell.dropdown.contentUpdate': (value: unknown) => this.handleContentUpdate(value as DropdownContentUpdate | null),

        // Code block events
        'message.codeBlock.hover': (value: unknown) => this.handleDropdownHover(value as DropdownHoverEvent | null),
        'message.codeBlock.click': (value: unknown) => this.handleDropdownClick(value as DropdownClickEvent | null)
      },
      enableDOMChangeDetection: false
    });

    this._chatContainer = chatContainer;
    this.injectStyles();
  }

  // ============================================
  // Initialization
  // ============================================

  private injectStyles(): void {
    if (this._stylesInjected) return;

    const existingStyles = document.getElementById('dropdown-focus-styles');
    if (existingStyles) {
      this._stylesInjected = true;
      return;
    }

    const style = document.createElement('style');
    style.id = 'dropdown-focus-styles';
    style.textContent = dropdownFocusStyles;
    document.head.appendChild(style);
    this._stylesInjected = true;
  }

  // ============================================
  // Event Handlers (Subscriptions)
  // ============================================

  private handleStreamingChange(streaming: boolean): void {
    this._streaming = streaming;

    // Update modal streaming state if open
    if (this._modalOverlay && this._modalDropdown) {
      const modal = this._modalOverlay.querySelector('.dropdown-modal');
      modal?.classList.toggle('streaming', streaming);
    }

    // Clear ghost if streaming stops
    if (!streaming) {
      this.clearGhost();
      this._currentHover = null;
    }
  }

  private handleDropdownHover(event: DropdownHoverEvent | null): void {
    // Only show ghost during streaming
    if (!this._streaming) return;

    if (event === null) {
      // Hover ended - use delayed clear to allow mouse to reach the ghost
      this.scheduleClearGhost();
      return;
    }

    // Cancel any pending clear since we have a new/continued hover
    this.cancelClearGhost();

    // Skip if already showing ghost for this dropdown (prevents flicker)
    if (this._currentHover?.id === event.dropdownId && this._ghostElement) {
      return;
    }

    // Create dropdown info from event
    this._currentHover = {
      id: event.dropdownId,
      type: event.type,
      hostElementId: event.hostElementId,
      bodyContent: event.bodyContent,
      headerLabel: event.headerLabel,
      originalScrollTop: 0
    };

    this.createGhost(event);
  }

  private scheduleClearGhost(): void {
    // Cancel any existing timer
    this.cancelClearGhost();

    // Delay clearing to allow mouse to reach the ghost
    this._ghostClearTimer = setTimeout(() => {
      this.clearGhost();
      this._currentHover = null;
      this._ghostClearTimer = null;
    }, 150); // 150ms grace period
  }

  private cancelClearGhost(): void {
    if (this._ghostClearTimer) {
      clearTimeout(this._ghostClearTimer);
      this._ghostClearTimer = null;
    }
  }

  private handleDropdownClick(event: DropdownClickEvent | null): void {
    // Modal can open anytime (not just during streaming)
    if (!event) return;

    const dropdownInfo: DropdownInfo = {
      id: event.dropdownId,
      type: event.type,
      hostElementId: event.hostElementId,
      bodyContent: event.bodyContent,
      headerLabel: event.headerLabel,
      originalScrollTop: event.scrollTop
    };

    this.openModal(dropdownInfo);
  }

  private handleContentUpdate(event: DropdownContentUpdate | null): void {
    if (!event || !this._modalDropdown) return;

    // Only update if this is for the currently open modal
    if (this._modalDropdown.id !== event.dropdownId) return;

    // Update modal content
    this._modalDropdown.bodyContent = event.bodyContent;
    this.updateModalContent();
  }

  // ============================================
  // Ghost Element
  // ============================================

  private createGhost(event: DropdownHoverEvent): void {
    // Clear any existing ghost first
    if (this._ghostElement) {
      this._ghostElement.remove();
      this._ghostElement = null;
    }

    const ghost = document.createElement('div');
    ghost.className = 'dropdown-ghost entering';

    // Create ghost content based on dropdown type
    ghost.innerHTML = this.createGhostContent(event);

    // Position near mouse
    ghost.style.left = `${event.mouseEvent.clientX - 100}px`;
    ghost.style.top = `${Math.max(event.mouseEvent.clientY - 20, 10)}px`;

    // Apply type-specific styling
    this.applyGhostStyles(ghost, event.type);

    document.body.appendChild(ghost);
    this._ghostElement = ghost;

    // Setup ghost event listeners
    ghost.addEventListener('click', () => {
      if (this._currentHover) {
        this.openModal({
          ...this._currentHover,
          originalScrollTop: this._chatContainer.scrollTop
        });
      }
    });

    // When mouse enters ghost, cancel any pending clear
    ghost.addEventListener('mouseenter', () => {
      this.cancelClearGhost();
    });

    // When mouse leaves ghost, schedule clear (with delay)
    ghost.addEventListener('mouseleave', () => {
      this.scheduleClearGhost();
    });

    // Remove entering class after animation
    setTimeout(() => ghost.classList.remove('entering'), 200);
  }

  private createGhostContent(event: DropdownHoverEvent): string {
    const emoji = this.getTypeEmoji(event.type);
    return `
      <span class="icon">▶</span>
      <span class="emoji">${emoji}</span>
      <span class="label">${event.headerLabel}</span>
    `;
  }

  private getTypeEmoji(type: DropdownType): string {
    switch (type) {
      case 'thinking': return '💭';
      case 'shell': return '⚡';
      case 'code': return '📄';
      default: return '▼';
    }
  }

  private applyGhostStyles(ghost: HTMLElement, type: DropdownType): void {
    ghost.style.background = 'var(--vscode-editorWidget-background)';
    ghost.style.padding = '8px 12px';
    ghost.style.display = 'flex';
    ghost.style.alignItems = 'center';
    ghost.style.gap = '8px';
    ghost.style.cursor = 'pointer';
    ghost.style.fontSize = '12px';
    ghost.style.color = 'var(--vscode-foreground)';

    switch (type) {
      case 'thinking':
        ghost.style.borderLeft = '3px solid var(--vscode-symbolIcon-classForeground, #ee9d28)';
        break;
      case 'shell':
        ghost.style.borderLeft = '3px solid var(--vscode-terminal-ansiGreen, #23d18b)';
        break;
      case 'code':
        ghost.style.borderLeft = '3px solid var(--vscode-terminal-ansiBlue, #3b8eea)';
        break;
    }
  }

  private clearGhost(): void {
    if (!this._ghostElement) return;

    this._ghostElement.classList.add('exiting');
    const ghost = this._ghostElement;

    setTimeout(() => {
      ghost.remove();
    }, 150);

    this._ghostElement = null;
  }

  // ============================================
  // Modal
  // ============================================

  private openModal(dropdown: DropdownInfo): void {
    this.clearGhost();
    this._currentHover = null;
    this._modalDropdown = dropdown;

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'dropdown-modal-overlay';

    // Create modal
    const modal = document.createElement('div');
    modal.className = 'dropdown-modal';
    modal.setAttribute('data-type', dropdown.type);
    if (this._streaming) {
      modal.classList.add('streaming');
    }

    // Header
    const header = document.createElement('div');
    header.className = 'dropdown-modal-header';
    header.innerHTML = this.createModalHeaderContent(dropdown);

    // Body
    const body = document.createElement('div');
    body.className = 'dropdown-modal-body';
    body.innerHTML = dropdown.bodyContent;

    // Footer
    const footer = document.createElement('div');
    footer.className = 'dropdown-modal-footer';
    footer.innerHTML = `
      <button class="dropdown-modal-btn secondary" data-action="original">
        <span class="btn-icon">📍</span>
        <span>Go to Original</span>
      </button>
      <button class="dropdown-modal-btn primary" data-action="latest">
        <span class="btn-icon">↓</span>
        <span>Go to Latest</span>
      </button>
    `;

    // Setup button handlers
    footer.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action') as 'original' | 'latest';
        this.closeModal(action);
      });
    });

    // Setup backdrop click handler
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        this.closeModal('latest');
      }
    });

    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);
    overlay.appendChild(modal);

    document.body.appendChild(overlay);
    this._modalOverlay = overlay;

    // Trigger animation
    requestAnimationFrame(() => {
      overlay.classList.add('visible');
    });

    // Publish state
    this.publish({
      'dropdownFocus.modalId': dropdown.id,
      'dropdownFocus.hasModal': true
    });
  }

  private createModalHeaderContent(dropdown: DropdownInfo): string {
    const emoji = this.getTypeEmoji(dropdown.type);
    return `
      <span class="icon">▼</span>
      <span class="emoji">${emoji}</span>
      <span class="label">${dropdown.headerLabel}</span>
    `;
  }

  private updateModalContent(): void {
    if (!this._modalOverlay || !this._modalDropdown) return;

    const body = this._modalOverlay.querySelector('.dropdown-modal-body');
    if (!body) return;

    body.innerHTML = this._modalDropdown.bodyContent;

    // Auto-scroll to bottom if streaming
    if (this._streaming) {
      body.scrollTop = body.scrollHeight;
    }
  }

  closeModal(action: 'original' | 'latest'): void {
    if (!this._modalOverlay || !this._modalDropdown) return;

    const dropdown = this._modalDropdown;

    // Animate out
    this._modalOverlay.classList.remove('visible');
    this._modalOverlay.classList.add('closing');

    setTimeout(() => {
      this._modalOverlay?.remove();
      this._modalOverlay = null;

      // Publish scroll request to ScrollActor
      if (action === 'original') {
        this.publishScrollRequest({ position: dropdown.originalScrollTop });

        // Highlight the original dropdown briefly
        const hostElement = document.getElementById(dropdown.hostElementId);
        if (hostElement) {
          hostElement.style.outline = '2px solid var(--vscode-focusBorder)';
          setTimeout(() => {
            hostElement.style.outline = '';
          }, 1000);
        }
      } else {
        // Scroll to bottom (latest)
        this.publishScrollRequest({ position: 'bottom' });
      }

      this._modalDropdown = null;

      this.publish({
        'dropdownFocus.modalId': null,
        'dropdownFocus.hasModal': false
      });
    }, 200);
  }

  // ============================================
  // Scroll Request Publishing
  // ============================================

  /**
   * Publish a scroll request to ScrollActor via pub/sub
   */
  private publishScrollRequest(request: ScrollRequest): void {
    this._pendingScrollRequest = request;
    this.publish({ 'scroll.request': request });
    // Clear after publishing to avoid duplicate processing
    this._pendingScrollRequest = null;
  }

  // ============================================
  // Public API
  // ============================================

  getState(): DropdownFocusState {
    return {
      streaming: this._streaming,
      hoveredDropdownId: this._currentHover?.id ?? null,
      modalDropdownId: this._modalDropdown?.id ?? null
    };
  }

  isModalOpen(): boolean {
    return this._modalDropdown !== null;
  }

  // ============================================
  // Lifecycle
  // ============================================

  destroy(): void {
    this.cancelClearGhost();
    this.clearGhost();

    if (this._modalOverlay) {
      this._modalOverlay.remove();
      this._modalOverlay = null;
    }

    // Remove injected styles
    const styles = document.getElementById('dropdown-focus-styles');
    styles?.remove();

    super.destroy();
  }
}
