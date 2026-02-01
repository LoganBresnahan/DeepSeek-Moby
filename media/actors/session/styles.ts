/**
 * SessionActor CSS styles
 * Exported as a string for reliable importing across environments
 */

export const sessionStyles = `
/**
 * Session-related styles
 * Loading states and session info display
 */

.session-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  text-align: center;
  color: var(--vscode-descriptionForeground, #8b8b8b);
}

.session-loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--vscode-progressBar-background, #0e70c0);
  border-top-color: transparent;
  border-radius: 50%;
  animation: session-spin 0.8s linear infinite;
  margin-bottom: 12px;
}

@keyframes session-spin {
  to {
    transform: rotate(360deg);
  }
}

.session-loading-text {
  font-size: 13px;
}

.session-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 20px;
  text-align: center;
  color: var(--vscode-errorForeground, #f48771);
  background: var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.1));
  border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
  border-radius: 4px;
  margin: 12px;
}

.session-error-icon {
  font-size: 24px;
  margin-bottom: 8px;
}

.session-error-message {
  font-size: 13px;
  margin-bottom: 12px;
}

.session-error-retry {
  padding: 6px 12px;
  font-size: 12px;
  color: var(--vscode-button-foreground, #ffffff);
  background: var(--vscode-button-background, #0e639c);
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.session-error-retry:hover {
  background: var(--vscode-button-hoverBackground, #1177bb);
}

/* Session info badge */
.session-info {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground, #8b8b8b);
  background: var(--vscode-badge-background, #4d4d4d);
  border-radius: 4px;
}

.session-info-model {
  font-weight: 600;
}
`;
