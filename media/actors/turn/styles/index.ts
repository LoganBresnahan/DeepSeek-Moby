/**
 * MessageTurnActor Combined Styles
 *
 * All styles for the different container types within a turn.
 * Each container type has its own shadow root with these styles adopted.
 * Styles are namespaced by container class to avoid conflicts.
 *
 * Container Types:
 * - .text-container: Text message segments
 * - .thinking-container: Chain-of-thought reasoning
 * - .tools-container: Tool call execution
 * - .shell-container: Shell command execution
 * - .pending-container: Pending file changes
 */

// ============================================
// Base Styles (shared across all containers)
// ============================================

const baseStyles = `
/* Container base - all containers inherit this */
.container {
  margin: 8px 0;
  font-family: var(--vscode-font-family);
  font-size: 13px;
  line-height: 1.4;
}

.container.entering {
  animation: fadeIn 0.3s ease-out forwards;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}

/* Scrollbar styling */
.scrollable::-webkit-scrollbar {
  width: 8px;
}

.scrollable::-webkit-scrollbar-track {
  background: transparent;
}

.scrollable::-webkit-scrollbar-thumb {
  background: var(--vscode-scrollbarSlider-background);
  border-radius: 4px;
}

.scrollable::-webkit-scrollbar-thumb:hover {
  background: var(--vscode-scrollbarSlider-hoverBackground);
}
`;

// ============================================
// Text Message Styles
// ============================================

