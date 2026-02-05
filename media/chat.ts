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
  SessionActor,
  HeaderActor,
  EditModeActor,
  MessageGatewayActor,
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

// All coordination state is now managed by MessageGatewayActor:
// - Streaming state: gateway.segmentContent, gateway.interleaved, gateway.phase
// - Shell segment tracking: internal to gateway
// - Edit mode: EditModeActor
// - Session/model: SessionActor
//
// See ARCHITECTURE/message-gateway.md for the Gateway pattern documentation

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

  // SessionActor - manages session state and publishes session.id, session.title, session.model
  // Has its own message listener for sessionLoaded, sessionCreated, modelChanged
  const sessionHost = document.createElement('div');
  sessionHost.id = 'sessionHost';
  sessionHost.style.display = 'none';
  document.body.appendChild(sessionHost);
  // Cast vscode to any - SessionActor's VSCodeAPI type is compatible but uses `unknown` for setState
  const session = new SessionActor(manager, sessionHost, vscode as any);

  // HeaderActor - subscribes to session.model and updates #currentModelName display
  // Element references are passed in (not found via document.getElementById)
  const headerHost = document.createElement('div');
  headerHost.id = 'headerHost';
  headerHost.style.display = 'none';
  document.body.appendChild(headerHost);
  const modelNameEl = getElement<HTMLElement>('currentModelName');
  const header = new HeaderActor(manager, headerHost, { modelNameEl });

  // EditModeActor - manages edit mode state ('manual' | 'ask' | 'auto')
  // Single source of truth for edit mode, publishes to 'edit.mode'
  const editModeHost = document.createElement('div');
  editModeHost.id = 'editModeHost';
  editModeHost.style.display = 'none';
  document.body.appendChild(editModeHost);
  const editModeActor = new EditModeActor(manager, editModeHost);

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
    editModeActor.setMode(mode);
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

  // Sync initial edit mode - actors read from editModeActor
  const initialEditMode = editModeActor.getMode();
  pending.setEditMode(initialEditMode);
  toolbar.setEditMode(initialEditMode);
  message.setEditMode(initialEditMode);

  // ============================================
  // Message Gateway Actor
  // ============================================
  // The MessageGatewayActor is the boundary between the VS Code extension
  // and the internal actor system. It handles all message routing and
  // coordination state. See ARCHITECTURE/message-gateway.md for details.

  const gatewayHost = document.createElement('div');
  gatewayHost.id = 'gatewayHost';
  gatewayHost.style.display = 'none';
  document.body.appendChild(gatewayHost);

  const gateway = new MessageGatewayActor(manager, gatewayHost, vscode, {
    streaming,
    session,
    editMode: editModeActor,
    message,
    shell,
    toolCalls,
    thinking,
    pending,
    inputArea,
    statusPanel,
    toolbar,
    history,
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
    session,
    editMode: editModeActor,
    gateway,
    header,
    message,
    scroll,
    shell,
    toolCalls,
    thinking,
    pending,
    inputArea,
    statusPanel,
    toolbar,
    history,
    files,
    commands,
    modelSelector,
    settings,
    inspector,
  };

  console.log('[ActorSystem] Initialized with MessageGatewayActor (full actor mode)');

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
