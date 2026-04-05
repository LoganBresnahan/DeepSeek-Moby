/**
 * HistoryShadowActor
 *
 * Shadow DOM actor for the history modal.
 * Displays chat history in a modal with search, date groupings,
 * and actions (open, rename, export, delete).
 *
 * Publications:
 * - history.modal.visible: boolean - whether the modal is open
 * - history.modal.open: boolean - reset to false on close (enables repeated opens)
 *
 * Subscriptions:
 * - history.modal.open: boolean - request to open/close modal
 * - history.sessions: HistorySession[] - session data from extension
 * - session.id: string - current active session ID
 */

import { ShadowActor } from '../../state/ShadowActor';
import { EventStateManager } from '../../state/EventStateManager';
import { historyShadowStyles } from './shadowStyles';

// ============================================
// Types
// ============================================

export interface HistoryMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date | string;
}

export interface HistorySession {
  id: string;
  title: string;
  messages?: HistoryMessage[];
  createdAt: Date | string;
  updatedAt: Date | string;
  model: string;
  parentSessionId?: string;
  forkSequence?: number;
  eventCount?: number;
  firstUserMessage?: string;
  lastActivityPreview?: string;
}

interface VSCodeAPI {
  postMessage(message: unknown): void;
}

type ExportFormat = 'json' | 'markdown' | 'txt';

interface DateGroup {
  label: string;
  sessions: HistorySession[];
}

// ============================================
// HistoryShadowActor
// ============================================

export class HistoryShadowActor extends ShadowActor {
  private _visible = false;
  private _sessions: HistorySession[] = [];
  private _filteredSessions: HistorySession[] = [];
  private _currentSessionId: string | null = null;
  private _searchQuery = '';
  private _openMenuId: string | null = null;
  private _exportDropdownOpen = false;
  private _confirmingDeleteAll = false;
  private _confirmingDeleteId: string | null = null;
  private _vscode: VSCodeAPI;

  // Bound handlers for cleanup
  private _boundHandleKeydown: (e: KeyboardEvent) => void;
  private _boundHandleOutsideClick: (e: MouseEvent) => void;

  constructor(manager: EventStateManager, element: HTMLElement, vscode: VSCodeAPI) {
    super({
      manager,
      element,
      styles: historyShadowStyles,
      publications: {
        'history.modal.visible': () => this._visible
      },
      subscriptions: {
        'history.modal.open': (value: unknown) => this.handleOpenRequest(value as boolean),
        'history.sessions': (value: unknown) => this.handleSessionsUpdate(value as HistorySession[]),
        'session.id': (value: unknown) => this.handleCurrentSessionChange(value as string)
      }
    });

    this._vscode = vscode;

    // Bind handlers
    this._boundHandleKeydown = this.handleKeydown.bind(this);
    this._boundHandleOutsideClick = this.handleOutsideClick.bind(this);

    // Render initial state
    this.renderModal();
    this.setupEventHandlers();
  }

  // ============================================
  // Rendering
  // ============================================

  private renderModal(): void {
    this.render(`
      <div class="history-backdrop" data-history-backdrop>
        <div class="history-modal" data-history-modal>
          <div class="history-header">
            <div class="history-title">
              <span class="history-title-icon">📋</span>
              <span>Chat History</span>
            </div>
            <button class="history-close" data-action="close" title="Close (Esc)">✕</button>
          </div>
          <div class="history-search">
            <input
              type="text"
              class="history-search-input"
              placeholder="Search history..."
              data-search-input
            />
          </div>
          <div class="history-list" data-history-list>
            ${this.renderHistoryList()}
          </div>
          <div class="history-footer">
            <div class="history-footer-left">
              <span class="history-count" data-history-count>
                ${this._filteredSessions.length} session${this._filteredSessions.length !== 1 ? 's' : ''}
              </span>
            </div>
            <div class="history-footer-right">
              <div class="export-dropdown-container">
                <button class="history-btn history-btn-secondary" data-action="exportAll">
                  📤 Export All ▾
                </button>
                <div class="export-dropdown" data-export-dropdown>
                  <div class="export-dropdown-item" data-export-format="json">📄 JSON</div>
                  <div class="export-dropdown-item" data-export-format="markdown">📝 Markdown</div>
                  <div class="export-dropdown-item" data-export-format="txt">📃 Plain Text</div>
                </div>
              </div>
              <button class="history-btn history-btn-danger" data-action="deleteAll">
                🗑️ Delete All
              </button>
            </div>
          </div>
        </div>
      </div>
    `);
  }

