/**
 * PlanPopupShadowActor
 *
 * Shadow DOM popup for managing plan files.
 * Shows a list of plans with checkboxes to toggle active state.
 * Plans are markdown files in `.moby-plans/` that get injected into the system prompt.
 *
 * Publications:
 * - plans.popup.visible: boolean - whether the popup is open
 * - plans.activeCount: number - number of active plans
 *
 * Subscriptions:
 * - plans.popup.open: boolean - request to open/close popup
 * - plans.state: PlanFile[] - plan list from extension
 */

import { PopupShadowActor, PopupConfig } from '../../state/PopupShadowActor';
import { EventStateManager } from '../../state/EventStateManager';
import type { VSCodeAPI } from '../../state/types';
import { plansShadowStyles } from './shadowStyles';
import { createLogger } from '../../logging';

const log = createLogger('PlanPopup');

// ============================================
// Types
// ============================================

export interface PlanFile {
  name: string;
  active: boolean;
}

// ============================================
// PlanPopupShadowActor
// ============================================

export class PlanPopupShadowActor extends PopupShadowActor {
  private _plans: PlanFile[] = [];
  private _showNewInput = false;
  private _confirmingDelete: string | null = null;

  constructor(manager: EventStateManager, element: HTMLElement, vscode: VSCodeAPI) {
    const config: PopupConfig = {
      manager,
      element,
      vscode,
      header: 'Plans',
      position: 'top-left',
      width: '280px',
      maxHeight: '400px',
      publications: {
        'plans.activeCount': () => (this._plans || []).filter((p: PlanFile) => p.active).length,
      },
      subscriptions: {
        'plans.state': (value: unknown) => this.handlePlanState(value as PlanFile[])
      },
      additionalStyles: plansShadowStyles,
      openRequestKey: 'plans.popup.open',
      visibleStateKey: 'plans.popup.visible'
    };

    super(config);

    // Re-render now that instance properties are initialized
    this.updateBodyContent(this.renderPopupContent());
  }

  // ============================================
  // Lifecycle
  // ============================================

  protected onOpen(): void {
    // Request plan list refresh when popup opens
    this._vscode.postMessage({ type: 'refreshPlans' });
  }

  // ============================================
  // Abstract Method Implementations
  // ============================================

  protected renderPopupContent(): string {
    const plans = this._plans || [];

    let html = '';

    // Description
    html += `<div class="plans-description">Manage plan files. Active plans are injected into every request.</div>`;

    // Plan list
    html += `<div class="plans-list">`;
    if (plans.length === 0) {
      html += `<div class="plans-empty">No plans yet</div>`;
    } else {
      for (const plan of plans) {
        if (this._confirmingDelete === plan.name) {
          html += this.renderDeleteConfirm(plan.name);
        } else {
          html += this.renderPlanItem(plan);
        }
      }
    }
    html += `</div>`;

    // Footer
    html += `<div class="plans-footer">`;
    if (this._showNewInput) {
      html += `
        <div class="plans-new-row">
          <input class="plans-new-input" type="text" placeholder="Plan name..." autofocus />
          <button class="plans-new-save" data-action="save-new">Create</button>
          <button class="plans-new-cancel" data-action="cancel-new">Cancel</button>
        </div>
      `;
    } else {
      html += `<button class="plans-btn plans-btn-new" data-action="new">New Plan</button>`;
    }
    html += `</div>`;

    return html;
  }

  private renderPlanItem(plan: PlanFile): string {
    const checked = plan.active ? 'checked' : '';
    return `
      <div class="plan-item" data-plan="${this.escapeHtml(plan.name)}">
        <input type="checkbox" class="plan-checkbox" data-action="toggle" ${checked} />
        <span class="plan-name" data-action="open">${this.escapeHtml(plan.name)}</span>
        <div class="plan-actions">
          <button class="plan-action-btn delete" data-action="delete" title="Delete plan">×</button>
        </div>
      </div>
    `;
  }

