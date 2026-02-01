/**
 * DiffShadowActor styles
 * Simplified CSS for Shadow DOM encapsulation (no prefixes needed)
 */
export const diffShadowStyles = `
/* Container */
.container {
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  margin: 8px 0;
  overflow: hidden;
  font-family: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
  font-size: var(--vscode-editor-font-size, 13px);
}

/* Header */
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--vscode-editorGroupHeader-tabsBackground);
  border-bottom: 1px solid var(--vscode-panel-border);
}

.title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
  color: var(--vscode-foreground);
}

.icon {
  opacity: 0.8;
}

.filename {
  font-family: var(--vscode-editor-font-family);
}

.actions {
  display: flex;
  gap: 6px;
}

.btn {
  padding: 4px 12px;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  transition: background 0.15s, opacity 0.15s;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.apply-btn {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.apply-btn:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
}

.reject-btn {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}

.reject-btn:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground);
}

.close-btn {
  background: transparent;
  color: var(--vscode-foreground);
  padding: 4px 8px;
}

.close-btn:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

/* Content area */
.content {
  overflow-x: auto;
  max-height: 400px;
  overflow-y: auto;
}

/* Table layout */
table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

/* Line number columns */
.line-num {
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

.line-num-old {
  border-right: none;
}

.line-num-new {
  border-right: 1px solid var(--vscode-panel-border);
}

/* Line content */
.line-content {
  padding: 0 8px;
  white-space: pre;
  vertical-align: top;
}

/* Line types */
.line {
  line-height: 1.5;
}

.line-added {
  background: var(--vscode-diffEditor-insertedLineBackground, rgba(155, 185, 85, 0.2));
}

.line-added .line-content {
  background: var(--vscode-diffEditor-insertedTextBackground, rgba(155, 185, 85, 0.3));
}

.line-added .line-num {
  background: var(--vscode-diffEditorGutter-insertedLineBackground, rgba(155, 185, 85, 0.2));
  color: var(--vscode-diffEditor-insertedTextForeground, inherit);
}

.line-removed {
  background: var(--vscode-diffEditor-removedLineBackground, rgba(255, 0, 0, 0.2));
}

.line-removed .line-content {
  background: var(--vscode-diffEditor-removedTextBackground, rgba(255, 0, 0, 0.3));
}

.line-removed .line-num {
  background: var(--vscode-diffEditorGutter-removedLineBackground, rgba(255, 0, 0, 0.2));
  color: var(--vscode-diffEditor-removedTextForeground, inherit);
}

.line-unchanged {
  background: var(--vscode-editor-background);
}

/* Hunk separator */
.hunk-separator {
  padding: 4px 8px;
  background: var(--vscode-editorGutter-background);
  color: var(--vscode-descriptionForeground);
  font-style: italic;
  text-align: center;
  border-top: 1px solid var(--vscode-panel-border);
  border-bottom: 1px solid var(--vscode-panel-border);
}

/* Stats summary */
.stats {
  display: flex;
  gap: 12px;
  padding: 8px 12px;
  background: var(--vscode-editorGutter-background);
  border-top: 1px solid var(--vscode-panel-border);
  font-size: 12px;
}

.stat-added {
  color: var(--vscode-gitDecoration-addedResourceForeground, #73c991);
}

.stat-removed {
  color: var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c);
}

/* Empty state */
.empty {
  padding: 24px;
  text-align: center;
  color: var(--vscode-descriptionForeground);
}

/* Loading state */
.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  gap: 8px;
  color: var(--vscode-descriptionForeground);
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid transparent;
  border-top-color: var(--vscode-progressBar-background);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
`;
