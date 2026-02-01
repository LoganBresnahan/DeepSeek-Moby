/**
 * Chat Entry Point - Full Shadow DOM Actor Integration
 *
 * All UI is managed by Shadow DOM actors that own their DOM elements.
 * This provides complete style isolation and cleaner architecture.
 */

import { EventStateManager } from './state/EventStateManager';
import {
  StreamingActor,
  ScrollActor,
  // Shadow DOM actors - own their DOM
  MessageShadowActor,
  ShellShadowActor,
  ToolCallsShadowActor,
  ThinkingShadowActor,
  PendingChangesShadowActor,
  InputAreaShadowActor,
  StatusPanelShadowActor,
  ToolbarShadowActor
} from './actors';
import { AnimationHelper } from './utils';

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

// Edit mode options
const editModes = ['manual', 'ask', 'auto'];

// File selection state (still needed for file modal)
const selectedFiles = new Map<string, string>();

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

  // Inject global animation styles
  AnimationHelper.injectStyles();

  // Get required DOM elements
  const chatMessages = getElement<HTMLDivElement>('chatMessages');

  // Create the event state manager
  const manager = new EventStateManager();

  // Get container elements for Shadow actors
  const inputAreaContainer = getElement<HTMLDivElement>('inputAreaContainer');
  const statusPanelContainer = getElement<HTMLDivElement>('statusPanelContainer');
  const toolbarContainer = getElement<HTMLDivElement>('toolbarContainer');

  // Get moby icon URL from data attribute
  const mobyIconUrl = document.body.dataset.mobyIcon || '';

  // Create a hidden streaming root (StreamingActor manages state, not visible content)
  const streamingRoot = document.createElement('div');
  streamingRoot.id = 'streamingRoot';
  streamingRoot.style.display = 'none';
  document.body.appendChild(streamingRoot);

  // Initialize state-only actors
  const streaming = new StreamingActor(manager, streamingRoot);
  const scroll = new ScrollActor(manager, chatMessages);

  // All actors now use InterleavedShadowActor pattern - each creates its own
  // shadow-encapsulated containers as siblings in chatMessages.
  // This allows proper interleaving: DOM order = visual order.
  //
  // Example DOM structure during streaming:
  //   <div id="chatMessages">
  //     <div data-actor="message">user message 1</div>
  //     <div data-actor="message">assistant segment 1</div>
  //     <div data-actor="thinking">thinking iteration 1</div>
  //     <div data-actor="message">assistant continuation</div>
  //     <div data-actor="shell">shell commands</div>
  //     <div data-actor="message">user message 2</div>
  //     <div data-actor="thinking">thinking iteration 2</div>
  //   </div>

  // MessageShadowActor - creates shadow containers for each message/segment
  const message = new MessageShadowActor(manager, chatMessages);

  // Interleaved Shadow actors - create shadow containers within chatMessages
  const shell = new ShellShadowActor(manager, chatMessages);
  const toolCalls = new ToolCallsShadowActor(manager, chatMessages);
  const thinking = new ThinkingShadowActor(manager, chatMessages);
  const pending = new PendingChangesShadowActor(manager, chatMessages);

  // Debug: Verify chatMessages is NOT a shadow host (critical for interleaving)
  console.log('[ActorSystem] Initialized. chatMessages.shadowRoot:', chatMessages.shadowRoot,
    'children:', chatMessages.children.length);

  // InputAreaShadowActor - owns its DOM, renders into inputAreaContainer
  const inputArea = new InputAreaShadowActor(manager, inputAreaContainer, vscode);

  // StatusPanelShadowActor - owns its DOM, renders into statusPanelContainer
  const statusPanel = new StatusPanelShadowActor(manager, statusPanelContainer, mobyIconUrl, vscode);

  // ToolbarShadowActor - owns its DOM, renders into toolbarContainer
  const toolbar = new ToolbarShadowActor(manager, toolbarContainer, vscode);

  // Set up InputAreaActor handlers
  inputArea.onSend((content, attachments) => {
    // Add user message to UI immediately
    const fileNames = attachments?.map(a => a.name) || [];
    if (selectedFiles.size > 0) {
      fileNames.push(...Array.from(selectedFiles.keys()));
    }
    message.addUserMessage(content, fileNames.length > 0 ? fileNames : undefined);

    // Send to backend
    vscode.postMessage({
      type: 'sendMessage',
      message: content,
      attachments: attachments && attachments.length > 0 ? attachments : undefined
    });
  });

  inputArea.onStop(() => {
    vscode.postMessage({ type: 'stopGeneration' });
  });

  // Set up ToolbarActor handlers
  toolbar.onEditModeChange((mode) => {
    editMode = mode;
    pending.setEditMode(mode);
    message.setEditMode(mode);
  });

  toolbar.onFilesOpen(() => {
    openFileModal();
  });

  // Wire toolbar buttons to input area
  toolbar.onSend(() => {
    inputArea.submit();
  });

  toolbar.onStop(() => {
    vscode.postMessage({ type: 'stopGeneration' });
  });

  toolbar.onAttach(() => {
    inputArea.triggerAttach();
  });

  // Set up pending files action handler
  // Map internal file ID to diffId and send the correct message type to backend
  pending.onAction((fileId, action) => {
    const file = pending.getFiles().find(f => f.id === fileId);
    if (!file) return;

    // For accept/reject, we need the diffId to match backend's acceptSpecificDiff/rejectSpecificDiff
    if (action === 'accept' && file.diffId) {
      vscode.postMessage({ type: 'acceptSpecificDiff', diffId: file.diffId });
    } else if (action === 'reject' && file.diffId) {
      vscode.postMessage({ type: 'rejectSpecificDiff', diffId: file.diffId });
    } else if (action === 'focus' && file.diffId) {
      vscode.postMessage({ type: 'focusDiff', diffId: file.diffId });
    }
  });

  // Sync initial edit mode
  pending.setEditMode(editMode);
  toolbar.setEditMode(editMode);
  message.setEditMode(editMode);

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

        // Enable printing surface effect during streaming
        AnimationHelper.enablePrintingSurface(chatMessages);

        // Start stream - this publishes streaming.active: true
        // InputAreaActor subscribes to this and handles button visibility
        streaming.startStream(msg.messageId || `msg-${Date.now()}`, currentModel);

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

        // Disable printing surface effect
        AnimationHelper.disablePrintingSurface(chatMessages);

        // End stream - this publishes streaming.active: false
        // InputAreaActor subscribes to this and handles button visibility
        streaming.endStream();

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

      case 'diffListChanged':
        // Extension sends diffListChanged with full list of diffs
        // Sync with pending changes actor - track by diffId to support multiple versions of same file
        if (msg.diffs && Array.isArray(msg.diffs)) {
          // Finalize current text segment before showing pending files
          if (message.isStreaming() && msg.diffs.length > 0) {
            message.finalizeCurrentSegment();
            hasInterleavedContent = true;
          }

          // Get current pending files and build a map by diffId
          const currentFiles = pending.getFiles();
          const currentDiffIds = new Map(currentFiles.map(f => [f.diffId, f]));

          // Process each diff from backend
          for (const diff of msg.diffs as Array<{ filePath: string; status: string; diffId?: string; iteration?: number; superseded?: boolean }>) {
            const existingFile = diff.diffId ? currentDiffIds.get(diff.diffId) : undefined;

            if (!existingFile) {
              // New diff - add it (PendingChangesActor.addFile will auto-supersede pending files for same path)
              pending.addFile(diff.filePath, diff.diffId, diff.iteration);
            } else {
              // Existing diff - update status and superseded state
              const updates: Partial<{ status: 'pending' | 'applied' | 'rejected'; superseded: boolean }> = {};

              if (existingFile.status !== diff.status) {
                updates.status = diff.status as 'pending' | 'applied' | 'rejected';
              }
              if (diff.superseded !== undefined && existingFile.superseded !== diff.superseded) {
                updates.superseded = diff.superseded;
              }

              if (Object.keys(updates).length > 0) {
                pending.updateFile(existingFile.id, updates);
              }
            }
          }

          // Update edit mode if provided
          if (msg.editMode && ['manual', 'ask', 'auto'].includes(msg.editMode)) {
            pending.setEditMode(msg.editMode);
          }
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
          toolbar.setEditMode(msg.mode);
          pending.setEditMode(msg.mode);
          message.setEditMode(msg.mode);
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
        if (msg.maxToolCalls !== undefined) {
          updateToolLimitDisplay(msg.maxToolCalls);
        }
        if (msg.maxTokens !== undefined) {
          updateTokenLimitDisplay(msg.maxTokens);
        }
        if (msg.logLevel !== undefined && msg.logColors !== undefined) {
          const logLevelSelect = getElementOrNull<HTMLSelectElement>('logLevelSelect');
          const logLevelValue = getElementOrNull<HTMLSpanElement>('logLevelValue');
          const logColorsCheck = getElementOrNull<HTMLInputElement>('logColorsCheck');
          if (logLevelSelect) logLevelSelect.value = msg.logLevel;
          if (logLevelValue) logLevelValue.textContent = msg.logLevel;
          if (logColorsCheck) logColorsCheck.checked = msg.logColors;
        }
        if (msg.systemPrompt !== undefined) {
          const systemPromptInput = getElementOrNull<HTMLTextAreaElement>('systemPromptInput');
          if (systemPromptInput) systemPromptInput.value = msg.systemPrompt;
        }
        // Web search settings
        if (msg.webSearch) {
          const searchDepthSelect = getElementOrNull<HTMLSelectElement>('searchDepthSelect');
          const searchesPerPromptSlider = getElementOrNull<HTMLInputElement>('searchesPerPromptSlider');
          const searchesPerPromptValue = getElementOrNull<HTMLSpanElement>('searchesPerPromptValue');
          const cacheDurationSlider = getElementOrNull<HTMLInputElement>('cacheDurationSlider');
          const cacheDurationValue = getElementOrNull<HTMLSpanElement>('cacheDurationValue');
          if (searchDepthSelect) searchDepthSelect.value = msg.webSearch.searchDepth || 'basic';
          if (searchesPerPromptSlider) searchesPerPromptSlider.value = String(msg.webSearch.searchesPerPrompt || 1);
          if (searchesPerPromptValue) searchesPerPromptValue.textContent = String(msg.webSearch.searchesPerPrompt || 1);
          if (cacheDurationSlider) cacheDurationSlider.value = String(msg.webSearch.cacheDuration || 15);
          if (cacheDurationValue) cacheDurationValue.textContent = String(msg.webSearch.cacheDuration || 15);
        }
        // History settings
        if (msg.autoSaveHistory !== undefined) {
          const autoSaveHistoryCheck = getElementOrNull<HTMLInputElement>('autoSaveHistoryCheck');
          if (autoSaveHistoryCheck) autoSaveHistoryCheck.checked = msg.autoSaveHistory;
        }
        if (msg.maxSessions !== undefined) {
          const maxSessionsSlider = getElementOrNull<HTMLInputElement>('maxSessionsSlider');
          const maxSessionsValue = getElementOrNull<HTMLSpanElement>('maxSessionsValue');
          if (maxSessionsSlider) maxSessionsSlider.value = String(msg.maxSessions);
          if (maxSessionsValue) maxSessionsValue.textContent = String(msg.maxSessions);
        }
        // Reasoner settings
        if (msg.allowAllCommands !== undefined) {
          const allowAllCommandsCheck = getElementOrNull<HTMLInputElement>('allowAllCommandsCheck');
          if (allowAllCommandsCheck) allowAllCommandsCheck.checked = msg.allowAllCommands;
        }
        break;

      case 'defaultSystemPrompt': {
        const defaultPromptPreview = getElementOrNull<HTMLDivElement>('defaultPromptPreview');
        const defaultPromptModel = getElementOrNull<HTMLElement>('defaultPromptModel');
        const defaultPromptContent = getElementOrNull<HTMLPreElement>('defaultPromptContent');
        if (defaultPromptPreview && defaultPromptModel && defaultPromptContent) {
          defaultPromptModel.textContent = msg.model || 'current model';
          defaultPromptContent.textContent = msg.prompt || '(no default prompt)';
          defaultPromptPreview.style.display = 'block';
        }
        break;
      }

      case 'settingsReset':
        // Request fresh settings after reset
        vscode.postMessage({ type: 'getSettings' });
        break;

      case 'webSearchToggled':
        toolbar.setWebSearchEnabled(msg.enabled);
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
        statusPanel.showError(msg.message);
        break;

      case 'warning':
        statusPanel.showWarning(msg.message);
        break;

      case 'statusMessage':
        statusPanel.showMessage(msg.message);
        break;

      case 'generationStopped':
        isStreaming = false;

        // Disable printing surface effect
        AnimationHelper.disablePrintingSurface(chatMessages);

        // End the stream - this publishes streaming.active: false
        // InputAreaActor subscribes to this and handles:
        // - Button visibility (send/stop)
        // - Pending interrupt messages
        streaming.endStream();

        // Reset segment state
        currentSegmentContent = '';
        hasInterleavedContent = false;
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

  function updateTokenLimitDisplay(limit: number): void {
    const tokenLimitValue = getElementOrNull<HTMLSpanElement>('tokenLimitValue');
    const tokenLimitSlider = getElementOrNull<HTMLInputElement>('tokenLimitSlider');
    // Format with K suffix for readability
    if (tokenLimitValue) {
      tokenLimitValue.textContent = limit >= 1000 ? `${(limit / 1024).toFixed(1)}K` : limit.toString();
    }
    if (tokenLimitSlider) tokenLimitSlider.value = limit.toString();
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

  const tokenLimitSlider = getElementOrNull<HTMLInputElement>('tokenLimitSlider');
  const tokenLimitValue = getElementOrNull<HTMLSpanElement>('tokenLimitValue');
  if (tokenLimitSlider && tokenLimitValue) {
    tokenLimitSlider.addEventListener('input', (e) => {
      e.stopPropagation();
      const limit = parseInt(tokenLimitSlider.value, 10);
      // Format with K suffix for readability
      tokenLimitValue.textContent = limit >= 1000 ? `${(limit / 1024).toFixed(1)}K` : limit.toString();
      vscode.postMessage({ type: 'setMaxTokens', maxTokens: limit });
    });
  }

  // ============================================
  // Settings Dropdown Handlers
  // ============================================

  const settingsBtn = getElementOrNull<HTMLButtonElement>('settingsBtn');
  const settingsDropdown = getElementOrNull<HTMLDivElement>('settingsDropdown');

  if (settingsBtn && settingsDropdown) {
    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = settingsDropdown.style.display === 'block';
      settingsDropdown.style.display = isVisible ? 'none' : 'block';
      // Close model dropdown if open
      if (modelDropdown) modelDropdown.style.display = 'none';
    });

    // Close when clicking outside
    document.addEventListener('click', (e) => {
      if (!settingsDropdown.contains(e.target as Node) && e.target !== settingsBtn) {
        settingsDropdown.style.display = 'none';
      }
    });
  }

  // Log Level Select
  const logLevelSelect = getElementOrNull<HTMLSelectElement>('logLevelSelect');
  const logLevelValue = getElementOrNull<HTMLSpanElement>('logLevelValue');
  if (logLevelSelect && logLevelValue) {
    logLevelSelect.addEventListener('change', (e) => {
      e.stopPropagation();
      const level = logLevelSelect.value;
      logLevelValue.textContent = level;
      vscode.postMessage({ type: 'setLogLevel', logLevel: level });
    });
  }

  // Log Colors Checkbox
  const logColorsCheck = getElementOrNull<HTMLInputElement>('logColorsCheck');
  if (logColorsCheck) {
    logColorsCheck.addEventListener('change', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'setLogColors', enabled: logColorsCheck.checked });
    });
  }

  // Open Logs Button
  const openLogsBtn = getElementOrNull<HTMLButtonElement>('openLogsBtn');
  if (openLogsBtn) {
    openLogsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'openLogs' });
    });
  }

  // Walk on the Wild Side Checkbox
  const allowAllCommandsCheck = getElementOrNull<HTMLInputElement>('allowAllCommandsCheck');
  if (allowAllCommandsCheck) {
    allowAllCommandsCheck.addEventListener('change', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'setAllowAllCommands', enabled: allowAllCommandsCheck.checked });
    });
  }

  // System Prompt
  const systemPromptInput = getElementOrNull<HTMLTextAreaElement>('systemPromptInput');
  const saveSystemPromptBtn = getElementOrNull<HTMLButtonElement>('saveSystemPromptBtn');
  const resetSystemPromptBtn = getElementOrNull<HTMLButtonElement>('resetSystemPromptBtn');
  const showDefaultPromptBtn = getElementOrNull<HTMLButtonElement>('showDefaultPromptBtn');
  const defaultPromptPreview = getElementOrNull<HTMLDivElement>('defaultPromptPreview');
  const defaultPromptModel = getElementOrNull<HTMLElement>('defaultPromptModel');
  const defaultPromptContent = getElementOrNull<HTMLPreElement>('defaultPromptContent');
  const closeDefaultPromptBtn = getElementOrNull<HTMLButtonElement>('closeDefaultPromptBtn');

  if (systemPromptInput && saveSystemPromptBtn) {
    saveSystemPromptBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const prompt = systemPromptInput.value;
      vscode.postMessage({ type: 'setSystemPrompt', systemPrompt: prompt });
      // Show feedback
      const originalText = saveSystemPromptBtn.textContent;
      saveSystemPromptBtn.textContent = 'Saved!';
      setTimeout(() => {
        saveSystemPromptBtn.textContent = originalText;
      }, 1500);
    });
  }

  if (resetSystemPromptBtn && systemPromptInput) {
    resetSystemPromptBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      systemPromptInput.value = '';
      vscode.postMessage({ type: 'setSystemPrompt', systemPrompt: '' });
      // Show feedback
      const originalText = resetSystemPromptBtn.textContent;
      resetSystemPromptBtn.textContent = 'Reset!';
      setTimeout(() => {
        resetSystemPromptBtn.textContent = originalText;
      }, 1500);
    });
  }

  if (showDefaultPromptBtn) {
    showDefaultPromptBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'getDefaultSystemPrompt' });
    });
  }

  if (closeDefaultPromptBtn && defaultPromptPreview) {
    closeDefaultPromptBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      defaultPromptPreview.style.display = 'none';
    });
  }

  // ============================================
  // Web Search Settings
  // ============================================

  const searchDepthSelect = getElementOrNull<HTMLSelectElement>('searchDepthSelect');
  const searchDepthValue = getElementOrNull<HTMLSpanElement>('searchDepthValue');
  if (searchDepthSelect && searchDepthValue) {
    searchDepthSelect.addEventListener('change', (e) => {
      e.stopPropagation();
      const depth = searchDepthSelect.value;
      searchDepthValue.textContent = depth;
      vscode.postMessage({ type: 'setSearchDepth', searchDepth: depth });
    });
  }

  const searchesPerPromptSlider = getElementOrNull<HTMLInputElement>('searchesPerPromptSlider');
  const searchesPerPromptValue = getElementOrNull<HTMLSpanElement>('searchesPerPromptValue');
  if (searchesPerPromptSlider && searchesPerPromptValue) {
    searchesPerPromptSlider.addEventListener('input', (e) => {
      e.stopPropagation();
      const value = parseInt(searchesPerPromptSlider.value, 10);
      searchesPerPromptValue.textContent = value.toString();
    });
    searchesPerPromptSlider.addEventListener('change', (e) => {
      e.stopPropagation();
      const value = parseInt(searchesPerPromptSlider.value, 10);
      vscode.postMessage({ type: 'setSearchesPerPrompt', searchesPerPrompt: value });
    });
  }

  const cacheDurationSlider = getElementOrNull<HTMLInputElement>('cacheDurationSlider');
  const cacheDurationValue = getElementOrNull<HTMLSpanElement>('cacheDurationValue');
  if (cacheDurationSlider && cacheDurationValue) {
    cacheDurationSlider.addEventListener('input', (e) => {
      e.stopPropagation();
      const value = parseInt(cacheDurationSlider.value, 10);
      cacheDurationValue.textContent = value.toString();
    });
    cacheDurationSlider.addEventListener('change', (e) => {
      e.stopPropagation();
      const value = parseInt(cacheDurationSlider.value, 10);
      vscode.postMessage({ type: 'setCacheDuration', cacheDuration: value });
    });
  }

  const clearSearchCacheBtn = getElementOrNull<HTMLButtonElement>('clearSearchCacheBtn');
  if (clearSearchCacheBtn) {
    clearSearchCacheBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'clearSearchCache' });
      // Show feedback
      const originalText = clearSearchCacheBtn.textContent;
      clearSearchCacheBtn.textContent = 'Cleared!';
      setTimeout(() => {
        clearSearchCacheBtn.textContent = originalText;
      }, 1500);
    });
  }

  // ============================================
  // History Settings
  // ============================================

  const autoSaveHistoryCheck = getElementOrNull<HTMLInputElement>('autoSaveHistoryCheck');
  if (autoSaveHistoryCheck) {
    autoSaveHistoryCheck.addEventListener('change', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'setAutoSaveHistory', enabled: autoSaveHistoryCheck.checked });
    });
  }

  const maxSessionsSlider = getElementOrNull<HTMLInputElement>('maxSessionsSlider');
  const maxSessionsValue = getElementOrNull<HTMLSpanElement>('maxSessionsValue');
  if (maxSessionsSlider && maxSessionsValue) {
    maxSessionsSlider.addEventListener('input', (e) => {
      e.stopPropagation();
      const value = parseInt(maxSessionsSlider.value, 10);
      maxSessionsValue.textContent = value.toString();
    });
    maxSessionsSlider.addEventListener('change', (e) => {
      e.stopPropagation();
      const value = parseInt(maxSessionsSlider.value, 10);
      vscode.postMessage({ type: 'setMaxSessions', maxSessions: value });
    });
  }

  const clearHistoryBtn = getElementOrNull<HTMLButtonElement>('clearHistoryBtn');
  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Confirm before clearing
      if (confirm('Are you sure you want to clear all chat history? This cannot be undone.')) {
        vscode.postMessage({ type: 'clearAllHistory' });
        // Show feedback
        const originalText = clearHistoryBtn.textContent;
        clearHistoryBtn.textContent = 'Cleared!';
        setTimeout(() => {
          clearHistoryBtn.textContent = originalText;
        }, 1500);
      }
    });
  }

  // ============================================
  // Debug Test Buttons
  // ============================================

  const testStatusBtn = getElementOrNull<HTMLButtonElement>('testStatusBtn');
  if (testStatusBtn) {
    testStatusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      statusPanel.showMessage('This is a test status message');
    });
  }

  const testWarningBtn = getElementOrNull<HTMLButtonElement>('testWarningBtn');
  if (testWarningBtn) {
    testWarningBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      statusPanel.showWarning('This is a test warning message');
    });
  }

  const testErrorBtn = getElementOrNull<HTMLButtonElement>('testErrorBtn');
  if (testErrorBtn) {
    testErrorBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      statusPanel.showError('This is a test error message');
    });
  }

  // ============================================
  // Reset to Defaults
  // ============================================

  const resetDefaultsBtn = getElementOrNull<HTMLButtonElement>('resetDefaultsBtn');
  if (resetDefaultsBtn) {
    resetDefaultsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('Reset all settings to their default values?')) {
        vscode.postMessage({ type: 'resetToDefaults' });
        // Show feedback
        const originalText = resetDefaultsBtn.textContent;
        resetDefaultsBtn.textContent = 'Reset!';
        setTimeout(() => {
          resetDefaultsBtn.textContent = originalText;
        }, 1500);
      }
    });
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
  // Request Initial Settings
  // ============================================

  // Request settings from backend to restore persisted state (edit mode, etc.)
  vscode.postMessage({ type: 'getSettings' });

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
    pending,
    inputArea,
    statusPanel,
    toolbar
  };

  console.log('[ActorSystem] Initialized with 10 actors (full actor mode)');
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeActorSystem);
} else {
  initializeActorSystem();
}

// Export for testing
export { initializeActorSystem };
