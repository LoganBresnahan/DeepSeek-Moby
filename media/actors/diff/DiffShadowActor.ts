/**
 * DiffShadowActor
 *
 * Shadow DOM version of DiffActor for visual diff rendering.
 * Shows unified diff view with added/removed lines.
 *
 * Uses Shadow DOM for complete style isolation - no class prefixes needed.
 *
 * Publications:
 * - diff.active: boolean - whether a diff is currently displayed
 * - diff.file: string | null - current file being diffed
 * - diff.stats: { added: number, removed: number } - line change stats
 *
 * Subscriptions:
 * - codeblock.diffedId: when a code block diff is toggled
 */

import { ShadowActor } from '../../state/ShadowActor';
import { EventStateManager } from '../../state/EventStateManager';
import { diffShadowStyles } from './shadowStyles';

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

export type DiffActionHandler = (
  action: 'apply' | 'reject' | 'close',
  filePath: string,
  codeBlockId: string
) => void;

export class DiffShadowActor extends ShadowActor {
  // State
  private _active = false;
  private _file: string | null = null;
  private _stats = { added: 0, removed: 0 };
  private _codeBlockId: string | null = null;
  private _currentDiff: DiffData | null = null;

  // Handler
  private _actionHandler: DiffActionHandler | null = null;

  constructor(manager: EventStateManager, element: HTMLElement) {
    super({
      manager,
      element,
      styles: diffShadowStyles,
      publications: {
        'diff.active': () => this._active,
        'diff.file': () => this._file,
        'diff.stats': () => ({ ...this._stats })
      },
      subscriptions: {
        'codeblock.diffedId': (value: unknown) => {
          const diffedId = value as string | null;
          if (diffedId === null && this._active) {
            this.close();
          }
        }
      }
    });
  }

  // ============================================
  // Public API
  // ============================================

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
    this.renderDiff();

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
    const oldBlockId = this._codeBlockId;

    this._active = false;
    this._file = null;
    this._stats = { added: 0, removed: 0 };
    this._codeBlockId = null;
    this._currentDiff = null;

    this.clearContent();

    if (wasActive) {
      this.publish({
        'diff.active': false,
        'diff.file': null,
        'diff.stats': { added: 0, removed: 0 }
      });

      if (this._actionHandler && oldFile && oldBlockId) {
        this._actionHandler('close', oldFile, oldBlockId);
      }
    }
  }

  /**
   * Set action handler for apply/reject/close
   */
  onAction(handler: DiffActionHandler): void {
    this._actionHandler = handler;
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

  // ============================================
  // Diff Computation
  // ============================================

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
   * Compute line-level diff
   */
  private computeLineDiff(oldLines: string[], newLines: string[]): DiffLine[] {
    const result: DiffLine[] = [];
    let oldIdx = 0;
    let newIdx = 0;

    while (oldIdx < oldLines.length || newIdx < newLines.length) {
      if (oldIdx >= oldLines.length) {
        result.push({
          type: 'added',
          content: newLines[newIdx],
          newLineNum: newIdx + 1
        });
        newIdx++;
      } else if (newIdx >= newLines.length) {
        result.push({
          type: 'removed',
          content: oldLines[oldIdx],
          oldLineNum: oldIdx + 1
        });
        oldIdx++;
      } else if (oldLines[oldIdx] === newLines[newIdx]) {
        result.push({
          type: 'unchanged',
          content: oldLines[oldIdx],
          oldLineNum: oldIdx + 1,
          newLineNum: newIdx + 1
        });
        oldIdx++;
        newIdx++;
      } else {
        const matchInNew = this.findMatchAhead(oldLines[oldIdx], newLines, newIdx, 5);
        const matchInOld = this.findMatchAhead(newLines[newIdx], oldLines, oldIdx, 5);

        if (matchInNew !== -1 && (matchInOld === -1 || matchInNew - newIdx <= matchInOld - oldIdx)) {
          while (newIdx < matchInNew) {
            result.push({
              type: 'added',
              content: newLines[newIdx],
              newLineNum: newIdx + 1
            });
            newIdx++;
          }
        } else if (matchInOld !== -1) {
          while (oldIdx < matchInOld) {
            result.push({
              type: 'removed',
              content: oldLines[oldIdx],
              oldLineNum: oldIdx + 1
            });
            oldIdx++;
          }
        } else {
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

  // ============================================
  // Rendering
  // ============================================

  /**
   * Render the diff view into the shadow DOM
   */
  private renderDiff(): void {
    if (!this._currentDiff) {
      this.clearContent();
      return;
    }

    const { filePath, lines, stats } = this._currentDiff;
    const fileName = filePath.split('/').pop() || filePath;

    this.render(`
      <div class="container">
        <div class="header">
          <div class="title">
            <span class="icon">📄</span>
            <span class="filename">${this.escapeHtml(fileName)}</span>
          </div>
          <div class="actions">
            <button class="btn apply-btn" data-action="apply">
              ✓ Apply
            </button>
            <button class="btn reject-btn" data-action="reject">
              ✗ Reject
            </button>
            <button class="btn close-btn" data-action="close">
              ×
            </button>
          </div>
        </div>
        <div class="content">
          <table>
            <tbody>
              ${lines.map(line => this.renderLine(line)).join('')}
            </tbody>
          </table>
        </div>
        <div class="stats">
          <span class="stat-added">+${stats.added} added</span>
          <span class="stat-removed">-${stats.removed} removed</span>
        </div>
      </div>
    `);

    // Bind click handlers using delegation
    this.delegate('click', '.btn', (event, el) => {
      const action = el.dataset.action as 'apply' | 'reject' | 'close';
      this.handleAction(action);
    });
  }

  /**
   * Render a single diff line
   */
  private renderLine(line: DiffLine): string {
    const typeClass = `line-${line.type}`;
    const oldNum = line.oldLineNum?.toString() || '';
    const newNum = line.newLineNum?.toString() || '';
    const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
    const content = this.escapeHtml(line.content);

    if (line.type === 'hunk') {
      return `
        <tr class="hunk-separator">
          <td colspan="3">${content}</td>
        </tr>
      `;
    }

    return `
      <tr class="line ${typeClass}">
        <td class="line-num line-num-old">${oldNum}</td>
        <td class="line-num line-num-new">${newNum}</td>
        <td class="line-content">${prefix} ${content}</td>
      </tr>
    `;
  }

  /**
   * Handle action button clicks
   */
  private handleAction(action: 'apply' | 'reject' | 'close'): void {
    if (this._actionHandler && this._file && this._codeBlockId) {
      this._actionHandler(action, this._file, this._codeBlockId);
    }

    if (action === 'close' || action === 'reject') {
      this.close();
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

  // ============================================
  // Lifecycle
  // ============================================

  destroy(): void {
    this._actionHandler = null;
    this._currentDiff = null;
    super.destroy();
  }
}
