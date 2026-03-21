/**
 * VirtualListActor
 *
 * Manages virtual rendering of conversation turns using a pool of MessageTurnActor instances.
 * Only visible turns are rendered; off-screen actors are recycled.
 *
 * Architecture:
 * - Maintains source of truth for all turn data
 * - Pools MessageTurnActor instances for reuse
 * - Computes visibility based on scroll position
 * - Measures heights after render for accurate positioning
 *
 * Performance:
 * - O(1) actor acquisition/release from pool
 * - O(visible) work on scroll (not O(total))
 * - Height caching eliminates layout thrashing
 *
 * Publications:
 * - virtualList.turnCount: number - total turns
 * - virtualList.visibleCount: number - visible turns
 * - virtualList.poolStats: PoolStats - pool statistics
 *
 * Subscriptions:
 * - streaming.active: boolean - track streaming state
 */

import { EventStateActor } from '../../state/EventStateActor';
import { EventStateManager } from '../../state/EventStateManager';
import type { ActorConfig } from '../../state/types';
import { MessageTurnActor, type MessageTurnActorConfig } from '../turn';
import { createLogger } from '../../logging';
import type {
  TurnData,
  TextSegmentData,
  ThinkingIterationData,
  ToolBatchData,
  ShellSegmentData,
  PendingFileData,
  CommandApprovalData,
  DrawingSegmentData,
  VisibleRange,
  PoolStats,
  VirtualListConfig,
  ContentOrderEntry
} from './types';
import { DEFAULT_CONFIG } from './types';
import type { TurnRole, EditMode } from '../turn/types';

const log = createLogger('VirtualList');

// ============================================
// Actor Binding
// ============================================

interface BoundActor {
  actor: MessageTurnActor;
  turnId: string;
  element: HTMLElement;
  resizeObserver: ResizeObserver;
}

// ============================================
// VirtualListActor
// ============================================

export class VirtualListActor extends EventStateActor {
  // ============================================
  // Configuration
  // ============================================

  private readonly config: Required<VirtualListConfig>;

  // ============================================
  // Turn Data (source of truth)
  // ============================================

  /** All turns in order */
  private _turns: TurnData[] = [];

  /** Quick lookup by turnId */
  private _turnMap: Map<string, TurnData> = new Map();

  /** The currently streaming turn (if any) */
  private _streamingTurnId: string | null = null;

  // ============================================
  // Actor Pool
  // ============================================

  /** Available actors for reuse */
  private _pool: MessageTurnActor[] = [];

  /** Actors currently bound to visible turns */
  private _boundActors: Map<string, BoundActor> = new Map();

  /** Total actors ever created (for stats) */
  private _totalActorsCreated = 0;

  // ============================================
  // Visibility State
  // ============================================

  /** Current visible range */
  private _visibleRange: VisibleRange = {
    startIndex: 0,
    endIndex: -1,
    scrollTop: 0,
    viewportHeight: 0
  };

  /** Total content height (sum of all turn heights) */
  private _totalHeight = 0;

  // ============================================
  // Scroll Handling
  // ============================================

  private _scrollContainer: HTMLElement | null = null;
  private _contentContainer: HTMLElement | null = null;
  private _scrollHandler: (() => void) | null = null;
  private _scrollDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _resizeObserver: ResizeObserver | null = null;

  // ============================================
  // Edit Mode
  // ============================================

  private _editMode: EditMode = 'manual';

  // ============================================
  // Callbacks
  // ============================================

  private readonly _postMessage: ((message: Record<string, unknown>) => void) | null;
  private readonly _onPendingFileAction: ((action: 'accept' | 'reject' | 'focus', fileId: string, diffId?: string, filePath?: string) => void) | null;
  private readonly _onCommandApprovalAction: ((command: string, decision: 'allowed' | 'blocked', persistent: boolean, prefix: string) => void) | null;

  // ============================================
  // Constructor
  // ============================================

  constructor(
    manager: EventStateManager,
    scrollContainer: HTMLElement,
    options?: {
      config?: VirtualListConfig;
      postMessage?: (message: Record<string, unknown>) => void;
      onPendingFileAction?: (action: 'accept' | 'reject' | 'focus', fileId: string, diffId?: string, filePath?: string) => void;
      onCommandApprovalAction?: (command: string, decision: 'allowed' | 'blocked', persistent: boolean, prefix: string) => void;
    }
  ) {
    // Create content container inside scroll container
    const contentContainer = document.createElement('div');
    contentContainer.className = 'virtual-list-content';
    contentContainer.style.position = 'relative';
    contentContainer.style.width = '100%';
    scrollContainer.appendChild(contentContainer);

    const actorConfig: ActorConfig = {
      manager,
      element: contentContainer,
      publications: {
        'virtualList.turnCount': () => this._turns.length,
        'virtualList.visibleCount': () => this._boundActors.size,
        'virtualList.poolStats': () => this.getPoolStats()
      },
      subscriptions: {
        'streaming.active': (value: unknown) => this.handleStreamingActive(value as boolean)
      },
      enableDOMChangeDetection: false
    };

    super(actorConfig);

    this.config = { ...DEFAULT_CONFIG, ...options?.config };
    this._scrollContainer = scrollContainer;
    this._contentContainer = contentContainer;
    this._postMessage = options?.postMessage ?? null;
    this._onPendingFileAction = options?.onPendingFileAction ?? null;
    this._onCommandApprovalAction = options?.onCommandApprovalAction ?? null;

    this.setupScrollHandling();
    this.prewarmPool();
  }

