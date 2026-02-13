/**
 * VirtualMessageGatewayActor
 *
 * Updated MessageGatewayActor that uses VirtualListActor for turn-based content
 * management instead of individual interleaved actors.
 *
 * This is the Phase 3 integration of the 1B Virtual Rendering architecture.
 *
 * Key differences from MessageGatewayActor:
 * - Uses VirtualListActor instead of MessageShadowActor, ShellShadowActor, etc.
 * - Routes all content through turn-based API
 * - Tracks current turn ID instead of individual actor state
 *
 * @see ARCHITECTURE/message-gateway.md for Gateway pattern documentation
 * @see ARCHITECTURE/actor-system.md for 1B architecture documentation
 */

import { EventStateActor } from '../../state/EventStateActor';
import { EventStateManager } from '../../state/EventStateManager';
import type { ActorConfig } from '../../state/types';
import { webviewTracer } from '../../tracing';
import { createLogger, setLogLevel, LogLevel } from '../../logging';

// Import actor types for type safety
import type { StreamingActor } from '../streaming';
import type { SessionActor } from '../session';
import type { EditModeActor } from '../edit-mode';
import type { InputAreaShadowActor } from '../input-area/InputAreaShadowActor';
import type { StatusPanelShadowActor } from '../status-panel/StatusPanelShadowActor';
import type { ToolbarShadowActor } from '../toolbar/ToolbarShadowActor';
import type { HistoryShadowActor } from '../history';
import type { VirtualListActor } from '../virtual-list';
import type { EditMode } from '../turn/types';

const log = createLogger('VirtualGateway');

export type GatewayPhase = 'idle' | 'streaming' | 'waiting-for-results';

/**
 * Actor references for VirtualMessageGatewayActor.
 * Note: Content actors (message, shell, toolCalls, thinking, pending) are replaced
 * by a single VirtualListActor.
 */
export interface VirtualActorRefs {
  streaming: StreamingActor;
  session: SessionActor;
  editMode: EditModeActor;
  virtualList: VirtualListActor;
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

export class VirtualMessageGatewayActor extends EventStateActor {
  // Actor references for coordinated operations
  private _actors: VirtualActorRefs;
  private _vscode: VSCodeAPI;
  private _manager: EventStateManager;

  // ============================================
  // Coordination State
  // ============================================

  /** Accumulated content for the current streaming segment */
  private _segmentContent = '';

  /** Whether tools/thinking interrupted text flow */
  private _hasInterleaved = false;

  /** Pending shell segment awaiting results */
  private _shellSegmentId: string | null = null;

  /** Current phase for debugging */
  private _phase: GatewayPhase = 'idle';

  /** Current turn ID during streaming */
  private _currentTurnId: string | null = null;

  /** Last streaming turn ID - used for late-arriving messages like diffListChanged */
  private _lastStreamingTurnId: string | null = null;

  /** Message counter for generating turn IDs */
  private _messageCounter = 0;

  // Message handler reference for cleanup
  private _messageHandler: ((event: MessageEvent) => void) | null = null;

  constructor(
    manager: EventStateManager,
    element: HTMLElement,
    vscode: VSCodeAPI,
    actors: VirtualActorRefs
  ) {
    const config: ActorConfig = {
      manager,
      element,
      publications: {
        'gateway.segmentContent': () => this._segmentContent,
        'gateway.interleaved': () => this._hasInterleaved,
        'gateway.phase': () => this._phase,
        'gateway.currentTurn': () => this._currentTurnId,
      },
      subscriptions: {},
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

      this.handleMessage(msg);
    };

    window.addEventListener('message', this._messageHandler);
  }

  // ============================================
  // Message Router
  // ============================================

