/**
 * Thinking actor styles for Shadow DOM
 *
 * These styles are scoped to each thinking iteration's shadow root.
 * No prefixes needed - simple class names work because of encapsulation.
 * Matches old .reasoning-content styling with amber left border.
 */
export const thinkingShadowStyles = `
/* Container (the main content wrapper inside shadow) */
.container {
  margin: 8px 0;
  border-left: 3px solid var(--vscode-symbolIcon-classForeground, #ee9d28);
  border-radius: 0 6px 6px 0;
  background: var(--vscode-editorWidget-background);
  overflow: hidden;
}

.container.entering {
  animation: slideDown 0.2s ease-out forwards;
}

@keyframes slideDown {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Header - clickable row with icon, label, toggle */
.header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  user-select: none;
  color: var(--vscode-foreground);
  font-size: 12px;
  font-weight: 500;
  background: var(--vscode-editorWidget-background);
  transition: background 0.15s ease;
}

.header:hover {
  background: var(--vscode-list-hoverBackground);
}

/* Arrow icon on left - rotates when expanded */
.icon {
  font-size: 10px;
  color: var(--vscode-foreground);
  transition: transform 0.2s ease;
}

.container.expanded .icon {
  transform: rotate(90deg);
}

.emoji {
  font-size: 14px;
}

.label {
  flex: 1;
}

/* Body - smooth max-height transition */
.body {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.3s ease, padding 0.3s ease;
}

.container.expanded .body {
  max-height: 300px;
  padding: 0 10px 8px 10px;
  overflow-y: auto;
}

/* Body text styling */
.body-content {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  background: transparent;
}

/* Code blocks in thinking content */
.body pre {
  background: var(--vscode-textCodeBlock-background);
  padding: 8px;
  border-radius: 4px;
  margin: 8px 0;
  overflow-x: auto;
}

.body code {
  font-family: var(--vscode-editor-font-family);
  font-size: 11px;
}

/* Streaming state - subtle pulsing animation on emoji */
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
