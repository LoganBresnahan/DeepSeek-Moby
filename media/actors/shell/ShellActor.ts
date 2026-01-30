/**
 * ShellActor
 *
 * Manages shell command execution state and dropdown rendering.
 * Handles shell tags from DeepSeek Reasoner (R1) model responses.
 *
 * ARCHITECTURE: Each segment creates its own DOM element that is
 * appended to the parent container in message flow order.
 * Old segments remain visible with their final state.
 *
 * Extends InterleavedContentActor for shared container management.
 *
 * Publications:
 * - shell.segments: ShellSegment[] - all shell command segments
 * - shell.activeCount: number - count of running commands
 * - shell.expanded: Set<string> - IDs of expanded segments
 *
 * Subscriptions:
 * - streaming.active: boolean - track streaming state
 */

import { InterleavedContentActor } from '../../state/InterleavedContentActor';
import { EventStateManager } from '../../state/EventStateManager';
import { shellStyles as styles } from './styles';

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
  element: HTMLElement; // Each segment has its own DOM element
}

export interface ShellState {
  segments: ShellSegment[];
  activeCount: number;
  expandedIds: string[];
}

export type ShellExecuteHandler = (commands: string[]) => void;

export class ShellActor extends InterleavedContentActor {
  // Internal state
  private _segments: ShellSegment[] = [];
  private _expandedIds: Set<string> = new Set();

  // Handlers
  private _onExecute: ShellExecuteHandler | null = null;

  constructor(manager: EventStateManager, element: HTMLElement) {
    super({
      manager,
      element,
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
      },
      actorName: 'shell',
      containerClassName: 'shell-segment',
      styles
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
   * Uses InterleavedContentActor's createContainer for consistent positioning.
   */
  createSegment(commands: string[]): string {
    // Use base class's container creation
    const container = this.createContainer('shell');

    const segment: ShellSegment = {
      id: container.id,
      commands: commands.map(cmd => ({
        command: cmd,
        status: 'pending'
      })),
      complete: false,
      element: container.element
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
   * Toggle segment expanded state
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
    // Use base class's container cleanup
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
        element: s.element
      })),
      activeCount: this.getActiveCount(),
      expandedIds: [...this._expandedIds]
    };
  }

  /**
   * Get segments (without element references for serialization)
   */
  getSegments(): Array<Omit<ShellSegment, 'element'>> {
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
   * Render a single segment (updates only that segment's element)
   */
  private renderSegment(segment: ShellSegment): void {
    if (!segment.element) return;

    if (segment.commands.length === 0) {
      segment.element.innerHTML = '';
      return;
    }

    const isExpanded = this._expandedIds.has(segment.id);
    const hasErrors = segment.commands.some(cmd => cmd.status === 'error');
    const doneCount = segment.commands.filter(cmd => cmd.status === 'done').length;
    const errorCount = segment.commands.filter(cmd => cmd.status === 'error').length;
    const runningCount = segment.commands.filter(cmd => cmd.status === 'running').length;
    const pendingCount = segment.commands.filter(cmd => cmd.status === 'pending').length;
    const totalCount = segment.commands.length;

    const classes = [
      'shell-container',
      segment.complete ? 'complete' : '',
      isExpanded ? 'expanded' : '',
      hasErrors ? 'has-errors' : ''
    ].filter(Boolean).join(' ');

    // Total completed = done + error (both are finished states)
    const completedCount = doneCount + errorCount;

    let title: string;
    if (!segment.complete) {
      if (completedCount > 0) {
        title = `Running ${runningCount + pendingCount} command${(runningCount + pendingCount) !== 1 ? 's' : ''}... (${completedCount}/${totalCount} done)`;
      } else {
        title = `Running ${totalCount} command${totalCount !== 1 ? 's' : ''}...`;
      }
    } else {
      title = `Ran ${totalCount} command${totalCount !== 1 ? 's' : ''}`;
      if (errorCount > 0) {
        title += ` (${errorCount} failed)`;
      }
    }

    segment.element.innerHTML = `
      <div class="${classes}" data-segment-id="${segment.id}">
        <div class="shell-header">
          <span class="shell-icon">▶</span>
          <span class="shell-title">${title}</span>
          <span class="shell-summary"></span>
        </div>
        <div class="shell-body">
          ${segment.commands.map((cmd, i) => this.renderCommand(cmd, segment.id, i)).join('')}
        </div>
      </div>
    `;

    // Bind click handler
    const header = segment.element.querySelector('.shell-header');
    if (header) {
      header.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleExpanded(segment.id);
      });
    }
  }

  /**
   * Render a single command
   */
  private renderCommand(cmd: ShellCommand, segmentId: string, index: number): string {
    const statusIcon = this.getStatusIcon(cmd.status);
    const spinClass = cmd.status === 'running' ? 'spinning' : '';

    return `
      <div class="shell-item" id="${segmentId}-item-${index}" data-status="${cmd.status}">
        <div class="shell-item-header">
          <span class="shell-status ${spinClass}">${statusIcon}</span>
          <code class="shell-command">${this.escapeHtml(cmd.command)}</code>
        </div>
        ${cmd.output ? `<pre class="shell-output">${this.escapeHtml(cmd.output)}</pre>` : ''}
      </div>
    `;
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

  /**
   * Destroy and cleanup
   */
  destroy(): void {
    this._segments = [];
    this._expandedIds.clear();
    this._onExecute = null;
    super.destroy();
  }

  /**
   * Reset styles injection flag and remove style tag (for testing)
   */
  static resetStylesInjected(): void {
    InterleavedContentActor.resetStylesInjectedFor('shell');
  }
}
