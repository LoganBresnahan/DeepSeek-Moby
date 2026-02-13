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

    it('renders Logging section', () => {
      const sections = element.shadowRoot?.querySelectorAll('.settings-section-title');
      const titles = Array.from(sections || []).map(s => s.textContent);

      expect(titles).toContain('Logging');
    });

    it('renders Reasoner section', () => {
      const sections = element.shadowRoot?.querySelectorAll('.settings-section-title');
      const titles = Array.from(sections || []).map(s => s.textContent);

      expect(titles).toContain('Reasoner (R1)');
    });

    it('renders System Prompt section', () => {
      const sections = element.shadowRoot?.querySelectorAll('.settings-section-title');
      const titles = Array.from(sections || []).map(s => s.textContent);

      expect(titles).toContain('System Prompt');
    });

    it('renders Web Search section', () => {
      const sections = element.shadowRoot?.querySelectorAll('.settings-section-title');
      const titles = Array.from(sections || []).map(s => s.textContent);

      expect(titles).toContain('Web Search');
    });

    it('renders History section', () => {
      const sections = element.shadowRoot?.querySelectorAll('.settings-section-title');
      const titles = Array.from(sections || []).map(s => s.textContent);

      expect(titles).toContain('History');
    });

    it('renders Debug section', () => {
      const sections = element.shadowRoot?.querySelectorAll('.settings-section-title');
      const titles = Array.from(sections || []).map(s => s.textContent);

      expect(titles).toContain('Debug');
    });
  });

  describe('Logging settings', () => {
    beforeEach(() => {
      actor = new SettingsShadowActor(manager, element, mockVSCode);
      actor.toggle();
      mockVSCode.postMessage.mockClear();
    });

    it('renders log level select', () => {
      const select = element.shadowRoot?.querySelector('[data-setting="logLevel"]');
      expect(select).toBeTruthy();
      expect(select?.tagName).toBe('SELECT');
    });

    it('posts setLogLevel on change', () => {
      const select = element.shadowRoot?.querySelector('[data-setting="logLevel"]') as HTMLSelectElement;
      select.value = 'DEBUG';
      select.dispatchEvent(new Event('change', { bubbles: true }));

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'setLogLevel',
        logLevel: 'DEBUG'
      });
    });

    it('renders log colors checkbox', () => {
      const checkbox = element.shadowRoot?.querySelector('[data-setting="logColors"]');
      expect(checkbox).toBeTruthy();
      expect(checkbox?.getAttribute('type')).toBe('checkbox');
    });

    it('posts setLogColors on change', () => {
      const checkbox = element.shadowRoot?.querySelector('[data-setting="logColors"]') as HTMLInputElement;
      checkbox.checked = false;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'setLogColors',
        enabled: false
      });
    });

    it('renders Open Logs button', () => {
      const btn = element.shadowRoot?.querySelector('[data-action="openLogs"]');
      expect(btn).toBeTruthy();
    });

    it('posts openLogs on button click', () => {
      const btn = element.shadowRoot?.querySelector('[data-action="openLogs"]') as HTMLElement;
      btn?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({ type: 'openLogs' });
    });
  });

  describe('Reasoner settings', () => {
    beforeEach(() => {
      actor = new SettingsShadowActor(manager, element, mockVSCode);
      actor.toggle();
      mockVSCode.postMessage.mockClear();
    });

    it('renders allow all commands checkbox', () => {
      const checkbox = element.shadowRoot?.querySelector('[data-setting="allowAllCommands"]');
      expect(checkbox).toBeTruthy();
    });

    it('posts setAllowAllCommands on change', () => {
      const checkbox = element.shadowRoot?.querySelector('[data-setting="allowAllCommands"]') as HTMLInputElement;
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'setAllowAllCommands',
        enabled: true
      });
    });
  });

  describe('System Prompt settings', () => {
    beforeEach(() => {
      actor = new SettingsShadowActor(manager, element, mockVSCode);
      actor.toggle();
      mockVSCode.postMessage.mockClear();
    });

    it('renders system prompt textarea', () => {
      const textarea = element.shadowRoot?.querySelector('[data-setting="systemPrompt"]');
      expect(textarea).toBeTruthy();
      expect(textarea?.tagName).toBe('TEXTAREA');
    });

    it('renders Save button', () => {
      const btn = element.shadowRoot?.querySelector('[data-action="savePrompt"]');
      expect(btn).toBeTruthy();
    });

    it('posts setSystemPrompt on Save click', () => {
      const textarea = element.shadowRoot?.querySelector('[data-setting="systemPrompt"]') as HTMLTextAreaElement;
      textarea.value = 'Custom prompt';

      const btn = element.shadowRoot?.querySelector('[data-action="savePrompt"]') as HTMLElement;
      btn?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'setSystemPrompt',
        systemPrompt: 'Custom prompt'
      });
    });

    it('renders Reset button', () => {
      const btn = element.shadowRoot?.querySelector('[data-action="resetPrompt"]');
      expect(btn).toBeTruthy();
    });

    it('clears prompt and posts on Reset click', () => {
      const textarea = element.shadowRoot?.querySelector('[data-setting="systemPrompt"]') as HTMLTextAreaElement;
      textarea.value = 'Some text';

      const btn = element.shadowRoot?.querySelector('[data-action="resetPrompt"]') as HTMLElement;
      btn?.click();

      expect(textarea.value).toBe('');
      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'setSystemPrompt',
        systemPrompt: ''
      });
    });

    it('renders Show Default button', () => {
      const btn = element.shadowRoot?.querySelector('[data-action="showDefault"]');
      expect(btn).toBeTruthy();
    });

    it('requests default prompt on Show Default click', () => {
      const btn = element.shadowRoot?.querySelector('[data-action="showDefault"]') as HTMLElement;
      btn?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({ type: 'getDefaultSystemPrompt' });
    });
  });

  describe('Default prompt preview', () => {
    beforeEach(() => {
      actor = new SettingsShadowActor(manager, element, mockVSCode);
      actor.toggle();
    });

    it('shows preview when defaultPrompt is published', () => {
      const data: DefaultPrompt = {
        model: 'deepseek-chat',
        prompt: 'You are a helpful assistant.'
      };

      manager.publishDirect('settings.defaultPrompt', data);

      const preview = element.shadowRoot?.querySelector('.settings-preview');
      expect(preview).toBeTruthy();
    });

    it('displays model name in preview', () => {
      manager.publishDirect('settings.defaultPrompt', {
        model: 'deepseek-reasoner',
        prompt: 'Test prompt'
      });

      const previewHeader = element.shadowRoot?.querySelector('.settings-preview-header');
      expect(previewHeader?.textContent).toContain('deepseek-reasoner');
    });

    it('displays prompt content in preview', () => {
      manager.publishDirect('settings.defaultPrompt', {
        model: 'test',
        prompt: 'The actual prompt content'
      });

      const previewContent = element.shadowRoot?.querySelector('.settings-preview-content');
      expect(previewContent?.textContent).toContain('The actual prompt content');
    });

    it('closes preview when close button clicked', () => {
      manager.publishDirect('settings.defaultPrompt', { model: 'test', prompt: 'test' });

      const closeBtn = element.shadowRoot?.querySelector('[data-action="closePreview"]') as HTMLElement;
      closeBtn?.click();

      const preview = element.shadowRoot?.querySelector('.settings-preview');
      expect(preview).toBeFalsy();
    });
  });

  describe('Web Search settings', () => {
    beforeEach(() => {
      actor = new SettingsShadowActor(manager, element, mockVSCode);
      actor.toggle();
      mockVSCode.postMessage.mockClear();
    });

    it('renders search depth select', () => {
      const select = element.shadowRoot?.querySelector('[data-setting="searchDepth"]');
      expect(select).toBeTruthy();
    });

    it('posts setSearchDepth on change', () => {
      const select = element.shadowRoot?.querySelector('[data-setting="searchDepth"]') as HTMLSelectElement;
      select.value = 'advanced';
      select.dispatchEvent(new Event('change', { bubbles: true }));

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'setSearchDepth',
        searchDepth: 'advanced'
      });
    });

    it('renders credits per prompt slider', () => {
      const slider = element.shadowRoot?.querySelector('[data-setting="creditsPerPrompt"]');
      expect(slider).toBeTruthy();
    });

    it('renders results per search slider', () => {
      const slider = element.shadowRoot?.querySelector('[data-setting="maxResultsPerSearch"]');
      expect(slider).toBeTruthy();
    });

    it('renders cache duration slider', () => {
      const slider = element.shadowRoot?.querySelector('[data-setting="cacheDuration"]');
      expect(slider).toBeTruthy();
    });

    it('renders Clear Search Cache button', () => {
      const btn = element.shadowRoot?.querySelector('[data-action="clearSearchCache"]');
      expect(btn).toBeTruthy();
    });

    it('posts clearSearchCache on click', () => {
      const btn = element.shadowRoot?.querySelector('[data-action="clearSearchCache"]') as HTMLElement;
      btn?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({ type: 'clearSearchCache' });
    });
  });

  describe('History settings', () => {
    beforeEach(() => {
      actor = new SettingsShadowActor(manager, element, mockVSCode);
      actor.toggle();
      mockVSCode.postMessage.mockClear();
    });

    it('renders auto-save checkbox', () => {
      const checkbox = element.shadowRoot?.querySelector('[data-setting="autoSaveHistory"]');
      expect(checkbox).toBeTruthy();
    });

    it('renders max sessions slider', () => {
      const slider = element.shadowRoot?.querySelector('[data-setting="maxSessions"]');
      expect(slider).toBeTruthy();
    });

    it('renders Clear All History button', () => {
      const btn = element.shadowRoot?.querySelector('[data-action="clearHistory"]');
      expect(btn).toBeTruthy();
    });

    it('confirms before clearing history', () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

      const btn = element.shadowRoot?.querySelector('[data-action="clearHistory"]') as HTMLElement;
      btn?.click();

      expect(confirmSpy).toHaveBeenCalled();
      expect(mockVSCode.postMessage).not.toHaveBeenCalledWith({ type: 'clearAllHistory' });
    });

    it('clears history when confirmed', () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      const btn = element.shadowRoot?.querySelector('[data-action="clearHistory"]') as HTMLElement;
      btn?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({ type: 'clearAllHistory' });
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
        autoSaveHistory: false,
        maxSessions: 200
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
      expect(settings).toHaveProperty('maxSessions');
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