  private renderHistoryList(): string {
    if (this._filteredSessions.length === 0) {
      return `<div class="history-empty">No chat history found</div>`;
    }

    const groups = this.groupSessionsByDate(this._filteredSessions);
    return groups.map(group => this.renderDateGroup(group)).join('');
  }

  private renderDateGroup(group: DateGroup): string {
    return `
      <div class="history-group">
        <div class="history-group-title">${this.escapeHtml(group.label)}</div>
        ${group.sessions.map(session => this.renderHistoryEntry(session)).join('')}
      </div>
    `;
  }

  private renderHistoryEntry(session: HistorySession): string {
    const isActive = session.id === this._currentSessionId;
    const preview = this.getSessionPreview(session);
    const timestamp = this.formatFullTimestamp(session.updatedAt);
    const modelIcon = session.model === 'deepseek-reasoner' ? '🧠' : '💬';
    const modelLabel = session.model === 'deepseek-reasoner' ? 'R1' : 'Chat';
    const messageCount = session.eventCount || session.messages?.length || 0;

    // Fork badge: show "Fork of [parent]" if this session has a parent
    const forkBadge = session.parentSessionId
      ? this.renderForkBadge(session.parentSessionId)
      : '';

    // Fork count: number of sessions forked from this one
    const forkCount = this._sessions.filter(s => s.parentSessionId === session.id).length;
    const forkCountBadge = forkCount > 0
      ? `<span class="history-entry-forks">\u2442 ${forkCount}</span>`
      : '';

    return `
      <div class="history-entry${isActive ? ' active' : ''}" data-session-id="${session.id}">
        <div class="history-entry-active-indicator"></div>
        <div class="history-entry-content">
          <div class="history-entry-title">${this.escapeHtml(session.title || 'Untitled')}</div>
          ${forkBadge}
          <div class="history-entry-preview">${this.escapeHtml(preview)}</div>
          <div class="history-entry-meta">
            <span class="history-entry-timestamp">${timestamp}</span>
            <span class="history-entry-model">${modelIcon} ${modelLabel}</span>
            <span class="history-entry-messages">💬 ${messageCount}</span>
            ${forkCountBadge}
          </div>
        </div>
        <button class="history-entry-menu" data-entry-menu="${session.id}" title="Actions">⋮</button>
        <div class="history-entry-dropdown${this._openMenuId === session.id ? ' open' : ''}" data-entry-dropdown="${session.id}">
          <div class="history-entry-dropdown-item" data-entry-action="rename" data-session-id="${session.id}">✏️ Rename</div>
          <div class="history-entry-dropdown-item" data-entry-action="export" data-session-id="${session.id}">📤 Export</div>
          <div class="export-submenu" data-export-submenu="${session.id}" style="display: none;">
            <div class="history-entry-dropdown-item" data-entry-action="exportFormat" data-session-id="${session.id}" data-format="json">📄 JSON</div>
            <div class="history-entry-dropdown-item" data-entry-action="exportFormat" data-session-id="${session.id}" data-format="markdown">📝 Markdown</div>
            <div class="history-entry-dropdown-item" data-entry-action="exportFormat" data-session-id="${session.id}" data-format="txt">📃 Plain Text</div>
          </div>
          <div class="history-entry-dropdown-divider"></div>
          <div class="history-entry-dropdown-item danger" data-entry-action="delete" data-session-id="${session.id}">🗑️ Delete</div>
        </div>
      </div>
    `;
  }

  private updateHistoryList(): void {
    const listEl = this.query<HTMLElement>('[data-history-list]');
    const countEl = this.query<HTMLElement>('[data-history-count]');

    if (listEl) {
      listEl.innerHTML = this.renderHistoryList();
    }

    if (countEl) {
      const count = this._filteredSessions.length;
      countEl.textContent = `${count} session${count !== 1 ? 's' : ''}`;
    }
  }

  // ============================================
  // Date Grouping
  // ============================================

