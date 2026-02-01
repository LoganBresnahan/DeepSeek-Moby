/**
 * ToolCallsShadowActor
 *
 * Shadow DOM version of ToolCallsActor.
 * Manages tool calls display during streaming responses.
 * Shows collapsible dropdown with tool execution status.
 *
 * Each batch of tool calls gets its own Shadow DOM for complete style isolation.
 * No z-index coordination needed, no class name prefixes required.
 *
 * Publications:
 * - tools.calls: ToolCall[] - current batch's tool calls
 * - tools.activeCount: number - count of running tools in current batch
 * - tools.expanded: boolean - whether current batch dropdown is expanded
 *
 * Subscriptions:
 * - streaming.active: boolean - track streaming state
 */

import { InterleavedShadowActor } from '../../state/InterleavedShadowActor';
import { EventStateManager } from '../../state/EventStateManager';
import { toolsShadowStyles } from './shadowStyles';

export interface ToolCall {
  id: string;
  name: string;
  detail: string;
  status: 'pending' | 'running' | 'done' | 'error';
}

export interface ToolBatch {
  id: string;
  calls: ToolCall[];
  expanded: boolean;
  complete: boolean;
  containerId: string;
}

export interface ToolCallsState {
  calls: ToolCall[];
  activeCount: number;
  expanded: boolean;
}

export class ToolCallsShadowActor extends InterleavedShadowActor {
  // Track all batches (each has its own shadow container)
  private _batches: ToolBatch[] = [];

  // Current active batch (null when no active batch)
  private _currentBatch: ToolBatch | null = null;

  // Counter for tool IDs within batches
  private _toolIdCounter = 0;

  constructor(manager: EventStateManager, element: HTMLElement) {
    super({
      manager,
      element,
      actorName: 'tools',
      containerStyles: toolsShadowStyles,
      publications: {
        'tools.calls': () => this._currentBatch ? [...this._currentBatch.calls] : [],
        'tools.activeCount': () => this.getActiveCount(),
        'tools.expanded': () => this._currentBatch?.expanded ?? false
      },
      subscriptions: {
        'streaming.active': (value: unknown) => this.handleStreamingActive(value as boolean)
      }
    });
  }

  // ============================================
  // Subscription Handlers
  // ============================================

