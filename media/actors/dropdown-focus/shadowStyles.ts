/**
 * DropdownFocusActor styles
 *
 * Styles for the sticky hover ghost and modal overlay system.
 * These are injected into the light DOM since this actor operates
 * outside of Shadow DOM boundaries.
 */
export const dropdownFocusStyles = `
/* ============================================
   Sticky Ghost Element
   ============================================ */

.dropdown-ghost {
  position: fixed;
  z-index: 1000;
  pointer-events: auto;
  opacity: 0.95;
  transform: scale(1.02);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  border-radius: 6px;
  transition: opacity 0.15s ease, transform 0.15s ease;
  max-width: calc(100vw - 40px);
}

.dropdown-ghost.entering {
  animation: ghostAppear 0.2s ease-out forwards;
}

.dropdown-ghost.exiting {
  animation: ghostDisappear 0.15s ease-in forwards;
}

@keyframes ghostAppear {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 0.95;
    transform: scale(1.02);
  }
}

@keyframes ghostDisappear {
  from {
    opacity: 0.95;
    transform: scale(1.02);
  }
  to {
    opacity: 0;
    transform: scale(0.95);
  }
}

/* ============================================
   Modal Overlay
   ============================================ */

.dropdown-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2000;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.dropdown-modal-overlay.visible {
  opacity: 1;
}

.dropdown-modal-overlay.closing {
  opacity: 0;
  pointer-events: none;
}

/* ============================================
   Modal Container
   ============================================ */

.dropdown-modal {
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  max-width: 90vw;
  height: 80vh;  /* Fixed height - opens at max size, content scrolls */
  width: 600px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transform: scale(0.95) translateY(10px);
  transition: transform 0.2s ease;
}

.dropdown-modal-overlay.visible .dropdown-modal {
  transform: scale(1) translateY(0);
}

/* ============================================
   Modal Header (cloned dropdown header)
   ============================================ */

.dropdown-modal-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: var(--vscode-editorWidget-background);
  border-bottom: 1px solid var(--vscode-panel-border);
  flex-shrink: 0;
}

.dropdown-modal-header .icon {
  font-size: 10px;
  color: var(--vscode-foreground);
  transform: rotate(90deg);
}

.dropdown-modal-header .emoji {
  font-size: 14px;
}

.dropdown-modal-header .label {
  flex: 1;
  font-size: 12px;
  font-weight: 500;
  color: var(--vscode-foreground);
}

/* Type-specific header colors */
.dropdown-modal[data-type="thinking"] {
  border-left: 3px solid var(--vscode-symbolIcon-classForeground, #ee9d28);
}

.dropdown-modal[data-type="shell"] {
  border-left: 3px solid var(--vscode-terminal-ansiGreen, #23d18b);
}

.dropdown-modal[data-type="code"] {
  border-left: 3px solid var(--vscode-terminal-ansiBlue, #3b8eea);
}

/* ============================================
   Modal Body (scrollable content)
   ============================================ */

.dropdown-modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--vscode-descriptionForeground);
  white-space: pre-wrap;
  word-break: break-word;
}

/* Code in modal body */
.dropdown-modal-body pre {
  background: var(--vscode-textCodeBlock-background);
  padding: 8px;
  border-radius: 4px;
  margin: 8px 0;
  overflow-x: auto;
}

.dropdown-modal-body code {
  font-family: var(--vscode-editor-font-family);
  font-size: 11px;
}

/* Shell command items in modal */
.dropdown-modal-body .command-item {
  padding: 8px 0;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.dropdown-modal-body .command-item:last-child {
  border-bottom: none;
}

.dropdown-modal-body .command-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--vscode-editor-font-family);
  font-size: 12px;
  color: var(--vscode-foreground);
}

.dropdown-modal-body .command-status {
  font-size: 12px;
}

.dropdown-modal-body .command-output {
  margin-top: 8px;
  padding: 8px;
  background: var(--vscode-textCodeBlock-background);
  border-radius: 4px;
  font-family: var(--vscode-editor-font-family);
  font-size: 11px;
  white-space: pre-wrap;
  max-height: 200px;
  overflow-y: auto;
}

/* ============================================
   Modal Footer (navigation buttons)
   ============================================ */

.dropdown-modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  background: var(--vscode-editorWidget-background);
  border-top: 1px solid var(--vscode-panel-border);
  flex-shrink: 0;
}

.dropdown-modal-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease, transform 0.1s ease;
}

.dropdown-modal-btn:hover {
  transform: translateY(-1px);
}

.dropdown-modal-btn:active {
  transform: translateY(0);
}

.dropdown-modal-btn.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.dropdown-modal-btn.primary:hover {
  background: var(--vscode-button-hoverBackground);
}

.dropdown-modal-btn.secondary {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}

.dropdown-modal-btn.secondary:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

/* Button icons */
.dropdown-modal-btn .btn-icon {
  font-size: 14px;
}

/* ============================================
   Streaming indicator in modal
   ============================================ */

.dropdown-modal.streaming .dropdown-modal-header .emoji {
  animation: modalPulse 1.5s ease-in-out infinite;
}

@keyframes modalPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* ============================================
   Scrollbar styling
   ============================================ */

.dropdown-modal-body::-webkit-scrollbar {
  width: 8px;
}

.dropdown-modal-body::-webkit-scrollbar-track {
  background: transparent;
}

.dropdown-modal-body::-webkit-scrollbar-thumb {
  background: var(--vscode-scrollbarSlider-background);
  border-radius: 4px;
}

.dropdown-modal-body::-webkit-scrollbar-thumb:hover {
  background: var(--vscode-scrollbarSlider-hoverBackground);
}
`;
