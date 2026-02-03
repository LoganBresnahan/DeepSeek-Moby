/**
 * PendingChangesShadowActor
 *
 * Shadow DOM version of PendingChangesActor.
 * Manages display of modified files during streaming.
 * Shows collapsible dropdown with file change status and actions.
 *
 * Uses a single Shadow DOM container that is reused for all files.
 * No z-index coordination needed, no class name prefixes required.
 *
 * Publications:
 * - pending.files: PendingFile[] - files with pending changes
 * - pending.expanded: boolean - whether dropdown is expanded
 *
 * Subscriptions:
 * - streaming.active: boolean - track streaming state
 */

import { InterleavedShadowActor, ShadowContainer } from '../../state/InterleavedShadowActor';
import { EventStateManager } from '../../state/EventStateManager';
import { pendingShadowStyles } from './shadowStyles';

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

export class PendingChangesShadowActor extends InterleavedShadowActor {
  // Internal state
  private _files: PendingFile[] = [];
  private _expanded = true; // Default expanded
  private _editMode: EditMode = 'ask';

  // Single container for pending changes (reused)
  private _currentContainerId: string | null = null;

  // Handlers
  private _onAction: FileActionHandler | null = null;

  // Counter for unique file IDs
  private _fileIdCounter = 0;

  constructor(manager: EventStateManager, element: HTMLElement) {
    super({
      manager,
      element,
      actorName: 'pending',
      containerStyles: pendingShadowStyles,
      publications: {
        'pending.files': () => [...this._files],
        'pending.expanded': () => this._expanded
      },
      subscriptions: {
        'streaming.active': (value: unknown) => this.handleStreamingActive(value as boolean)
      }
    });
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
    console.log('[PendingChangesShadowActor] addFile:', filePath, 'diffId:', diffId, 'iteration:', iteration, 'editMode:', this._editMode);
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

    console.log('[PendingChangesShadowActor] Total files now:', this._files.length);
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
   * Toggle expanded state.
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
    this._currentContainerId = null;
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
   * Ensure container exists
   */
  private ensureContainer(): ShadowContainer {
    if (!this._currentContainerId) {
      const container = this.createContainer('pending');
      this._currentContainerId = container.id;
    }
    return this.getContainer(this._currentContainerId)!;
  }

  /**
   * Render the pending changes dropdown
   */
  private render(): void {
    console.log('[PendingChangesShadowActor] render() called, editMode:', this._editMode, 'files:', this._files.length, 'expanded:', this._expanded);

    // In manual mode or no files, hide/remove the container
    if (this._editMode === 'manual' || this._files.length === 0) {
      console.log('[PendingChangesShadowActor] Hiding container - editMode:', this._editMode, 'files:', this._files.length);
      if (this._currentContainerId) {
        const container = this.getContainer(this._currentContainerId);
        if (container) {
          container.content.innerHTML = '';
          this.hideContainer(this._currentContainerId);
        }
      }
      return;
    }

    // Ensure container exists and is visible
    const container = this.ensureContainer();
    this.showContainer(container.id);
    console.log('[PendingChangesShadowActor] Container visible:', container.id, 'in element:', this.element.id || this.element.className);

    const isAutoMode = this._editMode === 'auto';
    const title = isAutoMode ? 'Modified Files' : 'Pending Changes';
    const toggleIcon = this._expanded ? '−' : '+';
    const headerIcon = isAutoMode ? '✓' : '📝';
    const preview = this.getPreviewText();

    // Check if this is a fresh render (no existing structure)
    const existingHeader = container.content.querySelector('.header');

    // Apply auto-mode class immediately
    container.content.classList.toggle('auto-mode', isAutoMode);
    container.content.classList.toggle('expanded', this._expanded);

    if (existingHeader) {
      // Incremental update - preserve event handlers
      const toggleEl = container.content.querySelector('.toggle');
      if (toggleEl) toggleEl.textContent = toggleIcon;

      const iconEl = container.content.querySelector('.icon');
      if (iconEl) iconEl.textContent = headerIcon;

      const titleEl = container.content.querySelector('.title');
      if (titleEl) titleEl.textContent = title;

      const previewEl = container.content.querySelector('.preview');
      if (previewEl) previewEl.textContent = preview;

      const countEl = container.content.querySelector('.count');
      if (countEl) countEl.textContent = `[${this._files.length}]`;

      // Update body content
      const body = container.content.querySelector('.body');
      if (body) {
        body.innerHTML = this._files.map((file, i, arr) => this.renderFile(file, i === arr.length - 1)).join('');
      }

      // Re-bind file event handlers
      this.bindFileEventHandlers(container.id);
    } else {
      // First render - clean HTML with dotted border from CSS
      container.content.innerHTML = `
<div class="header">
  <span class="toggle">${toggleIcon}</span>
  <span class="icon">${headerIcon}</span>
  <span class="title">${title}</span>
  <span class="preview">${preview}</span>
  <span class="count">[${this._files.length}]</span>
</div>
<div class="body">
${this._files.map((file, i, arr) => this.renderFile(file, i === arr.length - 1)).join('\n')}
</div>`;

      // Bind click handlers
      this.bindEventHandlers(container.id);
    }
  }

  /**
   * Get preview text for collapsed state
   */
  private getPreviewText(): string {
    if (this._expanded) return '';
    const names = this._files.slice(0, 3).map(f => f.fileName);
    const preview = names.join(' · ');
    return this._files.length > 3 ? `  ${preview} ...` : `  ${preview}`;
  }

  /**
   * Bind event handlers for the container
   */
  private bindEventHandlers(containerId: string): void {
    const container = this.getContainer(containerId);
    if (!container) return;

    // Add click handler to container for expand/collapse
    container.content.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      // Don't toggle if clicking on action buttons, clickable files, or inside body when expanded
      if (target.closest('.btn') || target.closest('.file:not(.no-click)')) {
        return;
      }
      if (target.closest('.body') && this._expanded) {
        return;
      }
      this.toggleExpanded();
    });

