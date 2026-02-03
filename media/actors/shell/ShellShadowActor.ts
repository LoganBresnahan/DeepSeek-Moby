/**
 * ShellShadowActor
 *
 * Shadow DOM version of ShellActor.
 * Manages shell command execution state and dropdown rendering.
 * Handles shell tags from DeepSeek Reasoner (R1) model responses.
 *
 * Each shell segment gets its own Shadow DOM for complete style isolation.
 * No z-index coordination needed, no class name prefixes required.
 *
 * Publications:
 * - shell.segments: ShellSegment[] - all shell command segments
 * - shell.activeCount: number - count of running commands
 * - shell.expanded: Set<string> - IDs of expanded segments
 *
 * Subscriptions:
 * - streaming.active: boolean - track streaming state
 */

import { InterleavedShadowActor } from '../../state/InterleavedShadowActor';
import { EventStateManager } from '../../state/EventStateManager';
import { shellShadowStyles } from './shadowStyles';

export interface ShellCommand {
  command: string;
  status: 'pending' | 'running' | 'done' | 'error';
  output?: string;
  success?: boolean;
}

export interface ShellSegment {
  id: string;
  commands: ShellCommand[];
  complete: boolean;
  containerId: string;
}

export interface ShellState {
  segments: ShellSegment[];
  activeCount: number;
  expandedIds: string[];
}

export type ShellExecuteHandler = (commands: string[]) => void;

export class ShellShadowActor extends InterleavedShadowActor {
  // Internal state
  private _segments: ShellSegment[] = [];
  private _expandedIds: Set<string> = new Set();

  // Handlers
  private _onExecute: ShellExecuteHandler | null = null;

