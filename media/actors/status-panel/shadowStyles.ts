/**
 * StatusPanelShadowActor styles
 * Shadow DOM encapsulated styles for the status panel
 * Matches the old chat.css design with light blue background
 */
export const statusPanelShadowStyles = `
/* Container - matches old .status-panel styling */
.status-panel {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  min-height: 32px;
  max-height: 32px;
  padding: 0 2px;
  border-radius: 4px;
  background: rgba(79, 195, 247, 0.08); /* Light blue background */
  border: 1px solid rgba(79, 195, 247, 0.2);
  overflow: visible; /* Allow water spurt animation to show above panel */
  box-sizing: border-box;
  min-width: 120px;
  flex: 1;
}

/* Moby whale icon */
.moby {
  position: relative;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.moby img {
  width: 18px;
  height: 18px;
  object-fit: contain;
}

/* Water spurt container */
.water-spurt {
  position: absolute;
  top: -8px;
  left: 50%;
  transform: translateX(-50%);
  width: 24px;
  height: 12px;
  pointer-events: none;
}

.droplet {
  position: absolute;
  bottom: 0;
  width: 3px;
  height: 3px;
  background: var(--vscode-terminal-ansiBrightCyan, #4fc3f7);
  border-radius: 50%;
  opacity: 0;
}

/* Spurt animation */
@keyframes spurt {
  0% {
    transform: translateY(0) scale(1);
    opacity: 1;
  }
  100% {
    transform: translateY(-16px) scale(0.3);
    opacity: 0;
  }
}

.moby.spurting .droplet {
  animation: spurt 0.6s ease-out forwards;
}

.moby.spurting .droplet:nth-child(1) { animation-delay: 0ms; left: 3px; }
.moby.spurting .droplet:nth-child(2) { animation-delay: 50ms; left: 10px; }
.moby.spurting .droplet:nth-child(3) { animation-delay: 100ms; left: 17px; }
.moby.spurting .droplet:nth-child(4) { animation-delay: 75ms; left: 6px; }
.moby.spurting .droplet:nth-child(5) { animation-delay: 125ms; left: 14px; }

/* Colored spurt variants */
.moby.spurt-blue .droplet {
  background: var(--vscode-terminal-ansiBrightCyan, #4fc3f7);
}

.moby.spurt-yellow .droplet {
  background: var(--vscode-editorWarning-foreground, #cca700);
}

.moby.spurt-red .droplet {
  background: var(--vscode-errorForeground, #f48771);
}

/* Left panel */
.left-panel {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0; /* Allow text truncation */
  overflow: hidden;
}

.messages {
  flex: 1;
  font-size: 13px;
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  cursor: default; /* Show tooltip on hover */
}

/* Separator */
.separator {
  width: 2px;
  height: 20px;
  background: var(--vscode-panel-border);
  cursor: col-resize;
  flex-shrink: 0;
  position: relative;
  margin: 0 3px;
  opacity: 0.6;
  transition: background 0.15s ease, width 0.15s ease, opacity 0.15s ease;
}

.separator:hover {
  background: var(--vscode-focusBorder);
  width: 3px;
  opacity: 1;
}

.separator::after {
  content: '';
  position: absolute;
  top: -4px;
  bottom: -4px;
  left: -3px;
  right: -3px;
  /* Invisible hit area for easier grabbing */
}

/* Right panel */
.right-panel {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  justify-content: flex-start;
  min-width: 0;
  overflow: hidden;
  border: 1px solid transparent;
  border-radius: 3px;
  box-sizing: border-box;
  padding: 2px 4px;
  transition: background 0.2s ease, border-color 0.2s ease;
}

.right-panel.warning-bg {
  background: rgba(249, 168, 37, 0.15);
  border-color: rgba(249, 168, 37, 0.5);
}

.right-panel.error-bg {
  background: rgba(231, 72, 86, 0.15);
  border-color: rgba(231, 72, 86, 0.5);
}

.warnings {
  flex: 1;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  min-width: 0;
  cursor: default; /* Show tooltip on hover */
  padding: 0 5px;
  color: var(--vscode-descriptionForeground);
}

.warnings.warning {
  color: var(--vscode-editorWarning-foreground, #f9a825);
}

.warnings.error {
  color: var(--vscode-errorForeground, #e74856);
}

/* Logs button */
.logs-btn {
  width: 24px;
  height: 24px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--vscode-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 3px;
  cursor: pointer;
  opacity: 0.6;
  transition: all 0.15s;
  flex-shrink: 0;
}

.logs-btn:hover {
  opacity: 1;
  background: var(--vscode-toolbar-hoverBackground);
}

.logs-btn svg {
  width: 14px;
  height: 14px;
}
`;