    // Bind file event handlers
    this.bindFileEventHandlers(containerId);
  }

  /**
   * Bind event handlers for file items (called on each render)
   */
  private bindFileEventHandlers(containerId: string): void {
    const container = this.getContainer(containerId);
    if (!container) return;

    // File clicks and action buttons
    this._files.forEach(file => {
      const fileEl = container.shadow.querySelector(`#${file.id} .file`) as HTMLElement | null;
      if (fileEl && file.status === 'pending' && !file.superseded) {
        fileEl.addEventListener('click', (e) => {
          e.stopPropagation();
          this.focusFile(file.id);
        });
      }

      const acceptBtn = container.shadow.querySelector(`#${file.id} .accept-btn`) as HTMLElement | null;
      if (acceptBtn) {
        acceptBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.acceptFile(file.id);
        });
      }

      const rejectBtn = container.shadow.querySelector(`#${file.id} .reject-btn`) as HTMLElement | null;
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
  private renderFile(file: PendingFile, isLast: boolean = false): string {
    const statusIcon = file.superseded ? this.getStatusIcon('superseded') : this.getStatusIcon(file.status);
    const statusClass = file.superseded ? 'superseded' : file.status;
    const isClickable = file.status === 'pending' && !file.superseded;
    const fileClass = isClickable ? 'file' : 'file no-click';
    const treeBranch = isLast ? '└─' : '├─';

    let actionsHtml = '';
    if (this._editMode === 'auto') {
      actionsHtml = `<span class="label">Auto Applied</span>`;
    } else if (file.status === 'applied') {
      actionsHtml = `<span class="label">Accepted</span>`;
    } else if (file.status === 'rejected') {
      actionsHtml = `<span class="label">Rejected</span>`;
    } else if (file.superseded) {
      actionsHtml = `<span class="label">Superseded</span>`;
    } else if (file.status === 'pending') {
      actionsHtml = `<span class="actions"><button class="btn accept-btn" title="Accept">[✓]</button> <button class="btn reject-btn" title="Reject">[✕]</button></span>`;
    }

    return `<div class="item" id="${file.id}" data-status="${file.status}" data-superseded="${file.superseded || false}">     <span class="tree">${treeBranch}</span> <span class="status ${statusClass}">${statusIcon}</span> <span class="${fileClass}" title="${this.escapeHtml(file.filePath)}">${this.escapeHtml(file.fileName)}</span> ${actionsHtml}</div>`;
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
        return '⊘';
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

  // ============================================
  // Lifecycle
  // ============================================

  destroy(): void {
    this._files = [];
    this._onAction = null;
    this._currentContainerId = null;
    super.destroy();
  }
}