  private handleMessage(msg: { type: string; [key: string]: unknown }): void {
    const { streaming, session, virtualList, statusPanel, toolbar } = this._actors;

    // Log key lifecycle messages (not per-chunk streaming messages)
    const lifecycleTypes = [
      'startResponse', 'endResponse',
      'toolCallsStart', 'toolCallsEnd',
      'iterationStart'
    ];
    if (lifecycleTypes.includes(msg.type)) {
      log.debug('Received:', msg.type);
    }

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
        if (this._currentTurnId) {
          virtualList.completeToolBatch(this._currentTurnId);
        }
        break;

      // ---- Pending Files Messages ----
      case 'pendingFileAdd':
        this.handlePendingFileAdd(msg);
        break;

      case 'pendingFileUpdate':
        if (msg.fileId && msg.status && this._currentTurnId) {
          virtualList.updatePendingStatus(
            this._currentTurnId,
            msg.fileId as string,
            msg.status as 'pending' | 'applied' | 'rejected' | 'superseded'
          );
        }
        break;

      case 'pendingFilesSetEditMode':
        if (msg.mode && ['manual', 'ask', 'auto'].includes(msg.mode as string)) {
          virtualList.setEditMode(msg.mode as EditMode);
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

      // ---- Session Messages ----
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

      // ---- Settings Messages ----
      case 'modelChanged':
        session.handleModelChanged({ model: msg.model as string });
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

      // ---- File Messages ----
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

      case 'codeApplied':
        this.handleCodeApplied(msg);
        break;

      // ---- Trace Messages ----
      case 'traceCalibration':
        // Receive calibration data from extension for timeline alignment
        webviewTracer.handleCalibration(
          msg.extensionStartTime as string,
          msg.correlationId as string | undefined
        );
        break;

      case 'requestTraceSync':
        // Extension requests immediate trace sync (e.g., on visibility change)
        webviewTracer.forceSync();
        break;

      case 'traceSyncAck':
        // Extension acknowledges receipt of trace events
        webviewTracer.handleSyncAck(msg.count as number);
        break;

      default:
        log.debug('Unhandled message type:', msg.type);
    }
  }

  // ============================================
  // Streaming Message Handlers
  // ============================================

  private handleStartResponse(msg: { type: string; [key: string]: unknown }): void {
    const { streaming, session, virtualList } = this._actors;

    log.debug('startResponse: beginning new stream');

    // Set the correlation ID for cross-boundary tracing (if provided)
    if (msg.correlationId) {
      webviewTracer.setExtensionCorrelationId(msg.correlationId as string);
    }

    // Reset coordination state
    this._segmentContent = '';
    this._hasInterleaved = false;
    this._phase = 'streaming';

    // Create a new turn for the assistant response
    const turnId = `turn-${++this._messageCounter}`;
    this._currentTurnId = turnId;

    // Add turn to virtual list
    virtualList.addTurn(turnId, 'assistant', {
      model: session.model,
      timestamp: Date.now()
    });

    // Start streaming on the turn
    virtualList.startStreamingTurn(turnId);

    // Start stream in StreamingActor
    streaming.startStream(
      (msg.messageId as string) || `msg-${Date.now()}`,
      session.model
    );

    this.publishCoordinationState();
  }

  private handleStreamToken(msg: { type: string; [key: string]: unknown }): void {
    const { streaming, session, virtualList } = this._actors;
    const token = msg.token as string;

    if (!this._currentTurnId) return;

    const turn = virtualList.getTurn(this._currentTurnId);
    if (!turn) return;

    // Check if we need to create a new segment after interleaving
    const boundActor = virtualList.getBoundActor(this._currentTurnId);
    if (boundActor?.needsNewSegment()) {
      log.debug('streamToken: resuming with new segment after interleave');
      virtualList.resumeWithNewSegment(this._currentTurnId);
      this._segmentContent = '';
      this._hasInterleaved = false;
    }

    // Accumulate content
    this._segmentContent += token;

    // Strip shell tags in reasoner mode
    const isReasonerMode = session.model === 'deepseek-reasoner';
    const displayContent = isReasonerMode
      ? this._segmentContent.replace(/<shell>[\s\S]*?<\/shell>/gi, '').trim()
      : this._segmentContent;

    // Create text segment if needed, then update
    if (turn.textSegments.length === 0) {
      virtualList.addTextSegment(this._currentTurnId, displayContent);
    } else {
      virtualList.updateTextContent(this._currentTurnId, displayContent);
    }

    streaming.handleContentChunk(token);
    this.publishCoordinationState();
  }

