/**
 * SidebarShadowActor styles
 * Shadow DOM encapsulated styles for the sidebar
 */
export const sidebarShadowStyles = `
/* Container */
.sidebar-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--vscode-sideBar-background, #252526);
  border-right: 1px solid var(--vscode-sideBar-border, #454545);
}

/* Header */
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  border-bottom: 1px solid var(--vscode-sideBar-border, #454545);
}

.title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--vscode-sideBarSectionHeader-foreground, #bbbbbb);
  letter-spacing: 0.5px;
}

/* Search */
.search {
  padding: 8px 12px;
  border-bottom: 1px solid var(--vscode-sideBar-border, #454545);
}

.search-input {
  width: 100%;
  padding: 6px 8px;
  font-size: 12px;
  color: var(--vscode-input-foreground, #cccccc);
  background: var(--vscode-input-background, #3c3c3c);
  border: 1px solid var(--vscode-input-border, #6b6b6b);
  border-radius: 4px;
  outline: none;
}

.search-input:focus {
  border-color: var(--vscode-focusBorder, #007fd4);
}

.search-input::placeholder {
  color: var(--vscode-input-placeholderForeground, #8b8b8b);
}

/* List */
.list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
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
  font-size: 32px;
  margin-bottom: 12px;
  opacity: 0.5;
}

.empty-text {
  font-size: 12px;
  line-height: 1.5;
}

/* Session item */
.item {
  display: flex;
  flex-direction: column;
  padding: 8px 12px;
  cursor: pointer;
  border-left: 2px solid transparent;
  transition: background 0.15s ease;
  position: relative;
}

.item:hover {
  background: var(--vscode-list-hoverBackground, #2a2d2e);
}

.item.active {
  background: var(--vscode-list-activeSelectionBackground, #094771);
  border-left-color: var(--vscode-focusBorder, #007fd4);
}

.item.active .item-title {
  color: var(--vscode-list-activeSelectionForeground, #ffffff);
}

.item-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--vscode-foreground, #cccccc);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 4px;
}

.item-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground, #8b8b8b);
}

.item-model {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.item-model.reasoner {
  color: var(--vscode-terminal-ansiYellow, #dcdcaa);
}

.item-date {
  white-space: nowrap;
}

.item-count {
  margin-left: auto;
}

/* Delete button */
.item-delete {
  display: none;
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  width: 20px;
  height: 20px;
  font-size: 12px;
  color: var(--vscode-foreground, #cccccc);
  background: transparent;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  opacity: 0.7;
  align-items: center;
  justify-content: center;
}

.item:hover .item-delete {
  display: flex;
}

.item-delete:hover {
  opacity: 1;
  background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
  color: var(--vscode-errorForeground, #f48771);
}

/* Group headers */
.group-header {
  padding: 8px 12px 4px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--vscode-descriptionForeground, #8b8b8b);
  letter-spacing: 0.5px;
}

/* Loading state */
.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.loading-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--vscode-progressBar-background, #0e70c0);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
`;
