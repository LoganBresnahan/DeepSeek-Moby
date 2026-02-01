/**
 * PendingChangesActor
 *
 * Manages display of modified files during streaming.
 * Shows collapsible dropdown with file change status and actions.
 *
 * Extends InterleavedContentActor for shared container management.
 *
 * Publications:
 * - pending.files: PendingFile[] - files with pending changes
 * - pending.expanded: boolean - whether dropdown is expanded
 *
 * Subscriptions:
 * - streaming.active: boolean - track streaming state
 */

import { InterleavedContentActor, InterleavedContainer } from '../../state/InterleavedContentActor';
import { EventStateManager } from '../../state/EventStateManager';
import { pendingStyles as styles } from './styles';

export type FileStatus = 'pending' | 'applied' | 'rejected' | 'superseded';
export type EditMode = 'manual' | 'ask' | 'auto';

export interface PendingFile {
  id: string;
  filePath: string;
  fileName: string;
  status: FileStatus;
  iteration: number;
  diffId?: string;
  superseded?: boolean;
}

export interface PendingChangesState {
  files: PendingFile[];
  expanded: boolean;
  editMode: EditMode;
}

export type FileActionHandler = (fileId: string, action: 'accept' | 'reject' | 'focus') => void;

export class PendingChangesActor extends InterleavedContentActor {
  // Internal state
  private _files: PendingFile[] = [];
  private _expanded = true; // Default expanded
  private _editMode: EditMode = 'ask';

  // Single container for pending changes (reused)
  private _currentContainer: InterleavedContainer | null = null;

  // Handlers
  private _onAction: FileActionHandler | null = null;

  // Counter for unique file IDs
  private _fileIdCounter = 0;

  constructor(manager: EventStateManager, element: HTMLElement) {
    super({
      manager,
      element,
      publications: {
        'pending.files': () => [...this._files],
        'pending.expanded': () => this._expanded
      },
      subscriptions: {
        'streaming.active': (value: unknown) => this.handleStreamingActive(value as boolean)
      },
      actorName: 'pending',
      containerClassName: 'pending-changes-wrapper',
      styles
    });
    // Don't render on construction - only when files are added
  }

  // ============================================
  // Subscription Handlers
  // ============================================

  private handleStreamingActive(active: boolean): void {
    // Could collapse when streaming ends, but we keep expanded for visibility
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Set the edit mode (affects UI display)
   */
  setEditMode(mode: EditMode): void {
    this._editMode = mode;
    this.render();
  }

  /**
   * Add a pending file change
   */
  addFile(filePath: string, diffId?: string, iteration: number = 1): string {
    const id = `pending-${++this._fileIdCounter}`;
    const fileName = filePath.split('/').pop() || filePath;

    // Check if this supersedes an existing file
    this._files.forEach(f => {
      if (f.filePath === filePath && f.status === 'pending' && !f.superseded) {
        f.superseded = true;
      }
    });

    this._files.push({
      id,
      filePath,
      fileName: iteration > 1 ? `${fileName} (${iteration})` : fileName,
      status: this._editMode === 'auto' ? 'applied' : 'pending',
      iteration,
      diffId,
      superseded: false
    });

    this.render();
    this.publish({ 'pending.files': [...this._files] });

    return id;
  }

  /**
   * Update file status
   */
  updateFile(id: string, update: Partial<Omit<PendingFile, 'id'>>): void {
    const file = this._files.find(f => f.id === id);
    if (!file) return;

    Object.assign(file, update);
    this.render();
    this.publish({ 'pending.files': [...this._files] });
  }

  /**
   * Accept a file change
   */
  acceptFile(id: string): void {
    this.updateFile(id, { status: 'applied' });
    if (this._onAction) {
      this._onAction(id, 'accept');
    }
  }

  /**
   * Reject a file change
   */
  rejectFile(id: string): void {
    this.updateFile(id, { status: 'rejected' });
    if (this._onAction) {
      this._onAction(id, 'reject');
    }
  }

  /**
   * Focus on a file's diff
   */
  focusFile(id: string): void {
    const file = this._files.find(f => f.id === id);
    if (!file || file.superseded) return;

    if (this._onAction) {
      this._onAction(id, 'focus');
    }
  }

  /**
   * Mark file as superseded
   */
  supersede(id: string): void {
    this.updateFile(id, { superseded: true });
  }

  /**
   * Toggle expanded state
   */
  toggleExpanded(): void {
    this._expanded = !this._expanded;
    this.render();
    this.publish({ 'pending.expanded': this._expanded });
  }

  /**
   * Expand dropdown
   */
  expand(): void {
    if (!this._expanded) {
      this._expanded = true;
      this.render();
      this.publish({ 'pending.expanded': true });
    }
  }

  /**
   * Collapse dropdown
   */
  collapse(): void {
    if (this._expanded) {
      this._expanded = false;
      this.render();
      this.publish({ 'pending.expanded': false });
    }
  }

  /**
   * Clear all files
   */
  clear(): void {
    this._files = [];
    this._currentContainer = null;
    // Use base class container cleanup
    this.clearContainers();
    this.publish({ 'pending.files': [] });
  }

  /**
   * Register action handler
   */
  onAction(handler: FileActionHandler): void {
    this._onAction = handler;
  }

  /**
   * Get current state
   */
  getState(): PendingChangesState {
    return {
      files: [...this._files],
      expanded: this._expanded,
      editMode: this._editMode
    };
  }

  /**
   * Get files
   */
  getFiles(): PendingFile[] {
    return [...this._files];
  }

  /**
   * Get pending count
   */
  getPendingCount(): number {
    return this._files.filter(f => f.status === 'pending' && !f.superseded).length;
  }

  /**
   * Check if has any pending files
   */
  hasPending(): boolean {
    return this.getPendingCount() > 0;
  }

  // ============================================
  // Rendering
  // ============================================

  /**
   * Ensure container element exists
   */
  private ensureContainer(): InterleavedContainer {
    if (!this._currentContainer) {
      this._currentContainer = this.createContainer('pending');
    }
    return this._currentContainer;
  }

  /**
   * Render the pending changes dropdown
   */
  private render(): void {
    // In manual mode or no files, hide/remove the container
    if (this._editMode === 'manual' || this._files.length === 0) {
      if (this._currentContainer) {
        this._currentContainer.element.innerHTML = '';
        this._currentContainer.element.style.display = 'none';
      }
      return;
    }

    // Ensure container exists and is visible
    const container = this.ensureContainer();
    container.element.style.display = '';

    const isAutoMode = this._editMode === 'auto';
    const title = isAutoMode ? 'Modified Files' : 'Pending Changes';

    const classes = [
      'pending-container',
      this._expanded ? 'expanded' : '',
      isAutoMode ? 'auto-mode' : ''
    ].filter(Boolean).join(' ');

    container.element.innerHTML = `
      <div class="${classes}">
        <div class="pending-header">
          <span class="pending-icon">▶</span>
          <span class="pending-title">${title}</span>
          <span class="pending-count">${this._files.length}</span>
        </div>
        <div class="pending-body">
          ${this._files.map(file => this.renderFile(file)).join('')}
        </div>
      </div>
    `;

    // Bind click handlers
    const header = container.element.querySelector('.pending-header');
    if (header) {
      header.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleExpanded();
      });
    }

