/**
 * Unit tests for StatusPanelActor
 *
 * StatusPanelActor wraps existing DOM elements for the status panel
 * (Moby whale, messages, warnings, errors, logs button, resizable separator).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { StatusPanelActor } from '../../../media/actors/status-panel/StatusPanelActor';

describe('StatusPanelActor', () => {
  let manager: EventStateManager;
  let rootElement: HTMLElement;
  let statusPanelActor: StatusPanelActor;
  let mockVSCode: { postMessage: ReturnType<typeof vi.fn> };

  // Create the DOM structure that StatusPanelActor expects
  function createStatusPanelDOM(): void {
    // Status panel container
    const statusPanel = document.createElement('div');
    statusPanel.className = 'status-panel';
    document.body.appendChild(statusPanel);

    // Moby whale
    const moby = document.createElement('div');
    moby.id = 'statusPanelMoby';
    statusPanel.appendChild(moby);

    // Left panel
    const leftPanel = document.createElement('div');
    leftPanel.className = 'status-panel-left';
    statusPanel.appendChild(leftPanel);

    // Messages element
    const messages = document.createElement('div');
    messages.id = 'statusPanelMessages';
    leftPanel.appendChild(messages);

    // Separator
    const separator = document.createElement('div');
    separator.id = 'statusPanelSeparator';
    statusPanel.appendChild(separator);

    // Right panel
    const rightPanel = document.createElement('div');
    rightPanel.className = 'status-panel-right';
    statusPanel.appendChild(rightPanel);

    // Warnings element
    const warnings = document.createElement('div');
    warnings.id = 'statusPanelWarnings';
    rightPanel.appendChild(warnings);

    // Logs button
    const logsBtn = document.createElement('button');
    logsBtn.id = 'statusPanelLogsBtn';
    statusPanel.appendChild(logsBtn);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new EventStateManager();
    mockVSCode = { postMessage: vi.fn() };

    // Create DOM structure that StatusPanelActor wraps
    createStatusPanelDOM();

    // Create root element for StatusPanelActor (hidden, just for registration)
    rootElement = document.createElement('div');
    rootElement.id = 'status-panel-root';
    document.body.appendChild(rootElement);

    // Create actor
    statusPanelActor = new StatusPanelActor(manager, rootElement, mockVSCode);
  });

  afterEach(() => {
    statusPanelActor.destroy();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  describe('initialization', () => {
    it('binds to existing DOM elements', () => {
      const state = statusPanelActor.getState();
      expect(state).toBeDefined();
      expect(state.message).toBe('');
      expect(state.warning).toBe('');
      expect(state.error).toBe('');
    });

    it('starts with empty state', () => {
      const state = statusPanelActor.getState();
      expect(state.message).toBe('');
      expect(state.warning).toBe('');
      expect(state.error).toBe('');
    });
  });

  describe('showMessage', () => {
    it('displays info message on left side', () => {
      statusPanelActor.showMessage('Test info message');

      const messagesEl = document.getElementById('statusPanelMessages');
      expect(messagesEl?.textContent).toBe('Test info message');
      expect(messagesEl?.title).toBe('Test info message');
    });

    it('triggers blue Moby spurt animation', () => {
      const moby = document.getElementById('statusPanelMoby');
      statusPanelActor.showMessage('Test');

      expect(moby?.classList.contains('spurt-blue')).toBe(true);
      expect(moby?.classList.contains('spurting')).toBe(true);
    });

    it('auto-clears after 5 seconds', () => {
      statusPanelActor.showMessage('Test');

      const messagesEl = document.getElementById('statusPanelMessages');
      expect(messagesEl?.textContent).toBe('Test');

      // Advance timers
      vi.advanceTimersByTime(5000);

      expect(messagesEl?.textContent).toBe('');
    });

    it('publishes status.hasMessage', () => {
      const spy = vi.spyOn(manager, 'handleStateChange');
      statusPanelActor.showMessage('Test');

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            'status.hasMessage': true
          })
        })
      );
    });
  });

  describe('showWarning', () => {
    it('displays warning message on right side', () => {
      statusPanelActor.showWarning('Test warning');

      const warningsEl = document.getElementById('statusPanelWarnings');
      expect(warningsEl?.textContent).toBe('Test warning');
      expect(warningsEl?.classList.contains('warning')).toBe(true);
    });

    it('triggers yellow Moby spurt animation', () => {
      const moby = document.getElementById('statusPanelMoby');
      statusPanelActor.showWarning('Test');

      expect(moby?.classList.contains('spurt-yellow')).toBe(true);
      expect(moby?.classList.contains('spurting')).toBe(true);
    });

    it('adds warning-bg class to right panel', () => {
      statusPanelActor.showWarning('Test');

      const rightPanel = document.querySelector('.status-panel-right');
      expect(rightPanel?.classList.contains('warning-bg')).toBe(true);
    });

    it('auto-clears after 8 seconds', () => {
      statusPanelActor.showWarning('Test');

      const warningsEl = document.getElementById('statusPanelWarnings');
      expect(warningsEl?.textContent).toBe('Test');

      vi.advanceTimersByTime(8000);

      expect(warningsEl?.textContent).toBe('');
    });
  });

  describe('showError', () => {
    it('displays error message on right side', () => {
      statusPanelActor.showError('Test error');

      const warningsEl = document.getElementById('statusPanelWarnings');
      expect(warningsEl?.textContent).toBe('Test error');
      expect(warningsEl?.classList.contains('error')).toBe(true);
    });

    it('triggers red Moby spurt animation', () => {
      const moby = document.getElementById('statusPanelMoby');
      statusPanelActor.showError('Test');

      expect(moby?.classList.contains('spurt-red')).toBe(true);
      expect(moby?.classList.contains('spurting')).toBe(true);
    });

    it('adds error-bg class to right panel', () => {
      statusPanelActor.showError('Test');

      const rightPanel = document.querySelector('.status-panel-right');
      expect(rightPanel?.classList.contains('error-bg')).toBe(true);
    });

    it('auto-clears after 10 seconds', () => {
      statusPanelActor.showError('Test');

      const warningsEl = document.getElementById('statusPanelWarnings');
      expect(warningsEl?.textContent).toBe('Test');

      vi.advanceTimersByTime(10000);

      expect(warningsEl?.textContent).toBe('');
    });
  });

  describe('clear methods', () => {
    it('clearMessage clears info message', () => {
      statusPanelActor.showMessage('Test');
      statusPanelActor.clearMessage();

      const messagesEl = document.getElementById('statusPanelMessages');
      expect(messagesEl?.textContent).toBe('');
    });

    it('clearWarning clears warning', () => {
      statusPanelActor.showWarning('Test');
      statusPanelActor.clearWarning();

      const warningsEl = document.getElementById('statusPanelWarnings');
      expect(warningsEl?.textContent).toBe('');
      expect(warningsEl?.classList.contains('warning')).toBe(false);
    });

    it('clearError clears error (same slot as warning)', () => {
      statusPanelActor.showError('Test');
      statusPanelActor.clearError();

      const warningsEl = document.getElementById('statusPanelWarnings');
      expect(warningsEl?.textContent).toBe('');
      expect(warningsEl?.classList.contains('error')).toBe(false);
    });

    it('clearAll clears all messages', () => {
      statusPanelActor.showMessage('Info');
      statusPanelActor.showWarning('Warning');
      statusPanelActor.clearAll();

      const messagesEl = document.getElementById('statusPanelMessages');
      const warningsEl = document.getElementById('statusPanelWarnings');
      expect(messagesEl?.textContent).toBe('');
      expect(warningsEl?.textContent).toBe('');
    });
  });

  describe('logs button', () => {
    it('posts showLogs message when clicked', () => {
      const logsBtn = document.getElementById('statusPanelLogsBtn') as HTMLButtonElement;
      logsBtn.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({ type: 'showLogs' });
    });

    it('calls onLogs handler when clicked', () => {
      const logsHandler = vi.fn();
      statusPanelActor.onLogs(logsHandler);

      const logsBtn = document.getElementById('statusPanelLogsBtn') as HTMLButtonElement;
      logsBtn.click();

      expect(logsHandler).toHaveBeenCalled();
    });
  });

  describe('message replacement', () => {
    it('new message replaces old message', () => {
      statusPanelActor.showMessage('First');
      statusPanelActor.showMessage('Second');

      const messagesEl = document.getElementById('statusPanelMessages');
      expect(messagesEl?.textContent).toBe('Second');
    });

    it('new warning replaces old warning', () => {
      statusPanelActor.showWarning('First');
      statusPanelActor.showWarning('Second');

      const warningsEl = document.getElementById('statusPanelWarnings');
      expect(warningsEl?.textContent).toBe('Second');
    });

    it('error replaces warning in same slot', () => {
      statusPanelActor.showWarning('Warning');
      statusPanelActor.showError('Error');

      const warningsEl = document.getElementById('statusPanelWarnings');
      expect(warningsEl?.textContent).toBe('Error');
      expect(warningsEl?.classList.contains('error')).toBe(true);
      expect(warningsEl?.classList.contains('warning')).toBe(false);
    });
  });

  describe('Moby animation cleanup', () => {
    it('removes spurting class after 700ms', () => {
      const moby = document.getElementById('statusPanelMoby');
      statusPanelActor.showMessage('Test');

      expect(moby?.classList.contains('spurting')).toBe(true);

      vi.advanceTimersByTime(700);

      expect(moby?.classList.contains('spurting')).toBe(false);
    });
  });
});
