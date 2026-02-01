/**
 * DiffActor - handles visual diff rendering in the chat webview
 *
 * Shows unified diff view with added/removed lines when a code block
 * is being diffed against the original file content.
 *
 * Publications:
 * - diff.active: boolean - whether a diff is currently displayed
 * - diff.file: string | null - current file being diffed
 * - diff.stats: { added: number, removed: number } - line change stats
 *
 * Subscriptions:
 * - codeblock.diffedId: when a code block diff is toggled
 */

import { EventStateManager } from '../../state/EventStateManager';
import { diffStyles } from './styles';

export interface DiffLine {
  type: 'added' | 'removed' | 'unchanged' | 'hunk';
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

export interface DiffData {
  filePath: string;
  oldContent: string;
  newContent: string;
  lines: DiffLine[];
  stats: {
    added: number;
    removed: number;
  };
}

export interface DiffState {
  active: boolean;
  file: string | null;
  stats: { added: number; removed: number };
  codeBlockId: string | null;
}

type ActionHandler = (action: 'apply' | 'reject' | 'close', filePath: string, codeBlockId: string) => void;

export class DiffActor {
  private static stylesInjected = false;

  private readonly manager: EventStateManager;
  private readonly element: HTMLElement;
  private readonly actorId: string;

  private _active = false;
  private _file: string | null = null;
  private _stats = { added: 0, removed: 0 };
  private _codeBlockId: string | null = null;
  private _currentDiff: DiffData | null = null;

  private actionHandler: ActionHandler | null = null;
  private boundHandleStateChanged: (event: Event) => void;

  constructor(manager: EventStateManager, element: HTMLElement) {
    this.manager = manager;
    this.element = element;
    this.actorId = element.id || 'diff-container';
    this.element.id = this.actorId;

    this.boundHandleStateChanged = this.handleStateChanged.bind(this);
    this.element.addEventListener('state-changed', this.boundHandleStateChanged);

    this.injectStyles();
    this.register();
  }

  private injectStyles(): void {
    if (DiffActor.stylesInjected) return;
    const style = document.createElement('style');
    style.setAttribute('data-actor', 'diff');
    style.textContent = diffStyles;
    document.head.appendChild(style);
    DiffActor.stylesInjected = true;
  }

  static resetStylesInjected(): void {
    DiffActor.stylesInjected = false;
    const existingStyle = document.querySelector('style[data-actor="diff"]');
    if (existingStyle) {
      existingStyle.remove();
    }
  }

  private register(): void {
    queueMicrotask(() => {
      this.manager.register(
        {
          actorId: this.actorId,
          element: this.element,
          publicationKeys: ['diff.active', 'diff.file', 'diff.stats'],
          subscriptionKeys: ['codeblock.diffedId']
        },
        this.getPublishedState()
      );
    });
  }

  private getPublishedState(): Record<string, unknown> {
    return {
      'diff.active': this._active,
      'diff.file': this._file,
      'diff.stats': { ...this._stats }
    };
  }

  private publish(state: Record<string, unknown>): void {
    this.manager.handleStateChange({
      source: this.actorId,
      state,
      changedKeys: Object.keys(state),
      publicationChain: [],
      timestamp: Date.now()
    });
  }

  private handleStateChanged(event: Event): void {
    const { state, changedKeys } = (event as CustomEvent).detail;

    if (changedKeys.includes('codeblock.diffedId')) {
      const diffedId = state['codeblock.diffedId'];
      if (diffedId === null && this._active) {
        // Diff was closed externally
        this.close();
      }
    }
  }

  /**
   * Show a diff for the given code block
   */
  showDiff(
    codeBlockId: string,
    filePath: string,
    oldContent: string,
    newContent: string
  ): void {
    this._codeBlockId = codeBlockId;
    this._file = filePath;
    this._active = true;

    // Compute the diff
    this._currentDiff = this.computeDiff(filePath, oldContent, newContent);
    this._stats = this._currentDiff.stats;

    // Render the diff view
    this.render();

    // Publish state
    this.publish({
      'diff.active': true,
      'diff.file': filePath,
      'diff.stats': { ...this._stats }
    });
  }

