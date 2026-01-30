/**
 * SidebarActor
 *
 * Handles the history sidebar showing past chat sessions.
 *
 * Publications:
 * - sidebar.selectedId: string | null - currently selected session ID
 * - sidebar.searchQuery: string - current search query
 *
 * Subscriptions:
 * - session.id: string | null - current session ID (for highlighting)
 */

import { EventStateActor } from '../../state/EventStateActor';
import { EventStateManager } from '../../state/EventStateManager';
import type { ActorConfig } from '../../state/types';
import { sidebarStyles as styles } from './styles';

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

export class SidebarActor extends EventStateActor {
  private static stylesInjected = false;

  // Internal state
  private _sessions: HistoryItem[] = [];
  private _selectedId: string | null = null;
  private _searchQuery = '';
  private _loading = false;

  // Handlers
  private _onSelect: SessionSelectHandler | null = null;
  private _onDelete: SessionDeleteHandler | null = null;

  // DOM elements
  private _listEl: HTMLElement | null = null;
  private _searchInput: HTMLInputElement | null = null;

  constructor(manager: EventStateManager, element: HTMLElement) {
    const config: ActorConfig = {
      manager,
      element,
      publications: {
        'sidebar.selectedId': () => this._selectedId,
        'sidebar.searchQuery': () => this._searchQuery
      },
      subscriptions: {
        'session.id': (value: unknown) => this.handleSessionIdChange(value as string | null)
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
    if (SidebarActor.stylesInjected) return;
    if (typeof document === 'undefined') return;

    const style = document.createElement('style');
    style.setAttribute('data-actor', 'sidebar');
    style.textContent = styles;
    document.head.appendChild(style);
    SidebarActor.stylesInjected = true;
  }

  /**
   * Setup DOM structure
   */
  private setupDOM(): void {
    const element = this.getElement();
    element.className = 'sidebar-container';

    element.innerHTML = `
      <div class="sidebar-header">
        <span class="sidebar-title">Chat History</span>
      </div>
      <div class="sidebar-search">
        <input
          type="text"
          class="sidebar-search-input"
          placeholder="Search conversations..."
        />
      </div>
      <div class="sidebar-list"></div>
    `;

    this._listEl = element.querySelector('.sidebar-list');
    this._searchInput = element.querySelector('.sidebar-search-input');

    this.renderList();
  }

  /**
   * Bind event handlers
   */
  private bindEvents(): void {
    // Search input
    this._searchInput?.addEventListener('input', (e) => {
      this._searchQuery = (e.target as HTMLInputElement).value;
      this.renderList();

      this.publish({
        'sidebar.searchQuery': this._searchQuery
      });
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
  // Rendering
  // ============================================

  private renderList(): void {
    if (!this._listEl) return;

    if (this._loading) {
      this._listEl.innerHTML = `
        <div class="sidebar-loading">
          <div class="sidebar-loading-spinner"></div>
        </div>
      `;
      return;
    }

    const filtered = this.getFilteredSessions();

    if (filtered.length === 0) {
      this._listEl.innerHTML = `
        <div class="sidebar-empty">
          <div class="sidebar-empty-icon">💬</div>
          <div class="sidebar-empty-text">
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
      html += `<div class="sidebar-group-header">${label}</div>`;
      for (const session of sessions) {
        const isActive = session.id === this._selectedId;
        const isReasoner = session.model === 'deepseek-reasoner';

        html += `
          <div class="sidebar-item${isActive ? ' active' : ''}" data-session-id="${this.escapeHtml(session.id)}">
            <div class="sidebar-item-title">${this.escapeHtml(session.title)}</div>
            <div class="sidebar-item-meta">
              <span class="sidebar-item-model${isReasoner ? ' reasoner' : ''}">
                ${isReasoner ? '🧠' : '💬'} ${isReasoner ? 'R1' : 'Chat'}
              </span>
              <span class="sidebar-item-date">${this.formatDate(session.updatedAt)}</span>
              <span class="sidebar-item-count">${session.messageCount} msgs</span>
            </div>
          </div>
        `;
      }
    }

    this._listEl.innerHTML = html;

    // Bind click handlers
    this._listEl.querySelectorAll('.sidebar-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.getAttribute('data-session-id');
        if (id) {
          this._onSelect?.(id);
        }
      });
    });
  }

  private updateSelection(): void {
    if (!this._listEl) return;

    this._listEl.querySelectorAll('.sidebar-item').forEach(item => {
      const id = item.getAttribute('data-session-id');
      item.classList.toggle('active', id === this._selectedId);
    });
  }

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

  /**
   * Destroy and cleanup
   */
  destroy(): void {
    this._listEl = null;
    this._searchInput = null;
    this._onSelect = null;
    this._onDelete = null;
    super.destroy();
  }

  /**
   * Reset styles injection flag and remove style tag (for testing)
   */
  static resetStylesInjected(): void {
    SidebarActor.stylesInjected = false;
    if (typeof document !== 'undefined') {
      const styleTag = document.querySelector('style[data-actor="sidebar"]');
      if (styleTag) {
        styleTag.remove();
      }
    }
  }
}
