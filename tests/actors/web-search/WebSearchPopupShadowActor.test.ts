/**
 * Tests for WebSearchPopupShadowActor
 *
 * Tests the Shadow DOM popup for web search settings including:
 * - Shadow root creation and structure
 * - Mode buttons (Off, Forced, Auto)
 * - Mode button click sends setWebSearchMode message
 * - Credits slider renders with value
 * - Results slider renders with value
 * - Depth buttons (Basic/Advanced)
 * - Controls disabled when mode is Off
 * - Clear cache button sends clearSearchCache
 * - Credits auto-clamp when switching depth
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  WebSearchPopupShadowActor,
  WebSearchMode,
  WebSearchSettings
} from '../../../media/actors/web-search/WebSearchPopupShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { ShadowActor } from '../../../media/state/ShadowActor';

// Mock VSCode API
const createMockVSCode = () => ({
  postMessage: vi.fn()
});

// Helper to wait for actor registration (deferred via queueMicrotask)
const waitForRegistration = () => new Promise(resolve => queueMicrotask(resolve));

describe('WebSearchPopupShadowActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: WebSearchPopupShadowActor;
  let mockVSCode: ReturnType<typeof createMockVSCode>;

  beforeEach(() => {
    manager = new EventStateManager({ batchBroadcasts: false });
    element = document.createElement('div');
    element.id = 'web-search-container';
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
      actor = new WebSearchPopupShadowActor(manager, element, mockVSCode);

      expect(element.shadowRoot).toBeTruthy();
    });

    it('adopts stylesheets into shadow root', () => {
      actor = new WebSearchPopupShadowActor(manager, element, mockVSCode);

      const sheets = element.shadowRoot?.adoptedStyleSheets;
      expect(sheets?.length).toBeGreaterThan(0);
    });

    it('renders popup structure with header', () => {
      actor = new WebSearchPopupShadowActor(manager, element, mockVSCode);

      const popup = element.shadowRoot?.querySelector('.popup-container');
      const header = element.shadowRoot?.querySelector('.popup-header');
      const body = element.shadowRoot?.querySelector('.popup-body');

      expect(popup).toBeTruthy();
      expect(header?.textContent).toContain('Web Search');
      expect(body).toBeTruthy();
    });
  });

  describe('Mode buttons', () => {
    beforeEach(() => {
      actor = new WebSearchPopupShadowActor(manager, element, mockVSCode);
    });

    it('renders Off, Forced, and Auto mode buttons', () => {
      const modeBtns = element.shadowRoot?.querySelectorAll('.ws-mode-btn');
      expect(modeBtns?.length).toBe(3);

      const labels = Array.from(modeBtns || []).map(b => b.textContent?.trim());
      expect(labels).toContain('Off');
      expect(labels).toContain('Forced');
      expect(labels).toContain('Auto');
    });

    it('Auto mode button is active by default', () => {
      const autoBtn = element.shadowRoot?.querySelector('[data-mode="auto"]');
      expect(autoBtn?.classList.contains('active')).toBe(true);
    });

    it('Off and Forced buttons are not active by default', () => {
      const offBtn = element.shadowRoot?.querySelector('[data-mode="off"]');
      const manualBtn = element.shadowRoot?.querySelector('[data-mode="manual"]');
      expect(offBtn?.classList.contains('active')).toBe(false);
      expect(manualBtn?.classList.contains('active')).toBe(false);
    });
  });

  describe('Mode button clicks', () => {
    beforeEach(() => {
      actor = new WebSearchPopupShadowActor(manager, element, mockVSCode);
    });

    it('sends setWebSearchMode message when Off is clicked', () => {
      const offBtn = element.shadowRoot?.querySelector('[data-mode="off"]') as HTMLElement;
      offBtn?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'setWebSearchMode',
        mode: 'off'
      });
    });

    it('sends setWebSearchMode message when Forced is clicked', () => {
      const manualBtn = element.shadowRoot?.querySelector('[data-mode="manual"]') as HTMLElement;
      manualBtn?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'setWebSearchMode',
        mode: 'manual'
      });
    });

    it('sends setWebSearchMode message when Auto is clicked', () => {
      // First switch to off
      const offBtn = element.shadowRoot?.querySelector('[data-mode="off"]') as HTMLElement;
      offBtn?.click();
      mockVSCode.postMessage.mockClear();

      // Then switch to auto
      const autoBtn = element.shadowRoot?.querySelector('[data-mode="auto"]') as HTMLElement;
      autoBtn?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'setWebSearchMode',
        mode: 'auto'
      });
    });

    it('auto-enables web search when switching to Forced mode', () => {
      const manualBtn = element.shadowRoot?.querySelector('[data-mode="manual"]') as HTMLElement;
      manualBtn?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'toggleWebSearch',
        enabled: true
      });
    });

    it('auto-disables web search when switching to Off mode', () => {
      // First enable via Forced mode
      const manualBtn = element.shadowRoot?.querySelector('[data-mode="manual"]') as HTMLElement;
      manualBtn?.click();
      mockVSCode.postMessage.mockClear();

      // Then switch to Off
      const offBtn = element.shadowRoot?.querySelector('[data-mode="off"]') as HTMLElement;
      offBtn?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'toggleWebSearch',
        enabled: false
      });
    });

    it('updates active button styling when mode changes', () => {
      const offBtn = element.shadowRoot?.querySelector('[data-mode="off"]') as HTMLElement;
      offBtn?.click();

      // After re-render, off should be active
      const offBtnUpdated = element.shadowRoot?.querySelector('[data-mode="off"]');
      const autoBtnUpdated = element.shadowRoot?.querySelector('[data-mode="auto"]');
      expect(offBtnUpdated?.classList.contains('active')).toBe(true);
      expect(autoBtnUpdated?.classList.contains('active')).toBe(false);
    });
  });

  describe('Credits slider', () => {
    beforeEach(() => {
      actor = new WebSearchPopupShadowActor(manager, element, mockVSCode);
    });

    it('renders credits slider', () => {
      const slider = element.shadowRoot?.querySelector('[data-id="creditsSlider"]') as HTMLInputElement;
      expect(slider).toBeTruthy();
      expect(slider?.type).toBe('range');
    });

    it('renders default credits value display', () => {
      const value = element.shadowRoot?.querySelector('[data-id="creditsValue"]');
      expect(value).toBeTruthy();
      expect(value?.textContent).toBe('1');
    });

    it('renders request count info', () => {
      const info = element.shadowRoot?.querySelector('[data-id="creditsInfo"]');
      expect(info).toBeTruthy();
      expect(info?.textContent).toContain('request');
    });

    it('shows correct slider range for basic depth', () => {
      const slider = element.shadowRoot?.querySelector('[data-id="creditsSlider"]') as HTMLInputElement;
      expect(slider?.min).toBe('1');
      expect(slider?.max).toBe('5');
      expect(slider?.step).toBe('1');
    });
  });

  describe('Results slider', () => {
    beforeEach(() => {
      actor = new WebSearchPopupShadowActor(manager, element, mockVSCode);
    });

    it('renders results slider', () => {
      const slider = element.shadowRoot?.querySelector('[data-id="maxResultsSlider"]') as HTMLInputElement;
      expect(slider).toBeTruthy();
      expect(slider?.type).toBe('range');
    });

    it('renders default results value display', () => {
      const value = element.shadowRoot?.querySelector('[data-id="maxResultsValue"]');
      expect(value).toBeTruthy();
      expect(value?.textContent).toBe('5');
    });

    it('shows correct slider range for results', () => {
      const slider = element.shadowRoot?.querySelector('[data-id="maxResultsSlider"]') as HTMLInputElement;
      expect(slider?.min).toBe('1');
      expect(slider?.max).toBe('20');
      expect(slider?.step).toBe('1');
    });
  });

  describe('Depth buttons', () => {
    beforeEach(() => {
      actor = new WebSearchPopupShadowActor(manager, element, mockVSCode);
    });

    it('renders Basic and Advanced depth buttons', () => {
      const depthBtns = element.shadowRoot?.querySelectorAll('.ws-depth-btn');
      expect(depthBtns?.length).toBe(2);

      const basicBtn = element.shadowRoot?.querySelector('[data-depth="basic"]');
      const advancedBtn = element.shadowRoot?.querySelector('[data-depth="advanced"]');
      expect(basicBtn).toBeTruthy();
      expect(advancedBtn).toBeTruthy();
    });

    it('Basic depth is active by default', () => {
      const basicBtn = element.shadowRoot?.querySelector('[data-depth="basic"]');
      expect(basicBtn?.classList.contains('active')).toBe(true);
    });

    it('sends setSearchDepth message when depth button is clicked', () => {
      const advancedBtn = element.shadowRoot?.querySelector('[data-depth="advanced"]') as HTMLElement;
      advancedBtn?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'setSearchDepth',
        searchDepth: 'advanced'
      });
    });

    it('updates active depth button styling', () => {
      const advancedBtn = element.shadowRoot?.querySelector('[data-depth="advanced"]') as HTMLElement;
      advancedBtn?.click();

      // After re-render
      const basicBtnUpdated = element.shadowRoot?.querySelector('[data-depth="basic"]');
      const advancedBtnUpdated = element.shadowRoot?.querySelector('[data-depth="advanced"]');
      expect(advancedBtnUpdated?.classList.contains('active')).toBe(true);
      expect(basicBtnUpdated?.classList.contains('active')).toBe(false);
    });

    it('shows credit cost in depth buttons', () => {
      const basicBtn = element.shadowRoot?.querySelector('[data-depth="basic"]');
      const advancedBtn = element.shadowRoot?.querySelector('[data-depth="advanced"]');

      expect(basicBtn?.textContent).toContain('1 credit');
      expect(advancedBtn?.textContent).toContain('2 credits');
    });
  });

  describe('Controls disabled when Off', () => {
    beforeEach(() => {
      actor = new WebSearchPopupShadowActor(manager, element, mockVSCode);
    });

    it('disables sliders when mode is Off', () => {
      const offBtn = element.shadowRoot?.querySelector('[data-mode="off"]') as HTMLElement;
      offBtn?.click();

      const creditsSlider = element.shadowRoot?.querySelector('[data-id="creditsSlider"]') as HTMLInputElement;
      const resultsSlider = element.shadowRoot?.querySelector('[data-id="maxResultsSlider"]') as HTMLInputElement;
      expect(creditsSlider?.disabled).toBe(true);
      expect(resultsSlider?.disabled).toBe(true);
    });

    it('disables depth buttons when mode is Off', () => {
      const offBtn = element.shadowRoot?.querySelector('[data-mode="off"]') as HTMLElement;
      offBtn?.click();

      const basicBtn = element.shadowRoot?.querySelector('[data-depth="basic"]') as HTMLButtonElement;
      const advancedBtn = element.shadowRoot?.querySelector('[data-depth="advanced"]') as HTMLButtonElement;
      expect(basicBtn?.disabled).toBe(true);
      expect(advancedBtn?.disabled).toBe(true);
    });

    it('disables clear cache button when mode is Off', () => {
      const offBtn = element.shadowRoot?.querySelector('[data-mode="off"]') as HTMLElement;
      offBtn?.click();

      const clearBtn = element.shadowRoot?.querySelector('.ws-clear-cache-btn') as HTMLButtonElement;
      expect(clearBtn?.disabled).toBe(true);
    });

    it('adds disabled-section class to settings when Off', () => {
      const offBtn = element.shadowRoot?.querySelector('[data-mode="off"]') as HTMLElement;
      offBtn?.click();

      const settings = element.shadowRoot?.querySelector('.ws-settings');
      expect(settings?.classList.contains('disabled-section')).toBe(true);
    });

    it('enables controls when switching from Off to Auto', () => {
      // First set to Off
      const offBtn = element.shadowRoot?.querySelector('[data-mode="off"]') as HTMLElement;
      offBtn?.click();

      // Then set to Auto
      const autoBtn = element.shadowRoot?.querySelector('[data-mode="auto"]') as HTMLElement;
      autoBtn?.click();

      const creditsSlider = element.shadowRoot?.querySelector('[data-id="creditsSlider"]') as HTMLInputElement;
      expect(creditsSlider?.disabled).toBe(false);

      const settings = element.shadowRoot?.querySelector('.ws-settings');
      expect(settings?.classList.contains('disabled-section')).toBe(false);
    });
  });

  describe('Clear cache button', () => {
    beforeEach(() => {
      actor = new WebSearchPopupShadowActor(manager, element, mockVSCode);
    });

    it('renders clear cache button', () => {
      const clearBtn = element.shadowRoot?.querySelector('.ws-clear-cache-btn');
      expect(clearBtn).toBeTruthy();
      expect(clearBtn?.textContent).toContain('Clear Cache');
    });

    it('sends clearSearchCache message on click', () => {
      const clearBtn = element.shadowRoot?.querySelector('.ws-clear-cache-btn') as HTMLElement;
      clearBtn?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'clearSearchCache'
      });
    });

    it('closes popup after clearing cache', () => {
      actor.open();

      const clearBtn = element.shadowRoot?.querySelector('.ws-clear-cache-btn') as HTMLElement;
      clearBtn?.click();

      expect(actor.isVisible()).toBe(false);
    });
  });

  describe('Credits auto-clamp when switching depth', () => {
    beforeEach(() => {
      actor = new WebSearchPopupShadowActor(manager, element, mockVSCode);
    });

    it('clamps credits to min 2 when switching to Advanced', () => {
      // Default: credits=1, depth=basic
      const advancedBtn = element.shadowRoot?.querySelector('[data-depth="advanced"]') as HTMLElement;
      advancedBtn?.click();

      // Credits should be clamped to 2 (min for advanced)
      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'setCreditsPerPrompt',
        value: 2
      });
    });

    it('updates slider range when depth changes to Advanced', () => {
      // Switch to advanced
      const advancedBtn = element.shadowRoot?.querySelector('[data-depth="advanced"]') as HTMLElement;
      advancedBtn?.click();

      const slider = element.shadowRoot?.querySelector('[data-id="creditsSlider"]') as HTMLInputElement;
      expect(slider?.min).toBe('2');
      expect(slider?.max).toBe('10');
      expect(slider?.step).toBe('2');
    });

    it('updates slider range back when depth changes to Basic', () => {
      // Switch to advanced first
      const advancedBtn = element.shadowRoot?.querySelector('[data-depth="advanced"]') as HTMLElement;
      advancedBtn?.click();

      // Switch back to basic
      const basicBtn = element.shadowRoot?.querySelector('[data-depth="basic"]') as HTMLElement;
      basicBtn?.click();

      const slider = element.shadowRoot?.querySelector('[data-id="creditsSlider"]') as HTMLInputElement;
      expect(slider?.min).toBe('1');
      expect(slider?.max).toBe('5');
      expect(slider?.step).toBe('1');
    });

    it('updates credits display value when depth changes', () => {
      // Switch to advanced -- credits should clamp from 1 to 2
      const advancedBtn = element.shadowRoot?.querySelector('[data-depth="advanced"]') as HTMLElement;
      advancedBtn?.click();

      const value = element.shadowRoot?.querySelector('[data-id="creditsValue"]');
      expect(value?.textContent).toBe('2');
    });
  });

  describe('Pub/sub integration', () => {
    beforeEach(() => {
      actor = new WebSearchPopupShadowActor(manager, element, mockVSCode);
    });

    it('updates settings when webSearch.settings is published', async () => {
      actor.open();
      await waitForRegistration();

      manager.publishDirect('webSearch.settings', {
        creditsPerPrompt: 3,
        maxResultsPerSearch: 10,
        searchDepth: 'basic'
      } as WebSearchSettings);

      const creditsValue = element.shadowRoot?.querySelector('[data-id="creditsValue"]');
      expect(creditsValue?.textContent).toBe('3');

      const resultsValue = element.shadowRoot?.querySelector('[data-id="maxResultsValue"]');
      expect(resultsValue?.textContent).toBe('10');
    });

    it('updates mode when webSearch.mode is published', async () => {
      actor.open();
      await waitForRegistration();

      manager.publishDirect('webSearch.mode', 'off' as WebSearchMode);

      const offBtn = element.shadowRoot?.querySelector('[data-mode="off"]');
      expect(offBtn?.classList.contains('active')).toBe(true);
    });

    it('opens via webSearch.popup.open subscription', async () => {
      await waitForRegistration();
      manager.publishDirect('webSearch.popup.open', true);
      expect(actor.isVisible()).toBe(true);
    });

    it('requests settings refresh when opened', () => {
      actor.open();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'getWebSearchSettings'
      });
    });
  });

  describe('Popup visibility', () => {
    beforeEach(() => {
      actor = new WebSearchPopupShadowActor(manager, element, mockVSCode);
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
  });

  describe('Lifecycle', () => {
    it('cleans up on destroy', () => {
      actor = new WebSearchPopupShadowActor(manager, element, mockVSCode);
      actor.toggle();

      actor.destroy();

      expect(() => actor.isVisible()).not.toThrow();
    });
  });
});
