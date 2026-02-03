/**
 * Thinking actor styles for Shadow DOM
 * Clean dotted border design - no ASCII art
 */
export const thinkingShadowStyles = `
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
.emoji {
  flex-shrink: 0;
}

/* Label text */
.label {
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

/* Body - hidden when collapsed */
.body {
  display: none;
  padding: 8px 10px 10px 30px;
  border-top: 1px dotted var(--vscode-panel-border);
  max-height: 300px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  line-height: 1.5;
}

/* Expanded state - show body */
.container.expanded .body {
  display: block;
}

/* Empty body - hide completely */
.body:empty {
  display: none;
}

/* Code blocks in thinking content */
.body pre {
  background: var(--vscode-textCodeBlock-background);
  padding: 8px;
  border-radius: 4px;
  margin: 8px 0;
  overflow-x: auto;
  white-space: pre;
}

.body code {
  font-family: var(--vscode-editor-font-family);
  font-size: 11px;
}

/* Streaming state - pulsing emoji */
.container.streaming .emoji {
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* Scrollbar styling */
.body::-webkit-scrollbar {
  width: 8px;
}

.body::-webkit-scrollbar-track {
  background: transparent;
}

.body::-webkit-scrollbar-thumb {
  background: var(--vscode-scrollbarSlider-background);
  border-radius: 4px;
}

.body::-webkit-scrollbar-thumb:hover {
  background: var(--vscode-scrollbarSlider-hoverBackground);
}
`;
