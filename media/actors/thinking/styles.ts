/**
 * Thinking actor styles
 * CSS for reasoning/thinking content display (DeepSeek Reasoner R1)
 */
export const thinkingStyles = `
/* Thinking Container */
.thinking-container {
  background: transparent;
  border: none;
  margin: 8px 0;
  border-radius: 6px;
}

/* Thinking Header */
.thinking-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  cursor: pointer;
  user-select: none;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  transition: opacity 0.15s ease;
}

.thinking-header:hover {
  opacity: 0.8;
}

.thinking-icon {
  font-size: 14px;
}

.thinking-label {
  flex: 1;
}

.thinking-toggle {
  transition: transform 0.2s ease;
}

.thinking-container.collapsed .thinking-toggle {
  transform: rotate(-90deg);
}

/* Thinking Body */
.thinking-body {
  padding: 0 0 8px 10px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 400px;
  overflow-y: auto;
}

.thinking-container.collapsed .thinking-body {
  display: none;
}

/* Code blocks in thinking content */
.thinking-body pre {
  background: var(--vscode-textCodeBlock-background);
  padding: 8px;
  border-radius: 4px;
  margin: 8px 0;
  overflow-x: auto;
}

.thinking-body code {
  font-family: var(--vscode-editor-font-family);
  font-size: 11px;
}

/* Streaming state - subtle pulsing animation on icon */
.thinking-container.streaming .thinking-icon {
  animation: thinkingPulse 1.5s ease-in-out infinite;
}

@keyframes thinkingPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* Scrollbar styling */
.thinking-body::-webkit-scrollbar {
  width: 8px;
}

.thinking-body::-webkit-scrollbar-track {
  background: transparent;
}

.thinking-body::-webkit-scrollbar-thumb {
  background: var(--vscode-scrollbarSlider-background);
  border-radius: 4px;
}

.thinking-body::-webkit-scrollbar-thumb:hover {
  background: var(--vscode-scrollbarSlider-hoverBackground);
}

/* Iteration badge */
.thinking-iteration {
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  padding: 2px 6px;
  border-radius: 10px;
  font-size: 10px;
  font-weight: 500;
}
`;
