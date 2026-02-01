/**
 * MessageShadowActor styles
 * Shadow DOM encapsulated styles for message bubbles
 */
export const messageShadowStyles = `
/* Container for all messages */
.messages-container {
  display: flex;
  flex-direction: column;
  gap: 0;
}

/* Individual message */
.message {
  margin-bottom: 20px;
  position: relative;
}

/* Continuation messages (after tools/shell) */
.message.continuation {
  margin-top: 8px;
}

.message.continuation .role {
  display: none;
}

/* Role label */
.role {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--vscode-descriptionForeground, #8b8b8b);
  margin-bottom: 4px;
  letter-spacing: 0.5px;
}

/* Message content */
.content {
  font-size: 13px;
  line-height: 1.6;
  color: var(--vscode-editor-foreground, #cccccc);
  word-wrap: break-word;
  overflow-wrap: break-word;
}

.content p {
  margin: 0 0 8px 0;
}

.content p:last-child {
  margin-bottom: 0;
}

/* File attachments */
.files {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.file-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: var(--vscode-badge-background, #4d4d4d);
  color: var(--vscode-badge-foreground, #ffffff);
  border-radius: 4px;
  font-size: 11px;
}

/* Thinking content */
.thinking-content {
  margin-bottom: 12px;
  padding: 8px 12px;
  background: var(--vscode-textBlockQuote-background, rgba(127, 127, 127, 0.1));
  border-left: 3px solid var(--vscode-textBlockQuote-border, #007acc);
  border-radius: 0 4px 4px 0;
}

.thinking-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--vscode-descriptionForeground);
  margin-bottom: 4px;
}

.thinking-body {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  white-space: pre-wrap;
  opacity: 0.8;
}

/* Streaming cursor */
.message.streaming .content::after {
  content: '▋';
  display: inline;
  animation: cursor-blink 1s step-end infinite;
  color: var(--vscode-editor-foreground, #cccccc);
  opacity: 0.7;
}

@keyframes cursor-blink {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0;
  }
}

/* Code blocks */
.code-block {
  margin: 12px 0;
  border-radius: 6px;
  overflow: hidden;
  background: var(--vscode-textCodeBlock-background, #1e1e1e);
}

.code-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: var(--vscode-editorWidget-background);
  border-bottom: 1px solid var(--vscode-panel-border);
}

.code-lang {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  text-transform: uppercase;
}

.code-actions {
  display: flex;
  gap: 4px;
}

.code-action-btn {
  padding: 2px 8px;
  border: none;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border-radius: 3px;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.code-action-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.code-block pre {
  margin: 0;
  padding: 12px;
  overflow-x: auto;
}

.code-block code {
  font-family: var(--vscode-editor-font-family);
  font-size: var(--vscode-editor-font-size, 13px);
  line-height: 1.5;
  white-space: pre;
}

/* Collapsed code block */
.code-block.collapsed pre {
  max-height: 50px;
  overflow: hidden;
  position: relative;
}

.code-block.collapsed pre::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 30px;
  background: linear-gradient(transparent, var(--vscode-textCodeBlock-background));
  pointer-events: none;
}

/* Inline code */
code.inline {
  padding: 2px 6px;
  background: var(--vscode-textCodeBlock-background);
  border-radius: 3px;
  font-family: var(--vscode-editor-font-family);
  font-size: 0.9em;
}

/* Empty state */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  text-align: center;
  color: var(--vscode-descriptionForeground, #8b8b8b);
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
  opacity: 0.5;
}

.empty-text {
  font-size: 14px;
  line-height: 1.5;
}

/* Animation for new messages */
@keyframes message-in {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.anim-message-in {
  animation: message-in 0.2s ease-out;
}
`;