  // ============================================
  // Initialization
  // ============================================

  private setupScrollHandling(): void {
    if (!this._scrollContainer) return;

    this._scrollHandler = () => {
      this.handleScroll();
    };

    this._scrollContainer.addEventListener('scroll', this._scrollHandler, { passive: true });

    // Watch for viewport resize
    this._resizeObserver = new ResizeObserver(() => {
      this.handleViewportResize();
    });
    this._resizeObserver.observe(this._scrollContainer);

    // Initial viewport size
    this._visibleRange.viewportHeight = this._scrollContainer.clientHeight;
  }

  private prewarmPool(): void {
    for (let i = 0; i < this.config.minPoolSize; i++) {
      const actor = this.createActor();
      this._pool.push(actor);
    }
  }

  // ============================================
  // Actor Pool Management
  // ============================================

  private createActor(): MessageTurnActor {
    this._totalActorsCreated++;
    this.checkPoolHealth();

    // Create host element for the actor
    const hostElement = document.createElement('div');
    hostElement.className = 'virtual-list-turn';
    hostElement.style.position = 'absolute';
    hostElement.style.left = '0';
    hostElement.style.right = '0';
    // Position will be set when bound

    const config: MessageTurnActorConfig = {
      manager: this.manager,
      element: hostElement,
      postMessage: this._postMessage ?? undefined,
      onPendingFileAction: this._onPendingFileAction ?? undefined,
      onCommandApprovalAction: this._onCommandApprovalAction ?? undefined,
    };

    return new MessageTurnActor(config);
  }

  private acquireActor(): MessageTurnActor {
    let actor = this._pool.pop();

    if (!actor) {
      actor = this.createActor();
    }

    return actor;
  }

  private releaseActor(actor: MessageTurnActor): void {
    actor.reset();

    // Remove from DOM
    actor.element.remove();

    // Keep in pool up to max size
    if (this._pool.length < this.config.maxPoolSize) {
      this._pool.push(actor);
    } else {
      actor.destroy();
    }
  }

  // ============================================
  // Turn Management
  // ============================================

  /**
   * Add a new turn to the list.
   * Returns the turn data for further updates.
   */
  addTurn(turnId: string, role: TurnRole, options?: {
    model?: string;
    files?: string[];
    timestamp?: number;
    sequence?: number;
  }): TurnData {
    const turn: TurnData = {
      turnId,
      role,
      timestamp: options?.timestamp ?? Date.now(),
      model: options?.model,
      files: options?.files,
      sequence: options?.sequence,
      height: this.config.defaultTurnHeight,
      heightMeasured: false,
      offsetTop: this._totalHeight,
      visible: false,
      index: this._turns.length,
      textSegments: [],
      thinkingIterations: [],
      toolBatches: [],
      shellSegments: [],
      pendingFiles: [],
      commandApprovals: [],
      drawingSegments: [],
      isStreaming: false,
      contentOrder: []
    };

    this._turns.push(turn);
    this._turnMap.set(turnId, turn);
    this._totalHeight += turn.height;

    // Update content container height
    this.updateContentHeight();

    // Check if new turn is visible
    this.updateVisibility();

    this.publish({
      'virtualList.turnCount': this._turns.length
    });

    return turn;
  }

  /**
   * Get a turn by ID.
   */
  getTurn(turnId: string): TurnData | undefined {
    return this._turnMap.get(turnId);
  }

  /**
   * Get the currently streaming turn.
   */
  getStreamingTurn(): TurnData | undefined {
    return this._streamingTurnId ? this._turnMap.get(this._streamingTurnId) : undefined;
  }

  /**
   * Get the bound actor for a turn (if visible).
   */
  getBoundActor(turnId: string): MessageTurnActor | undefined {
    return this._boundActors.get(turnId)?.actor;
  }

  /**
   * Get the last N turn IDs (most recent first).
   */
  getLastNTurnIds(n: number): string[] {
    const start = Math.max(0, this._turns.length - n);
    return this._turns.slice(start).map(t => t.turnId);
  }

  /**
   * Update the event sequence number for a turn (used for fork API).
   * If the turn has a bound actor, also updates it so the fork button appears.
   */
  updateTurnSequence(turnId: string, sequence: number): void {
    const turn = this._turnMap.get(turnId);
    if (!turn) return;
    turn.sequence = sequence;
    // Update bound actor if visible
    const bound = this._boundActors.get(turnId);
    if (bound) {
      bound.actor.updateSequence(sequence);
    }
  }

