/**
 * Plans Popup Styles
 *
 * Styles for the plans popup in the toolbar.
 * Shows a list of plan files with checkboxes, and controls to create/open/delete.
 */

export const plansShadowStyles = `
  /* Override popup sizing */
  .popup-container {
    min-width: 250px;
    max-width: 300px;
  }

  .popup-body {
    padding: 12px;
  }

  /* ── Description ── */

  .plans-description {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 12px;
    line-height: 1.4;
  }

  /* ── Plan list ── */

  .plans-list {
    margin-bottom: 12px;
  }

  .plans-empty {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
    padding: 8px 0;
  }

  .plan-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 4px;
    border-radius: 3px;
    transition: background-color 0.1s;
  }

  .plan-item:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .plan-checkbox {
    width: 14px;
    height: 14px;
    cursor: pointer;
    flex-shrink: 0;
    accent-color: var(--vscode-terminal-ansiMagenta, #c586c0);
  }

  .plan-name {
    flex: 1;
    font-size: 12px;
    color: var(--vscode-foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }

  .plan-name:hover {
    text-decoration: underline;
  }

  .plan-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.15s;
  }

  .plan-item:hover .plan-actions {
    opacity: 1;
  }

  .plan-action-btn {
    padding: 2px 6px;
    border: none;
    border-radius: 3px;
    font-size: 10px;
    cursor: pointer;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    transition: background-color 0.15s, color 0.15s;
  }

  .plan-action-btn:hover {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }

  .plan-action-btn.delete:hover {
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    color: var(--vscode-errorForeground, #f48771);
  }

  /* Delete confirmation */
  .plan-delete-confirm {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--vscode-errorForeground, #f48771);
  }

  .plan-delete-confirm .confirm-btn {
    padding: 2px 8px;
    border: 1px solid var(--vscode-errorForeground, #f48771);
    border-radius: 3px;
    font-size: 10px;
    cursor: pointer;
    background: transparent;
    color: var(--vscode-errorForeground, #f48771);
    transition: background-color 0.15s;
  }

  .plan-delete-confirm .confirm-btn:hover {
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
  }

  .plan-delete-confirm .cancel-btn {
    padding: 2px 8px;
    border: none;
    border-radius: 3px;
    font-size: 10px;
    cursor: pointer;
    background: transparent;
    color: var(--vscode-descriptionForeground);
  }

  /* ── Footer ── */

  .plans-footer {
    display: flex;
    gap: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
  }

  .plans-btn {
    padding: 6px 12px;
    border: none;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.15s;
  }

  .plans-btn-new {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }

  .plans-btn-new:hover {
    background: var(--vscode-button-hoverBackground);
  }

  /* New plan input row */
  .plans-new-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .plans-new-input {
    flex: 1;
    padding: 4px 8px;
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
    border-radius: 3px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font-size: 12px;
    outline: none;
  }

  .plans-new-input:focus {
    border-color: var(--vscode-focusBorder);
  }

  .plans-new-save {
    padding: 4px 10px;
    border: none;
    border-radius: 3px;
    font-size: 11px;
    cursor: pointer;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    flex-shrink: 0;
  }

  .plans-new-save:hover {
    background: var(--vscode-button-hoverBackground);
  }

  .plans-new-cancel {
    padding: 4px 8px;
    border: none;
    border-radius: 3px;
    font-size: 11px;
    cursor: pointer;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    flex-shrink: 0;
  }
`;
