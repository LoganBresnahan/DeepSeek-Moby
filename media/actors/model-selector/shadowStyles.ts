/**
 * Model Selector Popup Styles
 *
 * Styles for the model selection dropdown with parameter controls.
 * Uses VS Code theme variables for consistent theming.
 */

export const modelSelectorShadowStyles = `
  /* Override popup width for model selector */
  .popup-container {
    min-width: 280px;
    max-width: 320px;
  }

  /* Model option */
  .model-option {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 10px 12px;
    cursor: pointer;
    transition: background-color 0.1s;
    border-left: 3px solid transparent;
  }

  .model-option:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .model-option.selected {
    background: var(--vscode-list-activeSelectionBackground);
    border-left-color: var(--vscode-focusBorder, #007acc);
  }

  .model-option-name {
    font-size: 13px;
    font-weight: 500;
    color: var(--vscode-foreground);
  }

  .model-option.selected .model-option-name {
    color: var(--vscode-list-activeSelectionForeground);
  }

  .model-option-desc {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }

  .model-option.selected .model-option-desc {
    color: var(--vscode-list-activeSelectionForeground);
    opacity: 0.8;
  }

  /* Divider */
  .model-dropdown-divider {
    height: 1px;
    background: var(--vscode-panel-border);
    margin: 8px 0;
  }

  /* + Add custom model... link */
  .model-add-custom-row {
    padding: 4px 12px 0 12px;
  }

  .model-add-custom-btn {
    width: 100%;
    padding: 6px 8px;
    background: transparent;
    color: var(--vscode-textLink-foreground);
    border: 1px dashed var(--vscode-panel-border);
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    text-align: left;
    transition: background-color 0.15s, border-color 0.15s;
  }

  .model-add-custom-btn:hover {
    background: var(--vscode-list-hoverBackground);
    border-color: var(--vscode-textLink-foreground);
  }

  /* Parameter controls */
  .parameter-control {
    padding: 8px 12px;
  }

  .parameter-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 12px;
    color: var(--vscode-foreground);
    margin-bottom: 6px;
  }

  .parameter-value {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    min-width: 40px;
    text-align: right;
  }

  .parameter-slider {
    width: 100%;
    height: 4px;
    -webkit-appearance: none;
    appearance: none;
    background: var(--vscode-scrollbarSlider-background);
    border-radius: 2px;
    cursor: pointer;
  }

  .parameter-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--vscode-button-background);
    cursor: pointer;
    transition: transform 0.1s;
  }

  .parameter-slider::-webkit-slider-thumb:hover {
    transform: scale(1.1);
  }

  .parameter-slider::-webkit-slider-thumb:active {
    transform: scale(0.95);
  }

  .parameter-hint {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    margin-top: 4px;
    line-height: 1.3;
    opacity: 0.7;
  }
`;
