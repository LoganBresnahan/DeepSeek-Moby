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
  ToolbarShadowActor,
  HistoryShadowActor,
  // New modal/popup actors
  FilesShadowActor,
  CommandsShadowActor,
  ModelSelectorShadowActor,
  SettingsShadowActor
  // Note: DropdownFocusActor removed - see media/actors/dropdown-focus/UNUSED.txt
} from './actors';
// Dev-only actor - not included in production bundle
import { InspectorShadowActor } from './dev/inspector';
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

// File selection is now managed by FilesShadowActor
// Legacy selectedFiles Map removed - actor handles state

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

  // Note: DropdownFocusActor removed - dropdowns are now simple collapsibles
  // See media/actors/dropdown-focus/UNUSED.txt for details

  // Debug: Verify chatMessages is NOT a shadow host (critical for interleaving)
  console.log('[ActorSystem] Initialized. chatMessages.shadowRoot:', chatMessages.shadowRoot,
    'children:', chatMessages.children.length);

  // InputAreaShadowActor - owns its DOM, renders into inputAreaContainer
  const inputArea = new InputAreaShadowActor(manager, inputAreaContainer, vscode);

  // StatusPanelShadowActor - owns its DOM, renders into statusPanelContainer
  const statusPanel = new StatusPanelShadowActor(manager, statusPanelContainer, mobyIconUrl, vscode);

  // ToolbarShadowActor - owns its DOM, renders into toolbarContainer
  const toolbar = new ToolbarShadowActor(manager, toolbarContainer, vscode);

  // InspectorShadowActor - UI inspection tool, uses its own host element
  const inspectorHost = document.createElement('div');
  inspectorHost.id = 'inspectorHost';
  inspectorHost.style.cssText = 'position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 999999;';
  document.body.appendChild(inspectorHost);
  const inspector = new InspectorShadowActor(manager, inspectorHost);

  // HistoryShadowActor - History modal, uses its own host element
  const historyHost = document.createElement('div');
  historyHost.id = 'historyHost';
  historyHost.style.cssText = 'position: fixed; top: 0; left: 0; width: 0; height: 0;';
  document.body.appendChild(historyHost);
  const history = new HistoryShadowActor(manager, historyHost, vscode);

  // FilesShadowActor - File selection modal
  const filesHost = document.createElement('div');
  filesHost.id = 'filesHost';
  filesHost.style.cssText = 'position: fixed; top: 0; left: 0; width: 0; height: 0;';
  document.body.appendChild(filesHost);
  const files = new FilesShadowActor(manager, filesHost, vscode);

  // CommandsShadowActor - Commands dropdown (positioned relative to button)
  const commandsHost = getElementOrNull<HTMLElement>('commandsBtn')?.parentElement;
  let commands: CommandsShadowActor | null = null;
  if (commandsHost) {
    commandsHost.style.position = 'relative';
    const commandsContainer = document.createElement('div');
    commandsContainer.id = 'commandsActorHost';
    commandsHost.appendChild(commandsContainer);
    commands = new CommandsShadowActor(manager, commandsContainer, vscode);
  }

  // ModelSelectorShadowActor - Model dropdown with parameters
  const modelHost = getElementOrNull<HTMLElement>('modelBtn')?.parentElement;
  let modelSelector: ModelSelectorShadowActor | null = null;
  if (modelHost) {
    modelHost.style.position = 'relative';
    const modelContainer = document.createElement('div');
    modelContainer.id = 'modelActorHost';
    modelHost.appendChild(modelContainer);
    modelSelector = new ModelSelectorShadowActor(manager, modelContainer, vscode);
  }

  // SettingsShadowActor - Settings dropdown
  const settingsHost = getElementOrNull<HTMLElement>('settingsBtn')?.parentElement;
  let settings: SettingsShadowActor | null = null;
  if (settingsHost) {
    settingsHost.style.position = 'relative';
    const settingsContainer = document.createElement('div');
    settingsContainer.id = 'settingsActorHost';
    settingsHost.appendChild(settingsContainer);
    settings = new SettingsShadowActor(manager, settingsContainer, vscode);
  }

  // Wire up inspector toggle button
  const inspectorBtn = getElementOrNull<HTMLButtonElement>('inspectorBtn');
  if (inspectorBtn) {
    inspectorBtn.addEventListener('click', () => {
      inspector.toggle();
      inspectorBtn.classList.toggle('active', inspector.isVisible());
    });

    // Listen for inspector close (e.g., when closed via X button)
    inspectorHost.addEventListener('inspector-hidden', () => {
      inspectorBtn.classList.remove('active');
    });
  }

  // Wire up history button
  const historyBtn = getElementOrNull<HTMLButtonElement>('historyBtn');
  if (historyBtn) {
    historyBtn.addEventListener('click', () => {
      // Request history sessions from backend and open modal
      vscode.postMessage({ type: 'getHistorySessions' });
      manager.publishDirect('history.modal.open', true);
    });
  }

  // Wire up commands dropdown (uses CommandsShadowActor)
  const commandsBtn = getElementOrNull<HTMLButtonElement>('commandsBtn');
  if (commandsBtn && commands) {
    commandsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      commands.toggle();
    });
  }

  // Set up InputAreaActor handlers
  inputArea.onSend((content, attachments) => {
    // Add user message to UI immediately
    // File attachments come from InputAreaActor, selected files handled by FilesShadowActor
    const fileNames = attachments?.map(a => a.name) || [];
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
    // Use the new FilesShadowActor
    manager.publishDirect('files.modal.open', true);
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
        console.log('[Frontend] startResponse: beginning new stream, isReasoner=' + msg.isReasoner);
        isStreaming = true;
        isReasonerMode = msg.isReasoner || false;

        // Reset segment state for new response
        currentSegmentContent = '';
        hasInterleavedContent = false;
        console.log('[Frontend] startResponse: reset segment state (content="", interleaved=false)');

        // Printing surface effect removed - was too distracting

        // Start stream - this publishes streaming.active: true
        // InputAreaActor subscribes to this and handles button visibility
        streaming.startStream(msg.messageId || `msg-${Date.now()}`, currentModel);

        // NOTE: Don't call thinking.startIteration() here - let it be created
        // when actual thinking content arrives (via streaming.thinking or iterationStart).
        // This ensures thinking appears inline with the response flow, not at the top.
        break;

      case 'streamToken': {
        const tokenPreview = msg.token.length > 50 ? msg.token.slice(0, 50) + '...' : msg.token;
        console.log(`[Frontend] streamToken: "${tokenPreview.replace(/\n/g, '\\n')}" (${msg.token.length} chars, segment now ${currentSegmentContent.length + msg.token.length} chars, interleaved=${hasInterleavedContent})`);

        // Check if we need to start a new segment after tools/shell interrupted
        if (message.needsNewSegment()) {
          console.log('[Frontend] streamToken: needsNewSegment=true, calling resumeWithNewSegment()');
          message.resumeWithNewSegment();
          currentSegmentContent = '';
          hasInterleavedContent = false; // Reset for the new segment so thinking/iteration can finalize it
          console.log('[Frontend] streamToken: reset segment state after resume (content="", interleaved=false)');
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
      }

      case 'streamReasoning':
        // Finalize current text segment before thinking content
        // This ensures thinking appears after the text that preceded it
        if (message.isStreaming() && !hasInterleavedContent) {
          console.log(`[Frontend] streamReasoning: finalizing segment before thinking (content=${currentSegmentContent.length} chars)`);
          const didFinalize = message.finalizeCurrentSegment();
          if (didFinalize) {
            hasInterleavedContent = true;
          }
        } else {
          console.log(`[Frontend] streamReasoning: skipping finalize (streaming=${message.isStreaming()}, interleaved=${hasInterleavedContent})`);
        }
        streaming.handleThinkingChunk(msg.token);
        break;

      case 'iterationStart':
        console.log(`[Frontend] iterationStart: iteration=${msg.iteration}`);
        // Finalize current text segment before thinking iteration starts
        if (message.isStreaming() && !hasInterleavedContent) {
          console.log(`[Frontend] iterationStart: finalizing segment (content=${currentSegmentContent.length} chars)`);
          const didFinalize = message.finalizeCurrentSegment();
          if (didFinalize) {
            hasInterleavedContent = true;
          }
        } else {
          console.log(`[Frontend] iterationStart: skipping finalize (streaming=${message.isStreaming()}, interleaved=${hasInterleavedContent})`);
        }
        thinking.startIteration();
        break;

      case 'endResponse':
        console.log(`[Frontend] endResponse: ending stream (interleaved=${hasInterleavedContent}, segmentContent=${currentSegmentContent.length} chars)`);
        isStreaming = false;

        // Printing surface effect removed - was too distracting

        // End stream - this publishes streaming.active: false
        // InputAreaActor subscribes to this and handles button visibility
        streaming.endStream();

        // Finalize the streaming message
        // IMPORTANT: Only update content if we didn't have interleaved content.
        // When interleaved (thinking/tools/shell appeared during streaming), the content
        // is already displayed in continuation segments - updating the original message
        // would cause duplicates.
        if (msg.message) {
          console.log(`[Frontend] endResponse: finalizing message (useContent=${!hasInterleavedContent}, contentLength=${msg.message.content?.length || 0})`);
          message.finalizeLastMessage({
            content: hasInterleavedContent ? undefined : msg.message.content,
            thinking: msg.message.reasoning
          });
        }

        // Reset segment state
        currentSegmentContent = '';
        hasInterleavedContent = false;
        console.log('[Frontend] endResponse: reset segment state (content="", interleaved=false)');

        // Complete current thinking iteration
        thinking.completeIteration();
        break;

      // ---- Shell Messages ----
      case 'shellExecuting':
        console.log(`[Frontend] shellExecuting: ${msg.commands?.length || 0} commands (streaming=${message.isStreaming()}, segmentContent=${currentSegmentContent.length} chars)`);
        if (msg.commands && Array.isArray(msg.commands)) {
          // Finalize current text segment before showing shell commands
          // This preserves the text that came before the shell execution
          if (message.isStreaming()) {
            console.log(`[Frontend] shellExecuting: finalizing segment before shell (content=${currentSegmentContent.length} chars)`);
            const didFinalize = message.finalizeCurrentSegment();
            if (didFinalize) {
              hasInterleavedContent = true;
            }
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
        console.log(`[Frontend] toolCallsStart: ${msg.tools?.length || 0} tools (streaming=${message.isStreaming()}, segmentContent=${currentSegmentContent.length} chars)`);
        if (msg.tools && Array.isArray(msg.tools)) {
          // Finalize current text segment before showing tools
          // This preserves the text that came before the tools
          if (message.isStreaming()) {
            console.log(`[Frontend] toolCallsStart: finalizing segment before tools (content=${currentSegmentContent.length} chars)`);
            const didFinalize = message.finalizeCurrentSegment();
            if (didFinalize) {
              hasInterleavedContent = true;
            }
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
            const didFinalize = message.finalizeCurrentSegment();
            if (didFinalize) {
              hasInterleavedContent = true;
            }
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
        console.log(`[Frontend] diffListChanged: ${msg.diffs?.length || 0} diffs (streaming=${message.isStreaming()}, segmentContent=${currentSegmentContent.length} chars)`);
        // Extension sends diffListChanged with full list of diffs
        // Sync with pending changes actor - track by diffId to support multiple versions of same file
        if (msg.diffs && Array.isArray(msg.diffs)) {
          // Finalize current text segment before showing pending files
          if (message.isStreaming() && msg.diffs.length > 0) {
            console.log(`[Frontend] diffListChanged: finalizing segment before diffs (content=${currentSegmentContent.length} chars)`);
            const didFinalize = message.finalizeCurrentSegment();
            if (didFinalize) {
              hasInterleavedContent = true;
            }
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

      // ---- Settings Messages (routed to actors via pub/sub) ----
      case 'modelChanged':
        currentModel = msg.model;
        // Route to ModelSelectorShadowActor
        manager.publishDirect('model.current', msg.model);
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
        // Route model settings to ModelSelectorShadowActor
        if (msg.model || msg.temperature !== undefined || msg.maxToolCalls !== undefined || msg.maxTokens !== undefined) {
          currentModel = msg.model || currentModel;
          manager.publishDirect('model.settings', {
            model: msg.model,
            temperature: msg.temperature,
            toolLimit: msg.maxToolCalls,
            maxTokens: msg.maxTokens
          });
        }

        // Route settings values to SettingsShadowActor
        manager.publishDirect('settings.values', {
          logLevel: msg.logLevel,
          logColors: msg.logColors,
          allowAllCommands: msg.allowAllCommands,
          systemPrompt: msg.systemPrompt,
          searchDepth: msg.webSearch?.searchDepth,
          searchesPerPrompt: msg.webSearch?.searchesPerPrompt,
          cacheDuration: msg.webSearch?.cacheDuration,
          autoSaveHistory: msg.autoSaveHistory,
          maxSessions: msg.maxSessions
        });
        break;

      case 'defaultSystemPrompt':
        // Route to SettingsShadowActor
        manager.publishDirect('settings.defaultPrompt', {
          model: msg.model || 'current model',
          prompt: msg.prompt || ''
        });
        break;

      case 'settingsReset':
        // Request fresh settings after reset
        vscode.postMessage({ type: 'getSettings' });
        break;

      case 'webSearchToggled':
        toolbar.setWebSearchEnabled(msg.enabled);
        break;

      // ---- File Messages (via FilesShadowActor pub/sub) ----
      case 'openFiles':
        manager.publishDirect('files.openFiles', msg.files || []);
        break;

      case 'searchResults':
        manager.publishDirect('files.searchResults', msg.results || []);
        break;

      case 'fileContent':
        manager.publishDirect('files.content', { path: msg.filePath, content: msg.content });
        break;

      // ---- Status Messages ----
      case 'error':
        statusPanel.showError(msg.error || msg.message || 'An error occurred');
        break;

      case 'warning':
        statusPanel.showWarning(msg.message);
        break;

      case 'statusMessage':
        statusPanel.showMessage(msg.message);
        break;

      case 'generationStopped':
        isStreaming = false;

        // Printing surface effect removed - was too distracting

        // End the stream - this publishes streaming.active: false
        // InputAreaActor subscribes to this and handles:
        // - Button visibility (send/stop)
        // - Pending interrupt messages
        streaming.endStream();

        // Reset segment state
        currentSegmentContent = '';
        hasInterleavedContent = false;
        break;

      // ---- History Modal Messages ----
      case 'historySessions':
        // Publish sessions to HistoryShadowActor
        manager.publishDirect('history.sessions', msg.sessions);
        break;

      case 'currentSessionId':
        // Publish current session ID to HistoryShadowActor
        manager.publishDirect('session.id', msg.sessionId);
        break;

      case 'historyCleared':
        // Optionally close the history modal after clearing
        manager.publishDirect('history.sessions', []);
        break;

      case 'openHistoryModal':
        // Open the history modal (triggered by VS Code command)
        manager.publishDirect('history.modal.open', true);
        break;

      default:
        // Unknown message type - log for debugging
        console.log('[ActorSystem] Unhandled message type:', msg.type);
    }
  });

  // ============================================
  // Model Dropdown Handlers
  // ============================================
  // Legacy UI helper functions removed (updateModelDisplay, updateTemperatureDisplay,
  // updateToolLimitDisplay, updateTokenLimitDisplay) - actors handle their own display

  // Wire up model dropdown (uses ModelSelectorShadowActor)
  const modelBtn = getElementOrNull<HTMLButtonElement>('modelBtn');
  if (modelBtn && modelSelector) {
    modelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      modelSelector.toggle();
      // Close settings if open
      if (settings?.isVisible()) settings.close();
    });
  }

  // ============================================
  // Settings & Model Selection - Handled by Shadow Actors
  // ============================================
  // Legacy settings handlers removed - SettingsShadowActor handles:
  // - Log level, colors, allow all commands
  // - System prompt (save, reset, show default)
  // - Web search settings (depth, searches per prompt, cache)
  // - History settings (auto-save, max sessions, clear)
  // - Debug test buttons
  // - Reset to defaults
  //
  // ModelSelectorShadowActor handles:
  // - Model selection
  // - Temperature, tool limit, max tokens sliders

  // Wire up settings button to SettingsShadowActor
  const settingsBtn = getElementOrNull<HTMLButtonElement>('settingsBtn');
  if (settingsBtn && settings) {
    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      settings.toggle();
      // Close model dropdown if open
      if (modelSelector?.isVisible()) modelSelector.close();
    });
  }

  // ============================================
  // File Selection - Handled by FilesShadowActor
  // ============================================
  // Legacy file modal code removed - FilesShadowActor handles:
  // - Opening/closing modal via 'files.modal.open' subscription
  // - Displaying open files via 'files.openFiles' subscription
  // - Search via 'files.searchResults' subscription
  // - File content via 'files.content' subscription
  // - All UI rendering and state management

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

  // Dev tools are loaded separately via <script> tag injection by the extension
  // when deepseek.devMode is enabled. This keeps dev code out of production bundle.
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeActorSystem);
} else {
  initializeActorSystem();
}

// Export for testing
export { initializeActorSystem };
