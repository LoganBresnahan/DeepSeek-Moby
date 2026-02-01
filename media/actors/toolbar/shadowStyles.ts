/**
 * ToolbarShadowActor styles
 * 3x2 grid with all action buttons
 * Note: Modal styles are in global CSS since modals render to document.body
 */
export const toolbarShadowStyles = `
/* Container - 3x2 grid for 6 buttons */
.toolbar {
  display: grid;
  grid-template-columns: repeat(2, 32px);
  grid-template-rows: repeat(3, 32px);
  gap: 4px;
  flex-shrink: 0;
}

/* Base button */
.btn {
  width: 32px;
  height: 32px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--vscode-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.7;
  transition: all 0.15s;
}

.btn:hover {
  opacity: 1;
  background: var(--vscode-toolbar-hoverBackground);
}

.btn svg {
  width: 16px;
  height: 16px;
}

/* Files button */
.btn.files-btn {
  position: relative;
}

.btn.files-btn.active {
  opacity: 1;
  background: var(--vscode-terminal-ansiGreen, #4ec9b0);
  color: var(--vscode-editor-background);
  border-color: var(--vscode-terminal-ansiGreen, #4ec9b0);
}

.btn.files-btn.active:hover {
  background: var(--vscode-terminal-ansiBrightGreen, #5fd7af);
}

/* Edit mode button */
.btn.edit-mode-btn {
  font-weight: bold;
  font-size: 10px;
}

.btn.edit-mode-btn.state-ask {
  /* Ask mode (Q) - green like web search active */
  background: var(--vscode-terminal-ansiGreen, #4ec9b0);
  color: var(--vscode-editor-background);
  border-color: var(--vscode-terminal-ansiGreen, #4ec9b0);
  opacity: 1;
}

.btn.edit-mode-btn.state-ask:hover {
  background: var(--vscode-terminal-ansiBrightGreen, #5fd7af);
}

.btn.edit-mode-btn.state-auto {
  /* Auto mode (A) - blue */
  background: var(--vscode-terminal-ansiBlue, #3b8eea);
  color: var(--vscode-editor-background);
  border-color: var(--vscode-terminal-ansiBlue, #3b8eea);
  opacity: 1;
}

.btn.edit-mode-btn.state-auto:hover {
  background: var(--vscode-terminal-ansiBrightBlue, #5ca8ff);
}

/* Help button */
.btn.help-btn {
  /* default styling */
}

/* Search button */
.btn.search-btn.active {
  opacity: 1;
  background: var(--vscode-terminal-ansiGreen, #4ec9b0);
  color: var(--vscode-editor-background);
  border-color: var(--vscode-terminal-ansiGreen, #4ec9b0);
}

.btn.search-btn.active:hover {
  background: var(--vscode-terminal-ansiBrightGreen, #5fd7af);
}

/* Attach button */
.btn.attach-btn {
  opacity: 0.7;
}

.btn.attach-btn:hover {
  opacity: 1;
}

/* Send button */
.btn.send-btn {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  opacity: 1;
}

.btn.send-btn:hover {
  background: var(--vscode-button-hoverBackground);
}

.btn.send-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Stop button */
.btn.stop-btn {
  background: var(--vscode-errorForeground, #f48771);
  color: var(--vscode-editor-background);
  border: none;
  opacity: 1;
}

.btn.stop-btn:hover {
  filter: brightness(1.1);
}
`;
