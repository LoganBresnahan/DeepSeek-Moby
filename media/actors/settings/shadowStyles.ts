/**
 * Settings Popup Styles
 *
 * Styles for the settings dropdown with all configuration options.
 * Uses VS Code theme variables for consistent theming.
 */

export const settingsShadowStyles = `
  /* Override popup dimensions for settings */
  .popup-container {
    min-width: 320px;
    max-width: 380px;
    max-height: 500px;
  }

  .popup-body {
    overflow-y: auto;
    max-height: 450px;
    padding-bottom: 8px;
  }

  /* Settings sections */
  .settings-section {
    padding: 12px;
  }

  .settings-section-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 10px;
  }

  /* Divider */
  .settings-divider {
    height: 1px;
    background: var(--vscode-panel-border);
    margin: 0;
  }

  /* Settings control row */
  .settings-control {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 10px;
  }

  .settings-control:last-child {
    margin-bottom: 0;
  }

  .settings-control label {
    font-size: 12px;
    color: var(--vscode-foreground);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .settings-control label input[type="checkbox"] {
    width: 14px;
    height: 14px;
    cursor: pointer;
  }

  /* Hint text */
  .settings-hint {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    line-height: 1.3;
    opacity: 0.8;
  }

  /* Select dropdown */
  .settings-select {
    padding: 4px 8px;
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-widget-border));
    border-radius: 4px;
    color: var(--vscode-dropdown-foreground);
    font-size: 12px;
    cursor: pointer;
    outline: none;
  }

  .settings-select:focus {
    border-color: var(--vscode-focusBorder);
  }

  /* Slider */
  .settings-slider {
    width: 100%;
    height: 4px;
    -webkit-appearance: none;
    appearance: none;
    background: var(--vscode-scrollbarSlider-background);
    border-radius: 2px;
    cursor: pointer;
  }

  .settings-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--vscode-button-background);
    cursor: pointer;
  }

  /* Textarea */
  .settings-textarea {
    width: 100%;
    min-height: 80px;
    padding: 8px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
    border-radius: 4px;
    color: var(--vscode-input-foreground);
    font-size: 12px;
    font-family: inherit;
    resize: vertical;
    outline: none;
  }

  .settings-textarea:focus {
    border-color: var(--vscode-focusBorder);
  }

  .settings-textarea::placeholder {
    color: var(--vscode-input-placeholderForeground);
  }

  /* Button row */
  .settings-btn-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }

  /* Action button */
  .settings-action-btn {
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 11px;
    cursor: pointer;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    transition: background-color 0.15s;
  }

  .settings-action-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .settings-danger-btn {
    background: transparent;
    color: var(--vscode-errorForeground, #f48771);
    border: 1px solid var(--vscode-errorForeground, #f48771);
  }

  .settings-danger-btn:hover {
    background: var(--vscode-errorForeground, #f48771);
    color: var(--vscode-editor-background);
  }

  /* Allow all commands label */
  .settings-wild-label {
    display: flex !important;
    align-items: center;
    gap: 4px;
  }

  .settings-wild-icon {
    font-size: 14px;
  }

  /* Preview panel */
  .settings-preview {
    margin-top: 10px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    background: var(--vscode-editor-background);
    overflow: hidden;
  }

  .settings-preview-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 10px;
    background: var(--vscode-sideBarSectionHeader-background);
    font-size: 11px;
    color: var(--vscode-foreground);
  }

  .settings-close-btn {
    background: none;
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    padding: 2px 6px;
    font-size: 14px;
    opacity: 0.7;
  }

  .settings-close-btn:hover {
    opacity: 1;
  }

  .settings-preview-content {
    padding: 10px;
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-foreground);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 150px;
    overflow-y: auto;
    margin: 0;
  }

  /* Slider with label value */
  .settings-slider-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .settings-slider-value {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    min-width: 30px;
    text-align: right;
  }

  /* Scrollbar */
  .popup-body::-webkit-scrollbar {
    width: 8px;
  }

  .popup-body::-webkit-scrollbar-track {
    background: transparent;
  }

  .popup-body::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background);
    border-radius: 4px;
  }

  .popup-body::-webkit-scrollbar-thumb:hover {
    background: var(--vscode-scrollbarSlider-hoverBackground);
  }
`;
