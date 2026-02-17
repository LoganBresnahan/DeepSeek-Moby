/**
 * CommandRulesModalActor
 *
 * Modal for managing command approval rules.
 * Displays allowed/blocked rules in two sections with CRUD controls.
 *
 * Publications:
 * - rules.modal.visible: boolean — whether the modal is open
 *
 * Subscriptions:
 * - rules.modal.open: boolean — request to open/close modal
 * - rules.list: CommandRule[] — rules data from extension
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

// ============================================
// CommandRulesModalActor
// ============================================

export class CommandRulesModalActor extends ModalShadowActor {
  private _rules: CommandRule[] = [];

  constructor(manager: EventStateManager, element: HTMLElement, vscode: VSCodeAPI) {
    const config: ModalConfig = {
      manager,
      element,
      vscode,
      title: 'Command Rules',
      titleIcon: '\u{1F6E1}\u{FE0F}',
      hasSearch: false,
      hasFooter: true,
      maxWidth: '550px',
      maxHeight: '70vh',
      publications: {},
      subscriptions: {
        'rules.list': (value: unknown) => this.handleRulesList(value as CommandRule[]),
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
    return this.buildBodyHtml();
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
            <option value="allowed">Allowed</option>
            <option value="blocked">Blocked</option>
          </select>
          <button class="modal-btn modal-btn-primary" data-action="add-rule">+ Add</button>
        </div>
        <div class="footer-spacer"></div>
        <button class="modal-btn modal-btn-danger" data-action="reset-rules">Reset</button>
      </div>
    `;
  }

  protected setupModalEvents(): void {
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

    // Reset to defaults
    this.delegate('click', '[data-action="reset-rules"]', () => {
      log.debug('resetToDefaults requested');
      webviewTracer.trace('user.click', 'rules:reset', { level: 'info' });
      this._vscode.postMessage({ type: 'resetCommandRulesToDefaults' });
    });
  }

  // ============================================
  // Modal Lifecycle Hooks
  // ============================================

  protected onOpen(): void {
    log.debug('opened, requesting rules from extension');
    this._vscode.postMessage({ type: 'getCommandRules' });
  }

  // ============================================
  // Subscription Handlers
  // ============================================

  private handleRulesList(rules: CommandRule[]): void {
    this._rules = rules || [];
    const allowed = this._rules.filter(r => r.type === 'allowed').length;
    const blocked = this._rules.filter(r => r.type === 'blocked').length;
    log.debug(`received rules: ${allowed} allowed, ${blocked} blocked (${this._rules.length} total)`);
    this.renderRulesList();
  }

  // ============================================
  // Rendering
  // ============================================

  private renderRulesList(): void {
    this.updateBodyContent(this.buildBodyHtml());
  }

  private buildBodyHtml(): string {
    const rules = this._rules || [];
    const allowed = rules.filter(r => r.type === 'allowed');
    const blocked = rules.filter(r => r.type === 'blocked');

    return `
      <div class="rules-section">
        <div class="rules-section-header">
          Allowed <span class="rules-section-count">(${allowed.length})</span>
        </div>
        ${allowed.length === 0
          ? '<div class="rules-empty">No allowed rules</div>'
          : allowed.map(r => this.renderRuleItem(r)).join('')
        }
      </div>
      <div class="rules-section">
        <div class="rules-section-header">
          Blocked <span class="rules-section-count">(${blocked.length})</span>
        </div>
        ${blocked.length === 0
          ? '<div class="rules-empty">No blocked rules</div>'
          : blocked.map(r => this.renderRuleItem(r)).join('')
        }
      </div>
    `;
  }

  private renderRuleItem(rule: CommandRule): string {
    const isUser = rule.source === 'user';
    return `
      <div class="rule-item" data-rule-id="${rule.id}" data-source="${rule.source}">
        <span class="rule-prefix">${this.escapeHtml(rule.prefix)}</span>
        <span class="source-badge ${rule.source}">${rule.source}</span>
        ${isUser ? `<button class="rule-delete" title="Remove rule">\u00D7</button>` : ''}
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
}
