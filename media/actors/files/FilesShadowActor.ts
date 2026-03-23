/**
 * FilesShadowActor
 *
 * Shadow DOM actor for the file selection modal.
 * Allows users to select files from open editors or search
 * the workspace to add them as context for the AI.
 *
 * Publications:
 * - files.modal.visible: boolean - whether the modal is open
 * - files.selected: Map<string, string> - selected files (path -> content)
 *
 * Subscriptions:
 * - files.modal.open: boolean - request to open/close modal
 * - files.openFiles: string[] - list of currently open files from extension
 * - files.searchResults: string[] - search results from extension
 * - files.content: { path: string, content: string } - file content from extension
 */

import { ModalShadowActor, ModalConfig } from '../../state/ModalShadowActor';
import { EventStateManager } from '../../state/EventStateManager';
import type { VSCodeAPI } from '../../state/types';
import { filesShadowStyles } from './shadowStyles';

// ============================================
// Types
// ============================================

export interface FileData {
  path: string;
  content: string;
}

export interface FilesState {
  visible: boolean;
  selectedFiles: Map<string, string>;
  openFiles: string[];
  searchResults: string[];
  searchQuery: string;
}

export type FilesChangeHandler = (files: FileData[]) => void;

// ============================================
// FilesShadowActor
// ============================================

export class FilesShadowActor extends ModalShadowActor {
  private _selectedFiles: Map<string, string> = new Map();
  private _openFiles: string[] = [];
  private _searchResults: string[] = [];
  private _searchQuery = '';
  private _searchTimeout: ReturnType<typeof setTimeout> | null = null;
  private _onFilesChange: FilesChangeHandler | null = null;

  constructor(manager: EventStateManager, element: HTMLElement, vscode: VSCodeAPI) {
    const config: ModalConfig = {
      manager,
      element,
      vscode,
      title: 'Select Files for Context',
      titleIcon: '📂',
      hasSearch: false, // We render our own search in the body
      hasFooter: true,
      maxWidth: '600px',
      maxHeight: '80vh',
      publications: {
        'files.selected': () => this._selectedFiles
      },
      subscriptions: {
        'files.openFiles': (value: unknown) => this.handleOpenFiles(value as string[]),
        'files.searchResults': (value: unknown) => {
          const data = value as { results: string[]; _ts?: number };
          this.handleSearchResults(Array.isArray(data) ? data : data.results);
        },
        'files.content': (value: unknown) => {
          const data = value as FileData & { _ts?: number };
          this.handleFileContent(data);
        }
      },
      additionalStyles: filesShadowStyles,
      openRequestKey: 'files.modal.open',
      visibleStateKey: 'files.modal.visible'
    };

    super(config);
  }

  // ============================================
  // Abstract Method Implementations
  // ============================================

  protected renderModalContent(): string {
    return `
      <!-- Open files section -->
      <div class="file-section">
        <div class="file-section-header">
          Open Files (<span class="file-section-count" data-open-count>0</span>)
        </div>
        <div class="open-files-list" data-open-files>
          <div class="file-search-no-results">No files currently open</div>
        </div>
      </div>

      <!-- Search section -->
      <div class="file-section">
        <div class="file-section-header">Search Files</div>
        <input
          type="text"
          class="file-search-input"
          placeholder="🔍 Type to search files. Searching is case sensitive"
          data-file-search
        />
        <div class="file-search-results" data-search-results style="display: none;">
          <!-- Search results inserted here -->
        </div>
      </div>

      <!-- Selected files section -->
      <div class="file-section">
        <div class="file-section-header">
          Selected Files (<span class="file-section-count" data-selected-count>0</span>)
        </div>
        <div class="selected-files-container" data-selected-files>
          <div class="selected-files-empty">No files selected</div>
        </div>
      </div>
    `;
  }

  protected renderFooterContent(): string {
    return `
      <div class="footer-left">
        <button class="clear-btn" data-action="clear" style="display: none;">Clear All</button>
      </div>
      <div class="footer-right">
        <span class="footer-hint" data-footer-hint>Changes apply immediately</span>
      </div>
    `;
  }

