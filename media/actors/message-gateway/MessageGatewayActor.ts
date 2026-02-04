/**
 * MessageGatewayActor
 *
 * The boundary between the external system (VS Code extension) and the internal
 * actor system. This is an implementation of the Gateway/Anti-Corruption Layer pattern.
 *
 * Responsibilities:
 * 1. Receive external messages from VS Code extension
 * 2. Maintain coordination state across message events
 * 3. Orchestrate internal actors with ordering guarantees
 * 4. Translate external protocol → internal actor calls
 *
 * Why this exists:
 * - External messages arrive asynchronously, in arbitrary order
 * - Internal actors need coordinated, ordered operations
 * - Some operations span multiple message events (streaming sessions)
 * - Pure pub/sub is too slow for per-token streaming (~100 tokens/sec)
 *
 * Coordination State:
 * - currentSegmentContent: Accumulated content during streaming
 * - hasInterleavedContent: Whether tools/thinking interrupted text flow
 * - currentShellSegmentId: Pending shell operation tracking
 *
 * Publications (for debugging/observability):
 * - gateway.segmentContent: Current accumulated segment content
 * - gateway.interleaved: Whether interleaving has occurred
 * - gateway.phase: Current streaming phase
 *
 * @see ARCHITECTURE/message-gateway.md for detailed documentation
 */

import { EventStateActor } from '../../state/EventStateActor';
import { EventStateManager } from '../../state/EventStateManager';
import type { ActorConfig } from '../../state/types';

// Import actor types for type safety
import type { StreamingActor } from '../streaming';
import type { SessionActor } from '../session';
import type { EditModeActor } from '../edit-mode';
import type { MessageShadowActor } from '../message/MessageShadowActor';
import type { ShellShadowActor } from '../shell/ShellShadowActor';
import type { ToolCallsShadowActor } from '../tools/ToolCallsShadowActor';
import type { ThinkingShadowActor } from '../thinking/ThinkingShadowActor';
import type { PendingChangesShadowActor } from '../pending/PendingChangesShadowActor';
import type { InputAreaShadowActor } from '../input-area/InputAreaShadowActor';
import type { StatusPanelShadowActor } from '../status-panel/StatusPanelShadowActor';
import type { ToolbarShadowActor } from '../toolbar/ToolbarShadowActor';
import type { HistoryShadowActor } from '../history';

export type GatewayPhase = 'idle' | 'streaming' | 'waiting-for-results';

export interface ActorRefs {
  streaming: StreamingActor;
  session: SessionActor;
  editMode: EditModeActor;
  message: MessageShadowActor;
  shell: ShellShadowActor;
  toolCalls: ToolCallsShadowActor;
  thinking: ThinkingShadowActor;
  pending: PendingChangesShadowActor;
  inputArea: InputAreaShadowActor;
  statusPanel: StatusPanelShadowActor;
  toolbar: ToolbarShadowActor;
  history: HistoryShadowActor;
}

export interface VSCodeAPI {
  postMessage(message: unknown): void;
  getState(): Record<string, unknown> | undefined;
  setState(state: Record<string, unknown>): void;
}

export class MessageGatewayActor extends EventStateActor {
  // Actor references for coordinated operations
  private _actors: ActorRefs;
  private _vscode: VSCodeAPI;
  private _manager: EventStateManager;

  // ============================================
  // Coordination State
  // ============================================
  // These exist because message handling is stateful across multiple events.
  // They provide ordering guarantees that pure pub/sub cannot.

  /** Accumulated content for the current streaming segment */
  private _segmentContent = '';

  /** Whether tools/thinking interrupted text flow (prevents duplicate content in endResponse) */
  private _hasInterleaved = false;

  /** Pending shell segment awaiting results */
  private _shellSegmentId: string | null = null;

  /** Current phase for debugging */
  private _phase: GatewayPhase = 'idle';

  // Message handler reference for cleanup
  private _messageHandler: ((event: MessageEvent) => void) | null = null;

