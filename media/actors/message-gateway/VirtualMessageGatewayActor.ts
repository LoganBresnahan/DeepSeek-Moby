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
import { TurnEventLog, TurnEvent } from '../../events/TurnEventLog';
import { TurnProjector, ViewSegment, ViewMutation } from '../../events/TurnProjector';

// Import actor types for type safety
import type { StreamingActor } from '../streaming';
import type { SessionActor } from '../session';
import type { EditModeActor } from '../edit-mode';
import type { InputAreaShadowActor } from '../input-area/InputAreaShadowActor';
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

  // ============================================
  // CQRS Event Infrastructure
  // ============================================

  /** Per-turn event logs (turnId → TurnEventLog) */
  private _turnLogs = new Map<string, TurnEventLog>();

  /** Shared projector instance */
  private _projector = new TurnProjector();

  /** Current iteration counter (incremented by iterationStart) */
  private _currentIteration = 0;

  /** Counter for generating unique shell/approval IDs */
  private _eventIdCounter = 0;

  /** Last shell ID for causal linking of file-modified events */
  private _lastShellId: string | null = null;

  /** Current view model segments for the active streaming turn */
  private _currentViewSegments: ViewSegment[] = [];

  /** Maps CQRS shell IDs to VirtualListActor segment IDs (for shell result updates) */
  private _shellSegmentMap = new Map<string, string>();

  /** Maps CQRS approval IDs to VirtualListActor approval IDs */
  private _approvalSegmentMap = new Map<string, string>();

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
  // CQRS Helpers
  // ============================================

  /** Get or create the event log for a turn. */
  private getTurnLog(turnId: string): TurnEventLog {
    let tl = this._turnLogs.get(turnId);
    if (!tl) {
      tl = new TurnEventLog(turnId);
      this._turnLogs.set(turnId, tl);
    }
    return tl;
  }

  /** Summarize a ViewSegment for logging. */
  private summarizeSegment(s: ViewSegment): string {
    switch (s.type) {
      case 'text': return `text(len=${s.content.length}, cont=${s.continuation}, complete=${s.complete})`;
      case 'thinking': return `thinking(iter=${s.iteration}, complete=${s.complete})`;
      case 'shell': return `shell(id=${s.id}, cmds=${s.commands.length}, complete=${s.complete})`;
      case 'approval': return `approval(id=${s.id}, status=${s.status})`;
      case 'file-modified': return `file(path=${s.path}, status=${s.status})`;
      case 'tool-batch': return `tools(${s.tools.length}, complete=${s.complete})`;
      case 'code-block': return `code(lang=${s.language})`;
      case 'drawing': return `drawing`;
      default: return (s as any).type;
    }
  }

  /** Generate a unique ID for shell/approval events. */
  private generateEventId(prefix: string): string {
    return `${prefix}-${++this._eventIdCounter}`;
  }

  /**
   * Emit text-finalize only if the event log has an open text segment
   * (a text-append not followed by a text-finalize). Prevents spurious
   * and duplicate finalize events.
   */
  private emitTextFinalizeIfOpen(turnId: string): void {
    const tl = this._turnLogs.get(turnId);
    if (!tl) return;

    // Walk backwards to find the last text-related event
    const events = tl.getAll();
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === 'text-finalize') {
        // Already finalized — skip
        return;
      }
      if (e.type === 'text-append') {
        // Found open text — finalize it
        tl.append({ type: 'text-finalize', iteration: this._currentIteration, ts: Date.now() });
        return;
      }
      // Skip non-text events (thinking-content, shell events, etc.) and keep looking
    }
    // No text-append found at all — nothing to finalize
  }

  /**
   * Emit thinking-complete only if the event log has an open thinking block
   * (a thinking-start not followed by a thinking-complete for the same iteration).
   * Prevents spurious and duplicate complete events.
   */
  private emitThinkingCompleteIfOpen(turnId: string): void {
    const tl = this._turnLogs.get(turnId);
    if (!tl) return;

    const events = tl.getAll();
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === 'thinking-complete') {
        // Already completed — skip
        return;
      }
      if (e.type === 'thinking-start') {
        // Found open thinking — complete it via emitTurnEvent so the projector
        // produces a mutation that stops the pulse animation on the actor
        this.emitTurnEvent(turnId, { type: 'thinking-complete', iteration: e.iteration, ts: Date.now() });
        return;
      }
    }
  }

  /**
   * Emit a turn event: append to the log and apply incremental projection.
   * For normal streaming events (text, thinking, shell, approval, tools, etc.)
   */
  private emitTurnEvent(turnId: string, event: TurnEvent): void {
    const tl = this.getTurnLog(turnId);
    const index = tl.append(event);
    const mutations = this._projector.projectIncremental(this._currentViewSegments, event, index);
    this.applyMutations(turnId, mutations);
  }

  /**
   * Apply incremental view mutations to VirtualListActor.
   */
  private applyMutations(turnId: string, mutations: ViewMutation[]): void {
    const { virtualList } = this._actors;

    for (const mutation of mutations) {
      switch (mutation.op) {
        case 'append':
          this.renderSegment(turnId, mutation.segment);
          break;
        case 'update':
          this.updateRenderedSegment(turnId, mutation.segmentIndex, mutation.segment);
          break;
        case 'insert':
          // Insert is rare (only for causal) — handled by reconcileFull instead
          break;
      }
    }
  }

  /**
   * Render a single ViewSegment into VirtualListActor.
   * Maps ViewSegment types to VirtualListActor method calls.
   */
  private renderSegment(turnId: string, segment: ViewSegment): void {
    const { virtualList } = this._actors;

    log.debug(`[${turnId}] RENDER: ${this.summarizeSegment(segment)}`);

    switch (segment.type) {
      case 'text': {
        const isReasonerMode = this._actors.session.model === 'deepseek-reasoner';
        const displayContent = isReasonerMode
          ? segment.content.replace(/<shell>[\s\S]*?<\/shell>/gi, '').trim()
          : segment.content;
        virtualList.addTextSegment(turnId, displayContent);
        break;
      }

      case 'thinking': {
        virtualList.startThinkingIteration(turnId);
        if (segment.content) {
          virtualList.updateThinkingContent(turnId, segment.content);
        }
        if (segment.complete) {
          virtualList.completeThinkingIteration(turnId);
        }
        break;
      }

      case 'shell': {
        const segmentId = virtualList.createShellSegment(turnId, segment.commands);
        if (segmentId) {
          this._shellSegmentMap.set(segment.id, segmentId);
          if (segment.results) {
            virtualList.setShellResults(turnId, segmentId, segment.results.map(r => ({
              output: r.output,
              success: r.success
            })));
          }
        }
        break;
      }

      case 'approval': {
        const approvalId = virtualList.createCommandApproval(
          turnId, segment.command, segment.prefix, segment.command
        );
        if (approvalId) {
          this._approvalSegmentMap.set(segment.id, approvalId);
        }
        if (approvalId && segment.status !== 'pending') {
          virtualList.resolveCommandApproval(
            turnId, approvalId, segment.status as 'allowed' | 'blocked'
          );
        }
        break;
      }

      case 'file-modified': {
        const turn = virtualList.getTurn(turnId);
        const isRestore = turn && !turn.isStreaming;

        // Manual mode: no dropdown during live streaming, no dropdown on restore.
        // Just mark the code block as applied if it was.
        if (segment.editMode === 'manual' && isRestore) {
          if (segment.status === 'applied') {
            virtualList.markCodeBlockApplied(segment.path, turnId);
          }
          break;
        }

        // During history restore, pending files can't be
        // accepted/rejected anymore — mark them as expired
        let fileStatus = segment.status as 'pending' | 'applied' | 'rejected' | 'deleted' | 'expired';
        if (fileStatus === 'pending' && isRestore) {
          fileStatus = 'expired';
        }
        virtualList.addPendingFile(turnId, {
          filePath: segment.path,
          status: fileStatus,
          editMode: segment.editMode as EditMode | undefined,
        });
        // On restore, if the file was applied, mark the matching code block
        if (fileStatus === 'applied' && isRestore) {
          virtualList.markCodeBlockApplied(segment.path, turnId);
        }
        break;
      }

      case 'tool-batch': {
        virtualList.startToolBatch(turnId, segment.tools.map(t => ({
          name: t.name,
          detail: t.detail
        })));
        for (let i = 0; i < segment.tools.length; i++) {
          if (segment.tools[i].status) {
            virtualList.updateTool(turnId, i, segment.tools[i].status as 'done' | 'error');
          }
        }
        if (segment.complete) {
          virtualList.completeToolBatch(turnId);
        }
        break;
      }

      case 'code-block':
        // Code blocks are rendered as text segments with fenced content
        virtualList.addTextSegment(turnId, '```' + segment.language + '\n' + segment.content + '\n```');
        break;

      case 'drawing':
        // Drawing segments — delegate to virtual list if method exists
        break;
    }
  }

  /**
   * Update a rendered segment in place (for incremental updates like text accumulation).
   */
  private updateRenderedSegment(turnId: string, segmentIndex: number, segment: ViewSegment): void {
    const { virtualList, streaming } = this._actors;

    switch (segment.type) {
      case 'text': {
        // For text updates during streaming, use updateTextContent
        const isReasonerMode = this._actors.session.model === 'deepseek-reasoner';
        const displayContent = isReasonerMode
          ? segment.content.replace(/<shell>[\s\S]*?<\/shell>/gi, '').trim()
          : segment.content;
        virtualList.updateTextContent(turnId, displayContent);
        break;
      }

      case 'thinking':
        virtualList.updateThinkingContent(turnId, segment.content);
        if (segment.complete) {
          virtualList.completeThinkingIteration(turnId);
        }
        break;

      case 'shell': {
        const actorSegmentId = this._shellSegmentMap.get(segment.id);
        if (actorSegmentId && segment.results) {
          virtualList.setShellResults(turnId, actorSegmentId, segment.results.map(r => ({
            output: r.output,
            success: r.success
          })));
        }
        break;
      }

      case 'approval': {
        const actorApprovalId = this._approvalSegmentMap.get(segment.id);
        if (actorApprovalId && segment.status !== 'pending') {
          virtualList.resolveCommandApproval(
            turnId, actorApprovalId, segment.status as 'allowed' | 'blocked'
          );
        }
        break;
      }

      case 'tool-batch': {
        // Full batch update (handles both new tools and status changes)
        virtualList.updateToolBatch(turnId, segment.tools.map(t => ({
          name: t.name,
          detail: t.detail,
          status: t.status
        })));
        if (segment.complete) {
          virtualList.completeToolBatch(turnId);
        }
        break;
      }
    }
  }

  /**
   * Convert a RichHistoryTurn (from ConversationManager) into TurnEvent[].
   * This bridges the existing history format with the CQRS event log.
   */
  private convertHistoryToEvents(m: {
    content: string;
    reasoning_iterations?: string[];
    contentIterations?: string[];
    toolCalls?: Array<{ name: string; detail: string; status: string }>;
    shellResults?: Array<{ command: string; output: string; success: boolean }>;
    filesModified?: string[];
    editMode?: string;
  }): TurnEvent[] {
    const events: TurnEvent[] = [];
    const reasoning = m.reasoning_iterations || [];
    const contentIts = m.contentIterations || [];
    const shells = m.shellResults || [];
    const tools = m.toolCalls || [];
    let ts = 0;

    if (reasoning.length > 0) {
      // ── Reasoner model: interleave thinking → content → shells ──
      // Build a shell index by iteration (shells are sequential, map to iterations)
      let shellIdx = 0;

      for (let i = 0; i < reasoning.length; i++) {
        // Thinking
        events.push({ type: 'thinking-start', iteration: i, ts: ++ts });
        events.push({ type: 'thinking-content', content: reasoning[i], iteration: i, ts: ++ts });
        events.push({ type: 'thinking-complete', iteration: i, ts: ++ts });

        // Content for this iteration (if exists and there are shells for it)
        const contentForIteration = i < contentIts.length ? contentIts[i] : null;
        if (contentForIteration) {
          events.push({ type: 'text-append', content: contentForIteration, iteration: i, ts: ++ts });
          events.push({ type: 'text-finalize', iteration: i, ts: ++ts });
        }

        // Shell commands — assign remaining shells to this iteration
        // Heuristic: distribute one shell per iteration, remaining go to last
        if (shellIdx < shells.length && i < reasoning.length - 1) {
          // One shell per reasoning iteration (except the last which gets remaining content)
          const sr = shells[shellIdx];
          const shellId = `sh-restore-${shellIdx}`;
          events.push({ type: 'shell-start', id: shellId, commands: [{ command: sr.command }], iteration: i, ts: ++ts });
          events.push({ type: 'shell-complete', id: shellId, results: [{ output: sr.output, success: sr.success }], ts: ++ts });
          shellIdx++;
        }
      }

      // Remaining shells (if more shells than reasoning iterations)
      while (shellIdx < shells.length) {
        const sr = shells[shellIdx];
        const shellId = `sh-restore-${shellIdx}`;
        const lastIter = reasoning.length - 1;
        events.push({ type: 'shell-start', id: shellId, commands: [{ command: sr.command }], iteration: lastIter, ts: ++ts });
        events.push({ type: 'shell-complete', id: shellId, results: [{ output: sr.output, success: sr.success }], ts: ++ts });
        shellIdx++;
      }

      // File modifications
      if (m.filesModified && m.filesModified.length > 0) {
        for (const filePath of m.filesModified) {
          events.push({ type: 'file-modified', path: filePath, status: 'applied', editMode: m.editMode, ts: ++ts });
        }
      }

      // Remaining content that wasn't paired with iterations (fallback: full content)
      if (contentIts.length === 0 && m.content) {
        events.push({ type: 'text-append', content: m.content, iteration: 0, ts: ++ts });
      }
    } else {
      // ── Chat model: tools → files → content ──
      if (tools.length > 0) {
        events.push({ type: 'tool-batch-start', tools: tools.map(t => ({ name: t.name, detail: t.detail })), ts: ++ts });
        for (let i = 0; i < tools.length; i++) {
          events.push({ type: 'tool-update', index: i, status: tools[i].status, ts: ++ts });
        }
        events.push({ type: 'tool-batch-complete', ts: ++ts });
      }

      if (m.filesModified && m.filesModified.length > 0) {
        for (const filePath of m.filesModified) {
          events.push({ type: 'file-modified', path: filePath, status: 'applied', editMode: m.editMode, ts: ++ts });
        }
      }

      if (m.content) {
        events.push({ type: 'text-append', content: m.content, iteration: 0, ts: ++ts });
      }
    }

    return events;
  }

  // ============================================
  // Message Router
  // ============================================

  private handleMessage(msg: { type: string; [key: string]: unknown }): void {
    const { streaming, session, virtualList, toolbar } = this._actors;

    // Log and trace key lifecycle messages (not per-chunk streaming messages)
    const lifecycleTypes = [
      'startResponse', 'endResponse',
      'toolCallsStart', 'toolCallsEnd',
      'iterationStart'
    ];
    if (lifecycleTypes.includes(msg.type)) {
      log.debug('Received:', msg.type);
      webviewTracer.trace('bridge.receive', msg.type, { level: 'debug' });
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
          this.emitTurnEvent(this._currentTurnId, { type: 'tool-batch-complete', ts: Date.now() });
        }
        break;

      // ---- Command Approval Messages ----
      case 'commandApprovalRequired':
        this.handleCommandApprovalRequired(msg);
        break;

      case 'commandApprovalResolved':
        this.handleCommandApprovalResolved(msg);
        break;

      // ---- Pending Files Messages ----
      case 'pendingFileUpdate':
        if (msg.fileId && msg.status && this._currentTurnId) {
          virtualList.updatePendingStatus(
            this._currentTurnId,
            msg.fileId as string,
            msg.status as 'pending' | 'applied' | 'rejected' | 'superseded' | 'deleted' | 'expired'
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

      case 'savedPrompts':
        this._manager.publishDirect('savedPrompts.list', msg.prompts || []);
        break;

      case 'settingsReset':
        this._vscode.postMessage({ type: 'getSettings' });
        break;

      case 'webSearchToggled':
        toolbar.setWebSearchEnabled(msg.enabled as boolean);
        break;

      case 'webSearchModeChanged':
        toolbar.setWebSearchMode(msg.mode as 'off' | 'manual' | 'auto');
        break;

      case 'webSearchSettings': {
        // Response to getWebSearchSettings request — publish to popup's subscription keys
        const wsMode = msg.mode as string | undefined;
        const wsSettings = msg.settings as Record<string, unknown> | undefined;
        const wsEnabled = msg.enabled as boolean | undefined;
        if (wsMode) {
          toolbar.setWebSearchMode(wsMode as 'off' | 'manual' | 'auto');
          this._manager.publishDirect('webSearch.mode', wsMode);
        }
        if (wsSettings) {
          this._manager.publishDirect('webSearch.settings', wsSettings);
        }
        if (wsEnabled !== undefined) {
          toolbar.setWebSearchEnabled(wsEnabled);
          this._manager.publishDirect('webSearch.enabled', wsEnabled);
        }
        if (msg.configured !== undefined) {
          toolbar.setWebSearchConfigured(msg.configured as boolean);
        }
        break;
      }

      case 'webSearching':
        this._manager.publishDirect('status.message', { type: 'info', message: `Searching the web (${msg.current}/${msg.total})...` });
        break;

      case 'webSearchComplete':
        this._manager.publishDirect('status.message', { type: 'info', message: 'Web search complete' });
        break;

      case 'webSearchCached':
        this._manager.publishDirect('status.message', { type: 'info', message: 'Using cached search results' });
        break;

      // ---- File Messages ----
      case 'openFiles':
        this._manager.publishDirect('files.openFiles', msg.files || []);
        break;

      case 'searchResults':
        // Include timestamp to bypass EventStateManager dedup (same query can produce same results)
        this._manager.publishDirect('files.searchResults', { results: msg.results || [], _ts: Date.now() });
        break;

      case 'fileContent':
        // Include timestamp to bypass dedup (same file can be re-requested after deselection)
        this._manager.publishDirect('files.content', { path: msg.filePath, content: msg.content, _ts: Date.now() });
        break;

      // ---- Status Messages ----
      case 'error':
        this._manager.publishDirect('status.message', { type: 'error', message: (msg.error || msg.message || 'An error occurred') as string });
        break;

      case 'warning':
        this._manager.publishDirect('status.message', { type: 'warning', message: msg.message as string });
        break;

      case 'statusMessage':
        this._manager.publishDirect('status.message', { type: 'info', message: msg.message as string });
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

      // ---- Command Rules Modal Messages ----
      case 'commandRulesList':
        this._manager.publishDirect('rules.list', msg.rules);
        if (msg.allowAll !== undefined) {
          this._manager.publishDirect('rules.allowAll', msg.allowAll);
        }
        break;

      case 'openRulesModal':
        this._manager.publishDirect('rules.modal.open', true);
        break;

      case 'codeApplied':
        this.handleCodeApplied(msg);
        break;

      case 'diffClosed':
        // Diff tab was manually closed — reset code block diff/apply button state
        virtualList.resetDiffState();
        break;

      // ---- Drawing Server Messages ----
      case 'drawingServerState':
        this._manager.publishDirect('drawingServer.state', {
          running: msg.running,
          url: msg.url,
          qrMatrix: msg.qrMatrix,
          isWSL: msg.isWSL,
          portForwardCmd: msg.portForwardCmd,
        });
        break;

      case 'drawingReceived':
        this.handleDrawingReceived(msg);
        break;

      case 'asciiDrawingReceived':
        this.handleAsciiDrawingReceived(msg);
        break;

      // ---- Plan Messages ----
      case 'planState':
        this._manager.publishDirect('plans.state', msg.plans || []);
        break;

      // ---- Fork Messages ----
      case 'turnSequenceUpdate':
        this.handleTurnSequenceUpdate(msg);
        break;

      case 'sessionForked':
        this._manager.publishDirect('status.message', { type: 'info', message: `Forked from "${msg.parentTitle}"` });
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

    if (msg.correlationId) {
      webviewTracer.setExtensionCorrelationId(msg.correlationId as string);
    }

    this._phase = 'streaming';

    // Reset CQRS state for new turn
    this._currentIteration = 0;
    this._thinkingStartedForIteration = -1;
    this._lastShellId = null;
    this._currentViewSegments = [];
    this._eventIdCounter = 0;
    this._shellSegmentMap.clear();
    this._approvalSegmentMap.clear();

    const turnId = `turn-${++this._messageCounter}`;
    this._currentTurnId = turnId;

    // Create fresh event log for this turn
    this._turnLogs.delete(turnId);
    this.getTurnLog(turnId);

    virtualList.addTurn(turnId, 'assistant', {
      model: session.model,
      timestamp: Date.now()
    });
    virtualList.startStreamingTurn(turnId);

    streaming.startStream(
      (msg.messageId as string) || `msg-${Date.now()}`,
      session.model
    );

    this.publishCoordinationState();
  }

  private handleStreamToken(msg: { type: string; [key: string]: unknown }): void {
    const { streaming } = this._actors;
    const token = msg.token as string;

    if (!this._currentTurnId) return;

    // CQRS: Record event → projector produces mutations → render
    this.emitTurnEvent(this._currentTurnId, {
      type: 'text-append', content: token, iteration: this._currentIteration, ts: Date.now()
    });

    streaming.handleContentChunk(token);
  }

  private handleStreamReasoning(msg: { type: string; [key: string]: unknown }): void {
    const { streaming } = this._actors;

    if (!this._currentTurnId) return;

    // Defer thinking-start until first reasoning token arrives (avoids empty thinking bubble on failed requests)
    if (this._thinkingStartedForIteration !== this._currentIteration) {
      this._thinkingStartedForIteration = this._currentIteration;
      this.emitTurnEvent(this._currentTurnId, {
        type: 'thinking-start', iteration: this._currentIteration, ts: Date.now()
      });
    }

    // CQRS: Record event → projector produces mutations → render
    this.emitTurnEvent(this._currentTurnId, {
      type: 'thinking-content', content: msg.token as string, iteration: this._currentIteration, ts: Date.now()
    });

    streaming.handleThinkingChunk(msg.token as string);
  }

  private _thinkingStartedForIteration = -1;

  private handleIterationStart(msg: { type: string; [key: string]: unknown }): void {
    if (!this._currentTurnId) return;

    log.debug(`iterationStart: iteration=${msg.iteration}`);

    // Finalize previous thinking and text (only if open)
    this.emitThinkingCompleteIfOpen(this._currentTurnId);
    this.emitTextFinalizeIfOpen(this._currentTurnId);

    // Track iteration but defer thinking-start until first reasoning token arrives
    this._currentIteration = (msg.iteration as number) - 1; // Convert 1-based to 0-based
  }

  private handleEndResponse(msg: { type: string; [key: string]: unknown }): void {
    const { streaming, virtualList } = this._actors;

    log.debug(`endResponse: ending stream`);

    // CQRS: Finalize event log
    if (this._currentTurnId) {
      const tl = this.getTurnLog(this._currentTurnId);
      this.emitThinkingCompleteIfOpen(this._currentTurnId);
      this.emitTextFinalizeIfOpen(this._currentTurnId);

      log.debug(`endResponse: event log for ${this._currentTurnId} has ${tl.length} events`);

      // Send consolidated events to extension for DB persistence
      const consolidated = tl.consolidateForSave();
      log.debug(`endResponse: consolidated ${tl.length} → ${consolidated.length} events for save`);
      this._vscode.postMessage({ type: 'turnEventsForSave', events: consolidated });
    }

    streaming.endStream();

    if (this._currentTurnId) {
      virtualList.endStreamingTurn();
    }

    this._lastStreamingTurnId = this._currentTurnId;
    this._phase = 'idle';
    this._currentTurnId = null;

    webviewTracer.setExtensionCorrelationId(null);

    // Force sync traces to extension at end of response
    webviewTracer.forceSync();

    this.publishCoordinationState();
  }

  // ============================================
  // Shell Message Handlers
  // ============================================

  private handleShellExecuting(msg: { type: string; [key: string]: unknown }): void {
    const commands = msg.commands as Array<{ command: string; description?: string }>;

    if (!this._currentTurnId) {
      log.warn(`shellExecuting: NO CURRENT TURN ID - dropping message!`);
      return;
    }
    if (!commands || !Array.isArray(commands)) {
      log.warn(`shellExecuting: invalid commands array:`, commands);
      return;
    }

    log.debug(`shellExecuting: ${commands.length} commands for turn ${this._currentTurnId}`);

    const shellId = this.generateEventId('sh');
    this._lastShellId = shellId;
    this.emitTextFinalizeIfOpen(this._currentTurnId);
    this.emitTurnEvent(this._currentTurnId, {
      type: 'shell-start', id: shellId, commands: commands.map(c => ({ command: c.command })), iteration: this._currentIteration, ts: Date.now()
    });

    this._phase = 'waiting-for-results';
  }

  private handleShellResults(msg: { type: string; [key: string]: unknown }): void {
    const results = msg.results as Array<{ output?: string; success?: boolean; exitCode?: number }>;

    if (!this._currentTurnId || !results || !Array.isArray(results) || !this._lastShellId) return;

    this.emitTurnEvent(this._currentTurnId, {
      type: 'shell-complete', id: this._lastShellId,
      results: results.map(r => ({ output: r.output || '', success: r.success !== undefined ? r.success : (r.exitCode === 0) })),
      ts: Date.now()
    });

    this._phase = 'streaming';
  }

  // ============================================
  // Command Approval Message Handlers
  // ============================================

  private handleCommandApprovalRequired(msg: { type: string; [key: string]: unknown }): void {
    const command = msg.command as string;
    const prefix = msg.prefix as string;

    if (!this._currentTurnId || !command) {
      log.warn('commandApprovalRequired: no current turn or missing command');
      return;
    }

    const approvalEventId = this.generateEventId('ap');
    this.emitTurnEvent(this._currentTurnId, {
      type: 'approval-created', id: approvalEventId, command, prefix, shellId: this._lastShellId || '', ts: Date.now()
    });

    log.debug(`commandApprovalRequired: created approval ${approvalEventId} for "${command.substring(0, 40)}"`);
  }

  private handleCommandApprovalResolved(msg: { type: string; [key: string]: unknown }): void {
    const decision = msg.decision as 'allowed' | 'blocked';
    const turnId = this._currentTurnId || this._lastStreamingTurnId;

    if (!turnId || !decision) return;

    // Record event (with dedup check — UI click handler may have already resolved via postMessage round-trip)
    const tl = this._turnLogs.get(turnId);
    if (tl) {
      const approvalEvents = tl.getByType('approval-created');
      const lastApproval = approvalEvents[approvalEvents.length - 1];
      if (lastApproval) {
        const resolvedEvents = tl.getByType('approval-resolved');
        const alreadyResolved = resolvedEvents.some(e => e.id === lastApproval.id);
        if (!alreadyResolved) {
          this.emitTurnEvent(turnId, {
            type: 'approval-resolved', id: lastApproval.id, decision, persistent: false, ts: Date.now()
          });
        }
      }
    }
  }

  // ============================================
  // Tool Calls Message Handlers
  // ============================================

  private handleToolCallsStart(msg: { type: string; [key: string]: unknown }): void {
    const tools = msg.tools as Array<{ name: string; detail: string }>;

    if (!this._currentTurnId || !tools || !Array.isArray(tools)) return;

    log.debug(`toolCallsStart: ${tools.length} tools`);

    this.emitTurnEvent(this._currentTurnId, {
      type: 'tool-batch-start', tools: tools.map(t => ({ name: t.name, detail: t.detail })), ts: Date.now()
    });
  }

  private handleToolCallUpdate(msg: { type: string; [key: string]: unknown }): void {
    if (!this._currentTurnId || msg.index === undefined || !msg.status) return;

    this.emitTurnEvent(this._currentTurnId, {
      type: 'tool-update', index: msg.index as number, status: msg.status as string, ts: Date.now()
    });
  }

  private handleToolCallsUpdate(msg: { type: string; [key: string]: unknown }): void {
    const tools = msg.tools as Array<{ name: string; detail: string; status?: string }>;

    if (!this._currentTurnId || !tools || !Array.isArray(tools)) return;

    this.emitTurnEvent(this._currentTurnId, {
      type: 'tool-batch-update', tools: tools.map(t => ({ name: t.name, detail: t.detail, status: t.status })), ts: Date.now()
    });
  }

  // ============================================
  // Pending Files Message Handlers
  // ============================================

  private handleDiffListChanged(msg: { type: string; [key: string]: unknown }): void {
    const { virtualList } = this._actors;
    const diffs = msg.diffs as Array<{ filePath: string; status: string; diffId?: string; iteration?: number; superseded?: boolean }>;
    const source = (msg.source as string) || 'unknown';

    const turnId = this._currentTurnId || this._lastStreamingTurnId;
    if (!turnId || !diffs || !Array.isArray(diffs)) return;

    log.debug(`diffListChanged: ${diffs.length} diffs for turn ${turnId} (source=${source})`);

    const turn = virtualList.getTurn(turnId);
    if (!turn) return;

    const currentPaths = new Map(turn.pendingFiles.map(f => [f.filePath, f]));

    for (const diff of diffs) {
      const status = diff.status as 'pending' | 'applied' | 'rejected' | 'superseded' | 'error' | 'deleted' | 'expired';

      // Check if this diff exists in ANY turn (global search by diffId)
      if (diff.diffId) {
        const globalMatch = virtualList.findPendingFileGlobal(diff.diffId);
        if (globalMatch) {
          if (globalMatch.file.status !== status) {
            log.debug(`diffListChanged: global match for ${diff.filePath} (diffId=${diff.diffId}) in turn ${globalMatch.turnId}, ${globalMatch.file.status}→${status}`);
            virtualList.updatePendingStatus(globalMatch.turnId, globalMatch.file.id, status);
          }
          continue;
        }
      }

      // Check current turn by filePath (same file re-edited with new diffId)
      const existingByPath = currentPaths.get(diff.filePath);
      if (existingByPath) {
        const isResolved = existingByPath.status === 'rejected' || existingByPath.status === 'applied';
        if (isResolved && diff.diffId && existingByPath.diffId !== diff.diffId) {
          log.debug(`diffListChanged: ${diff.filePath} resolved (${existingByPath.status}) with new diffId — creating new pending entry`);
          // Fall through to create a new pending file entry
        } else {
          if (diff.diffId && existingByPath.diffId !== diff.diffId) {
            existingByPath.diffId = diff.diffId;
          }
          if (existingByPath.status !== status) {
            log.debug(`diffListChanged: path match for ${diff.filePath}, ${existingByPath.status}→${status}`);
            virtualList.updatePendingStatus(turnId, existingByPath.id, status);
          }
          continue;
        }
      }

      // Truly new diff — record in CQRS event log (for history save/restore)
      log.debug(`diffListChanged: new pending file ${diff.filePath} (diffId=${diff.diffId}) status=${status} source=${source} editMode=${msg.editMode}`);

      const tl = this._turnLogs.get(turnId);
      if (tl) {
        // Always append (not insertCausal) — file-modified events should appear
        // at the current stream position, matching where the dropdown renders live.
        // insertCausal would backdate the event to after its causing shell command,
        // splitting text that was streamed between the shell and the file notification.
        tl.append({
          type: 'file-modified', path: diff.filePath, status, editMode: msg.editMode as string | undefined, ts: Date.now()
        });
      }

      // In manual mode, diffs are managed entirely via VS Code diff tabs — no webview dropdown needed.
      // Only show pending files dropdown in ask/auto modes.
      const editMode = msg.editMode as string | undefined;
      if (editMode === 'manual') {
        continue;
      }

      virtualList.addPendingFile(turnId, {
        filePath: diff.filePath,
        diffId: diff.diffId,
        status,
        editMode: msg.editMode as EditMode | undefined
      });
    }

    if (msg.editMode && ['manual', 'ask', 'auto'].includes(msg.editMode as string)) {
      virtualList.setEditMode(msg.editMode as EditMode);
    }

    this.publishCoordinationState();
  }

  /**
   * Handle codeApplied message - update code block visual state on success,
   * or update file status to 'error' on failure.
   */
  private handleCodeApplied(msg: { type: string; [key: string]: unknown }): void {
    const { virtualList } = this._actors;
    const success = msg.success as boolean;
    const filePath = msg.filePath as string | undefined;

    if (success && filePath) {
      // Mark the code block as applied (grey out Diff, show checkmark on Apply)
      // Scope to the current/last streaming turn to avoid marking code blocks
      // in other turns that edit the same file (e.g., animals.txt edited in turn-2 and turn-3)
      const turnId = this._currentTurnId || this._lastStreamingTurnId;
      if (turnId) {
        virtualList.markCodeBlockApplied(filePath, turnId);
      } else {
        virtualList.markCodeBlockApplied(filePath);
      }
    } else if (!success && filePath) {
      log.debug(`codeApplied failed for: ${filePath}`);
      virtualList.updatePendingFileStatusByPath(filePath, 'error');
    }
  }

  // ============================================
  // Drawing Handlers
  // ============================================

  private handleDrawingReceived(msg: { type: string; [key: string]: unknown }): void {
    const { virtualList } = this._actors;
    const imageDataUrl = msg.imageDataUrl as string;
    const timestamp = (msg.timestamp as number) || Date.now();

    if (!imageDataUrl) return;

    // Create a user turn for the drawing
    const turnId = `turn-drawing-${Date.now()}`;
    virtualList.addTurn(turnId, 'user', { timestamp });
    virtualList.addDrawingSegment(turnId, imageDataUrl, timestamp);

    log.info(`Drawing received, added to turn ${turnId}`);
  }

  private handleAsciiDrawingReceived(msg: { type: string; [key: string]: unknown }): void {
    const { virtualList } = this._actors;
    const text = msg.text as string;
    if (!text) return;

    const codeFenced = '```\n' + text + '\n```';

    // Create a visible user turn showing the ASCII art in the chat stream
    const turnId = `turn-ascii-${Date.now()}`;
    virtualList.addTurn(turnId, 'user', { timestamp: Date.now() });
    virtualList.addTextSegment(turnId, codeFenced);

    // Send to extension as a regular user message (stored in history, sent to LLM)
    this._vscode.postMessage({ type: 'sendMessage', message: codeFenced });

    log.info(`ASCII diagram received, added to turn ${turnId}`);
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
      editMode?: 'manual' | 'ask' | 'auto';
      model?: string;
      timestamp?: number;
      sequence?: number;
      turnEvents?: Array<Record<string, unknown>>;
    }>;

    log.debug(`[VirtualGateway] handleLoadHistory: ${history?.length ?? 0} turns`);

    session.handleLoadHistory();
    virtualList.clear();
    this._turnLogs.clear();
    this._messageCounter = 0;

    if (history && Array.isArray(history)) {
      try {
        history.forEach(m => {
          const turnId = `turn-${++this._messageCounter}`;

          if (m.role === 'user') {
            virtualList.addTurn(turnId, 'user', {
              files: m.files,
              timestamp: m.timestamp || Date.now(),
              sequence: m.sequence
            });
            virtualList.addTextSegment(turnId, m.content);
          } else if (m.role === 'assistant') {
            virtualList.addTurn(turnId, 'assistant', {
              model: m.model,
              timestamp: m.timestamp || Date.now(),
              sequence: m.sequence
            });

            // ── CQRS: Load events and project ──
            // Prefer turnEvents (raw event log from DB) over fragment conversion
            const events = m.turnEvents && m.turnEvents.length > 0
              ? m.turnEvents as TurnEvent[]
              : this.convertHistoryToEvents(m);
            const source = m.turnEvents && m.turnEvents.length > 0 ? 'turnEvents' : 'converted';
            const tl = this.getTurnLog(turnId);
            tl.load(events);

            log.debug(`[VirtualGateway] restore turn ${turnId}: ${events.length} events from ${source}`);

            const segments = this._projector.projectFull(tl);

            log.debug(`[VirtualGateway] projected ${turnId}: ${segments.length} segments — [${segments.map((s, i) => `${i}:${this.summarizeSegment(s)}`).join(', ')}]`);

            for (const segment of segments) {
              this.renderSegment(turnId, segment);
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
    this._phase = 'idle';
    this._currentTurnId = null;

    // Clear CQRS state
    this._turnLogs.clear();
    this._currentIteration = 0;
    this._lastShellId = null;
    this._currentViewSegments = [];
    this._eventIdCounter = 0;
    this._shellSegmentMap.clear();
    this._approvalSegmentMap.clear();

    this.publishCoordinationState();
  }

  // ============================================
  // Fork Message Handlers
  // ============================================

  private handleTurnSequenceUpdate(msg: { type: string; [key: string]: unknown }): void {
    const { virtualList } = this._actors;
    const userSequence = msg.userSequence as number | undefined;
    const assistantSequence = msg.assistantSequence as number | undefined;

    // Walk last 2 turns (most recent user + assistant) and assign sequences
    const lastTurnIds = virtualList.getLastNTurnIds(2);
    for (const turnId of lastTurnIds) {
      const turn = virtualList.getTurn(turnId);
      if (!turn || turn.sequence) continue; // Skip if already has sequence

      if (turn.role === 'user' && userSequence) {
        virtualList.updateTurnSequence(turnId, userSequence);
      } else if (turn.role === 'assistant' && assistantSequence) {
        virtualList.updateTurnSequence(turnId, assistantSequence);
      }
    }
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

    // Sync session model so HeaderActor updates the button text
    if (msg.model) {
      const { session } = this._actors;
      session.handleModelChanged({ model: msg.model as string });
    }

    // Sync API key configured state to toolbar + input area
    if (msg.apiKeyConfigured !== undefined) {
      const { toolbar, inputArea } = this._actors;
      toolbar.setApiKeyConfigured(msg.apiKeyConfigured as boolean);
      inputArea.setSendDisabled(!(msg.apiKeyConfigured as boolean));
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

    const webSearch = msg.webSearch as { searchDepth?: string; creditsPerPrompt?: number; maxResultsPerSearch?: number; cacheDuration?: number; mode?: string; configured?: boolean } | undefined;

    // Sync web search mode and configured state to toolbar
    // (popup gets its state via onOpen → getWebSearchSettings → webSearchSettings response)
    if (webSearch?.mode) {
      const { toolbar } = this._actors;
      toolbar.setWebSearchMode(webSearch.mode as 'off' | 'manual' | 'auto');
    }
    if (webSearch?.configured !== undefined) {
      const { toolbar } = this._actors;
      toolbar.setWebSearchConfigured(webSearch.configured);
    }

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
      autoSaveHistory: msg.autoSaveHistory
    });
  }

  private handleGenerationStopped(): void {
    const { streaming, virtualList } = this._actors;

    streaming.endStream();

    if (this._currentTurnId) {
      virtualList.endStreamingTurn();
    }

    this._phase = 'idle';
    this._currentTurnId = null;

    this.publishCoordinationState();
  }

  // ============================================
  // Coordination State Publishing
  // ============================================

  private publishCoordinationState(): void {
    this.publish({
      'gateway.phase': this._phase,
      'gateway.currentTurn': this._currentTurnId,
    });
  }

  // ============================================
  // Public API
  // ============================================

  get phase(): GatewayPhase {
    return this._phase;
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