  private handleStreamReasoning(msg: { type: string; [key: string]: unknown }): void {
    const { streaming, virtualList } = this._actors;

    if (!this._currentTurnId) return;

    // Finalize text segment before thinking
    if (!this._hasInterleaved) {
      const finalized = virtualList.finalizeCurrentSegment(this._currentTurnId);
      if (finalized) {
        this._hasInterleaved = true;
      }
    }

    // Update thinking content in current iteration
    const turn = virtualList.getTurn(this._currentTurnId);
    if (turn && turn.thinkingIterations.length > 0) {
      const lastIteration = turn.thinkingIterations[turn.thinkingIterations.length - 1];
      if (!lastIteration.complete) {
        const currentContent = lastIteration.content || '';
        virtualList.updateThinkingContent(this._currentTurnId, currentContent + (msg.token as string));
      }
    }

    streaming.handleThinkingChunk(msg.token as string);
    this.publishCoordinationState();
  }

  private handleIterationStart(msg: { type: string; [key: string]: unknown }): void {
    const { virtualList } = this._actors;

    if (!this._currentTurnId) return;

    log.debug(`iterationStart: iteration=${msg.iteration}`);

    // Finalize text segment before thinking
    if (!this._hasInterleaved) {
      const finalized = virtualList.finalizeCurrentSegment(this._currentTurnId);
      if (finalized) {
        this._hasInterleaved = true;
      }
    }

    virtualList.startThinkingIteration(this._currentTurnId);
    this.publishCoordinationState();
  }

  private handleEndResponse(msg: { type: string; [key: string]: unknown }): void {
    const { streaming, virtualList } = this._actors;

    log.debug(`endResponse: ending stream`);

    // End streaming
    streaming.endStream();

    if (this._currentTurnId) {
      virtualList.endStreamingTurn();
    }

    // Save last streaming turn ID for late-arriving messages (diffListChanged, codeApplied)
    this._lastStreamingTurnId = this._currentTurnId;

    // Reset coordination state
    this._segmentContent = '';
    this._hasInterleaved = false;
    this._phase = 'idle';
    this._currentTurnId = null;

    // Clear the correlation ID now that the flow is complete
    webviewTracer.setExtensionCorrelationId(null);

    // Force sync traces to extension at end of response
    webviewTracer.forceSync();

    this.publishCoordinationState();
  }

  // ============================================
  // Shell Message Handlers
  // ============================================

  private handleShellExecuting(msg: { type: string; [key: string]: unknown }): void {
    const { virtualList } = this._actors;
    const commands = msg.commands as Array<{ command: string; description?: string }>;

    log.debug(`shellExecuting: raw commands:`, commands);

    if (!this._currentTurnId) {
      log.warn(`shellExecuting: NO CURRENT TURN ID - dropping message!`);
      return;
    }
    if (!commands || !Array.isArray(commands)) {
      log.warn(`shellExecuting: invalid commands array:`, commands);
      return;
    }

    log.debug(`shellExecuting: ${commands.length} commands for turn ${this._currentTurnId}`);

    // Finalize text segment before shell
    if (!this._hasInterleaved) {
      const finalized = virtualList.finalizeCurrentSegment(this._currentTurnId);
      if (finalized) {
        this._hasInterleaved = true;
      }
    }

    // Create shell segment
    this._shellSegmentId = virtualList.createShellSegment(
      this._currentTurnId,
      commands.map(c => ({ command: c.command }))
    );

    if (this._shellSegmentId) {
      this._phase = 'waiting-for-results';
      virtualList.startShellSegment(this._currentTurnId, this._shellSegmentId);
    }

    this.publishCoordinationState();
  }

