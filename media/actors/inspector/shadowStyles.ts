/**
 * Inspector Shadow DOM styles
 */
export const inspectorShadowStyles = `
/* Panel container */
.inspector-panel {
  position: fixed;
  top: 10px;
  right: 10px;
  width: 350px;
  max-height: calc(100vh - 20px);
  background: var(--vscode-editorWidget-background, #252526);
  border: 1px solid var(--vscode-editorWidget-border, #454545);
  border-radius: 6px;
  font-family: var(--vscode-font-family, sans-serif);
  font-size: 12px;
  color: var(--vscode-foreground, #ccc);
  z-index: 999999;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  pointer-events: auto;
}

.inspector-panel.hidden {
  display: none;
}

/* Header - draggable */
.inspector-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--vscode-titleBar-activeBackground, #3c3c3c);
  border-bottom: 1px solid var(--vscode-editorWidget-border, #454545);
  cursor: move;
  user-select: none;
}

.inspector-header-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.inspector-header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  margin-right: 8px;
}

.header-btn {
  background: transparent;
  border: 1px solid transparent;
  color: var(--vscode-foreground, #ccc);
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 3px;
  cursor: pointer;
  opacity: 0.8;
  transition: all 0.15s;
}

.header-btn:hover {
  opacity: 1;
  background: var(--vscode-button-secondaryBackground, #3a3d41);
}

.header-btn.active {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
  opacity: 1;
}

.header-btn span {
  font-size: 10px;
}

.inspector-icon {
  font-size: 14px;
}

.inspector-title {
  font-weight: 600;
}

.inspector-badge {
  background: var(--vscode-badge-background, #4d4d4d);
  color: var(--vscode-badge-foreground, #fff);
  padding: 1px 6px;
  border-radius: 10px;
  font-size: 10px;
}

.inspector-close {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  padding: 2px 6px;
  font-size: 16px;
  opacity: 0.7;
  transition: opacity 0.15s;
}

.inspector-close:hover {
  opacity: 1;
}

/* Inspect button active state */
.inspect-btn.active {
  background: #d63384 !important;
  color: #fff !important;
}

/* Match button active state (green) */
.match-btn.active {
  background: rgb(134, 179, 0) !important;
  color: #000 !important;
}

/* Body */
.inspector-body {
  overflow-y: auto;
  max-height: 400px;
  padding: 12px;
}

/* No selection state */
.no-selection {
  text-align: center;
  padding: 24px;
  color: var(--vscode-descriptionForeground, #999);
}

.no-selection-icon {
  font-size: 32px;
  margin-bottom: 8px;
}

.no-selection-text {
  line-height: 1.5;
}

/* Selection info */
.selection-info {
  display: none;
}

.selection-info.visible {
  display: block;
}

/* Element path */
.element-path {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10px;
  color: var(--vscode-textLink-foreground, #3794ff);
  margin-bottom: 12px;
  padding: 6px 8px;
  background: var(--vscode-textCodeBlock-background, #2d2d2d);
  border-radius: 4px;
  word-break: break-all;
  line-height: 1.4;
  user-select: text;
  cursor: text;
}

/* Box Model Visualization - Collapsible */
.box-model {
  margin-bottom: 12px;
  border: 1px solid var(--vscode-editorWidget-border, #3c3c3c);
  border-radius: 4px;
  overflow: hidden;
}

.box-model-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--vscode-editor-background, #1e1e1e);
  cursor: pointer;
  user-select: none;
}

.box-model-header:hover {
  background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.04));
}

.box-model-toggle {
  font-size: 10px;
  opacity: 0.7;
}

.box-model-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--vscode-foreground, #ccc);
}

.box-model-diagram {
  position: relative;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10px;
  padding: 8px;
}

.box-model.collapsed .box-model-diagram {
  display: none;
}

.box-margin {
  position: relative;
  background: rgba(255, 166, 87, 0.15);
  border: 1px dashed rgba(255, 166, 87, 0.5);
  padding: 18px;
}

.box-border {
  position: relative;
  background: rgba(255, 213, 79, 0.15);
  border: 1px dashed rgba(255, 213, 79, 0.5);
  padding: 18px;
}

.box-padding {
  position: relative;
  background: rgba(134, 179, 0, 0.15);
  border: 1px dashed rgba(134, 179, 0, 0.5);
  padding: 18px;
}

.box-content {
  background: rgba(59, 142, 234, 0.2);
  border: 1px solid rgba(59, 142, 234, 0.5);
  min-height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-textLink-foreground, #3794ff);
  font-weight: 500;
}

.box-label {
  position: absolute;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  opacity: 0.7;
}

.margin-label {
  top: 2px;
  left: 4px;
  color: rgb(255, 166, 87);
}

.border-label {
  top: 2px;
  left: 4px;
  color: rgb(255, 213, 79);
}

.padding-label {
  top: 2px;
  left: 4px;
  color: rgb(134, 179, 0);
}

.box-value {
  position: absolute;
  color: var(--vscode-descriptionForeground, #999);
  font-size: 10px;
  transition: color 0.15s;
}

.box-value.has-value {
  color: var(--vscode-foreground, #ccc);
  font-weight: 500;
}

/* Margin values */
.margin-top {
  top: 2px;
  left: 50%;
  transform: translateX(-50%);
}

.margin-right {
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
}

.margin-bottom {
  bottom: 2px;
  left: 50%;
  transform: translateX(-50%);
}

.margin-left {
  left: 4px;
  top: 50%;
  transform: translateY(-50%);
}

/* Border values */
.border-top {
  top: 2px;
  left: 50%;
  transform: translateX(-50%);
}

.border-right {
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
}

.border-bottom {
  bottom: 2px;
  left: 50%;
  transform: translateX(-50%);
}

.border-left {
  left: 4px;
  top: 50%;
  transform: translateY(-50%);
}

/* Padding values */
.padding-top {
  top: 2px;
  left: 50%;
  transform: translateX(-50%);
}

.padding-right {
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
}

.padding-bottom {
  bottom: 2px;
  left: 50%;
  transform: translateX(-50%);
}

.padding-left {
  left: 4px;
  top: 50%;
  transform: translateY(-50%);
}

.content-size {
  font-size: 10px;
}

.element-path .shadow-indicator {
  color: var(--vscode-terminal-ansiMagenta, #bc8cff);
  font-weight: 600;
}

/* Style controls */
.style-controls {
  display: flex;
  flex-direction: column;
  gap: 0;
}

/* Chrome DevTools style property rows */
.style-row {
  display: flex;
  align-items: center;
  padding: 3px 8px;
  gap: 4px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px;
}

.style-row:hover {
  background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.04));
}

.style-label {
  color: var(--vscode-symbolIcon-propertyForeground, #9cdcfe);
  width: 110px;
  flex-shrink: 0;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Editable value - inline text editing */
.style-value.editable {
  color: var(--vscode-symbolIcon-stringForeground, #ce9178);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 2px;
  padding: 2px 4px;
  flex: 1;
  min-width: 60px;
  cursor: text;
  font-family: inherit;
  font-size: inherit;
}

.style-value.editable:hover {
  border-color: var(--vscode-input-border, #3c3c3c);
}

.style-value.editable:focus {
  outline: none;
  border-color: var(--vscode-focusBorder, #007acc);
  background: var(--vscode-input-background, #1e1e1e);
}

/* Preset dropdown trigger */
.preset-trigger {
  background: none;
  border: 1px solid transparent;
  color: var(--vscode-descriptionForeground, #999);
  cursor: pointer;
  padding: 2px 4px;
  font-size: 8px;
  border-radius: 3px;
  transition: all 0.15s;
  line-height: 1;
  margin-left: 4px;
}

.preset-trigger:hover {
  color: var(--vscode-foreground, #ccc);
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  border-color: var(--vscode-editorWidget-border, #454545);
}

.preset-trigger.active {
  color: var(--vscode-button-foreground, #fff);
  background: var(--vscode-button-background, #0e639c);
  border-color: var(--vscode-button-background, #0e639c);
}

/* Preset dropdown menu - uses fixed positioning set via JS */
.preset-dropdown {
  position: fixed;
  min-width: 140px;
  max-height: 200px;
  overflow-y: auto;
  background: var(--vscode-editorWidget-background, #252526);
  border: 1px solid var(--vscode-editorWidget-border, #454545);
  border-radius: 4px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  z-index: 1000000;
  display: none;
}

.preset-dropdown.open {
  display: block;
  animation: presetDropdownIn 0.15s ease-out;
}

@keyframes presetDropdownIn {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Preset option */
.preset-option {
  display: block;
  width: 100%;
  padding: 6px 10px;
  text-align: left;
  background: none;
  border: none;
  color: var(--vscode-foreground, #ccc);
  font-size: 11px;
  font-family: var(--vscode-editor-font-family, monospace);
  cursor: pointer;
  transition: background 0.1s;
}

.preset-option:hover {
  background: var(--vscode-list-hoverBackground, #2a2d2e);
}

.preset-option.selected {
  background: var(--vscode-list-activeSelectionBackground, #094771);
  color: var(--vscode-list-activeSelectionForeground, #fff);
}

/* Divider before custom slider option */
.preset-divider {
  height: 1px;
  background: var(--vscode-editorWidget-border, #454545);
  margin: 4px 0;
}

/* Custom slider option styling */
.preset-option.custom-option {
  color: var(--vscode-descriptionForeground, #999);
  font-style: italic;
  font-family: var(--vscode-font-family, sans-serif);
}

.preset-option.custom-option:hover {
  color: var(--vscode-foreground, #ccc);
}

/* Category sections (collapsible) */
.style-category {
  border: 1px solid var(--vscode-editorWidget-border, #3c3c3c);
  border-radius: 4px;
  margin-bottom: 8px;
  overflow: hidden;
}

.style-category:last-child {
  margin-bottom: 0;
}

.category-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: var(--vscode-sideBarSectionHeader-background, #333);
  cursor: pointer;
  user-select: none;
  transition: background 0.15s;
}

.category-header:hover {
  background: var(--vscode-list-hoverBackground, #2a2d2e);
}

.category-toggle {
  font-size: 10px;
  color: var(--vscode-descriptionForeground, #999);
  width: 12px;
}

.category-icon {
  font-size: 12px;
  width: 16px;
  text-align: center;
}

.category-name {
  flex: 1;
  font-size: 11px;
  font-weight: 500;
}

.category-count {
  font-size: 10px;
  color: var(--vscode-descriptionForeground, #999);
  background: var(--vscode-badge-background, #4d4d4d);
  padding: 1px 6px;
  border-radius: 8px;
}

.category-body {
  display: none;
  padding: 8px 10px;
  background: var(--vscode-editor-background, #1e1e1e);
}

.style-category.expanded .category-body {
  display: block;
}

/* Custom property section */
.custom-category .category-icon {
  color: var(--vscode-terminal-ansiGreen, #89d185);
  font-weight: bold;
}

.add-custom-row {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--vscode-editorWidget-border, #3c3c3c);
}

.custom-prop-input {
  flex: 1;
  padding: 4px 8px;
  font-size: 11px;
  font-family: var(--vscode-editor-font-family, monospace);
  background: var(--vscode-input-background, #3c3c3c);
  border: 1px solid var(--vscode-input-border, #454545);
  border-radius: 3px;
  color: var(--vscode-input-foreground, #ccc);
  outline: none;
}

.custom-prop-input:focus {
  border-color: var(--vscode-focusBorder, #0e639c);
}

.custom-prop-input.error {
  border-color: var(--vscode-inputValidation-errorBorder, #f44747);
  animation: shake 0.3s ease;
}

@keyframes shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-4px); }
  75% { transform: translateX(4px); }
}

.add-custom-btn {
  padding: 4px 10px;
  font-size: 14px;
  font-weight: bold;
  background: var(--vscode-button-background, #0e639c);
  border: none;
  border-radius: 3px;
  color: var(--vscode-button-foreground, #fff);
  cursor: pointer;
  transition: background 0.15s;
}

.add-custom-btn:hover {
  background: var(--vscode-button-hoverBackground, #1177bb);
}

/* History section */
.history-section {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--vscode-editorWidget-border, #454545);
}

.history-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--vscode-foreground, #ccc);
  margin-bottom: 8px;
}

.copy-history-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 12px;
  padding: 2px 4px;
  opacity: 0.7;
  transition: opacity 0.15s;
  margin-left: auto; /* Push to right side */
}

.copy-history-btn:hover {
  opacity: 1;
}

.history-title {
  /* Title stays at natural width, copy button pushed right via margin-left: auto */
}

.history-list {
  background: var(--vscode-textCodeBlock-background, #2d2d2d);
  border-radius: 4px;
  padding: 8px;
  max-height: 150px;
  overflow-y: auto;
}

.history-empty {
  font-size: 11px;
  color: var(--vscode-descriptionForeground, #999);
  font-style: italic;
}

.history-item {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10px;
  padding: 6px;
  margin-bottom: 6px;
  border-radius: 4px;
  background: var(--vscode-editor-background, #1e1e1e);
  cursor: pointer;
  transition: background 0.15s;
}

.history-item:last-child {
  margin-bottom: 0;
}

.history-item:hover {
  background: var(--vscode-list-hoverBackground, #2a2d2e);
}

.history-item.current {
  /* Currently selected element - subtle highlight without left border */
  background: var(--vscode-list-activeSelectionBackground, rgba(59, 142, 234, 0.15));
}

.history-path {
  color: var(--vscode-descriptionForeground, #999);
  margin-bottom: 4px;
  word-break: break-all;
}

.history-override {
  display: flex;
  align-items: center;
  gap: 4px;
}

.history-override .override-prop {
  flex-shrink: 0;
}

.history-override .override-value {
  flex: 1;
  word-break: break-all;
}

.override-delete {
  margin-left: auto;
  background: none;
  border: none;
  color: var(--vscode-descriptionForeground, #999);
  cursor: pointer;
  font-size: 12px;
  padding: 0 4px;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s;
  line-height: 1;
}

.history-item:hover .override-delete {
  opacity: 0.6;
}

.override-delete:hover {
  opacity: 1 !important;
  color: var(--vscode-errorForeground, #f44747);
}

.override-prop {
  color: var(--vscode-terminal-ansiCyan, #29b8db);
}

.override-value {
  color: var(--vscode-terminal-ansiGreen, #89d185);
}

/* Resize handle - bottom right corner (standard) */
.resize-handle {
  position: absolute;
  bottom: 0;
  right: 0;
  width: 16px;
  height: 16px;
  cursor: nwse-resize;
  background: linear-gradient(
    135deg,
    transparent 50%,
    var(--vscode-scrollbarSlider-background, #4d4d4d) 50%,
    var(--vscode-scrollbarSlider-background, #4d4d4d) 60%,
    transparent 60%,
    transparent 70%,
    var(--vscode-scrollbarSlider-background, #4d4d4d) 70%,
    var(--vscode-scrollbarSlider-background, #4d4d4d) 80%,
    transparent 80%
  );
  opacity: 0.6;
  transition: opacity 0.15s;
}

.resize-handle:hover {
  opacity: 1;
}

/* Overlay styles */
.inspector-overlay {
  position: fixed;
  pointer-events: none;
  z-index: 999997;
  display: none;
}

.inspector-overlay.highlight {
  border: 2px dashed rgba(59, 142, 234, 0.8);
  background: rgba(59, 142, 234, 0.1);
}

.inspector-overlay.select {
  border: 2px solid #3b8eea;
  background: rgba(59, 142, 234, 0.15);
}

.inspector-overlay.visible {
  display: block;
}
`;
