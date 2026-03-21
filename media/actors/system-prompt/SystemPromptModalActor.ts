/**
 * SystemPromptModalActor
 *
 * Modal for editing custom instructions prepended to every request.
 * Supports saving named prompts to the database with load/delete.
 *
 * Flow:
 * - Load: switches active prompt, populates textarea, no dirty state
 * - New: clears textarea, deactivates all, dirty bar on typing → Save triggers Save As
 * - Save As: names and saves as new entry, sets active
 * - Dirty bar Save: updates active prompt, or triggers Save As if no active
 * - Clear: empties textarea for "no custom prompt" behavior
 *
 * Publications:
 * - systemPrompt.modal.visible: boolean
 *
 * Subscriptions:
 * - systemPrompt.modal.open: boolean
 * - settings.values: SettingsValues (contains systemPrompt)
 * - savedPrompts.list: SavedPrompt[]
 */

import { ModalShadowActor, ModalConfig } from '../../state/ModalShadowActor';
import { EventStateManager } from '../../state/EventStateManager';
import type { VSCodeAPI } from '../../state/types';
import { systemPromptShadowStyles } from './shadowStyles';
import { createLogger } from '../../logging';

const log = createLogger('SystemPromptModal');

interface SavedPrompt {
  id: number;
  name: string;
  content: string;
  model: string | null;
  is_active: boolean;
  created_at: number;
  updated_at: number;
}

export class SystemPromptModalActor extends ModalShadowActor {
  private _systemPrompt = '';
  private _savedContent = '';
  private _currentModel = '';
  private _activePromptId: number | null = null;
  private _savedPrompts: SavedPrompt[] = [];

  constructor(manager: EventStateManager, element: HTMLElement, vscode: VSCodeAPI) {
    const config: ModalConfig = {
      manager,
      element,
      vscode,
      title: 'System Prompt',
      titleIcon: '\u270F\uFE0F',
      hasFooter: true,
      maxWidth: '700px',
      maxHeight: '85vh',
      publications: {},
      subscriptions: {
        'settings.values': (value: unknown) => {
          const settings = value as { systemPrompt?: string; model?: string };
          if (settings.systemPrompt !== undefined) {
            this._systemPrompt = settings.systemPrompt;
            this._savedContent = settings.systemPrompt;
          }
          if (settings.model) {
            this._currentModel = settings.model;
          }
        },
        'savedPrompts.list': (value: unknown) => {
          this._savedPrompts = (value as SavedPrompt[]) || [];
          // Track active prompt ID
          const active = this._savedPrompts.find(p => p.is_active);
          this._activePromptId = active ? active.id : null;
          if (this._visible) {
            this.renderSavedPromptsList();
          }
        }
      },
      additionalStyles: systemPromptShadowStyles,
      openRequestKey: 'systemPrompt.modal.open',
      visibleStateKey: 'systemPrompt.modal.visible',
    };

    super(config);
  }

  protected renderModalContent(): string {
    return `
      <div class="prompt-container">
        <div class="prompt-hint">
          Add custom instructions prepended to every request. Leave empty for default behavior.
        </div>
        <textarea
          class="prompt-textarea"
          placeholder="e.g. &quot;Always respond in Spanish&quot;, &quot;Prefer functional patterns&quot;, &quot;Use tabs not spaces&quot;..."
        >${this.escapeHtml(this._systemPrompt)}</textarea>
        <div class="prompt-dirty" data-dirty-bar>
          <span>Unsaved changes</span>
          <div class="prompt-dirty-actions">
            <select class="prompt-dirty-model" data-dirty-model>
              <option value="">Any model</option>
              <option value="deepseek-chat">Chat (V3)</option>
              <option value="deepseek-reasoner">Reasoner (R1)</option>
            </select>
            <button class="prompt-dirty-btn save" data-action="dirty-save">Save</button>
            <button class="prompt-dirty-btn discard" data-action="dirty-discard">Discard</button>
          </div>
        </div>
        <div class="prompt-saved-section">
          <div class="prompt-saved-header">Saved Prompts</div>
          <div class="prompt-saved-list" data-saved-list>
            ${this.renderSavedPromptsItems()}
          </div>
        </div>
      </div>
    `;
  }

