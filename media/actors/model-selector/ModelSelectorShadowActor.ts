/**
 * ModelSelectorShadowActor
 *
 * Shadow DOM actor for the model selection dropdown.
 * Allows users to switch between models and adjust parameters
 * like temperature, tool iterations, and max tokens.
 *
 * Publications:
 * - model.popup.visible: boolean - whether the popup is open
 * - model.selected: string - currently selected model
 * - model.temperature: number - temperature setting
 * - model.toolLimit: number - tool iteration limit
 * - model.shellIterations: number - shell iteration limit (R1)
 * - model.maxTokens: number - max output tokens
 *
 * Subscriptions:
 * - model.popup.open: boolean - request to open/close popup
 * - model.current: string - current model from extension
 * - model.settings: ModelSettings - settings from extension
 */

import { PopupShadowActor, PopupConfig } from '../../state/PopupShadowActor';
import { EventStateManager } from '../../state/EventStateManager';
import type { VSCodeAPI } from '../../state/types';
import { modelSelectorShadowStyles } from './shadowStyles';

// ============================================
// Types
// ============================================

export interface ModelOption {
  id: string;
  name: string;
  description: string;
  maxTokens: number;
}

export interface ModelSettings {
  model: string;
  temperature: number;
  toolLimit: number;
  shellIterations: number;
  maxTokens: number;
}

export type ModelChangeHandler = (model: string) => void;
export type SettingsChangeHandler = (settings: Partial<ModelSettings>) => void;

// ============================================
// Default Models
// ============================================

