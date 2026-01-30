/**
 * Pending changes actor styles
 * CSS for modified files dropdown display
 */
export const pendingStyles = `
/* Pending Changes Container */
.pending-container {
  margin: 8px 0;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  overflow: hidden;
  background: var(--vscode-editor-background);
}

.pending-container.entering {
  animation: pendingSlideIn 0.2s ease-out;
}

@keyframes pendingSlideIn {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Pending Header */
.pending-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--vscode-editorWidget-background);
  cursor: pointer;
  user-select: none;
  transition: background 0.15s ease;
}

.pending-header:hover {
  background: var(--vscode-list-hoverBackground);
}

.pending-icon {
  font-size: 10px;
  color: var(--vscode-foreground);
  transition: transform 0.2s ease;
}

.pending-container.expanded .pending-icon {
  transform: rotate(90deg);
}

.pending-title {
  flex: 1;
  font-size: 12px;
  font-weight: 500;
  color: var(--vscode-foreground);
}

.pending-count {
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  padding: 2px 6px;
  border-radius: 10px;
  font-size: 10px;
  font-weight: 500;
}

/* Pending Body */
.pending-body {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.3s ease, padding 0.3s ease;
}

.pending-container.expanded .pending-body {
  max-height: 500px;
  padding: 8px 12px;
  overflow-y: auto;
}

/* Pending Item */
.pending-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.pending-item:last-child {
  border-bottom: none;
}

.pending-status {
  width: 16px;
  text-align: center;
  flex-shrink: 0;
}

.pending-status.pending {
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.pending-status.applied {
  color: var(--vscode-terminal-ansiGreen);
}

.pending-status.rejected {
  color: var(--vscode-errorForeground, #f48771);
}

.pending-status.superseded {
  color: var(--vscode-textLink-foreground, #3794ff);
}

/* File name */
.pending-file {
  flex: 1;
  font-family: var(--vscode-editor-font-family);
  font-size: 12px;
  color: var(--vscode-textLink-foreground);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pending-file:hover {
  text-decoration: underline;
}

.pending-file.no-click {
  cursor: default;
  color: var(--vscode-descriptionForeground);
}

.pending-file.no-click:hover {
  text-decoration: none;
}

/* Actions */
.pending-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.pending-btn {
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

.pending-btn.accept-btn {
  background: var(--vscode-terminal-ansiGreen, #4ec9b0);
  color: var(--vscode-editor-background);
}

.pending-btn.accept-btn:hover {
  background: var(--vscode-terminal-ansiBrightGreen, #5fd7af);
}

.pending-btn.reject-btn {
  background: var(--vscode-errorForeground, #f48771);
  color: var(--vscode-editor-background);
}

.pending-btn.reject-btn:hover {
  filter: brightness(1.15);
}

/* Status labels */
.pending-label {
  font-size: 10px;
  font-weight: 500;
  padding: 2px 6px;
  border-radius: 4px;
}

.pending-label.applied {
  background: var(--vscode-terminal-ansiGreen);
  color: var(--vscode-editor-background);
}

.pending-label.rejected {
  background: var(--vscode-errorForeground, #f48771);
  color: var(--vscode-editor-background);
}

.pending-label.superseded {
  background: var(--vscode-textLink-foreground, #3794ff);
  color: var(--vscode-editor-background);
}

.pending-label.auto {
  background: var(--vscode-terminal-ansiGreen);
  color: var(--vscode-editor-background);
}

/* Auto mode styling */
.pending-container.auto-mode .pending-item {
  padding: 4px 0;
}

/* Superseded items */
.pending-item[data-superseded="true"] {
  opacity: 0.8;
}
`;