  private groupSessionsByDate(sessions: HistorySession[]): DateGroup[] {
    const now = new Date();
    const today = this.getDateStart(now);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const thisWeekStart = new Date(today);
    thisWeekStart.setDate(thisWeekStart.getDate() - thisWeekStart.getDay());
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisYearStart = new Date(now.getFullYear(), 0, 1);

    const groups: Map<string, HistorySession[]> = new Map();
    const groupOrder = ['Today', 'Yesterday', 'This Week', 'This Month', 'This Year', 'Older'];

    for (const session of sessions) {
      const date = new Date(session.updatedAt);
      const dateStart = this.getDateStart(date);

      let groupLabel: string;
      if (dateStart.getTime() === today.getTime()) {
        groupLabel = 'Today';
      } else if (dateStart.getTime() === yesterday.getTime()) {
        groupLabel = 'Yesterday';
      } else if (date >= thisWeekStart) {
        groupLabel = 'This Week';
      } else if (date >= thisMonthStart) {
        groupLabel = 'This Month';
      } else if (date >= thisYearStart) {
        groupLabel = 'This Year';
      } else {
        groupLabel = 'Older';
      }

      if (!groups.has(groupLabel)) {
        groups.set(groupLabel, []);
      }
      groups.get(groupLabel)!.push(session);
    }

    // Sort sessions within each group by updatedAt (newest first)
    for (const sessions of groups.values()) {
      sessions.sort((a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
    }

    // Return groups in order
    return groupOrder
      .filter(label => groups.has(label))
      .map(label => ({ label, sessions: groups.get(label)! }));
  }

  private getDateStart(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  // ============================================
  // Formatting Helpers
  // ============================================

  private formatFullTimestamp(dateInput: Date | string): string {
    const date = new Date(dateInput);
    const pad = (n: number) => n.toString().padStart(2, '0');

    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    const seconds = pad(date.getSeconds());

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  private renderForkBadge(parentSessionId: string): string {
    const parentSession = this._sessions.find(s => s.id === parentSessionId);
    const parentTitle = parentSession
      ? this.escapeHtml(parentSession.title || 'Untitled')
      : parentSessionId.substring(0, 8);
    return `<div class="history-entry-fork-badge">\u2442 Fork of <span class="fork-badge-parent" data-fork-parent="${parentSessionId}">${parentTitle}</span></div>`;
  }

  private getSessionPreview(session: HistorySession): string {
    // Use pre-computed metadata from the session (populated by updateSessionMetadata)
    if (session.lastActivityPreview) {
      return session.lastActivityPreview;
    }

    if (session.firstUserMessage) {
      return session.firstUserMessage;
    }

    // Fallback to messages array if present (legacy)
    if (session.messages && session.messages.length > 0) {
      const lastUserMsg = [...session.messages]
        .reverse()
        .find(m => m.role === 'user');
      if (lastUserMsg) {
        const content = lastUserMsg.content || '';
        return content.length > 100 ? content.substring(0, 100) + '...' : content;
      }
    }

    return 'No messages';
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ============================================
  // Event Handlers
  // ============================================

  private setupEventHandlers(): void {
    // Close button
    this.delegate('click', '[data-action="close"]', () => {
      this.close();
    });

    // Backdrop click
    this.delegate('click', '[data-history-backdrop]', (e) => {
      if ((e.target as HTMLElement).hasAttribute('data-history-backdrop')) {
        this.close();
      }
    });

    // Search input
    this.delegate('input', '[data-search-input]', (e) => {
      this._searchQuery = (e.target as HTMLInputElement).value;
      this.filterSessions();
    });

    // Fork badge parent click (navigate to parent session)
    this.delegate('click', '.fork-badge-parent', (e) => {
      e.stopPropagation();
      const parentId = (e.target as HTMLElement).getAttribute('data-fork-parent');
      if (parentId) {
        this.openSession(parentId);
      }
    });

    // Session entry click (open)
    this.delegate('click', '.history-entry', (e, entry) => {
      const target = e.target as HTMLElement;
      // Don't open if clicking menu button, dropdown, or fork badge parent
      if (target.closest('[data-entry-menu]') || target.closest('[data-entry-dropdown]') || target.closest('.fork-badge-parent')) {
        return;
      }
      const sessionId = entry.getAttribute('data-session-id');
      if (sessionId) {
        this.openSession(sessionId);
      }
    });

    // Entry menu button
    this.delegate('click', '[data-entry-menu]', (e) => {
      e.stopPropagation();
      const sessionId = (e.target as HTMLElement).getAttribute('data-entry-menu');
      if (sessionId) {
        this.toggleEntryMenu(sessionId);
      }
    });

    // Entry dropdown actions
    this.delegate('click', '[data-entry-action]', (e) => {
      e.stopPropagation();
      const target = e.target as HTMLElement;
      const action = target.getAttribute('data-entry-action');
      const sessionId = target.getAttribute('data-session-id');
      const format = target.getAttribute('data-format') as ExportFormat | null;

      if (action === 'rename' && sessionId) {
        this.renameSession(sessionId);
      } else if (action === 'export' && sessionId) {
        this.toggleExportSubmenu(sessionId);
      } else if (action === 'exportFormat' && sessionId && format) {
        this.exportSession(sessionId, format);
      } else if (action === 'delete' && sessionId) {
        this.deleteSession(sessionId);
      }
    });

    // Export All button
    this.delegate('click', '[data-action="exportAll"]', (e) => {
      e.stopPropagation();
      this.toggleExportDropdown();
    });

    // Export format selection
    this.delegate('click', '[data-export-format]', (e) => {
      const format = (e.target as HTMLElement).getAttribute('data-export-format') as ExportFormat;
      if (format) {
        this.exportAll(format);
      }
    });

    // Delete All button
    this.delegate('click', '[data-action="deleteAll"]', () => {
      this.deleteAll();
    });

    // Delete All confirmation buttons
    this.delegate('click', '[data-action="confirmDeleteAll"]', (e) => {
      e.stopPropagation();
      this.confirmDeleteAll();
    });

    this.delegate('click', '[data-action="cancelDeleteAll"]', (e) => {
      e.stopPropagation();
      this.cancelDeleteAll();
    });

    // Delete Session confirmation buttons
    this.delegate('click', '[data-action="confirmDelete"]', (e) => {
      e.stopPropagation();
      const sessionId = (e.target as HTMLElement).getAttribute('data-session-id');
      if (sessionId) {
        this.confirmDeleteSession(sessionId);
      }
    });

    this.delegate('click', '[data-action="cancelDelete"]', (e) => {
      e.stopPropagation();
      const sessionId = (e.target as HTMLElement).getAttribute('data-session-id');
      if (sessionId) {
        this.cancelDeleteSession(sessionId);
      }
    });
  }

  private handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (this._openMenuId) {
        this.closeAllMenus();
      } else if (this._exportDropdownOpen) {
        this.closeExportDropdown();
      } else {
        this.close();
      }
    }
  }

  private handleOutsideClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;

    // Close entry menus if clicking outside
    if (this._openMenuId && !target.closest('[data-entry-dropdown]') && !target.closest('[data-entry-menu]')) {
      this.closeAllMenus();
    }

    // Close export dropdown if clicking outside
    if (this._exportDropdownOpen && !target.closest('.export-dropdown-container')) {
      this.closeExportDropdown();
    }
  }

  // ============================================
  // Modal Control
  // ============================================

  private handleOpenRequest(open: boolean): void {
    if (open) {
      this.open();
    } else {
      this.close();
    }
  }

  open(): void {
    if (this._visible) return;

    this._visible = true;
    this._searchQuery = '';

    // Request sessions from extension
    this._vscode.postMessage({ type: 'getHistorySessions' });

    // Update UI
    const backdrop = this.query<HTMLElement>('[data-history-backdrop]');
    if (backdrop) {
      backdrop.classList.add('visible');
    }

    // Clear search input
    const searchInput = this.query<HTMLInputElement>('[data-search-input]');
    if (searchInput) {
      searchInput.value = '';
      // Focus search after animation
      setTimeout(() => searchInput.focus(), 200);
    }

    // Add event listeners
    document.addEventListener('keydown', this._boundHandleKeydown);
    document.addEventListener('click', this._boundHandleOutsideClick);

    this.publish({ 'history.modal.visible': true });
  }

  close(): void {
    if (!this._visible) return;

    this._visible = false;
    this._openMenuId = null;
    this._exportDropdownOpen = false;

    // Reset pending confirmations
    if (this._confirmingDeleteAll) {
      this._confirmingDeleteAll = false;
      this.restoreDeleteAllButton();
    }
    this._confirmingDeleteId = null;

    // Update UI
    const backdrop = this.query<HTMLElement>('[data-history-backdrop]');
    if (backdrop) {
      backdrop.classList.remove('visible');
    }

    // Remove event listeners
    document.removeEventListener('keydown', this._boundHandleKeydown);
    document.removeEventListener('click', this._boundHandleOutsideClick);

    // Publish visible state change
    this.publish({ 'history.modal.visible': false });

    // Reset the request state so the next open request triggers a change
    // (Without this, clicking the button twice wouldn't reopen the modal
    // because the state manager wouldn't detect a change from true -> true)
    this.manager.publishDirect('history.modal.open', false, this.actorId);
  }

  // ============================================
  // Subscription Handlers
  // ============================================

  private handleSessionsUpdate(sessions: HistorySession[]): void {
    this._sessions = sessions || [];
    this.filterSessions();
  }

  private handleCurrentSessionChange(sessionId: string): void {
    this._currentSessionId = sessionId;
    this.updateHistoryList();
  }

  // ============================================
  // Search & Filter
  // ============================================

  private filterSessions(): void {
    if (!this._searchQuery.trim()) {
      this._filteredSessions = [...this._sessions];
    } else {
      const query = this._searchQuery.toLowerCase();
      this._filteredSessions = this._sessions.filter(session => {
        // Search in title
        if (session.title?.toLowerCase().includes(query)) return true;

        // Search in messages
        if (session.messages?.some(msg =>
          msg.content?.toLowerCase().includes(query)
        )) return true;

        return false;
      });
    }

    this.updateHistoryList();
  }

  // ============================================
  // Session Actions
  // ============================================

  private openSession(sessionId: string): void {
    this._vscode.postMessage({ type: 'switchToSession', sessionId });
    this.close();
  }

  private renameSession(sessionId: string): void {
    this.closeAllMenus();

    const entry = this.query<HTMLElement>(`[data-session-id="${sessionId}"]`);
    if (!entry) return;

    const titleEl = entry.querySelector('.history-entry-title');
    if (!titleEl) return;

    const session = this._sessions.find(s => s.id === sessionId);
    if (!session) return;

    const currentTitle = session.title || 'Untitled';

    // Replace title with input
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'history-entry-rename-input';
    input.value = currentTitle;

    titleEl.replaceWith(input);
    input.focus();
    input.select();

    const save = () => {
      const newTitle = input.value.trim() || 'Untitled';

      // Restore title element
      const span = document.createElement('div');
      span.className = 'history-entry-title';
      span.textContent = newTitle;
      input.replaceWith(span);

      // Send rename request
      if (newTitle !== currentTitle) {
        this._vscode.postMessage({ type: 'renameSession', sessionId, title: newTitle });
      }
    };

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        input.blur();
      } else if (e.key === 'Escape') {
        input.value = currentTitle;
        input.blur();
      }
    });
  }

  private exportSession(sessionId: string, format: ExportFormat): void {
    this.closeAllMenus();
    this._vscode.postMessage({ type: 'exportSession', sessionId, format });
  }

  private deleteSession(sessionId: string): void {
    // Show inline confirmation instead of window.confirm (which fails in VS Code webviews)
    this._confirmingDeleteId = sessionId;
    const deleteItem = this.query<HTMLElement>(`[data-entry-action="delete"][data-session-id="${sessionId}"]`);
    if (!deleteItem) return;

    const container = document.createElement('div');
    container.className = 'delete-confirm-entry';
    container.setAttribute('data-delete-confirm', sessionId);
    container.innerHTML = `
      <span class="delete-confirm-text">Delete?</span>
      <button class="history-btn history-btn-secondary history-btn-sm" data-action="cancelDelete" data-session-id="${sessionId}">No</button>
      <button class="history-btn history-btn-danger history-btn-sm" data-action="confirmDelete" data-session-id="${sessionId}">Yes</button>
    `;
    deleteItem.replaceWith(container);
  }

  private confirmDeleteSession(sessionId: string): void {
    this._confirmingDeleteId = null;
    this._vscode.postMessage({ type: 'deleteSession', sessionId });
    this.closeAllMenus();
  }

  private cancelDeleteSession(_sessionId: string): void {
    this._confirmingDeleteId = null;
    this.closeAllMenus();
    // Re-render the list to restore the dropdown item
    this.updateHistoryList();
  }

  // ============================================
  // Bulk Actions
  // ============================================

  private exportAll(format: ExportFormat): void {
    this.closeExportDropdown();
    this._vscode.postMessage({ type: 'exportAllHistory', format });
  }

  private deleteAll(): void {
    // Show inline confirmation instead of window.confirm (which fails in VS Code webviews)
    this._confirmingDeleteAll = true;
    const btn = this.query<HTMLElement>('[data-action="deleteAll"]');
    if (!btn) return;

    const container = document.createElement('div');
    container.className = 'delete-confirm-inline';
    container.setAttribute('data-delete-all-confirm', '');
    container.innerHTML = `
      <span class="delete-confirm-text">Delete all?</span>
      <button class="history-btn history-btn-secondary history-btn-sm" data-action="cancelDeleteAll">Cancel</button>
      <button class="history-btn history-btn-danger history-btn-sm" data-action="confirmDeleteAll">Delete</button>
    `;
    btn.replaceWith(container);
  }

  private confirmDeleteAll(): void {
    this._confirmingDeleteAll = false;
    this._vscode.postMessage({ type: 'clearAllHistory' });
    this.restoreDeleteAllButton();
  }

  private cancelDeleteAll(): void {
    this._confirmingDeleteAll = false;
    this.restoreDeleteAllButton();
  }

  private restoreDeleteAllButton(): void {
    const container = this.query<HTMLElement>('[data-delete-all-confirm]');
    if (!container) return;

    const btn = document.createElement('button');
    btn.className = 'history-btn history-btn-danger';
    btn.setAttribute('data-action', 'deleteAll');
    btn.innerHTML = '🗑️ Delete All';
    container.replaceWith(btn);
  }

  // ============================================
  // Menu Control
  // ============================================

  private toggleEntryMenu(sessionId: string): void {
    if (this._openMenuId === sessionId) {
      this.closeAllMenus();
    } else {
      this.closeAllMenus();
      this._openMenuId = sessionId;

      const dropdown = this.query<HTMLElement>(`[data-entry-dropdown="${sessionId}"]`);
      if (dropdown) {
        dropdown.classList.add('open');

        // Position dropdown: prefer below, flip above if clipped at bottom,
        // but stay below if flipping would clip at top
        requestAnimationFrame(() => {
          const list = this.query<HTMLElement>('.history-list');
          if (!list) return;
          const listRect = list.getBoundingClientRect();

          // Try below first
          dropdown.style.top = '100%';
          dropdown.style.bottom = 'auto';
          const belowRect = dropdown.getBoundingClientRect();

          if (belowRect.bottom > listRect.bottom) {
            // Clipped at bottom — try above
            dropdown.style.top = 'auto';
            dropdown.style.bottom = '100%';
            const aboveRect = dropdown.getBoundingClientRect();

            if (aboveRect.top < listRect.top) {
              // Clipped at top too — stay below (lesser evil, list can scroll)
              dropdown.style.top = '100%';
              dropdown.style.bottom = 'auto';
            }
          }
        });
      }
    }
  }

  private toggleExportSubmenu(sessionId: string): void {
    const submenu = this.query<HTMLElement>(`[data-export-submenu="${sessionId}"]`);
    if (submenu) {
      const isVisible = submenu.style.display !== 'none';
      submenu.style.display = isVisible ? 'none' : 'block';
    }
  }

  private closeAllMenus(): void {
    this._openMenuId = null;

    this.queryAll<HTMLElement>('.history-entry-dropdown').forEach(el => {
      el.classList.remove('open');
    });

    this.queryAll<HTMLElement>('[data-export-submenu]').forEach(el => {
      el.style.display = 'none';
    });
  }

  private toggleExportDropdown(): void {
    this._exportDropdownOpen = !this._exportDropdownOpen;

    const dropdown = this.query<HTMLElement>('[data-export-dropdown]');
    if (dropdown) {
      dropdown.classList.toggle('open', this._exportDropdownOpen);
    }
  }

  private closeExportDropdown(): void {
    this._exportDropdownOpen = false;

    const dropdown = this.query<HTMLElement>('[data-export-dropdown]');
    if (dropdown) {
      dropdown.classList.remove('open');
    }
  }

  // ============================================
  // Public API
  // ============================================

  isVisible(): boolean {
    return this._visible;
  }

  getSessions(): HistorySession[] {
    return [...this._sessions];
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