const textStyles = `
/* Text container - message content */
.text-container {
  /* No border for text, flows naturally */
}

.text-container.streaming {
  /* Active streaming indicator */
}

.text-container.continuation {
  margin-top: 8px;
}

/* Role divider — left-aligned label */
.message-divider {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 5px;
}

.message-divider-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--vscode-descriptionForeground, #8b8b8b);
}

/* User message content in italics to distinguish from assistant */
.message.user .content {
  font-style: italic;
}

/* Fork button — hidden by default, visible on host hover */
.fork-btn {
  background: transparent;
  border: none;
  color: var(--vscode-descriptionForeground, #8b8b8b);
  cursor: pointer;
  font-size: 16px;
  padding: 0 2px;
  opacity: 0;
  transition: opacity 0.15s ease;
}
:host(:hover) .fork-btn {
  opacity: 0.6;
}
.fork-btn:hover {
  opacity: 1 !important;
  color: var(--vscode-foreground);
}

/* Hide divider for continuation segments */
.text-container.continuation .message-divider {
  display: none;
}

/* Message content */
.content {
  font-size: 13px;
  line-height: 1.6;
  color: var(--vscode-editor-foreground, #cccccc);
  word-wrap: break-word;
  overflow-wrap: break-word;
  padding: 0;
}

/* File attachments */
.files {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.file-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: var(--vscode-badge-background, #4d4d4d);
  color: var(--vscode-badge-foreground, #ffffff);
  border-radius: 4px;
  font-size: 11px;
}

/* Code blocks */
.code-block {
  margin: 0 0 12px 0;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  overflow: hidden;
  background: var(--vscode-textCodeBlock-background, #1e1e1e);
}

.code-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--vscode-editorWidget-background);
  border-bottom: 1px solid var(--vscode-panel-border);
  cursor: pointer;
  user-select: none;
  transition: background 0.15s ease;
}

.code-header:hover {
  /* hover highlight removed — clickable affordance provided by cursor: pointer */
}

.code-toggle {
  font-size: 10px;
  color: var(--vscode-foreground);
  transition: transform 0.2s ease;
  flex-shrink: 0;
}

.code-block.expanded .code-toggle {
  transform: rotate(90deg);
}

.code-lang {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  text-transform: uppercase;
  flex-shrink: 0;
}

.code-preview {
  flex: 1;
  font-family: var(--vscode-editor-font-family);
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.7;
}

.code-block.expanded .code-preview {
  display: none;
}

.code-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
  margin-left: auto;
}

.code-action-btn {
  padding: 2px 8px;
  border: none;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border-radius: 3px;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.code-action-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.code-action-btn.copy-btn.copied {
  background: var(--vscode-terminal-ansiGreen);
  color: var(--vscode-editor-background);
}

.code-action-btn.diff-btn.active {
  background: var(--vscode-terminal-ansiBlue);
  color: var(--vscode-editor-background);
}

.code-action-btn.apply-btn {
  opacity: 0.4;
  pointer-events: none;
}

.code-block.diffed .code-action-btn.apply-btn {
  opacity: 1;
  pointer-events: auto;
  background: var(--vscode-terminal-ansiGreen);
  color: var(--vscode-editor-background);
}

/* Permanent applied state */
.code-block.applied .code-action-btn.apply-btn {
  opacity: 1;
  pointer-events: none;
  background: var(--vscode-terminal-ansiGreen);
  color: var(--vscode-editor-background);
  cursor: default;
}

.code-block.applied .code-action-btn.diff-btn {
  opacity: 0.4;
  pointer-events: none;
  cursor: default;
}

/* Hide diff/apply buttons when not in manual mode */
.code-block[data-edit-mode="ask"] .diff-btn,
.code-block[data-edit-mode="ask"] .apply-btn,
.code-block[data-edit-mode="auto"] .diff-btn,
.code-block[data-edit-mode="auto"] .apply-btn {
  display: none;
}

.code-body {
  position: relative;
  max-height: 50px;
  overflow: hidden;
  transition: max-height 0.3s ease;
}

.code-body::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 30px;
  background: linear-gradient(transparent, var(--vscode-textCodeBlock-background, #1e1e1e));
  pointer-events: none;
  opacity: 1;
  transition: opacity 0.2s ease;
}

.code-block.expanded .code-body {
  max-height: 500px;
  overflow-y: auto;
}

.code-block.expanded .code-body::after {
  opacity: 0;
}

.code-body pre {
  margin: 0;
  padding: 12px;
  overflow-x: auto;
}

.code-body code {
  font-family: var(--vscode-editor-font-family);
  font-size: var(--vscode-editor-font-size, 13px);
  line-height: 1.5;
  white-space: pre;
}

code.inline-code {
  padding: 2px 6px;
  background: var(--vscode-textCodeBlock-background);
  border-radius: 3px;
  font-family: var(--vscode-editor-font-family);
  font-size: 0.9em;
}

/* Code generating placeholder — shown while a code block is being streamed */
.code-generating {
  position: relative;
  height: 22px;
  margin: 10px 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.code-gen-moby {
  position: relative;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.code-gen-moby img {
  width: 16px;
  height: 16px;
  object-fit: contain;
  filter: brightness(0) invert(1);
  opacity: 0.85;
}

.code-gen-spurt {
  position: absolute;
  top: -6px;
  left: 50%;
  transform: translateX(-50%);
  width: 20px;
  height: 10px;
  pointer-events: none;
}

.code-gen-spurt .drop {
  position: absolute;
  bottom: 0;
  width: 2px;
  height: 2px;
  background: #ffffff;
  border-radius: 50%;
  opacity: 0;
  animation: codeSpurt 1.5s ease-out infinite;
}

.code-gen-spurt .drop:nth-child(1) { animation-delay: 0ms; left: 2px; }
.code-gen-spurt .drop:nth-child(2) { animation-delay: 150ms; left: 8px; }
.code-gen-spurt .drop:nth-child(3) { animation-delay: 300ms; left: 14px; }
.code-gen-spurt .drop:nth-child(4) { animation-delay: 200ms; left: 5px; }
.code-gen-spurt .drop:nth-child(5) { animation-delay: 350ms; left: 11px; }

@keyframes codeSpurt {
  0% { opacity: 0.9; transform: translateY(0) scale(1); }
  40% { transform: translateY(-14px) scale(0.3); opacity: 0; }
  100% { opacity: 0; }
}

.code-gen-phrases {
  position: relative;
  flex: 1;
  height: 22px;
}

.gen-phrase {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  opacity: 0;
  font-style: italic;
  font-size: 13px;
  letter-spacing: 0.3px;
}

.gp-1 { animation: cyclePhrase 4.5s ease-in-out infinite; }
.gp-2 { animation: cyclePhrase 4.5s ease-in-out 1.5s infinite; }
.gp-3 { animation: cyclePhrase 4.5s ease-in-out 3s infinite; }

@keyframes cyclePhrase {
  0% { opacity: 0; }
  6.67% { opacity: 1; }
  27.78% { opacity: 1; }
  33.33% { opacity: 0; }
  100% { opacity: 0; }
}

.gc {
  display: inline-block;
  color: var(--vscode-descriptionForeground);
  animation: charWave 1.8s ease-in-out infinite;
  animation-delay: calc(var(--d) * 0.07s);
}

@keyframes charWave {
  0%, 100% { transform: translateY(0); opacity: 0.5; }
  50% { transform: translateY(-2px); opacity: 1; }
}
`;

// ============================================
// Thinking Styles
// ============================================