  protected setupModalEvents(): void {
    // Search input with debounce
    this.delegate('input', '[data-file-search]', (e) => {
      const input = e.target as HTMLInputElement;
      this._searchQuery = input.value.trim();

      if (this._searchTimeout) {
        clearTimeout(this._searchTimeout);
      }

      this._searchTimeout = setTimeout(() => {
        if (this._searchQuery.length >= 2) {
          this._vscode.postMessage({ type: 'searchFiles', query: this._searchQuery });
        } else {
          this.hideSearchResults();
        }
      }, 300);
    });

    // Open file checkbox click (via delegation)
    this.delegate('change', '.open-file-checkbox', (e) => {
      const checkbox = e.target as HTMLInputElement;
      const item = checkbox.closest('.open-file-item');
      const path = item?.getAttribute('data-path');

      if (path) {
        if (checkbox.checked) {
          this._vscode.postMessage({ type: 'getFileContent', filePath: path });
        } else {
          this._selectedFiles.delete(path);
          this.updateSelectedFilesList();
        }
      }
    });

    // Search result click (via delegation)
    this.delegate('click', '.file-search-result-item', (e) => {
      const item = e.target as HTMLElement;
      const path = item.getAttribute('data-path');

      if (path) {
        this._vscode.postMessage({ type: 'getFileContent', filePath: path });
        this.clearSearch();
      }
    });

    // Selected file remove (via delegation)
    this.delegate('click', '.selected-file-remove', (e) => {
      e.stopPropagation();
      const chip = (e.target as HTMLElement).closest('.selected-file-chip');
      const path = chip?.getAttribute('data-path');

      if (path) {
        this._selectedFiles.delete(path);
        this.updateSelectedFilesList();
        this.updateOpenFilesCheckboxes();
      }
    });

    // Clear button
    this.delegate('click', '[data-action="clear"]', () => {
      this._selectedFiles.clear();
      this.updateSelectedFilesList();
      this.updateOpenFilesCheckboxes();
    });

  }

  // ============================================
  // Modal Lifecycle Hooks
  // ============================================

  protected onOpen(): void {
    // Request open files from extension
    this._vscode.postMessage({ type: 'getOpenFiles' });
    this._vscode.postMessage({ type: 'fileModalOpened' });
  }

  protected onClose(): void {
    this._vscode.postMessage({ type: 'fileModalClosed' });
    this.clearSearch();
    // Don't clear selection - preserve it for next open
  }

  // ============================================
  // Subscription Handlers
  // ============================================

  private handleOpenFiles(files: string[]): void {
    this._openFiles = files || [];
    this.renderOpenFilesList();
  }

  private handleSearchResults(results: string[]): void {
    this._searchResults = results || [];
    this.renderSearchResults();
  }

  private handleFileContent(data: FileData): void {
    if (data?.path && data?.content !== undefined) {
      this._selectedFiles.set(data.path, data.content);
      this.updateSelectedFilesList();
      this.updateOpenFilesCheckboxes();
    }
  }

  // ============================================
  // Rendering
  // ============================================

  private renderOpenFilesList(): void {
    const container = this.query<HTMLElement>('[data-open-files]');
    const countEl = this.query<HTMLElement>('[data-open-count]');

    if (!container) return;

    if (countEl) {
      countEl.textContent = this._openFiles.length.toString();
    }

    if (this._openFiles.length === 0) {
      container.innerHTML = '<div class="file-search-no-results">No files currently open</div>';
      return;
    }

    container.innerHTML = this._openFiles.map(filePath => {
      const isSelected = this._selectedFiles.has(filePath);
      return `
        <div class="open-file-item" data-path="${this.escapeHtml(filePath)}">
          <input
            type="checkbox"
            class="open-file-checkbox"
            ${isSelected ? 'checked' : ''}
          />
          <span class="open-file-name" title="${this.escapeHtml(filePath)}">${this.escapeHtml(filePath)}</span>
        </div>
      `;
    }).join('');
  }