  constructor(manager: EventStateManager, element: HTMLElement) {
    super({
      manager,
      element,
      actorName: 'shell',
      containerStyles: shellShadowStyles,
      publications: {
        'shell.segments': () => this._segments.map(s => ({
          id: s.id,
          commands: [...s.commands],
          complete: s.complete
        })),
        'shell.activeCount': () => this.getActiveCount(),
        'shell.expanded': () => [...this._expandedIds]
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
    if (!active) {
      // Mark all segments as complete when streaming ends
      this._segments.forEach(seg => {
        seg.complete = true;
        seg.commands.forEach(cmd => {
          if (cmd.status === 'pending' || cmd.status === 'running') {
            cmd.status = 'done';
            cmd.success = true;
          }
        });
        this.renderSegment(seg);
      });
      this.publish({
        'shell.segments': this._segments.map(s => ({
          id: s.id,
          commands: [...s.commands],
          complete: s.complete
        })),
        'shell.activeCount': 0
      });
    }
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Create a new shell segment with commands to execute.
   * Creates a new shadow-encapsulated container.
   */
  createSegment(commands: string[]): string {
    // Create shadow-encapsulated container
    const container = this.createContainer('shell');

    const segment: ShellSegment = {
      id: container.id,
      commands: commands.map(cmd => ({
        command: cmd,
        status: 'pending'
      })),
      complete: false,
      containerId: container.id
    };

    this._segments.push(segment);
    this.renderSegment(segment);

    this.publish({
      'shell.segments': this._segments.map(s => ({
        id: s.id,
        commands: [...s.commands],
        complete: s.complete
      })),
      'shell.activeCount': this.getActiveCount()
    });

    return container.id;
  }

  /**
   * Start executing commands in a segment
   */
  startSegment(segmentId: string): void {
    const segment = this._segments.find(s => s.id === segmentId);
    if (!segment) return;

    segment.commands.forEach(cmd => {
      if (cmd.status === 'pending') {
        cmd.status = 'running';
      }
    });

    this.renderSegment(segment);
    this.publish({
      'shell.segments': this._segments.map(s => ({
        id: s.id,
        commands: [...s.commands],
        complete: s.complete
      })),
      'shell.activeCount': this.getActiveCount()
    });

    // Trigger execute handler
    if (this._onExecute) {
      this._onExecute(segment.commands.map(c => c.command));
    }
  }

  /**
   * Update command results for a segment
   */
  setResults(segmentId: string, results: Array<{ success: boolean; output?: string }>): void {
    const segment = this._segments.find(s => s.id === segmentId);
    if (!segment) return;

    results.forEach((result, i) => {
      if (segment.commands[i]) {
        segment.commands[i].status = result.success ? 'done' : 'error';
        segment.commands[i].success = result.success;
        segment.commands[i].output = result.output;
      }
    });

    segment.complete = true;

    this.renderSegment(segment);

    this.publish({
      'shell.segments': this._segments.map(s => ({
        id: s.id,
        commands: [...s.commands],
        complete: s.complete
      })),
      'shell.activeCount': this.getActiveCount()
    });
  }

  /**
   * Update a single command's status
   */
  updateCommand(segmentId: string, commandIndex: number, update: Partial<ShellCommand>): void {
    const segment = this._segments.find(s => s.id === segmentId);
    if (!segment || !segment.commands[commandIndex]) return;

    Object.assign(segment.commands[commandIndex], update);

    // Check if segment is complete
    segment.complete = segment.commands.every(
      cmd => cmd.status === 'done' || cmd.status === 'error'
    );

    this.renderSegment(segment);
    this.publish({
      'shell.segments': this._segments.map(s => ({
        id: s.id,
        commands: [...s.commands],
        complete: s.complete
      })),
      'shell.activeCount': this.getActiveCount()
    });
  }

  /**
   * Toggle segment expanded state.
   */
  toggleExpanded(segmentId: string): void {
    const segment = this._segments.find(s => s.id === segmentId);
    if (!segment) return;

    if (this._expandedIds.has(segmentId)) {
      this._expandedIds.delete(segmentId);
    } else {
      this._expandedIds.add(segmentId);
    }

    this.renderSegment(segment);
    this.publish({
      'shell.expanded': [...this._expandedIds]
    });
  }

  /**
   * Expand a segment
   */
  expand(segmentId: string): void {
    const segment = this._segments.find(s => s.id === segmentId);
    if (!segment) return;

    if (!this._expandedIds.has(segmentId)) {
      this._expandedIds.add(segmentId);
      this.renderSegment(segment);
      this.publish({ 'shell.expanded': [...this._expandedIds] });
    }
  }

  /**
   * Collapse a segment
   */
  collapse(segmentId: string): void {
    const segment = this._segments.find(s => s.id === segmentId);
    if (!segment) return;

    if (this._expandedIds.has(segmentId)) {
      this._expandedIds.delete(segmentId);
      this.renderSegment(segment);
      this.publish({ 'shell.expanded': [...this._expandedIds] });
    }
  }

  /**
   * Clear all segments and remove their DOM elements
   */
  clear(): void {
    this.clearContainers();

    this._segments = [];
    this._expandedIds.clear();

    this.publish({
      'shell.segments': [],
      'shell.activeCount': 0,
      'shell.expanded': []
    });
  }

  /**
   * Register execute handler
   */
  onExecute(handler: ShellExecuteHandler): void {
    this._onExecute = handler;
  }

  /**
   * Get current state
   */
  getState(): ShellState {
    return {
      segments: this._segments.map(s => ({
        id: s.id,
        commands: [...s.commands],
        complete: s.complete,
        containerId: s.containerId
      })),
      activeCount: this.getActiveCount(),
      expandedIds: [...this._expandedIds]
    };
  }

  /**
   * Get segments (without containerId for serialization)
   */
  getSegments(): Array<Omit<ShellSegment, 'containerId'>> {
    return this._segments.map(s => ({
      id: s.id,
      commands: [...s.commands],
      complete: s.complete
    }));
  }

  /**
   * Get active (running) command count
   */
  getActiveCount(): number {
    return this._segments.reduce((count, seg) => {
      return count + seg.commands.filter(cmd => cmd.status === 'running').length;
    }, 0);
  }

  /**
   * Check if any segment has errors
   */
  hasErrors(): boolean {
    return this._segments.some(seg =>
      seg.commands.some(cmd => cmd.status === 'error')
    );
  }

  // ============================================
  // Rendering
  // ============================================

  /**
   * Render a single segment into its shadow container.
   * Uses incremental updates to preserve event handlers.
   */
  private renderSegment(segment: ShellSegment): void {
    const container = this.getContainer(segment.containerId);
    if (!container) return;

    if (segment.commands.length === 0) {
      container.content.innerHTML = '';
      return;
    }

    // Check expansion state
    const isExpanded = this._expandedIds.has(segment.id);
    const hasErrors = segment.commands.some(cmd => cmd.status === 'error');

    // Apply state classes
    container.content.classList.toggle('expanded', isExpanded);
    container.content.classList.toggle('complete', segment.complete);
    container.content.classList.toggle('has-errors', hasErrors);

    const toggleIcon = isExpanded ? '−' : '+';
    const preview = this.getPreviewText(segment, isExpanded);
    const statusIcons = this.getHeaderStatusIcons(segment);

    // Check if structure already exists
    const existingHeader = container.content.querySelector('.header');

    if (existingHeader) {
      // Incremental update - preserve event handlers
      const toggleEl = container.content.querySelector('.toggle');
      if (toggleEl) toggleEl.textContent = toggleIcon;

      const titleEl = container.content.querySelector('.title');
      if (titleEl) titleEl.textContent = this.getSegmentTitle(segment);

      const previewEl = container.content.querySelector('.preview');
      if (previewEl) previewEl.textContent = preview;

      const statusEl = container.content.querySelector('.header-status');
      if (statusEl) statusEl.innerHTML = statusIcons;

      // Update body content
      const body = container.content.querySelector('.body');
      if (body) {
        body.innerHTML = segment.commands.map((cmd, i, arr) =>
          this.renderCommand(cmd, segment.id, i, i === arr.length - 1)
        ).join('');
      }
    } else {
      // First render - clean HTML with dotted border from CSS
      container.content.innerHTML = `
<div class="header">
  <span class="toggle">${toggleIcon}</span>
  <span class="icon">$</span>
  <span class="title">${this.getSegmentTitle(segment)}</span>
  <span class="preview">${preview}</span>
  <span class="header-status">${statusIcons}</span>
</div>
<div class="body">
${segment.commands.map((cmd, i, arr) => this.renderCommand(cmd, segment.id, i, i === arr.length - 1)).join('\n')}
</div>`;

      // Bind click handler to header only
      const header = container.content.querySelector('.header');
      header?.addEventListener('click', () => {
        this.toggleExpanded(segment.id);
      });
    }
  }

  /**
   * Get preview text for collapsed state
   */
  private getPreviewText(segment: ShellSegment, isExpanded: boolean): string {
    if (isExpanded) return '';
    const firstCmd = segment.commands[0]?.command || '';
    const preview = firstCmd.slice(0, 30);
    return preview.length < firstCmd.length ? `  ${preview}...` : `  ${preview}`;
  }

  /**
   * Get status icons for header (collapsed view)
   */
  private getHeaderStatusIcons(segment: ShellSegment): string {
    return segment.commands.map(cmd => {
      switch (cmd.status) {
        case 'done': return '<span style="color: var(--vscode-terminal-ansiGreen)">✓</span>';
        case 'error': return '<span style="color: var(--vscode-errorForeground)">✕</span>';
        case 'running': return '<span style="color: var(--vscode-terminal-ansiYellow)">⟳</span>';
        default: return '<span style="color: var(--vscode-descriptionForeground)">○</span>';
      }
    }).join('');
  }

  /**
   * Get title text for a segment
   */
  private getSegmentTitle(segment: ShellSegment): string {
    const doneCount = segment.commands.filter(cmd => cmd.status === 'done').length;
    const errorCount = segment.commands.filter(cmd => cmd.status === 'error').length;
    const runningCount = segment.commands.filter(cmd => cmd.status === 'running').length;
    const pendingCount = segment.commands.filter(cmd => cmd.status === 'pending').length;
    const totalCount = segment.commands.length;

    const completedCount = doneCount + errorCount;

    if (!segment.complete) {
      if (completedCount > 0) {
        return `Running ${runningCount + pendingCount} command${(runningCount + pendingCount) !== 1 ? 's' : ''}... (${completedCount}/${totalCount} done)`;
      } else {
        return `Running ${totalCount} command${totalCount !== 1 ? 's' : ''}...`;
      }
    } else {
      let title = `Ran ${totalCount} command${totalCount !== 1 ? 's' : ''}`;
      if (errorCount > 0) {
        title += ` (${errorCount} failed)`;
      }
      return title;
    }
  }

  /**
   * Render a single command
   */
  private renderCommand(cmd: ShellCommand, segmentId: string, index: number, isLast: boolean = false): string {
    const statusIcon = this.getStatusIcon(cmd.status);
    const spinClass = cmd.status === 'running' ? 'spinning' : '';
    const treeBranch = isLast ? '└─' : '├─';

    const outputHtml = cmd.output ? `
       <div class="output">${this.escapeHtml(cmd.output)}</div>` : '';

    return `<div class="item" id="${segmentId}-item-${index}" data-status="${cmd.status}">
<div class="item-row">     <span class="tree">${treeBranch}</span> <span class="status ${spinClass}">${statusIcon}</span> <span class="command">${this.escapeHtml(cmd.command)}</span></div>${outputHtml}
</div>`;
  }

  /**
   * Get icon for command status
   */
  private getStatusIcon(status: ShellCommand['status']): string {
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
    this._segments = [];
    this._expandedIds.clear();
    this._onExecute = null;
    super.destroy();
  }
}
