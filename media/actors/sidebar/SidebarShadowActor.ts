/**
 * SidebarShadowActor
 *
 * Shadow DOM version of SidebarActor.
 * Actor OWNS its DOM instead of wrapping existing elements.
 *
 * Features:
 * - Chat history list with search
 * - Session selection and deletion
 * - Grouped by date (Today, Yesterday, This Week, etc.)
 * - Loading and empty states
 *
 * Publications:
 * - sidebar.selectedId: string | null - currently selected session ID
 * - sidebar.searchQuery: string - current search query
 *
 * Subscriptions:
 * - session.id: string | null - current session ID (for highlighting)
 */

import { ShadowActor } from '../../state/ShadowActor';
import { EventStateManager } from '../../state/EventStateManager';
import { sidebarShadowStyles } from './shadowStyles';

export interface HistoryItem {
  id: string;
  title: string;
  model: string;
  messageCount: number;
  updatedAt: number;
}

export interface SidebarState {
  sessions: HistoryItem[];
  selectedId: string | null;
  searchQuery: string;
  loading: boolean;
}

export type SessionSelectHandler = (sessionId: string) => void;
export type SessionDeleteHandler = (sessionId: string) => void;

export class SidebarShadowActor extends ShadowActor {
  // Internal state
  private _sessions: HistoryItem[] = [];
  private _selectedId: string | null = null;
  private _searchQuery = '';
  private _loading = false;

  // Handlers
  private _onSelect: SessionSelectHandler | null = null;
  private _onDelete: SessionDeleteHandler | null = null;

  // DOM elements (cached after render)
  private _listEl: HTMLElement | null = null;
  private _searchInput: HTMLInputElement | null = null;

  constructor(manager: EventStateManager, element: HTMLElement) {
    super({
      manager,
      element,
      styles: sidebarShadowStyles,
      publications: {
        'sidebar.selectedId': () => this._selectedId,
        'sidebar.searchQuery': () => this._searchQuery
      },
      subscriptions: {
        'session.id': (value: unknown) => this.handleSessionIdChange(value as string | null)
      }
    });

    // Render the sidebar
    this.renderSidebar();
  }

  // ============================================
  // Rendering
  // ============================================

  private renderSidebar(): void {
    this.render(`
      <div class="sidebar-container">
        <div class="header">
          <span class="title">Chat History</span>
        </div>
        <div class="search">
          <input
            type="text"
            class="search-input"
            placeholder="Search conversations..."
          />
        </div>
        <div class="list"></div>
      </div>
    `);

    // Cache DOM elements
    this._listEl = this.query('.list');
    this._searchInput = this.query('.search-input') as HTMLInputElement;

    // Setup event handlers
    this.delegate('input', '.search-input', (e) => {
      this._searchQuery = (e.target as HTMLInputElement).value;
      this.renderList();

      this.publish({
        'sidebar.searchQuery': this._searchQuery
      });
    });

    this.renderList();
  }

  private renderList(): void {
    if (!this._listEl) return;

    if (this._loading) {
      this._listEl.innerHTML = `
        <div class="loading">
          <div class="loading-spinner"></div>
        </div>
      `;
      return;
    }

    const filtered = this.getFilteredSessions();

    if (filtered.length === 0) {
      this._listEl.innerHTML = `
        <div class="empty">
          <div class="empty-icon">💬</div>
          <div class="empty-text">
            ${this._searchQuery ? 'No matching conversations' : 'No chat history yet'}
          </div>
        </div>
      `;
      return;
    }

    // Group by date
    const groups = this.groupByDate(filtered);

    let html = '';
    for (const [label, sessions] of Object.entries(groups)) {
      html += `<div class="group-header">${label}</div>`;
      for (const session of sessions) {
        const isActive = session.id === this._selectedId;
        const isReasoner = session.model === 'deepseek-reasoner';

        html += `
          <div class="item${isActive ? ' active' : ''}" data-session-id="${this.escapeHtml(session.id)}">
            <div class="item-title">${this.escapeHtml(session.title)}</div>
            <div class="item-meta">
              <span class="item-model${isReasoner ? ' reasoner' : ''}">
                ${isReasoner ? '🧠' : '💬'} ${isReasoner ? 'R1' : 'Chat'}
              </span>
              <span class="item-date">${this.formatDate(session.updatedAt)}</span>
              <span class="item-count">${session.messageCount} msgs</span>
            </div>
            <button class="item-delete" data-delete-id="${this.escapeHtml(session.id)}" title="Delete">🗑️</button>
          </div>
        `;
      }
    }

    this._listEl.innerHTML = html;

    // Bind click handlers using delegation
    this.setupListHandlers();
  }

