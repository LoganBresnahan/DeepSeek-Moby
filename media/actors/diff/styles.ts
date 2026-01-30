/**
 * DiffActor styles - visual diff rendering
 */
export const diffStyles = `
/* Diff container */
.diff-container {
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  margin: 8px 0;
  overflow: hidden;
  font-family: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
  font-size: var(--vscode-editor-font-size, 13px);
}

/* Diff header */
.diff-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--vscode-editorGroupHeader-tabsBackground);
  border-bottom: 1px solid var(--vscode-panel-border);
}

.diff-header-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
  color: var(--vscode-foreground);
}

.diff-header-icon {
  opacity: 0.8;
}

.diff-header-filename {
  font-family: var(--vscode-editor-font-family);
}

.diff-header-actions {
  display: flex;
  gap: 6px;
}

.diff-action-btn {
  padding: 4px 12px;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  transition: background 0.15s, opacity 0.15s;
}

.diff-action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.diff-apply-btn {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.diff-apply-btn:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
}

.diff-reject-btn {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}

.diff-reject-btn:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground);
}

.diff-close-btn {
  background: transparent;
  color: var(--vscode-foreground);
  padding: 4px 8px;
}

.diff-close-btn:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

/* Diff content area */
.diff-content {
  overflow-x: auto;
  max-height: 400px;
  overflow-y: auto;
}

/* Diff table layout */
.diff-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

/* Line number columns */
.diff-line-num {
  width: 48px;
  min-width: 48px;
  padding: 0 8px;
  text-align: right;
  color: var(--vscode-editorLineNumber-foreground);
  background: var(--vscode-editorGutter-background);
  user-select: none;
  vertical-align: top;
  border-right: 1px solid var(--vscode-panel-border);
}

.diff-line-num-old {
  border-right: none;
}

.diff-line-num-new {
  border-right: 1px solid var(--vscode-panel-border);
}

/* Line content */
.diff-line-content {
  padding: 0 8px;
  white-space: pre;
  vertical-align: top;
}

/* Line types */
.diff-line {
  line-height: 1.5;
}

.diff-line-added {
  background: var(--vscode-diffEditor-insertedLineBackground, rgba(155, 185, 85, 0.2));
}

.diff-line-added .diff-line-content {
  background: var(--vscode-diffEditor-insertedTextBackground, rgba(155, 185, 85, 0.3));
}

.diff-line-added .diff-line-num {
  background: var(--vscode-diffEditorGutter-insertedLineBackground, rgba(155, 185, 85, 0.2));
  color: var(--vscode-diffEditor-insertedTextForeground, inherit);
}

.diff-line-removed {
  background: var(--vscode-diffEditor-removedLineBackground, rgba(255, 0, 0, 0.2));
}

.diff-line-removed .diff-line-content {
  background: var(--vscode-diffEditor-removedTextBackground, rgba(255, 0, 0, 0.3));
}

.diff-line-removed .diff-line-num {
  background: var(--vscode-diffEditorGutter-removedLineBackground, rgba(255, 0, 0, 0.2));
  color: var(--vscode-diffEditor-removedTextForeground, inherit);
}

.diff-line-unchanged {
  background: var(--vscode-editor-background);
}

/* Hunk separator */
.diff-hunk-separator {
  padding: 4px 8px;
  background: var(--vscode-editorGutter-background);
  color: var(--vscode-descriptionForeground);
  font-style: italic;
  text-align: center;
  border-top: 1px solid var(--vscode-panel-border);
  border-bottom: 1px solid var(--vscode-panel-border);
}

/* Stats summary */
.diff-stats {
  display: flex;
  gap: 12px;
  padding: 8px 12px;
  background: var(--vscode-editorGutter-background);
  border-top: 1px solid var(--vscode-panel-border);
  font-size: 12px;
}

.diff-stat-added {
  color: var(--vscode-gitDecoration-addedResourceForeground, #73c991);
}

.diff-stat-removed {
  color: var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c);
}

/* Empty state */
.diff-empty {
  padding: 24px;
  text-align: center;
  color: var(--vscode-descriptionForeground);
}

/* Side by side mode */
.diff-container.side-by-side .diff-table {
  display: flex;
}

.diff-container.side-by-side .diff-side {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
}

.diff-container.side-by-side .diff-side-old {
  border-right: 1px solid var(--vscode-panel-border);
}

/* Inline word diff highlighting */
.diff-word-added {
  background: var(--vscode-diffEditor-insertedTextBackground, rgba(155, 185, 85, 0.5));
  padding: 1px 0;
}

.diff-word-removed {
  background: var(--vscode-diffEditor-removedTextBackground, rgba(255, 0, 0, 0.5));
  padding: 1px 0;
  text-decoration: line-through;
}

/* Loading state */
.diff-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  gap: 8px;
  color: var(--vscode-descriptionForeground);
}

.diff-loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid transparent;
  border-top-color: var(--vscode-progressBar-background);
  border-radius: 50%;
  animation: diff-spin 0.8s linear infinite;
}

@keyframes diff-spin {
  to { transform: rotate(360deg); }
}
`;

export default diffStyles;
