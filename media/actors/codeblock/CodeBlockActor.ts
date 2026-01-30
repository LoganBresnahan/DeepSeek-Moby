/**
 * CodeBlockActor
 *
 * Manages code block display, collapse/expand state, and actions.
 * Handles copy, diff, and apply functionality for code blocks.
 *
 * Publications:
 * - codeblock.blocks: CodeBlock[] - all code blocks
 * - codeblock.collapsedIds: string[] - IDs of collapsed blocks
 * - codeblock.diffedId: string | null - ID of block with active diff
 *
 * Subscriptions:
 * - streaming.active: boolean - auto-collapse when streaming ends
 */

import { EventStateActor } from '../../state/EventStateActor';
import { EventStateManager } from '../../state/EventStateManager';
import type { ActorConfig } from '../../state/types';
import { codeBlockStyles as styles } from './styles';

export interface CodeBlock {
  id: string;
  language: string;
  code: string;
  collapsed: boolean;
  isApplied: boolean;
  isToolOutput: boolean;
}

export interface CodeBlockState {
  blocks: CodeBlock[];
  collapsedIds: string[];
  diffedId: string | null;
}

export type CodeActionHandler = (blockId: string, action: 'copy' | 'diff' | 'apply', code: string, language: string) => void;

export class CodeBlockActor extends EventStateActor {
  private static stylesInjected = false;

  // Internal state
  private _blocks: Map<string, CodeBlock> = new Map();
  private _diffedId: string | null = null;
  private _idCounter = 0;

  // Handlers
  private _onAction: CodeActionHandler | null = null;

  constructor(manager: EventStateManager, element: HTMLElement) {
    const config: ActorConfig = {
      manager,
      element,
      publications: {
        'codeblock.blocks': () => [...this._blocks.values()],
        'codeblock.collapsedIds': () => this.getCollapsedIds(),
        'codeblock.diffedId': () => this._diffedId
      },
      subscriptions: {
        'streaming.active': (value: unknown) => this.handleStreamingActive(value as boolean)
      },
      enableDOMChangeDetection: false
    };

    super(config);
    this.injectStyles();
  }

  /**
   * Inject CSS styles (once per class)
   */
  private injectStyles(): void {
    if (CodeBlockActor.stylesInjected) return;
    if (typeof document === 'undefined') return;

    const style = document.createElement('style');
    style.setAttribute('data-actor', 'codeblock');
    style.textContent = styles;
    document.head.appendChild(style);
    CodeBlockActor.stylesInjected = true;
  }

  // ============================================
  // Subscription Handlers
  // ============================================

