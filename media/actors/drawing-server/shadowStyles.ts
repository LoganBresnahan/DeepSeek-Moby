/**
 * Drawing Server Popup Styles
 *
 * Styles for the drawing server dropdown in the header bar.
 * Two states: stopped (start button) and running (QR code + URL + stop button).
 */

export const drawingServerShadowStyles = `
  /* Override popup sizing */
  .popup-container {
    min-width: 240px;
    max-width: 280px;
  }

  .popup-body {
    padding: 12px;
  }

  /* ── Stopped state ── */

  .ds-description {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 12px;
    line-height: 1.4;
  }

  .ds-btn {
    width: 100%;
    padding: 8px 12px;
    border: none;
    border-radius: 4px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.15s;
  }

  .ds-btn-start {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }

  .ds-btn-start:hover {
    background: var(--vscode-button-hoverBackground);
  }

  .ds-btn-stop {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }

  .ds-btn-stop:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .ds-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ── Running state ── */

  .ds-qr-container {
    display: flex;
    justify-content: center;
    margin-bottom: 12px;
  }

  .ds-qr {
    display: grid;
    border: 4px solid #fff;
    border-radius: 4px;
    background: #fff;
  }

  .ds-qr-cell {
    width: 4px;
    height: 4px;
  }

  .ds-qr-cell.dark {
    background: #000;
  }

  .ds-url-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 12px;
    padding: 6px 8px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
    border-radius: 4px;
  }

  .ds-url-text {
    flex: 1;
    font-size: 12px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-foreground);
    word-break: break-all;
    user-select: all;
  }

  .ds-copy-btn {
    padding: 4px 8px;
    border: none;
    border-radius: 3px;
    font-size: 11px;
    cursor: pointer;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    flex-shrink: 0;
    transition: background-color 0.15s;
  }

  .ds-copy-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .ds-copy-btn.copied {
    background: var(--vscode-terminal-ansiGreen, #4ec9b0);
    color: var(--vscode-editor-background);
  }

  .ds-status {
    font-size: 11px;
    color: var(--vscode-terminal-ansiGreen, #4ec9b0);
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .ds-status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--vscode-terminal-ansiGreen, #4ec9b0);
  }
`;
