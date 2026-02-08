/**
 * Tests for ModelSelectorShadowActor
 *
 * Tests the Shadow DOM popup for model selection including:
 * - Popup open/close behavior
 * - Model option rendering and selection
 * - Parameter controls (temperature, tool limit, max tokens)
 * - Settings sync via pub/sub
 * - VSCode message posting
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ModelSelectorShadowActor, ModelOption, ModelSettings } from '../../../media/actors/model-selector/ModelSelectorShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';

// Mock VSCode API
const createMockVSCode = () => ({
  postMessage: vi.fn()
});

describe('ModelSelectorShadowActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: ModelSelectorShadowActor;
  let mockVSCode: ReturnType<typeof createMockVSCode>;

  beforeEach(() => {
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'model-selector-container';
    document.body.appendChild(element);
    mockVSCode = createMockVSCode();
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
  });

  describe('Shadow DOM creation', () => {
    it('creates shadow root on construction', () => {
      actor = new ModelSelectorShadowActor(manager, element, mockVSCode);

      expect(element.shadowRoot).toBeTruthy();
    });

    it('adopts stylesheets into shadow root', () => {
      actor = new ModelSelectorShadowActor(manager, element, mockVSCode);

      const sheets = element.shadowRoot?.adoptedStyleSheets;
      expect(sheets?.length).toBeGreaterThan(0);
    });

    it('renders popup structure', () => {
      actor = new ModelSelectorShadowActor(manager, element, mockVSCode);

      const popup = element.shadowRoot?.querySelector('.popup-container');
      const body = element.shadowRoot?.querySelector('.popup-body');

      expect(popup).toBeTruthy();
      expect(body).toBeTruthy();
    });
  });

  describe('Popup visibility', () => {
    beforeEach(() => {
      actor = new ModelSelectorShadowActor(manager, element, mockVSCode);
    });

    it('starts hidden', () => {
      expect(actor.isVisible()).toBe(false);
    });

    it('opens when toggle() is called', () => {
      actor.toggle();

      expect(actor.isVisible()).toBe(true);
    });

    it('closes when toggle() is called while open', () => {
      actor.toggle();
      actor.toggle();

      expect(actor.isVisible()).toBe(false);
    });

    it('opens when model.popup.open is published', () => {
      manager.publishDirect('model.popup.open', true);

      expect(actor.isVisible()).toBe(true);
    });

    it('closes on Escape key', () => {
      actor.toggle();

      const event = new KeyboardEvent('keydown', { key: 'Escape' });
      document.dispatchEvent(event);

      expect(actor.isVisible()).toBe(false);
    });
  });

  describe('Model rendering', () => {
    beforeEach(() => {
      actor = new ModelSelectorShadowActor(manager, element, mockVSCode);
      actor.toggle();
    });

    it('renders default model options', () => {
      const modelOptions = element.shadowRoot?.querySelectorAll('.model-option');
      expect(modelOptions?.length).toBe(2); // Chat and Reasoner
    });

    it('shows model name and description', () => {
      const option = element.shadowRoot?.querySelector('.model-option');
      const name = option?.querySelector('.model-option-name');
      const desc = option?.querySelector('.model-option-desc');

      expect(name).toBeTruthy();
      expect(desc).toBeTruthy();
    });

    it('highlights selected model', () => {
      const selectedOption = element.shadowRoot?.querySelector('.model-option.selected');
      expect(selectedOption).toBeTruthy();
      expect(selectedOption?.getAttribute('data-model')).toBe('deepseek-chat');
    });
  });

  describe('Model selection', () => {
    beforeEach(() => {
      actor = new ModelSelectorShadowActor(manager, element, mockVSCode);
      actor.toggle();
      mockVSCode.postMessage.mockClear();
    });

    it('selects model when clicked', () => {
      const reasonerOption = element.shadowRoot?.querySelector('.model-option[data-model="deepseek-reasoner"]') as HTMLElement;
      reasonerOption?.click();

      expect(actor.getSelectedModel()).toBe('deepseek-reasoner');
    });

    it('posts selectModel message to extension', () => {
      const reasonerOption = element.shadowRoot?.querySelector('.model-option[data-model="deepseek-reasoner"]') as HTMLElement;
      reasonerOption?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'selectModel',
        model: 'deepseek-reasoner'
      });
    });

    it('updates selected visual on model change', () => {
      const reasonerOption = element.shadowRoot?.querySelector('.model-option[data-model="deepseek-reasoner"]') as HTMLElement;
      reasonerOption?.click();

      // Re-query after click because selectModel() re-renders the popup content
      const updatedReasonerOption = element.shadowRoot?.querySelector('.model-option[data-model="deepseek-reasoner"]');
      expect(updatedReasonerOption?.classList.contains('selected')).toBe(true);

      const chatOption = element.shadowRoot?.querySelector('.model-option[data-model="deepseek-chat"]');
      expect(chatOption?.classList.contains('selected')).toBe(false);
    });

    it('publishes model.selected on change', () => {
      // The actor uses this.publish() which calls manager.handleStateChange()
      const handleStateSpy = vi.spyOn(manager, 'handleStateChange');

      const reasonerOption = element.shadowRoot?.querySelector('.model-option[data-model="deepseek-reasoner"]') as HTMLElement;
      reasonerOption?.click();

      expect(handleStateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({ 'model.selected': 'deepseek-reasoner' })
        })
      );
    });
  });

  describe('Parameter controls', () => {
    beforeEach(() => {
      actor = new ModelSelectorShadowActor(manager, element, mockVSCode);
      actor.toggle();
      mockVSCode.postMessage.mockClear();
    });

    it('renders temperature slider', () => {
      const tempSlider = element.shadowRoot?.querySelector('[data-param="temperature"]');
      expect(tempSlider).toBeTruthy();
    });

    it('renders tool limit slider', () => {
      const toolSlider = element.shadowRoot?.querySelector('[data-param="toolLimit"]');
      expect(toolSlider).toBeTruthy();
    });

    it('renders max tokens slider', () => {
      const tokenSlider = element.shadowRoot?.querySelector('[data-param="maxTokens"]');
      expect(tokenSlider).toBeTruthy();
    });

    it('updates temperature on slider input', () => {
      const slider = element.shadowRoot?.querySelector('[data-param="temperature"]') as HTMLInputElement;
      slider.value = '1.5';
      slider.dispatchEvent(new Event('input', { bubbles: true }));

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'setTemperature',
        temperature: 1.5
      });
    });

    it('updates tool limit on slider input', () => {
      const slider = element.shadowRoot?.querySelector('[data-param="toolLimit"]') as HTMLInputElement;
      slider.value = '50';
      slider.dispatchEvent(new Event('input', { bubbles: true }));

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'setToolLimit',
        toolLimit: 50
      });
    });

    it('updates max tokens on slider input', () => {
      const slider = element.shadowRoot?.querySelector('[data-param="maxTokens"]') as HTMLInputElement;
      slider.value = '4096';
      slider.dispatchEvent(new Event('input', { bubbles: true }));

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'setMaxTokens',
        maxTokens: 4096
      });
    });

    it('displays value next to slider', () => {
      const tempValue = element.shadowRoot?.querySelector('[data-value="temperature"]');
      expect(tempValue?.textContent).toBeTruthy();
    });
  });

  describe('Settings sync via pub/sub', () => {
    beforeEach(() => {
      actor = new ModelSelectorShadowActor(manager, element, mockVSCode);
    });

    it('updates model when model.current is published', () => {
      manager.publishDirect('model.current', 'deepseek-reasoner');

      expect(actor.getSelectedModel()).toBe('deepseek-reasoner');
    });

    it('updates settings when model.settings is published', () => {
      const settings: ModelSettings = {
        model: 'deepseek-reasoner',
        temperature: 1.2,
        toolLimit: 50,
        maxTokens: 16384
      };

      manager.publishDirect('model.settings', settings);

      const result = actor.getSettings();
      expect(result.model).toBe('deepseek-reasoner');
      expect(result.temperature).toBe(1.2);
      expect(result.toolLimit).toBe(50);
      expect(result.maxTokens).toBe(16384);
    });
  });

  describe('Public API', () => {
    beforeEach(() => {
      actor = new ModelSelectorShadowActor(manager, element, mockVSCode);
    });

    it('getSelectedModel() returns current model', () => {
      expect(actor.getSelectedModel()).toBe('deepseek-chat');
    });

    it('getSettings() returns all settings', () => {
      const settings = actor.getSettings();

      expect(settings).toHaveProperty('model');
      expect(settings).toHaveProperty('temperature');
      expect(settings).toHaveProperty('toolLimit');
      expect(settings).toHaveProperty('maxTokens');
    });

    it('onModelChange() handler is called on selection', () => {
      const handler = vi.fn();
      actor.onModelChange(handler);

      actor.toggle();
      const option = element.shadowRoot?.querySelector('.model-option[data-model="deepseek-reasoner"]') as HTMLElement;
      option?.click();

      expect(handler).toHaveBeenCalledWith('deepseek-reasoner');
    });

    it('onSettingsChange() handler is called on parameter change', () => {
      const handler = vi.fn();
      actor.onSettingsChange(handler);

      actor.toggle();
      const slider = element.shadowRoot?.querySelector('[data-param="temperature"]') as HTMLInputElement;
      slider.value = '1.0';
      slider.dispatchEvent(new Event('input', { bubbles: true }));

      expect(handler).toHaveBeenCalledWith({ temperature: 1.0 });
    });

    it('setModels() updates available models', () => {
      const customModels: ModelOption[] = [
        { id: 'custom-model', name: 'Custom', description: 'Test', maxTokens: 4096 }
      ];

      actor.setModels(customModels);
      actor.toggle();

      const options = element.shadowRoot?.querySelectorAll('.model-option');
      expect(options?.length).toBe(1);
    });
  });

  describe('Lifecycle', () => {
    it('cleans up on destroy', () => {
      actor = new ModelSelectorShadowActor(manager, element, mockVSCode);
      actor.toggle();

      actor.destroy();

      expect(() => actor.isVisible()).not.toThrow();
    });
  });
});