  private handleStreamingActive(active: boolean): void {
    if (!active && this._currentBatch && !this._currentBatch.complete) {
      // Mark current batch as complete when streaming ends
      this.complete();
    }
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Start a new batch of tool calls.
   * Creates a new shadow-encapsulated container.
   */
  startBatch(tools: Array<{ name: string; detail: string }>): void {
    // Create shadow-encapsulated container
    const container = this.createContainer('tools');

    // Create the batch
    const batch: ToolBatch = {
      id: container.id,
      calls: tools.map((tool) => ({
        id: `tool-${++this._toolIdCounter}`,
        name: tool.name,
        detail: tool.detail,
        status: 'running' as const
      })),
      expanded: false,
      complete: false,
      containerId: container.id
    };

    this._batches.push(batch);
    this._currentBatch = batch;

    this.renderBatch(batch);
    this.publish({
      'tools.calls': [...batch.calls],
      'tools.activeCount': this.getActiveCount()
    });
  }

  /**
   * Update tool calls in the current batch
   */
  updateBatch(tools: Array<{ name: string; detail: string; status?: 'pending' | 'running' | 'done' | 'error' }>): void {
    if (!this._currentBatch) return;

    // Update existing or add new tools
    tools.forEach((tool, index) => {
      if (this._currentBatch!.calls[index]) {
        this._currentBatch!.calls[index].name = tool.name;
        this._currentBatch!.calls[index].detail = tool.detail;
        if (tool.status) {
          this._currentBatch!.calls[index].status = tool.status;
        }
      } else {
        this._currentBatch!.calls.push({
          id: `tool-${++this._toolIdCounter}`,
          name: tool.name,
          detail: tool.detail,
          status: tool.status || 'running'
        });
      }
    });

    this.renderBatch(this._currentBatch);
    this.publish({
      'tools.calls': [...this._currentBatch.calls],
      'tools.activeCount': this.getActiveCount()
    });
  }

  /**
   * Add a single tool call to the current batch (or create a new batch if none active)
   */
  addTool(name: string, detail: string): string {
    // If no current batch or current batch is complete, start a new one
    if (!this._currentBatch || this._currentBatch.complete) {
      this.startBatch([{ name, detail }]);
      return this._currentBatch!.calls[0].id;
    }

    const id = `tool-${++this._toolIdCounter}`;
    this._currentBatch.calls.push({
      id,
      name,
      detail,
      status: 'running'
    });

    this.renderBatch(this._currentBatch);
    this.publish({
      'tools.calls': [...this._currentBatch.calls],
      'tools.activeCount': this.getActiveCount()
    });

    return id;
  }

  /**
   * Update a specific tool's status
   */
  updateTool(id: string, update: Partial<Omit<ToolCall, 'id'>>): void {
    // Find the tool across all batches
    for (const batch of this._batches) {
      const tool = batch.calls.find(t => t.id === id);
      if (tool) {
        Object.assign(tool, update);
        this.renderBatch(batch);
        if (batch === this._currentBatch) {
          this.publish({
            'tools.calls': [...batch.calls],
            'tools.activeCount': this.getActiveCount()
          });
        }
        return;
      }
    }
  }

  /**
   * Mark a tool as complete
   */
  completeTool(id: string, success: boolean = true): void {
    this.updateTool(id, { status: success ? 'done' : 'error' });
  }

  /**
   * Mark current batch as complete
   */
  complete(): void {
    if (!this._currentBatch) return;

    this._currentBatch.complete = true;
    this._currentBatch.calls.forEach(tool => {
      if (tool.status === 'pending' || tool.status === 'running') {
        tool.status = 'done';
      }
    });

    this.renderBatch(this._currentBatch);
    this.publish({
      'tools.calls': [...this._currentBatch.calls],
      'tools.activeCount': 0
    });

    // Clear current batch reference (next startBatch will create new one)
    this._currentBatch = null;
  }

  /**
   * Toggle expanded state of current batch
   */
  toggleExpanded(): void {
    if (!this._currentBatch) return;

    this._currentBatch.expanded = !this._currentBatch.expanded;
    this.renderBatch(this._currentBatch);
    this.publish({ 'tools.expanded': this._currentBatch.expanded });
  }

  /**
   * Toggle expanded state of a specific batch by ID
   */
  toggleBatchExpanded(batchId: string): void {
    const batch = this._batches.find(b => b.id === batchId);
    if (!batch) return;

    batch.expanded = !batch.expanded;
    this.renderBatch(batch);

    if (batch === this._currentBatch) {
      this.publish({ 'tools.expanded': batch.expanded });
    }
  }

  /**
   * Expand current batch dropdown
   */
  expand(): void {
    if (!this._currentBatch || this._currentBatch.expanded) return;

    this._currentBatch.expanded = true;
    this.renderBatch(this._currentBatch);
    this.publish({ 'tools.expanded': true });
  }

  /**
   * Collapse current batch dropdown
   */
  collapse(): void {
    if (!this._currentBatch || !this._currentBatch.expanded) return;

    this._currentBatch.expanded = false;
    this.renderBatch(this._currentBatch);
    this.publish({ 'tools.expanded': false });
  }

  /**
   * Clear all batches and their DOM elements
   */
  clear(): void {
    this.clearContainers();

    this._batches = [];
    this._currentBatch = null;

    this.publish({
      'tools.calls': [],
      'tools.activeCount': 0,
      'tools.expanded': false
    });
  }

  /**
   * Get current batch state
   */
  getState(): ToolCallsState {
    return {
      calls: this._currentBatch ? [...this._currentBatch.calls] : [],
      activeCount: this.getActiveCount(),
      expanded: this._currentBatch?.expanded ?? false
    };
  }

  /**
   * Get current batch's tool calls
   */
  getCalls(): ToolCall[] {
    return this._currentBatch ? [...this._currentBatch.calls] : [];
  }

  /**
   * Get all batches
   */
  getBatches(): ToolBatch[] {
    return [...this._batches];
  }

  /**
   * Get active (running) tool count in current batch
   */
  getActiveCount(): number {
    if (!this._currentBatch) return 0;
    return this._currentBatch.calls.filter(t => t.status === 'running').length;
  }

  /**
   * Check if current batch has errors
   */
  hasErrors(): boolean {
    return this._currentBatch?.calls.some(t => t.status === 'error') ?? false;
  }

  /**
   * Check if current/last batch is complete
   */
  isComplete(): boolean {
    if (this._currentBatch) {
      return this._currentBatch.complete;
    }
    if (this._batches.length > 0) {
      const lastBatch = this._batches[this._batches.length - 1];
      return lastBatch.complete;
    }
    return false;
  }

  // ============================================
  // Rendering
  // ============================================

  /**
   * Render a specific batch into its shadow container.
   * Uses incremental updates to preserve event handlers.
   */
  private renderBatch(batch: ToolBatch): void {
    const container = this.getContainer(batch.containerId);
    if (!container) return;

    if (batch.calls.length === 0) {
      container.content.innerHTML = '';
      return;
    }

    const doneCount = batch.calls.filter(t => t.status === 'done').length;
    const errorCount = batch.calls.filter(t => t.status === 'error').length;
    const runningCount = batch.calls.filter(t => t.status === 'running').length;
    const hasErrors = errorCount > 0;

    // container.content already has class="container" from InterleavedShadowActor
    // Apply state classes directly to it
    container.content.classList.toggle('expanded', batch.expanded);
    container.content.classList.toggle('complete', batch.complete);
    container.content.classList.toggle('has-errors', hasErrors);

    // Check if structure already exists
    const existingHeader = container.content.querySelector('.header');

    if (existingHeader) {
      // Incremental update - preserve event handlers
      // Update title
      const titleEl = container.content.querySelector('.title');
      if (titleEl) {
        titleEl.textContent = this.getBatchTitle(batch);
      }

      // Update body content
      const body = container.content.querySelector('.body');
      if (body) {
        body.innerHTML = batch.calls.map(tool => this.renderTool(tool)).join('');
      }
    } else {
      // First render - create structure inside container.content
      container.content.innerHTML = `
        <div class="header">
          <span class="icon">▶</span>
          <span class="title">${this.getBatchTitle(batch)}</span>
          <span class="summary"></span>
        </div>
        <div class="body">
          ${batch.calls.map(tool => this.renderTool(tool)).join('')}
        </div>
      `;

      // Bind click handler using event delegation
      this.delegateInContainer(container.id, 'click', '.header', () => {
        this.toggleBatchExpanded(batch.id);
      });
    }
  }

  /**
   * Get title text for a batch
   */
  private getBatchTitle(batch: ToolBatch): string {
    const doneCount = batch.calls.filter(t => t.status === 'done').length;
    const errorCount = batch.calls.filter(t => t.status === 'error').length;
    const runningCount = batch.calls.filter(t => t.status === 'running').length;
    const totalCount = batch.calls.length;

    if (!batch.complete) {
      const pendingOrRunning = runningCount + batch.calls.filter(t => t.status === 'pending').length;
      if (pendingOrRunning > 0) {
        if (doneCount > 0) {
          return `Using tools... (${doneCount}/${totalCount} done)`;
        }
        return `Using ${pendingOrRunning} tool${pendingOrRunning !== 1 ? 's' : ''}...`;
      }
      return `Used ${totalCount} tool${totalCount !== 1 ? 's' : ''}`;
    }

    let title = `Used ${doneCount} tool${doneCount !== 1 ? 's' : ''}`;
    if (errorCount > 0) {
      title += ` (${errorCount} failed)`;
    }
    return title;
  }

  /**
   * Render a single tool call
   */
  private renderTool(tool: ToolCall): string {
    const statusIcon = this.getStatusIcon(tool.status);
    const spinClass = tool.status === 'running' ? 'spinning' : '';

    return `
      <div class="item" id="${tool.id}" data-status="${tool.status}">
        <span class="status ${spinClass}">${statusIcon}</span>
        <span class="name">${this.escapeHtml(tool.name)}</span>
        <span class="detail">${this.escapeHtml(tool.detail)}</span>
      </div>
    `;
  }

  /**
   * Get icon for tool status
   */
  private getStatusIcon(status: ToolCall['status']): string {
    switch (status) {
      case 'pending':
        return '○';
      case 'running':
        return '⏳';
      case 'done':
        return '✓';
      case 'error':
        return '✗';
    }
  }

  /**
   * Escape HTML special characters
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ============================================
  // Lifecycle
  // ============================================

  destroy(): void {
    this._batches = [];
    this._currentBatch = null;
    super.destroy();
  }
}
