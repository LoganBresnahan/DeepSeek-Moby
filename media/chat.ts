/**
 * Chat Entry Point - Full Shadow DOM Actor Integration
 *
 * All UI is managed by Shadow DOM actors that own their DOM elements.
 * This provides complete style isolation and cleaner architecture.
 *
 * Uses the 1B virtual rendering architecture with VirtualListActor
 * for pooled rendering and better performance with many messages.
 */

import { EventStateManager } from './state/EventStateManager';
import {
  StreamingActor,
  ScrollActor,
  SessionActor,
  HeaderActor,
  EditModeActor,
  VirtualMessageGatewayActor,
  VirtualListActor,
  InputAreaShadowActor,
  StatusPanelShadowActor,
  ToolbarShadowActor,
  HistoryShadowActor,
  FilesShadowActor,
  CommandsShadowActor,
  CommandRulesModalActor,
  SystemPromptModalActor,
  ModelSelectorShadowActor,
  SettingsShadowActor,
  DrawingServerShadowActor,
  PlanPopupShadowActor,
  WebSearchPopupShadowActor
} from './actors';
// Dev-only actor - not included in production bundle
import { InspectorShadowActor } from './dev/inspector';
import { AnimationHelper } from './utils';
import { webviewTracer } from './tracing';
import { createLogger, webviewLogBuffer } from './logging';

const log = createLogger('ActorSystem');

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

