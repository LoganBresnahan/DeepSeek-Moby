/**
 * InputAreaShadowActor styles
 * Styles for textarea and attachments (buttons are in Toolbar)
 */
export const inputAreaShadowStyles = `
/* Main container */
.input-area {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

/* Textarea */
textarea {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--vscode-input-border);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border-radius: 4px;
  font-family: var(--vscode-font-family);
  font-size: 13px;
  resize: none;
  min-height: 68px;
  max-height: 200px;
  line-height: 1.4;
  box-sizing: border-box;
}

textarea:focus {
  outline: none;
  border-color: var(--vscode-focusBorder);
}

textarea::placeholder {
  color: var(--vscode-input-placeholderForeground);
}

/* Attachments */
.attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.attachments:empty {
  display: none;
}

.attachment {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 4px;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-panel-border);
  max-width: 200px;
}

.attachment .icon {
  font-size: 14px;
  flex-shrink: 0;
}

.attachment .name {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.attachment .size {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  flex-shrink: 0;
}

.attachment .remove {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  border: none;
  border-radius: 50%;
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
}

.attachment .remove:hover {
  background: var(--vscode-toolbar-hoverBackground);
  color: var(--vscode-foreground);
}

/* File chips */
.file-chips-container {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 8px;
  background: var(--vscode-input-background);
  border-radius: 4px;
}

.file-chips-container:empty,
.file-chips-container.hidden {
  display: none;
}

.file-chips-label {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  font-weight: 600;
  margin-right: 4px;
}

.file-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-radius: 12px;
  font-size: 11px;
  font-family: var(--vscode-editor-font-family);
  max-width: 200px;
}

.file-chip-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-chip-remove {
  background: transparent;
  border: none;
  color: currentColor;
  cursor: pointer;
  padding: 0;
  font-size: 12px;
  line-height: 1;
  opacity: 0.7;
  display: flex;
  align-items: center;
}

.file-chip-remove:hover {
  opacity: 1;
}

/* Hidden file input */
.hidden-input {
  display: none;
}
`;