  private handleShellResults(msg: { type: string; [key: string]: unknown }): void {
    const { virtualList } = this._actors;
    const results = msg.results as Array<{ output?: string; success?: boolean; exitCode?: number }>;

    if (!this._currentTurnId || !results || !Array.isArray(results) || !this._shellSegmentId) return;

    virtualList.setShellResults(
      this._currentTurnId,
      this._shellSegmentId,
      results.map(result => ({
        success: result.success !== undefined ? result.success : (result.exitCode === 0),
        output: result.output || ''
      }))
    );

    this._shellSegmentId = null;
    this._phase = 'streaming';
    this.publishCoordinationState();
  }

  // ============================================
  // Tool Calls Message Handlers
  // ============================================

  private handleToolCallsStart(msg: { type: string; [key: string]: unknown }): void {
    const { virtualList } = this._actors;
    const tools = msg.tools as Array<{ name: string; detail: string }>;

    if (!this._currentTurnId || !tools || !Array.isArray(tools)) return;

    log.debug(`toolCallsStart: ${tools.length} tools`);

    // Finalize text segment before tools
    if (!this._hasInterleaved) {
      const finalized = virtualList.finalizeCurrentSegment(this._currentTurnId);
      if (finalized) {
        this._hasInterleaved = true;
      }
    }

    virtualList.startToolBatch(this._currentTurnId, tools);
    this.publishCoordinationState();
  }

  private handleToolCallUpdate(msg: { type: string; [key: string]: unknown }): void {
    const { virtualList } = this._actors;

    if (!this._currentTurnId || msg.index === undefined || !msg.status) return;

    virtualList.updateTool(
      this._currentTurnId,
      msg.index as number,
      msg.status as 'pending' | 'running' | 'done' | 'error'
    );
  }

  private handleToolCallsUpdate(msg: { type: string; [key: string]: unknown }): void {
    const { virtualList } = this._actors;
    const tools = msg.tools as Array<{ name: string; detail: string; status?: string }>;

    if (!this._currentTurnId || !tools || !Array.isArray(tools)) return;

    // Update the entire tool batch (adds new tools and updates status)
    virtualList.updateToolBatch(this._currentTurnId, tools);
  }

  // ============================================
  // Pending Files Message Handlers
  // ============================================

  private handlePendingFileAdd(msg: { type: string; [key: string]: unknown }): void {
    const { virtualList } = this._actors;

    if (!this._currentTurnId || !msg.filePath) return;

    // Finalize text segment before pending files
    if (!this._hasInterleaved) {
      const finalized = virtualList.finalizeCurrentSegment(this._currentTurnId);
      if (finalized) {
        this._hasInterleaved = true;
      }
    }

    virtualList.addPendingFile(this._currentTurnId, {
      filePath: msg.filePath as string,
      diffId: msg.diffId as string | undefined
    });

    this.publishCoordinationState();
  }

