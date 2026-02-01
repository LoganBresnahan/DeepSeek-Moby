/**
 * Unit tests for ToolbarActor
 *
 * ToolbarActor wraps existing DOM elements for the input toolbar
 * (Files, Edit Mode, Help, Search buttons and their modals).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushMicrotasks } from '../../setup';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { ToolbarActor } from '../../../media/actors/toolbar/ToolbarActor';
import { StreamingActor } from '../../../media/actors/streaming/StreamingActor';

describe('ToolbarActor', () => {
  let manager: EventStateManager;
  let rootElement: HTMLElement;
  let streamingElement: HTMLElement;
  let toolbarActor: ToolbarActor;
  let streamingActor: StreamingActor;
  let mockVSCode: { postMessage: ReturnType<typeof vi.fn> };

  // Create the DOM structure that ToolbarActor expects
  function createToolbarDOM(): void {
    // Files button
    const filesBtn = document.createElement('button');
    filesBtn.id = 'filesBtn';
    document.body.appendChild(filesBtn);

    // Edit mode button
    const editModeBtn = document.createElement('button');
    editModeBtn.id = 'editModeBtn';
    document.body.appendChild(editModeBtn);

    // Edit mode icon (SVG)
    const editModeIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    editModeIcon.id = 'editModeIcon';
    document.body.appendChild(editModeIcon);

    // Help button
    const helpBtn = document.createElement('button');
    helpBtn.id = 'helpBtn';
    helpBtn.className = 'help-btn';
    document.body.appendChild(helpBtn);

    // Search button
    const searchBtn = document.createElement('button');
    searchBtn.id = 'searchBtn';
    searchBtn.className = 'search-btn';
    document.body.appendChild(searchBtn);
  }

  beforeEach(() => {
    // Reset styles injection
    StreamingActor.resetStylesInjected();

    manager = new EventStateManager();
    mockVSCode = { postMessage: vi.fn() };

    // Create DOM structure that ToolbarActor wraps
    createToolbarDOM();

    // Create root element for ToolbarActor (hidden, just for registration)
    rootElement = document.createElement('div');
    rootElement.id = 'toolbar-root';
    document.body.appendChild(rootElement);

    // Create streaming element for streaming actor
    streamingElement = document.createElement('div');
    streamingElement.id = 'streaming-root';
    document.body.appendChild(streamingElement);

    // Create actors
    streamingActor = new StreamingActor(manager, streamingElement);
    toolbarActor = new ToolbarActor(manager, rootElement, mockVSCode);
  });

  afterEach(() => {
    toolbarActor.destroy();
    streamingActor.destroy();
    document.body.innerHTML = '';
  });

  describe('initialization', () => {
    it('binds to existing DOM elements', () => {
      const state = toolbarActor.getState();
      expect(state).toBeDefined();
      expect(state.editMode).toBe('manual');
      expect(state.webSearchEnabled).toBe(false);
    });

    it('starts with default state', () => {
      const state = toolbarActor.getState();
      expect(state.editMode).toBe('manual');
      expect(state.webSearchEnabled).toBe(false);
      expect(state.filesModalOpen).toBe(false);
      expect(state.commandsModalOpen).toBe(false);
    });
  });

  describe('files button', () => {
    it('calls onFilesOpen handler when clicked', () => {
      const filesHandler = vi.fn();
      toolbarActor.onFilesOpen(filesHandler);

      const filesBtn = document.getElementById('filesBtn') as HTMLButtonElement;
      filesBtn.click();

      expect(filesHandler).toHaveBeenCalled();
    });

    it('posts getOpenFiles message to VS Code', () => {
      const filesBtn = document.getElementById('filesBtn') as HTMLButtonElement;
      filesBtn.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({ type: 'getOpenFiles' });
    });

    it('posts fileModalOpened message to VS Code', () => {
      const filesBtn = document.getElementById('filesBtn') as HTMLButtonElement;
      filesBtn.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({ type: 'fileModalOpened' });
    });

    it('publishes toolbar.filesModalOpen', () => {
      const spy = vi.spyOn(manager, 'handleStateChange');

      const filesBtn = document.getElementById('filesBtn') as HTMLButtonElement;
      filesBtn.click();

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            'toolbar.filesModalOpen': true
          })
        })
      );
    });
  });

  describe('edit mode button', () => {
    it('cycles through edit modes on click', () => {
      const editModeBtn = document.getElementById('editModeBtn') as HTMLButtonElement;

      expect(toolbarActor.getState().editMode).toBe('manual');

      editModeBtn.click();
      expect(toolbarActor.getState().editMode).toBe('ask');

      editModeBtn.click();
      expect(toolbarActor.getState().editMode).toBe('auto');

      editModeBtn.click();
      expect(toolbarActor.getState().editMode).toBe('manual');
    });

    it('calls onEditModeChange handler', () => {
      const editModeHandler = vi.fn();
      toolbarActor.onEditModeChange(editModeHandler);

      const editModeBtn = document.getElementById('editModeBtn') as HTMLButtonElement;
      editModeBtn.click();

      expect(editModeHandler).toHaveBeenCalledWith('ask');
    });

    it('posts setEditMode message to VS Code', () => {
      const editModeBtn = document.getElementById('editModeBtn') as HTMLButtonElement;
      editModeBtn.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({ type: 'setEditMode', mode: 'ask' });
    });

    it('updates button classes', () => {
      const editModeBtn = document.getElementById('editModeBtn') as HTMLButtonElement;

      editModeBtn.click(); // -> ask
      expect(editModeBtn.classList.contains('state-ask')).toBe(true);

      editModeBtn.click(); // -> auto
      expect(editModeBtn.classList.contains('state-auto')).toBe(true);
      expect(editModeBtn.classList.contains('state-ask')).toBe(false);
    });

    it('setEditMode updates state programmatically', () => {
      toolbarActor.setEditMode('auto');
      expect(toolbarActor.getState().editMode).toBe('auto');

      const editModeBtn = document.getElementById('editModeBtn') as HTMLButtonElement;
      expect(editModeBtn.classList.contains('state-auto')).toBe(true);
    });
  });

  describe('help button (commands modal)', () => {
    it('opens commands modal on click', () => {
      const helpBtn = document.getElementById('helpBtn') as HTMLButtonElement;
      helpBtn.click();

      const modal = document.querySelector('.commands-modal');
      expect(modal).toBeTruthy();
    });

    it('shows commands list in modal', () => {
      const helpBtn = document.getElementById('helpBtn') as HTMLButtonElement;
      helpBtn.click();

      const modal = document.querySelector('.commands-modal');
      expect(modal?.querySelector('.commands-list')).toBeTruthy();
      expect(modal?.querySelectorAll('.command-item').length).toBeGreaterThan(0);
    });

    it('closes modal when close button clicked', () => {
      const helpBtn = document.getElementById('helpBtn') as HTMLButtonElement;
      helpBtn.click();

      const closeBtn = document.querySelector('.commands-modal-close') as HTMLButtonElement;
      closeBtn.click();

      const modal = document.querySelector('.commands-modal');
      expect(modal).toBeFalsy();
    });

    it('calls onCommand handler when command clicked', () => {
      const commandHandler = vi.fn();
      toolbarActor.onCommand(commandHandler);

      const helpBtn = document.getElementById('helpBtn') as HTMLButtonElement;
      helpBtn.click();

      const commandItem = document.querySelector('.command-item') as HTMLElement;
      commandItem.click();

      expect(commandHandler).toHaveBeenCalled();
    });

    it('posts executeCommand message when command clicked', () => {
      const helpBtn = document.getElementById('helpBtn') as HTMLButtonElement;
      helpBtn.click();

      const commandItem = document.querySelector('.command-item[data-command="newChat"]') as HTMLElement;
      if (commandItem) {
        commandItem.click();
        expect(mockVSCode.postMessage).toHaveBeenCalledWith({
          type: 'executeCommand',
          command: 'deepseek.newChat'
        });
      }
    });
  });

  describe('search button (web search)', () => {
    it('opens web search modal when clicked (not enabled)', () => {
      const searchBtn = document.getElementById('searchBtn') as HTMLButtonElement;
      searchBtn.click();

      const modal = document.querySelector('.web-search-modal');
      expect(modal).toBeTruthy();
    });

    it('toggles off when already enabled', () => {
      toolbarActor.setWebSearchEnabled(true);

      const searchBtn = document.getElementById('searchBtn') as HTMLButtonElement;
      searchBtn.click();

      expect(toolbarActor.getState().webSearchEnabled).toBe(false);
      expect(mockVSCode.postMessage).toHaveBeenCalledWith({ type: 'toggleWebSearch', enabled: false });
    });

    it('setWebSearchEnabled updates state', () => {
      toolbarActor.setWebSearchEnabled(true);
      expect(toolbarActor.getState().webSearchEnabled).toBe(true);

      const searchBtn = document.getElementById('searchBtn') as HTMLButtonElement;
      expect(searchBtn.classList.contains('active')).toBe(true);
    });

    it('enable button in modal enables web search', () => {
      const searchBtn = document.getElementById('searchBtn') as HTMLButtonElement;
      searchBtn.click();

      const enableBtn = document.querySelector('.web-search-enable-btn') as HTMLButtonElement;
      enableBtn.click();

      expect(toolbarActor.getState().webSearchEnabled).toBe(true);
      expect(mockVSCode.postMessage).toHaveBeenCalledWith({ type: 'toggleWebSearch', enabled: true });
    });

    it('calls onWebSearchToggle handler', () => {
      const webSearchHandler = vi.fn();
      toolbarActor.onWebSearchToggle(webSearchHandler);

      const searchBtn = document.getElementById('searchBtn') as HTMLButtonElement;
      searchBtn.click();

      const enableBtn = document.querySelector('.web-search-enable-btn') as HTMLButtonElement;
      enableBtn.click();

      expect(webSearchHandler).toHaveBeenCalledWith(true, expect.any(Object));
    });
  });

  describe('closeFilesModal', () => {
    it('posts fileModalClosed message', () => {
      // Open first
      const filesBtn = document.getElementById('filesBtn') as HTMLButtonElement;
      filesBtn.click();

      // Then close
      toolbarActor.closeFilesModal();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({ type: 'fileModalClosed' });
    });

    it('publishes toolbar.filesModalOpen: false', () => {
      // Open first
      const filesBtn = document.getElementById('filesBtn') as HTMLButtonElement;
      filesBtn.click();

      const spy = vi.spyOn(manager, 'handleStateChange');

      toolbarActor.closeFilesModal();

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            'toolbar.filesModalOpen': false
          })
        })
      );
    });
  });

  describe('streaming state', () => {
    it('tracks streaming state from subscription', async () => {
      streamingActor.startStream('msg-1');
      await flushMicrotasks();

      expect(toolbarActor.getState().streaming).toBe(true);

      streamingActor.endStream();
      await flushMicrotasks();

      expect(toolbarActor.getState().streaming).toBe(false);
    });
  });
});
