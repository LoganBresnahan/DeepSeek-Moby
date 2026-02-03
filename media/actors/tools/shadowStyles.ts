/**
 * Tool Calls Shadow Actor styles
 * Clean dotted border design - no ASCII art
 */
export const toolsShadowStyles = `
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

/* Emoji icon */
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

/* Individual tool item */
.item {
  padding: 4px 0;
  display: flex;
  align-items: flex-start;
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

.status.spinning {
  animation: spin 1s linear infinite;
  display: inline-block;
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

/* Tool name */
.name {
  color: var(--vscode-foreground);
  font-weight: 500;
  flex-shrink: 0;
}

/* Tool detail */
.detail {
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
}

/* Complete state - slightly muted */
.container.complete {
  opacity: 0.85;
}

.container.complete:hover {
  opacity: 1;
}

/* Error state */
.container.has-errors .title {
  color: var(--vscode-errorForeground);
}
`;