  /**
   * Close the current diff view
   */
  close(): void {
    const wasActive = this._active;
    const oldFile = this._file;

    this._active = false;
    this._file = null;
    this._stats = { added: 0, removed: 0 };
    this._codeBlockId = null;
    this._currentDiff = null;

    this.element.innerHTML = '';

    if (wasActive) {
      this.publish({
        'diff.active': false,
        'diff.file': null,
        'diff.stats': { added: 0, removed: 0 }
      });

      if (this.actionHandler && oldFile && this._codeBlockId) {
        this.actionHandler('close', oldFile, this._codeBlockId);
      }
    }
  }

  /**
   * Set action handler for apply/reject/close
   */
  onAction(handler: ActionHandler): void {
    this.actionHandler = handler;
  }

  /**
   * Compute diff between old and new content
   */
  private computeDiff(
    filePath: string,
    oldContent: string,
    newContent: string
  ): DiffData {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    // Simple line-by-line diff using LCS approach
    const diffLines = this.computeLineDiff(oldLines, newLines);

    let added = 0;
    let removed = 0;
    for (const line of diffLines) {
      if (line.type === 'added') added++;
      if (line.type === 'removed') removed++;
    }

    return {
      filePath,
      oldContent,
      newContent,
      lines: diffLines,
      stats: { added, removed }
    };
  }

  /**
   * Compute line-level diff using a simple algorithm
   */
  private computeLineDiff(oldLines: string[], newLines: string[]): DiffLine[] {
    const result: DiffLine[] = [];
    let oldIdx = 0;
    let newIdx = 0;

    // Simple diff: find matching lines and mark differences
    while (oldIdx < oldLines.length || newIdx < newLines.length) {
      if (oldIdx >= oldLines.length) {
        // Remaining new lines are additions
        result.push({
          type: 'added',
          content: newLines[newIdx],
          newLineNum: newIdx + 1
        });
        newIdx++;
      } else if (newIdx >= newLines.length) {
        // Remaining old lines are removals
        result.push({
          type: 'removed',
          content: oldLines[oldIdx],
          oldLineNum: oldIdx + 1
        });
        oldIdx++;
      } else if (oldLines[oldIdx] === newLines[newIdx]) {
        // Lines match
        result.push({
          type: 'unchanged',
          content: oldLines[oldIdx],
          oldLineNum: oldIdx + 1,
          newLineNum: newIdx + 1
        });
        oldIdx++;
        newIdx++;
      } else {
        // Lines differ - look ahead for potential match
        const matchInNew = this.findMatchAhead(oldLines[oldIdx], newLines, newIdx, 5);
        const matchInOld = this.findMatchAhead(newLines[newIdx], oldLines, oldIdx, 5);

        if (matchInNew !== -1 && (matchInOld === -1 || matchInNew - newIdx <= matchInOld - oldIdx)) {
          // Add intervening new lines as additions
          while (newIdx < matchInNew) {
            result.push({
              type: 'added',
              content: newLines[newIdx],
              newLineNum: newIdx + 1
            });
            newIdx++;
          }
        } else if (matchInOld !== -1) {
          // Add intervening old lines as removals
          while (oldIdx < matchInOld) {
            result.push({
              type: 'removed',
              content: oldLines[oldIdx],
              oldLineNum: oldIdx + 1
            });
            oldIdx++;
          }
        } else {
          // No match found nearby - mark as change
          result.push({
            type: 'removed',
            content: oldLines[oldIdx],
            oldLineNum: oldIdx + 1
          });
          result.push({
            type: 'added',
            content: newLines[newIdx],
            newLineNum: newIdx + 1
          });
          oldIdx++;
          newIdx++;
        }
      }
    }

    return result;
  }

