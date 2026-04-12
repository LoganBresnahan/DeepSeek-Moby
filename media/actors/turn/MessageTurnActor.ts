/**
 * MessageTurnActor
 *
 * One actor per conversation turn (user or assistant).
 * Extends InterleavedShadowActor to create multiple shadow containers
 * for different content types within the turn:
 *
 * - Text segments (can be split by tool/thinking insertions)
 * - Thinking iterations (chain-of-thought reasoning)
 * - Tool call batches
 * - Shell command executions
 * - Pending file changes
 *
 * Design Goals:
 * - Poolable by VirtualListActor for virtual rendering
 * - Full shadow DOM isolation for each content type
 * - Efficient style sharing via adoptedStyleSheets
 * - Clean reset/bind lifecycle for pool reuse
 *
 * @see InterleavedShadowActor for container management
 * @see VirtualListActor for pooling (future)
 */

import { InterleavedShadowActor, ShadowContainer } from '../../state/InterleavedShadowActor';
import { EventStateManager } from '../../state/EventStateManager';
import { turnActorStyles } from './styles';
import { createLogger } from '../../logging';
import { extractCodeBlocks, hasIncompleteFence } from '../../utils/codeBlocks';
import { highlightCode } from '../../utils/syntaxHighlight';
import type {
  TurnRole,
  TurnData,
  EditMode,
  TextSegment,
  ThinkingIteration,
  ToolBatch,
  ToolCall,
  ToolStatus,
  ShellSegment,
  ShellCommand,
  ShellCommandStatus,
  PendingFile,
  PendingFileStatus,
  PendingGroup
} from './types';

const log = createLogger('MessageTurnActor');

// ============================================
// Configuration
// ============================================

export interface MessageTurnActorConfig {
  manager: EventStateManager;
  element: HTMLElement;
  /** Callback for VS Code message posting */
  postMessage?: (message: Record<string, unknown>) => void;
  /** Callback when pending file action is triggered */
  onPendingFileAction?: (action: 'accept' | 'reject' | 'focus', fileId: string, diffId?: string, filePath?: string) => void;
  /** Callback when command approval action is triggered */
  onCommandApprovalAction?: (command: string, decision: 'allowed' | 'blocked', persistent: boolean, prefix: string, approvalId?: string) => void;
}

// ============================================
// Actor Implementation
// ============================================

export class MessageTurnActor extends InterleavedShadowActor {
  // ============================================
  // Turn Identity
  // ============================================

  private _turnId: string | null = null;
  private _role: TurnRole | null = null;
  private _timestamp: number = 0;
  private _model: string | null = null;
  private _files: string[] = [];

  // ============================================
  // Text Segment State
  // ============================================

  private _textSegments: Map<string, TextSegment> = new Map();
  private _currentTextContainerId: string | null = null;
  private _textSegmentCounter = 0;
  private _currentSegmentContent = '';
  private _lastFormattedHtml = '';

  // ============================================
  // Thinking State
  // ============================================

  private _thinkingIterations: Map<number, ThinkingIteration> = new Map();
  private _currentThinkingIteration = 0;
  private _thinkingBaseOffset = 0;
  private _lastKnownThinkingLength = 0;
  private _expandedThinking: Set<number> = new Set();

  // ============================================
  // Tool Calls State
  // ============================================

  private _toolBatches: Map<string, ToolBatch> = new Map();
  private _currentToolBatch: ToolBatch | null = null;
  private _toolCounter = 0;

  // ============================================
  // Shell State
  // ============================================

  private _shellSegments: Map<string, ShellSegment> = new Map();

  // ============================================
  // Command Approval State
  // ============================================

  private _commandApprovals: Map<string, { id: string; command: string; prefix: string; unknownSubCommand: string; status: 'pending' | 'allowed' | 'blocked'; persistent?: boolean; containerId: string }> = new Map();
  private _approvalCounter = 0;

  // ============================================
  // Pending Files State
  // ============================================

  private _pendingGroups: PendingGroup[] = [];
  private _currentPendingGroup: PendingGroup | null = null;
  private _pendingIteration = 0;

  // ============================================
  // Drawing State
  // ============================================

  private _drawingCounter = 0;

  // ============================================
  // Streaming State
  // ============================================

  private _isStreaming = false;
  private _hasInterleaved = false;

  // ============================================
  // Header State
  // ============================================

  /** Whether the role header ("MOBY" / "YOU") has been rendered */
  private _headerRendered = false;

  /** Event sequence number from backend (for fork API) */
  private _sequence: number | null = null;

  // ============================================
  // Configuration
  // ============================================

  private _editMode: EditMode = 'manual';
  private readonly _postMessage: ((message: Record<string, unknown>) => void) | null;
  private readonly _onPendingFileAction: ((action: 'accept' | 'reject' | 'focus', fileId: string, diffId?: string, filePath?: string) => void) | null;
  private readonly _onCommandApprovalAction: ((command: string, decision: 'allowed' | 'blocked', persistent: boolean, prefix: string, approvalId?: string) => void) | null;

  // ============================================
  // Constructor
  // ============================================

  constructor(config: MessageTurnActorConfig) {
    super({
      manager: config.manager,
      element: config.element,
      actorName: 'turn',
      containerStyles: turnActorStyles,
      publications: {
        'turn.id': () => this._turnId,
        'turn.role': () => this._role,
        'turn.streaming': () => this._isStreaming,
        'turn.hasInterleaved': () => this._hasInterleaved,
        'turn.textSegmentCount': () => this._textSegments.size,
        'turn.thinkingCount': () => this._thinkingIterations.size,
        'turn.toolBatchCount': () => this._toolBatches.size,
        'turn.shellSegmentCount': () => this._shellSegments.size
      },
      subscriptions: {}  // MessageTurnActor is controlled directly, not via pub/sub
    });

    this._postMessage = config.postMessage ?? null;
    this._onPendingFileAction = config.onPendingFileAction ?? null;
    this._onCommandApprovalAction = config.onCommandApprovalAction ?? null;
  }

  // ============================================
  // Pool Lifecycle
  // ============================================

  /**
   * Reset all state for pool reuse.
   * Call this before releasing back to pool.
   */
  reset(): void {
    // Clear all containers
    this.clearContainers();

    // Reset turn identity
    this._turnId = null;
    this._role = null;
    this._timestamp = 0;
    this._model = null;
    this._files = [];

    // Reset text segments
    this._textSegments.clear();
    this._currentTextContainerId = null;
    this._textSegmentCounter = 0;
    this._currentSegmentContent = '';
    this._lastFormattedHtml = '';

    // Reset thinking
    this._thinkingIterations.clear();
    this._currentThinkingIteration = 0;
    this._thinkingBaseOffset = 0;
    this._lastKnownThinkingLength = 0;
    this._expandedThinking.clear();

    // Reset tools
    this._toolBatches.clear();
    this._currentToolBatch = null;
    this._toolCounter = 0;

    // Reset shell
    this._shellSegments.clear();

    // Reset pending files
    this._pendingGroups = [];
    this._currentPendingGroup = null;
    this._pendingIteration = 0;

    // Reset command approvals
    this._commandApprovals.clear();
    this._approvalCounter = 0;

    // Reset drawing
    this._drawingCounter = 0;

    // Reset streaming state
    this._isStreaming = false;
    this._hasInterleaved = false;
    this._headerRendered = false;

    // Remove data attributes
    this.element.removeAttribute('data-turn-id');
    this.element.removeAttribute('data-role');
  }

  /**
   * Bind this actor to a new turn.
   * Call this after acquiring from pool.
   */
  bind(data: TurnData): void {
    this.reset();

    this._turnId = data.turnId;
    this._role = data.role;
    this._timestamp = data.timestamp;
    this._model = data.model ?? null;
    this._files = data.files ?? [];
    this._sequence = data.sequence ?? null;

    this.element.setAttribute('data-turn-id', data.turnId);
    this.element.setAttribute('data-role', data.role);

    this.publish({
      'turn.id': data.turnId,
      'turn.role': data.role
    });
  }

