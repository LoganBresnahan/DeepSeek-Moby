/**
 * Shell actor styles
 * CSS for shell command dropdowns and output display
 */
export const shellStyles = `
/* Shell Segment Wrapper (outer container from InterleavedContentActor) */
.shell-segment {
  position: relative;
  z-index: 1;  /* Ensure shell appears above animation effects like printing-surface */
}

/* Shell Commands Container - extends tool-calls-container */
.shell-container {
  margin: 8px 0;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  overflow: hidden;
  background: var(--vscode-editor-background);
}

.shell-container.entering {
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

/* Shell Header */
.shell-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--vscode-editorWidget-background);
  cursor: pointer;
  user-select: none;
  transition: background 0.15s ease;
}

.shell-header:hover {
  background: var(--vscode-list-hoverBackground);
}

.shell-icon {
  font-size: 10px;
  color: var(--vscode-foreground);
  transition: transform 0.2s ease;
}

.shell-container.expanded .shell-icon {
  transform: rotate(90deg);
}

.shell-title {
  flex: 1;
  font-size: 12px;
  color: var(--vscode-foreground);
}

.shell-summary {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

/* Shell Body */
.shell-body {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.3s ease, padding 0.3s ease;
}

.shell-container.expanded .shell-body {
  max-height: 500px;
  padding: 8px 12px;
  overflow-y: auto;
}

/* Shell Command Item */
.shell-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 0;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.shell-item:last-child {
  border-bottom: none;
}

.shell-item-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.shell-status {
  width: 16px;
  text-align: center;
  flex-shrink: 0;
}

.shell-status.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.shell-item[data-status="pending"] .shell-status {
  color: var(--vscode-descriptionForeground);
}

.shell-item[data-status="running"] .shell-status {
  color: var(--vscode-terminal-ansiYellow);
}

.shell-item[data-status="done"] .shell-status {
  color: var(--vscode-terminal-ansiGreen);
}

.shell-item[data-status="error"] .shell-status {
  color: var(--vscode-errorForeground);
}

.shell-command {
  font-family: var(--vscode-editor-font-family);
  font-size: 12px;
  color: var(--vscode-terminal-ansiYellow);
}

.shell-command::before {
  content: '$ ';
  color: var(--vscode-descriptionForeground);
}

/* Shell Output */
.shell-output {
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

.shell-output:empty {
  display: none;
}

/* Complete state */
.shell-container.complete .shell-header {
  opacity: 0.7;
}

.shell-container.complete .shell-header:hover {
  opacity: 1;
}

/* Error state */
.shell-container.has-errors .shell-title {
  color: var(--vscode-errorForeground);
}
`;
