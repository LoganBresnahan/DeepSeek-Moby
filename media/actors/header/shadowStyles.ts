/**
 * HeaderShadowActor styles
 * Shadow DOM encapsulated styles for the header
 */
export const headerShadowStyles = `
/* Container */
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
.title {
  font-size: 13px;
  font-weight: 500;
  color: var(--vscode-foreground, #cccccc);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}

.title.editable {
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 3px;
}

.title.editable:hover {
  background: var(--vscode-list-hoverBackground, #2a2d2e);
}

.title-input {
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
.model-selector {
  display: flex;
  align-items: center;
  gap: 4px;
}

.model-select {
  font-size: 11px;
  padding: 4px 8px;
  color: var(--vscode-dropdown-foreground, #cccccc);
  background: var(--vscode-dropdown-background, #3c3c3c);
  border: 1px solid var(--vscode-dropdown-border, #6b6b6b);
  border-radius: 3px;
  cursor: pointer;
  outline: none;
}

.model-select:focus {
  border-color: var(--vscode-focusBorder, #007fd4);
}

.model-select:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* Control buttons */
.btn {
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

.btn:hover {
  background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
}

.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn:disabled:hover {
  background: transparent;
}

/* Menu dropdown */
.menu {
  position: relative;
}

.menu-dropdown {
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

.menu-dropdown.open {
  display: block;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--vscode-menu-foreground, #cccccc);
  cursor: pointer;
}

.menu-item:hover {
  background: var(--vscode-menu-selectionBackground, #094771);
}

.menu-item.danger {
  color: var(--vscode-errorForeground, #f48771);
}

.menu-divider {
  height: 1px;
  margin: 4px 0;
  background: var(--vscode-menu-separatorBackground, #454545);
}

/* Streaming indicator */
.streaming-indicator {
  display: none;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground, #8b8b8b);
}

.streaming-indicator.active {
  display: inline-flex;
}

.streaming-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--vscode-terminal-ansiGreen, #89d185);
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% {
    opacity: 0.4;
  }
  50% {
    opacity: 1;
  }
}
`;