  /**
   * Start streaming on a turn.
   * Always ensures an actor is bound for the streaming turn.
   */
  startStreamingTurn(turnId: string): void {
    const turn = this._turnMap.get(turnId);
    if (!turn) {
      log.warn('startStreamingTurn: turn not found:', turnId);
      return;
    }

    turn.isStreaming = true;
    this._streamingTurnId = turnId;

    // CRITICAL: Always bind an actor for streaming turns
    // This ensures content is rendered even if turn is off-screen
    let bound = this._boundActors.get(turnId);
    if (!bound) {
      log.debug('Force-binding actor for streaming turn:', turnId);
      this.bindActorToTurn(turn);
      bound = this._boundActors.get(turnId);
    }

    if (bound) {
      bound.actor.startStreaming();

      // Measure height after startStreaming() renders the role header.
      // This gives the turn immediate visible height (V3 fix: no empty gap during API wait).
      // Forces synchronous layout so _totalHeight and margin-top are correct before paint.
      this.measureTurnHeight(turnId);
      log.debug('startStreamingTurn: bound and measured', turnId, `height=${turn.height}`);
    }
  }

  /**
   * Scroll to make a turn visible.
   */
  scrollToTurn(turnId: string): void {
    const turn = this._turnMap.get(turnId);
    if (!turn || !this._scrollContainer) return;

    const turnBottom = turn.offsetTop + turn.height;
    const viewportBottom = this._scrollContainer.scrollTop + this._scrollContainer.clientHeight;

    // If turn is below the viewport, scroll down to show it
    if (turnBottom > viewportBottom) {
      this._scrollContainer.scrollTop = turn.offsetTop;
    }
  }

  /**
   * End streaming on the current turn.
   */
  endStreamingTurn(): void {
    if (!this._streamingTurnId) return;

    const turn = this._turnMap.get(this._streamingTurnId);
    if (turn) {
      turn.isStreaming = false;
    }

    const bound = this._boundActors.get(this._streamingTurnId);
    if (bound) {
      bound.actor.endStreaming();
      // Measure final height
      this.measureTurnHeight(this._streamingTurnId);
    }

    this._streamingTurnId = null;
  }

  // ============================================
  // Content Updates (delegated to bound actors)
  // ============================================

  /**
   * Add a text segment to a turn.
   */
  addTextSegment(turnId: string, content: string, isContinuation = false): string | null {
    const turn = this._turnMap.get(turnId);
    if (!turn) return null;

    const segmentIndex = turn.textSegments.length;
    const segmentId = `${turnId}-text-${segmentIndex + 1}`;
    const segment: TextSegmentData = {
      id: segmentId,
      content,
      isContinuation,
      complete: !turn.isStreaming
    };

    turn.textSegments.push(segment);
    turn.contentOrder.push({ type: 'text', index: segmentIndex });

    // Update actor if visible
    const bound = this._boundActors.get(turnId);
    if (bound) {
      bound.actor.createTextSegment(content, { isContinuation });
    }

    return segmentId;
  }

  /**
   * Update text content in the current segment.
   */
  updateTextContent(turnId: string, content: string): void {
    const turn = this._turnMap.get(turnId);
    if (!turn) return;

    // Update the last segment's content
    const lastSegment = turn.textSegments[turn.textSegments.length - 1];
    if (lastSegment) {
      lastSegment.content = content;
    }

    // Update actor if visible
    const bound = this._boundActors.get(turnId);
    if (bound) {
      bound.actor.updateTextContent(content);
    }
  }

  /**
   * Finalize current segment before interleaving.
   */
  finalizeCurrentSegment(turnId: string): boolean {
    const turn = this._turnMap.get(turnId);
    if (!turn) return false;

    const lastSegment = turn.textSegments[turn.textSegments.length - 1];
    if (lastSegment) {
      lastSegment.complete = true;
    }

    const bound = this._boundActors.get(turnId);
    if (bound) {
      return bound.actor.finalizeCurrentSegment();
    }

    return false;
  }

  /**
   * Resume with a new segment after interleaving.
   * Creates a continuation segment in both data and actor.
   *
   * IMPORTANT: We add data directly here instead of using addTextSegment
   * because resumeWithNewSegment() already creates the segment in the actor,
   * and addTextSegment would create a duplicate.
   */
  resumeWithNewSegment(turnId: string): void {
    const turn = this._turnMap.get(turnId);
    if (!turn) return;

    // Create segment in actor (if bound)
    const bound = this._boundActors.get(turnId);
    if (bound) {
      bound.actor.resumeWithNewSegment();
    }

    // Add segment data directly (NOT via addTextSegment which would create again in actor)
    const segmentIndex = turn.textSegments.length;
    const segmentId = `${turnId}-text-${segmentIndex + 1}`;
    const segment: TextSegmentData = {
      id: segmentId,
      content: '',
      isContinuation: true,
      complete: false
    };

    turn.textSegments.push(segment);
    turn.contentOrder.push({ type: 'text', index: segmentIndex });
  }

  /**
   * Start a thinking iteration.
   */
  startThinkingIteration(turnId: string): number {
    const turn = this._turnMap.get(turnId);
    if (!turn) return -1;

    const iterationIndex = turn.thinkingIterations.length;
    const index = iterationIndex + 1;
    const iteration: ThinkingIterationData = {
      index,
      content: '',
      complete: false,
      expanded: false
    };

    turn.thinkingIterations.push(iteration);
    turn.contentOrder.push({ type: 'thinking', index: iterationIndex });

    const bound = this._boundActors.get(turnId);
    if (bound) {
      bound.actor.startThinkingIteration();
    }

    return index;
  }