    // Bind file click handlers
    this._files.forEach(file => {
      const fileEl = container.element.querySelector(`#${file.id} .pending-file`);
      if (fileEl && file.status === 'pending' && !file.superseded) {
        fileEl.addEventListener('click', () => this.focusFile(file.id));
      }

      // Bind action buttons
      const acceptBtn = container.element.querySelector(`#${file.id} .accept-btn`);
      if (acceptBtn) {
        acceptBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.acceptFile(file.id);
        });
      }

      const rejectBtn = container.element.querySelector(`#${file.id} .reject-btn`);
      if (rejectBtn) {
        rejectBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.rejectFile(file.id);
        });
      }
    });
  }

  /**
   * Render a single file item
   */
  private renderFile(file: PendingFile): string {
    // Show superseded icon if superseded, otherwise show status icon
    const statusIcon = file.superseded ? this.getStatusIcon('superseded') : this.getStatusIcon(file.status);
    const statusClass = file.superseded ? 'superseded' : file.status;
    const isClickable = file.status === 'pending' && !file.superseded;
    const fileClass = isClickable ? 'pending-file' : 'pending-file no-click';

    let actionsHtml = '';
    if (this._editMode === 'auto') {
      actionsHtml = `<span class="pending-label auto">Auto Applied</span>`;
    } else if (file.status === 'applied') {
      actionsHtml = `<span class="pending-label applied">Accepted</span>`;
    } else if (file.status === 'rejected') {
      actionsHtml = `<span class="pending-label rejected">Rejected</span>`;
    } else if (file.superseded) {
      actionsHtml = `<span class="pending-label superseded">Superseded</span>`;
    } else if (file.status === 'pending') {
      actionsHtml = `
        <div class="pending-actions">
          <button class="pending-btn accept-btn" title="Accept changes">✓</button>
          <button class="pending-btn reject-btn" title="Reject changes">✕</button>
        </div>
      `;
    }

    return `
      <div class="pending-item" id="${file.id}" data-status="${file.status}" data-superseded="${file.superseded || false}">
        <span class="pending-status ${statusClass}">${statusIcon}</span>
        <span class="${fileClass}" title="${this.escapeHtml(file.filePath)}">${this.escapeHtml(file.fileName)}</span>
        ${actionsHtml}
      </div>
    `;
  }

  /**
   * Get icon for file status
   */
  private getStatusIcon(status: FileStatus): string {
    switch (status) {
      case 'pending':
        return '●';
      case 'applied':
        return '✓';
      case 'rejected':
        return '✗';
      case 'superseded':
        return '⊘';  // Void/cancel symbol
    }
  }

  /**
   * Escape HTML special characters
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Destroy and cleanup
   */
  destroy(): void {
    this._files = [];
    this._onAction = null;
    this._currentContainer = null;
    super.destroy();
  }

  /**
   * Reset styles injection flag and remove style tag (for testing)
   */
  static resetStylesInjected(): void {
    InterleavedContentActor.resetStylesInjectedFor('pending');
  }
}
