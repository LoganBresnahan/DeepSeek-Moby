/**
 * Commands Popup Styles
 *
 * Styles for the commands dropdown menu.
 * Uses VS Code theme variables for consistent theming.
 */

export const commandsShadowStyles = `
  /* Override popup width for commands */
  .popup-container {
    min-width: 220px;
    max-width: 280px;
  }

  /* Commands dropdown title */
  .commands-dropdown-title {
    padding: 10px 12px 6px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-panel-border);
  }

  /* Section title */
  .commands-section-title {
    padding: 8px 12px 4px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground);
    opacity: 0.7;
  }

  /* Command item */
  .command-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    cursor: pointer;
    transition: background-color 0.1s;
  }

  .command-item:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .command-item:active {
    background: var(--vscode-list-activeSelectionBackground);
  }

  .command-icon {
    font-size: 16px;
    width: 24px;
    text-align: center;
    flex-shrink: 0;
  }

  .command-info {
    flex: 1;
    min-width: 0;
  }

  .command-name {
    font-size: 13px;
    color: var(--vscode-foreground);
    font-weight: 500;
  }

  .command-desc {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Command shortcut (if any) */
  .command-shortcut {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    padding: 2px 6px;
    background: var(--vscode-badge-background);
    border-radius: 3px;
    opacity: 0.7;
  }
`;
