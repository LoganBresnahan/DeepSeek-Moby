/**
 * Code block actor styles
 * CSS for code block display, collapse/expand, and actions
 */
export const codeBlockStyles = `
/* Code Block Container */
.codeblock-container {
  border-radius: 6px;
  overflow: hidden;
  margin: 8px 0;
  background: var(--vscode-textCodeBlock-background);
}

.codeblock-container.entering {
  animation: codeblockSlideIn 0.2s ease-out;
}

@keyframes codeblockSlideIn {
  from {
    opacity: 0;
    transform: translateY(-5px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Code Header */
.codeblock-header {
  display: flex;
  align-items: center;
  padding: 6px 12px;
  background: var(--vscode-editorWidget-background);
  border-bottom: 1px solid var(--vscode-panel-border);
}

.codeblock-lang {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  text-transform: uppercase;
  flex: 1;
}

.codeblock-label {
  font-size: 10px;
  color: var(--vscode-terminal-ansiGreen);
  margin-left: 8px;
}

/* Code Actions */
.codeblock-actions {
  display: flex;
  gap: 4px;
}

.codeblock-btn {
  padding: 2px 8px;
  border: none;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border-radius: 3px;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.codeblock-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.codeblock-btn.copy-btn.copied {
  background: var(--vscode-terminal-ansiGreen);
  color: var(--vscode-editor-background);
}

.codeblock-btn.diff-btn.active {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.codeblock-btn.apply-btn {
  opacity: 0.5;
  pointer-events: none;
}

.codeblock-container.diffed .codeblock-btn.apply-btn {
  opacity: 1;
  pointer-events: auto;
}

.codeblock-btn.collapse-btn {
  padding: 2px 6px;
  min-width: 20px;
}

/* Code Content */
.codeblock-content {
  position: relative;
  max-height: 2000px;
  overflow: hidden;
  transition: max-height 0.3s ease-out;
}

.codeblock-container.collapsed .codeblock-content {
  max-height: 50px;
  transition: max-height 0.2s ease-in;
}

.codeblock-content pre {
  margin: 0;
  padding: 12px;
  overflow-x: auto;
}

.codeblock-content code {
  font-family: var(--vscode-editor-font-family);
  font-size: var(--vscode-editor-font-size, 13px);
  line-height: 1.5;
  white-space: pre;
}

/* Fade overlay for collapsed state */
.codeblock-content::after {
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

.codeblock-container.collapsed .codeblock-content::after {
  opacity: 1;
}

/* Diffed state */
.codeblock-container.diffed {
  border: 1px solid var(--vscode-terminal-ansiGreen);
}

/* Tool output style */
.codeblock-container.tool-output {
  opacity: 0.6;
}

.codeblock-container.tool-output .codeblock-header {
  background: transparent;
}

/* Syntax highlighting tokens */
.token.comment { color: var(--vscode-editor-foreground); opacity: 0.5; font-style: italic; }
.token.string { color: var(--vscode-terminal-ansiGreen); }
.token.number { color: var(--vscode-terminal-ansiYellow); }
.token.keyword { color: var(--vscode-terminal-ansiMagenta); }
.token.builtin { color: var(--vscode-terminal-ansiCyan); }
.token.function { color: var(--vscode-terminal-ansiBlue); }
`;
