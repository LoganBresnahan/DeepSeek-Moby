/**
 * Web Search Popup Styles
 *
 * Migrated from chat.css inline styles into shadow DOM.
 */

export const webSearchShadowStyles = `
  .popup-container {
    min-width: 260px;
    max-width: 300px;
  }

  .popup-body {
    padding: 12px;
  }

  /* Mode selector */
  .ws-mode-options {
    display: flex;
    gap: 6px;
    margin-bottom: 12px;
  }

  .ws-mode-btn {
    flex: 1;
    padding: 6px 8px;
    background: transparent;
    border: 1px solid var(--vscode-input-border);
    border-radius: 4px;
    cursor: pointer;
    text-align: center;
    color: var(--vscode-foreground);
    font-size: 11px;
    font-weight: 500;
    transition: all 0.15s;
  }

  .ws-mode-btn:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .ws-mode-btn.active[data-mode="off"] {
    background: var(--vscode-inputValidation-errorBackground, rgba(231, 72, 86, 0.15));
    color: var(--vscode-errorForeground, #e74856);
    border-color: var(--vscode-errorForeground, #e74856);
  }

  .ws-mode-btn.active[data-mode="manual"] {
    background: var(--vscode-terminal-ansiGreen, #4ec9b0);
    color: var(--vscode-editor-background);
    border-color: var(--vscode-terminal-ansiGreen, #4ec9b0);
  }

  .ws-mode-btn.active[data-mode="auto"] {
    background: var(--vscode-terminal-ansiBlue, #3b8eea);
    color: var(--vscode-editor-background);
    border-color: var(--vscode-terminal-ansiBlue, #3b8eea);
  }

  /* Settings section */
  .ws-settings.disabled-section {
    opacity: 0.4;
    pointer-events: none;
  }

  .ws-option {
    margin-bottom: 12px;
  }

  .ws-option label {
    display: block;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 6px;
  }

  .ws-option input[type="range"] {
    width: 100%;
    height: 4px;
    -webkit-appearance: none;
    background: var(--vscode-scrollbarSlider-background);
    border-radius: 2px;
  }

  .ws-option input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 12px;
    height: 12px;
    background: var(--vscode-charts-red, #e74c3c);
    box-shadow: 0 0 4px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.3));
    border-radius: 50%;
    cursor: pointer;
  }

  .ws-option input[type="range"]::-webkit-slider-thumb:hover {
    background: var(--vscode-terminal-ansiRed, #ff6b5b);
  }

  /* Depth toggle */
  .ws-depth-options {
    display: flex;
    gap: 8px;
  }

  .ws-depth-btn {
    flex: 1;
    padding: 8px;
    background: transparent;
    border: 1px solid var(--vscode-input-border);
    border-radius: 4px;
    cursor: pointer;
    text-align: center;
    color: var(--vscode-foreground);
    transition: all 0.15s;
  }

  .ws-depth-btn:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .ws-depth-btn.active {
    background: var(--vscode-terminal-ansiGreen, #4ec9b0);
    color: var(--vscode-editor-background);
    border-color: var(--vscode-terminal-ansiGreen, #4ec9b0);
  }

  .ws-depth-name {
    display: block;
    font-size: 12px;
    font-weight: 500;
  }

  .ws-depth-credits {
    display: block;
    font-size: 10px;
    opacity: 0.8;
  }

  /* Clear cache */
  .ws-clear-cache-btn {
    width: 100%;
    padding: 8px;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    margin-top: 8px;
    transition: background 0.15s, color 0.15s;
  }

  .ws-clear-cache-btn:hover {
    background: var(--vscode-list-hoverBackground);
    color: var(--vscode-foreground);
  }
`;
