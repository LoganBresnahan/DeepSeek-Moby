/**
 * Pending Changes Shadow Actor styles
 * Simplified CSS for Shadow DOM encapsulation - no prefixes needed
 */
export const pendingShadowStyles = `
/* Container - applied to shadow content root */
.container {
  margin: 8px 0;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  overflow: hidden;
  background: var(--vscode-editor-background);
}

.container.entering {
  animation: slideIn 0.2s ease-out;
}

@keyframes slideIn {
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
  font-weight: 500;
  color: var(--vscode-foreground);
}

.count {
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  padding: 2px 6px;
  border-radius: 10px;
  font-size: 10px;
  font-weight: 500;
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

/* Item */
.item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.item:last-child {
  border-bottom: none;
}

.status {
  width: 16px;
  text-align: center;
  flex-shrink: 0;
}

.status.pending {
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.status.applied {
  color: var(--vscode-terminal-ansiGreen);
}

.status.rejected {
  color: var(--vscode-errorForeground, #f48771);
}

.status.superseded {
  color: var(--vscode-textLink-foreground, #3794ff);
}

/* File name */
.file {
  flex: 1;
  font-family: var(--vscode-editor-font-family);
  font-size: 12px;
  color: var(--vscode-textLink-foreground);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file:hover {
  text-decoration: underline;
}

.file.no-click {
  cursor: default;
  color: var(--vscode-descriptionForeground);
}

.file.no-click:hover {
  text-decoration: none;
}

/* Actions */
.actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.btn {
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  transition: filter 0.15s ease;
}

.btn.accept-btn {
  background: var(--vscode-terminal-ansiGreen, #4ec9b0);
  color: var(--vscode-editor-background);
}

.btn.accept-btn:hover {
  background: var(--vscode-terminal-ansiBrightGreen, #5fd7af);
}

.btn.reject-btn {
  background: var(--vscode-errorForeground, #f48771);
  color: var(--vscode-editor-background);
}

.btn.reject-btn:hover {
  filter: brightness(1.15);
}

/* Status labels */
.label {
  font-size: 10px;
  font-weight: 500;
  padding: 2px 6px;
  border-radius: 4px;
}

.label.applied {
  background: var(--vscode-terminal-ansiGreen);
  color: var(--vscode-editor-background);
}

.label.rejected {
  background: var(--vscode-errorForeground, #f48771);
  color: var(--vscode-editor-background);
}

.label.superseded {
  background: var(--vscode-textLink-foreground, #3794ff);
  color: var(--vscode-editor-background);
}

.label.auto {
  background: var(--vscode-terminal-ansiGreen);
  color: var(--vscode-editor-background);
}

/* Auto mode styling */
.container.auto-mode .item {
  padding: 4px 0;
}

/* Superseded items */
.item[data-superseded="true"] {
  opacity: 0.6;
}

.item[data-superseded="true"] .file {
  text-decoration: line-through;
  color: var(--vscode-descriptionForeground);
}

.item[data-superseded="true"] .status {
  color: var(--vscode-descriptionForeground);
}
`;