  /**
   * Update thinking content.
   */
  updateThinkingContent(turnId: string, content: string): void {
    const turn = this._turnMap.get(turnId);
    if (!turn) return;

    // Update last iteration
    const lastIteration = turn.thinkingIterations[turn.thinkingIterations.length - 1];
    if (lastIteration) {
      lastIteration.content = content;
    }

    const bound = this._boundActors.get(turnId);
    if (bound) {
      bound.actor.updateThinkingContent(content);
    }
  }

  /**
   * Mark the current thinking iteration as complete.
   */
  completeThinkingIteration(turnId: string): void {
    const turn = this._turnMap.get(turnId);
    if (!turn) return;

    const lastIteration = turn.thinkingIterations[turn.thinkingIterations.length - 1];
    if (lastIteration) {
      lastIteration.complete = true;
    }

    const bound = this._boundActors.get(turnId);
    if (bound) {
      bound.actor.completeThinkingIteration();
    }
  }

  /**
   * Start a tool batch.
   */
  startToolBatch(turnId: string, tools: Array<{ name: string; detail: string }>): string | null {
    const turn = this._turnMap.get(turnId);
    if (!turn) {
      log.warn(`startToolBatch: turn ${turnId} not found`);
      return null;
    }

    log.debug(`startToolBatch: creating batch with ${tools.length} tools for ${turnId}`);

    const batchIndex = turn.toolBatches.length;
    const batchId = `${turnId}-tools-${batchIndex + 1}`;
    const batch: ToolBatchData = {
      id: batchId,
      calls: tools.map((tool, i) => ({
        id: `${batchId}-${i}`,
        name: tool.name,
        detail: tool.detail,
        status: 'running'
      })),
      expanded: false,
      complete: false
    };

    turn.toolBatches.push(batch);
    turn.contentOrder.push({ type: 'tools', index: batchIndex });

    const bound = this._boundActors.get(turnId);
    if (bound) {
      log.debug(`startToolBatch: actor bound, delegating to MessageTurnActor`);
      bound.actor.startToolBatch(tools);
    } else {
      log.warn(`startToolBatch: actor NOT bound for ${turnId} - batch will be stored but not rendered`);
    }

    return batchId;
  }

  /**
   * Update a tool's status.
   */
  updateTool(turnId: string, index: number, status: 'pending' | 'running' | 'done' | 'error'): void {
    const turn = this._turnMap.get(turnId);
    if (!turn) return;

    const lastBatch = turn.toolBatches[turn.toolBatches.length - 1];
    if (lastBatch && lastBatch.calls[index]) {
      lastBatch.calls[index].status = status;
    }

    const bound = this._boundActors.get(turnId);
    if (bound) {
      bound.actor.updateTool(index, status);
    }
  }

  /**
   * Update the entire tool batch with new tools array.
   * This handles adding new tools to an existing batch.
   */
  updateToolBatch(turnId: string, tools: Array<{ name: string; detail: string; status?: string }>): void {
    const turn = this._turnMap.get(turnId);
    if (!turn) return;

    const lastBatch = turn.toolBatches[turn.toolBatches.length - 1];
    if (!lastBatch) return;

    // Update the batch calls
    lastBatch.calls = tools.map((tool, i) => ({
      id: lastBatch.calls[i]?.id ?? `tool-${i}`,
      name: tool.name,
      detail: tool.detail,
      status: (tool.status as 'pending' | 'running' | 'done' | 'error') ?? 'running'
    }));

    const bound = this._boundActors.get(turnId);
    if (bound) {
      bound.actor.updateToolBatch(tools.map(t => ({
        name: t.name,
        detail: t.detail,
        status: (t.status as 'pending' | 'running' | 'done' | 'error') ?? 'running'
      })));
    }
  }

  /**
   * Complete the current tool batch.
   */
  completeToolBatch(turnId: string): void {
    const turn = this._turnMap.get(turnId);
    if (!turn) return;

    const lastBatch = turn.toolBatches[turn.toolBatches.length - 1];
    if (lastBatch) {
      lastBatch.complete = true;
    }

    const bound = this._boundActors.get(turnId);
    if (bound) {
      bound.actor.completeToolBatch();
    }
  }

  /**
   * Create a shell segment.
   */
  createShellSegment(turnId: string, commands: Array<{ command: string; cwd?: string }>): string | null {
    const turn = this._turnMap.get(turnId);
    if (!turn) {
      log.warn(`createShellSegment: turn ${turnId} not found`);
      return null;
    }

    const segmentIndex = turn.shellSegments.length;
    const segmentId = `${turnId}-shell-${segmentIndex + 1}`;
    const segment: ShellSegmentData = {
      id: segmentId,
      commands: commands.map(cmd => ({
        command: cmd.command,
        cwd: cmd.cwd,
        status: 'pending'
      })),
      expanded: false,
      complete: false
    };

    turn.shellSegments.push(segment);
    turn.contentOrder.push({ type: 'shell', index: segmentIndex });

    log.debug(`createShellSegment: created ${segmentId} with ${commands.length} commands`);

    // If actor is bound, create in actor and store its internal ID
    const bound = this._boundActors.get(turnId);
    if (bound) {
      log.debug(`createShellSegment: actor bound, delegating to MessageTurnActor`);
      const actorSegmentId = bound.actor.createShellSegment(commands);
      segment.actorSegmentId = actorSegmentId;
      log.debug(`createShellSegment: actor segment ID = ${actorSegmentId}`);
    } else {
      log.warn(`createShellSegment: actor NOT bound for ${turnId} - segment will be stored but not rendered`);
    }

    return segmentId;
  }