  // ============================================
  // Turn Identity Accessors
  // ============================================

  get turnId(): string | null {
    return this._turnId;
  }

  get role(): TurnRole | null {
    return this._role;
  }

  get isUser(): boolean {
    return this._role === 'user';
  }

  get isAssistant(): boolean {
    return this._role === 'assistant';
  }

  // ============================================
  // Streaming State
  // ============================================

  startStreaming(): void {
    this._isStreaming = true;
    this._hasInterleaved = false;
    this.publish({ 'turn.streaming': true });

    // Render role header immediately so the turn has visible height from the start.
    // Without this, V3 (Chat) assistant turns stay empty until the first API chunk arrives,
    // creating a visible gap. R1 doesn't have this issue because iterationStart fires
    // before the API call, triggering startThinkingIteration → ensureRoleHeader().
    // ensureRoleHeader() is idempotent (checks _headerRendered), so subsequent calls are no-ops.
    this.ensureRoleHeader();
    log.debug('startStreaming:', this._turnId, `role=${this._role}`);
  }

  endStreaming(): void {
    this._isStreaming = false;

    // Mark current text segment as complete and re-render to remove
    // the "Seeking/Developing..." animation (formatContent skips it
    // when _isStreaming is false, but the old HTML is still in the DOM)
    if (this._currentTextContainerId) {
      const container = this.getContainer(this._currentTextContainerId);
      if (container) {
        container.host.classList.remove('streaming');
        const contentEl = container.content.querySelector('.content');
        if (contentEl && this._currentSegmentContent) {
          const formatted = this.formatContent(this._currentSegmentContent);
          contentEl.innerHTML = formatted;
          this._lastFormattedHtml = formatted;
        }
      }
    }

    // Mark current thinking iteration as complete
    const thinking = this._thinkingIterations.get(this._currentThinkingIteration);
    if (thinking && !thinking.complete) {
      thinking.complete = true;
      this.renderThinkingIteration(this._currentThinkingIteration);
    }

    // Mark tool batches as complete
    if (this._currentToolBatch && !this._currentToolBatch.complete) {
      this._currentToolBatch.complete = true;
      this.renderToolBatch(this._currentToolBatch.id);
    }

    this.publish({ 'turn.streaming': false });
  }

  isStreaming(): boolean {
    return this._isStreaming;
  }

  /** Check if ANY turn is currently streaming (global state). */
  private isGlobalStreaming(): boolean {
    return !!this.manager.getState('streaming.active');
  }

  hasInterleaved(): boolean {
    return this._hasInterleaved;
  }

  /**
   * Reset diff/apply button state on all code blocks.
   * Called when the diff tab is manually closed by the user.
   */
  resetDiffState(): void {
    // Code blocks are inside shadow DOM containers — must query within each shadow root
    this.containers.forEach(container => {
      const diffedBlocks = container.content.querySelectorAll('.code-block.diffed');
      diffedBlocks.forEach(block => {
        block.classList.remove('diffed');
        const diffBtn = block.querySelector('.diff-btn');
        if (diffBtn) diffBtn.classList.remove('active');
      });
    });
  }

  /**
   * Mark a code block as applied by matching its # File: header against the file path.
   * Called when a diff is accepted from the editor toolbar or pending files dropdown.
   */
  markCodeBlockApplied(filePath: string): void {
    const fileName = filePath.split('/').pop() ?? filePath;
    this.containers.forEach(container => {
      const codeBlocks = container.content.querySelectorAll('.code-block');
      codeBlocks.forEach(block => {
        if (block.classList.contains('applied')) return;
        const codeEl = block.querySelector('code');
        if (!codeEl) return;
        const text = codeEl.textContent || '';
        // Match if the code contains a # File: header matching the file path
        if (text.includes(`# File: ${filePath}`) || text.includes(`# File: ${fileName}`)) {
          block.classList.add('applied');
          block.classList.remove('diffed');
          const applyBtn = block.querySelector('.apply-btn') as HTMLElement | null;
          if (applyBtn) applyBtn.textContent = 'Applied';
          const diffBtn = block.querySelector('.diff-btn') as HTMLElement | null;
          if (diffBtn) diffBtn.classList.remove('active');
        }
      });
    });
  }

  // ============================================
  // Text Segment Methods
  // ============================================

  /**
   * Create the first text segment for this turn.
   * For user messages, renders immediately.
   * For assistant messages, creates streaming structure.
   */
  createTextSegment(content: string = '', options?: { isContinuation?: boolean }): string {
    this._currentPendingGroup = null;
    this._textSegmentCounter++;
    const segmentId = `${this._turnId}-text-${this._textSegmentCounter}`;
    const isContinuation = options?.isContinuation ?? false;

    const hostClasses = [this._role === 'user' ? 'user' : 'assistant'];
    if (isContinuation) hostClasses.push('continuation');
    if (this._isStreaming) hostClasses.push('streaming');

    const container = this.createContainer('message', {
      hostClasses: ['text-container', ...hostClasses],
      dataAttributes: {
        'segment-id': segmentId,
        'turn-id': this._turnId ?? ''
      }
    });

    const segment: TextSegment = {
      id: segmentId,
      content,
      containerId: container.id,
      isContinuation,
      complete: !this._isStreaming
    };

    this._textSegments.set(segmentId, segment);
    this._currentTextContainerId = container.id;
    this._currentSegmentContent = content;
    this._lastFormattedHtml = '';

    this.renderTextSegment(segment, container);
    this.setupTextSegmentHandlers(container.id);

    // Hide container if created with empty content (will show when content arrives)
    if (!content.trim()) {
      container.host.setAttribute('hidden', '');
    }

    this.publish({ 'turn.textSegmentCount': this._textSegments.size });

    return segmentId;
  }

  /**
   * Update the current text segment with new content.
   * Creates segment lazily if it doesn't exist.
   */
  updateTextContent(content: string): void {
    // Lazy creation - create segment when content first arrives
    if (!this._currentTextContainerId) {
      this.createTextSegment(content);
      return;
    }

    const container = this.getContainer(this._currentTextContainerId);
    if (!container) return;

    const contentEl = container.content.querySelector('.content');
    if (contentEl) {
      const formatted = this.formatContent(content);
      // Skip DOM update if output unchanged (preserves CSS animations on placeholder)
      if (formatted !== this._lastFormattedHtml) {
        contentEl.innerHTML = formatted;
        this._lastFormattedHtml = formatted;
      }
    }

    // Hide container when content is empty (e.g., shell tags stripped),
    // show it again when content arrives
    const isEmpty = !content.trim();
    if (isEmpty) {
      container.host.setAttribute('hidden', '');
    } else {
      container.host.removeAttribute('hidden');
    }

    this._currentSegmentContent = content;

    // Update segment data
    for (const segment of this._textSegments.values()) {
      if (segment.containerId === this._currentTextContainerId) {
        segment.content = content;
        break;
      }
    }
  }

  /**
   * Get the content accumulated in the current segment.
   */
  getCurrentSegmentContent(): string {
    return this._currentSegmentContent;
  }

  // ============================================
  // Role Header
  // ============================================