// All coordination state is managed by VirtualMessageGatewayActor:
// - Streaming state: gateway.phase, gateway.currentTurn
// - CQRS: TurnEventLog per turn → TurnProjector → VirtualListActor
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

  // Initialize webview tracer for unified observability
  webviewTracer.initialize(vscode as any);
  manager.setTracer(webviewTracer);

  // Initialize webview log buffer for log syncing to extension
  webviewLogBuffer.initialize(vscode as any);

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

  // ============================================
  // VirtualListActor (1B Architecture)
  // ============================================
  // Uses VirtualListActor with pooled MessageTurnActors for efficient
  // rendering of conversations with many messages.

  log.info('Using virtual rendering mode (1B architecture)');

  const virtualList = new VirtualListActor(manager, chatMessages, {
    config: {
      minPoolSize: 5,
      maxPoolSize: 20,
      overscan: 2,
      defaultTurnHeight: 150
    },
    postMessage: (msg) => vscode.postMessage(msg),
    onPendingFileAction: (action, _fileId, diffId, filePath) => {
      if (action === 'accept' && diffId) {
        vscode.postMessage({ type: 'acceptSpecificDiff', diffId });
      } else if (action === 'reject' && diffId) {
        vscode.postMessage({ type: 'rejectSpecificDiff', diffId });
      } else if (action === 'focus') {
        // Focus the file - send both diffId and filePath so extension can fall back
        // to opening the file directly if the diff was already applied/closed
        vscode.postMessage({ type: 'focusFile', diffId, filePath });
      }
    },
    onCommandApprovalAction: (command, decision, persistent, prefix) => {
      vscode.postMessage({
        type: 'commandApprovalResponse',
        command,
        decision,
        persistent,
        prefix,
      });
    }
  });

  log.info('VirtualListActor initialized');

  // InputAreaShadowActor - owns its DOM, renders into inputAreaContainer
  const inputArea = new InputAreaShadowActor(manager, inputAreaContainer, vscode);

  // StatusPanelShadowActor - owns its DOM, renders into statusPanelContainer
  const statusPanel = new StatusPanelShadowActor(manager, statusPanelContainer, mobyIconUrl, vscode);

  // ToolbarShadowActor - owns its DOM, renders into toolbarContainer
  const toolbar = new ToolbarShadowActor(manager, toolbarContainer, vscode);

  // PlanPopupShadowActor - Plans popup (trigger in toolbar shadow DOM)
  const planPopupContainer = document.createElement('div');
  planPopupContainer.id = 'planPopupHost';
  toolbarContainer.appendChild(planPopupContainer);
  const planPopup = new PlanPopupShadowActor(manager, planPopupContainer, vscode);
  toolbar.onPlan(() => planPopup.toggle());
  const planBtn = toolbar.getButton('.plan-btn');
  if (planBtn) planPopup.setTriggerElement(planBtn);

  // WebSearchPopupShadowActor - Web search settings popup (trigger in toolbar shadow DOM)
  const webSearchPopupContainer = document.createElement('div');
  webSearchPopupContainer.id = 'webSearchPopupHost';
  toolbarContainer.appendChild(webSearchPopupContainer);
  const webSearchPopup = new WebSearchPopupShadowActor(manager, webSearchPopupContainer, vscode);
  toolbar.onSearch(() => webSearchPopup.toggle());
  const searchBtn = toolbar.getButton('.search-btn');
  if (searchBtn) webSearchPopup.setTriggerElement(searchBtn);

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

  // CommandRulesModalActor - Command rules management modal
  const rulesHost = document.createElement('div');
  rulesHost.id = 'rulesHost';
  rulesHost.style.cssText = 'position: fixed; top: 0; left: 0; width: 0; height: 0;';
  document.body.appendChild(rulesHost);
  const commandRules = new CommandRulesModalActor(manager, rulesHost, vscode);

  // SystemPromptModalActor - System prompt editor modal
  const systemPromptHost = document.createElement('div');
  systemPromptHost.id = 'systemPromptHost';
  systemPromptHost.style.cssText = 'position: fixed; top: 0; left: 0; width: 0; height: 0;';
  document.body.appendChild(systemPromptHost);
  const systemPromptModal = new SystemPromptModalActor(manager, systemPromptHost, vscode);

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

  // DrawingServerShadowActor - Drawing server popup (positioned relative to button)
  const drawingServerHost = getElementOrNull<HTMLElement>('drawingServerBtn')?.parentElement;
  let drawingServerActor: DrawingServerShadowActor | null = null;
  if (drawingServerHost) {
    drawingServerHost.style.position = 'relative';
    const drawingServerContainer = document.createElement('div');
    drawingServerContainer.id = 'drawingServerActorHost';
    drawingServerHost.appendChild(drawingServerContainer);
    drawingServerActor = new DrawingServerShadowActor(manager, drawingServerContainer, vscode);
  }

  // Wire up drawing server button
  const drawingServerBtn = getElementOrNull<HTMLButtonElement>('drawingServerBtn');
  if (drawingServerBtn && drawingServerActor) {
    drawingServerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      drawingServerActor!.toggle();
    });
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
    // Add user message to UI immediately via VirtualListActor
    const fileNames = attachments?.map(a => a.name) || [];

    const turnId = `turn-user-${Date.now()}`;
    virtualList.addTurn(turnId, 'user', {
      files: fileNames.length > 0 ? fileNames : undefined,
      timestamp: Date.now()
    });
    virtualList.addTextSegment(turnId, content);

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
    virtualList.setEditMode(mode);
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

  // Sync initial edit mode
  const initialEditMode = editModeActor.getMode();
  toolbar.setEditMode(initialEditMode);
  virtualList.setEditMode(initialEditMode);

  // ============================================
  // Message Gateway Actor
  // ============================================
  // The VirtualMessageGatewayActor is the boundary between the VS Code extension
  // and the internal actor system. It handles all message routing and
  // coordination state. See ARCHITECTURE/message-gateway.md for details.

  const gatewayHost = document.createElement('div');
  gatewayHost.id = 'gatewayHost';
  gatewayHost.style.display = 'none';
  document.body.appendChild(gatewayHost);

  const gateway = new VirtualMessageGatewayActor(manager, gatewayHost, vscode, {
    streaming,
    session,
    editMode: editModeActor,
    virtualList,
    inputArea,
    toolbar,
    history,
  });
  log.info('Initialized with VirtualMessageGatewayActor');

  // ============================================
  // Model Dropdown Handlers
  // ============================================

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
  // SettingsShadowActor handles:
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
  // FilesShadowActor handles:
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
    scroll,
    inputArea,
    statusPanel,
    toolbar,
    history,
    files,
    commandRules,
    systemPromptModal,
    commands,
    modelSelector,
    settings,
    drawingServer: drawingServerActor,
    planPopup,
    webSearchPopup,
    inspector,
    virtualList,
  };

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