  private renderDeleteConfirm(name: string): string {
    return `
      <div class="plan-item" data-plan="${this.escapeHtml(name)}">
        <div class="plan-delete-confirm">
          Delete?
          <button class="confirm-btn" data-action="confirm-delete">Yes</button>
          <button class="cancel-btn" data-action="cancel-delete">No</button>
        </div>
      </div>
    `;
  }

  protected setupPopupEvents(): void {
    // Toggle checkbox
    this.delegate('change', '[data-action="toggle"]', (_e, element) => {
      const planItem = element.closest('.plan-item') as HTMLElement;
      const name = planItem?.dataset.plan;
      if (name) {
        log.debug(`toggle plan: ${name}`);
        this._vscode.postMessage({ type: 'togglePlan', name });
      }
    });

    // Open plan in editor
    this.delegate('click', '[data-action="open"]', (_e, element) => {
      const planItem = element.closest('.plan-item') as HTMLElement;
      const name = planItem?.dataset.plan;
      if (name) {
        log.debug(`open plan: ${name}`);
        this._vscode.postMessage({ type: 'openPlan', name });
      }
    });

    // Delete button → show confirmation
    this.delegate('click', '[data-action="delete"]', (_e, element) => {
      const planItem = element.closest('.plan-item') as HTMLElement;
      const name = planItem?.dataset.plan;
      if (name) {
        this._confirmingDelete = name;
        this.updateBodyContent(this.renderPopupContent());
      }
    });

    // Confirm delete
    this.delegate('click', '[data-action="confirm-delete"]', (_e, element) => {
      const planItem = element.closest('.plan-item') as HTMLElement;
      const name = planItem?.dataset.plan;
      if (name) {
        log.debug(`delete plan: ${name}`);
        this._vscode.postMessage({ type: 'deletePlan', name });
        this._confirmingDelete = null;
      }
    });

    // Cancel delete
    this.delegate('click', '[data-action="cancel-delete"]', () => {
      this._confirmingDelete = null;
      this.updateBodyContent(this.renderPopupContent());
    });

    // New plan button
    this.delegate('click', '[data-action="new"]', () => {
      this._showNewInput = true;
      this.updateBodyContent(this.renderPopupContent());
      // Focus input after render
      requestAnimationFrame(() => {
        const input = this.query<HTMLInputElement>('.plans-new-input');
        input?.focus();
      });
    });

    // Save new plan
    this.delegate('click', '[data-action="save-new"]', () => {
      this.saveNewPlan();
    });

    // Cancel new plan
    this.delegate('click', '[data-action="cancel-new"]', () => {
      this._showNewInput = false;
      this.updateBodyContent(this.renderPopupContent());
    });

    // Enter key in new plan input
    this.delegateEvent('keydown', '.plans-new-input', (e) => {
      const keyEvent = e as KeyboardEvent;
      if (keyEvent.key === 'Enter') {
        this.saveNewPlan();
      } else if (keyEvent.key === 'Escape') {
        this._showNewInput = false;
        this.updateBodyContent(this.renderPopupContent());
      }
    });
  }

  // ============================================
  // Private Methods
  // ============================================

  private saveNewPlan(): void {
    const input = this.query<HTMLInputElement>('.plans-new-input');
    const name = input?.value.trim();
    if (!name) return;

    log.debug(`create plan: ${name}`);
    this._vscode.postMessage({ type: 'createPlan', name });
    this._showNewInput = false;
    // Don't re-render — wait for the state update from extension
  }

  private handlePlanState(plans: PlanFile[]): void {
    log.debug(`plan state: ${plans.length} plans, ${plans.filter(p => p.active).length} active`);
    this._plans = plans;
    this._confirmingDelete = null;
    this.updateBodyContent(this.renderPopupContent());

    // Publish active count for toolbar badge
    const activeCount = plans.filter(p => p.active).length;
    this.publish({ 'plans.activeCount': activeCount });
  }

  // ============================================
  // Helpers
  // ============================================

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Delegate an event with a different event type (e.g., keydown) */
  private delegateEvent(eventType: string, selector: string, handler: (e: Event) => void): void {
    this.shadowRoot?.addEventListener(eventType, (e) => {
      const target = (e.target as Element)?.closest(selector);
      if (target) handler(e);
    });
  }
}
