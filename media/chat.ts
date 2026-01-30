/**
 * Chat Entry Point - Hybrid Actor Integration
 *
 * This file integrates the actor system with the existing HTML structure.
 * Actors handle rendering (messages, shell commands, thinking, etc.)
 * Legacy code handles input and UI controls (model dropdown, sliders, file modal)
 */

import { EventStateManager } from './state/EventStateManager';
import {
  StreamingActor,
  MessageActor,
  ScrollActor,
  ShellActor,
  ToolCallsActor,
  ThinkingActor,
  PendingChangesActor
} from './actors';

// ============================================
// VS Code API Types
// ============================================

interface VSCodeAPI {
  postMessage(message: unknown): void;
  getState(): Record<string, unknown> | undefined;
  setState(state: Record<string, unknown>): void;
}

declare function acquireVsCodeApi(): VSCodeAPI;

// ============================================
// Global State
// ============================================

let isStreaming = false;
let isReasonerMode = false;
let currentModel = 'deepseek-chat';
let editMode: 'manual' | 'ask' | 'auto' = 'manual';
let currentShellSegmentId: string | null = null;
const editModes = ['manual', 'ask', 'auto'];
const editModeLabels: Record<string, string> = {
  manual: 'Manual',
  ask: 'Ask before applying',
  auto: 'Auto-apply'
};

// File selection state
const selectedFiles = new Map<string, string>();
let pendingAttachments: Array<{ content: string; name: string; size: number }> = [];

// Web search state
let webSearchEnabled = false;
const webSearchSettings = {
  searchesPerPrompt: 3,
  searchDepth: 'basic' as 'basic' | 'advanced'
};

// Commands for help modal
const commands = [
  { section: 'Chat' },
  { id: 'newChat', name: 'New Chat', desc: 'Start a new conversation', icon: '✨' },
  { section: 'History' },
  { id: 'showChatHistory', name: 'Show History', desc: 'View chat history', icon: '📚' },
  { id: 'exportChatHistory', name: 'Export History', desc: 'Export all chats', icon: '📤' },
  { id: 'searchChatHistory', name: 'Search History', desc: 'Search past chats', icon: '🔍' },
  { section: 'Other' },
  { id: 'showStats', name: 'Show Stats', desc: 'View usage statistics', icon: '📊' },
  { id: 'showLogs', name: 'Show Logs', desc: 'View extension logs', icon: '📋' }
] as const;

// Content segmentation state for interleaved rendering
// This tracks content per segment to support text->tools->text ordering
let currentSegmentContent = '';
let hasInterleavedContent = false; // True after tools/shell interrupt text

// ============================================
// DOM Elements
// ============================================

function getElement<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element #${id} not found`);
  return el as T;
}

function getElementOrNull<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// ============================================
// Initialize Actor System
// ============================================

