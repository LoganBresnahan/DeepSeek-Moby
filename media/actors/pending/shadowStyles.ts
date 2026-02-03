/**
 * Pending Changes Shadow Actor styles
 * Clean dotted border design - no ASCII art
 */
export const pendingShadowStyles = `
/* Container - dotted border, no background */
.container {
  margin: 8px 0;
  border: 1px dotted var(--vscode-panel-border);
  border-radius: 4px;
  font-family: var(--vscode-font-family);
  font-size: 13px;
  line-height: 1.4;
  cursor: pointer;
  user-select: none;
}

.container.entering {
  animation: fadeIn 0.5s ease-out forwards;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* Header row */
.header {
  display: flex;
  align-items: center;
  padding: 6px 10px;
  gap: 8px;
}

.container:hover .header {
  background: var(--vscode-list-hoverBackground);
}

/* +/- toggle icon */
.toggle {
  color: var(--vscode-descriptionForeground);
  font-family: monospace;
  font-weight: bold;
  width: 12px;
  flex-shrink: 0;
}

/* Emoji/status icon */
.icon {
  flex-shrink: 0;
}

/* Title text */
.title {
  color: var(--vscode-foreground);
  font-weight: 500;
}

/* Preview text (collapsed state) */
.preview {
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  font-size: 12px;
}

/* Count badge */
.count {
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  flex-shrink: 0;
}

/* Body - hidden when collapsed */
.body {
  display: none;
  padding: 8px 10px;
  border-top: 1px dotted var(--vscode-panel-border);
}

/* Expanded state - show body */
.container.expanded .body {
  display: block;
}

/* Empty body - hide completely */
.body:empty {
  display: none;
}

/* File item */
.item {
  padding: 4px 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

/* Tree branch characters */
.tree {
  color: var(--vscode-panel-border);
  font-family: monospace;
  flex-shrink: 0;
}

/* Status icon */
.status {
  flex-shrink: 0;
  width: 14px;
  text-align: center;
}

.status.pending {
  color: var(--vscode-terminal-ansiYellow);
}

.status.applied {
  color: var(--vscode-terminal-ansiGreen);
}

.status.rejected {
  color: var(--vscode-errorForeground);
}

.status.superseded {
  color: var(--vscode-descriptionForeground);
}

/* File name */
.file {
  color: var(--vscode-textLink-foreground);
  cursor: pointer;
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
  gap: 8px;
  margin-left: auto;
}

.btn {
  padding: 2px 6px;
  border: none;
  background: none;
  cursor: pointer;
  font-family: inherit;
  font-size: 12px;
  border-radius: 3px;
}

.btn.accept-btn {
  color: var(--vscode-terminal-ansiGreen);
}

.btn.accept-btn:hover {
  background: var(--vscode-list-hoverBackground);
}

.btn.reject-btn {
  color: var(--vscode-errorForeground);
}

.btn.reject-btn:hover {
  background: var(--vscode-list-hoverBackground);
}

/* Status labels */
.label {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  margin-left: auto;
}

/* Superseded items */
.item[data-superseded="true"] {
  opacity: 0.6;
}

.item[data-superseded="true"] .file {
  text-decoration: line-through;
  color: var(--vscode-descriptionForeground);
}

/* Auto mode styling */
.container.auto-mode .item {
  padding: 4px 0;
}
`;
