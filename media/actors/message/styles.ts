/**
 * MessageActor CSS styles
 * Exported as a string for reliable importing across environments
 */

export const messageStyles = `
/**
 * Message styles
 * User and assistant message bubbles
 */

.message {
  margin-bottom: 20px;
  position: relative;
}

.message .role {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--vscode-descriptionForeground, #8b8b8b);
  margin-bottom: 4px;
  letter-spacing: 0.5px;
}

.message .content {
  font-size: 13px;
  line-height: 1.6;
  color: var(--vscode-editor-foreground, #cccccc);
  word-wrap: break-word;
  overflow-wrap: break-word;
}

.message .content p {
  margin: 0 0 8px 0;
}

.message .content p:last-child {
  margin-bottom: 0;
}

/* Message files (attachments) */
.message-files {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.message-file-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: var(--vscode-badge-background, #4d4d4d);
  color: var(--vscode-badge-foreground, #ffffff);
  border-radius: 4px;
  font-size: 11px;
}

/* Streaming message state */
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

/* Empty state */
.messages-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  text-align: center;
  color: var(--vscode-descriptionForeground, #8b8b8b);
}

.messages-empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
  opacity: 0.5;
}

.messages-empty-text {
  font-size: 14px;
  line-height: 1.5;
}
`;
