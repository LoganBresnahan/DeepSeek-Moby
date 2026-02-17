/**
 * Command Rules Modal Styles
 *
 * Styles for the command rules management modal.
 * Uses VS Code theme variables for consistent theming.
 */

export const commandRulesShadowStyles = `
  /* Rules sections */
  .rules-section {
    padding: 12px 16px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }

  .rules-section:last-child {
    border-bottom: none;
  }

  .rules-section-header {
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .rules-section-count {
    font-weight: normal;
    opacity: 0.7;
  }

  /* Rule items */
  .rule-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 8px;
    border-radius: 4px;
    transition: background-color 0.1s;
  }

  .rule-item:hover {
    background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.04));
  }

  .rule-prefix {
    flex: 1;
    font-family: var(--vscode-editor-font-family);
    font-size: 13px;
    color: var(--vscode-foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .source-badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 3px;
    flex-shrink: 0;
  }

  .source-badge.default {
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #cccccc);
  }

  .source-badge.user {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff);
  }

  .rule-delete {
    background: none;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    padding: 2px 6px;
    font-size: 14px;
    opacity: 0;
    border-radius: 3px;
    transition: opacity 0.1s, color 0.1s, background-color 0.1s;
    flex-shrink: 0;
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
    padding: 12px 8px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    font-style: italic;
  }

  /* Footer form */
  .add-rule-form {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
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

  .footer-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
  }

  .footer-spacer {
    flex-shrink: 0;
  }
`;
