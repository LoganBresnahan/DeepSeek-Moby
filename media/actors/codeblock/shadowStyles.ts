/**
 * CodeBlockShadowActor styles
 * Simplified CSS for Shadow DOM encapsulation (no prefixes needed)
 */
export const codeBlockShadowStyles = `
/* Container (inside shadow root) */
.container {
  border-radius: 6px;
  overflow: hidden;
  background: var(--vscode-textCodeBlock-background);
}

.container.collapsed .content {
  max-height: 50px;
}

.container.diffed {
  border: 1px solid var(--vscode-terminal-ansiGreen);
}

.container.tool-output {
  opacity: 0.6;
}

.container.tool-output .header {
  background: transparent;
}

/* Header */
.header {
  display: flex;
  align-items: center;
  padding: 6px 12px;
  background: var(--vscode-editorWidget-background);
  border-bottom: 1px solid var(--vscode-panel-border);
}

.lang {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  text-transform: uppercase;
  flex: 1;
}

.label {
  font-size: 10px;
  color: var(--vscode-terminal-ansiGreen);
  margin-left: 8px;
}

/* Actions */
.actions {
  display: flex;
  gap: 4px;
}

.btn {
  padding: 2px 8px;
  border: none;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border-radius: 3px;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.btn:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.btn.copy-btn.copied {
  background: var(--vscode-terminal-ansiGreen);
  color: var(--vscode-editor-background);
}

.btn.diff-btn.active {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.btn.apply-btn {
  opacity: 0.5;
  pointer-events: none;
}

.container.diffed .btn.apply-btn {
  opacity: 1;
  pointer-events: auto;
}

.btn.collapse-btn {
  padding: 2px 6px;
  min-width: 20px;
}

/* Content */
.content {
  position: relative;
  max-height: 2000px;
  overflow: hidden;
  transition: max-height 0.3s ease-out;
}

.container.collapsed .content {
  max-height: 50px;
  transition: max-height 0.2s ease-in;
}

.content pre {
  margin: 0;
  padding: 12px;
  overflow-x: auto;
}

.content code {
  font-family: var(--vscode-editor-font-family, 'Consolas', 'Monaco', monospace);
  font-size: var(--vscode-editor-font-size, 13px);
  line-height: 1.5;
  white-space: pre;
  color: var(--vscode-editor-foreground, #d4d4d4);
}

/* Fade overlay for collapsed state */
.content::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 30px;
  background: linear-gradient(transparent, var(--vscode-textCodeBlock-background));
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease;
}

.container.collapsed .content::after {
  opacity: 1;
}

/* Syntax highlighting tokens (with fallback colors for VSCode webview) */
.token.comment { color: var(--vscode-editorLineNumber-foreground, #6a9955); font-style: italic; }
.token.string { color: var(--vscode-terminal-ansiGreen, #4ec9b0); }
.token.number { color: var(--vscode-terminal-ansiYellow, #b5cea8); }
.token.keyword { color: var(--vscode-terminal-ansiMagenta, #c586c0); }
.token.builtin { color: var(--vscode-terminal-ansiCyan, #4fc1ff); }
.token.function { color: var(--vscode-terminal-ansiBlue, #dcdcaa); }
.token.operator { color: var(--vscode-editor-foreground, #d4d4d4); }
.token.punctuation { color: var(--vscode-editor-foreground, #d4d4d4); }
`;