  private handleStreamingActive(active: boolean): void {
    if (!active) {
      // Auto-collapse applied blocks when streaming ends
      this._blocks.forEach((block, id) => {
        if (block.isApplied && !block.collapsed) {
          block.collapsed = true;
        }
      });
      this.publish({
        'codeblock.blocks': [...this._blocks.values()],
        'codeblock.collapsedIds': this.getCollapsedIds()
      });
    }
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Register a code block
   */
  addBlock(language: string, code: string, options: Partial<Omit<CodeBlock, 'id' | 'language' | 'code'>> = {}): string {
    const id = `codeblock-${++this._idCounter}-${Date.now()}`;
    const isApplied = /^#\s*File:/m.test(code);

    this._blocks.set(id, {
      id,
      language,
      code,
      collapsed: options.collapsed ?? false,
      isApplied: options.isApplied ?? isApplied,
      isToolOutput: options.isToolOutput ?? (language === 'tool-output')
    });

    this.publish({
      'codeblock.blocks': [...this._blocks.values()],
      'codeblock.collapsedIds': this.getCollapsedIds()
    });

    return id;
  }

  /**
   * Get a block by ID
   */
  getBlock(id: string): CodeBlock | undefined {
    return this._blocks.get(id);
  }

  /**
   * Toggle collapse state
   */
  toggleCollapse(id: string): void {
    const block = this._blocks.get(id);
    if (!block) return;

    block.collapsed = !block.collapsed;

    this.publish({
      'codeblock.blocks': [...this._blocks.values()],
      'codeblock.collapsedIds': this.getCollapsedIds()
    });
  }

  /**
   * Collapse a block
   */
  collapse(id: string): void {
    const block = this._blocks.get(id);
    if (!block || block.collapsed) return;

    block.collapsed = true;

    this.publish({
      'codeblock.blocks': [...this._blocks.values()],
      'codeblock.collapsedIds': this.getCollapsedIds()
    });
  }

  /**
   * Expand a block
   */
  expand(id: string): void {
    const block = this._blocks.get(id);
    if (!block || !block.collapsed) return;

    block.collapsed = false;

    this.publish({
      'codeblock.blocks': [...this._blocks.values()],
      'codeblock.collapsedIds': this.getCollapsedIds()
    });
  }

  /**
   * Copy code to clipboard
   */
  async copy(id: string): Promise<boolean> {
    const block = this._blocks.get(id);
    if (!block) return false;

    try {
      await navigator.clipboard.writeText(block.code);
      if (this._onAction) {
        this._onAction(id, 'copy', block.code, block.language);
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Toggle diff mode for a block
   */
  toggleDiff(id: string): void {
    const block = this._blocks.get(id);
    if (!block) return;

    if (this._diffedId === id) {
      // Close diff
      this._diffedId = null;
    } else {
      // Open diff (close any existing)
      this._diffedId = id;
    }

    this.publish({ 'codeblock.diffedId': this._diffedId });

    if (this._onAction) {
      this._onAction(id, 'diff', block.code, block.language);
    }
  }

  /**
   * Apply code from a block
   */
  apply(id: string): void {
    const block = this._blocks.get(id);
    if (!block) return;

    if (this._onAction) {
      this._onAction(id, 'apply', block.code, block.language);
    }
  }

  /**
   * Close any active diff
   */
  closeDiff(): void {
    if (this._diffedId) {
      this._diffedId = null;
      this.publish({ 'codeblock.diffedId': null });
    }
  }

  /**
   * Remove a block
   */
  removeBlock(id: string): void {
    if (!this._blocks.has(id)) return;

    this._blocks.delete(id);

    if (this._diffedId === id) {
      this._diffedId = null;
    }

    this.publish({
      'codeblock.blocks': [...this._blocks.values()],
      'codeblock.collapsedIds': this.getCollapsedIds(),
      'codeblock.diffedId': this._diffedId
    });
  }

  /**
   * Clear all blocks
   */
  clear(): void {
    this._blocks.clear();
    this._diffedId = null;

    this.publish({
      'codeblock.blocks': [],
      'codeblock.collapsedIds': [],
      'codeblock.diffedId': null
    });
  }

  /**
   * Register action handler
   */
  onAction(handler: CodeActionHandler): void {
    this._onAction = handler;
  }

  /**
   * Get current state
   */
  getState(): CodeBlockState {
    return {
      blocks: [...this._blocks.values()],
      collapsedIds: this.getCollapsedIds(),
      diffedId: this._diffedId
    };
  }

  /**
   * Get all blocks
   */
  getBlocks(): CodeBlock[] {
    return [...this._blocks.values()];
  }

  /**
   * Get collapsed block IDs
   */
  getCollapsedIds(): string[] {
    return [...this._blocks.values()]
      .filter(b => b.collapsed)
      .map(b => b.id);
  }

  /**
   * Check if a block is collapsed
   */
  isCollapsed(id: string): boolean {
    return this._blocks.get(id)?.collapsed ?? false;
  }

  /**
   * Check if a block has active diff
   */
  isDiffed(id: string): boolean {
    return this._diffedId === id;
  }

  /**
   * Render a code block HTML (utility for MessageActor)
   */
  renderBlock(block: CodeBlock, editMode: 'manual' | 'ask' | 'auto' = 'manual'): string {
    const isAskOrAuto = editMode === 'ask' || editMode === 'auto';
    const showFullButtons = !isAskOrAuto || !block.isApplied;
    const appliedLabel = (isAskOrAuto && block.isApplied) ? ' (APPLIED)' : '';
    const displayLang = block.isToolOutput ? 'output' : block.language;

    const classes = [
      'codeblock-container',
      block.collapsed ? 'collapsed' : '',
      this._diffedId === block.id ? 'diffed' : '',
      block.isToolOutput ? 'tool-output' : ''
    ].filter(Boolean).join(' ');

    const collapseIcon = block.collapsed ? '▶' : '▼';
    const collapseTitle = block.collapsed ? 'Expand' : 'Collapse';

    let actionsHtml = '';
    if (!block.isToolOutput) {
      if (showFullButtons) {
        actionsHtml = `
          <div class="codeblock-actions">
            <button class="codeblock-btn copy-btn" data-action="copy">Copy</button>
            <button class="codeblock-btn diff-btn" data-action="diff">Diff</button>
            <button class="codeblock-btn apply-btn" data-action="apply">Apply</button>
            <button class="codeblock-btn collapse-btn" data-action="collapse" title="${collapseTitle}">${collapseIcon}</button>
          </div>
        `;
      } else {
        actionsHtml = `
          <div class="codeblock-actions">
            <button class="codeblock-btn copy-btn" data-action="copy">Copy</button>
            <button class="codeblock-btn collapse-btn" data-action="collapse" title="${collapseTitle}">${collapseIcon}</button>
          </div>
        `;
      }
    }

    return `
      <div class="${classes}" id="${block.id}" data-language="${block.language}">
        <div class="codeblock-header">
          <span class="codeblock-lang">${displayLang}${appliedLabel}</span>
          ${actionsHtml}
        </div>
        <div class="codeblock-content">
          <pre><code class="language-${block.language}">${this.highlightCode(block.code)}</code></pre>
        </div>
      </div>
    `;
  }

  /**
   * Basic syntax highlighting
   */
  private highlightCode(code: string): string {
    let highlighted = this.escapeHtml(code);

    const tokens: string[] = [];

    // Strings
    highlighted = highlighted.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, (match) => {
      const idx = tokens.length;
      tokens.push(`<span class="token string">${match}</span>`);
      return `__TOKEN_${idx}__`;
    });

    // Comments
    highlighted = highlighted.replace(/(\/\/.*|#.*|\/\*[\s\S]*?\*\/)/g, (match) => {
      const idx = tokens.length;
      tokens.push(`<span class="token comment">${match}</span>`);
      return `__TOKEN_${idx}__`;
    });

    // Keywords
    highlighted = highlighted.replace(/\b(function|const|let|var|if|else|for|while|return|class|def|import|export|from|async|await|try|catch|finally|throw|new|this|true|false|null|undefined)\b/g, (match) => {
      const idx = tokens.length;
      tokens.push(`<span class="token keyword">${match}</span>`);
      return `__TOKEN_${idx}__`;
    });

    // Numbers
    highlighted = highlighted.replace(/\b(\d+\.?\d*)\b/g, (match) => {
      const idx = tokens.length;
      tokens.push(`<span class="token number">${match}</span>`);
      return `__TOKEN_${idx}__`;
    });

    // Restore tokens
    tokens.forEach((token, idx) => {
      highlighted = highlighted.replace(`__TOKEN_${idx}__`, token);
    });

    return highlighted;
  }

  /**
   * Escape HTML
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Destroy and cleanup
   */
  destroy(): void {
    this._blocks.clear();
    this._onAction = null;
    super.destroy();
  }

  /**
   * Reset styles injection flag and remove style tag (for testing)
   */
  static resetStylesInjected(): void {
    CodeBlockActor.stylesInjected = false;
    if (typeof document !== 'undefined') {
      const styleTag = document.querySelector('style[data-actor="codeblock"]');
      if (styleTag) {
        styleTag.remove();
      }
    }
  }
}
