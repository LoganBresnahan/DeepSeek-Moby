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
  PendingFileStatus
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
  private _segmentsPaused = false;

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
  // Pending Files State
  // ============================================

  private _pendingContainerId: string | null = null;
  private _pendingFiles: Map<string, PendingFile> = new Map();
  private _pendingIteration = 0;

  // ============================================
  // Streaming State
  // ============================================

  private _isStreaming = false;
  private _hasInterleaved = false;

  // ============================================
  // Configuration
  // ============================================

  private _editMode: EditMode = 'manual';
  private readonly _postMessage: ((message: Record<string, unknown>) => void) | null;
  private readonly _onPendingFileAction: ((action: 'accept' | 'reject' | 'focus', fileId: string, diffId?: string, filePath?: string) => void) | null;

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
    this._segmentsPaused = false;

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
    this._pendingContainerId = null;
    this._pendingFiles.clear();
    this._pendingIteration = 0;

    // Reset streaming state
    this._isStreaming = false;
    this._hasInterleaved = false;

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
  }

  endStreaming(): void {
    this._isStreaming = false;

    // Mark current text segment as complete
    if (this._currentTextContainerId) {
      const container = this.getContainer(this._currentTextContainerId);
      if (container) {
        container.host.classList.remove('streaming');
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

  hasInterleaved(): boolean {
    return this._hasInterleaved;
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
    this._segmentsPaused = false;

    this.renderTextSegment(segment, container);
    this.setupTextSegmentHandlers(container.id);

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
      contentEl.innerHTML = this.formatContent(content);
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

  /**
   * Finalize the current segment before tool/thinking content.
   * Returns true if a segment was finalized.
   */
  finalizeCurrentSegment(): boolean {
    if (!this._currentTextContainerId) {
      return false;
    }

    const container = this.getContainer(this._currentTextContainerId);
    if (container) {
      container.host.classList.remove('streaming');
    }

    this._currentTextContainerId = null;
    this._segmentsPaused = true;
    this._hasInterleaved = true;

    this.publish({ 'turn.hasInterleaved': true });

    return true;
  }

  /**
   * Check if we need a new segment after interleaving.
   */
  needsNewSegment(): boolean {
    return this._segmentsPaused && this._isStreaming;
  }

  /**
   * Resume with a new continuation segment after tool/thinking content.
   */
  resumeWithNewSegment(): void {
    if (!this._segmentsPaused) return;

    this.createTextSegment('', { isContinuation: true });
  }

  // ============================================
  // Thinking Methods
  // ============================================

  /**
   * Start a new thinking iteration.
   */
  startThinkingIteration(): number {
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
        const body = container.content.querySelector('.thinking-body');
        const preview = container.content.querySelector('.thinking-preview');

        if (body) {
          body.textContent = content;
        }

        // Update preview text too
        if (preview) {
          const previewText = content.slice(0, 50).replace(/\n/g, ' ');
          preview.textContent = previewText + (content.length > 50 ? '...' : '');
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
        cmd.success = result.success;
        cmd.status = result.success ? 'done' : 'error';
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
  addPendingFile(file: { filePath: string; diffId?: string; status?: PendingFileStatus }): string {
    const fileName = file.filePath.split('/').pop() ?? file.filePath;
    const fileId = `pending-${Date.now()}-${this._pendingFiles.size}`;

    this._pendingIteration++;

    const pendingFile: PendingFile = {
      id: fileId,
      filePath: file.filePath,
      fileName,
      diffId: file.diffId,
      status: file.status ?? 'pending',
      iteration: this._pendingIteration
    };

    this._pendingFiles.set(fileId, pendingFile);

    // Ensure pending container exists
    if (!this._pendingContainerId) {
      const container = this.createContainer('message', {
        hostClasses: ['pending-container', 'expanded'],
        dataAttributes: { 'turn-id': this._turnId ?? '' }
      });
      this._pendingContainerId = container.id;
      this.setupPendingHandlers(container.id);
    }

    this.renderPendingFiles();

    return fileId;
  }

  /**
   * Update pending file status.
   */
  updatePendingStatus(fileId: string, status: PendingFileStatus, diffId?: string, filePath?: string): void {
    let file = this._pendingFiles.get(fileId);
    // Fallback: VirtualListActor uses different IDs than MessageTurnActor,
    // so look up by diffId or filePath when the fileId doesn't match.
    if (!file && (diffId || filePath)) {
      for (const f of this._pendingFiles.values()) {
        if ((diffId && f.diffId === diffId) || (filePath && f.filePath === filePath)) {
          file = f;
          break;
        }
      }
    }
    if (file) {
      file.status = status;
      this.renderPendingFiles();
    }
  }

  /**
   * Set edit mode for pending files display.
   */
  setEditMode(mode: EditMode): void {
    this._editMode = mode;

    // Update existing code blocks
    this.containers.forEach(container => {
      const codeBlocks = container.content.querySelectorAll('.code-block');
      codeBlocks.forEach(block => {
        block.setAttribute('data-edit-mode', mode);
      });
    });

    // Update pending files display
    this.renderPendingFiles();
  }

  // ============================================
  // Private Render Methods
  // ============================================

  private renderTextSegment(segment: TextSegment, container: ShadowContainer): void {
    const isUser = this._role === 'user';
    const roleLabel = isUser ? 'YOU' : 'DEEPSEEK MOBY';

    let html = `<div class="message ${this._role}${segment.isContinuation ? ' continuation' : ''}">`;

    // Divider (not for continuations)
    if (!segment.isContinuation) {
      html += `<div class="message-divider">`;
      html += `<span class="message-divider-label">${roleLabel}</span>`;
      html += `</div>`;
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

    // Preview: first 50 chars
    const preview = iteration.content.slice(0, 50).replace(/\n/g, ' ');
    const previewText = preview + (iteration.content.length > 50 ? '...' : '');

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
    const icon = '🔧';
    const doneCount = batch.calls.filter(c => c.status === 'done').length;
    const errorCount = batch.calls.filter(c => c.status === 'error').length;

    let title: string;
    if (batch.complete) {
      title = `Used ${batch.calls.length} tool${batch.calls.length > 1 ? 's' : ''}`;
      if (errorCount > 0) title += ` (${errorCount} failed)`;
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
      const spinning = call.status === 'running' ? ' spinning' : '';

      itemsHtml += `
        <div class="tool-item" data-status="${call.status}">
          <span class="tool-tree">${tree}</span>
          <span class="tool-status${spinning}">${statusIcon}</span>
          <span class="tool-name">${this.escapeHtml(call.name)}</span>
          <span class="tool-detail">${this.escapeHtml(call.detail)}</span>
        </div>
      `;
    });

    container.content.innerHTML = `
      <div class="tools-header">
        <span class="tools-toggle">${toggle}</span>
        <span class="tools-icon">${icon}</span>
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
    const icon = '$';
    const hasErrors = segment.commands.some(c => c.status === 'error');

    let title: string;
    if (segment.complete) {
      title = `Ran ${segment.commands.length} command${segment.commands.length > 1 ? 's' : ''}`;
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
      const spinning = cmd.status === 'running' ? ' spinning' : '';

      let outputHtml = '';
      if (cmd.output) {
        const outputClass = cmd.success ? 'success' : 'error';
        outputHtml = `<div class="shell-output scrollable"><span class="${outputClass}">${this.escapeHtml(cmd.output)}</span></div>`;
      }

      itemsHtml += `
        <div class="shell-item" data-status="${cmd.status}">
          <div class="shell-item-row">
            <span class="shell-tree">${tree}</span>
            <span class="shell-status${spinning}">${statusIcon}</span>
            <span class="shell-command">${this.escapeHtml(cmd.command)}</span>
          </div>
          ${outputHtml}
        </div>
      `;
    });

    container.content.innerHTML = `
      <div class="shell-header">
        <span class="shell-toggle">${toggle}</span>
        <span class="shell-icon">${icon}</span>
        <span class="shell-title">${title}</span>
        <span class="shell-preview">${this.escapeHtml(previewText)}</span>
      </div>
      <div class="shell-body">${itemsHtml}</div>
    `;
  }

  private renderPendingFiles(): void {
    if (!this._pendingContainerId) return;

    const container = this.getContainer(this._pendingContainerId);
    if (!container) return;

    const files = Array.from(this._pendingFiles.values());
    const pendingCount = files.filter(f => f.status === 'pending').length;
    const appliedCount = files.filter(f => f.status === 'applied').length;

    // Hide when empty
    if (files.length === 0) {
      container.host.setAttribute('hidden', '');
      return;
    }

    // In manual mode, only show if there are resolved files (applied/rejected from history
    // or completed actions). Hide if all files are still pending (user manages via diff view).
    const hasResolvedFiles = files.some(f => f.status === 'applied' || f.status === 'rejected');
    if (this._editMode === 'manual' && !hasResolvedFiles) {
      container.host.setAttribute('hidden', '');
      return;
    }
    container.host.removeAttribute('hidden');

    const isAuto = this._editMode === 'auto' || (this._editMode === 'manual' && hasResolvedFiles);
    const title = isAuto ? 'Modified Files' : 'Pending Changes';
    const icon = isAuto ? '✓' : '📝';
    const isExpanded = container.host.classList.contains('expanded');
    const toggle = isExpanded ? '−' : '+';

    // Count label: show appropriate status based on mode
    const rejectedCount = files.filter(f => f.status === 'rejected').length;
    let countLabel: string;
    if (isAuto) {
      countLabel = appliedCount > 0 ? `${appliedCount} applied` : `${files.length} file${files.length > 1 ? 's' : ''}`;
    } else if (pendingCount > 0) {
      countLabel = `${pendingCount} pending`;
    } else if (appliedCount > 0 && rejectedCount > 0) {
      countLabel = `${appliedCount} applied, ${rejectedCount} rejected`;
    } else if (appliedCount > 0) {
      countLabel = `${appliedCount} applied`;
    } else if (rejectedCount > 0) {
      countLabel = `${rejectedCount} rejected`;
    } else {
      countLabel = `${files.length} file${files.length > 1 ? 's' : ''}`;
    }

    container.host.classList.toggle('auto-mode', isAuto);

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
      } else if (isAuto) {
        if (file.status === 'error') {
          actionsHtml = `<span class="pending-label error">Error</span>`;
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
      const codeBlock = btn.closest('.code-block');
      if (!codeBlock?.classList.contains('diffed')) return;

      const code = codeBlock?.querySelector('code')?.textContent;
      const lang = codeBlock?.getAttribute('data-lang') || 'text';

      if (code && this._postMessage) {
        this._postMessage({ type: 'applyCode', code, language: lang });

        btn.textContent = 'Applied!';
        setTimeout(() => {
          btn.textContent = 'Apply';
          codeBlock?.classList.remove('diffed');
          const diffBtn = codeBlock?.querySelector('.diff-btn');
          diffBtn?.classList.remove('active');
        }, 1500);
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
        this.renderPendingFiles();
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

    // Accept button
    this.delegateInContainer(containerId, 'click', '.accept-btn', (e, btn) => {
      e.stopPropagation();
      const fileId = btn.getAttribute('data-file-id');
      const diffId = btn.getAttribute('data-diff-id');
      if (fileId && this._onPendingFileAction) {
        this._onPendingFileAction('accept', fileId, diffId || undefined);
      }
    });

    // Reject button
    this.delegateInContainer(containerId, 'click', '.reject-btn', (e, btn) => {
      e.stopPropagation();
      const fileId = btn.getAttribute('data-file-id');
      const diffId = btn.getAttribute('data-diff-id');
      if (fileId && this._onPendingFileAction) {
        this._onPendingFileAction('reject', fileId, diffId || undefined);
      }
    });
  }

  // ============================================
  // Utility Methods
  // ============================================

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
      case 'error': return '✗';
      default: return '●';
    }
  }

  private formatContent(content: string): string {
    if (!content) return '';

    const startExpanded = this._editMode === 'manual';

    // Fenced code blocks
    let result = content.replace(
      /```(\w*)\n([\s\S]*?)```/g,
      (_, lang, code) => {
        const language = lang || 'text';
        const escapedCode = this.escapeHtml(code.trimEnd()).replace(/\n/g, '&#10;');
        const expandedClass = startExpanded ? ' expanded' : '';

        const firstLine = code.trim().split('\n')[0] || '';
        const preview = firstLine.length > 60 ? firstLine.substring(0, 60) + '...' : firstLine;
        const escapedPreview = this.escapeHtml(preview);

        return `<div class="code-block entering${expandedClass}" data-lang="${language}" data-edit-mode="${this._editMode}"><div class="code-header"><span class="code-toggle">▶</span><span class="code-lang">${language}</span><span class="code-preview">${escapedPreview}</span><div class="code-actions"><button class="code-action-btn diff-btn">Diff</button><button class="code-action-btn apply-btn">Apply</button><button class="code-action-btn copy-btn">Copy</button></div></div><div class="code-body"><pre><code class="language-${language}">${escapedCode}</code></pre></div></div>`;
      }
    );

    // Inline code
    result = result.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');

    // Bold
    result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italic
    result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Line breaks
    result = result.replace(/\n/g, '<br>');

    return result;
  }

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