  /**
   * Find a matching line ahead in the array
   */
  private findMatchAhead(
    target: string,
    lines: string[],
    startIdx: number,
    maxLookahead: number
  ): number {
    const endIdx = Math.min(startIdx + maxLookahead, lines.length);
    for (let i = startIdx; i < endIdx; i++) {
      if (lines[i] === target) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Render the diff view
   */
  private render(): void {
    if (!this._currentDiff) {
      this.element.innerHTML = '';
      return;
    }

    const { filePath, lines, stats } = this._currentDiff;
    const fileName = filePath.split('/').pop() || filePath;

    this.element.innerHTML = `
      <div class="diff-container">
        <div class="diff-header">
          <div class="diff-header-title">
            <span class="diff-header-icon">📄</span>
            <span class="diff-header-filename">${this.escapeHtml(fileName)}</span>
          </div>
          <div class="diff-header-actions">
            <button class="diff-action-btn diff-apply-btn" data-action="apply">
              ✓ Apply
            </button>
            <button class="diff-action-btn diff-reject-btn" data-action="reject">
              ✗ Reject
            </button>
            <button class="diff-action-btn diff-close-btn" data-action="close">
              ×
            </button>
          </div>
        </div>
        <div class="diff-content">
          <table class="diff-table">
            <tbody>
              ${lines.map(line => this.renderLine(line)).join('')}
            </tbody>
          </table>
        </div>
        <div class="diff-stats">
          <span class="diff-stat-added">+${stats.added} added</span>
          <span class="diff-stat-removed">-${stats.removed} removed</span>
        </div>
      </div>
    `;

    // Attach event listeners
    this.element.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = (e.currentTarget as HTMLElement).dataset.action as 'apply' | 'reject' | 'close';
        this.handleAction(action);
      });
    });
  }

  /**
   * Render a single diff line
   */
  private renderLine(line: DiffLine): string {
    const typeClass = `diff-line-${line.type}`;
    const oldNum = line.oldLineNum?.toString() || '';
    const newNum = line.newLineNum?.toString() || '';
    const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
    const content = this.escapeHtml(line.content);

    if (line.type === 'hunk') {
      return `
        <tr class="diff-hunk-separator">
          <td colspan="3">${content}</td>
        </tr>
      `;
    }

    return `
      <tr class="diff-line ${typeClass}">
        <td class="diff-line-num diff-line-num-old">${oldNum}</td>
        <td class="diff-line-num diff-line-num-new">${newNum}</td>
        <td class="diff-line-content">${prefix} ${content}</td>
      </tr>
    `;
  }

  /**
   * Handle action button clicks
   */
  private handleAction(action: 'apply' | 'reject' | 'close'): void {
    if (this.actionHandler && this._file && this._codeBlockId) {
      this.actionHandler(action, this._file, this._codeBlockId);
    }

    if (action === 'close' || action === 'reject') {
      this.close();
    } else if (action === 'apply') {
      // Keep diff open until apply is confirmed externally
      // The parent should call close() after successful apply
    }
  }

  /**
   * Escape HTML entities
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Get current state
   */
  getState(): DiffState {
    return {
      active: this._active,
      file: this._file,
      stats: { ...this._stats },
      codeBlockId: this._codeBlockId
    };
  }

  /**
   * Check if diff is currently active
   */
  isActive(): boolean {
    return this._active;
  }

  /**
   * Get current file being diffed
   */
  getCurrentFile(): string | null {
    return this._file;
  }

  /**
   * Get current diff data
   */
  getDiffData(): DiffData | null {
    return this._currentDiff;
  }

  /**
   * Get current code block ID being diffed
   */
  getCodeBlockId(): string | null {
    return this._codeBlockId;
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.element.removeEventListener('state-changed', this.boundHandleStateChanged);
    this.manager.unregister(this.actorId);
    this.element.innerHTML = '';
  }
}