const DEFAULT_MODELS: ModelOption[] = [
  { id: 'deepseek-chat', name: 'DeepSeek Chat (V3)', description: 'Fast, general-purpose', maxTokens: 8192 },
  { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner (R1)', description: 'Chain-of-thought reasoning', maxTokens: 65536 }
];

// ============================================
// ModelSelectorShadowActor
// ============================================

export class ModelSelectorShadowActor extends PopupShadowActor {
  private _models: ModelOption[] = DEFAULT_MODELS;
  private _selectedModel = 'deepseek-chat';
  private _temperature = 0.7;
  private _toolLimit = 100;
  private _shellIterations = 100;
  private _maxTokens = 8192;

  private _onModelChange: ModelChangeHandler | null = null;
  private _onSettingsChange: SettingsChangeHandler | null = null;

  constructor(manager: EventStateManager, element: HTMLElement, vscode: VSCodeAPI) {
    const config: PopupConfig = {
      manager,
      element,
      vscode,
      position: 'bottom-right',
      width: '300px',
      publications: {
        'model.selected': () => this._selectedModel,
        'model.temperature': () => this._temperature,
        'model.toolLimit': () => this._toolLimit,
        'model.shellIterations': () => this._shellIterations,
        'model.maxTokens': () => this._maxTokens
      },
      subscriptions: {
        'model.current': (value: unknown) => this.handleModelChange(value as string),
        'model.settings': (value: unknown) => this.handleSettingsUpdate(value as ModelSettings)
      },
      additionalStyles: modelSelectorShadowStyles,
      openRequestKey: 'model.popup.open',
      visibleStateKey: 'model.popup.visible'
    };

    super(config);

    // Re-render now that instance properties are initialized
    // (base class renders during construction when properties are undefined)
    this.updateBodyContent(this.renderPopupContent());
  }

  // ============================================
  // Abstract Method Implementations
  // ============================================

  protected renderPopupContent(): string {
    // Defensive checks: properties may be undefined during base class construction
    const models = this._models || [];
    const temperature = this._temperature ?? 0.7;
    const toolLimit = this._toolLimit ?? 100;
    const shellIterations = this._shellIterations ?? 100;
    const maxTokens = this._maxTokens ?? 8192;
    const isReasoner = (this._selectedModel || 'deepseek-chat') === 'deepseek-reasoner';

    // Use the selected model's max tokens as the slider maximum
    const modelMaxTokens = this.getSelectedModelMaxTokens();

    return `
      ${models.map(model => this.renderModelOption(model)).join('')}
      <div class="model-dropdown-divider"></div>
      ${this.renderParameterControl('temperature', 'Temperature', temperature.toString(), 0, 2, 0.1, 'Controls randomness. 0 = deterministic, 2 = very creative')}
      ${isReasoner
        ? this.renderParameterControl('shellIterations', 'Shell Iterations', shellIterations.toString(), 1, 100, 1, 'Limits R1 shell command loops. 100 = No limit')
        : this.renderParameterControl('toolLimit', 'Tool Iterations', toolLimit.toString(), 5, 100, 5, 'Limits tool calling loops. 100 = No limit')}
      <div class="model-dropdown-divider"></div>
      ${this.renderParameterControl('maxTokens', 'Max Output Tokens', this.formatTokens(maxTokens), 256, modelMaxTokens, 256, this.getTokenHint())}
    `;
  }

  private renderModelOption(model: ModelOption): string {
    const selectedModel = this._selectedModel || 'deepseek-chat';
    const isSelected = model.id === selectedModel;
    return `
      <div class="model-option ${isSelected ? 'selected' : ''}" data-model="${this.escapeHtml(model.id)}">
        <span class="model-option-name">${this.escapeHtml(model.name)}</span>
        <span class="model-option-desc">${this.escapeHtml(model.description)}</span>
      </div>
    `;
  }

  private renderParameterControl(
    id: string,
    label: string,
    value: string,
    min: number,
    max: number,
    step: number,
    hint: string
  ): string {
    const currentValue = this.getParameterValue(id);
    return `
      <div class="parameter-control">
        <div class="parameter-label">
          <span>${this.escapeHtml(label)}</span>
          <span class="parameter-value" data-value="${id}">${value}</span>
        </div>
        <input
          type="range"
          class="parameter-slider"
          data-param="${id}"
          min="${min}"
          max="${max}"
          step="${step}"
          value="${currentValue}"
        />
        <div class="parameter-hint">${this.escapeHtml(hint)}</div>
      </div>
    `;
  }

  private getParameterValue(id: string): number {
    switch (id) {
      case 'temperature': return this._temperature ?? 0.7;
      case 'toolLimit': return this._toolLimit ?? 100;
      case 'shellIterations': return this._shellIterations ?? 100;
      case 'maxTokens': return this._maxTokens ?? 8192;
      default: return 0;
    }
  }

  protected setupPopupEvents(): void {
    // Model option click (via delegation)
    this.delegate('click', '.model-option', (e, element) => {
      const modelId = element.getAttribute('data-model');
      if (modelId && modelId !== this._selectedModel) {
        this.selectModel(modelId);
      }
    });

    // Slider input (via delegation)
    this.delegate('input', '.parameter-slider', (e) => {
      const slider = e.target as HTMLInputElement;
      const param = slider.getAttribute('data-param');
      const value = parseFloat(slider.value);

      if (param) {
        this.updateParameter(param, value);
      }
    });
  }

  // ============================================
  // Subscription Handlers
  // ============================================

  private handleModelChange(model: string): void {
    if (model && model !== this._selectedModel) {
      this._selectedModel = model;
      // Re-render popup content (works whether popup is open or closed)
      this.updateBodyContent(this.renderPopupContent());
      this.publish({ 'model.selected': model });
    }
  }

  private handleSettingsUpdate(settings: ModelSettings): void {
    if (!settings) return;

    let changed = false;

    if (settings.model && settings.model !== this._selectedModel) {
      this._selectedModel = settings.model;
      changed = true;
    }

    if (typeof settings.temperature === 'number' && settings.temperature !== this._temperature) {
      this._temperature = settings.temperature;
      changed = true;
    }

    if (typeof settings.toolLimit === 'number' && settings.toolLimit !== this._toolLimit) {
      this._toolLimit = settings.toolLimit;
      changed = true;
    }

    if (typeof settings.shellIterations === 'number' && settings.shellIterations !== this._shellIterations) {
      this._shellIterations = settings.shellIterations;
      changed = true;
    }

    if (typeof settings.maxTokens === 'number' && settings.maxTokens !== this._maxTokens) {
      this._maxTokens = settings.maxTokens;
      changed = true;
    }

    if (changed) {
      this.updateBodyContent(this.renderPopupContent());
    }
  }

  // ============================================
  // Model & Parameter Updates
  // ============================================

  private selectModel(modelId: string): void {
    this._selectedModel = modelId;

    // Clamp maxTokens to new model's limit and update slider
    const newModelMaxTokens = this.getSelectedModelMaxTokens();
    if (this._maxTokens > newModelMaxTokens) {
      this._maxTokens = newModelMaxTokens;
      // Notify extension of the clamped value
      this._vscode.postMessage({ type: 'setMaxTokens', maxTokens: this._maxTokens });
      this.publish({ 'model.maxTokens': this._maxTokens });
    }

    // Re-render to update slider max and hint
    this.updateBodyContent(this.renderPopupContent());

    // Notify handlers
    if (this._onModelChange) {
      this._onModelChange(modelId);
    }

    // Send to extension
    this._vscode.postMessage({ type: 'selectModel', model: modelId });

    // Publish state
    this.publish({ 'model.selected': modelId });
  }

  private updateParameter(param: string, value: number): void {
    const valueEl = this.query<HTMLElement>(`[data-value="${param}"]`);

    switch (param) {
      case 'temperature':
        this._temperature = value;
        if (valueEl) valueEl.textContent = value.toString();
        this._vscode.postMessage({ type: 'setTemperature', temperature: value });
        this.publish({ 'model.temperature': value });
        break;

      case 'toolLimit':
        this._toolLimit = value;
        if (valueEl) valueEl.textContent = value.toString();
        this._vscode.postMessage({ type: 'setToolLimit', toolLimit: value });
        this.publish({ 'model.toolLimit': value });
        break;

      case 'shellIterations':
        this._shellIterations = value;
        if (valueEl) valueEl.textContent = value.toString();
        this._vscode.postMessage({ type: 'setShellIterations', shellIterations: value });
        this.publish({ 'model.shellIterations': value });
        break;

      case 'maxTokens':
        this._maxTokens = value;
        if (valueEl) valueEl.textContent = this.formatTokens(value);
        this._vscode.postMessage({ type: 'setMaxTokens', maxTokens: value });
        this.publish({ 'model.maxTokens': value });
        break;
    }

    // Notify handler
    if (this._onSettingsChange) {
      this._onSettingsChange({ [param]: value });
    }
  }

  // ============================================
  // Utilities
  // ============================================

  private formatTokens(value: number): string {
    return value >= 1000 ? `${(value / 1024).toFixed(1)}K` : value.toString();
  }

  private getTokenHint(): string {
    const selectedModel = this._selectedModel || 'deepseek-chat';
    return `Maximum tokens in response. ${selectedModel === 'deepseek-reasoner' ? 'Reasoner: 64K' : 'Chat: 8K'}`;
  }

  /**
   * Get the max tokens limit for the currently selected model.
   */
  private getSelectedModelMaxTokens(): number {
    const models = this._models || [];
    const selectedModel = this._selectedModel || 'deepseek-chat';
    const model = models.find(m => m.id === selectedModel);
    return model?.maxTokens ?? 8192;
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Set handler for model changes.
   */
  onModelChange(handler: ModelChangeHandler): void {
    this._onModelChange = handler;
  }

  /**
   * Set handler for settings changes.
   */
  onSettingsChange(handler: SettingsChangeHandler): void {
    this._onSettingsChange = handler;
  }

  /**
   * Get current model.
   */
  getSelectedModel(): string {
    return this._selectedModel;
  }

  /**
   * Get current settings.
   */
  getSettings(): ModelSettings {
    return {
      model: this._selectedModel,
      temperature: this._temperature,
      toolLimit: this._toolLimit,
      shellIterations: this._shellIterations,
      maxTokens: this._maxTokens
    };
  }

  /**
   * Set models list.
   */
  setModels(models: ModelOption[]): void {
    this._models = models;
    this.updateBodyContent(this.renderPopupContent());
  }
}