  private handleDiffListChanged(msg: { type: string; [key: string]: unknown }): void {
    const { virtualList } = this._actors;
    const diffs = msg.diffs as Array<{ filePath: string; status: string; diffId?: string; iteration?: number; superseded?: boolean }>;

    // Use current turn or fall back to last streaming turn (for late-arriving messages after endResponse)
    const turnId = this._currentTurnId || this._lastStreamingTurnId;
    if (!turnId || !diffs || !Array.isArray(diffs)) return;

    log.debug(`diffListChanged: ${diffs.length} diffs for turn ${turnId}`);

    // Only finalize text segment if still streaming (don't do it for late-arriving messages)
    if (this._currentTurnId && !this._hasInterleaved && diffs.length > 0) {
      const finalized = virtualList.finalizeCurrentSegment(turnId);
      if (finalized) {
        this._hasInterleaved = true;
      }
    }

    // Get current pending files for this turn
    const turn = virtualList.getTurn(turnId);
    if (!turn) return;

    const currentDiffIds = new Map(turn.pendingFiles.map(f => [f.diffId, f]));
    const currentPaths = new Map(turn.pendingFiles.map(f => [f.filePath, f]));

    for (const diff of diffs) {
      const status = diff.status as 'pending' | 'applied' | 'rejected' | 'superseded' | 'error';

      // First: check if this diff exists in ANY turn (global search by diffId).
      // This prevents resolved diffs from previous turns being re-added to the current turn.
      if (diff.diffId) {
        const globalMatch = virtualList.findPendingFileGlobal(diff.diffId);
        if (globalMatch) {
          if (globalMatch.file.status !== status) {
            virtualList.updatePendingStatus(globalMatch.turnId, globalMatch.file.id, status);
          }
          continue;
        }
      }

      // Second: check current turn by filePath (same file re-edited with new diffId)
      const existingByPath = currentPaths.get(diff.filePath);
      if (existingByPath) {
        if (diff.diffId && existingByPath.diffId !== diff.diffId) {
          existingByPath.diffId = diff.diffId;
        }
        if (existingByPath.status !== status) {
          virtualList.updatePendingStatus(turnId, existingByPath.id, status);
        }
        continue;
      }

      // Truly new diff — add to current turn
      virtualList.addPendingFile(turnId, {
        filePath: diff.filePath,
        diffId: diff.diffId,
        status
      });
    }

    // Update edit mode if provided
    if (msg.editMode && ['manual', 'ask', 'auto'].includes(msg.editMode as string)) {
      virtualList.setEditMode(msg.editMode as EditMode);
    }

    this.publishCoordinationState();
  }

  /**
   * Handle codeApplied message - update file status to 'error' if apply failed.
   */
  private handleCodeApplied(msg: { type: string; [key: string]: unknown }): void {
    const { virtualList } = this._actors;
    const success = msg.success as boolean;
    const filePath = msg.filePath as string | undefined;

    // Only handle failures - success is already handled by diffListChanged
    if (!success && filePath) {
      log.debug(`codeApplied failed for: ${filePath}`);
      virtualList.updatePendingFileStatusByPath(filePath, 'error');
    }
  }

  // ============================================
  // History Message Handlers
  // ============================================

  private handleAddMessage(msg: { type: string; [key: string]: unknown }): void {
    const { virtualList } = this._actors;
    const msgData = msg.message as { role: string; content: string; files?: string[]; reasoning?: string };

    if (!msgData) return;

    const turnId = `turn-${++this._messageCounter}`;

    if (msgData.role === 'user') {
      virtualList.addTurn(turnId, 'user', {
        files: msgData.files,
        timestamp: Date.now()
      });
      virtualList.addTextSegment(turnId, msgData.content);
    } else if (msgData.role === 'assistant') {
      virtualList.addTurn(turnId, 'assistant', {
        timestamp: Date.now()
      });
      virtualList.addTextSegment(turnId, msgData.content);

      // Add thinking if present
      if (msgData.reasoning) {
        virtualList.startThinkingIteration(turnId);
        virtualList.updateThinkingContent(turnId, msgData.reasoning);
      }
    }
  }

