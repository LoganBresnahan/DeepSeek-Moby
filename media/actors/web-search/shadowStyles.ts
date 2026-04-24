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

  /* ── Provider picker (Phase 2: Tavily vs SearXNG) ── */
  .ws-provider-options {
    display: flex;
    gap: 6px;
  }

  .ws-provider-btn {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: 6px 8px;
    background: transparent;
    border: 1px solid var(--vscode-input-border);
    border-radius: 4px;
    cursor: pointer;
    text-align: left;
    color: var(--vscode-foreground);
    transition: background 0.15s, border-color 0.15s;
  }

  .ws-provider-btn:hover:not(:disabled) {
    background: var(--vscode-list-hoverBackground);
  }

  .ws-provider-btn.active {
    background: var(--vscode-terminal-ansiBlue, #3b8eea);
    color: var(--vscode-editor-background);
    border-color: var(--vscode-terminal-ansiBlue, #3b8eea);
  }

  .ws-provider-btn .ws-provider-name {
    font-size: 12px;
    font-weight: 600;
  }

  .ws-provider-btn .ws-provider-hint {
    font-size: 10px;
    opacity: 0.75;
  }

  /* ── SearXNG endpoint row ── */
  .ws-endpoint-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .ws-endpoint-value {
    flex: 1;
    padding: 4px 6px;
    background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.04));
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family);
    font-size: 11px;
    color: var(--vscode-foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ws-endpoint-value.unset {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }

  .ws-endpoint-btn {
    padding: 4px 10px;
    background: transparent;
    border: 1px solid var(--vscode-input-border);
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
    color: var(--vscode-foreground);
    transition: background 0.15s;
  }

  .ws-endpoint-btn:hover:not(:disabled) {
    background: var(--vscode-list-hoverBackground);
  }

  /* ── SearXNG engines checkbox grid ── */
  .ws-engines {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px 10px;
    margin-top: 2px;
  }

  .ws-engine-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    cursor: pointer;
    color: var(--vscode-foreground);
  }

  .ws-engine-item input[type="checkbox"] {
    margin: 0;
    cursor: pointer;
  }

  .ws-engines-hint {
    margin-top: 6px;
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    opacity: 0.8;
  }

  /* ── Test connection row ── */
  .ws-test-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .ws-test-btn {
    padding: 4px 10px;
    background: transparent;
    border: 1px solid var(--vscode-input-border);
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
    color: var(--vscode-foreground);
    transition: background 0.15s;
    flex-shrink: 0;
  }

  .ws-test-btn:hover:not(:disabled) {
    background: var(--vscode-list-hoverBackground);
  }

  .ws-test-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .ws-test-result {
    flex: 1;
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ws-test-result.ok {
    color: var(--vscode-terminal-ansiGreen, #4eb14e);
  }

  .ws-test-result.err {
    color: var(--vscode-errorForeground, #e74856);
  }
`;
