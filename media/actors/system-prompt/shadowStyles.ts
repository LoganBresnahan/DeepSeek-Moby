/**
 * SystemPromptModalActor styles
 */
export const systemPromptShadowStyles = `
  .prompt-container {
    padding: 16px;
  }

  .prompt-hint {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 12px;
    line-height: 1.4;
  }

  .prompt-textarea {
    width: 100%;
    min-height: 200px;
    max-height: 50vh;
    padding: 12px;
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, #3c3c3c));
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border-radius: 4px;
    font-family: var(--vscode-editor-font-family);
    font-size: 13px;
    line-height: 1.5;
    resize: vertical;
    box-sizing: border-box;
  }

  .prompt-textarea:focus {
    outline: none;
    border-color: var(--vscode-focusBorder, #007acc);
  }

  .prompt-textarea::placeholder {
    color: var(--vscode-input-placeholderForeground);
  }

  /* Unsaved changes bar */
  .prompt-dirty {
    display: none;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    margin-top: 8px;
    border-radius: 4px;
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-terminal-ansiYellow, #cca700);
    font-size: 12px;
    color: var(--vscode-terminal-ansiYellow, #cca700);
  }

  .prompt-dirty.visible {
    display: flex;
  }

  .prompt-dirty-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .prompt-dirty-model {
    padding: 2px 4px;
    border: 1px solid var(--vscode-terminal-ansiYellow, #cca700);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border-radius: 3px;
    font-size: 11px;
  }

  .prompt-dirty-model:focus {
    outline: none;
    border-color: var(--vscode-focusBorder);
  }

  .prompt-dirty-btn {
    padding: 2px 8px;
    border: none;
    border-radius: 3px;
    font-size: 11px;
    cursor: pointer;
  }

  .prompt-dirty-btn.save {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }

  .prompt-dirty-btn.save:hover {
    background: var(--vscode-button-hoverBackground);
  }

  .prompt-dirty-btn.discard {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }

  .prompt-dirty-btn.discard:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  /* Saved prompts section */
  .prompt-saved-section {
    margin-top: 16px;
  }

  .prompt-saved-header {
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-descriptionForeground);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 8px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }

  .prompt-saved-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .prompt-saved-empty {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    padding: 8px 0;
    font-style: italic;
  }

  .prompt-saved-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 8px;
    border-radius: 4px;
    transition: background 0.1s ease;
  }

  .prompt-saved-item:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .prompt-saved-item.active {
    border-left: 2px solid var(--vscode-terminal-ansiGreen, #89d185);
    padding-left: 6px;
  }

  .prompt-saved-info {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .prompt-saved-name {
    font-size: 13px;
    color: var(--vscode-foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .prompt-saved-model {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    flex-shrink: 0;
  }

  .prompt-saved-active-badge {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--vscode-terminal-ansiGreen, #89d185);
    color: var(--vscode-editor-background);
    flex-shrink: 0;
    cursor: pointer;
    transition: background 0.15s;
  }

  .prompt-saved-active-badge:hover {
    background: var(--vscode-errorForeground, #f48771);
  }

  .prompt-saved-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }

  .prompt-saved-btn {
    padding: 2px 8px;
    border: none;
    border-radius: 3px;
    font-size: 11px;
    cursor: pointer;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }

  .prompt-saved-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .prompt-saved-btn.delete:hover {
    background: var(--vscode-errorForeground);
    color: var(--vscode-editor-background);
  }

  /* Delete confirmation */
  .prompt-delete-confirm {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--vscode-errorForeground, #f48771);
  }

  .prompt-delete-btn {
    padding: 2px 8px;
    border-radius: 3px;
    font-size: 11px;
    cursor: pointer;
    border: none;
  }

  .prompt-delete-btn.no {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }

  .prompt-delete-btn.no:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .prompt-delete-btn.yes {
    background: var(--vscode-errorForeground, #f48771);
    color: var(--vscode-editor-background);
    border: 1px solid var(--vscode-errorForeground, #f48771);
  }

  .prompt-delete-btn.yes:hover {
    opacity: 0.85;
  }

  /* Footer */
  .prompt-footer-default {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
  }

  .prompt-footer-left {
    display: flex;
    gap: 8px;
  }

  /* Save As form — right-aligned, replaces default footer */
  .prompt-footer-save-as {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    width: 100%;
  }

  .prompt-name-input {
    padding: 4px 8px;
    border: 1px solid var(--vscode-input-border);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border-radius: 4px;
    font-size: 12px;
    width: 150px;
  }

  .prompt-name-input:focus {
    outline: none;
    border-color: var(--vscode-focusBorder);
  }

  /* Saved feedback */
  .prompt-saved-feedback {
    font-size: 12px;
    color: var(--vscode-terminal-ansiGreen, #89d185);
    opacity: 0;
    transition: opacity 0.2s ease;
  }

  .prompt-saved-feedback.visible {
    opacity: 1;
  }
`;