  constructor(
    manager: EventStateManager,
    element: HTMLElement,
    vscode: VSCodeAPI,
    actors: ActorRefs
  ) {
    const config: ActorConfig = {
      manager,
      element,
      publications: {
        // Publish coordination state for debugging/inspector
        'gateway.segmentContent': () => this._segmentContent,
        'gateway.interleaved': () => this._hasInterleaved,
        'gateway.phase': () => this._phase,
      },
      subscriptions: {
        // No subscriptions - this actor receives messages directly from window
      },
      enableDOMChangeDetection: false,
    };

    super(config);

    this._actors = actors;
    this._vscode = vscode;
    this._manager = manager;

    this.setupMessageListener();
  }

  // ============================================
  // Message Listener Setup
  // ============================================

  private setupMessageListener(): void {
    if (typeof window === 'undefined') return;

    this._messageHandler = (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || !msg.type) return;

      console.log('[MessageGateway] Received:', msg.type);
      this.handleMessage(msg);
    };

    window.addEventListener('message', this._messageHandler);
  }

  // ============================================
  // Message Router (The Switch Statement)
  // ============================================

  private handleMessage(msg: { type: string; [key: string]: unknown }): void {
    const { streaming, session, editMode, message, shell, toolCalls, thinking, pending, statusPanel, toolbar } = this._actors;

    switch (msg.type) {
      // ---- Streaming Messages ----
      case 'startResponse':
        this.handleStartResponse(msg);
        break;

      case 'streamToken':
        this.handleStreamToken(msg);
        break;

      case 'streamReasoning':
        this.handleStreamReasoning(msg);
        break;

      case 'iterationStart':
        this.handleIterationStart(msg);
        break;

      case 'endResponse':
        this.handleEndResponse(msg);
        break;

      // ---- Shell Messages ----
      case 'shellExecuting':
        this.handleShellExecuting(msg);
        break;

      case 'shellResults':
        this.handleShellResults(msg);
        break;

      // ---- Tool Calls Messages ----
      case 'toolCallsStart':
        this.handleToolCallsStart(msg);
        break;

      case 'toolCallUpdate':
        this.handleToolCallUpdate(msg);
        break;

      case 'toolCallsUpdate':
        this.handleToolCallsUpdate(msg);
        break;

      case 'toolCallsEnd':
        toolCalls.complete();
        break;

      // ---- Pending Files Messages ----
      case 'pendingFileAdd':
        this.handlePendingFileAdd(msg);
        break;

      case 'pendingFileUpdate':
        if (msg.fileId && msg.status) {
          pending.updateFile(msg.fileId as string, { status: msg.status as 'pending' | 'applied' | 'rejected' });
        }
        break;

      case 'pendingFileAccept':
        if (msg.fileId) {
          pending.acceptFile(msg.fileId as string);
        }
        break;

      case 'pendingFileReject':
        if (msg.fileId) {
          pending.rejectFile(msg.fileId as string);
        }
        break;

      case 'pendingFilesSetEditMode':
        if (msg.mode && ['manual', 'ask', 'auto'].includes(msg.mode as string)) {
          pending.setEditMode(msg.mode as 'manual' | 'ask' | 'auto');
        }
        break;

      case 'diffListChanged':
        this.handleDiffListChanged(msg);
        break;

      // ---- History Messages ----
      case 'addMessage':
        this.handleAddMessage(msg);
        break;

      case 'loadHistory':
        this.handleLoadHistory(msg);
        break;

      case 'clearChat':
        this.handleClearChat();
        break;

      // ---- Session Messages (routed to SessionActor) ----
      case 'sessionLoaded':
        session.handleSessionLoaded({
          sessionId: msg.sessionId as string,
          title: msg.title as string,
          model: msg.model as string
        });
        break;

      case 'sessionCreated':
        session.handleSessionCreated({
          sessionId: msg.sessionId as string,
          model: msg.model as string
        });
        break;

      case 'sessionError':
        session.handleSessionError({ error: msg.error as string });
        break;

      // ---- Settings Messages (routed to actors via pub/sub) ----
      case 'modelChanged':
        // Route to SessionActor for state management
        session.handleModelChanged({ model: msg.model as string });
        // Also route to ModelSelectorShadowActor for UI update
        this._manager.publishDirect('model.current', msg.model);
        break;

      case 'editModeSettings':
        this.handleEditModeSettings(msg);
        break;

      case 'settings':
        this.handleSettings(msg);
        break;

      case 'defaultSystemPrompt':
        this._manager.publishDirect('settings.defaultPrompt', {
          model: msg.model || 'current model',
          prompt: msg.prompt || ''
        });
        break;

      case 'settingsReset':
        this._vscode.postMessage({ type: 'getSettings' });
        break;

      case 'webSearchToggled':
        toolbar.setWebSearchEnabled(msg.enabled as boolean);
        break;

      // ---- File Messages (via FilesShadowActor pub/sub) ----
      case 'openFiles':
        this._manager.publishDirect('files.openFiles', msg.files || []);
        break;

      case 'searchResults':
        this._manager.publishDirect('files.searchResults', msg.results || []);
        break;

      case 'fileContent':
        this._manager.publishDirect('files.content', { path: msg.filePath, content: msg.content });
        break;

      // ---- Status Messages ----
      case 'error':
        statusPanel.showError((msg.error || msg.message || 'An error occurred') as string);
        break;

      case 'warning':
        statusPanel.showWarning(msg.message as string);
        break;

      case 'statusMessage':
        statusPanel.showMessage(msg.message as string);
        break;

      case 'generationStopped':
        this.handleGenerationStopped();
        break;

      // ---- History Modal Messages ----
      case 'historySessions':
        this._manager.publishDirect('history.sessions', msg.sessions);
        break;

      case 'currentSessionId':
        this._manager.publishDirect('session.id', msg.sessionId);
        break;

      case 'historyCleared':
        this._manager.publishDirect('history.sessions', []);
        break;

      case 'openHistoryModal':
        this._manager.publishDirect('history.modal.open', true);
        break;

      default:
        console.log('[MessageGateway] Unhandled message type:', msg.type);
    }
  }

  // ============================================
  // Streaming Message Handlers
  // ============================================

  private handleStartResponse(msg: { type: string; [key: string]: unknown }): void {
    const { streaming, session } = this._actors;

    console.log('[MessageGateway] startResponse: beginning new stream, isReasoner=' + msg.isReasoner);

    // Reset coordination state for new response
    this._segmentContent = '';
    this._hasInterleaved = false;
    this._phase = 'streaming';
    this.publishCoordinationState();

    // Start stream - publishes streaming.active: true
    streaming.startStream(
      (msg.messageId as string) || `msg-${Date.now()}`,
      session.model
    );
  }

  private handleStreamToken(msg: { type: string; [key: string]: unknown }): void {
    const { streaming, session, message } = this._actors;
    const token = msg.token as string;

    const tokenPreview = token.length > 50 ? token.slice(0, 50) + '...' : token;
    console.log(`[MessageGateway] streamToken: "${tokenPreview.replace(/\n/g, '\\n')}" (${token.length} chars, segment now ${this._segmentContent.length + token.length} chars, interleaved=${this._hasInterleaved})`);

    // Check if we need to start a new segment after tools/shell interrupted
    if (message.needsNewSegment()) {
      console.log('[MessageGateway] streamToken: needsNewSegment=true, calling resumeWithNewSegment()');
      message.resumeWithNewSegment();
      this._segmentContent = '';
      this._hasInterleaved = false;
      this.publishCoordinationState();
    }

    // Accumulate content for current segment
    this._segmentContent += token;

    // In reasoner mode, strip shell tags before displaying
    const isReasonerMode = session.model === 'deepseek-reasoner';
    const displayContent = isReasonerMode
      ? this._segmentContent.replace(/<shell>[\s\S]*?<\/shell>/gi, '').trim()
      : this._segmentContent;

    message.updateCurrentSegmentContent(displayContent);
    streaming.handleContentChunk(token);
  }

  private handleStreamReasoning(msg: { type: string; [key: string]: unknown }): void {
    const { streaming, message } = this._actors;

    // Finalize current text segment before thinking content
    if (message.isStreaming() && !this._hasInterleaved) {
      console.log(`[MessageGateway] streamReasoning: finalizing segment before thinking (content=${this._segmentContent.length} chars)`);
      const didFinalize = message.finalizeCurrentSegment();
      if (didFinalize) {
        this._hasInterleaved = true;
        this.publishCoordinationState();
      }
    }

    streaming.handleThinkingChunk(msg.token as string);
  }

  private handleIterationStart(msg: { type: string; [key: string]: unknown }): void {
    const { thinking, message } = this._actors;

    console.log(`[MessageGateway] iterationStart: iteration=${msg.iteration}`);

    // Finalize current text segment before thinking iteration starts
    if (message.isStreaming() && !this._hasInterleaved) {
      console.log(`[MessageGateway] iterationStart: finalizing segment (content=${this._segmentContent.length} chars)`);
      const didFinalize = message.finalizeCurrentSegment();
      if (didFinalize) {
        this._hasInterleaved = true;
        this.publishCoordinationState();
      }
    }

    thinking.startIteration();
  }

  private handleEndResponse(msg: { type: string; [key: string]: unknown }): void {
    const { streaming, thinking, message } = this._actors;

    console.log(`[MessageGateway] endResponse: ending stream (interleaved=${this._hasInterleaved}, segmentContent=${this._segmentContent.length} chars)`);

    // End stream - publishes streaming.active: false
    streaming.endStream();

    // Finalize the streaming message
    // IMPORTANT: Only update content if we didn't have interleaved content.
    // When interleaved, content is already in continuation segments.
    if (msg.message) {
      const msgData = msg.message as { content?: string; reasoning?: string };
      console.log(`[MessageGateway] endResponse: finalizing message (useContent=${!this._hasInterleaved}, contentLength=${msgData.content?.length || 0})`);
      message.finalizeLastMessage({
        content: this._hasInterleaved ? undefined : msgData.content,
        thinking: msgData.reasoning
      });
    }

    // Reset coordination state
    this._segmentContent = '';
    this._hasInterleaved = false;
    this._phase = 'idle';
    this.publishCoordinationState();

    // Complete current thinking iteration
    thinking.completeIteration();
  }

  // ============================================
  // Shell Message Handlers
  // ============================================

  private handleShellExecuting(msg: { type: string; [key: string]: unknown }): void {
    const { shell, message } = this._actors;
    const commands = msg.commands as Array<{ command: string; description?: string }>;

    console.log(`[MessageGateway] shellExecuting: ${commands?.length || 0} commands`);

    if (commands && Array.isArray(commands)) {
      // Finalize current text segment before showing shell commands
      if (message.isStreaming()) {
        const didFinalize = message.finalizeCurrentSegment();
        if (didFinalize) {
          this._hasInterleaved = true;
          this.publishCoordinationState();
        }
      }

      // Create segment and track ID for results
      // Extract just the command strings - ShellShadowActor expects string[]
      const commandStrings = commands.map(c => c.command);
      this._shellSegmentId = shell.createSegment(commandStrings);
      this._phase = 'waiting-for-results';
      shell.startSegment(this._shellSegmentId);
      this.publishCoordinationState();
    }
  }

  private handleShellResults(msg: { type: string; [key: string]: unknown }): void {
    const { shell } = this._actors;
    const results = msg.results as Array<{ output?: string; success?: boolean; exitCode?: number }>;

    if (results && Array.isArray(results) && this._shellSegmentId) {
      shell.setResults(this._shellSegmentId, results.map(result => ({
        success: result.success !== undefined ? result.success : (result.exitCode === 0),
        output: result.output
      })));
      this._shellSegmentId = null;
      this._phase = 'streaming'; // Back to streaming after results
      this.publishCoordinationState();
    }
  }

  // ============================================
  // Tool Calls Message Handlers
  // ============================================

  private handleToolCallsStart(msg: { type: string; [key: string]: unknown }): void {
    const { toolCalls, message } = this._actors;
    const tools = msg.tools as Array<{ name: string; detail: string }>;

    console.log(`[MessageGateway] toolCallsStart: ${tools?.length || 0} tools`);

    if (tools && Array.isArray(tools)) {
      // Finalize current text segment before showing tools
      if (message.isStreaming()) {
        const didFinalize = message.finalizeCurrentSegment();
        if (didFinalize) {
          this._hasInterleaved = true;
          this.publishCoordinationState();
        }
      }

      toolCalls.startBatch(tools.map(t => ({
        name: t.name,
        detail: t.detail
      })));
    }
  }

  private handleToolCallUpdate(msg: { type: string; [key: string]: unknown }): void {
    const { toolCalls } = this._actors;

    if (msg.index !== undefined && msg.status) {
      const currentCalls = toolCalls.getCalls();
      if (currentCalls[msg.index as number]) {
        toolCalls.updateBatch(currentCalls.map((t, i) => ({
          name: t.name,
          detail: t.detail,
          status: i === (msg.index as number) ? (msg.status as 'pending' | 'running' | 'done' | 'error') : t.status
        })));
      }
    }
  }

  private handleToolCallsUpdate(msg: { type: string; [key: string]: unknown }): void {
    const { toolCalls } = this._actors;
    const tools = msg.tools as Array<{ name: string; detail: string; status?: string }>;

    if (tools && Array.isArray(tools)) {
      toolCalls.updateBatch(tools.map(t => ({
        name: t.name,
        detail: t.detail,
        status: t.status as 'pending' | 'running' | 'done' | 'error' | undefined
      })));
    }
  }

  // ============================================
  // Pending Files Message Handlers
  // ============================================

  private handlePendingFileAdd(msg: { type: string; [key: string]: unknown }): void {
    const { pending, message } = this._actors;

    if (msg.filePath) {
      // Finalize current text segment before showing pending files
      if (message.isStreaming()) {
        const didFinalize = message.finalizeCurrentSegment();
        if (didFinalize) {
          this._hasInterleaved = true;
          this.publishCoordinationState();
        }
      }
      pending.addFile(msg.filePath as string, msg.diffId as string | undefined, msg.iteration as number | undefined);
    }
  }

  private handleDiffListChanged(msg: { type: string; [key: string]: unknown }): void {
    const { pending, message } = this._actors;
    const diffs = msg.diffs as Array<{ filePath: string; status: string; diffId?: string; iteration?: number; superseded?: boolean }>;

    console.log(`[MessageGateway] diffListChanged: ${diffs?.length || 0} diffs`);

    if (diffs && Array.isArray(diffs)) {
      // Finalize current text segment before showing pending files
      if (message.isStreaming() && diffs.length > 0) {
        const didFinalize = message.finalizeCurrentSegment();
        if (didFinalize) {
          this._hasInterleaved = true;
          this.publishCoordinationState();
        }
      }

      // Get current pending files and build a map by diffId
      const currentFiles = pending.getFiles();
      const currentDiffIds = new Map(currentFiles.map(f => [f.diffId, f]));

      // Process each diff from backend
      for (const diff of diffs) {
        const existingFile = diff.diffId ? currentDiffIds.get(diff.diffId) : undefined;

        if (!existingFile) {
          pending.addFile(diff.filePath, diff.diffId, diff.iteration);
        } else {
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
      if (msg.editMode && ['manual', 'ask', 'auto'].includes(msg.editMode as string)) {
        pending.setEditMode(msg.editMode as 'manual' | 'ask' | 'auto');
      }
    }
  }

  // ============================================
  // History Message Handlers
  // ============================================

  private handleAddMessage(msg: { type: string; [key: string]: unknown }): void {
    const { message } = this._actors;
    const msgData = msg.message as { role: string; content: string; files?: string[]; reasoning?: string };

    if (msgData?.role === 'user') {
      message.addUserMessage(msgData.content, msgData.files);
    } else if (msgData?.role === 'assistant') {
      message.addAssistantMessage(msgData.content, {
        thinking: msgData.reasoning
      });
    }
  }

  private handleLoadHistory(msg: { type: string; [key: string]: unknown }): void {
    const { message, session } = this._actors;
    const history = msg.history as Array<{ role: string; content: string; files?: string[]; reasoning_content?: string }>;

    // Update session loading state
    session.handleLoadHistory();

    message.clear();

    if (history && Array.isArray(history)) {
      history.forEach(m => {
        if (m.role === 'user') {
          message.addUserMessage(m.content, m.files);
        } else if (m.role === 'assistant') {
          message.addAssistantMessage(m.content, {
            thinking: m.reasoning_content
          });
        }
      });
    }
  }

  private handleClearChat(): void {
    const { message, toolCalls, shell, thinking, pending } = this._actors;

    message.clear();
    toolCalls.clear();
    shell.clear();
    thinking.clear();
    pending.clear();

    // Reset coordination state
    this._shellSegmentId = null;
    this._segmentContent = '';
    this._hasInterleaved = false;
    this._phase = 'idle';
    this.publishCoordinationState();
  }

  // ============================================
  // Settings Message Handlers
  // ============================================

  private handleEditModeSettings(msg: { type: string; [key: string]: unknown }): void {
    const { editMode, toolbar, pending, message } = this._actors;

    if (msg.mode && editMode.isValidMode(msg.mode)) {
      const mode = msg.mode as 'manual' | 'ask' | 'auto';
      editMode.setMode(mode);
      toolbar.setEditMode(mode);
      pending.setEditMode(mode);
      message.setEditMode(mode);
    }
  }

  private handleSettings(msg: { type: string; [key: string]: unknown }): void {
    // Route model settings to ModelSelectorShadowActor
    if (msg.model || msg.temperature !== undefined || msg.maxToolCalls !== undefined || msg.maxTokens !== undefined) {
      this._manager.publishDirect('model.settings', {
        model: msg.model,
        temperature: msg.temperature,
        toolLimit: msg.maxToolCalls,
        maxTokens: msg.maxTokens
      });
    }

    // Route settings values to SettingsShadowActor
    const webSearch = msg.webSearch as { searchDepth?: number; searchesPerPrompt?: number; cacheDuration?: number } | undefined;
    this._manager.publishDirect('settings.values', {
      logLevel: msg.logLevel,
      logColors: msg.logColors,
      allowAllCommands: msg.allowAllCommands,
      systemPrompt: msg.systemPrompt,
      searchDepth: webSearch?.searchDepth,
      searchesPerPrompt: webSearch?.searchesPerPrompt,
      cacheDuration: webSearch?.cacheDuration,
      autoSaveHistory: msg.autoSaveHistory,
      maxSessions: msg.maxSessions
    });
  }

  private handleGenerationStopped(): void {
    const { streaming } = this._actors;

    // End the stream - publishes streaming.active: false
    streaming.endStream();

    // Reset coordination state
    this._segmentContent = '';
    this._hasInterleaved = false;
    this._phase = 'idle';
    this.publishCoordinationState();
  }

  // ============================================
  // Coordination State Publishing
  // ============================================

  private publishCoordinationState(): void {
    this.publish({
      'gateway.segmentContent': this._segmentContent,
      'gateway.interleaved': this._hasInterleaved,
      'gateway.phase': this._phase,
    });
  }

  // ============================================
  // Public API (Getters for synchronous queries)
  // ============================================

  /** Get current accumulated segment content */
  get segmentContent(): string {
    return this._segmentContent;
  }

  /** Check if interleaving has occurred */
  get hasInterleaved(): boolean {
    return this._hasInterleaved;
  }

  /** Get current phase */
  get phase(): GatewayPhase {
    return this._phase;
  }

  /** Get pending shell segment ID */
  get shellSegmentId(): string | null {
    return this._shellSegmentId;
  }

  // ============================================
  // Lifecycle
  // ============================================

  destroy(): void {
    if (this._messageHandler) {
      window.removeEventListener('message', this._messageHandler);
      this._messageHandler = null;
    }
    super.destroy();
  }
}
