/**
 * HeaderActor CSS styles
 * Exported as a string for reliable importing across environments
 */

export const headerStyles = `
/**
 * Header styles
 * Model selector, session title, and controls
 */

.header-container {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--vscode-sideBar-background, #252526);
  border-bottom: 1px solid var(--vscode-panel-border, #454545);
  gap: 12px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* Session title */
.header-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--vscode-foreground, #cccccc);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}

.header-title.editable {
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 3px;
}

.header-title.editable:hover {
  background: var(--vscode-list-hoverBackground, #2a2d2e);
}

.header-title-input {
  font-size: 13px;
  font-weight: 500;
  padding: 2px 6px;
  color: var(--vscode-input-foreground, #cccccc);
  background: var(--vscode-input-background, #3c3c3c);
  border: 1px solid var(--vscode-focusBorder, #007fd4);
  border-radius: 3px;
  outline: none;
  max-width: 200px;
}

/* Model selector */
.header-model-selector {
  display: flex;
  align-items: center;
  gap: 4px;
}

.header-model-select {
  font-size: 11px;
  padding: 4px 8px;
  color: var(--vscode-dropdown-foreground, #cccccc);
  background: var(--vscode-dropdown-background, #3c3c3c);
  border: 1px solid var(--vscode-dropdown-border, #6b6b6b);
  border-radius: 3px;
  cursor: pointer;
  outline: none;
}

.header-model-select:focus {
  border-color: var(--vscode-focusBorder, #007fd4);
}

.header-model-select:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* Control buttons */
.header-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  font-size: 14px;
  color: var(--vscode-foreground, #cccccc);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.header-button:hover {
  background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
}

.header-button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.header-button:disabled:hover {
  background: transparent;
}

.header-button[title]::after {
  content: attr(title);
  position: absolute;
  display: none;
}

/* Menu dropdown */
.header-menu {
  position: relative;
}

.header-menu-dropdown {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  min-width: 150px;
  background: var(--vscode-menu-background, #252526);
  border: 1px solid var(--vscode-menu-border, #454545);
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  z-index: 1000;
  display: none;
}

.header-menu-dropdown.open {
  display: block;
}

.header-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--vscode-menu-foreground, #cccccc);
  cursor: pointer;
}

.header-menu-item:hover {
  background: var(--vscode-menu-selectionBackground, #094771);
}

.header-menu-item.danger {
  color: var(--vscode-errorForeground, #f48771);
}

.header-menu-divider {
  height: 1px;
  margin: 4px 0;
  background: var(--vscode-menu-separatorBackground, #454545);
}

/* Streaming indicator in header */
.header-streaming {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground, #8b8b8b);
}

.header-streaming-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--vscode-terminal-ansiGreen, #89d185);
  animation: header-pulse 1.5s ease-in-out infinite;
}

@keyframes header-pulse {
  0%, 100% {
    opacity: 0.4;
  }
  50% {
    opacity: 1;
  }
}
`;
