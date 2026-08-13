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
      expect(selectedOption?.getAttribute('data-model')).toBe('deepseek-v4-pro-thinking');
    });
  });

  describe('Model selection', () => {
    beforeEach(() => {
      actor = new ModelSelectorShadowActor(manager, element, mockVSCode);
      actor.toggle();
      mockVSCode.postMessage.mockClear();
    });

    it('selects model when clicked', () => {
      const flashOption = element.shadowRoot?.querySelector('.model-option[data-model="deepseek-v4-flash-thinking"]') as HTMLElement;
      flashOption?.click();

      expect(actor.getSelectedModel()).toBe('deepseek-v4-flash-thinking');
    });

    it('posts selectModel message to extension', () => {
      const flashOption = element.shadowRoot?.querySelector('.model-option[data-model="deepseek-v4-flash-thinking"]') as HTMLElement;
      flashOption?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'selectModel',
        model: 'deepseek-v4-flash-thinking'
      });
    });

    it('updates selected visual on model change', () => {
      const flashOption = element.shadowRoot?.querySelector('.model-option[data-model="deepseek-v4-flash-thinking"]') as HTMLElement;
      flashOption?.click();

      // Re-query after click because selectModel() re-renders the popup content
      const updatedFlashOption = element.shadowRoot?.querySelector('.model-option[data-model="deepseek-v4-flash-thinking"]');
      expect(updatedFlashOption?.classList.contains('selected')).toBe(true);

      const proOption = element.shadowRoot?.querySelector('.model-option[data-model="deepseek-v4-pro-thinking"]');
      expect(proOption?.classList.contains('selected')).toBe(false);
    });

    it('publishes model.selected on change', () => {
      // The actor uses this.publish() which calls manager.handleStateChange()
      const handleStateSpy = vi.spyOn(manager, 'handleStateChange');

      const flashOption = element.shadowRoot?.querySelector('.model-option[data-model="deepseek-v4-flash-thinking"]') as HTMLElement;
      flashOption?.click();

      expect(handleStateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({ 'model.selected': 'deepseek-v4-flash-thinking' })
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
      // Make the R1 model available in the list, then switch to it so the
      // shell iterations slider appears (it's gated on deepseek-reasoner).
      actor.setModels([
        { id: 'deepseek-v4-pro-thinking', name: 'DeepSeek V4 Pro', description: '', maxTokens: 384000 },
        { id: 'deepseek-reasoner', name: 'R1', description: '', maxTokens: 65536 }
      ]);
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

      // Includes the selected model id so the backend writes the correct per-model
      // config key instead of falling back to getModel() (the latent wrong-key bug).
      expect(mockVSCode.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'setMaxTokens',
          maxTokens: 4096,
          model: expect.any(String)
        })
      );
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
      expect(actor.getSelectedModel()).toBe('deepseek-v4-pro-thinking');
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
      const option = element.shadowRoot?.querySelector('.model-option[data-model="deepseek-v4-flash-thinking"]') as HTMLElement;
      option?.click();

      expect(handler).toHaveBeenCalledWith('deepseek-v4-flash-thinking');
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

  // Thinking controls. Every pill is rendered FROM a declaration, so the
  // regression locks are about what does NOT render as much as what does:
  // no Off pill without an off-knob, no Effort pill for an undeclared level.
  describe('Thinking controls', () => {
    function publishModelList(models: ModelOption[]) {
      manager.publishDirect('model.list', models);
    }

    const V4_PRO: ModelOption = {
      id: 'deepseek-v4-pro-thinking', name: 'V4 Pro', description: '', maxTokens: 384000,
      isCustom: false, thinkingLevels: ['high', 'max'], canDisableThinking: true,
      thinking: 'on', thinkingLevel: 'max',
    };
    // Shaped after Kimi K3: grades effort, but always reasons.
    const K3: ModelOption = {
      id: 'kimi-k3', name: 'Kimi K3', description: '', maxTokens: 1048576,
      isCustom: true, thinkingLevels: ['low', 'high', 'max'], canDisableThinking: false,
      thinking: 'on', thinkingLevel: 'max',
    };

    beforeEach(() => {
      actor = new ModelSelectorShadowActor(manager, element, mockVSCode);
      actor.toggle();
    });

    it('renders no controls for a model that declares neither levels nor an off-knob', () => {
      publishModelList([
        { id: 'deepseek-chat', name: 'V3 Chat', description: '', maxTokens: 8192, isCustom: false },
      ]);
      manager.publishDirect('model.current', 'deepseek-chat');
      expect(element.shadowRoot?.querySelector('.thinking-control')).toBeNull();
    });

    it('renders no controls on inactive rows, only on the selected one', () => {
      publishModelList([
        { id: 'deepseek-chat', name: 'V3 Chat', description: '', maxTokens: 8192, isCustom: false },
        V4_PRO,
      ]);
      manager.publishDirect('model.current', 'deepseek-chat');
      expect(element.shadowRoot?.querySelectorAll('.thinking-control').length).toBe(0);
    });

    it('renders a Thinking row and one Effort pill per declared level', () => {
      publishModelList([V4_PRO]);
      manager.publishDirect('model.current', V4_PRO.id);
      const rows = element.shadowRoot?.querySelectorAll('.thinking-control');
      expect(rows?.length).toBe(2);
      expect(element.shadowRoot?.querySelectorAll('[data-action="setThinking"]').length).toBe(2);
      const levels = element.shadowRoot?.querySelectorAll('[data-action="setThinkingLevel"]');
      expect(Array.from(levels ?? []).map(p => p.getAttribute('data-level'))).toEqual(['high', 'max']);
    });

    it('renders a level pill per declared level for a custom model — the row reasoningEffortDefault could never drive', () => {
      publishModelList([K3]);
      manager.publishDirect('model.current', K3.id);
      const levels = element.shadowRoot?.querySelectorAll('[data-action="setThinkingLevel"]');
      expect(Array.from(levels ?? []).map(p => p.textContent?.trim())).toEqual(['Low', 'High', 'Max']);
    });

    it('omits the Thinking row entirely when the model declares no off-knob', () => {
      publishModelList([K3]);
      manager.publishDirect('model.current', K3.id);
      // K3 always thinks. An Off pill here would be a control with no params
      // behind it — the exact dead-UI class this design removes.
      expect(element.shadowRoot?.querySelector('[data-action="setThinking"]')).toBeNull();
      expect(element.shadowRoot?.querySelectorAll('.thinking-control').length).toBe(1);
    });

    it('marks the effective level active, not the first pill', () => {
      publishModelList([{ ...V4_PRO, thinkingLevel: 'high' }]);
      manager.publishDirect('model.current', V4_PRO.id);
      const high = element.shadowRoot?.querySelector('[data-level="high"]');
      const max = element.shadowRoot?.querySelector('[data-level="max"]');
      expect(high?.classList.contains('active')).toBe(true);
      expect(max?.classList.contains('active')).toBe(false);
    });

    it('dims and disables the Effort row when thinking is off, keeping the remembered level', () => {
      publishModelList([{ ...V4_PRO, thinking: 'off', thinkingLevel: 'max' }]);
      manager.publishDirect('model.current', V4_PRO.id);
      const rows = element.shadowRoot?.querySelectorAll('.thinking-control');
      const effortRow = rows?.[1];
      expect(effortRow?.classList.contains('disabled')).toBe(true);
      // Still rendered, so the choice reads as remembered rather than lost.
      expect(effortRow?.querySelectorAll('[data-level]').length).toBe(2);
      // ...but not shown as the live setting while thinking is off.
      expect(element.shadowRoot?.querySelector('[data-level="max"]')?.classList.contains('active')).toBe(false);
      // Off is the active thinking pill.
      const off = element.shadowRoot?.querySelector('[data-thinking="off"]');
      expect(off?.classList.contains('active')).toBe(true);
    });

    it('posts setThinking and optimistically flips the pill on click', () => {
      publishModelList([V4_PRO]);
      manager.publishDirect('model.current', V4_PRO.id);
      mockVSCode.postMessage.mockClear();

      (element.shadowRoot?.querySelector('[data-thinking="off"]') as HTMLElement)?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'setThinking', model: V4_PRO.id, thinking: 'off',
      });
      expect(element.shadowRoot?.querySelector('[data-thinking="off"]')?.classList.contains('active')).toBe(true);
    });

    it('posts setThinkingLevel and optimistically flips the pill on click', () => {
      publishModelList([V4_PRO]);
      manager.publishDirect('model.current', V4_PRO.id);
      mockVSCode.postMessage.mockClear();

      (element.shadowRoot?.querySelector('[data-level="high"]') as HTMLElement)?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'setThinkingLevel', model: V4_PRO.id, level: 'high',
      });
      expect(element.shadowRoot?.querySelector('[data-level="high"]')?.classList.contains('active')).toBe(true);
    });

    it('ignores clicks on a disabled level pill', () => {
      publishModelList([{ ...V4_PRO, thinking: 'off' }]);
      manager.publishDirect('model.current', V4_PRO.id);
      mockVSCode.postMessage.mockClear();

      (element.shadowRoot?.querySelector('[data-level="high"]') as HTMLElement)?.click();

      expect(mockVSCode.postMessage).not.toHaveBeenCalled();
    });

    it('stops propagation so clicking a pill does NOT also select the row', () => {
      publishModelList([V4_PRO]);
      manager.publishDirect('model.current', V4_PRO.id);
      mockVSCode.postMessage.mockClear();

      (element.shadowRoot?.querySelector('[data-level="high"]') as HTMLElement)?.click();

      const calls = mockVSCode.postMessage.mock.calls.map((c: any) => c[0].type);
      expect(calls).toContain('setThinkingLevel');
      expect(calls).not.toContain('selectModel');
    });
  });

  // A fresh model selection used to adopt the slider's UPPER BOUND as its
  // value. On a model whose API ceiling equals its context window (Kimi K3:
  // both 1,048,576) that left zero budget for the conversation — every
  // message dropped, and the model answered from the system prompt alone.
  describe('fresh selection uses the model default, not its ceiling', () => {
    function publishModelList(models: ModelOption[]) {
      manager.publishDirect('model.list', models);
    }

    const K3: ModelOption = {
      id: 'kimi-k3', name: 'Kimi K3', description: '',
      maxTokens: 1048576,          // API ceiling — slider bound only
      defaultMaxTokens: 131072,    // what a fresh selection should take
    } as ModelOption;

    beforeEach(() => {
      actor = new ModelSelectorShadowActor(manager, element, mockVSCode);
      actor.toggle();
    });

    it('posts the default, not the cap, when the model has no saved value', () => {
      publishModelList([K3]);
      mockVSCode.postMessage.mockClear();

      (element.shadowRoot?.querySelector('[data-model="kimi-k3"]') as HTMLElement)?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'setMaxTokens', maxTokens: 131072, model: 'kimi-k3' })
      );
    });

    it('falls back to the cap when no default is declared', () => {
      publishModelList([{ ...K3, defaultMaxTokens: undefined } as ModelOption]);
      mockVSCode.postMessage.mockClear();

      (element.shadowRoot?.querySelector('[data-model="kimi-k3"]') as HTMLElement)?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'setMaxTokens', maxTokens: 1048576 })
      );
    });
  });
});
