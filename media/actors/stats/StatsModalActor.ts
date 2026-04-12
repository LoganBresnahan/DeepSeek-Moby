/**
 * StatsModalActor
 *
 * Modal for displaying DeepSeek and Tavily account usage statistics.
 * Shows balance, session counts, and API usage information.
 *
 * Publications:
 * - stats.modal.visible: boolean
 *
 * Subscriptions:
 * - stats.modal.open: boolean
 * - stats.data: stats payload from extension
 */

import { ModalShadowActor, ModalConfig } from '../../state/ModalShadowActor';
import { EventStateManager } from '../../state/EventStateManager';
import type { VSCodeAPI } from '../../state/types';
import { statsShadowStyles } from './shadowStyles';
import { createLogger } from '../../logging';

const log = createLogger('StatsModal');

interface StatsData {
  stats?: {
    totalSessions: number;
    totalMessages: number;
    totalTokens: number;
  };
  balance?: {
    available: boolean;  // is_available — whether account can make API calls
    balance: string;     // total_balance — dollar amount as string
    currency: string;
  } | null;
  tavilyStats?: {
    totalSearches: number;
    basicSearches: number;
    advancedSearches: number;
    totalCreditsUsed: number;
  };
  tavilyApiUsage?: {
    used: number;
    limit: number | null;
    remaining: number | null;
    plan: string;
  } | null;
}

export class StatsModalActor extends ModalShadowActor {
  private _data: StatsData | null = null;
  private _loading = true;

  constructor(manager: EventStateManager, element: HTMLElement, vscode: VSCodeAPI) {
    const config: ModalConfig = {
      manager,
      element,
      vscode,
      title: 'Account Stats',
      titleIcon: '\u{1F4CA}',
      maxWidth: '500px',
      maxHeight: '75vh',
      publications: {},
      subscriptions: {
        'stats.data': (value: unknown) => {
          this._data = value as StatsData;
          this._loading = false;
          log.debug('stats data received');
          if (this._visible) {
            this.updateBodyContent(this.renderModalContent());
          }
        }
      },
      additionalStyles: statsShadowStyles,
      openRequestKey: 'stats.modal.open',
      visibleStateKey: 'stats.modal.visible',
    };

    super(config);
  }

  protected renderModalContent(): string {
    if (this._loading) {
      return '<div class="stats-loading">Loading account data...</div>';
    }

    if (!this._data) {
      return '<div class="stats-error">Failed to load stats data</div>';
    }

    let html = '<div class="stats-container">';

    // DeepSeek Section
    html += '<div class="stats-section">';
    html += '<div class="stats-section-title"><span class="stats-section-icon">🤖</span> DeepSeek</div>';
    html += '<div class="stats-grid">';

    if (this._data.balance) {
      const raw = parseFloat(this._data.balance.balance || '0');
      const amount = isNaN(raw) ? 0 : raw;
      const valueClass = amount > 5 ? 'balance' : amount > 1 ? 'warning' : 'error';
      html += `
        <div class="stats-card">
          <div class="stats-card-value ${valueClass}">$${amount.toFixed(2)}</div>
          <div class="stats-card-label">Balance (${this._data.balance.currency || 'USD'})</div>
        </div>
      `;
    } else {
      html += `
        <div class="stats-card">
          <div class="stats-card-value">—</div>
          <div class="stats-card-label">Balance (unavailable)</div>
        </div>
      `;
    }

    if (this._data.stats) {
      html += `
        <div class="stats-card">
          <div class="stats-card-value">${this._data.stats.totalSessions ?? 0}</div>
          <div class="stats-card-label">Sessions</div>
        </div>
        <div class="stats-card">
          <div class="stats-card-value">${this._data.stats.totalMessages ?? 0}</div>
          <div class="stats-card-label">Messages</div>
        </div>
      `;
    }

    html += '</div></div>';

    // Tavily Section
    html += '<div class="stats-divider"></div>';
    html += '<div class="stats-section">';
    html += '<div class="stats-section-title"><span class="stats-section-icon">🔍</span> Tavily Web Search</div>';
    html += '<div class="stats-grid">';

    if (this._data.tavilyApiUsage) {
      const remaining = this._data.tavilyApiUsage.remaining;
      const limit = this._data.tavilyApiUsage.limit;
      const used = this._data.tavilyApiUsage.used ?? 0;
      const plan = this._data.tavilyApiUsage.plan || 'Unknown';

      if (remaining != null && limit != null && limit > 0) {
        const pct = (remaining / limit) * 100;
        const valueClass = pct > 50 ? 'balance' : pct > 20 ? 'warning' : 'error';
        html += `
          <div class="stats-card">
            <div class="stats-card-value ${valueClass}">${remaining}</div>
            <div class="stats-card-label">Credits Remaining</div>
          </div>
        `;
      }

      html += `
        <div class="stats-card">
          <div class="stats-card-value">${used}</div>
          <div class="stats-card-label">Credits Used</div>
        </div>
      `;

      if (limit != null) {
        html += `
          <div class="stats-card">
            <div class="stats-card-value">${limit}</div>
            <div class="stats-card-label">Monthly Limit</div>
          </div>
        `;
      }

      html += `
        <div class="stats-card">
          <div class="stats-card-value">${plan}</div>
          <div class="stats-card-label">Plan</div>
        </div>
      `;
    } else {
      html += `
        <div class="stats-card">
          <div class="stats-card-value">—</div>
          <div class="stats-card-label">Not configured</div>
        </div>
      `;
    }

    if (this._data.tavilyStats) {
      html += `
        <div class="stats-card">
          <div class="stats-card-value">${this._data.tavilyStats.totalSearches ?? 0}</div>
          <div class="stats-card-label">Searches (session)</div>
        </div>
      `;
    }

    html += '</div></div>';

    html += '<div class="stats-note">Data refreshed on modal open</div>';
    html += '</div>';

    return html;
  }

  protected setupModalEvents(): void {
    // No interactive events needed — this is a read-only display
  }

  protected onOpen(): void {
    this._loading = true;
    this._data = null;
    this.updateBodyContent(this.renderModalContent());
    // Data will arrive via stats.data subscription after extension processes getStats
  }
}