  /**
   * Ensure the role header divider ("MOBY" / "YOU") is rendered.
   * Called before thinking/tool containers so the header always appears first.
   * If a text segment is created first, it renders the header itself.
   */
  private ensureRoleHeader(): void {
    if (this._headerRendered) return;

    const roleLabel = this._role === 'user' ? 'YOU' : 'MOBY';

    const container = this.createContainer('header', {
      hostClasses: ['header-container', this._role === 'user' ? 'user' : 'assistant'],
      skipAnimation: true
    });

    const forkBtn = this._sequence ? `<button class="fork-btn" data-sequence="${this._sequence}" title="Fork from here">\u{1F374}</button>` : '';
    container.content.innerHTML = `
      <div class="message ${this._role}">
        <div class="message-divider">
          <span class="message-divider-label">${roleLabel}</span>
          ${forkBtn}
        </div>
      </div>
    `;

    if (this._sequence) {
      this.setupForkHandlers(container.id);
    }

    this._headerRendered = true;
  }

  // ============================================
  // Thinking Methods
  // ============================================

  /**
   * Start a new thinking iteration.
   */
  startThinkingIteration(): number {
    this.ensureRoleHeader();
    this._currentPendingGroup = null;

    // Complete the previous thinking iteration (stops pulse animation)
    const prev = this._thinkingIterations.get(this._currentThinkingIteration);
    if (prev && !prev.complete) {
      prev.complete = true;
      this.renderThinkingIteration(this._currentThinkingIteration);
    }

    this._currentThinkingIteration++;
    this._thinkingBaseOffset = this._lastKnownThinkingLength;

    const container = this.createContainer('message', {
      hostClasses: ['thinking-container', 'streaming'],
      dataAttributes: {
        'iteration': this._currentThinkingIteration.toString(),
        'turn-id': this._turnId ?? ''
      }
    });

    const iteration: ThinkingIteration = {
      index: this._currentThinkingIteration,
      content: '',
      containerId: container.id,
      complete: false
    };

    this._thinkingIterations.set(this._currentThinkingIteration, iteration);
    this.renderThinkingIteration(this._currentThinkingIteration);
    this.setupThinkingHandlers(container.id, this._currentThinkingIteration);

    this.publish({ 'turn.thinkingCount': this._thinkingIterations.size });

    return this._currentThinkingIteration;
  }

  /**
   * Update thinking content for the current iteration.
   * In virtual mode, content is already the current iteration's content.
   * In legacy mode (via subscription), it would be the full accumulated content.
   *
   * Optimization: During streaming, only update the body text instead of
   * re-rendering the entire container. This prevents click handlers from
   * being blocked by rapid DOM replacements.
   */
  updateThinkingContent(content: string): void {
    // Track length for offset calculation (legacy compatibility)
    this._lastKnownThinkingLength = content.length;

    const iteration = this._thinkingIterations.get(this._currentThinkingIteration);
    if (!iteration) return;

    iteration.content = content;

    // During streaming, only update the body text for better performance
    // and to avoid blocking click handlers with rapid DOM replacement
    if (this._isStreaming) {
      const container = this.getContainer(iteration.containerId);
      if (container) {
        const body = container.content.querySelector('.thinking-body') as HTMLElement | null;
        const preview = container.content.querySelector('.thinking-preview');

        if (body) {
          // Check if user is at (or near) the bottom before updating
          const isAtBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 30;

          body.textContent = content;

          // Only auto-scroll if user was already following at the bottom
          if (isAtBottom) {
            body.scrollTop = body.scrollHeight;
          }
        }

        // Show the start of thinking text (CSS ellipsis handles overflow)
        if (preview) {
          preview.textContent = content.replace(/\n/g, ' ').trim();
        }
        return;
      }
    }

    // Full re-render for non-streaming updates (initial render, completion, etc.)
    this.renderThinkingIteration(this._currentThinkingIteration);
  }

  /**
   * Complete the current thinking iteration.
   */
  completeThinkingIteration(): void {
    const iteration = this._thinkingIterations.get(this._currentThinkingIteration);
    if (iteration) {
      iteration.complete = true;
      this.renderThinkingIteration(this._currentThinkingIteration);
    }
  }

  /**
   * Toggle thinking iteration expansion.
   */
  toggleThinkingExpanded(index: number): void {
    if (this._expandedThinking.has(index)) {
      this._expandedThinking.delete(index);
    } else {
      this._expandedThinking.add(index);
    }
    this.renderThinkingIteration(index);
  }

  // ============================================
  // Tool Calls Methods
  // ============================================

  /**
   * Start a new tool batch.
   */
  startToolBatch(tools: Array<{ name: string; detail: string }>): string {
    this.ensureRoleHeader();
    this._currentPendingGroup = null;
    const container = this.createContainer('message', {
      hostClasses: ['tools-container'],
      dataAttributes: { 'turn-id': this._turnId ?? '' }
    });

    const calls: ToolCall[] = tools.map(tool => ({
      id: `tool-${++this._toolCounter}`,
      name: tool.name,
      detail: tool.detail,
      status: 'running' as ToolStatus
    }));

    const batch: ToolBatch = {
      id: container.id,
      calls,
      containerId: container.id,
      expanded: false,
      complete: false
    };

    this._toolBatches.set(batch.id, batch);
    this._currentToolBatch = batch;

    this.renderToolBatch(batch.id);
    this.setupToolBatchHandlers(container.id);

    this.publish({ 'turn.toolBatchCount': this._toolBatches.size });

    return batch.id;
  }

  /**
   * Update a tool's status.
   */
  updateTool(index: number, status: ToolStatus): void {
    if (!this._currentToolBatch) return;

    const call = this._currentToolBatch.calls[index];
    if (call) {
      call.status = status;
      this.renderToolBatch(this._currentToolBatch.id);
    }
  }

  /**
   * Update multiple tools at once.
   */
  updateToolBatch(tools: Array<{ name: string; detail: string; status: ToolStatus }>): void {
    if (!this._currentToolBatch) return;

    this._currentToolBatch.calls = tools.map((tool, i) => ({
      id: this._currentToolBatch!.calls[i]?.id ?? `tool-${++this._toolCounter}`,
      name: tool.name,
      detail: tool.detail,
      status: tool.status
    }));

    this.renderToolBatch(this._currentToolBatch.id);
  }

  /**
   * Complete the current tool batch.
   */
  completeToolBatch(): void {
    if (!this._currentToolBatch) return;

    this._currentToolBatch.complete = true;
    this.renderToolBatch(this._currentToolBatch.id);
  }

  // ============================================
  // Shell Methods
  // ============================================

  /**
   * Create a shell segment.
   */
  createShellSegment(commands: Array<{ command: string; cwd?: string }>): string {
    this._currentPendingGroup = null;
    log.debug(`createShellSegment: creating with ${commands.length} commands`);

    const container = this.createContainer('message', {
      hostClasses: ['shell-container'],
      dataAttributes: { 'turn-id': this._turnId ?? '' }
    });

    log.debug(`createShellSegment: container created with id ${container.id}`);

    const shellCommands: ShellCommand[] = commands.map(cmd => ({
      command: cmd.command,
      cwd: cmd.cwd,
      status: 'pending' as ShellCommandStatus
    }));

    const segment: ShellSegment = {
      id: container.id,
      commands: shellCommands,
      containerId: container.id,
      expanded: false,
      complete: false
    };

    this._shellSegments.set(segment.id, segment);

    this.renderShellSegment(segment.id);
    this.setupShellHandlers(container.id);

    log.debug(`createShellSegment: rendered and setup handlers for ${segment.id}`);

    this.publish({ 'turn.shellSegmentCount': this._shellSegments.size });

    return segment.id;
  }

  /**
   * Start shell segment (mark as running).
   */
  startShellSegment(segmentId: string): void {
    const segment = this._shellSegments.get(segmentId);
    if (!segment) return;

    segment.commands.forEach(cmd => {
      cmd.status = 'running';
    });

    this.renderShellSegment(segmentId);
  }

