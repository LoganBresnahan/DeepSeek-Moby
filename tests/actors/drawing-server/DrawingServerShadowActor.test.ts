/**
 * Tests for DrawingServerShadowActor
 *
 * Tests the Shadow DOM popup for drawing server controls including:
 * - Shadow root creation and structure
 * - Stopped state rendering (start button)
 * - Running state rendering (URL, QR code, stop button)
 * - Start/stop/copy button click messages
 * - updateState() method updates UI
 * - isServerRunning getter
 * - Starting state (disabled button)
 * - WSL2 port forward command display
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DrawingServerShadowActor,
  DrawingServerState
} from '../../../media/actors/drawing-server/DrawingServerShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { ShadowActor } from '../../../media/state/ShadowActor';

// Mock VSCode API
const createMockVSCode = () => ({
  postMessage: vi.fn()
});

// Helper to wait for actor registration (deferred via queueMicrotask)
const waitForRegistration = () => new Promise(resolve => queueMicrotask(resolve));

describe('DrawingServerShadowActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: DrawingServerShadowActor;
  let mockVSCode: ReturnType<typeof createMockVSCode>;

  beforeEach(() => {
    manager = new EventStateManager({ batchBroadcasts: false });
    element = document.createElement('div');
    element.id = 'drawing-server-container';
    document.body.appendChild(element);
    mockVSCode = createMockVSCode();
    ShadowActor.resetInstanceCount();
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
  });

  describe('Shadow DOM creation', () => {
    it('creates shadow root on construction', () => {
      actor = new DrawingServerShadowActor(manager, element, mockVSCode);

      expect(element.shadowRoot).toBeTruthy();
    });

    it('adopts stylesheets into shadow root', () => {
      actor = new DrawingServerShadowActor(manager, element, mockVSCode);

      const sheets = element.shadowRoot?.adoptedStyleSheets;
      expect(sheets?.length).toBeGreaterThan(0);
    });

    it('renders popup structure with header', () => {
      actor = new DrawingServerShadowActor(manager, element, mockVSCode);

      const popup = element.shadowRoot?.querySelector('.popup-container');
      const header = element.shadowRoot?.querySelector('.popup-header');
      const body = element.shadowRoot?.querySelector('.popup-body');

      expect(popup).toBeTruthy();
      expect(header?.textContent).toContain('Drawing Pad');
      expect(body).toBeTruthy();
    });
  });

  describe('Stopped state rendering', () => {
    it('renders start button when server is stopped', () => {
      actor = new DrawingServerShadowActor(manager, element, mockVSCode);

      const startBtn = element.shadowRoot?.querySelector('[data-action="start"]');
      expect(startBtn).toBeTruthy();
      expect(startBtn?.textContent).toContain('Start Server');
    });

    it('renders description text when stopped', () => {
      actor = new DrawingServerShadowActor(manager, element, mockVSCode);

      const desc = element.shadowRoot?.querySelector('.ds-description');
      expect(desc).toBeTruthy();
      expect(desc?.textContent).toContain('Draw on your phone');
    });

    it('does not render stop button when stopped', () => {
      actor = new DrawingServerShadowActor(manager, element, mockVSCode);

      const stopBtn = element.shadowRoot?.querySelector('[data-action="stop"]');
      expect(stopBtn).toBeNull();
    });
  });

  describe('Running state rendering', () => {
    beforeEach(() => {
      actor = new DrawingServerShadowActor(manager, element, mockVSCode);
    });

    it('renders running state with URL display', () => {
      actor.updateState({
        running: true,
        url: 'http://192.168.1.100:3000'
      });

      const urlText = element.shadowRoot?.querySelector('.ds-url-text');
      expect(urlText).toBeTruthy();
      expect(urlText?.textContent).toContain('192.168.1.100:3000');
    });

    it('renders stop button when running', () => {
      actor.updateState({ running: true, url: 'http://localhost:3000' });

      const stopBtn = element.shadowRoot?.querySelector('[data-action="stop"]');
      expect(stopBtn).toBeTruthy();
      expect(stopBtn?.textContent).toContain('Stop Server');
    });

    it('renders status dot when running', () => {
      actor.updateState({ running: true });

      const statusDot = element.shadowRoot?.querySelector('.ds-status-dot');
      expect(statusDot).toBeTruthy();
    });

    it('renders copy button when URL is present', () => {
      actor.updateState({ running: true, url: 'http://localhost:3000' });

      const copyBtn = element.shadowRoot?.querySelector('[data-action="copy"]');
      expect(copyBtn).toBeTruthy();
      expect(copyBtn?.textContent).toContain('Copy');
    });

    it('does not render start button when running', () => {
      actor.updateState({ running: true });

      const startBtn = element.shadowRoot?.querySelector('[data-action="start"]');
      expect(startBtn).toBeNull();
    });

    it('renders QR code when qrMatrix is provided', () => {
      const qrMatrix = [
        [true, false, true],
        [false, true, false],
        [true, false, true]
      ];
      actor.updateState({ running: true, qrMatrix });

      const qrContainer = element.shadowRoot?.querySelector('.ds-qr-container');
      const cells = element.shadowRoot?.querySelectorAll('.ds-qr-cell');
      expect(qrContainer).toBeTruthy();
      expect(cells?.length).toBe(9);
    });

    it('renders WSL2 indicator when isWSL is true', () => {
      actor.updateState({ running: true, isWSL: true });

      const status = element.shadowRoot?.querySelector('.ds-status');
      expect(status?.textContent).toContain('WSL2');
    });

    it('renders port forward command for WSL2', () => {
      actor.updateState({
        running: true,
        isWSL: true,
        portForwardCmd: 'netsh interface portproxy add v4tov4 listenport=3000'
      });

      const wslSection = element.shadowRoot?.querySelector('.ds-wsl-section');
      const cmdEl = element.shadowRoot?.querySelector('.ds-wsl-cmd');
      expect(wslSection).toBeTruthy();
      expect(cmdEl?.textContent).toContain('netsh');
    });
  });

  describe('Button click messages', () => {
    beforeEach(() => {
      actor = new DrawingServerShadowActor(manager, element, mockVSCode);
    });

    it('start button click sends startDrawingServer message', () => {
      const startBtn = element.shadowRoot?.querySelector('[data-action="start"]') as HTMLElement;
      startBtn?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'startDrawingServer'
      });
    });

    it('start button click shows starting state', () => {
      const startBtn = element.shadowRoot?.querySelector('[data-action="start"]') as HTMLElement;
      startBtn?.click();

      const desc = element.shadowRoot?.querySelector('.ds-description');
      expect(desc?.textContent).toContain('Starting server');
    });

    it('stop button click sends stopDrawingServer message', () => {
      actor.updateState({ running: true, url: 'http://localhost:3000' });

      const stopBtn = element.shadowRoot?.querySelector('[data-action="stop"]') as HTMLElement;
      stopBtn?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'stopDrawingServer'
      });
    });

    it('copy button click sends copyToClipboard message with URL', () => {
      actor.updateState({ running: true, url: 'http://192.168.1.100:3000' });

      const copyBtn = element.shadowRoot?.querySelector('[data-action="copy"]') as HTMLElement;
      copyBtn?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'copyToClipboard',
        text: 'http://192.168.1.100:3000'
      });
    });

    it('copy button shows "Copied!" feedback after click', () => {
      actor.updateState({ running: true, url: 'http://localhost:3000' });

      const copyBtn = element.shadowRoot?.querySelector('[data-action="copy"]') as HTMLElement;
      copyBtn?.click();

      expect(copyBtn.textContent).toBe('Copied!');
      expect(copyBtn.classList.contains('copied')).toBe(true);
    });

    it('copy-cmd button sends copyToClipboard with port forward command', () => {
      actor.updateState({
        running: true,
        isWSL: true,
        portForwardCmd: 'netsh interface portproxy add v4tov4 listenport=3000'
      });

      const copyCmdBtn = element.shadowRoot?.querySelector('[data-action="copy-cmd"]') as HTMLElement;
      copyCmdBtn?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'copyToClipboard',
        text: 'netsh interface portproxy add v4tov4 listenport=3000'
      });
    });
  });

  describe('updateState() method', () => {
    beforeEach(() => {
      actor = new DrawingServerShadowActor(manager, element, mockVSCode);
    });

    it('updates UI from stopped to running', () => {
      // Verify initial stopped state
      expect(element.shadowRoot?.querySelector('[data-action="start"]')).toBeTruthy();

      actor.updateState({ running: true, url: 'http://localhost:3000' });

      // Should now show running state
      expect(element.shadowRoot?.querySelector('[data-action="start"]')).toBeNull();
      expect(element.shadowRoot?.querySelector('[data-action="stop"]')).toBeTruthy();
      expect(element.shadowRoot?.querySelector('.ds-url-text')).toBeTruthy();
    });

    it('updates UI from running to stopped', () => {
      actor.updateState({ running: true, url: 'http://localhost:3000' });
      actor.updateState({ running: false });

      expect(element.shadowRoot?.querySelector('[data-action="start"]')).toBeTruthy();
      expect(element.shadowRoot?.querySelector('[data-action="stop"]')).toBeNull();
    });

    it('clears starting state when state update arrives', () => {
      // Click start to enter starting state
      const startBtn = element.shadowRoot?.querySelector('[data-action="start"]') as HTMLElement;
      startBtn?.click();

      // Verify starting state
      const disabledBtn = element.shadowRoot?.querySelector('.ds-btn-start[disabled]');
      expect(disabledBtn).toBeTruthy();

      // State update clears starting state
      actor.updateState({ running: true, url: 'http://localhost:3000' });
      expect(element.shadowRoot?.querySelector('.ds-btn-start[disabled]')).toBeNull();
    });
  });

  describe('isServerRunning getter', () => {
    beforeEach(() => {
      actor = new DrawingServerShadowActor(manager, element, mockVSCode);
    });

    it('returns false when server is stopped', () => {
      expect(actor.isServerRunning).toBe(false);
    });

    it('returns true when server is running', () => {
      actor.updateState({ running: true });
      expect(actor.isServerRunning).toBe(true);
    });

    it('returns false after server stops', () => {
      actor.updateState({ running: true });
      actor.updateState({ running: false });
      expect(actor.isServerRunning).toBe(false);
    });
  });

  describe('Pub/sub integration', () => {
    beforeEach(() => {
      actor = new DrawingServerShadowActor(manager, element, mockVSCode);
    });

    it('responds to drawingServer.state subscription', async () => {
      await waitForRegistration();

      manager.publishDirect('drawingServer.state', {
        running: true,
        url: 'http://10.0.0.1:3000'
      } as DrawingServerState);

      expect(actor.isServerRunning).toBe(true);
      const urlText = element.shadowRoot?.querySelector('.ds-url-text');
      expect(urlText?.textContent).toContain('10.0.0.1:3000');
    });
  });

  describe('Popup visibility', () => {
    beforeEach(() => {
      actor = new DrawingServerShadowActor(manager, element, mockVSCode);
    });

    it('starts hidden', () => {
      expect(actor.isVisible()).toBe(false);
    });

    it('opens when toggle() is called', () => {
      actor.toggle();
      expect(actor.isVisible()).toBe(true);
    });

    it('closes on Escape key', () => {
      actor.toggle();
      const event = new KeyboardEvent('keydown', { key: 'Escape' });
      document.dispatchEvent(event);

      expect(actor.isVisible()).toBe(false);
    });

    it('opens via drawingServer.popup.open subscription', async () => {
      await waitForRegistration();
      manager.publishDirect('drawingServer.popup.open', true);
      expect(actor.isVisible()).toBe(true);
    });
  });

  describe('Lifecycle', () => {
    it('cleans up on destroy', () => {
      actor = new DrawingServerShadowActor(manager, element, mockVSCode);
      actor.toggle();

      actor.destroy();

      expect(() => actor.isVisible()).not.toThrow();
    });
  });
});
