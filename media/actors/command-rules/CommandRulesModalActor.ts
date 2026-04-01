/**
 * CommandRulesModalActor
 *
 * Modal for managing command approval rules.
 * Displays a unified alphabetical list with checkboxes (checked = approved),
 * filter chips (All / Approved / Blocked), search, add form, delete buttons,
 * an "Allow All" toggle, and reset-to-defaults.
 *
 * Publications:
 * - rules.modal.visible: boolean — whether the modal is open
 *
 * Subscriptions:
 * - rules.modal.open: boolean — request to open/close modal
 * - rules.list: CommandRule[] — rules data from extension
 * - rules.allowAll: boolean — whether allowAllShellCommands is enabled
 */

import { ModalShadowActor, ModalConfig } from '../../state/ModalShadowActor';
import { EventStateManager } from '../../state/EventStateManager';
import type { VSCodeAPI } from '../../state/types';
import { commandRulesShadowStyles } from './shadowStyles';
import { createLogger } from '../../logging';
import { webviewTracer } from '../../tracing';

const log = createLogger('RulesModal');

// ============================================
// Types (local — mirrors extension type)
// ============================================

export interface CommandRule {
  id: number;
  prefix: string;
  type: 'allowed' | 'blocked';
  source: 'default' | 'user';
  created_at: number;
}

type FilterMode = 'all' | 'allowed' | 'blocked';

// ============================================
// CommandRulesModalActor
// ============================================

export class CommandRulesModalActor extends ModalShadowActor {
  private _rules: CommandRule[] = [];
  private _filter: FilterMode = 'all';
  private _searchQuery = '';
  private _allowAll = false;

  constructor(manager: EventStateManager, element: HTMLElement, vscode: VSCodeAPI) {
    const config: ModalConfig = {
      manager,
      element,
      vscode,
      title: 'Command Rules',
      titleIcon: '\u{1F6E1}\u{FE0F}',
      hasSearch: true,
      searchPlaceholder: 'Search commands...',
      hasFooter: true,
      maxWidth: '600px',
      maxHeight: '75vh',
      publications: {},
      subscriptions: {
        'rules.list': (value: unknown) => this.handleRulesList(value as CommandRule[]),
        'rules.allowAll': (value: unknown) => this.handleAllowAll(value as boolean),
      },
      additionalStyles: commandRulesShadowStyles,
      openRequestKey: 'rules.modal.open',
      visibleStateKey: 'rules.modal.visible',
    };

    super(config);
  }

  // ============================================
  // Abstract Method Implementations
  // ============================================

  protected renderModalContent(): string {
    return this.buildAllowAllBar() + this.buildFilterRow() + this.buildBodyHtml();
  }

  protected renderFooterContent(): string {
    return `
      <div class="footer-actions">
        <div class="add-rule-form">
          <input
            type="text"
            class="add-rule-input"
            placeholder="Command prefix (e.g. npm install)"
            data-rule-input
          />
          <select class="add-rule-select" data-rule-type>
            <option value="allowed">Approved</option>
            <option value="blocked">Blocked</option>
          </select>
          <button class="modal-btn modal-btn-primary" data-action="add-rule">+ Add</button>
        </div>
        <button class="modal-btn modal-btn-danger" data-action="reset-rules">Reset</button>
      </div>
    `;
  }

