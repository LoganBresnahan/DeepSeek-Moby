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
    manager = new EventStateManager({ batchBroadcasts: false });
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

    it('updates shell iterations on slider input when R1 is selected', () => {
      // Switch to R1 model so shell iterations slider appears
      actor.toggle();
      const r1Option = element.shadowRoot?.querySelector('.model-option[data-model="deepseek-reasoner"]') as HTMLElement;
      r1Option?.click();

      const slider = element.shadowRoot?.querySelector('[data-param="shellIterations"]') as HTMLInputElement;
      expect(slider).toBeTruthy();
      slider.value = '10';
      slider.dispatchEvent(new Event('input', { bubbles: true }));

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'setShellIterations',
        shellIterations: 10
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
        shellIterations: 10,
        maxTokens: 16384
      };

      manager.publishDirect('model.settings', settings);

      const result = actor.getSettings();
      expect(result.model).toBe('deepseek-reasoner');
      expect(result.temperature).toBe(1.2);
      expect(result.toolLimit).toBe(50);
      expect(result.shellIterations).toBe(10);
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
      expect(settings).toHaveProperty('shellIterations');
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

  // Phase 4 regression locks: reasoning-effort pills appear only on
  // the active row, only when the model is thinking-capable, and
  // clicking a pill posts setReasoningEffort + optimistically flips
  // the active state without waiting for the round-trip.
  describe('Reasoning-effort pills (Phase 4)', () => {
    function publishModelList(models: ModelOption[]) {
      manager.publishDirect('model.list', models);
    }

    beforeEach(() => {
      actor = new ModelSelectorShadowActor(manager, element, mockVSCode);
      actor.toggle();
    });

    it('does NOT render the pill row when no model has reasoningEffortDefault', () => {
      publishModelList([
        { id: 'deepseek-chat', name: 'V3 Chat', description: '', maxTokens: 8192, isCustom: false },
        { id: 'deepseek-reasoner', name: 'R1', description: '', maxTokens: 65536, isCustom: false },
      ]);
      expect(element.shadowRoot?.querySelector('.reasoning-effort')).toBeNull();
    });

    it('does NOT render pills on inactive thinking-capable rows (only on selected)', () => {
      publishModelList([
        { id: 'deepseek-chat', name: 'V3 Chat', description: '', maxTokens: 8192, isCustom: false },
        // V4 Pro Thinking exists in the list but is NOT the selected model.
        { id: 'deepseek-v4-pro-thinking', name: 'V4 Pro (Thinking)', description: '', maxTokens: 384000, isCustom: false, reasoningEffortDefault: 'max' },
      ]);
      manager.publishDirect('model.current', 'deepseek-chat');
      const pillRows = element.shadowRoot?.querySelectorAll('.reasoning-effort');
      expect(pillRows?.length).toBe(0);
    });

    it('renders pills on the selected row when the model is thinking-capable', () => {
      publishModelList([
        { id: 'deepseek-v4-flash-thinking', name: 'V4 Flash (Thinking)', description: '', maxTokens: 384000, isCustom: false, reasoningEffortDefault: 'high' },
      ]);
      manager.publishDirect('model.current', 'deepseek-v4-flash-thinking');
      const pillRow = element.shadowRoot?.querySelector('.reasoning-effort');
      expect(pillRow).toBeTruthy();
      expect(pillRow?.getAttribute('data-model')).toBe('deepseek-v4-flash-thinking');
      const pills = pillRow?.querySelectorAll('.reasoning-effort-pill');
      expect(pills?.length).toBe(2);
    });

    it('marks the registry-default pill as active when no per-model override set', () => {
      publishModelList([
        { id: 'deepseek-v4-flash-thinking', name: 'V4 Flash (Thinking)', description: '', maxTokens: 384000, isCustom: false, reasoningEffortDefault: 'high' },
      ]);
      manager.publishDirect('model.current', 'deepseek-v4-flash-thinking');
      const high = element.shadowRoot?.querySelector('.reasoning-effort-pill[data-effort="high"]');
      const max = element.shadowRoot?.querySelector('.reasoning-effort-pill[data-effort="max"]');
      expect(high?.classList.contains('active')).toBe(true);
      expect(max?.classList.contains('active')).toBe(false);
    });

    it('lets reasoningEffort override reasoningEffortDefault for active state', () => {
      publishModelList([
        // Registry default is 'high', but the user already overrode to 'max'.
        { id: 'deepseek-v4-flash-thinking', name: 'V4 Flash (Thinking)', description: '', maxTokens: 384000, isCustom: false, reasoningEffortDefault: 'high', reasoningEffort: 'max' },
      ]);
      manager.publishDirect('model.current', 'deepseek-v4-flash-thinking');
      const max = element.shadowRoot?.querySelector('.reasoning-effort-pill[data-effort="max"]');
      const high = element.shadowRoot?.querySelector('.reasoning-effort-pill[data-effort="high"]');
      expect(max?.classList.contains('active')).toBe(true);
      expect(high?.classList.contains('active')).toBe(false);
    });

    it('posts setReasoningEffort and optimistically flips the active pill on click', () => {
      publishModelList([
        { id: 'deepseek-v4-pro-thinking', name: 'V4 Pro (Thinking)', description: '', maxTokens: 384000, isCustom: false, reasoningEffortDefault: 'max' },
      ]);
      manager.publishDirect('model.current', 'deepseek-v4-pro-thinking');
      mockVSCode.postMessage.mockClear();

      const highPill = element.shadowRoot?.querySelector('.reasoning-effort-pill[data-effort="high"]') as HTMLElement;
      highPill?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'setReasoningEffort',
        model: 'deepseek-v4-pro-thinking',
        effort: 'high'
      });
      // After re-render, the high pill should now be active.
      const reHigh = element.shadowRoot?.querySelector('.reasoning-effort-pill[data-effort="high"]');
      const reMax = element.shadowRoot?.querySelector('.reasoning-effort-pill[data-effort="max"]');
      expect(reHigh?.classList.contains('active')).toBe(true);
      expect(reMax?.classList.contains('active')).toBe(false);
    });

    it('stops propagation so clicking a pill does NOT also select the row', () => {
      publishModelList([
        { id: 'deepseek-v4-pro-thinking', name: 'V4 Pro (Thinking)', description: '', maxTokens: 384000, isCustom: false, reasoningEffortDefault: 'max' },
      ]);
      manager.publishDirect('model.current', 'deepseek-v4-pro-thinking');
      mockVSCode.postMessage.mockClear();

      const pill = element.shadowRoot?.querySelector('.reasoning-effort-pill[data-effort="high"]') as HTMLElement;
      pill?.click();

      // Should have posted setReasoningEffort but NOT a stray selectModel.
      const calls = mockVSCode.postMessage.mock.calls.map((c: any) => c[0].type);
      expect(calls).toContain('setReasoningEffort');
      expect(calls).not.toContain('selectModel');
    });
  });
});