const thinkingStyles = `
/* Thinking container - dotted border on host */
:host(.thinking-container) {
  display: block;
  margin: 8px 0;
  border: 1px dotted var(--vscode-panel-border);
  border-radius: 4px;
}

:host(.thinking-container:hover) .thinking-header {
  /* hover highlight removed */
}

.thinking-header {
  display: flex;
  align-items: center;
  padding: 6px 10px;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}

.thinking-toggle {
  color: var(--vscode-descriptionForeground);
  font-family: monospace;
  font-weight: bold;
  width: 12px;
  flex-shrink: 0;
}

.thinking-emoji {
  flex-shrink: 0;
}

.thinking-label {
  color: var(--vscode-foreground);
  font-weight: 500;
}

.thinking-preview {
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  font-size: 12px;
}

.thinking-body {
  display: none;
  padding: 8px 10px 10px 30px;
  border-top: 1px dotted var(--vscode-panel-border);
  max-height: 300px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  line-height: 1.5;
}

:host(.thinking-container.expanded) .thinking-body {
  display: block;
}

.thinking-body:empty {
  display: none;
}

:host(.thinking-container.streaming) .thinking-emoji {
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}
`;

// ============================================
// Tool Calls Styles
// ============================================

const toolsStyles = `
/* Tools container - dotted border on host */
:host(.tools-container) {
  display: block;
  margin: 8px 0;
  border: 1px dotted var(--vscode-panel-border);
  border-radius: 4px;
}

:host(.tools-container:hover) .tools-header {
  /* hover highlight removed */
}

.tools-header {
  display: flex;
  align-items: center;
  padding: 6px 10px;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}

.tools-toggle {
  color: var(--vscode-descriptionForeground);
  font-family: monospace;
  font-weight: bold;
  width: 12px;
  flex-shrink: 0;
}

.tools-icon {
  flex-shrink: 0;
}

.tools-title {
  color: var(--vscode-foreground);
  font-weight: 500;
}

.tools-preview {
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  font-size: 12px;
}

.tools-count {
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  flex-shrink: 0;
}

.tools-body {
  display: none;
  padding: 8px 10px;
  border-top: 1px dotted var(--vscode-panel-border);
}

:host(.tools-container.expanded) .tools-body {
  display: block;
}

.tools-body:empty {
  display: none;
}

.tool-item {
  padding: 4px 0;
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.tool-tree {
  color: var(--vscode-panel-border);
  font-family: monospace;
  flex-shrink: 0;
}

.tool-status {
  flex-shrink: 0;
  width: 14px;
  text-align: center;
}

.tool-item[data-status="pending"] .tool-status {
  color: var(--vscode-descriptionForeground);
}

.tool-item[data-status="running"] .tool-status {
  color: var(--vscode-terminal-ansiYellow);
}

.tool-item[data-status="done"] .tool-status {
  color: var(--vscode-terminal-ansiGreen);
}

.tool-item[data-status="error"] .tool-status {
  color: var(--vscode-errorForeground);
}

.tool-name {
  color: var(--vscode-foreground);
  font-weight: 500;
  flex-shrink: 0;
}

.tool-detail {
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
}

:host(.tools-container.complete) {
  opacity: 0.85;
}

:host(.tools-container.complete:hover) {
  opacity: 1;
}

:host(.tools-container.has-errors) .tools-title {
  color: var(--vscode-errorForeground);
}
`;

// ============================================
// Shell Execution Styles
// ============================================

const shellStyles = `
/* Shell container - dotted border on host */
:host(.shell-container) {
  display: block;
  margin: 8px 0;
  border: 1px dotted var(--vscode-panel-border);
  border-radius: 4px;
}

:host(.shell-container:hover) .shell-header {
  /* hover highlight removed */
}

.shell-header {
  display: flex;
  align-items: center;
  padding: 6px 10px;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}

.shell-toggle {
  color: var(--vscode-descriptionForeground);
  font-family: monospace;
  font-weight: bold;
  width: 12px;
  flex-shrink: 0;
}

.shell-icon {
  flex-shrink: 0;
}

:host(.shell-container:not(.complete)) .shell-icon {
  animation: shell-pulse 1.5s ease-in-out infinite;
}

@keyframes shell-pulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}

.shell-title {
  color: var(--vscode-foreground);
  font-weight: 500;
}

.shell-preview {
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  font-size: 12px;
}

.shell-header-status {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.shell-body {
  display: none;
  padding: 8px 10px;
  border-top: 1px dotted var(--vscode-panel-border);
}

:host(.shell-container.expanded) .shell-body {
  display: block;
}

.shell-body:empty {
  display: none;
}

.shell-item {
  padding: 4px 0;
}

.shell-item-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.shell-tree {
  color: var(--vscode-panel-border);
  font-family: monospace;
  flex-shrink: 0;
}

.shell-status {
  flex-shrink: 0;
  width: 14px;
  text-align: center;
}

.shell-item[data-status="pending"] .shell-status {
  color: var(--vscode-descriptionForeground);
}

.shell-item[data-status="running"] .shell-status {
  color: var(--vscode-terminal-ansiYellow);
}

.shell-item[data-status="done"] .shell-status {
  color: var(--vscode-terminal-ansiGreen);
}

.shell-item[data-status="error"] .shell-status {
  color: var(--vscode-errorForeground);
}

.shell-command {
  color: var(--vscode-foreground);
  font-family: var(--vscode-editor-font-family);
  font-size: 12px;
}

.shell-output {
  background: var(--vscode-textCodeBlock-background);
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 11px;
  margin: 4px 0 4px 22px;
  max-height: 150px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--vscode-descriptionForeground);
  font-family: var(--vscode-editor-font-family);
}

.shell-output:empty {
  display: none;
}

.shell-output .success {
  color: var(--vscode-terminal-ansiGreen);
}

.shell-output .error {
  color: var(--vscode-errorForeground);
}

:host(.shell-container.complete) {
  opacity: 0.85;
}

:host(.shell-container.complete:hover) {
  opacity: 1;
}

:host(.shell-container.has-errors) .shell-title {
  color: var(--vscode-errorForeground);
}
`;