  /**
   * Set shell results.
   */
  setShellResults(segmentId: string, results: Array<{ output: string; success: boolean }>): void {
    const segment = this._shellSegments.get(segmentId);
    if (!segment) return;

    results.forEach((result, i) => {
      const cmd = segment.commands[i];
      if (cmd) {
        cmd.output = result.output;
        // Detect timeout — command ran but was killed after timeout (not a real failure)
        const isTimeout = !result.success && result.output.includes('timed out after');
        cmd.success = result.success || isTimeout;
        cmd.status = result.success ? 'done' : isTimeout ? 'done' : 'error';
      }
    });

    segment.complete = true;
    this.renderShellSegment(segmentId);
  }

  // ============================================
  // Pending Files Methods
  // ============================================

  /**
   * Add a pending file.
   */
  addPendingFile(file: { filePath: string; diffId?: string; status?: PendingFileStatus; editMode?: EditMode }): string {
    // Show workspace-relative path (e.g., "src/game.ts" not just "game.ts")
    // For directories (no extension, no dots in last segment), append trailing slash
    let fileName = file.filePath;
    const lastSegment = fileName.split('/').pop() ?? '';
    if (lastSegment && !lastSegment.includes('.')) {
      fileName = fileName.endsWith('/') ? fileName : fileName + '/';
    }
    const fileId = `pending-${Date.now()}-${this._pendingIteration}`;

    this._pendingIteration++;

    const pendingFile: PendingFile = {
      id: fileId,
      filePath: file.filePath,
      fileName,
      diffId: file.diffId,
      status: file.status ?? 'pending',
      iteration: this._pendingIteration
    };

    // Use explicit editMode if provided (e.g., from VirtualListActor restore),
    // otherwise fall back to current global mode
    const groupEditMode = file.editMode ?? this._editMode;

    // Create new group if needed (no current group = after non-pending content)
    if (!this._currentPendingGroup) {
      const container = this.createContainer('message', {
        hostClasses: ['pending-container', 'expanded'],
        dataAttributes: { 'turn-id': this._turnId ?? '' }
      });
      this._currentPendingGroup = { containerId: container.id, files: new Map(), editMode: groupEditMode };
      this._pendingGroups.push(this._currentPendingGroup);
      this.setupPendingHandlers(container.id);
    }

    this._currentPendingGroup.files.set(fileId, pendingFile);
    this.renderPendingGroup(this._currentPendingGroup);

    // During streaming, move the text container to the end so the
    // "Seeking..." animation always stays below file dropdowns.
    if (this._isStreaming && this._currentTextContainerId) {
      const textContainer = this.getContainer(this._currentTextContainerId);
      if (textContainer) {
        this.element.appendChild(textContainer.host);
      }
    }

    return fileId;
  }

  /**
   * Update pending file status.
   */
  updatePendingStatus(fileId: string, status: PendingFileStatus, diffId?: string, filePath?: string): void {
    // Search across ALL pending groups for the file
    for (const group of this._pendingGroups) {
      let file = group.files.get(fileId);
      let matchedBy = file ? 'fileId' : '';
      // Fallback: VirtualListActor uses different IDs than MessageTurnActor,
      // so look up by diffId or filePath when the fileId doesn't match.
      // IMPORTANT: Prefer diffId over filePath to avoid matching the wrong group
      // when multiple groups have files with the same path (e.g., retries).
      if (!file && (diffId || filePath)) {
        for (const f of group.files.values()) {
          if (diffId) {
            if (f.diffId === diffId) {
              file = f;
              matchedBy = 'diffId';
              break;
            }
          } else if (filePath && f.filePath === filePath) {
            file = f;
            matchedBy = 'filePath';
            break;
          }
        }
      }
      if (file) {
        const oldStatus = file.status;
        file.status = status;
        if (diffId && file.diffId !== diffId) {
          log.debug(`updatePendingStatus: updating diffId ${file.diffId}→${diffId}`);
          file.diffId = diffId;
        }
        log.debug(`updatePendingStatus: ${file.filePath} ${oldStatus}→${status} (matched by ${matchedBy})`);
        this.renderPendingGroup(group);
        return;
      }
    }
    log.warn(`updatePendingStatus: file not found — fileId=${fileId} diffId=${diffId} filePath=${filePath}`);
  }

  /**
   * Set edit mode for pending files display.
   */
  setEditMode(mode: EditMode): void {
    this._editMode = mode;

    // Update existing code blocks (these reflect current mode for new actions)
    this.containers.forEach(container => {
      const codeBlocks = container.content.querySelectorAll('.code-block');
      codeBlocks.forEach(block => {
        block.setAttribute('data-edit-mode', mode);
      });
    });

    // NOTE: Pending groups are NOT re-rendered here. Each group retains its
    // original editMode (set at creation time) so switching modes doesn't
    // retroactively change how existing file changes are displayed.
  }

  // ============================================
  // Private Render Methods
  // ============================================

  private renderTextSegment(segment: TextSegment, container: ShadowContainer): void {
    const isUser = this._role === 'user';
    const roleLabel = isUser ? 'YOU' : 'MOBY';
    // Show divider unless it's a continuation or the header was already rendered
    // (e.g., by ensureRoleHeader() before a thinking iteration)
    const showDivider = !segment.isContinuation && !this._headerRendered;

    let html = `<div class="message ${this._role}${segment.isContinuation ? ' continuation' : ''}">`;

    // Divider (not for continuations, not if header already rendered)
    if (showDivider) {
      const forkBtn = this._sequence ? `<button class="fork-btn" data-sequence="${this._sequence}" title="Fork from here">\u{1F374}</button>` : '';
      html += `<div class="message-divider">`;
      html += `<span class="message-divider-label">${roleLabel}</span>`;
      html += forkBtn;
      html += `</div>`;
      this._headerRendered = true;
    }

    // Files (user messages only)
    if (isUser && this._files.length > 0) {
      html += `<div class="files">`;
      for (const file of this._files) {
        html += `<span class="file-tag">${this.escapeHtml(file)}</span>`;
      }
      html += `</div>`;
    }

    // Content
    html += `<div class="content">${this.formatContent(segment.content)}</div>`;
    html += `</div>`;

    container.content.innerHTML = html;
  }

  private renderThinkingIteration(index: number): void {
    const iteration = this._thinkingIterations.get(index);
    if (!iteration) return;

    const container = this.getContainer(iteration.containerId);
    if (!container) return;

    const isExpanded = this._expandedThinking.has(index);
    const toggle = isExpanded ? '−' : '+';
    const emoji = '💭';
    const label = this._thinkingIterations.size > 1
      ? `Thinking (${index}/${this._thinkingIterations.size})`
      : 'Thinking';

    // Preview: show start of thinking text (CSS ellipsis handles overflow)
    const previewText = iteration.content.replace(/\n/g, ' ').trim();

    container.host.classList.toggle('expanded', isExpanded);
    container.host.classList.toggle('streaming', !iteration.complete);

    container.content.innerHTML = `
      <div class="thinking-header">
        <span class="thinking-toggle">${toggle}</span>
        <span class="thinking-emoji">${emoji}</span>
        <span class="thinking-label">${label}</span>
        <span class="thinking-preview">${this.escapeHtml(previewText)}</span>
      </div>
      <div class="thinking-body scrollable">${this.escapeHtml(iteration.content)}</div>
    `;
  }