  /**
   * Start shell segment execution.
   */
  startShellSegment(turnId: string, segmentId: string): void {
    const turn = this._turnMap.get(turnId);
    if (!turn) return;

    const segment = turn.shellSegments.find(s => s.id === segmentId);
    if (segment) {
      segment.commands.forEach(cmd => {
        cmd.status = 'running';
      });

      // Use actor's segment ID for delegation
      const bound = this._boundActors.get(turnId);
      if (bound && segment.actorSegmentId) {
        bound.actor.startShellSegment(segment.actorSegmentId);
      }
    }
  }

  /**
   * Set shell results.
   */
  setShellResults(turnId: string, segmentId: string, results: Array<{ output: string; success: boolean }>): void {
    const turn = this._turnMap.get(turnId);
    if (!turn) return;

    const segment = turn.shellSegments.find(s => s.id === segmentId);
    if (segment) {
      results.forEach((result, i) => {
        if (segment.commands[i]) {
          segment.commands[i].output = result.output;
          segment.commands[i].success = result.success;
          segment.commands[i].status = result.success ? 'done' : 'error';
        }
      });
      segment.complete = true;

      // Use actor's segment ID for delegation
      const bound = this._boundActors.get(turnId);
      if (bound && segment.actorSegmentId) {
        bound.actor.setShellResults(segment.actorSegmentId, results);
      }
    }
  }

  // ============================================
  // Command Approval Methods
  // ============================================

  /**
   * Create an inline command approval widget.
   */
  createCommandApproval(turnId: string, command: string, prefix: string, unknownSubCommand: string): string | null {
    const turn = this._turnMap.get(turnId);
    if (!turn) {
      log.warn(`createCommandApproval: turn ${turnId} not found`);
      return null;
    }

    const approvalIndex = turn.commandApprovals.length;
    const approvalId = `${turnId}-approval-${approvalIndex}`;

    const approval: CommandApprovalData = {
      id: approvalId,
      command,
      prefix,
      unknownSubCommand,
      status: 'pending',
    };

    turn.commandApprovals.push(approval);
    turn.contentOrder.push({ type: 'approval', index: approvalIndex });

    const bound = this._boundActors.get(turnId);
    if (bound) {
      const actorApprovalId = bound.actor.createCommandApproval(command, prefix, unknownSubCommand);
      approval.actorApprovalId = actorApprovalId;
    }

    this.updateLayout();

    return approvalId;
  }

  /**
   * Resolve a command approval (update status in data and UI).
   */
  resolveCommandApproval(turnId: string, approvalId: string, decision: 'allowed' | 'blocked'): void {
    const turn = this._turnMap.get(turnId);
    if (!turn) return;

    const approval = turn.commandApprovals.find(a => a.id === approvalId);
    if (approval) {
      approval.status = decision;

      const bound = this._boundActors.get(turnId);
      if (bound && approval.actorApprovalId) {
        bound.actor.resolveCommandApproval(approval.actorApprovalId, decision);
      }
    }
  }

  /**
   * Add a pending file.
   */
  addPendingFile(turnId: string, file: { filePath: string; diffId?: string; status?: 'pending' | 'applied' | 'rejected' | 'superseded' | 'error'; editMode?: 'manual' | 'ask' | 'auto' }): string | null {
    const turn = this._turnMap.get(turnId);
    if (!turn) {
      log.warn(`addPendingFile: turn ${turnId} not found`);
      return null;
    }

    log.debug(`addPendingFile: adding ${file.filePath} to ${turnId}`);

    const fileName = file.filePath.split('/').pop() ?? file.filePath;
    const fileIndex = turn.pendingFiles.length;
    const fileId = `${turnId}-pending-${fileIndex + 1}`;

    const pendingFile: PendingFileData = {
      id: fileId,
      filePath: file.filePath,
      fileName,
      diffId: file.diffId,
      status: file.status ?? 'pending',
      iteration: fileIndex + 1,
      editMode: file.editMode ?? this._editMode
    };

    turn.pendingFiles.push(pendingFile);
    turn.contentOrder.push({ type: 'pending', index: fileIndex });

    const bound = this._boundActors.get(turnId);
    if (bound) {
      bound.actor.addPendingFile({ ...file, status: pendingFile.status, editMode: pendingFile.editMode });
    }

    return fileId;
  }

  /**
   * Update pending file status.
   */
  updatePendingStatus(turnId: string, fileId: string, status: 'pending' | 'applied' | 'rejected' | 'superseded' | 'error'): void {
    const turn = this._turnMap.get(turnId);
    if (!turn) return;

    const file = turn.pendingFiles.find(f => f.id === fileId);
    if (file) {
      file.status = status;
    }

    const bound = this._boundActors.get(turnId);
    if (bound) {
      bound.actor.updatePendingStatus(fileId, status, file?.diffId, file?.filePath);
    }
  }

