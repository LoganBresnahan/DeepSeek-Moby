/**
 * History Modal Styles
 *
 * Modal styling for the history feature.
 * Uses VS Code theme variables for consistent theming.
 */

export const historyShadowStyles = `
  /* Modal Backdrop */
  .history-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    visibility: hidden;
    transition: opacity 0.2s ease, visibility 0.2s ease;
  }

  .history-backdrop.visible {
    opacity: 1;
    visibility: visible;
  }

  /* Modal Container */
  .history-modal {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, #454545));
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    width: 90%;
    max-width: 600px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    transform: translateY(-20px);
    opacity: 0;
    transition: transform 0.2s ease, opacity 0.2s ease;
  }

  .history-backdrop.visible .history-modal {
    transform: translateY(0);
    opacity: 1;
  }

  /* Modal Header */
  .history-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px;
    border-bottom: 1px solid var(--vscode-widget-border, #454545);
  }

  .history-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 16px;
    font-weight: 600;
    color: var(--vscode-foreground);
  }

  .history-title-icon {
    font-size: 18px;
  }

  .history-close {
    background: none;
    border: none;
    color: var(--vscode-foreground);
    font-size: 18px;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 4px;
    opacity: 0.7;
    transition: opacity 0.15s ease, background 0.15s ease;
  }

  .history-close:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground);
  }

  /* Search Bar */
  .history-search {
    padding: 12px 16px;
    border-bottom: 1px solid var(--vscode-widget-border, #454545);
  }

  .history-search-input {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid var(--vscode-input-border, #3c3c3c);
    border-radius: 4px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font-size: 13px;
    outline: none;
  }

  .history-search-input:focus {
    border-color: var(--vscode-focusBorder);
  }

  .history-search-input::placeholder {
    color: var(--vscode-input-placeholderForeground);
  }

  /* History List */
  .history-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
  }

  .history-empty {
    padding: 32px 16px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }

  /* Date Group */
  .history-group {
    margin-bottom: 8px;
  }

  .history-group-title {
    padding: 8px 16px 4px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground);
  }

  /* History Entry */
  .history-entry {
    display: flex;
    align-items: flex-start;
    padding: 10px 16px;
    cursor: pointer;
    transition: background 0.15s ease;
    position: relative;
  }

  .history-entry:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .history-entry.active {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }

  .history-entry-content {
    flex: 1;
    min-width: 0;
  }

  .history-entry-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--vscode-foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-bottom: 2px;
  }

  .history-entry.active .history-entry-title {
    color: var(--vscode-list-activeSelectionForeground);
  }

  .history-entry-preview {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-bottom: 4px;
  }

  .history-entry.active .history-entry-preview {
    color: var(--vscode-list-activeSelectionForeground);
    opacity: 0.8;
  }

  .history-entry-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }

  .history-entry.active .history-entry-meta {
    color: var(--vscode-list-activeSelectionForeground);
    opacity: 0.7;
  }

  .history-entry-timestamp {
    font-family: var(--vscode-editor-font-family, monospace);
  }

  .history-entry-model {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .history-entry-messages {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  /* Active Indicator */
  .history-entry-active-indicator {
    display: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--vscode-charts-green, #4caf50);
    margin-right: 8px;
    flex-shrink: 0;
    align-self: center;
  }

  .history-entry.active .history-entry-active-indicator {
    display: block;
  }

  /* Entry Menu Button */
  .history-entry-menu {
    opacity: 0;
    background: none;
    border: none;
    color: var(--vscode-foreground);
    font-size: 16px;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 4px;
    transition: opacity 0.15s ease, background 0.15s ease;
    flex-shrink: 0;
  }

  .history-entry:hover .history-entry-menu {
    opacity: 0.7;
  }

  .history-entry-menu:hover {
    opacity: 1 !important;
    background: var(--vscode-toolbar-hoverBackground);
  }

  /* Entry Dropdown Menu */
  .history-entry-dropdown {
    position: absolute;
    right: 16px;
    top: 100%;
    background: var(--vscode-menu-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, #454545));
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    z-index: 100;
    min-width: 140px;
    display: none;
  }

  .history-entry-dropdown.open {
    display: block;
  }

  .history-entry-dropdown-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    font-size: 12px;
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .history-entry-dropdown-item:hover {
    background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
  }

  .history-entry-dropdown-item.danger {
    color: var(--vscode-errorForeground, #f44336);
  }

  .history-entry-dropdown-divider {
    height: 1px;
    background: var(--vscode-menu-separatorBackground, var(--vscode-widget-border, #454545));
    margin: 4px 0;
  }

  /* Export Format Submenu */
  .export-submenu {
    padding-left: 20px;
    background: var(--vscode-menu-background);
  }

  .export-submenu .history-entry-dropdown-item {
    font-size: 11px;
    padding: 6px 12px;
  }

  /* Modal Footer */
  .history-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-top: 1px solid var(--vscode-widget-border, #454545);
    gap: 12px;
  }

  .history-footer-left {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .history-footer-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .history-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.15s ease, opacity 0.15s ease;
  }

  .history-btn-primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }

  .history-btn-primary:hover {
    background: var(--vscode-button-hoverBackground);
  }

  .history-btn-secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }

  .history-btn-secondary:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .history-btn-danger {
    background: transparent;
    color: var(--vscode-errorForeground, #f44336);
    border-color: var(--vscode-errorForeground, #f44336);
  }

  .history-btn-danger:hover {
    background: var(--vscode-errorForeground, #f44336);
    color: white;
  }

  /* Export Dropdown */
  .export-dropdown-container {
    position: relative;
  }

  .export-dropdown {
    position: absolute;
    bottom: 100%;
    left: 0;
    margin-bottom: 4px;
    background: var(--vscode-menu-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, #454545));
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    min-width: 160px;
    display: none;
  }

  .export-dropdown.open {
    display: block;
  }

  .export-dropdown-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    font-size: 12px;
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .export-dropdown-item:hover {
    background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
  }

  /* Session count */
  .history-count {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }

  /* Scrollbar */
  .history-list::-webkit-scrollbar {
    width: 8px;
  }

  .history-list::-webkit-scrollbar-track {
    background: transparent;
  }

  .history-list::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background);
    border-radius: 4px;
  }

  .history-list::-webkit-scrollbar-thumb:hover {
    background: var(--vscode-scrollbarSlider-hoverBackground);
  }

  /* Rename Input */
  .history-entry-rename-input {
    width: 100%;
    padding: 4px 8px;
    border: 1px solid var(--vscode-focusBorder);
    border-radius: 2px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font-size: 13px;
    outline: none;
  }
`;
