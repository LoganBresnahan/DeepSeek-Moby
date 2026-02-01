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

.icon {
  font-size: 14px;
}

.label {
  flex: 1;
}

.toggle {
  transition: transform 0.2s ease;
}

/* Collapsed state */
.container.collapsed .toggle {
  transform: rotate(-90deg);
}

.container.collapsed .body {
  display: none;
}

/* Body - content area */
.body {
  padding: 0 10px 8px 10px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 300px;
  overflow-y: auto;
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

/* Streaming state - subtle pulsing animation on icon */
.container.streaming .icon {
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