  /**
   * Restore a previously saved conversation from RichHistoryTurn[] data.
   *
   * Clears the virtual list and re-renders all turns using the VirtualListActor API.
   * The rendering order differs by model to match the live streaming experience:
   *
   * **Reasoner model** (has reasoning_iterations):
   *   thinking[0] → content[0] → shell[0] → thinking[1] → content[1] → shell[1] →
   *   ... → filesModified → remaining content (the "real" response text)
   *
   * **Chat model** (no reasoning):
   *   toolCalls (badges) → filesModified → text content
   *
   * **Live vs restored differences:**
   * - Restored tool badges are static (no progress animation)
   * - Restored file modifications show as 'applied' (no pending/accept/reject actions)
   * - Shell results show completed output (no streaming indicator)
   * - Thinking iterations are immediately complete (no typing animation)
   *
   * If `contentIterations` is not available (older data), falls back to the full
   * accumulated `content` field placed after all thinking/shells.
   */
  private handleLoadHistory(msg: { type: string; [key: string]: unknown }): void {
    const { session, virtualList } = this._actors;
    const history = msg.history as Array<{
      role: string;
      content: string;
      files?: string[];
      reasoning_iterations?: string[];
      contentIterations?: string[];
      toolCalls?: Array<{ name: string; detail: string; status: string }>;
      shellResults?: Array<{ command: string; output: string; success: boolean }>;
      filesModified?: string[];
      model?: string;
      timestamp?: number;
    }>;

    log.debug(`[VirtualGateway] handleLoadHistory: ${history?.length ?? 0} turns`);

    session.handleLoadHistory();
    virtualList.clear();
    this._messageCounter = 0;

    if (history && Array.isArray(history)) {
      try {
        history.forEach(m => {
          const turnId = `turn-${++this._messageCounter}`;

          if (m.role === 'user') {
            virtualList.addTurn(turnId, 'user', {
              files: m.files,
              timestamp: m.timestamp || Date.now()
            });
            virtualList.addTextSegment(turnId, m.content);
          } else if (m.role === 'assistant') {
            virtualList.addTurn(turnId, 'assistant', {
              model: m.model,
              timestamp: m.timestamp || Date.now()
            });

            const reasoning = m.reasoning_iterations || [];
            const contentIts = m.contentIterations || [];
            const shells = m.shellResults || [];
            const tools = m.toolCalls || [];

            log.debug(`[VirtualGateway] restore turn ${turnId}: reasoning=${reasoning.length}, contentIts=${contentIts.length}, shells=${shells.length}, tools=${tools.length}, files=${m.filesModified?.length || 0}`);

            if (reasoning.length > 0) {
              // ── Reasoner model restore ──
              // Interleave: thinking[i] → content[i] → shell[i] → files → ... → final text
              let contentUsedInline = 0;

              for (let i = 0; i < reasoning.length; i++) {
                virtualList.startThinkingIteration(turnId);
                virtualList.updateThinkingContent(turnId, reasoning[i]);
                virtualList.completeThinkingIteration(turnId);

                // Content text from this iteration (appears between thinking and shell)
                if (i < contentIts.length && contentIts[i] && i < shells.length) {
                  virtualList.addTextSegment(turnId, contentIts[i]);
                  contentUsedInline++;
                }

                // Shell command from this iteration
                if (i < shells.length) {
                  const sr = shells[i];
                  const segmentId = virtualList.createShellSegment(turnId, [{ command: sr.command }]);
                  if (segmentId) {
                    virtualList.setShellResults(turnId, segmentId, [{ output: sr.output, success: sr.success }]);
                  }
                }
              }

              // File modifications (appear after shells, before final text)
              if (m.filesModified && m.filesModified.length > 0) {
                for (const filePath of m.filesModified) {
                  virtualList.addPendingFile(turnId, { filePath, status: 'applied' });
                }
              }

              // Remaining content iterations (after the last shell) — the "real" response text
              if (contentIts.length > contentUsedInline) {
                for (let i = contentUsedInline; i < contentIts.length; i++) {
                  if (contentIts[i]) {
                    virtualList.addTextSegment(turnId, contentIts[i]);
                  }
                }
              } else if (contentIts.length === 0 && m.content) {
                virtualList.addTextSegment(turnId, m.content);
              }
            } else {
              // ── Chat model restore ──
              // Order matches live streaming: tools → files → text content
              if (tools.length > 0) {
                virtualList.startToolBatch(turnId, tools.map(tc => ({
                  name: tc.name,
                  detail: tc.detail
                })));
                tools.forEach((tc, i) => {
                  virtualList.updateTool(turnId, i, tc.status as 'done' | 'error');
                });
                virtualList.completeToolBatch(turnId);
              }

              if (m.filesModified && m.filesModified.length > 0) {
                for (const filePath of m.filesModified) {
                  virtualList.addPendingFile(turnId, { filePath, status: 'applied' });
                }
              }

              if (m.content) {
                virtualList.addTextSegment(turnId, m.content);
              }
            }
          }
        });
      } catch (error) {
        log.warn(`[VirtualGateway] handleLoadHistory ERROR: ${error}`);
      }
    }
  }