  private renderSavedPromptsItems(): string {
    if (!this._savedPrompts || this._savedPrompts.length === 0) {
      return '<div class="prompt-saved-empty">No saved prompts yet</div>';
    }
    return this._savedPrompts.map(p => `
      <div class="prompt-saved-item${p.is_active ? ' active' : ''}" data-prompt-id="${p.id}">
        <div class="prompt-saved-info">
          <span class="prompt-saved-name">${this.escapeHtml(p.name)}</span>
          ${p.model ? `<span class="prompt-saved-model">${this.escapeHtml(p.model)}</span>` : ''}
          ${p.is_active ? '<span class="prompt-saved-active-badge" data-action="deactivate" data-id="' + p.id + '">active &times;</span>' : ''}
        </div>
        <div class="prompt-saved-actions">
          <button class="prompt-saved-btn load" data-action="load" data-id="${p.id}">Load</button>
          <button class="prompt-saved-btn delete" data-action="confirm-delete" data-id="${p.id}">Delete</button>
          <div class="prompt-delete-confirm" data-delete-confirm="${p.id}" style="display:none">
            <span>Delete?</span>
            <button class="prompt-delete-btn no" data-action="cancel-delete" data-id="${p.id}">No</button>
            <button class="prompt-delete-btn yes" data-action="delete-prompt" data-id="${p.id}">Yes</button>
          </div>
        </div>
      </div>
    `).join('');
  }

  private renderSavedPromptsList(): void {
    const list = this.query<HTMLElement>('[data-saved-list]');
    if (list) {
      list.innerHTML = this.renderSavedPromptsItems();
    }
  }

  protected renderFooterContent(): string {
    return `
      <div class="prompt-footer-default" data-footer-default>
        <div class="prompt-footer-left">
          <button class="modal-btn modal-btn-secondary" data-action="new" data-new-btn>New</button>
          <button class="modal-btn modal-btn-secondary" data-action="save-as">Save As...</button>
        </div>
        <span class="prompt-saved-feedback" data-saved-indicator>Saved!</span>
      </div>
      <div class="prompt-footer-save-as" data-save-as-form style="display:none">
        <input type="text" class="prompt-name-input" data-save-as-name placeholder="Prompt name..." />
        <button class="modal-btn modal-btn-primary" data-action="save-as-confirm">Save</button>
        <button class="modal-btn modal-btn-secondary" data-action="save-as-cancel">Cancel</button>
      </div>
    `;
  }