  /**
   * Update pending file status by file path (searches all turns).
   * Used when we only have the file path (e.g., from codeApplied error message).
   */
  updatePendingFileStatusByPath(filePath: string, status: 'pending' | 'applied' | 'rejected' | 'superseded' | 'error'): void {
    // Search through all turns for the file
    for (const [turnId, turn] of this._turnMap) {
      const file = turn.pendingFiles.find(f => f.filePath === filePath);
      if (file) {
        file.status = status;
        const bound = this._boundActors.get(turnId);
        if (bound) {
          bound.actor.updatePendingStatus(file.id, status, file.diffId, file.filePath);
        }
        return; // Found and updated
      }
    }
  }

  /**
   * Find a pending file by diffId across ALL turns.
   * Returns the turnId and file data if found, null otherwise.
   */
  findPendingFileGlobal(diffId: string): { turnId: string; file: PendingFileData } | null {
    for (const [turnId, turn] of this._turnMap) {
      for (const file of turn.pendingFiles) {
        if (file.diffId === diffId) {
          return { turnId, file };
        }
      }
    }
    return null;
  }

  // ============================================
  // Drawing Segments
  // ============================================

  /**
   * Add a drawing segment (phone drawing image) to a turn.
   */
  addDrawingSegment(turnId: string, imageDataUrl: string, timestamp?: number): string | null {
    const turn = this._turnMap.get(turnId);
    if (!turn) {
      log.warn(`addDrawingSegment: turn ${turnId} not found`);
      return null;
    }

    const segmentIndex = turn.drawingSegments.length;
    const segmentId = `${turnId}-drawing-${segmentIndex}`;

    const segment: DrawingSegmentData = {
      id: segmentId,
      imageDataUrl,
      timestamp: timestamp ?? Date.now()
    };

    turn.drawingSegments.push(segment);
    turn.contentOrder.push({ type: 'drawing', index: segmentIndex });

    const bound = this._boundActors.get(turnId);
    if (bound) {
      bound.actor.createDrawingSegment(imageDataUrl);
    }

    return segmentId;
  }

  // ============================================
  // Visibility Management
  // ============================================

  private updateVisibility(): void {
    if (!this._scrollContainer) return;

    const scrollTop = this._scrollContainer.scrollTop;
    const viewportHeight = this._scrollContainer.clientHeight;
    const overscan = this.config.overscan * this.config.defaultTurnHeight;

    // Find first visible turn
    const viewTop = Math.max(0, scrollTop - overscan);
    const viewBottom = scrollTop + viewportHeight + overscan;

    let startIndex = -1;
    let endIndex = -1;

    for (let i = 0; i < this._turns.length; i++) {
      const turn = this._turns[i];
      const turnTop = turn.offsetTop;
      const turnBottom = turnTop + turn.height;

      // Check if turn intersects viewport
      if (turnBottom >= viewTop && turnTop <= viewBottom) {
        if (startIndex === -1) startIndex = i;
        endIndex = i;
        turn.visible = true;
      } else {
        turn.visible = false;
      }
    }

    // Handle empty case
    if (startIndex === -1) {
      startIndex = 0;
      endIndex = -1;
    }

    const rangeChanged =
      this._visibleRange.startIndex !== startIndex ||
      this._visibleRange.endIndex !== endIndex;

    this._visibleRange = {
      startIndex,
      endIndex,
      scrollTop,
      viewportHeight
    };

    if (rangeChanged) {
      this.reconcileActors();
    }
  }

  private reconcileActors(): void {
    const { startIndex, endIndex } = this._visibleRange;

    // Find turns that should be visible
    const shouldBeVisible = new Set<string>();
    for (let i = startIndex; i <= endIndex && i < this._turns.length; i++) {
      shouldBeVisible.add(this._turns[i].turnId);
    }

    // Release actors for turns no longer visible
    for (const [turnId, bound] of this._boundActors) {
      if (!shouldBeVisible.has(turnId)) {
        // Trace actor unbind
        this.manager.getTracer()?.traceActorUnbind(bound.actor.actorId, turnId);
        bound.resizeObserver.disconnect();
        this.releaseActor(bound.actor);
        this._boundActors.delete(turnId);
      }
    }

    // Bind actors for newly visible turns
    for (const turnId of shouldBeVisible) {
      if (!this._boundActors.has(turnId)) {
        const turn = this._turnMap.get(turnId);
        if (turn) {
          this.bindActorToTurn(turn);
        }
      }
    }

    this.publish({
      'virtualList.visibleCount': this._boundActors.size,
      'virtualList.poolStats': this.getPoolStats()
    });
  }