// ============================================
// Pending Files Styles
// ============================================

const pendingStyles = `
/* Pending container - dotted border on host */
:host(.pending-container) {
  display: block;
  margin: 8px 0;
  border: 1px dotted var(--vscode-panel-border);
  border-radius: 4px;
}

:host(.pending-container:hover) .pending-header {
  /* hover highlight removed */
}

.pending-header {
  display: flex;
  align-items: center;
  padding: 6px 10px;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}

.pending-toggle {
  color: var(--vscode-descriptionForeground);
  font-family: monospace;
  font-weight: bold;
  width: 12px;
  flex-shrink: 0;
}

.pending-icon {
  flex-shrink: 0;
}

.pending-title {
  color: var(--vscode-foreground);
  font-weight: 500;
}

.pending-preview {
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  font-size: 12px;
}

.pending-count {
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  flex-shrink: 0;
}

.pending-body {
  display: none;
  padding: 8px 10px;
  border-top: 1px dotted var(--vscode-panel-border);
}

:host(.pending-container.expanded) .pending-body {
  display: block;
}

.pending-body:empty {
  display: none;
}

.pending-item {
  padding: 4px 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.pending-tree {
  color: var(--vscode-panel-border);
  font-family: monospace;
  flex-shrink: 0;
}

.pending-status {
  flex-shrink: 0;
  width: 14px;
  text-align: center;
}

.pending-status.pending {
  color: var(--vscode-terminal-ansiYellow);
}

.pending-status.applied {
  color: var(--vscode-terminal-ansiGreen);
}

.pending-status.rejected {
  color: var(--vscode-errorForeground);
}

.pending-status.superseded {
  color: var(--vscode-descriptionForeground);
}

.pending-status.error {
  color: var(--vscode-errorForeground);
}

.pending-file {
  color: var(--vscode-textLink-foreground);
  cursor: pointer;
}

.pending-file:hover {
  text-decoration: underline;
}

.pending-file.no-click {
  cursor: default;
  color: var(--vscode-descriptionForeground);
}

.pending-file.no-click:hover {
  text-decoration: none;
}

.pending-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}

.pending-btn {
  padding: 2px 6px;
  border: none;
  background: none;
  cursor: pointer;
  font-family: inherit;
  font-size: 12px;
  border-radius: 3px;
}

.pending-btn.accept-btn {
  color: var(--vscode-terminal-ansiGreen);
}

.pending-btn.accept-btn:hover {
  background: var(--vscode-list-hoverBackground);
}

.pending-btn.reject-btn {
  color: var(--vscode-errorForeground);
}

.pending-btn.reject-btn:hover {
  background: var(--vscode-list-hoverBackground);
}

.pending-label {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  margin-left: auto;
}

.pending-label.auto-applied {
  color: var(--vscode-charts-green, #89d185);
}

.pending-label.error {
  color: var(--vscode-errorForeground);
}

.pending-status.deleted {
  color: var(--vscode-errorForeground);
}

.pending-label.deleted {
  color: var(--vscode-errorForeground);
}

.pending-item[data-status="deleted"] .pending-file {
  text-decoration: line-through;
  opacity: 0.7;
}

.pending-status.expired {
  color: var(--vscode-disabledForeground);
}

.pending-label.expired {
  color: var(--vscode-disabledForeground);
}

.pending-item[data-status="expired"] .pending-file {
  opacity: 0.6;
}

.pending-item[data-superseded="true"] {
  opacity: 0.6;
}

.pending-item[data-superseded="true"] .pending-file {
  text-decoration: line-through;
  color: var(--vscode-descriptionForeground);
}

:host(.pending-container.auto-mode) .pending-item {
  padding: 4px 0;
}
`;