  private handleClearChat(): void {
    const { virtualList } = this._actors;

    virtualList.clear();
    this._messageCounter = 0;

    // Reset coordination state
    this._shellSegmentId = null;
    this._segmentContent = '';
    this._hasInterleaved = false;
    this._phase = 'idle';
    this._currentTurnId = null;

    this.publishCoordinationState();
  }

  // ============================================
  // Settings Message Handlers
  // ============================================

  private handleEditModeSettings(msg: { type: string; [key: string]: unknown }): void {
    const { editMode, toolbar, virtualList } = this._actors;

    if (msg.mode && editMode.isValidMode(msg.mode)) {
      const mode = msg.mode as EditMode;
      editMode.setMode(mode);
      toolbar.setEditMode(mode);
      virtualList.setEditMode(mode);
    }
  }

  private handleSettings(msg: { type: string; [key: string]: unknown }): void {
    if (msg.model || msg.temperature !== undefined || msg.maxToolCalls !== undefined || msg.maxTokens !== undefined) {
      this._manager.publishDirect('model.settings', {
        model: msg.model,
        temperature: msg.temperature,
        toolLimit: msg.maxToolCalls,
        maxTokens: msg.maxTokens
      });
    }

    // Apply webview log level to global log level
    if (msg.webviewLogLevel !== undefined) {
      const levelMap: Record<string, number> = {
        'DEBUG': LogLevel.DEBUG,
        'INFO': LogLevel.INFO,
        'WARN': LogLevel.WARN,
        'ERROR': LogLevel.ERROR
      };
      const level = levelMap[msg.webviewLogLevel as string] ?? LogLevel.WARN;
      setLogLevel(level);
      log.debug('Webview log level set to:', msg.webviewLogLevel);
    }

    // Apply tracing enabled/disabled
    if (msg.tracingEnabled !== undefined) {
      webviewTracer.enabled = msg.tracingEnabled as boolean;
      log.debug('Tracing enabled:', msg.tracingEnabled);
    }

    const webSearch = msg.webSearch as { searchDepth?: string; creditsPerPrompt?: number; maxResultsPerSearch?: number; cacheDuration?: number } | undefined;
    this._manager.publishDirect('settings.values', {
      logLevel: msg.logLevel,
      webviewLogLevel: msg.webviewLogLevel,
      tracingEnabled: msg.tracingEnabled,
      logColors: msg.logColors,
      allowAllCommands: msg.allowAllCommands,
      systemPrompt: msg.systemPrompt,
      searchDepth: webSearch?.searchDepth,
      creditsPerPrompt: webSearch?.creditsPerPrompt,
      maxResultsPerSearch: webSearch?.maxResultsPerSearch,
      cacheDuration: webSearch?.cacheDuration,
      autoSaveHistory: msg.autoSaveHistory,
      maxSessions: msg.maxSessions
    });
  }

  private handleGenerationStopped(): void {
    const { streaming, virtualList } = this._actors;

    streaming.endStream();

    if (this._currentTurnId) {
      virtualList.endStreamingTurn();
    }

    this._segmentContent = '';
    this._hasInterleaved = false;
    this._phase = 'idle';
    this._currentTurnId = null;

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
      'gateway.currentTurn': this._currentTurnId,
    });
  }

  // ============================================
  // Public API
  // ============================================

  get segmentContent(): string {
    return this._segmentContent;
  }

  get hasInterleaved(): boolean {
    return this._hasInterleaved;
  }

  get phase(): GatewayPhase {
    return this._phase;
  }

  get shellSegmentId(): string | null {
    return this._shellSegmentId;
  }

  get currentTurnId(): string | null {
    return this._currentTurnId;
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