function initializeActorSystem(): void {
  const vscode = acquireVsCodeApi();

  // Get required DOM elements
  const chatMessages = getElement<HTMLDivElement>('chatMessages');
  const messageInput = getElement<HTMLTextAreaElement>('messageInput');
  const sendBtn = getElement<HTMLButtonElement>('sendBtn');
  const stopBtn = getElement<HTMLButtonElement>('stopBtn');

  // Create the event state manager
  const manager = new EventStateManager();

  // Create a hidden streaming root (StreamingActor needs an element but doesn't render visible content)
  const streamingRoot = document.createElement('div');
  streamingRoot.id = 'streamingRoot';
  streamingRoot.style.display = 'none';
  document.body.appendChild(streamingRoot);

  // Initialize actors
  const streaming = new StreamingActor(manager, streamingRoot);
  const message = new MessageActor(manager, chatMessages);
  const scroll = new ScrollActor(manager, chatMessages);

  // ShellActor - uses chatMessages directly, creates segment elements dynamically
  const shell = new ShellActor(manager, chatMessages);

  // ToolCallsActor - uses chatMessages directly, creates batch elements dynamically
  const toolCalls = new ToolCallsActor(manager, chatMessages);

  // ThinkingActor - uses chatMessages directly, creates iteration elements dynamically
  // This allows thinking to appear inline with the response flow
  const thinking = new ThinkingActor(manager, chatMessages);

  // PendingChangesActor - uses chatMessages directly, creates elements dynamically
  const pending = new PendingChangesActor(manager, chatMessages);

  // Set up pending files action handler
  pending.onAction((fileId, action) => {
    vscode.postMessage({
      type: 'pendingFileAction',
      fileId,
      action
    });
  });

  // Sync initial edit mode
  pending.setEditMode(editMode);

  // ============================================
  // Input Handling (Direct DOM - not using InputActor)
  // ============================================

  function sendMessage(): void {
    const content = messageInput.value.trim();
    if ((!content && pendingAttachments.length === 0) || isStreaming) return;

    // Add user message to UI immediately
    const fileNames = pendingAttachments.map(a => a.name);
    if (selectedFiles.size > 0) {
      fileNames.push(...Array.from(selectedFiles.keys()));
    }
    message.addUserMessage(content, fileNames.length > 0 ? fileNames : undefined);

    // Clear input
    messageInput.value = '';
    messageInput.style.height = 'auto';

    // Send to backend
    vscode.postMessage({
      type: 'sendMessage',
      message: content,
      attachments: pendingAttachments.length > 0 ? pendingAttachments : undefined
    });

    // Clear attachments after sending
    pendingAttachments = [];
    const attachmentsContainer = getElementOrNull<HTMLDivElement>('attachments');
    if (attachmentsContainer) attachmentsContainer.innerHTML = '';
  }

  function stopGeneration(): void {
    vscode.postMessage({ type: 'stopGeneration' });
  }

  // Input event handlers
  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn.addEventListener('click', sendMessage);
  stopBtn.addEventListener('click', stopGeneration);

  // ============================================
  // VS Code Message Handlers
  // ============================================

  window.addEventListener('message', (event) => {
    const msg = event.data;
    console.log('[ActorSystem] Received:', msg.type);

    switch (msg.type) {
      // ---- Streaming Messages ----
      case 'startResponse':
        isStreaming = true;
        isReasonerMode = msg.isReasoner || false;

        // Reset segment state for new response
        currentSegmentContent = '';
        hasInterleavedContent = false;

        streaming.startStream(msg.messageId || `msg-${Date.now()}`, currentModel);

        // Toggle buttons
        sendBtn.style.display = 'none';
        stopBtn.style.display = 'flex';

        // NOTE: Don't call thinking.startIteration() here - let it be created
        // when actual thinking content arrives (via streaming.thinking or iterationStart).
        // This ensures thinking appears inline with the response flow, not at the top.
        break;

      case 'streamToken':
        // Check if we need to start a new segment after tools/shell interrupted
        if (message.needsNewSegment()) {
          message.resumeWithNewSegment();
          currentSegmentContent = '';
        }

        // Track content for the current segment
        currentSegmentContent += msg.token;

        // In reasoner mode, strip shell tags before displaying (they're handled separately)
        const displayContent = isReasonerMode
          ? currentSegmentContent.replace(/<shell>[\s\S]*?<\/shell>/gi, '').trim()
          : currentSegmentContent;
        message.updateCurrentSegmentContent(displayContent);

        streaming.handleContentChunk(msg.token);
        break;

      case 'streamReasoning':
        // Finalize current text segment before thinking content
        // This ensures thinking appears after the text that preceded it
        if (message.isStreaming() && !hasInterleavedContent) {
          message.finalizeCurrentSegment();
          hasInterleavedContent = true;
        }
        streaming.handleThinkingChunk(msg.token);
        break;

      case 'iterationStart':
        // Finalize current text segment before thinking iteration starts
        if (message.isStreaming() && !hasInterleavedContent) {
          message.finalizeCurrentSegment();
          hasInterleavedContent = true;
        }
        thinking.startIteration();
        break;

      case 'endResponse':
        isStreaming = false;
        streaming.endStream();

        // Toggle buttons
        sendBtn.style.display = 'flex';
        stopBtn.style.display = 'none';

        // Finalize the streaming message
        // IMPORTANT: Only update content if we didn't have interleaved content.
        // When interleaved (thinking/tools/shell appeared during streaming), the content
        // is already displayed in continuation segments - updating the original message
        // would cause duplicates.
        if (msg.message) {
          message.finalizeLastMessage({
            content: hasInterleavedContent ? undefined : msg.message.content,
            thinking: msg.message.reasoning
          });
        }

        // Reset segment state
        currentSegmentContent = '';
        hasInterleavedContent = false;

        // Complete current thinking iteration
        thinking.completeIteration();
        break;

      // ---- Shell Messages ----
      case 'shellExecuting':
        if (msg.commands && Array.isArray(msg.commands)) {
          // Finalize current text segment before showing shell commands
          // This preserves the text that came before the shell execution
          if (message.isStreaming()) {
            message.finalizeCurrentSegment();
            hasInterleavedContent = true;
          }

          // Create segment and start it
          const segmentId = shell.createSegment(msg.commands);
          currentShellSegmentId = segmentId;
          shell.startSegment(segmentId);
        }
        break;

      case 'shellResults':
        if (msg.results && Array.isArray(msg.results) && currentShellSegmentId) {
          shell.setResults(currentShellSegmentId, msg.results.map((result: { output?: string; success?: boolean; exitCode?: number }) => ({
            // Extension sends 'success' boolean directly, but fall back to exitCode check for compatibility
            success: result.success !== undefined ? result.success : (result.exitCode === 0),
            output: result.output
          })));
          currentShellSegmentId = null;
        }
        break;

      // ---- Tool Calls Messages ----
      case 'toolCallsStart':
        if (msg.tools && Array.isArray(msg.tools)) {
          // Finalize current text segment before showing tools
          // This preserves the text that came before the tools
          if (message.isStreaming()) {
            message.finalizeCurrentSegment();
            hasInterleavedContent = true;
          }

          toolCalls.startBatch(msg.tools.map((t: { name: string; detail: string }) => ({
            name: t.name,
            detail: t.detail
          })));
        }
        break;

      case 'toolCallUpdate':
        // Update via updateBatch with status
        if (msg.index !== undefined && msg.status) {
          const currentCalls = toolCalls.getCalls();
          if (currentCalls[msg.index]) {
            toolCalls.updateBatch(currentCalls.map((t, i) => ({
              name: t.name,
              detail: t.detail,
              status: i === msg.index ? msg.status : t.status
            })));
          }
        }
        break;

      case 'toolCallsUpdate':
        // Batch update from backend
        if (msg.tools && Array.isArray(msg.tools)) {
          toolCalls.updateBatch(msg.tools.map((t: { name: string; detail: string; status?: string }) => ({
            name: t.name,
            detail: t.detail,
            status: t.status as 'pending' | 'running' | 'done' | 'error' | undefined
          })));
        }
        break;

      case 'toolCallsEnd':
        toolCalls.complete();
        break;

      // ---- Pending Files Messages ----
      case 'pendingFileAdd':
        if (msg.filePath) {
          // Finalize current text segment before showing pending files
          if (message.isStreaming()) {
            message.finalizeCurrentSegment();
            hasInterleavedContent = true;
          }
          pending.addFile(msg.filePath, msg.diffId, msg.iteration);
        }
        break;

      case 'pendingFileUpdate':
        if (msg.fileId && msg.status) {
          pending.updateFile(msg.fileId, { status: msg.status });
        }
        break;

      case 'pendingFileAccept':
        if (msg.fileId) {
          pending.acceptFile(msg.fileId);
        }
        break;

      case 'pendingFileReject':
        if (msg.fileId) {
          pending.rejectFile(msg.fileId);
        }
        break;

      case 'pendingFilesSetEditMode':
        if (msg.mode && ['manual', 'ask', 'auto'].includes(msg.mode)) {
          pending.setEditMode(msg.mode);
        }
        break;

      // ---- History Messages ----
      case 'addMessage':
        if (msg.message?.role === 'user') {
          message.addUserMessage(msg.message.content, msg.message.files);
        } else if (msg.message?.role === 'assistant') {
          message.addAssistantMessage(msg.message.content, {
            thinking: msg.message.reasoning
          });
        }
        break;

      case 'loadHistory':
        message.clear();
        if (msg.history && Array.isArray(msg.history)) {
          msg.history.forEach((m: { role: string; content: string; files?: string[]; reasoning_content?: string }) => {
            if (m.role === 'user') {
              message.addUserMessage(m.content, m.files);
            } else if (m.role === 'assistant') {
              message.addAssistantMessage(m.content, {
                thinking: m.reasoning_content
              });
            }
          });
        }
        break;

      case 'clearChat':
        // Clear all actors when chat is cleared
        message.clear();
        toolCalls.clear();
        shell.clear();
        thinking.clear();
        pending.clear();
        currentShellSegmentId = null;
        currentSegmentContent = '';
        hasInterleavedContent = false;
        break;

      // ---- Settings Messages ----
      case 'modelChanged':
        currentModel = msg.model;
        updateModelDisplay(msg.model);
        break;

      case 'editModeSettings':
        if (msg.mode && editModes.includes(msg.mode)) {
          editMode = msg.mode;
          updateEditModeDisplay(editMode);
          pending.setEditMode(msg.mode);
        }
        break;

      case 'settings':
        if (msg.model) {
          currentModel = msg.model;
          updateModelDisplay(msg.model);
        }
        if (msg.temperature !== undefined) {
          updateTemperatureDisplay(msg.temperature);
        }
        if (msg.toolLimit !== undefined) {
          updateToolLimitDisplay(msg.toolLimit);
        }
        break;

      case 'webSearchToggled':
        webSearchEnabled = msg.enabled;
        updateWebSearchDisplay(msg.enabled);
        break;

      // ---- File Messages ----
      case 'openFiles':
        loadOpenFiles(msg.files || []);
        break;

      case 'searchResults':
        displaySearchResults(msg.results || []);
        break;

      case 'fileContent':
        addFileToSelection(msg.filePath, msg.content);
        break;

      // ---- Status Messages ----
      case 'error':
        showToast(msg.message, 'error');
        break;

      case 'warning':
        showToast(msg.message, 'warning');
        break;

      case 'generationStopped':
        isStreaming = false;
        sendBtn.style.display = 'flex';
        stopBtn.style.display = 'none';
        break;

      default:
        // Unknown message type - log for debugging
        console.log('[ActorSystem] Unhandled message type:', msg.type);
    }
  });

  // ============================================
  // UI Helper Functions
  // ============================================

  function updateModelDisplay(model: string): void {
    const currentModelName = getElementOrNull<HTMLSpanElement>('currentModelName');
    if (currentModelName) {
      const displayNames: Record<string, string> = {
        'deepseek-chat': 'Chat (V3)',
        'deepseek-reasoner': 'Reasoner (R1)'
      };
      currentModelName.textContent = displayNames[model] || model;
    }
  }

  function updateTemperatureDisplay(temp: number): void {
    const tempValue = getElementOrNull<HTMLSpanElement>('tempValue');
    const tempSlider = getElementOrNull<HTMLInputElement>('tempSlider');
    if (tempValue) tempValue.textContent = temp.toString();
    if (tempSlider) tempSlider.value = temp.toString();
  }

  function updateToolLimitDisplay(limit: number): void {
    const toolLimitValue = getElementOrNull<HTMLSpanElement>('toolLimitValue');
    const toolLimitSlider = getElementOrNull<HTMLInputElement>('toolLimitSlider');
    if (toolLimitValue) toolLimitValue.textContent = limit.toString();
    if (toolLimitSlider) toolLimitSlider.value = limit.toString();
  }

  function updateEditModeDisplay(mode: string): void {
    const editModeBtn = getElementOrNull<HTMLButtonElement>('editModeBtn');
    if (editModeBtn) {
      editModeBtn.classList.remove('state-manual', 'state-ask', 'state-auto');
      if (mode === 'ask') editModeBtn.classList.add('state-ask');
      else if (mode === 'auto') editModeBtn.classList.add('state-auto');
      editModeBtn.title = `Edit mode: ${editModeLabels[mode] || mode}`;
      updateEditModeIcon(mode);
    }
  }

  function updateEditModeIcon(mode: string): void {
    const editModeIcon = getElementOrNull<SVGElement>('editModeIcon');
    if (!editModeIcon) return;

    const letters: Record<string, string> = { manual: 'M', ask: 'Q', auto: 'A' };
    editModeIcon.innerHTML = `
      <text x="8" y="11" font-size="10" font-weight="bold" text-anchor="middle" fill="currentColor">${letters[mode] || 'M'}</text>
    `;
  }

  function updateWebSearchDisplay(enabled: boolean): void {
    const searchBtn = getElementOrNull<HTMLButtonElement>('searchBtn');
    if (searchBtn) {
      searchBtn.classList.toggle('active', enabled);
    }
  }

  function showToast(message: string, type: 'error' | 'warning' | 'info' = 'info'): void {
    const toastContainer = getElementOrNull<HTMLDivElement>('toastContainer');
    if (!toastContainer) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ============================================
  // Commands Modal (Help Button)
  // ============================================

  function showCommandsModal(btn: HTMLElement): void {
    closeCommandsModal();
    closeWebSearchModal();

    const modal = document.createElement('div');
    modal.className = 'commands-modal';
    modal.innerHTML = `
      <div class="commands-modal-title">
        <span>Commands</span>
        <button class="commands-modal-close">×</button>
      </div>
      <div class="commands-list">
        ${commands.map(cmd => {
          if ('section' in cmd) {
            return `<div class="commands-section-title">${cmd.section}</div>`;
          }
          return `
            <div class="command-item" data-command="${cmd.id}">
              <span class="command-icon">${cmd.icon}</span>
              <div class="command-info">
                <div class="command-name">${cmd.name}</div>
                <div class="command-desc">${cmd.desc}</div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    // Position above the button
    const rect = btn.getBoundingClientRect();
    modal.style.bottom = `${window.innerHeight - rect.top + 5}px`;
    modal.style.left = `${rect.left}px`;

    // Close button handler
    modal.querySelector('.commands-modal-close')?.addEventListener('click', closeCommandsModal);

    // Command click handlers
    modal.querySelectorAll('.command-item').forEach(item => {
      item.addEventListener('click', () => {
        const commandId = (item as HTMLElement).dataset.command;
        if (commandId) {
          vscode.postMessage({ type: 'executeCommand', command: `deepseek.${commandId}` });
          closeCommandsModal();
        }
      });
    });

    document.body.appendChild(modal);

    // Close when clicking outside
    setTimeout(() => {
      document.addEventListener('click', handleCommandsModalOutsideClick);
    }, 0);
  }

  function handleCommandsModalOutsideClick(e: MouseEvent): void {
    if (!(e.target as Element).closest('.commands-modal') && !(e.target as Element).closest('.help-btn')) {
      closeCommandsModal();
    }
  }

  function closeCommandsModal(): void {
    const modal = document.querySelector('.commands-modal');
    if (modal) modal.remove();
    document.removeEventListener('click', handleCommandsModalOutsideClick);
  }

  // ============================================
  // Web Search Modal
  // ============================================

  function showWebSearchModal(btn: HTMLElement): void {
    closeWebSearchModal();
    closeCommandsModal();

    const modal = document.createElement('div');
    modal.className = 'web-search-modal';
    modal.innerHTML = `
      <div class="web-search-modal-title">
        <span>Web Search Settings</span>
        <button class="web-search-modal-close">&times;</button>
      </div>
      <div class="web-search-modal-content">
        <div class="web-search-option">
          <label>Searches per prompt: <span id="searchCountValue">${webSearchSettings.searchesPerPrompt}</span></label>
          <input type="range" id="searchCountSlider" min="1" max="20" step="1" value="${webSearchSettings.searchesPerPrompt}">
        </div>
        <div class="web-search-option">
          <label>Search depth:</label>
          <div class="search-depth-options">
            <button class="depth-btn ${webSearchSettings.searchDepth === 'basic' ? 'active' : ''}" data-depth="basic">
              <span class="depth-name">Basic</span>
              <span class="depth-credits">1 credit</span>
            </button>
            <button class="depth-btn ${webSearchSettings.searchDepth === 'advanced' ? 'active' : ''}" data-depth="advanced">
              <span class="depth-name">Advanced</span>
              <span class="depth-credits">2 credits</span>
            </button>
          </div>
        </div>
        <button class="web-search-enable-btn">Enable Web Search</button>
        <button class="web-search-clear-cache-btn">Clear Cache</button>
      </div>
    `;

    // Position above button
    const rect = btn.getBoundingClientRect();
    modal.style.bottom = (window.innerHeight - rect.top + 5) + 'px';
    modal.style.left = rect.left + 'px';

    // Event handlers
    modal.querySelector('.web-search-modal-close')?.addEventListener('click', closeWebSearchModal);

    modal.querySelector('#searchCountSlider')?.addEventListener('input', (e) => {
      const value = (e.target as HTMLInputElement).value;
      const valueEl = modal.querySelector('#searchCountValue');
      if (valueEl) valueEl.textContent = value;
      webSearchSettings.searchesPerPrompt = parseInt(value, 10);
    });

    modal.querySelectorAll('.depth-btn').forEach(depthBtn => {
      depthBtn.addEventListener('click', () => {
        modal.querySelectorAll('.depth-btn').forEach(b => b.classList.remove('active'));
        depthBtn.classList.add('active');
        webSearchSettings.searchDepth = (depthBtn as HTMLElement).dataset.depth as 'basic' | 'advanced';
      });
    });

    modal.querySelector('.web-search-enable-btn')?.addEventListener('click', () => {
      webSearchEnabled = true;
      btn.classList.add('active');
      vscode.postMessage({ type: 'toggleWebSearch', enabled: true });
      vscode.postMessage({ type: 'updateWebSearchSettings', settings: webSearchSettings });
      closeWebSearchModal();
    });

    modal.querySelector('.web-search-clear-cache-btn')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'clearSearchCache' });
      closeWebSearchModal();
    });

    document.body.appendChild(modal);

    setTimeout(() => {
      document.addEventListener('click', handleWebSearchModalOutsideClick);
    }, 0);
  }

  function closeWebSearchModal(): void {
    const modal = document.querySelector('.web-search-modal');
    if (modal) modal.remove();
    document.removeEventListener('click', handleWebSearchModalOutsideClick);
  }

  function handleWebSearchModalOutsideClick(e: MouseEvent): void {
    if (!(e.target as Element).closest('.web-search-modal') && !(e.target as Element).closest('.search-btn')) {
      closeWebSearchModal();
    }
  }

  // ============================================
  // Model Dropdown Handlers
  // ============================================

  const modelBtn = getElementOrNull<HTMLButtonElement>('modelBtn');
  const modelDropdown = getElementOrNull<HTMLDivElement>('modelDropdown');

  if (modelBtn && modelDropdown) {
    modelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = modelDropdown.style.display === 'block';
      modelDropdown.style.display = isVisible ? 'none' : 'block';
    });

    // Model option clicks
    modelDropdown.querySelectorAll('.model-option').forEach(option => {
      option.addEventListener('click', (e) => {
        e.stopPropagation();
        const model = (option as HTMLElement).dataset.model;
        if (model) {
          vscode.postMessage({ type: 'selectModel', model });
          modelDropdown.style.display = 'none';
        }
      });
    });

    // Prevent dropdown from closing when interacting with sliders or other controls inside
    modelDropdown.addEventListener('click', (e) => {
      // Only close if clicking a model option, not sliders or other controls
      const target = e.target as HTMLElement;
      if (!target.closest('.model-option')) {
        e.stopPropagation();
      }
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', () => {
      modelDropdown.style.display = 'none';
    });
  }

  // ============================================
  // Temperature & Tool Limit Sliders
  // ============================================

  const tempSlider = getElementOrNull<HTMLInputElement>('tempSlider');
  const tempValue = getElementOrNull<HTMLSpanElement>('tempValue');
  if (tempSlider && tempValue) {
    tempSlider.addEventListener('input', (e) => {
      e.stopPropagation();
      const temp = parseFloat(tempSlider.value);
      tempValue.textContent = temp.toString();
      vscode.postMessage({ type: 'setTemperature', temperature: temp });
    });
  }

  const toolLimitSlider = getElementOrNull<HTMLInputElement>('toolLimitSlider');
  const toolLimitValue = getElementOrNull<HTMLSpanElement>('toolLimitValue');
  if (toolLimitSlider && toolLimitValue) {
    toolLimitSlider.addEventListener('input', (e) => {
      e.stopPropagation();
      const limit = parseInt(toolLimitSlider.value, 10);
      toolLimitValue.textContent = limit.toString();
      vscode.postMessage({ type: 'setToolLimit', toolLimit: limit });
    });
  }

  // ============================================
  // Edit Mode Button Handler
  // ============================================

  const editModeBtn = getElementOrNull<HTMLButtonElement>('editModeBtn');
  if (editModeBtn) {
    editModeBtn.addEventListener('click', () => {
      const currentIndex = editModes.indexOf(editMode);
      const nextIndex = (currentIndex + 1) % editModes.length;
      const newMode = editModes[nextIndex];
      editMode = newMode as typeof editMode;
      vscode.postMessage({ type: 'setEditMode', mode: newMode });
      updateEditModeDisplay(newMode);
      pending.setEditMode(newMode as 'manual' | 'ask' | 'auto');
    });
  }

  // ============================================
  // Help Button Handler
  // ============================================

  const helpBtn = getElementOrNull<HTMLButtonElement>('helpBtn');
  if (helpBtn) {
    helpBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showCommandsModal(helpBtn);
    });
  }

  // ============================================
  // Web Search Button Handler
  // ============================================

  const searchBtn = getElementOrNull<HTMLButtonElement>('searchBtn');
  if (searchBtn) {
    searchBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (webSearchEnabled) {
        // Toggle off
        webSearchEnabled = false;
        searchBtn.classList.remove('active');
        vscode.postMessage({ type: 'toggleWebSearch', enabled: false });
      } else {
        // Show settings modal
        showWebSearchModal(searchBtn);
      }
    });
  }

  // ============================================
  // File Attachment Handler
  // ============================================

  const attachBtn = getElementOrNull<HTMLButtonElement>('attachBtn');
  const fileInput = getElementOrNull<HTMLInputElement>('fileInput');
  const attachmentsContainer = getElementOrNull<HTMLDivElement>('attachments');

  if (attachBtn && fileInput) {
    attachBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
      const files = Array.from((e.target as HTMLInputElement).files || []);
      files.forEach(file => {
        const reader = new FileReader();
        reader.onload = (event) => {
          const content = event.target?.result as string;
          const attachment = { content, name: file.name, size: file.size };
          pendingAttachments.push(attachment);
          renderAttachmentPreview(attachment);
        };
        reader.readAsText(file);
      });
      fileInput.value = '';
    });
  }

  function renderAttachmentPreview(attachment: { content: string; name: string; size: number }): void {
    if (!attachmentsContainer) return;

    const preview = document.createElement('div');
    preview.className = 'attachment-preview file-attachment';
    const sizeKB = (attachment.size / 1024).toFixed(1);
    preview.innerHTML = `
      <span class="file-icon">📄</span>
      <span class="file-name" title="${escapeHtml(attachment.name)}">${escapeHtml(attachment.name)}</span>
      <span class="file-size">${sizeKB}KB</span>
      <button class="attachment-remove" title="Remove">×</button>
    `;
    preview.querySelector('.attachment-remove')?.addEventListener('click', () => {
      const idx = pendingAttachments.indexOf(attachment);
      if (idx > -1) pendingAttachments.splice(idx, 1);
      preview.remove();
    });
    attachmentsContainer.appendChild(preview);
  }

  // ============================================
  // File Selection Modal Handlers
  // ============================================

  const filesBtn = getElementOrNull<HTMLButtonElement>('filesBtn');
  const fileModalOverlay = getElementOrNull<HTMLDivElement>('fileModalOverlay');
  const fileModalClose = getElementOrNull<HTMLButtonElement>('fileModalClose');
  const fileModalCancel = getElementOrNull<HTMLButtonElement>('fileModalCancel');
  const fileModalAdd = getElementOrNull<HTMLButtonElement>('fileModalAdd');
  const fileSearchInput = getElementOrNull<HTMLInputElement>('fileSearchInput');
  const clearSelectedBtn = getElementOrNull<HTMLButtonElement>('clearSelectedBtn');

  function openFileModal(): void {
    if (!fileModalOverlay) return;
    vscode.postMessage({ type: 'getOpenFiles' });
    vscode.postMessage({ type: 'fileModalOpened' });
    fileModalOverlay.style.display = 'flex';
    setTimeout(() => fileSearchInput?.focus(), 100);
  }

  function closeFileModal(): void {
    if (!fileModalOverlay) return;
    vscode.postMessage({ type: 'fileModalClosed' });
    fileModalOverlay.style.display = 'none';
    if (fileSearchInput) fileSearchInput.value = '';
    const fileSearchResults = getElementOrNull<HTMLDivElement>('fileSearchResults');
    if (fileSearchResults) {
      fileSearchResults.style.display = 'none';
      fileSearchResults.innerHTML = '';
    }
  }

  if (filesBtn) filesBtn.addEventListener('click', openFileModal);
  if (fileModalClose) fileModalClose.addEventListener('click', closeFileModal);
  if (fileModalCancel) fileModalCancel.addEventListener('click', closeFileModal);
  if (fileModalOverlay) {
    fileModalOverlay.addEventListener('click', (e) => {
      if (e.target === fileModalOverlay) closeFileModal();
    });
  }

  if (fileModalAdd) {
    fileModalAdd.addEventListener('click', () => {
      const filesData = Array.from(selectedFiles.entries()).map(([path, content]) => ({ path, content }));
      vscode.postMessage({ type: 'setSelectedFiles', files: filesData });
      renderFileChips();
      closeFileModal();
    });
  }

  if (clearSelectedBtn) {
    clearSelectedBtn.addEventListener('click', () => {
      selectedFiles.clear();
      updateSelectedFilesList();
    });
  }

  let searchTimeout: ReturnType<typeof setTimeout> | null = null;
  if (fileSearchInput) {
    fileSearchInput.addEventListener('input', () => {
      if (searchTimeout) clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        const query = fileSearchInput.value.trim();
        if (query.length >= 2) {
          vscode.postMessage({ type: 'searchFiles', query });
        } else {
          const fileSearchResults = getElementOrNull<HTMLDivElement>('fileSearchResults');
          if (fileSearchResults) fileSearchResults.style.display = 'none';
        }
      }, 300);
    });
  }

  function loadOpenFiles(files: string[]): void {
    const openFilesList = getElementOrNull<HTMLDivElement>('openFilesList');
    const openFilesCount = getElementOrNull<HTMLSpanElement>('openFilesCount');
    if (!openFilesList || !openFilesCount) return;

    openFilesCount.textContent = files.length.toString();

    if (files.length === 0) {
      openFilesList.innerHTML = '<div class="file-search-no-results">No files currently open</div>';
      return;
    }

    openFilesList.innerHTML = '';
    files.forEach(filePath => {
      const item = document.createElement('div');
      item.className = 'open-file-item';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'open-file-checkbox';
      checkbox.checked = selectedFiles.has(filePath);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          vscode.postMessage({ type: 'getFileContent', filePath });
        } else {
          selectedFiles.delete(filePath);
          updateSelectedFilesList();
        }
      });

      const name = document.createElement('span');
      name.className = 'open-file-name';
      name.textContent = filePath;
      name.title = filePath;

      item.appendChild(checkbox);
      item.appendChild(name);
      openFilesList.appendChild(item);
    });
  }

  function displaySearchResults(results: string[]): void {
    const fileSearchResults = getElementOrNull<HTMLDivElement>('fileSearchResults');
    if (!fileSearchResults) return;

    if (results.length === 0) {
      fileSearchResults.innerHTML = '<div class="file-search-no-results">No files found</div>';
      fileSearchResults.style.display = 'block';
      return;
    }

    fileSearchResults.innerHTML = '';
    fileSearchResults.style.display = 'block';

    results.forEach(filePath => {
      const item = document.createElement('div');
      item.className = 'file-search-result-item';
      item.textContent = filePath;
      item.title = filePath;
      item.addEventListener('click', () => {
        vscode.postMessage({ type: 'getFileContent', filePath });
        if (fileSearchInput) fileSearchInput.value = '';
        fileSearchResults.style.display = 'none';
      });
      fileSearchResults.appendChild(item);
    });
  }

  function addFileToSelection(filePath: string, content: string): void {
    selectedFiles.set(filePath, content);
    updateSelectedFilesList();

    // Update checkbox in open files list
    const openFilesList = getElementOrNull<HTMLDivElement>('openFilesList');
    if (openFilesList) {
      openFilesList.querySelectorAll('.open-file-item').forEach(item => {
        const name = item.querySelector('.open-file-name');
        const checkbox = item.querySelector('.open-file-checkbox') as HTMLInputElement;
        if (name && checkbox && name.textContent === filePath) {
          checkbox.checked = true;
        }
      });
    }
  }

  function updateSelectedFilesList(): void {
    const selectedFilesList = getElementOrNull<HTMLDivElement>('selectedFilesList');
    const selectedFilesCount = getElementOrNull<HTMLSpanElement>('selectedFilesCount');
    if (!selectedFilesList || !selectedFilesCount) return;

    selectedFilesCount.textContent = selectedFiles.size.toString();

    if (selectedFiles.size === 0) {
      selectedFilesList.innerHTML = '<div class="selected-files-empty">No files selected</div>';
      if (clearSelectedBtn) clearSelectedBtn.style.display = 'none';
      if (fileModalAdd) fileModalAdd.disabled = true;
      updateFilesButtonState();
      return;
    }

    if (clearSelectedBtn) clearSelectedBtn.style.display = 'inline-block';
    if (fileModalAdd) fileModalAdd.disabled = false;
    selectedFilesList.innerHTML = '';

    selectedFiles.forEach((_, filePath) => {
      const chip = document.createElement('div');
      chip.className = 'selected-file-chip';

      const name = document.createElement('span');
      name.className = 'selected-file-name';
      name.textContent = filePath;
      name.title = filePath;

      const removeBtn = document.createElement('button');
      removeBtn.className = 'selected-file-remove';
      removeBtn.textContent = '×';
      removeBtn.title = 'Remove';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedFiles.delete(filePath);
        updateSelectedFilesList();
      });

      chip.appendChild(name);
      chip.appendChild(removeBtn);
      selectedFilesList.appendChild(chip);
    });

    updateFilesButtonState();
  }

  function updateFilesButtonState(): void {
    if (filesBtn) {
      filesBtn.classList.toggle('active', selectedFiles.size > 0);
    }
  }

  function renderFileChips(): void {
    const fileChipsContainer = getElementOrNull<HTMLDivElement>('fileChipsContainer');
    const fileChips = getElementOrNull<HTMLDivElement>('fileChips');
    if (!fileChipsContainer || !fileChips) return;

    if (selectedFiles.size === 0) {
      fileChipsContainer.style.display = 'none';
      fileChips.innerHTML = '';
      return;
    }

    fileChipsContainer.style.display = 'flex';
    fileChips.innerHTML = '';

    selectedFiles.forEach((_, filePath) => {
      const chip = document.createElement('div');
      chip.className = 'file-chip';

      const name = document.createElement('span');
      name.className = 'file-chip-name';
      name.textContent = filePath;
      name.title = filePath;

      const removeBtn = document.createElement('button');
      removeBtn.className = 'file-chip-remove';
      removeBtn.textContent = '×';
      removeBtn.title = 'Remove';
      removeBtn.addEventListener('click', () => {
        selectedFiles.delete(filePath);
        renderFileChips();
        const filesData = Array.from(selectedFiles.entries()).map(([path, content]) => ({ path, content }));
        vscode.postMessage({ type: 'setSelectedFiles', files: filesData });
      });

      chip.appendChild(name);
      chip.appendChild(removeBtn);
      fileChips.appendChild(chip);
    });
  }

  // ============================================
  // Status Panel Handler
  // ============================================

  const statusPanelLogsBtn = getElementOrNull<HTMLButtonElement>('statusPanelLogsBtn');
  if (statusPanelLogsBtn) {
    statusPanelLogsBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'showLogs' });
    });
  }

  // ============================================
  // Utility Functions
  // ============================================

  function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ============================================
  // Expose for Debugging
  // ============================================

  (window as unknown as Record<string, unknown>).actorManager = manager;
  (window as unknown as Record<string, unknown>).actors = {
    streaming,
    message,
    scroll,
    shell,
    toolCalls,
    thinking,
    pending
  };

  console.log('[ActorSystem] Initialized with 7 actors (hybrid mode)');
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeActorSystem);
} else {
  initializeActorSystem();
}

// Export for testing
export { initializeActorSystem };