// ============================================
// Command Approval Styles
// ============================================

const approvalStyles = `
/* Approval container */
:host(.approval-container) {
  display: block;
  margin: 8px 0;
  border: 1px solid var(--vscode-terminal-ansiYellow, #cca700);
  border-radius: 6px;
  overflow: hidden;
  background: var(--vscode-editorWidget-background, #252526);
}

:host(.approval-container.resolved) {
  border-color: var(--vscode-panel-border);
  opacity: 0.85;
}

:host(.approval-container.resolved:hover) {
  opacity: 1;
}

:host(.approval-container.allowed) {
  border-color: var(--vscode-terminal-ansiGreen, #89d185);
}

:host(.approval-container.blocked) {
  border-color: var(--vscode-errorForeground, #f48771);
}

.approval-header {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  gap: 8px;
}

.approval-header .approval-icon {
  flex-shrink: 0;
  font-size: 14px;
}

.approval-header .approval-title {
  color: var(--vscode-foreground);
  font-weight: 500;
  font-size: 13px;
}

.approval-header .approval-title code {
  font-family: var(--vscode-editor-font-family);
  font-size: 12px;
  padding: 1px 4px;
  background: var(--vscode-textCodeBlock-background);
  border-radius: 3px;
}

.approval-header.resolved .approval-title {
  font-weight: 400;
}

.approval-command {
  padding: 6px 12px 8px;
  border-top: 1px solid var(--vscode-panel-border);
  background: var(--vscode-textCodeBlock-background, #1e1e1e);
}

.approval-command code {
  font-family: var(--vscode-editor-font-family);
  font-size: 12px;
  color: var(--vscode-terminal-foreground, #cccccc);
  white-space: pre-wrap;
  word-break: break-all;
}

.approval-command .unknown-subcmd {
  background: rgba(204, 167, 0, 0.2);
  border-bottom: 2px solid var(--vscode-terminal-ansiYellow, #cca700);
  padding: 1px 2px;
  border-radius: 2px;
}

.approval-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 12px;
  border-top: 1px solid var(--vscode-panel-border);
}

.approval-btn {
  padding: 4px 10px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  font-size: 12px;
  font-family: var(--vscode-font-family);
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-button-secondaryForeground, #cccccc);
}

.approval-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground, #45494e);
}

.approval-btn.allow-once {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #ffffff);
  border-color: var(--vscode-button-background, #0e639c);
}

.approval-btn.allow-once:hover {
  background: var(--vscode-button-hoverBackground, #1177bb);
}

.approval-btn.always-allow {
  color: var(--vscode-terminal-ansiGreen, #89d185);
  border-color: var(--vscode-terminal-ansiGreen, #89d185);
}

.approval-btn.always-block {
  color: var(--vscode-errorForeground, #f48771);
  border-color: var(--vscode-errorForeground, #f48771);
}
`;

// ============================================
// Drawing Styles
// ============================================

const drawingStyles = `
/* Drawing container */
:host(.drawing-container) {
  display: block;
  margin: 8px 0;
}

.drawing-wrapper {
  display: inline-block;
  position: relative;
}

.drawing-image {
  max-width: 100%;
  max-height: 400px;
  border-radius: 8px;
  border: 1px solid var(--vscode-panel-border);
  object-fit: contain;
  background: #ffffff;
  cursor: pointer;
}

.drawing-context-menu {
  position: absolute;
  background: var(--vscode-menu-background, var(--vscode-dropdown-background));
  border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, #454545));
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
  padding: 4px 0;
  z-index: 10000;
  min-width: 140px;
}

.drawing-context-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: 13px;
  color: var(--vscode-menu-foreground, var(--vscode-foreground));
  cursor: pointer;
}

.drawing-context-menu-item:hover {
  background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
  color: var(--vscode-menu-selectionForeground, var(--vscode-foreground));
}
`;

// ============================================
// Syntax Highlighting (imported)
// ============================================

import { syntaxHighlightStyles } from '../../../utils/syntaxHighlight';

// ============================================
// Export Combined Styles
// ============================================

export const turnActorStyles = `
${baseStyles}
${textStyles}
${thinkingStyles}
${toolsStyles}
${shellStyles}
${pendingStyles}
${approvalStyles}
${drawingStyles}
${syntaxHighlightStyles}
`;
