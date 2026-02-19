/**
 * Command Rules Modal Styles
 *
 * Styles for the command rules management modal.
 * Uses VS Code theme variables for consistent theming.
 */

export const commandRulesShadowStyles = `
  /* Allow-all toggle bar */
  .allow-all-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }

  .allow-all-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 500;
    color: var(--vscode-foreground);
    cursor: pointer;
    user-select: none;
  }

  .allow-all-icon {
    font-size: 15px;
  }

  /* Toggle switch */
  .toggle-switch {
    position: relative;
    width: 36px;
    height: 20px;
    flex-shrink: 0;
  }

  .toggle-switch input {
    opacity: 0;
    width: 0;
    height: 0;
  }

  .toggle-slider {
    position: absolute;
    cursor: pointer;
    inset: 0;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, #3c3c3c);
    border-radius: 10px;
    transition: background 0.2s, border-color 0.2s;
  }

  .toggle-slider::before {
    content: '';
    position: absolute;
    height: 14px;
    width: 14px;
    left: 2px;
    bottom: 2px;
    background: var(--vscode-foreground);
    border-radius: 50%;
    transition: transform 0.2s;
  }

  .toggle-switch input:checked + .toggle-slider {
    background: var(--vscode-button-background);
    border-color: var(--vscode-button-background);
  }

  .toggle-switch input:checked + .toggle-slider::before {
    transform: translateX(16px);
    background: var(--vscode-button-foreground);
  }

  /* Filter chips row */
  .filter-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }

  .filter-chip {
    padding: 3px 10px;
    border-radius: 12px;
    font-size: 11px;
    cursor: pointer;
    border: 1px solid var(--vscode-widget-border, #3c3c3c);
    background: transparent;
    color: var(--vscode-descriptionForeground);
    transition: background 0.15s, color 0.15s, border-color 0.15s;
    user-select: none;
  }

  .filter-chip:hover {
    background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.04));
  }

  .filter-chip.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-background);
  }

  .filter-count {
    margin-left: 2px;
    opacity: 0.7;
  }

  /* Rules list (multi-column grid) */
  .rules-list {
    padding: 8px 12px;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 2px 12px;
  }

  /* Rule item row */
  .rule-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    border-radius: 4px;
    transition: background-color 0.1s;
    min-width: 0;
  }

  .rule-item:hover {
    background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.04));
  }

  .rule-prefix {
    flex: 1;
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
    color: var(--vscode-foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .source-badge {
    font-size: 9px;
    padding: 1px 4px;
    border-radius: 3px;
    flex-shrink: 0;
    opacity: 0.7;
  }

  .source-badge.default {
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #cccccc);
  }

  .source-badge.user {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff);
  }

  /* Checkbox (approved/blocked toggle) */
  .rule-checkbox {
    flex-shrink: 0;
    width: 14px;
    height: 14px;
    accent-color: var(--vscode-button-background, #0e639c);
    cursor: pointer;
    margin: 0;
  }

  /* Delete button */
  .rule-delete {
    background: none;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    padding: 1px 4px;
    font-size: 13px;
    opacity: 0;
    border-radius: 3px;
    transition: opacity 0.1s, color 0.1s, background-color 0.1s;
    flex-shrink: 0;
    line-height: 1;
  }

  .rule-item:hover .rule-delete {
    opacity: 0.7;
  }

  .rule-delete:hover {
    opacity: 1 !important;
    color: var(--vscode-errorForeground, #f48771);
    background: rgba(244, 135, 113, 0.1);
  }

  /* Empty state */
  .rules-empty {
    padding: 24px 16px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    font-style: italic;
    grid-column: 1 / -1;
  }

  /* Footer form */
  .footer-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
  }

  .add-rule-form {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
  }

  .add-rule-input {
    flex: 1;
    min-width: 0;
    padding: 5px 8px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, #3c3c3c));
    border-radius: 4px;
    color: var(--vscode-input-foreground);
    font-size: 12px;
    font-family: var(--vscode-editor-font-family);
    outline: none;
    transition: border-color 0.15s;
  }

  .add-rule-input:focus {
    border-color: var(--vscode-focusBorder, #007acc);
  }

  .add-rule-input::placeholder {
    color: var(--vscode-input-placeholderForeground);
  }

  .add-rule-select {
    padding: 5px 6px;
    background: var(--vscode-dropdown-background, var(--vscode-input-background));
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, #3c3c3c));
    border-radius: 4px;
    color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
    font-size: 12px;
    outline: none;
    cursor: pointer;
    flex-shrink: 0;
  }

  /* Grayed-out state when allow-all is enabled */
  .rules-disabled .filter-row,
  .rules-disabled .rules-list,
  .rules-disabled .modal-footer {
    opacity: 0.35;
    pointer-events: none;
    user-select: none;
  }

  .rules-disabled .modal-search {
    opacity: 0.35;
    pointer-events: none;
  }
`;
