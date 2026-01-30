/**
 * Tool calls actor styles
 * CSS for tool calls dropdown display
 */
export const toolsStyles = `
/* Tool Calls Container */
.tools-container {
  margin: 8px 0;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  overflow: hidden;
  background: var(--vscode-editor-background);
}

.tools-container.entering {
  animation: toolsSlideDown 0.2s ease-out forwards;
}

@keyframes toolsSlideDown {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Tools Header */
.tools-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--vscode-editorWidget-background);
  cursor: pointer;
  user-select: none;
  transition: background 0.15s ease;
}

.tools-header:hover {
  background: var(--vscode-list-hoverBackground);
}

.tools-icon {
  font-size: 10px;
  color: var(--vscode-foreground);
  transition: transform 0.2s ease;
}

.tools-container.expanded .tools-icon {
  transform: rotate(90deg);
}

.tools-title {
  flex: 1;
  font-size: 12px;
  color: var(--vscode-foreground);
}

.tools-summary {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

/* Tools Body */
.tools-body {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.3s ease, padding 0.3s ease;
}

.tools-container.expanded .tools-body {
  max-height: 500px;
  padding: 8px 12px;
  overflow-y: auto;
}

/* Tool Item */
.tools-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.tools-item:last-child {
  border-bottom: none;
}

.tools-status {
  width: 16px;
  text-align: center;
  flex-shrink: 0;
}

.tools-status.spinning {
  animation: toolsSpin 1s linear infinite;
}

@keyframes toolsSpin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.tools-item[data-status="pending"] .tools-status {
  color: var(--vscode-descriptionForeground);
}

.tools-item[data-status="running"] .tools-status {
  color: var(--vscode-terminal-ansiYellow);
}

.tools-item[data-status="done"] .tools-status {
  color: var(--vscode-terminal-ansiGreen);
}

.tools-item[data-status="error"] .tools-status {
  color: var(--vscode-errorForeground);
}

.tools-name {
  font-weight: 500;
  color: var(--vscode-textLink-foreground);
}

.tools-detail {
  flex: 1;
  color: var(--vscode-descriptionForeground);
  word-break: break-all;
  font-size: 11px;
}

/* Complete state */
.tools-container.complete .tools-header {
  opacity: 0.7;
}

.tools-container.complete .tools-header:hover {
  opacity: 1;
}

/* Error state */
.tools-container.has-errors .tools-title {
  color: var(--vscode-errorForeground);
}
`;
