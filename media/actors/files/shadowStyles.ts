/**
 * Files Modal Styles
 *
 * Styles for the file selection modal.
 * Uses VS Code theme variables for consistent theming.
 */

export const filesShadowStyles = `
  /* File Sections */
  .file-section {
    padding: 12px 16px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }

  .file-section:last-child {
    border-bottom: none;
  }

  .file-section-header {
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .file-section-count {
    font-weight: normal;
    opacity: 0.7;
  }

  /* Open Files List */
  .open-files-list {
    max-height: 150px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .open-file-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 4px;
    cursor: pointer;
    transition: background-color 0.1s;
  }

  .open-file-item:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .open-file-checkbox {
    width: 16px;
    height: 16px;
    cursor: pointer;
    flex-shrink: 0;
  }

  .open-file-name {
    flex: 1;
    font-size: 13px;
    color: var(--vscode-foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Search Input */
  .file-search-input {
    width: 100%;
    padding: 8px 12px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, #3c3c3c));
    border-radius: 4px;
    color: var(--vscode-input-foreground);
    font-size: 13px;
    outline: none;
    transition: border-color 0.15s;
  }

  .file-search-input:focus {
    border-color: var(--vscode-focusBorder, #007acc);
  }

  .file-search-input::placeholder {
    color: var(--vscode-input-placeholderForeground);
  }

  /* Search Results */
  .file-search-results {
    margin-top: 8px;
    max-height: 150px;
    overflow-y: auto;
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-widget-border));
    border-radius: 4px;
  }

  .file-search-result-item {
    padding: 8px 12px;
    font-size: 13px;
    color: var(--vscode-foreground);
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: background-color 0.1s;
  }

  .file-search-result-item:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .file-search-no-results {
    padding: 12px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
    font-size: 13px;
  }

  /* Selected Files List */
  .selected-files-container {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-height: 40px;
  }

  .selected-files-empty {
    color: var(--vscode-descriptionForeground);
    font-size: 13px;
    font-style: italic;
    padding: 8px 0;
  }

  .selected-file-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 12px;
    font-size: 12px;
    max-width: 200px;
  }

  .selected-file-name {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .selected-file-remove {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 0 2px;
    font-size: 14px;
    line-height: 1;
    opacity: 0.7;
    transition: opacity 0.1s;
  }

  .selected-file-remove:hover {
    opacity: 1;
  }

  /* Footer Buttons */
  .footer-left {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .footer-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .clear-btn {
    background: transparent;
    border: 1px solid var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    padding: 6px 12px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    transition: background-color 0.15s;
  }

  .clear-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .footer-hint {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }

  /* Scrollbar */
  .open-files-list::-webkit-scrollbar,
  .file-search-results::-webkit-scrollbar {
    width: 8px;
  }

  .open-files-list::-webkit-scrollbar-track,
  .file-search-results::-webkit-scrollbar-track {
    background: transparent;
  }

  .open-files-list::-webkit-scrollbar-thumb,
  .file-search-results::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background);
    border-radius: 4px;
  }

  .open-files-list::-webkit-scrollbar-thumb:hover,
  .file-search-results::-webkit-scrollbar-thumb:hover {
    background: var(--vscode-scrollbarSlider-hoverBackground);
  }
`;