  private bindActorToTurn(turn: TurnData): void {
    const actor = this.acquireActor();

    // Position the actor
    actor.element.style.top = `${turn.offsetTop}px`;

    // Add to DOM
    if (this._contentContainer) {
      this._contentContainer.appendChild(actor.element);
    }

    // Bind to turn data
    actor.bind({
      turnId: turn.turnId,
      role: turn.role,
      timestamp: turn.timestamp,
      model: turn.model,
      files: turn.files,
      sequence: turn.sequence
    });

    // Set edit mode
    actor.setEditMode(this._editMode);

    // Restore streaming state
    if (turn.isStreaming) {
      actor.startStreaming();
    }

    // Restore content
    this.restoreTurnContent(actor, turn);

    // Create ResizeObserver to detect height changes (e.g., code block expansion).
    // Runs after layout but BEFORE paint — height updates are visible in the same frame.
    // No requestAnimationFrame: rAF defers to the next frame, causing a 1-frame flash
    // where margin-top: auto holds the wrong value (content rendered but container stale).
    const resizeObserver = new ResizeObserver(() => {
      this.measureTurnHeight(turn.turnId);
    });
    resizeObserver.observe(actor.element);

    // Store binding
    this._boundActors.set(turn.turnId, {
      actor,
      turnId: turn.turnId,
      element: actor.element,
      resizeObserver
    });

    // Trace actor bind
    this.manager.getTracer()?.traceActorBind(actor.actorId, turn.turnId);

    // Measure height synchronously after first render.
    // Reading offsetHeight forces layout, giving us the correct initial height
    // before the browser paints. This avoids the flash from margin-top: auto.
    this.measureTurnHeight(turn.turnId);
  }

  private restoreTurnContent(actor: MessageTurnActor, turn: TurnData): void {
    // Restore content in the original interleaved order using contentOrder
    for (const entry of turn.contentOrder) {
      switch (entry.type) {
        case 'text': {
          const segment = turn.textSegments[entry.index];
          if (segment) {
            actor.createTextSegment(segment.content, { isContinuation: segment.isContinuation });
          }
          break;
        }

        case 'thinking': {
          const iteration = turn.thinkingIterations[entry.index];
          if (iteration) {
            actor.startThinkingIteration();
            if (iteration.content) {
              actor.updateThinkingContent(iteration.content);
            }
            if (iteration.complete) {
              actor.completeThinkingIteration();
            }
            if (iteration.expanded) {
              actor.toggleThinkingExpanded(iteration.index);
            }
          }
          break;
        }

        case 'tools': {
          const batch = turn.toolBatches[entry.index];
          if (batch) {
            actor.startToolBatch(batch.calls.map(c => ({ name: c.name, detail: c.detail })));
            batch.calls.forEach((call, i) => {
              if (call.status !== 'running') {
                actor.updateTool(i, call.status);
              }
            });
            if (batch.complete) {
              actor.completeToolBatch();
            }
          }
          break;
        }

        case 'shell': {
          const segment = turn.shellSegments[entry.index];
          if (segment) {
            const actorSegmentId = actor.createShellSegment(segment.commands.map(c => ({
              command: c.command,
              cwd: c.cwd
            })));
            // Store the actor's segment ID for future operations
            segment.actorSegmentId = actorSegmentId;
            if (actorSegmentId && segment.complete) {
              actor.setShellResults(actorSegmentId, segment.commands.map(c => ({
                output: c.output ?? '',
                success: c.success ?? true
              })));
            }
          }
          break;
        }

        case 'pending': {
          const file = turn.pendingFiles[entry.index];
          if (file) {
            actor.addPendingFile({
              filePath: file.filePath,
              diffId: file.diffId,
              status: file.status,
              editMode: file.editMode
            });
          }
          break;
        }

        case 'approval': {
          const approval = turn.commandApprovals[entry.index];
          if (approval) {
            const actorApprovalId = actor.createCommandApproval(approval.command, approval.prefix, approval.unknownSubCommand);
            approval.actorApprovalId = actorApprovalId;
            if (approval.status !== 'pending' && actorApprovalId) {
              actor.resolveCommandApproval(actorApprovalId, approval.status);
            }
          }
          break;
        }

        case 'drawing': {
          const drawing = turn.drawingSegments[entry.index];
          if (drawing) {
            actor.createDrawingSegment(drawing.imageDataUrl);
          }
          break;
        }
      }
    }
  }

  // ============================================
  // Height Management
  // ============================================

  private measureTurnHeight(turnId: string): void {
    const bound = this._boundActors.get(turnId);
    const turn = this._turnMap.get(turnId);
    if (!bound || !turn) return;

    const measuredHeight = bound.actor.element.offsetHeight;

    if (measuredHeight > 0 && measuredHeight !== turn.height) {
      const oldHeight = turn.height;
      const heightDelta = measuredHeight - oldHeight;
      turn.height = measuredHeight;
      turn.heightMeasured = true;

      log.debug(`measureTurnHeight: ${turnId} ${oldHeight}→${measuredHeight} (Δ${heightDelta > 0 ? '+' : ''}${heightDelta})`);

      // Update offsets for all following turns
      for (let i = turn.index + 1; i < this._turns.length; i++) {
        this._turns[i].offsetTop += heightDelta;

        // Update position if bound
        const followingBound = this._boundActors.get(this._turns[i].turnId);
        if (followingBound) {
          followingBound.actor.element.style.top = `${this._turns[i].offsetTop}px`;
        }
      }

      this._totalHeight += heightDelta;
      this.updateContentHeight();
    }
  }

