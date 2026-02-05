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
  margin-bottom: 0;
  position: relative;
}

.message.assistant {
  padding-bottom: 0;
}

/* Continuation messages (after tools/shell) */
.message.continuation {
  margin-top: 8px;
}

.message.continuation .message-divider,
.message.continuation .role {
  display: none;
}

/* Divider with centered label */
.message-divider {
  display: flex;
  align-items: center;
  margin-bottom: 0;
}

.message-divider::before,
.message-divider::after {
  content: '';
  flex: 1;
  border-bottom: 1px dashed var(--vscode-panel-border, #3c3c3c);
}

.message-divider-label {
  padding: 0 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--vscode-descriptionForeground, #8b8b8b);
}

/* Legacy role label - kept for compatibility */
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
  padding-top: 15px;
  padding-right: 0px;
  padding-bottom: 15px;
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

/* Streaming state - no cursor, just indicates message is being streamed */
.message.streaming {
  /* Parent container is marked as streaming */
}

/* Code blocks - dropdown style matching shell/thinking */
.code-block {
  margin: 0 0 12px 0;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  overflow: hidden;
  background: var(--vscode-textCodeBlock-background, #1e1e1e);
}

.code-block.entering {
  animation: slideDown 0.2s ease-out forwards;
}

@keyframes codeSlideDown {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Header - clickable row */
.code-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--vscode-editorWidget-background);
  border-bottom: 1px solid var(--vscode-panel-border);
  cursor: pointer;
  user-select: none;
  transition: background 0.15s ease;
}

.code-header:hover {
  background: var(--vscode-list-hoverBackground);
}

/* Arrow icon on left - rotates when expanded */
.code-toggle {
  font-size: 10px;
  color: var(--vscode-foreground);
  transition: transform 0.2s ease;
  flex-shrink: 0;
}

.code-block.expanded .code-toggle {
  transform: rotate(90deg);
}

.code-lang {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  text-transform: uppercase;
  flex-shrink: 0;
}

/* Code preview shown when collapsed */
.code-preview {
  flex: 1;
  font-family: var(--vscode-editor-font-family);
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.7;
}

.code-block.expanded .code-preview {
  display: none;
}

/* Actions - always visible */
.code-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.code-action-btn {
  padding: 2px 8px;
  border: none;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border-radius: 3px;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.15s ease, opacity 0.15s ease;
}

.code-action-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

/* Copy button success state */
.code-action-btn.copy-btn.copied {
  background: var(--vscode-terminal-ansiGreen);
  color: var(--vscode-editor-background);
}

/* Diff button active state */
.code-action-btn.diff-btn.active {
  background: var(--vscode-terminal-ansiBlue);
  color: var(--vscode-editor-background);
}

/* Apply button - enabled when diffed */
.code-action-btn.apply-btn {
  opacity: 0.4;
  pointer-events: none;
}

.code-block.diffed .code-action-btn.apply-btn {
  opacity: 1;
  pointer-events: auto;
  background: var(--vscode-terminal-ansiGreen);
  color: var(--vscode-editor-background);
}

/* Hide diff/apply buttons when not in manual mode */
.code-block[data-edit-mode="ask"] .diff-btn,
.code-block[data-edit-mode="ask"] .apply-btn,
.code-block[data-edit-mode="auto"] .diff-btn,
.code-block[data-edit-mode="auto"] .apply-btn {
  display: none;
}

/* Code body - collapsed shows preview with fade */
.code-body {
  position: relative;
  max-height: 50px;
  overflow: hidden;
  transition: max-height 0.3s ease;
}

/* Fade overlay for collapsed state */
.code-body::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 30px;
  background: linear-gradient(transparent, var(--vscode-textCodeBlock-background, #1e1e1e));
  pointer-events: none;
  opacity: 1;
  transition: opacity 0.2s ease;
}

.code-block.expanded .code-body {
  max-height: 500px;
  overflow-y: auto;
}

.code-block.expanded .code-body::after {
  opacity: 0;
}

.code-body pre {
  margin: 0;
  padding: 12px;
  overflow-x: auto;
}

.code-body code {
  font-family: var(--vscode-editor-font-family);
  font-size: var(--vscode-editor-font-size, 13px);
  line-height: 1.5;
  white-space: pre;
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
