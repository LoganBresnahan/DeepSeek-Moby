/**
 * Tests for SystemPromptModalActor
 *
 * Tests the Shadow DOM modal for system prompt editing including:
 * - Shadow root creation and structure
 * - Textarea rendering for system prompt
 * - Saved prompts list rendering
 * - Dirty state detection on textarea edit
 * - Save button sends setSystemPrompt message
 * - Discard button reverts changes
 * - Load prompt populates textarea and activates
 * - Delete prompt with confirmation flow
 * - Activate/deactivate prompt
 * - Save As flow with name input
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SystemPromptModalActor } from '../../../media/actors/system-prompt/SystemPromptModalActor';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { ShadowActor } from '../../../media/state/ShadowActor';

// Mock VSCode API
const createMockVSCode = () => ({
  postMessage: vi.fn()
});

// Helper to wait for actor registration (deferred via queueMicrotask)
const waitForRegistration = () => new Promise(resolve => queueMicrotask(resolve));

describe('SystemPromptModalActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: SystemPromptModalActor;
  let mockVSCode: ReturnType<typeof createMockVSCode>;

  beforeEach(() => {
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'system-prompt-container';
    document.body.appendChild(element);
    mockVSCode = createMockVSCode();
    ShadowActor.resetInstanceCount();
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
  });

  // Helper: create actor, wait for registration, set system prompt, and open modal
  async function openModalWithPrompt(systemPrompt = ''): Promise<void> {
    actor = new SystemPromptModalActor(manager, element, mockVSCode);
    await waitForRegistration();
    manager.publishDirect('settings.values', { systemPrompt });
    // Open modal -- this triggers onOpen() which re-renders body content
    actor.open();
    mockVSCode.postMessage.mockClear();
  }

  describe('Shadow DOM creation', () => {
    it('creates shadow root on construction', () => {
      actor = new SystemPromptModalActor(manager, element, mockVSCode);

      expect(element.shadowRoot).toBeTruthy();
    });

    it('adopts stylesheets into shadow root', () => {
      actor = new SystemPromptModalActor(manager, element, mockVSCode);

      const sheets = element.shadowRoot?.adoptedStyleSheets;
      expect(sheets?.length).toBeGreaterThan(0);
    });

    it('renders modal structure with title', () => {
      actor = new SystemPromptModalActor(manager, element, mockVSCode);

      const backdrop = element.shadowRoot?.querySelector('.modal-backdrop');
      const title = element.shadowRoot?.querySelector('.modal-title');

      expect(backdrop).toBeTruthy();
      expect(title?.textContent).toContain('System Prompt');
    });

    it('renders modal footer', () => {
      actor = new SystemPromptModalActor(manager, element, mockVSCode);

      const footer = element.shadowRoot?.querySelector('.modal-footer');
      expect(footer).toBeTruthy();
    });
  });

  describe('Modal visibility', () => {
    beforeEach(() => {
      actor = new SystemPromptModalActor(manager, element, mockVSCode);
    });

    it('starts hidden', () => {
      expect(actor.isVisible()).toBe(false);
    });

    it('opens via systemPrompt.modal.open subscription', async () => {
      await waitForRegistration();
      manager.publishDirect('systemPrompt.modal.open', true);

      expect(actor.isVisible()).toBe(true);
    });

    it('closes on Escape key', async () => {
      await waitForRegistration();
      manager.publishDirect('systemPrompt.modal.open', true);

      const event = new KeyboardEvent('keydown', { key: 'Escape' });
      document.dispatchEvent(event);

      expect(actor.isVisible()).toBe(false);
    });

    it('requests saved prompts when opened', () => {
      actor.open();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'getSavedPrompts'
      });
    });
  });

  describe('Textarea rendering', () => {
    it('renders textarea for system prompt', async () => {
      await openModalWithPrompt();

      const textarea = element.shadowRoot?.querySelector('.prompt-textarea') as HTMLTextAreaElement;
      expect(textarea).toBeTruthy();
    });

    it('populates textarea with current system prompt', async () => {
      await openModalWithPrompt('Always respond concisely');

      const textarea = element.shadowRoot?.querySelector('.prompt-textarea') as HTMLTextAreaElement;
      expect(textarea?.value).toBe('Always respond concisely');
    });

    it('renders hint text', async () => {
      await openModalWithPrompt();

      const hint = element.shadowRoot?.querySelector('.prompt-hint');
      expect(hint).toBeTruthy();
      expect(hint?.textContent).toContain('custom instructions');
    });
  });

  describe('Dirty state', () => {
    it('shows dirty bar when textarea is edited', async () => {
      await openModalWithPrompt('original text');

      const textarea = element.shadowRoot?.querySelector('.prompt-textarea') as HTMLTextAreaElement;
      textarea.value = 'modified text';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));

      const dirtyBar = element.shadowRoot?.querySelector('[data-dirty-bar]');
      expect(dirtyBar?.classList.contains('visible')).toBe(true);
    });

    it('hides dirty bar when textarea matches saved content', async () => {
      await openModalWithPrompt('original text');

      const textarea = element.shadowRoot?.querySelector('.prompt-textarea') as HTMLTextAreaElement;
      // Modify
      textarea.value = 'modified text';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      // Revert
      textarea.value = 'original text';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));

      const dirtyBar = element.shadowRoot?.querySelector('[data-dirty-bar]');
      expect(dirtyBar?.classList.contains('visible')).toBe(false);
    });
  });

  describe('Save (dirty bar)', () => {
    it('sends setSystemPrompt message on dirty-save click', async () => {
      await openModalWithPrompt('');

      const textarea = element.shadowRoot?.querySelector('.prompt-textarea') as HTMLTextAreaElement;
      textarea.value = 'New system prompt';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));

      const saveBtn = element.shadowRoot?.querySelector('[data-action="dirty-save"]') as HTMLElement;
      saveBtn?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'setSystemPrompt',
        systemPrompt: 'New system prompt'
      });
    });
  });

  describe('Discard button', () => {
    it('reverts textarea to saved content on discard', async () => {
      await openModalWithPrompt('original');

      const textarea = element.shadowRoot?.querySelector('.prompt-textarea') as HTMLTextAreaElement;
      textarea.value = 'modified';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));

      const discardBtn = element.shadowRoot?.querySelector('[data-action="dirty-discard"]') as HTMLElement;
      discardBtn?.click();

      expect(textarea.value).toBe('original');
    });

    it('hides dirty bar after discard', async () => {
      await openModalWithPrompt('original');

      const textarea = element.shadowRoot?.querySelector('.prompt-textarea') as HTMLTextAreaElement;
      textarea.value = 'modified';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));

      const discardBtn = element.shadowRoot?.querySelector('[data-action="dirty-discard"]') as HTMLElement;
      discardBtn?.click();

      const dirtyBar = element.shadowRoot?.querySelector('[data-dirty-bar]');
      expect(dirtyBar?.classList.contains('visible')).toBe(false);
    });
  });

  describe('Saved prompts list', () => {
    const samplePrompts = [
      { id: 1, name: 'Concise', content: 'Be concise', model: null, is_active: false, created_at: 1000, updated_at: 1000 },
      { id: 2, name: 'Spanish', content: 'Respond in Spanish', model: 'deepseek-chat', is_active: true, created_at: 2000, updated_at: 2000 }
    ];

    it('renders saved prompts list', async () => {
      await openModalWithPrompt();
      manager.publishDirect('savedPrompts.list', samplePrompts);

      const items = element.shadowRoot?.querySelectorAll('.prompt-saved-item');
      expect(items?.length).toBe(2);
    });

    it('renders prompt names', async () => {
      await openModalWithPrompt();
      manager.publishDirect('savedPrompts.list', samplePrompts);

      const names = element.shadowRoot?.querySelectorAll('.prompt-saved-name');
      const texts = Array.from(names || []).map(n => n.textContent);
      expect(texts).toContain('Concise');
      expect(texts).toContain('Spanish');
    });

    it('shows active badge on active prompt', async () => {
      await openModalWithPrompt();
      manager.publishDirect('savedPrompts.list', samplePrompts);

      const activeBadge = element.shadowRoot?.querySelector('.prompt-saved-active-badge');
      expect(activeBadge).toBeTruthy();
    });

    it('renders model tag for prompts with model', async () => {
      await openModalWithPrompt();
      manager.publishDirect('savedPrompts.list', samplePrompts);

      const modelTag = element.shadowRoot?.querySelector('.prompt-saved-model');
      expect(modelTag).toBeTruthy();
      expect(modelTag?.textContent).toContain('deepseek-chat');
    });

    it('renders empty state when no saved prompts', async () => {
      await openModalWithPrompt();
      manager.publishDirect('savedPrompts.list', []);

      const emptyState = element.shadowRoot?.querySelector('.prompt-saved-empty');
      expect(emptyState).toBeTruthy();
      expect(emptyState?.textContent).toContain('No saved prompts');
    });
  });

  describe('Load prompt', () => {
    const samplePrompts = [
      { id: 1, name: 'Concise', content: 'Be concise', model: null, is_active: false, created_at: 1000, updated_at: 1000 }
    ];

    it('populates textarea when load button is clicked', async () => {
      await openModalWithPrompt('');
      manager.publishDirect('savedPrompts.list', samplePrompts);

      const loadBtn = element.shadowRoot?.querySelector('[data-action="load"]') as HTMLElement;
      expect(loadBtn).toBeTruthy();
      loadBtn?.click();

      const textarea = element.shadowRoot?.querySelector('.prompt-textarea') as HTMLTextAreaElement;
      expect(textarea.value).toBe('Be concise');
    });

    it('sends setActivePrompt message on load', async () => {
      await openModalWithPrompt('');
      manager.publishDirect('savedPrompts.list', samplePrompts);

      const loadBtn = element.shadowRoot?.querySelector('[data-action="load"]') as HTMLElement;
      loadBtn?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'setActivePrompt',
        id: 1
      });
    });

    it('sends setSystemPrompt message on load', async () => {
      await openModalWithPrompt('');
      manager.publishDirect('savedPrompts.list', samplePrompts);

      const loadBtn = element.shadowRoot?.querySelector('[data-action="load"]') as HTMLElement;
      loadBtn?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'setSystemPrompt',
        systemPrompt: 'Be concise'
      });
    });
  });

  describe('Delete saved prompt', () => {
    const samplePrompts = [
      { id: 1, name: 'ToDelete', content: 'content', model: null, is_active: false, created_at: 1000, updated_at: 1000 }
    ];

    it('shows delete confirmation when delete button is clicked', async () => {
      await openModalWithPrompt();
      manager.publishDirect('savedPrompts.list', samplePrompts);

      const deleteBtn = element.shadowRoot?.querySelector('[data-action="confirm-delete"]') as HTMLElement;
      expect(deleteBtn).toBeTruthy();
      deleteBtn?.click();

      const confirmBar = element.shadowRoot?.querySelector('[data-delete-confirm="1"]') as HTMLElement;
      expect(confirmBar).toBeTruthy();
      expect(confirmBar?.style.display).toBe('flex');
    });

    it('sends deleteSavedPrompt message on confirmed delete', async () => {
      await openModalWithPrompt();
      manager.publishDirect('savedPrompts.list', samplePrompts);

      // Show confirmation
      const deleteBtn = element.shadowRoot?.querySelector('[data-action="confirm-delete"]') as HTMLElement;
      deleteBtn?.click();

      // Confirm delete
      const confirmBtn = element.shadowRoot?.querySelector('[data-action="delete-prompt"]') as HTMLElement;
      expect(confirmBtn).toBeTruthy();
      confirmBtn?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'deleteSavedPrompt',
        id: 1
      });
    });

    it('hides confirmation on cancel', async () => {
      await openModalWithPrompt();
      manager.publishDirect('savedPrompts.list', samplePrompts);

      // Show confirmation
      const deleteBtn = element.shadowRoot?.querySelector('[data-action="confirm-delete"]') as HTMLElement;
      deleteBtn?.click();

      // Cancel delete
      const cancelBtn = element.shadowRoot?.querySelector('[data-action="cancel-delete"]') as HTMLElement;
      cancelBtn?.click();

      const confirmBar = element.shadowRoot?.querySelector('[data-delete-confirm="1"]') as HTMLElement;
      expect(confirmBar?.style.display).toBe('none');
    });
  });

  describe('Deactivate prompt', () => {
    const activePrompts = [
      { id: 1, name: 'Active', content: 'active content', model: null, is_active: true, created_at: 1000, updated_at: 1000 }
    ];

    it('sends setActivePrompt with null on deactivate click', async () => {
      await openModalWithPrompt('active content');
      manager.publishDirect('savedPrompts.list', activePrompts);

      const deactivateBtn = element.shadowRoot?.querySelector('[data-action="deactivate"]') as HTMLElement;
      expect(deactivateBtn).toBeTruthy();
      deactivateBtn?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'setActivePrompt',
        id: null
      });
    });

    it('clears textarea on deactivate', async () => {
      await openModalWithPrompt('active content');
      manager.publishDirect('savedPrompts.list', activePrompts);

      const deactivateBtn = element.shadowRoot?.querySelector('[data-action="deactivate"]') as HTMLElement;
      deactivateBtn?.click();

      const textarea = element.shadowRoot?.querySelector('.prompt-textarea') as HTMLTextAreaElement;
      expect(textarea.value).toBe('');
    });

    it('sends setSystemPrompt with empty string on deactivate', async () => {
      await openModalWithPrompt('active content');
      manager.publishDirect('savedPrompts.list', activePrompts);

      const deactivateBtn = element.shadowRoot?.querySelector('[data-action="deactivate"]') as HTMLElement;
      deactivateBtn?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'setSystemPrompt',
        systemPrompt: ''
      });
    });
  });

  describe('New button', () => {
    it('clears textarea on new button click', async () => {
      await openModalWithPrompt('existing');

      const newBtn = element.shadowRoot?.querySelector('[data-action="new"]') as HTMLElement;
      newBtn?.click();

      const textarea = element.shadowRoot?.querySelector('.prompt-textarea') as HTMLTextAreaElement;
      expect(textarea.value).toBe('');
    });

    it('sends setActivePrompt with null on new', async () => {
      await openModalWithPrompt('existing');

      const newBtn = element.shadowRoot?.querySelector('[data-action="new"]') as HTMLElement;
      newBtn?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'setActivePrompt',
        id: null
      });
    });

    it('sends setSystemPrompt with empty string on new', async () => {
      await openModalWithPrompt('existing');

      const newBtn = element.shadowRoot?.querySelector('[data-action="new"]') as HTMLElement;
      newBtn?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'setSystemPrompt',
        systemPrompt: ''
      });
    });
  });

  describe('Save As flow', () => {
    it('shows save-as form when Save As button is clicked', async () => {
      await openModalWithPrompt('');

      const saveAsBtn = element.shadowRoot?.querySelector('[data-action="save-as"]') as HTMLElement;
      saveAsBtn?.click();

      const form = element.shadowRoot?.querySelector('[data-save-as-form]') as HTMLElement;
      expect(form?.style.display).toBe('flex');
    });

    it('hides default footer when save-as form is shown', async () => {
      await openModalWithPrompt('');

      const saveAsBtn = element.shadowRoot?.querySelector('[data-action="save-as"]') as HTMLElement;
      saveAsBtn?.click();

      const defaultFooter = element.shadowRoot?.querySelector('[data-footer-default]') as HTMLElement;
      expect(defaultFooter?.style.display).toBe('none');
    });

    it('sends savePrompt message with name on confirm', async () => {
      await openModalWithPrompt('');

      const textarea = element.shadowRoot?.querySelector('.prompt-textarea') as HTMLTextAreaElement;
      textarea.value = 'My custom instructions';

      const saveAsBtn = element.shadowRoot?.querySelector('[data-action="save-as"]') as HTMLElement;
      saveAsBtn?.click();

      const nameInput = element.shadowRoot?.querySelector('[data-save-as-name]') as HTMLInputElement;
      nameInput.value = 'My Prompt';

      const confirmBtn = element.shadowRoot?.querySelector('[data-action="save-as-confirm"]') as HTMLElement;
      confirmBtn?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'savePrompt',
          name: 'My Prompt',
          content: 'My custom instructions'
        })
      );
    });

    it('rejects empty name on save-as confirm', async () => {
      await openModalWithPrompt('');

      const saveAsBtn = element.shadowRoot?.querySelector('[data-action="save-as"]') as HTMLElement;
      saveAsBtn?.click();

      const nameInput = element.shadowRoot?.querySelector('[data-save-as-name]') as HTMLInputElement;
      nameInput.value = '   ';

      const confirmBtn = element.shadowRoot?.querySelector('[data-action="save-as-confirm"]') as HTMLElement;
      confirmBtn?.click();

      // Should NOT send savePrompt for empty/whitespace name
      expect(mockVSCode.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'savePrompt' })
      );
    });

    it('hides save-as form on cancel', async () => {
      await openModalWithPrompt('');

      const saveAsBtn = element.shadowRoot?.querySelector('[data-action="save-as"]') as HTMLElement;
      saveAsBtn?.click();

      const cancelBtn = element.shadowRoot?.querySelector('[data-action="save-as-cancel"]') as HTMLElement;
      cancelBtn?.click();

      const form = element.shadowRoot?.querySelector('[data-save-as-form]') as HTMLElement;
      expect(form?.style.display).toBe('none');
    });

    it('submits save-as on Enter key in name input', async () => {
      await openModalWithPrompt('');

      const textarea = element.shadowRoot?.querySelector('.prompt-textarea') as HTMLTextAreaElement;
      textarea.value = 'Enter prompt content';

      const saveAsBtn = element.shadowRoot?.querySelector('[data-action="save-as"]') as HTMLElement;
      saveAsBtn?.click();

      const nameInput = element.shadowRoot?.querySelector('[data-save-as-name]') as HTMLInputElement;
      nameInput.value = 'Enter Prompt';

      const keyEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
      nameInput.dispatchEvent(keyEvent);

      expect(mockVSCode.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'savePrompt',
          name: 'Enter Prompt'
        })
      );
    });
  });

  describe('Escape key behavior', () => {
    it('closes save-as form on Escape without closing modal', async () => {
      await openModalWithPrompt('');

      // Open save-as form
      const saveAsBtn = element.shadowRoot?.querySelector('[data-action="save-as"]') as HTMLElement;
      saveAsBtn?.click();

      // Press Escape
      const event = new KeyboardEvent('keydown', { key: 'Escape' });
      document.dispatchEvent(event);

      // Form should be hidden but modal still visible
      const form = element.shadowRoot?.querySelector('[data-save-as-form]') as HTMLElement;
      expect(form?.style.display).toBe('none');
      expect(actor.isVisible()).toBe(true);
    });

    it('closes modal on Escape when save-as form is not shown', async () => {
      await openModalWithPrompt('');

      const event = new KeyboardEvent('keydown', { key: 'Escape' });
      document.dispatchEvent(event);

      expect(actor.isVisible()).toBe(false);
    });
  });

  describe('Lifecycle', () => {
    it('cleans up on destroy', () => {
      actor = new SystemPromptModalActor(manager, element, mockVSCode);
      actor.open();

      actor.destroy();

      expect(() => actor.isVisible()).not.toThrow();
    });
  });
});
