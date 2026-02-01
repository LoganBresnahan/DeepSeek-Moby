/**
 * Shell Shadow Actor styles
 * Simplified CSS for Shadow DOM encapsulation - no prefixes needed
 */
export const shellShadowStyles = `
/* Container - applied to shadow content root */
.container {
  margin: 8px 0;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  overflow: hidden;
  background: var(--vscode-editor-background);
}

.container.entering {
  animation: slideDown 0.2s ease-out forwards;
}

@keyframes slideDown {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Header */
.header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--vscode-editorWidget-background);
  cursor: pointer;
  user-select: none;
  transition: background 0.15s ease;
}

.header:hover {
  background: var(--vscode-list-hoverBackground);
}

.icon {
  font-size: 10px;
  color: var(--vscode-foreground);
  transition: transform 0.2s ease;
}

.container.expanded .icon {
  transform: rotate(90deg);
}

.title {
  flex: 1;
  font-size: 12px;
  color: var(--vscode-foreground);
}

.summary {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

/* Body */
.body {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.3s ease, padding 0.3s ease;
}

.container.expanded .body {
  max-height: 500px;
  padding: 8px 12px;
  overflow-y: auto;
}

/* Command Item */
.item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 0;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.item:last-child {
  border-bottom: none;
}

.item-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status {
  width: 16px;
  text-align: center;
  flex-shrink: 0;
}

.status.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.item[data-status="pending"] .status {
  color: var(--vscode-descriptionForeground);
}

.item[data-status="running"] .status {
  color: var(--vscode-terminal-ansiYellow);
}

.item[data-status="done"] .status {
  color: var(--vscode-terminal-ansiGreen);
}

.item[data-status="error"] .status {
  color: var(--vscode-errorForeground);
}

.command {
  font-family: var(--vscode-editor-font-family);
  font-size: 12px;
  color: var(--vscode-terminal-ansiYellow);
}

.command::before {
  content: '$ ';
  color: var(--vscode-descriptionForeground);
}

/* Output */
.output {
  font-family: var(--vscode-editor-font-family);
  font-size: 11px;
  color: var(--vscode-terminal-foreground);
  background: var(--vscode-terminal-background);
  padding: 8px;
  border-radius: 4px;
  margin-top: 4px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow-y: auto;
}

.output:empty {
  display: none;
}

/* Complete state */
.container.complete .header {
  opacity: 0.7;
}

.container.complete .header:hover {
  opacity: 1;
}

/* Error state */
.container.has-errors .title {
  color: var(--vscode-errorForeground);
}
`;