  private updateContentHeight(): void {
    if (this._contentContainer) {
      this._contentContainer.style.height = `${this._totalHeight}px`;

      // Push content to bottom when few messages (chat-style layout).
      // CSS margin-top: auto was unreliable in VS Code webview, so we compute explicitly.
      if (this._scrollContainer) {
        const viewportHeight = this._scrollContainer.clientHeight;
        const marginTop = Math.max(0, viewportHeight - this._totalHeight);
        this._contentContainer.style.marginTop = `${marginTop}px`;
      }
    }
  }

  private recalculateOffsets(): void {
    let offset = 0;
    for (const turn of this._turns) {
      turn.offsetTop = offset;
      offset += turn.height;
    }
    this._totalHeight = offset;
    this.updateContentHeight();
  }

  // ============================================
  // Scroll Handling
  // ============================================

  private handleScroll(): void {
    if (this._scrollDebounceTimer) {
      clearTimeout(this._scrollDebounceTimer);
    }

    this._scrollDebounceTimer = setTimeout(() => {
      this.updateVisibility();
    }, this.config.scrollDebounce);
  }

  private handleViewportResize(): void {
    if (this._scrollContainer) {
      this._visibleRange.viewportHeight = this._scrollContainer.clientHeight;
      this.updateVisibility();
      // Recompute margin-top for bottom-push layout
      this.updateContentHeight();
    }
  }

  // ============================================
  // Subscription Handlers
  // ============================================

  private handleStreamingActive(active: boolean): void {
    if (!active && this._streamingTurnId) {
      this.endStreamingTurn();
    }
  }

  // ============================================
  // Edit Mode
  // ============================================

  setEditMode(mode: EditMode): void {
    this._editMode = mode;

    // Update all bound actors — this affects code block display (Apply/Diff buttons)
    // but NOT pending file groups (they retain their original editMode from creation time)
    for (const bound of this._boundActors.values()) {
      bound.actor.setEditMode(mode);
    }
  }

  // ============================================
  // Clear/Reset
  // ============================================

  clear(): void {
    // Release all bound actors
    for (const [turnId, bound] of this._boundActors) {
      // Trace actor unbind
      this.manager.getTracer()?.traceActorUnbind(bound.actor.actorId, turnId);
      bound.resizeObserver.disconnect();
      this.releaseActor(bound.actor);
    }
    this._boundActors.clear();

    // Clear turn data
    this._turns = [];
    this._turnMap.clear();
    this._streamingTurnId = null;
    this._totalHeight = 0;
    this._visibleRange = {
      startIndex: 0,
      endIndex: -1,
      scrollTop: 0,
      viewportHeight: this._visibleRange.viewportHeight
    };

    this.updateContentHeight();

    this.publish({
      'virtualList.turnCount': 0,
      'virtualList.visibleCount': 0,
      'virtualList.poolStats': this.getPoolStats()
    });
  }

  // ============================================
  // Statistics
  // ============================================

  getPoolStats(): PoolStats {
    return {
      totalTurns: this._turns.length,
      visibleTurns: this._boundActors.size,
      actorsInUse: this._boundActors.size,
      actorsInPool: this._pool.length,
      totalActorsCreated: this._totalActorsCreated
    };
  }

  /**
   * Log current pool statistics for debugging.
   * Call this periodically or after significant operations.
   */
  logPoolStats(): void {
    const stats = this.getPoolStats();
    log.debug('Pool stats:', {
      turns: stats.totalTurns,
      visible: stats.visibleTurns,
      pool: stats.actorsInPool,
      created: stats.totalActorsCreated
    });
  }

  /**
   * Check pool health and warn if issues detected.
   * Call this after actor creation to catch exhaustion early.
   */
  private checkPoolHealth(): void {
    const stats = this.getPoolStats();

    // Pool exhaustion: creating more actors than pool can hold
    if (stats.totalActorsCreated > this.config.maxPoolSize * 2) {
      log.warn('Potential pool exhaustion:', stats);

      // Also send to extension for persistent logging
      this._postMessage?.({
        type: 'poolWarning',
        message: 'Pool exhaustion detected',
        stats
      });
    }
  }

  getVisibleRange(): VisibleRange {
    return { ...this._visibleRange };
  }

  getTotalHeight(): number {
    return this._totalHeight;
  }

  // ============================================
  // Lifecycle
  // ============================================

  destroy(): void {
    // Clear debounce timer
    if (this._scrollDebounceTimer) {
      clearTimeout(this._scrollDebounceTimer);
    }

    // Remove scroll handler
    if (this._scrollHandler && this._scrollContainer) {
      this._scrollContainer.removeEventListener('scroll', this._scrollHandler);
    }

    // Disconnect resize observer
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
    }

    // Release all actors
    for (const bound of this._boundActors.values()) {
      bound.resizeObserver.disconnect();
      bound.actor.destroy();
    }
    this._boundActors.clear();

    // Destroy pooled actors
    for (const actor of this._pool) {
      actor.destroy();
    }
    this._pool = [];

    // Remove content container
    if (this._contentContainer) {
      this._contentContainer.remove();
    }

    super.destroy();
  }
}