  private renderToolBatch(batchId: string): void {
    const batch = this._toolBatches.get(batchId);
    if (!batch) return;

    const container = this.getContainer(batch.containerId);
    if (!container) return;

    const toggle = batch.expanded ? '−' : '+';
    const doneCount = batch.calls.filter(c => c.status === 'done').length;
    const errorCount = batch.calls.filter(c => c.status === 'error').length;

    let title: string;
    let iconClass = 'status-running';
    if (batch.complete) {
      title = `Used ${batch.calls.length} tool${batch.calls.length > 1 ? 's' : ''}`;
      if (errorCount > 0 && doneCount > 0) {
        title += ` (${errorCount} failed)`;
        iconClass = 'status-mixed';
      } else if (errorCount > 0) {
        title += ` (${errorCount} failed)`;
        iconClass = 'status-error';
      } else {
        iconClass = 'status-success';
      }
    } else {
      title = `Using ${batch.calls.length} tool${batch.calls.length > 1 ? 's' : ''}...`;
      if (doneCount > 0) title += ` (${doneCount}/${batch.calls.length} done)`;
    }

    // Preview: first 3 tool names
    const preview = batch.calls.slice(0, 3).map(c => c.name).join(', ');
    const previewText = batch.calls.length > 3 ? preview + '...' : preview;

    container.host.classList.toggle('expanded', batch.expanded);
    container.host.classList.toggle('complete', batch.complete);
    container.host.classList.toggle('has-errors', errorCount > 0);

    let itemsHtml = '';
    batch.calls.forEach((call, i) => {
      const tree = i === batch.calls.length - 1 ? '└─' : '├─';
      const statusIcon = this.getStatusIcon(call.status);
      itemsHtml += `
        <div class="tool-item" data-status="${call.status}">
          <span class="tool-tree">${tree}</span>
          <span class="tool-status">${statusIcon}</span>
          <span class="tool-name">${this.escapeHtml(call.name)}</span>
          <span class="tool-detail">${this.escapeHtml(call.detail)}</span>
        </div>
      `;
    });

    container.content.innerHTML = `
      <div class="tools-header">
        <span class="tools-toggle">${toggle}</span>
        <span class="tools-icon status-square ${iconClass}"></span>
        <span class="tools-title">${title}</span>
        <span class="tools-preview">${this.escapeHtml(previewText)}</span>
      </div>
      <div class="tools-body">${itemsHtml}</div>
    `;
  }

  private renderShellSegment(segmentId: string): void {
    const segment = this._shellSegments.get(segmentId);
    if (!segment) return;

    const container = this.getContainer(segment.containerId);
    if (!container) return;

    const toggle = segment.expanded ? '−' : '+';
    const hasErrors = segment.commands.some(c => c.status === 'error');

    const successCount = segment.commands.filter(c => c.success === true).length;
    const failCount = segment.commands.filter(c => c.success === false && c.status !== 'running').length;

    let title: string;
    let iconClass = 'status-running';
    if (segment.complete) {
      title = `Ran ${segment.commands.length} command${segment.commands.length > 1 ? 's' : ''}`;
      if (failCount > 0 && successCount > 0) {
        iconClass = 'status-mixed';
      } else if (failCount > 0) {
        iconClass = 'status-error';
      } else {
        iconClass = 'status-success';
      }
    } else {
      const running = segment.commands.filter(c => c.status === 'running').length;
      title = running > 0 ? `Running ${running} command${running > 1 ? 's' : ''}...` : 'Shell commands';
    }

    // Preview: first command
    const preview = segment.commands[0]?.command ?? '';
    const previewText = preview.length > 40 ? preview.slice(0, 40) + '...' : preview;

    container.host.classList.toggle('expanded', segment.expanded);
    container.host.classList.toggle('complete', segment.complete);
    container.host.classList.toggle('has-errors', hasErrors);

    let itemsHtml = '';
    segment.commands.forEach((cmd, i) => {
      const tree = i === segment.commands.length - 1 ? '└─' : '├─';
      const statusIcon = this.getStatusIcon(cmd.status);
      let outputHtml = '';
      if (cmd.output) {
        // Detect timeout — command ran but was killed after timeout (not a real failure)
        const isTimeout = !cmd.success && cmd.output.includes('timed out after');
        const outputClass = cmd.success ? 'success' : isTimeout ? 'success' : 'error';
        outputHtml = `<div class="shell-output scrollable"><span class="${outputClass}">${this.escapeHtml(cmd.output)}</span></div>`;
      }

      itemsHtml += `
        <div class="shell-item" data-status="${cmd.status}">
          <div class="shell-item-row">
            <span class="shell-tree">${tree}</span>
            <span class="shell-status">${statusIcon}</span>
            <span class="shell-command">${this.escapeHtml(cmd.command)}</span>
          </div>
          ${outputHtml}
        </div>
      `;
    });

    container.content.innerHTML = `
      <div class="shell-header">
        <span class="shell-toggle">${toggle}</span>
        <span class="shell-icon status-square ${iconClass}"></span>
        <span class="shell-title">${title}</span>
        <span class="shell-preview">${this.escapeHtml(previewText)}</span>
      </div>
      <div class="shell-body">${itemsHtml}</div>
    `;
  }

  private renderPendingGroup(group: PendingGroup): void {
    const container = this.getContainer(group.containerId);
    if (!container) return;

    const files = Array.from(group.files.values());
    const pendingCount = files.filter(f => f.status === 'pending').length;
    const appliedCount = files.filter(f => f.status === 'applied').length;

    // Hide when empty
    if (files.length === 0) {
      container.host.setAttribute('hidden', '');
      return;
    }

    // Use the group's edit mode (set at creation time), not the current global mode.
    // This ensures groups retain their original display style when the user switches modes.
    const groupMode = group.editMode;

    // In manual mode, only show if there are resolved files (applied/rejected from history
    // or completed actions). Hide if all files are still pending (user manages via diff view).
    const hasResolvedFiles = files.some(f => f.status === 'applied' || f.status === 'rejected' || f.status === 'deleted' || f.status === 'expired');
    if (groupMode === 'manual' && !hasResolvedFiles) {
      container.host.setAttribute('hidden', '');
      return;
    }
    container.host.removeAttribute('hidden');

    const isAuto = groupMode === 'auto' || (groupMode === 'manual' && hasResolvedFiles);
    const title = isAuto ? 'Modified Files' : 'Pending Changes';
    const icon = isAuto ? '📂' : '📝';
    const isExpanded = container.host.classList.contains('expanded');
    const toggle = isExpanded ? '−' : '+';

    // Count label with status-specific coloring
    const rejectedCount = files.filter(f => f.status === 'rejected').length;
    const deletedCount = files.filter(f => f.status === 'deleted').length;
    const errorCount = files.filter(f => f.status === 'error').length;
    const failureCount = errorCount + rejectedCount;

    let countLabel: string;
    if (isAuto) {
      const parts: string[] = [];
      if (appliedCount > 0) parts.push(`<span class="count-applied">${appliedCount} applied</span>`);
      if (deletedCount > 0) parts.push(`<span class="count-deleted">${deletedCount} deleted</span>`);
      if (errorCount > 0) parts.push(`<span class="count-error">${errorCount} failed</span>`);
      countLabel = parts.length > 0 ? parts.join(', ') : `${files.length} file${files.length > 1 ? 's' : ''}`;
    } else if (pendingCount > 0) {
      countLabel = `${pendingCount} pending`;
    } else {
      const expiredCount = files.filter(f => f.status === 'expired').length;
      const parts: string[] = [];
      if (appliedCount > 0) parts.push(`<span class="count-applied">${appliedCount} applied</span>`);
      if (rejectedCount > 0) parts.push(`<span class="count-error">${rejectedCount} rejected</span>`);
      if (expiredCount > 0) parts.push(`<span class="count-expired">${expiredCount} expired</span>`);
      countLabel = parts.length > 0 ? parts.join(', ') : `${files.length} file${files.length > 1 ? 's' : ''}`;
    }

    container.host.classList.toggle('auto-mode', isAuto);

    // Status classes for container styling (used by tests and CSS)
    const allApplied = files.length > 0 && pendingCount === 0 && failureCount === 0;
    container.host.classList.toggle('all-applied', allApplied);
    container.host.classList.toggle('has-errors', errorCount > 0);
    container.host.classList.toggle('has-rejected', rejectedCount > 0);

    let itemsHtml = '';
    files.forEach((file, i) => {
      const tree = i === files.length - 1 ? '└─' : '├─';
      // In auto mode with applied status, show green checkmark
      const effectiveStatus = isAuto && file.status === 'applied' ? 'applied' : file.status;
      const statusIcon = this.getPendingStatusIcon(effectiveStatus);
      const statusClass = effectiveStatus;

      let actionsHtml = '';
      if (!isAuto && file.status === 'pending') {
        actionsHtml = `
          <div class="pending-actions">
            <button class="pending-btn accept-btn" data-file-id="${file.id}" data-diff-id="${file.diffId ?? ''}">Accept</button>
            <button class="pending-btn reject-btn" data-file-id="${file.id}" data-diff-id="${file.diffId ?? ''}">Reject</button>
          </div>
        `;
      } else if (file.status === 'expired') {
        actionsHtml = `<span class="pending-label expired">Expired</span>`;
      } else if (isAuto) {
        if (file.status === 'error') {
          actionsHtml = `<span class="pending-label error">Error</span>`;
        } else if (file.status === 'deleted') {
          actionsHtml = `<span class="pending-label deleted">Deleted</span>`;
        } else {
          actionsHtml = `<span class="pending-label auto-applied">Auto Applied</span>`;
        }
      }

      itemsHtml += `
        <div class="pending-item" data-status="${effectiveStatus}" data-superseded="${file.status === 'superseded'}">
          <span class="pending-tree">${tree}</span>
          <span class="pending-status ${statusClass}">${statusIcon}</span>
          <span class="pending-file" data-file-id="${file.id}" data-diff-id="${file.diffId ?? ''}" data-file-path="${file.filePath}">${this.escapeHtml(file.fileName)}</span>
          ${actionsHtml}
        </div>
      `;
    });

    container.content.innerHTML = `
      <div class="pending-header">
        <span class="pending-toggle">${toggle}</span>
        <span class="pending-icon">${icon}</span>
        <span class="pending-title">${title}</span>
        <span class="pending-count">${countLabel}</span>
      </div>
      <div class="pending-body">${itemsHtml}</div>
    `;
  }