  private setupListHandlers(): void {
    // Item selection
    this.delegate('click', '.item', (e) => {
      // Ignore if clicking delete button
      if ((e.target as HTMLElement).closest('.item-delete')) return;

      const item = (e.target as HTMLElement).closest('.item') as HTMLElement;
      const id = item?.getAttribute('data-session-id');
      if (id) {
        this._onSelect?.(id);
      }
    });

    // Delete button
    this.delegate('click', '.item-delete', (e) => {
      e.stopPropagation();
      const btn = e.target as HTMLElement;
      const id = btn.getAttribute('data-delete-id');
      if (id) {
        this._onDelete?.(id);
      }
    });
  }

  private updateSelection(): void {
    if (!this._listEl) return;

    this._listEl.querySelectorAll('.item').forEach(item => {
      const id = item.getAttribute('data-session-id');
      item.classList.toggle('active', id === this._selectedId);
    });
  }

  // ============================================
  // Subscription Handlers
  // ============================================

  private handleSessionIdChange(sessionId: string | null): void {
    this._selectedId = sessionId;
    this.updateSelection();

    this.publish({
      'sidebar.selectedId': sessionId
    });
  }

  // ============================================
  // Helpers
  // ============================================

  private getFilteredSessions(): HistoryItem[] {
    if (!this._searchQuery) {
      return this._sessions;
    }

    const query = this._searchQuery.toLowerCase();
    return this._sessions.filter(s =>
      s.title.toLowerCase().includes(query)
    );
  }

  private groupByDate(sessions: HistoryItem[]): Record<string, HistoryItem[]> {
    const groups: Record<string, HistoryItem[]> = {};
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    for (const session of sessions) {
      const age = now - session.updatedAt;
      let label: string;

      if (age < dayMs) {
        label = 'Today';
      } else if (age < 2 * dayMs) {
        label = 'Yesterday';
      } else if (age < 7 * dayMs) {
        label = 'This Week';
      } else if (age < 30 * dayMs) {
        label = 'This Month';
      } else {
        label = 'Older';
      }

      if (!groups[label]) {
        groups[label] = [];
      }
      groups[label].push(session);
    }

    return groups;
  }

  private formatDate(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();

    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Set session select handler
   */
  onSelect(handler: SessionSelectHandler): void {
    this._onSelect = handler;
  }

  /**
   * Set session delete handler
   */
  onDelete(handler: SessionDeleteHandler): void {
    this._onDelete = handler;
  }

  /**
   * Set the sessions list
   */
  setSessions(sessions: HistoryItem[]): void {
    this._sessions = sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    this._loading = false;
    this.renderList();
  }

  /**
   * Add or update a session
   */
  updateSession(session: HistoryItem): void {
    const index = this._sessions.findIndex(s => s.id === session.id);
    if (index >= 0) {
      this._sessions[index] = session;
    } else {
      this._sessions.unshift(session);
    }
    this._sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    this.renderList();
  }

  /**
   * Remove a session
   */
  removeSession(sessionId: string): void {
    this._sessions = this._sessions.filter(s => s.id !== sessionId);
    this.renderList();
  }

  /**
   * Set loading state
   */
  setLoading(loading: boolean): void {
    this._loading = loading;
    this.renderList();
  }

  /**
   * Clear search
   */
  clearSearch(): void {
    this._searchQuery = '';
    if (this._searchInput) {
      this._searchInput.value = '';
    }
    this.renderList();

    this.publish({
      'sidebar.searchQuery': ''
    });
  }

  /**
   * Get sessions
   */
  getSessions(): HistoryItem[] {
    return [...this._sessions];
  }

  /**
   * Get current state
   */
  getState(): SidebarState {
    return {
      sessions: [...this._sessions],
      selectedId: this._selectedId,
      searchQuery: this._searchQuery,
      loading: this._loading
    };
  }

  // ============================================
  // Lifecycle
  // ============================================

  destroy(): void {
    this._listEl = null;
    this._searchInput = null;
    this._onSelect = null;
    this._onDelete = null;
    super.destroy();
  }
}