  private renderSearchResults(): void {
    const container = this.query<HTMLElement>('[data-search-results]');
    if (!container) return;

    if (this._searchResults.length === 0) {
      container.innerHTML = '<div class="file-search-no-results">No files found</div>';
      container.style.display = 'block';
      return;
    }

    container.innerHTML = this._searchResults.map(filePath => `
      <div class="file-search-result-item" data-path="${this.escapeHtml(filePath)}" title="${this.escapeHtml(filePath)}">
        ${this.escapeHtml(filePath)}
      </div>
    `).join('');

    container.style.display = 'block';
  }

  private hideSearchResults(): void {
    const container = this.query<HTMLElement>('[data-search-results]');
    if (container) {
      container.style.display = 'none';
      container.innerHTML = '';
    }
  }

  private clearSearch(): void {
    const input = this.query<HTMLInputElement>('[data-file-search]');
    if (input) {
      input.value = '';
    }
    this._searchQuery = '';
    this._searchResults = [];
    this.hideSearchResults();
  }

  private updateSelectedFilesList(): void {
    const container = this.query<HTMLElement>('[data-selected-files]');
    const countEl = this.query<HTMLElement>('[data-selected-count]');
    const clearBtn = this.query<HTMLElement>('[data-action="clear"]');

    if (!container) return;

    const count = this._selectedFiles.size;

    if (countEl) {
      countEl.textContent = count.toString();
    }

    if (clearBtn) {
      clearBtn.style.display = count > 0 ? 'inline-block' : 'none';
    }

    if (count === 0) {
      container.innerHTML = '<div class="selected-files-empty">No files selected</div>';
    } else {
      container.innerHTML = Array.from(this._selectedFiles.keys()).map(filePath => `
        <div class="selected-file-chip" data-path="${this.escapeHtml(filePath)}">
          <span class="selected-file-name" title="${this.escapeHtml(filePath)}">${this.escapeHtml(this.getFileName(filePath))}</span>
          <button class="selected-file-remove" title="Remove">×</button>
        </div>
      `).join('');
    }

    // Live sync — publish and notify extension immediately
    this.publish({ 'files.selected': this._selectedFiles });
    const filesData = Array.from(this._selectedFiles.entries()).map(([path, content]) => ({ path, content }));
    this._vscode.postMessage({ type: 'setSelectedFiles', files: filesData });

    if (this._onFilesChange) {
      this._onFilesChange(filesData);
    }
  }

  private updateOpenFilesCheckboxes(): void {
    const checkboxes = this.queryAll<HTMLInputElement>('.open-file-checkbox');
    checkboxes.forEach(checkbox => {
      const item = checkbox.closest('.open-file-item');
      const path = item?.getAttribute('data-path');
      if (path) {
        checkbox.checked = this._selectedFiles.has(path);
      }
    });
  }

  // ============================================
  // Actions
  // ============================================

  private commitSelection(): void {
    const filesData = Array.from(this._selectedFiles.entries()).map(([path, content]) => ({
      path,
      content
    }));

    // Notify extension
    this._vscode.postMessage({ type: 'setSelectedFiles', files: filesData });

    // Notify handler
    if (this._onFilesChange) {
      this._onFilesChange(filesData);
    }

    // Publish state
    this.publish({ 'files.selected': this._selectedFiles });

    this.close();
  }

  // ============================================
  // Utilities
  // ============================================

  private getFileName(filePath: string): string {
    const parts = filePath.split(/[/\\]/);
    return parts[parts.length - 1] || filePath;
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Set a handler for when files are committed.
   */
  onFilesChange(handler: FilesChangeHandler): void {
    this._onFilesChange = handler;
  }

  /**
   * Get currently selected files.
   */
  getSelectedFiles(): Map<string, string> {
    return new Map(this._selectedFiles);
  }

  /**
   * Clear the selection.
   */
  clearSelection(): void {
    this._selectedFiles.clear();
    this.updateSelectedFilesList();
    this.updateOpenFilesCheckboxes();
  }

  /**
   * Get file count.
   */
  getFileCount(): number {
    return this._selectedFiles.size;
  }
}