  protected setupModalEvents(): void {
    // Allow-all toggle
    this.delegate('change', '[data-allow-all]', (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      log.debug(`allowAll toggled: ${checked}`);
      webviewTracer.trace('user.click', 'rules:allowAll', { level: 'info', data: { enabled: checked } });
      this._allowAll = checked;
      this._vscode.postMessage({ type: 'setAllowAllCommands', enabled: checked });
      this.refreshFullBody();
    });

    // Filter chips
    this.delegate('click', '[data-filter]', (e) => {
      const filter = (e.target as HTMLElement).closest('[data-filter]')?.getAttribute('data-filter') as FilterMode;
      if (filter && filter !== this._filter) {
        log.debug(`filter changed: ${filter}`);
        this._filter = filter;
        this.refreshFullBody();
      }
    });

    // Toggle rule type (checkbox)
    this.delegate('change', '.rule-checkbox', (e) => {
      const cb = e.target as HTMLInputElement;
      const item = cb.closest('.rule-item');
      const idStr = item?.getAttribute('data-rule-id');
      const prefix = item?.getAttribute('data-rule-prefix');
      if (idStr && prefix) {
        const newType = cb.checked ? 'allowed' : 'blocked';
        log.debug(`toggleRule: id=${idStr}, prefix="${prefix}", newType=${newType}`);
        webviewTracer.trace('user.click', 'rules:toggle', { level: 'info', data: { ruleId: parseInt(idStr, 10), newType } });
        // Remove old rule, add with new type
        this._vscode.postMessage({ type: 'removeCommandRule', id: parseInt(idStr, 10) });
        this._vscode.postMessage({ type: 'addCommandRule', prefix, ruleType: newType });
      }
    });

    // Delete rule button
    this.delegate('click', '.rule-delete', (e) => {
      const item = (e.target as HTMLElement).closest('.rule-item');
      const idStr = item?.getAttribute('data-rule-id');
      if (idStr) {
        log.debug(`deleteRule: id=${idStr}`);
        webviewTracer.trace('user.click', 'rules:delete', { level: 'info', data: { ruleId: parseInt(idStr, 10) } });
        this._vscode.postMessage({ type: 'removeCommandRule', id: parseInt(idStr, 10) });
      }
    });

    // Add rule button
    this.delegate('click', '[data-action="add-rule"]', () => {
      this.submitAddRule();
    });

    // Enter key in input triggers add
    this.delegate('keydown', '[data-rule-input]', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        this.submitAddRule();
      }
    });

    // Reset to defaults
    this.delegate('click', '[data-action="reset-rules"]', () => {
      log.debug('resetToDefaults requested');
      webviewTracer.trace('user.click', 'rules:reset', { level: 'info' });
      this._vscode.postMessage({ type: 'resetCommandRulesToDefaults' });
    });
  }

  // ============================================
  // Search (built-in from ModalShadowActor)
  // ============================================

  protected handleSearch(query: string): void {
    this._searchQuery = query.toLowerCase().trim();
    this.renderRulesList();
  }

  // ============================================
  // Modal Lifecycle Hooks
  // ============================================

  protected onOpen(): void {
    log.debug('opened');
    // Rules are already sent by the extension before the modal opens
    // (via sendCommandRules() in openRulesModal or getCommandRules handler).
    // No need to request again — avoids double render.
  }

  // ============================================
  // Subscription Handlers
  // ============================================

  private handleRulesList(rules: CommandRule[]): void {
    this._rules = rules || [];
    const allowed = this._rules.filter(r => r.type === 'allowed').length;
    const blocked = this._rules.filter(r => r.type === 'blocked').length;
    log.debug(`received rules: ${allowed} allowed, ${blocked} blocked (${this._rules.length} total)`);
    this.refreshFullBody();
  }

  private handleAllowAll(enabled: boolean): void {
    this._allowAll = !!enabled;
    log.debug(`allowAll state received: ${this._allowAll}`);
    this.refreshFullBody();
  }

  // ============================================
  // Rendering
  // ============================================

  /** Full re-render of body (allow-all bar + filter row + list). */
  private refreshFullBody(): void {
    this.updateBodyContent(this.buildAllowAllBar() + this.buildFilterRow() + this.buildBodyHtml());

    // Apply/remove disabled overlay class on the container
    const container = this.query<HTMLElement>('[data-modal-container]');
    if (container) {
      container.classList.toggle('rules-disabled', this._allowAll);
    }
  }

  /** Re-render just the rules list (for search). */
  private renderRulesList(): void {
    const listContainer = this.query<HTMLElement>('[data-rules-list]');
    if (listContainer) {
      listContainer.innerHTML = this.buildListItems();
    }
    // Also update filter counts
    this.updateFilterCounts();
  }

  private getFilteredRules(): CommandRule[] {
    let rules = [...(this._rules || [])];

    // Apply type filter
    if (this._filter === 'allowed') {
      rules = rules.filter(r => r.type === 'allowed');
    } else if (this._filter === 'blocked') {
      rules = rules.filter(r => r.type === 'blocked');
    }

    // Apply search
    if (this._searchQuery) {
      rules = rules.filter(r => r.prefix.toLowerCase().includes(this._searchQuery));
    }

    // Sort alphabetically
    rules.sort((a, b) => a.prefix.localeCompare(b.prefix));

    return rules;
  }

  private buildAllowAllBar(): string {
    return `
      <div class="allow-all-bar">
        <label class="allow-all-label">
          <span class="allow-all-icon">\u{1F43E}</span>
          <span>Allow All Commands</span>
        </label>
        <label class="toggle-switch">
          <input type="checkbox" data-allow-all ${this._allowAll ? 'checked' : ''} />
          <span class="toggle-slider"></span>
        </label>
      </div>
    `;
  }

  private buildFilterRow(): string {
    const rules = this._rules || [];
    const all = rules.length;
    const allowed = rules.filter(r => r.type === 'allowed').length;
    const blocked = rules.filter(r => r.type === 'blocked').length;

    return `
      <div class="filter-row">
        <button class="filter-chip ${this._filter === 'all' ? 'active' : ''}" data-filter="all">
          All<span class="filter-count">(${all})</span>
        </button>
        <button class="filter-chip ${this._filter === 'allowed' ? 'active' : ''}" data-filter="allowed">
          Approved<span class="filter-count">(${allowed})</span>
        </button>
        <button class="filter-chip ${this._filter === 'blocked' ? 'active' : ''}" data-filter="blocked">
          Blocked<span class="filter-count">(${blocked})</span>
        </button>
      </div>
    `;
  }

  private updateFilterCounts(): void {
    const chips = this.queryAll<HTMLElement>('[data-filter]');
    const rules = this._rules || [];
    const all = rules.length;
    const allowed = rules.filter(r => r.type === 'allowed').length;
    const blocked = rules.filter(r => r.type === 'blocked').length;
    const counts: Record<string, number> = { all, allowed, blocked };

    chips.forEach(chip => {
      const filter = chip.getAttribute('data-filter');
      if (filter) {
        const countEl = chip.querySelector('.filter-count');
        if (countEl) {
          countEl.textContent = `(${counts[filter] ?? 0})`;
        }
        chip.classList.toggle('active', filter === this._filter);
      }
    });
  }

  private buildBodyHtml(): string {
    return `<div class="rules-list" data-rules-list>${this.buildListItems()}</div>`;
  }

  private buildListItems(): string {
    const filtered = this.getFilteredRules();

    if (filtered.length === 0) {
      if (this._searchQuery) {
        return '<div class="rules-empty">No commands match your search</div>';
      }
      if (this._filter !== 'all') {
        return `<div class="rules-empty">No ${this._filter} commands</div>`;
      }
      return '<div class="rules-empty">No command rules</div>';
    }

    return filtered.map(r => this.renderRuleItem(r)).join('');
  }

  private renderRuleItem(rule: CommandRule): string {
    const isApproved = rule.type === 'allowed';
    return `
      <div class="rule-item" data-rule-id="${rule.id}" data-rule-prefix="${this.escapeHtml(rule.prefix)}">
        <span class="rule-prefix">${this.escapeHtml(rule.prefix)}</span>
        <span class="source-badge ${rule.source}">${rule.source}</span>
        <button class="rule-delete" title="Remove rule">\u00D7</button>
        <input type="checkbox" class="rule-checkbox" title="${isApproved ? 'Approved' : 'Blocked'}" ${isApproved ? 'checked' : ''} />
      </div>
    `;
  }

  // ============================================
  // Actions
  // ============================================

  private submitAddRule(): void {
    const input = this.query<HTMLInputElement>('[data-rule-input]');
    const select = this.query<HTMLSelectElement>('[data-rule-type]');

    if (!input || !select) return;

    const prefix = input.value.trim();
    if (!prefix) return;

    const ruleType = select.value as 'allowed' | 'blocked';
    log.debug(`addRule: prefix="${prefix}", type=${ruleType}`);
    webviewTracer.trace('user.click', 'rules:add', { level: 'info', data: { prefix, ruleType } });

    this._vscode.postMessage({ type: 'addCommandRule', prefix, ruleType });

    // Clear input for next entry
    input.value = '';
    input.focus();
  }

  // ============================================
  // Public API
  // ============================================

  getRules(): CommandRule[] {
    return [...this._rules];
  }

  getAllowAll(): boolean {
    return this._allowAll;
  }

  getFilter(): FilterMode {
    return this._filter;
  }
}