  // ============================================
  // Event Handlers Setup
  // ============================================

  private setupTextSegmentHandlers(containerId: string): void {
    // Fork button (may be present in divider)
    if (this._sequence) {
      this.setupForkHandlers(containerId);
    }

    // Code block toggle
    this.delegateInContainer(containerId, 'click', '.code-header', (e, header) => {
      const target = e.target as HTMLElement;
      if (target.closest('.code-actions')) return;

      const codeBlock = header.closest('.code-block') as HTMLElement;
      if (codeBlock) {
        codeBlock.classList.toggle('expanded');
      }
    });

    // Copy button
    this.delegateInContainer(containerId, 'click', '.copy-btn', (e, btn) => {
      e.stopPropagation();
      const codeBlock = btn.closest('.code-block');
      const code = codeBlock?.querySelector('code')?.textContent;
      if (code) {
        navigator.clipboard.writeText(code);
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = 'Copy';
          btn.classList.remove('copied');
        }, 1500);
      }
    });

    // Diff/Apply buttons
    this.delegateInContainer(containerId, 'click', '.diff-btn', (e, btn) => {
      e.stopPropagation();
      const codeBlock = btn.closest('.code-block');
      const code = codeBlock?.querySelector('code')?.textContent;
      const lang = codeBlock?.getAttribute('data-lang') || 'text';

      if (code) {
        const isActive = btn.classList.toggle('active');
        codeBlock?.classList.toggle('diffed', isActive);

        if (isActive && this._postMessage) {
          this._postMessage({ type: 'showDiff', code, language: lang });
        }
      }
    });

    this.delegateInContainer(containerId, 'click', '.apply-btn', (e, btn) => {
      e.stopPropagation();
      if (this.isGlobalStreaming()) return;
      const codeBlock = btn.closest('.code-block');
      if (!codeBlock?.classList.contains('diffed') || codeBlock?.classList.contains('applied')) return;

      const code = codeBlock?.querySelector('code')?.textContent;
      const lang = codeBlock?.getAttribute('data-lang') || 'text';

      if (code && this._postMessage) {
        this._postMessage({ type: 'applyCode', code, language: lang });

        // Permanent applied state
        codeBlock?.classList.add('applied');
        codeBlock?.classList.remove('diffed');
        btn.textContent = 'Applied';
        const diffBtn = codeBlock?.querySelector('.diff-btn') as HTMLElement | null;
        if (diffBtn) {
          diffBtn.classList.remove('active');
        }
      }
    });
  }

  private setupThinkingHandlers(containerId: string, iterationIndex: number): void {
    this.delegateInContainer(containerId, 'click', '.thinking-header', () => {
      this.toggleThinkingExpanded(iterationIndex);
    });
  }

  private setupToolBatchHandlers(containerId: string): void {
    this.delegateInContainer(containerId, 'click', '.tools-header', () => {
      const batch = this._toolBatches.get(containerId);
      if (batch) {
        batch.expanded = !batch.expanded;
        this.renderToolBatch(containerId);
      }
    });
  }

  private setupShellHandlers(containerId: string): void {
    this.delegateInContainer(containerId, 'click', '.shell-header', () => {
      const segment = this._shellSegments.get(containerId);
      if (segment) {
        segment.expanded = !segment.expanded;
        this.renderShellSegment(containerId);
      }
    });
  }

  private setupPendingHandlers(containerId: string): void {
    // Toggle expansion
    this.delegateInContainer(containerId, 'click', '.pending-header', () => {
      const container = this.getContainer(containerId);
      if (container) {
        container.host.classList.toggle('expanded');
        const group = this._pendingGroups.find(g => g.containerId === containerId);
        if (group) this.renderPendingGroup(group);
      }
    });

    // File click - focus in editor
    this.delegateInContainer(containerId, 'click', '.pending-file', (_, el) => {
      const fileId = el.getAttribute('data-file-id');
      const diffId = el.getAttribute('data-diff-id');
      const filePath = el.getAttribute('data-file-path');
      if (fileId && this._onPendingFileAction) {
        this._onPendingFileAction('focus', fileId, diffId || undefined, filePath || undefined);
      }
    });

    // Accept button — no streaming guard: these buttons unblock the stream
    this.delegateInContainer(containerId, 'click', '.accept-btn', (e, btn) => {
      e.stopPropagation();
      const fileId = btn.getAttribute('data-file-id');
      const diffId = btn.getAttribute('data-diff-id');
      // Get filePath from the sibling .pending-file element
      const fileEntry = btn.closest('.pending-item');
      const filePath = fileEntry?.querySelector('.pending-file')?.getAttribute('data-file-path');
      if (fileId && this._onPendingFileAction) {
        this._onPendingFileAction('accept', fileId, diffId || undefined, filePath || undefined);
      }
    });

    // Reject button — no streaming guard: these buttons unblock the stream
    this.delegateInContainer(containerId, 'click', '.reject-btn', (e, btn) => {
      e.stopPropagation();
      const fileId = btn.getAttribute('data-file-id');
      const diffId = btn.getAttribute('data-diff-id');
      const fileEntry = btn.closest('.pending-item');
      const filePath = fileEntry?.querySelector('.pending-file')?.getAttribute('data-file-path');
      if (fileId && this._onPendingFileAction) {
        this._onPendingFileAction('reject', fileId, diffId || undefined, filePath || undefined);
      }
    });
  }

  // ============================================
  // Command Approval Methods
  // ============================================

  /**
   * Create an inline command approval widget.
   */
  createCommandApproval(command: string, prefix: string, unknownSubCommand: string): string {
    // Break any pending group chain
    this._currentPendingGroup = null;

    const container = this.createContainer('message', {
      hostClasses: ['approval-container'],
      dataAttributes: { 'turn-id': this._turnId ?? '' }
    });

    const approvalId = container.id;
    this._approvalCounter++;

    this._commandApprovals.set(approvalId, {
      id: approvalId,
      command,
      prefix,
      unknownSubCommand,
      status: 'pending',
      containerId: container.id,
    });

    this.renderCommandApproval(approvalId);
    this.setupApprovalHandlers(container.id);

    return approvalId;
  }

  /**
   * Resolve a command approval (update status).
   */
  resolveCommandApproval(approvalId: string, decision: 'allowed' | 'blocked', persistent?: boolean): void {
    const approval = this._commandApprovals.get(approvalId);
    if (!approval) return;

    approval.status = decision;
    if (persistent !== undefined) {
      approval.persistent = persistent;
    }
    this.renderCommandApproval(approvalId);
  }

  private renderCommandApproval(approvalId: string): void {
    const approval = this._commandApprovals.get(approvalId);
    if (!approval) return;

    const container = this.getContainer(approval.containerId);
    if (!container) return;

    const isPending = approval.status === 'pending';
    const isAllowed = approval.status === 'allowed';

    container.host.classList.toggle('resolved', !isPending);
    container.host.classList.toggle('allowed', isAllowed);
    container.host.classList.toggle('blocked', approval.status === 'blocked');

    if (isPending) {
      const commandHtml = this.highlightUnknownSubCommand(approval.command, approval.unknownSubCommand);
      container.content.innerHTML = `
        <div class="approval-header">
          <span class="approval-icon">⚡</span>
          <span class="approval-title">Command approval required</span>
        </div>
        <div class="approval-command">
          <code>$ ${commandHtml}</code>
        </div>
        <div class="approval-actions">
          <button class="approval-btn allow-once" data-approval-id="${approvalId}" data-decision="allowed" data-persistent="false">Allow Once</button>
          <button class="approval-btn always-allow" data-approval-id="${approvalId}" data-decision="allowed" data-persistent="true">Always Allow "${this.escapeHtml(approval.prefix)}"</button>
          <button class="approval-btn block-once" data-approval-id="${approvalId}" data-decision="blocked" data-persistent="false">Block Once</button>
          <button class="approval-btn always-block" data-approval-id="${approvalId}" data-decision="blocked" data-persistent="true">Always Block "${this.escapeHtml(approval.prefix)}"</button>
        </div>
      `;
    } else {
      const icon = isAllowed ? '✓' : '✗';
      let displayText: string;
      if (approval.persistent) {
        // Persistent rule — show the prefix that was saved
        const action = isAllowed ? 'Always allowed' : 'Always blocked';
        displayText = `${action}: <code>${this.escapeHtml(approval.prefix)}</code>`;
      } else {
        // One-time decision — show the full command
        const action = isAllowed ? 'Allowed' : 'Blocked';
        displayText = `${action}: <code>${this.escapeHtml(approval.command)}</code>`;
      }
      container.content.innerHTML = `
        <div class="approval-header resolved">
          <span class="approval-icon">${icon}</span>
          <span class="approval-title">${displayText}</span>
        </div>
      `;
    }
  }

  private setupApprovalHandlers(containerId: string): void {
    this.delegateInContainer(containerId, 'click', '.approval-btn', (e, btn) => {
      e.stopPropagation();
      const approvalId = btn.getAttribute('data-approval-id');
      const decision = btn.getAttribute('data-decision') as 'allowed' | 'blocked';
      const persistent = btn.getAttribute('data-persistent') === 'true';

      if (!approvalId || !decision) return;

      const approval = this._commandApprovals.get(approvalId);
      if (!approval || approval.status !== 'pending') return;

      // Update the widget immediately for instant visual feedback
      // (don't wait for the extension round-trip)
      this.resolveCommandApproval(approvalId, decision, persistent);

      if (this._onCommandApprovalAction) {
        this._onCommandApprovalAction(approval.command, decision, persistent, approval.prefix, approvalId);
      }
    });
  }

  // ============================================
  // Drawing Methods
  // ============================================

  /**
   * Create a drawing segment displaying a phone drawing image.
   */
  createDrawingSegment(imageDataUrl: string): string {
    this._currentPendingGroup = null;
    this._drawingCounter++;
    const segmentId = `${this._turnId}-drawing-${this._drawingCounter}`;

    this.ensureRoleHeader();

    const container = this.createContainer('message', {
      hostClasses: ['drawing-container', 'user'],
      dataAttributes: {
        'segment-id': segmentId,
        'turn-id': this._turnId ?? ''
      }
    });

    container.content.innerHTML = `
      <div class="drawing-wrapper">
        <img
          src="${imageDataUrl}"
          alt="Phone drawing"
          class="drawing-image"
        />
      </div>
    `;

    // Right-click → save drawing
    const img = container.content.querySelector('.drawing-image') as HTMLImageElement;
    if (img) {
      img.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showDrawingContextMenu(container.content, e, imageDataUrl);
      });
    }

    return segmentId;
  }

  private showDrawingContextMenu(root: HTMLElement, e: MouseEvent, imageDataUrl: string): void {
    // Remove any existing context menu
    root.querySelector('.drawing-context-menu')?.remove();

    const menu = document.createElement('div');
    menu.className = 'drawing-context-menu';

    const saveItem = document.createElement('div');
    saveItem.className = 'drawing-context-menu-item';
    saveItem.textContent = 'Save Drawing As...';
    menu.appendChild(saveItem);

    // Position relative to wrapper
    const wrapper = root.querySelector('.drawing-wrapper') as HTMLElement;
    const rect = wrapper.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    menu.style.left = `${e.clientX - rootRect.left}px`;
    menu.style.top = `${e.clientY - rootRect.top}px`;

    wrapper.appendChild(menu);

    saveItem.addEventListener('click', () => {
      menu.remove();
      if (this._postMessage) {
        this._postMessage({ type: 'saveDrawing', imageDataUrl });
      }
    });

    // Close on click outside or escape
    const close = () => {
      menu.remove();
      document.removeEventListener('click', close, true);
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') close();
    };
    setTimeout(() => {
      document.addEventListener('click', close, true);
      document.addEventListener('keydown', onKey);
    }, 0);
  }

  // ============================================
  // Utility Methods
  // ============================================

  /**
   * Render the full command with the unknown sub-command highlighted.
   * If unknownSubCommand equals the full command (simple, non-compound),
   * just escape and return as-is. Otherwise wrap the unknown portion
   * in a <span class="unknown-subcmd"> highlight.
   */
  private highlightUnknownSubCommand(command: string, unknownSubCommand: string): string {
    if (!unknownSubCommand || unknownSubCommand === command) {
      return this.escapeHtml(command);
    }

    const idx = command.indexOf(unknownSubCommand);
    if (idx === -1) {
      return this.escapeHtml(command);
    }

    const before = command.substring(0, idx);
    const match = command.substring(idx, idx + unknownSubCommand.length);
    const after = command.substring(idx + unknownSubCommand.length);

    return `${this.escapeHtml(before)}<span class="unknown-subcmd">${this.escapeHtml(match)}</span>${this.escapeHtml(after)}`;
  }

  private getStatusIcon(status: ToolStatus | ShellCommandStatus): string {
    switch (status) {
      case 'pending': return '○';
      case 'running': return '⏳';
      case 'done': return '✓';
      case 'error': return '✗';
      default: return '○';
    }
  }

  private getPendingStatusIcon(status: PendingFileStatus): string {
    switch (status) {
      case 'pending': return '●';
      case 'applied': return '✓';
      case 'rejected': return '✗';
      case 'superseded': return '⊘';
      case 'deleted': return '🗑️';
      case 'expired': return '○';
      case 'error': return '✗';
      default: return '●';
    }
  }

  private formatContent(content: string): string {
    if (!content) return '';

    const startExpanded = this._editMode === 'manual' || this._role === 'user';

    // Fenced code blocks (complete only) — fence-length-aware (CommonMark spec)
    const blocks = extractCodeBlocks(content);
    let result = content;

    // Replace from last to first to preserve string indices
    for (let bi = blocks.length - 1; bi >= 0; bi--) {
      const block = blocks[bi];
      let language = block.language || 'text';
      const code = block.content;

      // Infer language from # File: header when fence language is generic (bash, text, plaintext)
      if (['bash', 'text', 'plaintext', 'sh'].includes(language.toLowerCase())) {
        const fileMatch = code.match(/^#\s*File:\s*(\S+)/m);
        if (fileMatch) {
          const ext = fileMatch[1].split('.').pop()?.toLowerCase();
          const extMap: Record<string, string> = {
            ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
            json: 'json', md: 'markdown', py: 'python', rs: 'rust', go: 'go',
            java: 'java', rb: 'ruby', css: 'css', html: 'html', yml: 'yaml', yaml: 'yaml',
            sh: 'bash', xml: 'xml', sql: 'sql', c: 'c', cpp: 'cpp', cs: 'csharp',
            swift: 'swift', kt: 'kotlin', php: 'php', r: 'r', toml: 'toml'
          };
          if (ext && extMap[ext]) {
            language = extMap[ext];
          }
        }
      }
      const highlightedCode = highlightCode(code.trimEnd(), language);
      const expandedClass = startExpanded ? ' expanded' : '';

      const firstLine = code.trim().split('\n')[0] || '';
      const preview = firstLine.length > 60 ? firstLine.substring(0, 60) + '...' : firstLine;
      const escapedPreview = this.escapeHtml(preview);

      const html = `<div class="code-block entering${expandedClass}" data-lang="${language}" data-edit-mode="${this._editMode}"><div class="code-header"><span class="code-toggle">▶</span><span class="code-lang">${language}</span><span class="code-preview">${escapedPreview}</span><div class="code-actions"><button class="code-action-btn diff-btn">Diff</button><button class="code-action-btn apply-btn">Apply</button><button class="code-action-btn copy-btn">Copy</button></div></div><div class="code-body"><pre><code class="language-${language}">${highlightedCode}</code></pre></div></div>`;
      result = result.substring(0, block.startIndex) + html + result.substring(block.endIndex);
    }

    // During streaming, hide incomplete code blocks and show animated placeholder
    if (this._isStreaming) {
      result = result.replace(/```\w*(?:\n[\s\S]*)?$/, (match) => {
        // Try to extract filename from # File: header (SEARCH/REPLACE edits)
        const fileMatch = match.match(/^```\w*\n#\s*File:\s*(\S+)/);
        if (fileMatch) {
          return this.buildCodeGeneratingHtml(`Writing ${fileMatch[1]}...`);
        }
        // Try to extract filename from heredoc pattern (cat > file << 'EOF')
        const heredocMatch = match.match(/cat\s+>+\s+(\S+)\s+<</);
        if (heredocMatch) {
          // Extract just the filename from the full path
          const fullPath = heredocMatch[1];
          const fileName = fullPath.split('/').pop() || fullPath;
          return this.buildCodeGeneratingHtml(`Creating ${fileName}...`);
        }
        return this._codeGeneratingHtml;
      });
    }

    // Inline code
    result = result.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');

    // Bold
    result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italic
    result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Line breaks (collapse 3+ consecutive newlines to 2)
    result = result.replace(/\n{3,}/g, '\n\n');
    result = result.replace(/\n/g, '<br>');

    // Remove <br> tags after code blocks (prevents extra whitespace between code and text)
    result = result.replace(/<\/div>(<br>)+/g, '</div>');
    // Remove trailing <br> tags
    result = result.replace(/(<br>)+$/, '');

    return result;
  }

  /** Pre-built HTML for the code-generating placeholder (static, cached once) */
  // ============================================
  // Fork Methods
  // ============================================

  /**
   * Update the event sequence number (called after live turn save).
   * Injects fork button into the rendered divider if not already present.
   */
  updateSequence(sequence: number): void {
    this._sequence = sequence;
    // Find the rendered divider, inject button if missing
    // containers is a Map<string, ShadowContainer> — iterate values
    for (const [containerId, container] of this.containers) {
      const divider = container.content.querySelector('.message-divider');
      if (divider && !divider.querySelector('.fork-btn')) {
        const btn = document.createElement('button');
        btn.className = 'fork-btn';
        btn.dataset.sequence = String(sequence);
        btn.title = 'Fork from here';
        btn.textContent = '\u{1F374}';
        divider.appendChild(btn);
        this.setupForkHandlers(containerId);
        break;
      }
    }
  }

  private setupForkHandlers(containerId: string): void {
    this.delegateInContainer(containerId, 'click', '.fork-btn', (e, btn) => {
      e.stopPropagation();
      if (this.isGlobalStreaming()) return;
      const seq = parseInt(btn.getAttribute('data-sequence') || '0', 10);
      if (seq > 0) this.showForkPopup(btn as HTMLElement, seq);
    });
  }

  private showForkPopup(anchor: HTMLElement, sequence: number): void {
    // Remove existing popup
    document.querySelector('.fork-popup')?.remove();

    const popup = document.createElement('div');
    popup.className = 'fork-popup';
    popup.innerHTML = `<div class="fork-popup-item"><span class="fork-popup-icon">\u{1F374}</span> Fork here</div>`;

    // Position below the button
    const rect = anchor.getBoundingClientRect();
    popup.style.position = 'fixed';
    popup.style.top = `${rect.bottom + 4}px`;
    popup.style.left = `${rect.left}px`;
    document.body.appendChild(popup);

    // "Fork here" click
    popup.querySelector('.fork-popup-item')!.addEventListener('click', () => {
      popup.remove();
      if (this._postMessage) {
        this._postMessage({ type: 'forkSession', atSequence: sequence });
      }
    });

    // Close on outside click / Escape
    const close = () => {
      popup.remove();
      document.removeEventListener('click', close, true);
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') close();
    };
    setTimeout(() => {
      document.addEventListener('click', close, true);
      document.addEventListener('keydown', onKey);
    }, 0);
  }

  /** Build the code-generating placeholder HTML, optionally with a specific filename */
  private buildCodeGeneratingHtml(text?: string): string {
    const mobyIconUrl = document.body.dataset.mobyIcon || '';
    const mobyHtml = mobyIconUrl
      ? `<div class="code-gen-moby"><img src="${mobyIconUrl}" alt="Moby"><div class="code-gen-spurt">${'<span class="drop"></span>'.repeat(5)}</div></div>`
      : '';
    if (text) {
      // Single phrase with wave animation
      const chars = text.split('').map((ch, ci) =>
        `<span class="gc" style="--d:${ci}">${ch === ' ' ? '&nbsp;' : this.escapeHtml(ch)}</span>`
      ).join('');
      return `<div class="code-generating">${mobyHtml}<div class="code-gen-phrases"><span class="gen-phrase gp-1" style="opacity:1">${chars}</span></div></div>`;
    }
    // Default cycling phrases
    const phrases = ['Developing...', 'Diving...', 'Seeking...'];
    const phraseHtml = phrases.map((phrase, i) => {
      const chars = phrase.split('').map((ch, ci) =>
        `<span class="gc" style="--d:${ci}">${ch}</span>`
      ).join('');
      return `<span class="gen-phrase gp-${i + 1}">${chars}</span>`;
    }).join('');
    return `<div class="code-generating">${mobyHtml}<div class="code-gen-phrases">${phraseHtml}</div></div>`;
  }

  /** Pre-built default placeholder (cached for performance) */
  private readonly _codeGeneratingHtml = this.buildCodeGeneratingHtml();

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ============================================
  // Lifecycle
  // ============================================

  destroy(): void {
    this.reset();
    super.destroy();
  }
}
