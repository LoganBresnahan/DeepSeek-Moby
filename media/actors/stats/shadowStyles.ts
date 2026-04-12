/**
 * StatsModalActor styles
 */
export const statsShadowStyles = `
  .stats-container {
    padding: 16px;
  }

  .stats-section {
    margin-bottom: 24px;
  }

  .stats-section-title {
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .stats-section-icon {
    font-size: 16px;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 12px;
  }

  .stats-card {
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    padding: 14px;
    text-align: center;
  }

  .stats-card-value {
    font-size: 24px;
    font-weight: 700;
    color: var(--vscode-foreground);
    margin-bottom: 4px;
  }

  .stats-card-value.balance {
    color: var(--vscode-terminal-ansiGreen, #89d185);
  }

  .stats-card-value.warning {
    color: var(--vscode-terminal-ansiYellow, #cca700);
  }

  .stats-card-value.error {
    color: var(--vscode-errorForeground, #f48771);
  }

  .stats-card-label {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }

  .stats-loading {
    text-align: center;
    padding: 32px;
    color: var(--vscode-descriptionForeground);
  }

  .stats-error {
    text-align: center;
    padding: 16px;
    color: var(--vscode-errorForeground);
    font-size: 12px;
  }

  .stats-divider {
    height: 1px;
    background: var(--vscode-panel-border);
    margin: 16px 0;
  }

  .stats-note {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    text-align: center;
    margin-top: 8px;
  }
`;
