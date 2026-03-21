/**
 * Tests for SettingsShadowActor
 *
 * Tests the Shadow DOM popup for settings including:
 * - Popup open/close behavior
 * - Settings sections (Logging, Reasoner, System Prompt, Web Search, History, Debug)
 * - Setting controls (selects, checkboxes, sliders, textareas)
 * - Settings sync via pub/sub
 * - VSCode message posting
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SettingsShadowActor, SettingsValues, DefaultPrompt } from '../../../media/actors/settings/SettingsShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';

// Mock VSCode API
const createMockVSCode = () => ({
  postMessage: vi.fn()
});

describe('SettingsShadowActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: SettingsShadowActor;
  let mockVSCode: ReturnType<typeof createMockVSCode>;

  beforeEach(() => {
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'settings-container';
    document.body.appendChild(element);
    mockVSCode = createMockVSCode();
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
  });

  describe('Shadow DOM creation', () => {
    it('creates shadow root on construction', () => {
      actor = new SettingsShadowActor(manager, element, mockVSCode);

      expect(element.shadowRoot).toBeTruthy();
    });

    it('adopts stylesheets into shadow root', () => {
      actor = new SettingsShadowActor(manager, element, mockVSCode);

      const sheets = element.shadowRoot?.adoptedStyleSheets;
      expect(sheets?.length).toBeGreaterThan(0);
    });

    it('renders popup structure with header', () => {
      actor = new SettingsShadowActor(manager, element, mockVSCode);

      const popup = element.shadowRoot?.querySelector('.popup-container');
      const header = element.shadowRoot?.querySelector('.popup-header');

      expect(popup).toBeTruthy();
      expect(header?.textContent).toContain('Settings');
    });
  });

  describe('Popup visibility', () => {
    beforeEach(() => {
      actor = new SettingsShadowActor(manager, element, mockVSCode);
    });

    it('starts hidden', () => {
      expect(actor.isVisible()).toBe(false);
    });

    it('opens when toggle() is called', () => {
      actor.toggle();

      expect(actor.isVisible()).toBe(true);
    });

    it('opens when settings.popup.open is published', () => {
      manager.publishDirect('settings.popup.open', true);

      expect(actor.isVisible()).toBe(true);
    });

    it('closes on Escape key', () => {
      actor.toggle();

      const event = new KeyboardEvent('keydown', { key: 'Escape' });
      document.dispatchEvent(event);

      expect(actor.isVisible()).toBe(false);
    });
  });

  describe('Settings sections', () => {
    beforeEach(() => {
      actor = new SettingsShadowActor(manager, element, mockVSCode);
      actor.toggle();
    });

    it('renders Debug section', () => {
      const sections = element.shadowRoot?.querySelectorAll('.settings-section-title');
      const titles = Array.from(sections || []).map(s => s.textContent);

      expect(titles).toContain('Debug');
    });
  });

  describe('Debug buttons', () => {
    beforeEach(() => {
      actor = new SettingsShadowActor(manager, element, mockVSCode);
      actor.toggle();
    });

    it('renders test status button', () => {
      const btn = element.shadowRoot?.querySelector('[data-action="testStatus"]');
      expect(btn).toBeTruthy();
    });

    it('renders test warning button', () => {
      const btn = element.shadowRoot?.querySelector('[data-action="testWarning"]');
      expect(btn).toBeTruthy();
    });

    it('renders test error button', () => {
      const btn = element.shadowRoot?.querySelector('[data-action="testError"]');
      expect(btn).toBeTruthy();
    });

    it('publishes status message on test click', () => {
      const publishSpy = vi.spyOn(manager, 'publishDirect');

      const btn = element.shadowRoot?.querySelector('[data-action="testStatus"]') as HTMLElement;
      btn?.click();

      expect(publishSpy).toHaveBeenCalledWith(
        'status.message',
        expect.objectContaining({ type: 'info' }),
        expect.any(String)
      );
    });
  });

  describe('Reset to Defaults', () => {
    beforeEach(() => {
      actor = new SettingsShadowActor(manager, element, mockVSCode);
      actor.toggle();
      mockVSCode.postMessage.mockClear();
    });

    it('renders reset defaults button', () => {
      const btn = element.shadowRoot?.querySelector('[data-action="resetDefaults"]');
      expect(btn).toBeTruthy();
    });

    it('confirms before resetting', () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

      const btn = element.shadowRoot?.querySelector('[data-action="resetDefaults"]') as HTMLElement;
      btn?.click();

      expect(confirmSpy).toHaveBeenCalled();
      expect(mockVSCode.postMessage).not.toHaveBeenCalledWith({ type: 'resetAllSettings' });
    });

    it('resets when confirmed', () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      const btn = element.shadowRoot?.querySelector('[data-action="resetDefaults"]') as HTMLElement;
      btn?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({ type: 'resetAllSettings' });
    });
  });

  describe('Settings sync via pub/sub', () => {
    beforeEach(() => {
      actor = new SettingsShadowActor(manager, element, mockVSCode);
    });

    it('updates settings when settings.values is published', () => {
      const values: SettingsValues = {
        logLevel: 'DEBUG',
        webviewLogLevel: 'INFO',
        tracingEnabled: true,
        logColors: false,
        allowAllCommands: true,
        systemPrompt: 'Custom',
        searchDepth: 'advanced',
        creditsPerPrompt: 4,
        maxResultsPerSearch: 10,
        cacheDuration: 30,
        autoSaveHistory: false
      };

      manager.publishDirect('settings.values', values);

      const settings = actor.getSettings();
      expect(settings.logLevel).toBe('DEBUG');
      expect(settings.allowAllCommands).toBe(true);
      expect(settings.creditsPerPrompt).toBe(4);
    });
  });

  describe('Public API', () => {
    beforeEach(() => {
      actor = new SettingsShadowActor(manager, element, mockVSCode);
    });

    it('getSettings() returns current settings', () => {
      const settings = actor.getSettings();

      expect(settings).toHaveProperty('logLevel');
      expect(settings).toHaveProperty('logColors');
      expect(settings).toHaveProperty('allowAllCommands');
      expect(settings).toHaveProperty('systemPrompt');
      expect(settings).toHaveProperty('searchDepth');
      expect(settings).toHaveProperty('creditsPerPrompt');
      expect(settings).toHaveProperty('maxResultsPerSearch');
      expect(settings).toHaveProperty('cacheDuration');
      expect(settings).toHaveProperty('autoSaveHistory');
    });
  });

  describe('Lifecycle', () => {
    it('cleans up on destroy', () => {
      actor = new SettingsShadowActor(manager, element, mockVSCode);
      actor.toggle();

      actor.destroy();

      expect(() => actor.isVisible()).not.toThrow();
    });
  });
});
