/**
 * Tests for ToolbarShadowActor
 *
 * Tests Shadow DOM encapsulation, edit mode cycling,
 * web search toggle, plan button, and send/stop controls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolbarShadowActor, EditMode } from '../../../media/actors/toolbar/ToolbarShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { ShadowActor } from '../../../media/state/ShadowActor';

describe('ToolbarShadowActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: ToolbarShadowActor;
  let mockVscode: { postMessage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'toolbar-container';
    document.body.appendChild(element);
    mockVscode = { postMessage: vi.fn() };
    ShadowActor.resetInstanceCount();
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
  });

  describe('Shadow DOM creation', () => {
    it('creates shadow root on element', () => {
      actor = new ToolbarShadowActor(manager, element, mockVscode);
      expect(element.shadowRoot).toBeTruthy();
    });

    it('renders toolbar buttons', () => {
      actor = new ToolbarShadowActor(manager, element, mockVscode);

      expect(element.shadowRoot?.querySelector('.toolbar')).toBeTruthy();
      expect(element.shadowRoot?.querySelector('.files-btn')).toBeTruthy();
      expect(element.shadowRoot?.querySelector('.edit-mode-btn')).toBeTruthy();
      expect(element.shadowRoot?.querySelector('.plan-btn')).toBeTruthy();
      expect(element.shadowRoot?.querySelector('.search-btn')).toBeTruthy();
      expect(element.shadowRoot?.querySelector('.attach-btn')).toBeTruthy();
      expect(element.shadowRoot?.querySelector('.send-btn')).toBeTruthy();
      expect(element.shadowRoot?.querySelector('.stop-btn')).toBeTruthy();
    });
  });

  describe('Edit mode', () => {
    beforeEach(() => {
      actor = new ToolbarShadowActor(manager, element, mockVscode);
    });

    it('starts in manual mode', () => {
      expect(actor.getState().editMode).toBe('manual');
    });

    it('cycles through edit modes on click', () => {
      const editBtn = element.shadowRoot?.querySelector('.edit-mode-btn') as HTMLButtonElement;

      editBtn.click();
      expect(actor.getState().editMode).toBe('ask');

      editBtn.click();
      expect(actor.getState().editMode).toBe('auto');

      editBtn.click();
      expect(actor.getState().editMode).toBe('manual');
    });

    it('calls handler when mode changes', () => {
      const handler = vi.fn();
      actor.onEditModeChange(handler);

      const editBtn = element.shadowRoot?.querySelector('.edit-mode-btn') as HTMLButtonElement;
      editBtn.click();

      expect(handler).toHaveBeenCalledWith('ask');
    });

    it('posts message to vscode on mode change', () => {
      const editBtn = element.shadowRoot?.querySelector('.edit-mode-btn') as HTMLButtonElement;
      editBtn.click();

      expect(mockVscode.postMessage).toHaveBeenCalledWith({
        type: 'setEditMode',
        mode: 'ask'
      });
    });

    it('can set mode programmatically', () => {
      actor.setEditMode('auto');
      expect(actor.getState().editMode).toBe('auto');
    });

    it('updates button title on mode change', () => {
      const editBtn = element.shadowRoot?.querySelector('.edit-mode-btn') as HTMLButtonElement;

      actor.setEditMode('ask');
      expect(editBtn.title).toContain('Ask before applying');

      actor.setEditMode('auto');
      expect(editBtn.title).toContain('Auto-apply');
    });
  });

  describe('Files button', () => {
    beforeEach(() => {
      actor = new ToolbarShadowActor(manager, element, mockVscode);
    });

    it('calls handler when clicked', () => {
      const handler = vi.fn();
      actor.onFilesOpen(handler);

      const filesBtn = element.shadowRoot?.querySelector('.files-btn') as HTMLButtonElement;
      filesBtn.click();

      expect(handler).toHaveBeenCalled();
    });

    it('posts messages to vscode', () => {
      const filesBtn = element.shadowRoot?.querySelector('.files-btn') as HTMLButtonElement;
      filesBtn.click();

      expect(mockVscode.postMessage).toHaveBeenCalledWith({ type: 'getOpenFiles' });
      expect(mockVscode.postMessage).toHaveBeenCalledWith({ type: 'fileModalOpened' });
    });

    it('updates filesModalOpen state', () => {
      const filesBtn = element.shadowRoot?.querySelector('.files-btn') as HTMLButtonElement;
      filesBtn.click();

      expect(actor.getState().filesModalOpen).toBe(true);
    });
  });

  describe('Plan button', () => {
    beforeEach(() => {
      actor = new ToolbarShadowActor(manager, element, mockVscode);
    });

    it('starts disabled', () => {
      expect(actor.getState().planEnabled).toBe(false);
    });

    it('toggles plan state on click', () => {
      const planBtn = element.shadowRoot?.querySelector('.plan-btn') as HTMLButtonElement;

      planBtn.click();
      expect(actor.getState().planEnabled).toBe(true);
      expect(planBtn.classList.contains('active')).toBe(true);

      planBtn.click();
      expect(actor.getState().planEnabled).toBe(false);
      expect(planBtn.classList.contains('active')).toBe(false);
    });

    it('calls handler when toggled', () => {
      const handler = vi.fn();
      actor.onPlan(handler);

      const planBtn = element.shadowRoot?.querySelector('.plan-btn') as HTMLButtonElement;
      planBtn.click();

      expect(handler).toHaveBeenCalledWith(true);

      planBtn.click();
      expect(handler).toHaveBeenCalledWith(false);
    });

    it('posts message to vscode on toggle', () => {
      const planBtn = element.shadowRoot?.querySelector('.plan-btn') as HTMLButtonElement;
      planBtn.click();

      expect(mockVscode.postMessage).toHaveBeenCalledWith({
        type: 'togglePlan',
        enabled: true
      });
    });
  });

  describe('Web search', () => {
    beforeEach(() => {
      actor = new ToolbarShadowActor(manager, element, mockVscode);
    });

    it('opens web search modal on click', () => {
      const searchBtn = element.shadowRoot?.querySelector('.search-btn') as HTMLButtonElement;
      searchBtn.click();

      const modal = document.body.querySelector('.web-search-modal');
      expect(modal).toBeTruthy();
    });

    it('enables web search when enable button clicked', () => {
      const searchBtn = element.shadowRoot?.querySelector('.search-btn') as HTMLButtonElement;
      searchBtn.click();

      const enableBtn = document.body.querySelector('.web-search-enable-btn') as HTMLButtonElement;
      enableBtn.click();

      expect(actor.getState().webSearchEnabled).toBe(true);
      expect(searchBtn.classList.contains('active')).toBe(true);
    });

    it('disables web search when clicking while enabled', () => {
      actor.setWebSearchEnabled(true);

      const searchBtn = element.shadowRoot?.querySelector('.search-btn') as HTMLButtonElement;
      searchBtn.click();

      expect(actor.getState().webSearchEnabled).toBe(false);
    });

    it('calls handler with settings when enabled', () => {
      const handler = vi.fn();
      actor.onWebSearchToggle(handler);

      const searchBtn = element.shadowRoot?.querySelector('.search-btn') as HTMLButtonElement;
      searchBtn.click();

      const enableBtn = document.body.querySelector('.web-search-enable-btn') as HTMLButtonElement;
      enableBtn.click();

      expect(handler).toHaveBeenCalledWith(true, expect.objectContaining({
        searchesPerPrompt: expect.any(Number),
        searchDepth: expect.any(String)
      }));
    });
  });

  describe('State', () => {
    beforeEach(() => {
      actor = new ToolbarShadowActor(manager, element, mockVscode);
    });

    it('returns current state', () => {
      const state = actor.getState();

      expect(state).toEqual({
        editMode: 'manual',
        webSearchEnabled: false,
        filesModalOpen: false,
        planEnabled: false,
        streaming: false
      });
    });
  });

  describe('Send/Stop/Attach buttons', () => {
    beforeEach(() => {
      actor = new ToolbarShadowActor(manager, element, mockVscode);
    });

    it('calls onSend handler when send clicked', () => {
      const handler = vi.fn();
      actor.onSend(handler);

      const sendBtn = element.shadowRoot?.querySelector('.send-btn') as HTMLButtonElement;
      sendBtn.click();

      expect(handler).toHaveBeenCalled();
    });

    it('calls onStop handler when stop clicked', () => {
      const handler = vi.fn();
      actor.onStop(handler);

      const stopBtn = element.shadowRoot?.querySelector('.stop-btn') as HTMLButtonElement;
      stopBtn.click();

      expect(handler).toHaveBeenCalled();
    });

    it('posts stopGeneration message to vscode on stop', () => {
      const stopBtn = element.shadowRoot?.querySelector('.stop-btn') as HTMLButtonElement;
      stopBtn.click();

      expect(mockVscode.postMessage).toHaveBeenCalledWith({ type: 'stopGeneration' });
    });

    it('calls onAttach handler when attach clicked', () => {
      const handler = vi.fn();
      actor.onAttach(handler);

      const attachBtn = element.shadowRoot?.querySelector('.attach-btn') as HTMLButtonElement;
      attachBtn.click();

      expect(handler).toHaveBeenCalled();
    });

    it('shows send button by default, stop hidden', () => {
      const sendBtn = element.shadowRoot?.querySelector('.send-btn') as HTMLButtonElement;
      const stopBtn = element.shadowRoot?.querySelector('.stop-btn') as HTMLButtonElement;

      expect(sendBtn.style.display).not.toBe('none');
      expect(stopBtn.style.display).toBe('none');
    });
  });

  describe('Streaming subscription', () => {
    beforeEach(async () => {
      actor = new ToolbarShadowActor(manager, element, mockVscode);
      await Promise.resolve();
      await Promise.resolve();
    });

    it('tracks streaming state', () => {
      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.active': true },
        changedKeys: ['streaming.active'],
        publicationChain: [],
        timestamp: Date.now()
      });

      expect(actor.getState().streaming).toBe(true);
    });

    it('shows stop button when streaming', () => {
      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.active': true },
        changedKeys: ['streaming.active'],
        publicationChain: [],
        timestamp: Date.now()
      });

      const sendBtn = element.shadowRoot?.querySelector('.send-btn') as HTMLButtonElement;
      const stopBtn = element.shadowRoot?.querySelector('.stop-btn') as HTMLButtonElement;

      expect(sendBtn.style.display).toBe('none');
      expect(stopBtn.style.display).toBe('flex');
    });
  });

  describe('Lifecycle', () => {
    it('cleans up modals on destroy', () => {
      actor = new ToolbarShadowActor(manager, element, mockVscode);

      // Open web search modal
      const searchBtn = element.shadowRoot?.querySelector('.search-btn') as HTMLButtonElement;
      searchBtn.click();

      expect(document.body.querySelector('.web-search-modal')).toBeTruthy();

      actor.destroy();

      expect(document.body.querySelector('.web-search-modal')).toBeNull();
    });
  });
});
