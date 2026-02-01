/**
 * Unit tests for StatusPanelActor
 *
 * Tests the status panel functionality including:
 * - Message display (info, warning, error)
 * - Moby water spurt animations
 * - Auto-clear timeouts
 * - State publications
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { StatusPanelActor } from '../../../media/actors/status-panel/StatusPanelActor';

// Mock VSCode API
const createMockVSCodeAPI = () => ({
  postMessage: vi.fn()
});

describe('StatusPanelActor', () => {
  let manager: EventStateManager;
  let actor: StatusPanelActor;
  let root: HTMLDivElement;
  let mockVSCode: ReturnType<typeof createMockVSCodeAPI>;

  // DOM elements that StatusPanelActor looks for
  let mobyEl: HTMLDivElement;
  let messagesEl: HTMLDivElement;
  let warningsEl: HTMLDivElement;
  let leftPanel: HTMLDivElement;
  let rightPanel: HTMLDivElement;
  let separatorEl: HTMLDivElement;
  let logsBtnEl: HTMLButtonElement;

  beforeEach(() => {
    vi.useFakeTimers();

    // Create mock DOM structure that StatusPanelActor expects
    const statusPanel = document.createElement('div');
    statusPanel.className = 'status-panel';

    // Moby whale element
    mobyEl = document.createElement('div');
    mobyEl.id = 'statusPanelMoby';
    statusPanel.appendChild(mobyEl);

    // Left panel with messages
    leftPanel = document.createElement('div');
    leftPanel.className = 'status-panel-left';
    statusPanel.appendChild(leftPanel);

    messagesEl = document.createElement('div');
    messagesEl.id = 'statusPanelMessages';
    leftPanel.appendChild(messagesEl);

    // Separator
    separatorEl = document.createElement('div');
    separatorEl.id = 'statusPanelSeparator';
    statusPanel.appendChild(separatorEl);

    // Right panel with warnings
    rightPanel = document.createElement('div');
    rightPanel.className = 'status-panel-right';
    statusPanel.appendChild(rightPanel);

    warningsEl = document.createElement('div');
    warningsEl.id = 'statusPanelWarnings';
    rightPanel.appendChild(warningsEl);

    // Logs button
    logsBtnEl = document.createElement('button');
    logsBtnEl.id = 'statusPanelLogsBtn';
    statusPanel.appendChild(logsBtnEl);

    // Root element for actor
    root = document.createElement('div');
    root.id = 'statusPanelRoot';

    document.body.appendChild(statusPanel);
    document.body.appendChild(root);

    manager = new EventStateManager();
    mockVSCode = createMockVSCodeAPI();
    actor = new StatusPanelActor(manager, root, mockVSCode);
  });

  afterEach(() => {
    vi.useRealTimers();
    actor.destroy();
    document.body.innerHTML = '';
  });

  describe('showMessage', () => {
    it('displays message in messages element', () => {
      actor.showMessage('Test info message');

      expect(messagesEl.textContent).toBe('Test info message');
      expect(messagesEl.title).toBe('Test info message');
    });

    it('triggers blue Moby spurt', () => {
      actor.showMessage('Info message');

      expect(mobyEl.classList.contains('spurt-blue')).toBe(true);
      expect(mobyEl.classList.contains('spurting')).toBe(true);
    });

    it('removes spurting class after animation', () => {
      actor.showMessage('Info message');

      expect(mobyEl.classList.contains('spurting')).toBe(true);

      vi.advanceTimersByTime(700);

      expect(mobyEl.classList.contains('spurting')).toBe(false);
    });

    it('auto-clears after 5 seconds', () => {
      actor.showMessage('Auto-clear message');

      expect(messagesEl.textContent).toBe('Auto-clear message');

      vi.advanceTimersByTime(5000);

      expect(messagesEl.textContent).toBe('');
    });

    it('resets timeout when new message shown', () => {
      actor.showMessage('First message');

      vi.advanceTimersByTime(3000);

      actor.showMessage('Second message');

      // After 5s from first message (but only 2s from second), should still show
      vi.advanceTimersByTime(2000);
      expect(messagesEl.textContent).toBe('Second message');

      // After 5s from second message, should clear
      vi.advanceTimersByTime(3000);
      expect(messagesEl.textContent).toBe('');
    });

    it('publishes status.hasMessage', async () => {
      const receivedState: Record<string, unknown> = {};
      const subscriber = document.createElement('div');
      subscriber.id = 'test-subscriber';
      document.body.appendChild(subscriber);

      subscriber.addEventListener('state-changed', ((e: CustomEvent) => {
        Object.assign(receivedState, e.detail.state);
      }) as EventListener);

      manager.register({
        actorId: 'test-subscriber',
        element: subscriber,
        publicationKeys: [],
        subscriptionKeys: ['status.*']
      }, {});

      actor.showMessage('Publish test');

      // Allow pub/sub to propagate
      await Promise.resolve();

      expect(receivedState['status.hasMessage']).toBe(true);
    });
  });

  describe('showWarning', () => {
    it('displays warning in warnings element', () => {
      actor.showWarning('Test warning');

      expect(warningsEl.textContent).toBe('Test warning');
      expect(warningsEl.title).toBe('Test warning');
    });

    it('adds warning class to element', () => {
      actor.showWarning('Warning message');

      expect(warningsEl.classList.contains('warning')).toBe(true);
      expect(warningsEl.classList.contains('error')).toBe(false);
    });

    it('adds warning-bg class to right panel', () => {
      actor.showWarning('Warning message');

      expect(rightPanel.classList.contains('warning-bg')).toBe(true);
      expect(rightPanel.classList.contains('error-bg')).toBe(false);
    });

    it('triggers yellow Moby spurt', () => {
      actor.showWarning('Warning');

      expect(mobyEl.classList.contains('spurt-yellow')).toBe(true);
      expect(mobyEl.classList.contains('spurting')).toBe(true);
    });

    it('auto-clears after 8 seconds', () => {
      actor.showWarning('Auto-clear warning');

      expect(warningsEl.textContent).toBe('Auto-clear warning');

      vi.advanceTimersByTime(8000);

      expect(warningsEl.textContent).toBe('');
    });

    it('clears existing error when showing warning', () => {
      actor.showError('First error');
      expect(actor.getState().error).toBe('First error');

      actor.showWarning('New warning');

      expect(actor.getState().error).toBe('');
      expect(actor.getState().warning).toBe('New warning');
    });
  });

  describe('showError', () => {
    it('displays error in warnings element', () => {
      actor.showError('Test error');

      expect(warningsEl.textContent).toBe('Test error');
      expect(warningsEl.title).toBe('Test error');
    });

    it('adds error class to element', () => {
      actor.showError('Error message');

      expect(warningsEl.classList.contains('error')).toBe(true);
      expect(warningsEl.classList.contains('warning')).toBe(false);
    });

    it('adds error-bg class to right panel', () => {
      actor.showError('Error message');

      expect(rightPanel.classList.contains('error-bg')).toBe(true);
      expect(rightPanel.classList.contains('warning-bg')).toBe(false);
    });

    it('triggers red Moby spurt', () => {
      actor.showError('Error');

      expect(mobyEl.classList.contains('spurt-red')).toBe(true);
      expect(mobyEl.classList.contains('spurting')).toBe(true);
    });

    it('auto-clears after 10 seconds', () => {
      actor.showError('Auto-clear error');

      expect(warningsEl.textContent).toBe('Auto-clear error');

      vi.advanceTimersByTime(10000);

      expect(warningsEl.textContent).toBe('');
    });

    it('clears existing warning when showing error', () => {
      actor.showWarning('First warning');
      expect(actor.getState().warning).toBe('First warning');

      actor.showError('New error');

      expect(actor.getState().warning).toBe('');
      expect(actor.getState().error).toBe('New error');
    });
  });

  describe('clearMessage', () => {
    it('clears the message text', () => {
      actor.showMessage('Message to clear');
      expect(messagesEl.textContent).toBe('Message to clear');

      actor.clearMessage();

      expect(messagesEl.textContent).toBe('');
      expect(messagesEl.title).toBe('');
    });

    it('cancels auto-clear timeout', () => {
      actor.showMessage('Message');
      actor.clearMessage();

      // Advance past auto-clear time - should not throw
      vi.advanceTimersByTime(10000);

      expect(messagesEl.textContent).toBe('');
    });

    it('publishes status.hasMessage as false', async () => {
      const receivedState: Record<string, unknown> = {};
      const subscriber = document.createElement('div');
      subscriber.id = 'test-subscriber-clear';
      document.body.appendChild(subscriber);

      subscriber.addEventListener('state-changed', ((e: CustomEvent) => {
        Object.assign(receivedState, e.detail.state);
      }) as EventListener);

      manager.register({
        actorId: 'test-subscriber-clear',
        element: subscriber,
        publicationKeys: [],
        subscriptionKeys: ['status.*']
      }, {});

      actor.showMessage('Message');
      await Promise.resolve();

      actor.clearMessage();
      await Promise.resolve();

      expect(receivedState['status.hasMessage']).toBe(false);
    });
  });

  describe('clearWarning / clearError', () => {
    it('clears warning text and classes', () => {
      actor.showWarning('Warning to clear');

      actor.clearWarning();

      expect(warningsEl.textContent).toBe('');
      expect(warningsEl.classList.contains('warning')).toBe(false);
      expect(rightPanel.classList.contains('warning-bg')).toBe(false);
    });

    it('clears error text and classes', () => {
      actor.showError('Error to clear');

      actor.clearError();

      expect(warningsEl.textContent).toBe('');
      expect(warningsEl.classList.contains('error')).toBe(false);
      expect(rightPanel.classList.contains('error-bg')).toBe(false);
    });

    it('clearError is alias for clearWarning', () => {
      actor.showError('Error');
      actor.clearError();

      expect(actor.getState().error).toBe('');
      expect(actor.getState().warning).toBe('');
    });
  });

  describe('clearAll', () => {
    it('clears both message and warning/error', () => {
      actor.showMessage('Info');
      actor.showWarning('Warning');

      actor.clearAll();

      expect(messagesEl.textContent).toBe('');
      expect(warningsEl.textContent).toBe('');
    });
  });

  describe('getState', () => {
    it('returns current state', () => {
      expect(actor.getState()).toEqual({
        message: '',
        warning: '',
        error: ''
      });

      actor.showMessage('Info');
      actor.showWarning('Warn');

      expect(actor.getState()).toEqual({
        message: 'Info',
        warning: 'Warn',
        error: ''
      });
    });
  });

  describe('logs button', () => {
    it('sends showLogs message to vscode when clicked', () => {
      logsBtnEl.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({ type: 'showLogs' });
    });

    it('calls onLogs handler when set', () => {
      const handler = vi.fn();
      actor.onLogs(handler);

      logsBtnEl.click();

      expect(handler).toHaveBeenCalled();
    });
  });

  describe('Moby spurt color switching', () => {
    it('switches from blue to yellow', () => {
      actor.showMessage('Blue');
      expect(mobyEl.classList.contains('spurt-blue')).toBe(true);

      actor.showWarning('Yellow');
      expect(mobyEl.classList.contains('spurt-yellow')).toBe(true);
      expect(mobyEl.classList.contains('spurt-blue')).toBe(false);
    });

    it('switches from yellow to red', () => {
      actor.showWarning('Yellow');
      expect(mobyEl.classList.contains('spurt-yellow')).toBe(true);

      actor.showError('Red');
      expect(mobyEl.classList.contains('spurt-red')).toBe(true);
      expect(mobyEl.classList.contains('spurt-yellow')).toBe(false);
    });

    it('switches from red to blue', () => {
      actor.showError('Red');
      expect(mobyEl.classList.contains('spurt-red')).toBe(true);

      actor.showMessage('Blue');
      expect(mobyEl.classList.contains('spurt-blue')).toBe(true);
      expect(mobyEl.classList.contains('spurt-red')).toBe(false);
    });
  });
});