  protected setupModalEvents(): void {
    // Textarea input — track dirty state
    this.delegate('input', '.prompt-textarea', () => {
      this.updateDirtyState();
    });

    // Dirty bar save — update active or trigger Save As
    this.delegate('click', '[data-action="dirty-save"]', () => {
      const modelSelect = this.query<HTMLSelectElement>('[data-dirty-model]');
      const selectedModel = modelSelect?.value || undefined;

      const textarea = this.query<HTMLTextAreaElement>('.prompt-textarea');
      if (!textarea) return;

      this._systemPrompt = textarea.value;
      this._savedContent = textarea.value;

      if (this._activePromptId) {
        // Update the active prompt in DB
        const active = this._savedPrompts.find(p => p.id === this._activePromptId);
        if (active) {
          this._vscode.postMessage({
            type: 'updateSavedPrompt',
            id: active.id,
            name: active.name,
            content: textarea.value,
            model: selectedModel
          });
        }
      } else {
        // No active prompt — save as new with auto-generated name
        const name = `Prompt ${new Date().toLocaleDateString()}`;
        this._vscode.postMessage({
          type: 'savePrompt',
          name,
          content: textarea.value,
          model: selectedModel
        });
      }

      this._vscode.postMessage({ type: 'setSystemPrompt', systemPrompt: this._systemPrompt });
      this.updateDirtyState();
      this.showSavedFeedback();
      log.debug('Saved prompt');
    });

    // Dirty bar discard
    this.delegate('click', '[data-action="dirty-discard"]', () => {
      const textarea = this.query<HTMLTextAreaElement>('.prompt-textarea');
      if (textarea) {
        textarea.value = this._savedContent;
        this.updateDirtyState();
      }
    });

    // New — clear textarea, deactivate all
    this.delegate('click', '[data-action="new"]', () => {
      const textarea = this.query<HTMLTextAreaElement>('.prompt-textarea');
      if (textarea) {
        textarea.value = '';
        textarea.focus();
      }
      this._activePromptId = null;
      this._savedContent = '';
      this._systemPrompt = '';
      this._vscode.postMessage({ type: 'setActivePrompt', id: null });
      this._vscode.postMessage({ type: 'setSystemPrompt', systemPrompt: '' });
      this._vscode.postMessage({ type: 'getSavedPrompts' });
      this.updateDirtyState();
    });

    // Save As — show inline name input
    this.delegate('click', '[data-action="save-as"]', () => {
      this.showSaveAsForm();
    });

    // Save As confirm
    this.delegate('click', '[data-action="save-as-confirm"]', () => {
      this.handleSaveAs();
    });

    // Save As cancel
    this.delegate('click', '[data-action="save-as-cancel"]', () => {
      this.hideSaveAsForm();
    });

    // Save As enter key
    this.delegate('keydown', '[data-save-as-name]', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        this.handleSaveAs();
      }
    });

    // Deactivate active prompt
    this.delegate('click', '[data-action="deactivate"]', () => {
      this._activePromptId = null;
      this._systemPrompt = '';
      this._savedContent = '';
      const textarea = this.query<HTMLTextAreaElement>('.prompt-textarea');
      if (textarea) textarea.value = '';
      this._vscode.postMessage({ type: 'setActivePrompt', id: null });
      this._vscode.postMessage({ type: 'setSystemPrompt', systemPrompt: '' });
      this._vscode.postMessage({ type: 'getSavedPrompts' });
      this.updateDirtyState();
      log.debug('Deactivated prompt');
    });

    // Load saved prompt — set as active immediately
    this.delegate('click', '[data-action="load"]', (_, el) => {
      const id = parseInt(el.getAttribute('data-id') || '0');
      const prompt = this._savedPrompts.find(p => p.id === id);
      if (prompt) {
        const textarea = this.query<HTMLTextAreaElement>('.prompt-textarea');
        if (textarea) {
          textarea.value = prompt.content;
          textarea.focus();
        }
        this._activePromptId = prompt.id;
        this._systemPrompt = prompt.content;
        this._savedContent = prompt.content;
        // Set as active in DB and update the system prompt
        this._vscode.postMessage({ type: 'setActivePrompt', id: prompt.id });
        this._vscode.postMessage({ type: 'setSystemPrompt', systemPrompt: prompt.content });
        this._vscode.postMessage({ type: 'getSavedPrompts' });
        this.updateDirtyState();
        log.debug(`Loaded and activated prompt "${prompt.name}" (id=${id})`);
      }
    });

    // Show delete confirmation
    this.delegate('click', '[data-action="confirm-delete"]', (_, el) => {
      const id = el.getAttribute('data-id') || '0';
      const confirm = this.query<HTMLElement>(`[data-delete-confirm="${id}"]`);
      const actions = el.closest('.prompt-saved-actions') as HTMLElement;
      if (confirm && actions) {
        // Hide load/delete buttons, show confirm bar
        for (const btn of Array.from(actions.querySelectorAll('.prompt-saved-btn'))) {
          (btn as HTMLElement).style.display = 'none';
        }
        confirm.style.display = 'flex';
      }
    });

    // Cancel delete
    this.delegate('click', '[data-action="cancel-delete"]', (_, el) => {
      const id = el.getAttribute('data-id') || '0';
      const confirm = this.query<HTMLElement>(`[data-delete-confirm="${id}"]`);
      const actions = el.closest('.prompt-saved-actions') as HTMLElement;
      if (confirm && actions) {
        confirm.style.display = 'none';
        for (const btn of Array.from(actions.querySelectorAll('.prompt-saved-btn'))) {
          (btn as HTMLElement).style.display = '';
        }
      }
    });

    // Confirmed delete
    this.delegate('click', '[data-action="delete-prompt"]', (_, el) => {
      const id = parseInt(el.getAttribute('data-id') || '0');
      // If deleting the active prompt, clear it
      if (id === this._activePromptId) {
        this._activePromptId = null;
        this._systemPrompt = '';
        this._savedContent = '';
        const textarea = this.query<HTMLTextAreaElement>('.prompt-textarea');
        if (textarea) textarea.value = '';
        this._vscode.postMessage({ type: 'setSystemPrompt', systemPrompt: '' });
      }
      this._vscode.postMessage({ type: 'deleteSavedPrompt', id });
      this.updateDirtyState();
      log.debug(`Deleted saved prompt id=${id}`);
    });
  }

  protected onOpen(): void {
    this._savedContent = this._systemPrompt;
    this.updateBodyContent(this.renderModalContent());
    this.updateFooterContent(this.renderFooterContent());

    // Request saved prompts from extension
    this._vscode.postMessage({ type: 'getSavedPrompts' });

    // Focus textarea after animation
    setTimeout(() => {
      const textarea = this.query<HTMLTextAreaElement>('.prompt-textarea');
      if (textarea) textarea.focus();
    }, 200);
  }

  protected handleEscapeKey(): void {
    const form = this.query<HTMLElement>('[data-save-as-form]');
    if (form && form.style.display !== 'none') {
      this.hideSaveAsForm();
      return;
    }
    this.close();
  }

  private showSaveAsForm(): void {
    const defaultFooter = this.query<HTMLElement>('[data-footer-default]');
    const form = this.query<HTMLElement>('[data-save-as-form]');
    if (defaultFooter) defaultFooter.style.display = 'none';
    if (form) {
      form.style.display = 'flex';
      const input = this.query<HTMLInputElement>('[data-save-as-name]');
      if (input) {
        input.value = '';
        input.focus();
      }
    }
  }

  private hideSaveAsForm(): void {
    const defaultFooter = this.query<HTMLElement>('[data-footer-default]');
    const form = this.query<HTMLElement>('[data-save-as-form]');
    if (form) form.style.display = 'none';
    if (defaultFooter) defaultFooter.style.display = '';
  }

  private handleSaveAs(): void {
    const nameInput = this.query<HTMLInputElement>('[data-save-as-name]');
    const textarea = this.query<HTMLTextAreaElement>('.prompt-textarea');
    if (!nameInput || !textarea) return;

    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }

    const modelSelect = this.query<HTMLSelectElement>('[data-dirty-model]');
    const model = modelSelect?.value || undefined;

    // Save as new prompt (sets active in DB)
    this._vscode.postMessage({
      type: 'savePrompt',
      name,
      content: textarea.value,
      model
    });

    this._systemPrompt = textarea.value;
    this._savedContent = textarea.value;
    this._vscode.postMessage({ type: 'setSystemPrompt', systemPrompt: this._systemPrompt });

    this.hideSaveAsForm();

    this.updateDirtyState();
    this.showSavedFeedback();
    log.debug(`Saved prompt as "${name}"`);
  }

  private updateDirtyState(): void {
    const textarea = this.query<HTMLTextAreaElement>('.prompt-textarea');
    const dirtyBar = this.query<HTMLElement>('[data-dirty-bar]');
    const newBtn = this.query<HTMLButtonElement>('[data-new-btn]');
    if (!textarea || !dirtyBar) return;

    const isDirty = textarea.value !== this._savedContent;
    const wasVisible = dirtyBar.classList.contains('visible');
    dirtyBar.classList.toggle('visible', isDirty);

    // Pre-select current model when dirty bar first appears
    if (isDirty && !wasVisible) {
      const modelSelect = this.query<HTMLSelectElement>('[data-dirty-model]');
      if (modelSelect) {
        // If editing an active prompt, use its model; otherwise use current model
        const active = this._savedPrompts.find(p => p.id === this._activePromptId);
        modelSelect.value = active?.model || this._currentModel || '';
      }
    }

    if (newBtn) {
      newBtn.disabled = isDirty;
      newBtn.style.opacity = isDirty ? '0.4' : '';
      newBtn.style.pointerEvents = isDirty ? 'none' : '';
    }
  }

  private showSavedFeedback(): void {
    const indicator = this.query<HTMLElement>('[data-saved-indicator]');
    if (indicator) {
      indicator.classList.add('visible');
      setTimeout(() => indicator.classList.remove('visible'), 2000);
    }
  }
}
