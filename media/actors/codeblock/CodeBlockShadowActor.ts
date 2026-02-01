/**
 * CodeBlockShadowActor
 *
 * Shadow DOM version of CodeBlockActor.
 * Each code block gets its own shadow-encapsulated container for complete style isolation.
 *
 * Unlike the original CodeBlockActor which provided `renderBlock()` for external use,
 * this actor renders code blocks directly into shadow DOM containers.
 *
 * Publications:
 * - codeblock.blocks: CodeBlock[] - all code blocks
 * - codeblock.collapsedIds: string[] - IDs of collapsed blocks
 * - codeblock.diffedId: string | null - ID of block with active diff
 *
 * Subscriptions:
 * - streaming.active: boolean - auto-collapse when streaming ends
 */

import { InterleavedShadowActor, ShadowContainer } from '../../state/InterleavedShadowActor';
import { EventStateManager } from '../../state/EventStateManager';
import { codeBlockShadowStyles } from './shadowStyles';

export interface CodeBlock {
  id: string;
  language: string;
  code: string;
  collapsed: boolean;
  isApplied: boolean;
  isToolOutput: boolean;
  containerId: string;
}

export interface CodeBlockState {
  blocks: CodeBlock[];
  collapsedIds: string[];
  diffedId: string | null;
}

export type CodeActionHandler = (
  blockId: string,
  action: 'copy' | 'diff' | 'apply',
  code: string,
  language: string
) => void;

export class CodeBlockShadowActor extends InterleavedShadowActor {
  // Internal state
  private _blocks: Map<string, CodeBlock> = new Map();
  private _diffedId: string | null = null;
  private _idCounter = 0;

  // Handler
  private _onAction: CodeActionHandler | null = null;

  // Edit mode for rendering
  private _editMode: 'manual' | 'ask' | 'auto' = 'manual';

  constructor(manager: EventStateManager, element: HTMLElement) {
    super({
      manager,
      element,
      actorName: 'codeblock',
      containerStyles: codeBlockShadowStyles,
      publications: {
        'codeblock.blocks': () => [...this._blocks.values()],
        'codeblock.collapsedIds': () => this.getCollapsedIds(),
        'codeblock.diffedId': () => this._diffedId
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
      // Auto-collapse applied blocks when streaming ends
      this._blocks.forEach((block) => {
        if (block.isApplied && !block.collapsed) {
          block.collapsed = true;
          this.updateBlockClasses(block);
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
   * Add and render a code block
   */
  addBlock(
    language: string,
    code: string,
    options: Partial<Omit<CodeBlock, 'id' | 'language' | 'code' | 'containerId'>> = {}
  ): string {
    const id = `codeblock-${++this._idCounter}-${Date.now()}`;
    const isApplied = options.isApplied ?? /^#\s*File:/m.test(code);

    // Create shadow container
    const container = this.createContainer('block', {
      animate: true,
      dataAttributes: { blockId: id }
    });

    const block: CodeBlock = {
      id,
      language,
      code,
      collapsed: options.collapsed ?? false,
      isApplied,
      isToolOutput: options.isToolOutput ?? (language === 'tool-output'),
      containerId: container.id
    };

    this._blocks.set(id, block);

    // Render into shadow DOM
    this.renderBlock(block);

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
    this.updateBlockClasses(block);
    this.updateCollapseButton(block);

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
    this.updateBlockClasses(block);
    this.updateCollapseButton(block);

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
    this.updateBlockClasses(block);
    this.updateCollapseButton(block);

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

      // Visual feedback
      const copyBtn = this.queryInContainer<HTMLButtonElement>(
        block.containerId,
        '.copy-btn'
      );
      if (copyBtn) {
        copyBtn.classList.add('copied');
        copyBtn.textContent = 'Copied!';
        setTimeout(() => {
          copyBtn.classList.remove('copied');
          copyBtn.textContent = 'Copy';
        }, 1500);
      }

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

    const oldDiffedId = this._diffedId;

    if (this._diffedId === id) {
      this._diffedId = null;
    } else {
      // Close old diff
      if (oldDiffedId) {
        const oldBlock = this._blocks.get(oldDiffedId);
        if (oldBlock) {
          this.updateBlockClasses(oldBlock);
          this.updateDiffButton(oldBlock, false);
        }
      }
      this._diffedId = id;
    }

    this.updateBlockClasses(block);
    this.updateDiffButton(block, this._diffedId === id);

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
      const block = this._blocks.get(this._diffedId);
      if (block) {
        this.updateBlockClasses(block);
        this.updateDiffButton(block, false);
      }
      this._diffedId = null;
      this.publish({ 'codeblock.diffedId': null });
    }
  }

  /**
   * Remove a block
   */
  removeBlock(id: string): void {
    const block = this._blocks.get(id);
    if (!block) return;

    this.removeContainer(block.containerId, true);
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
    this.clearContainers();
    this._blocks.clear();
    this._diffedId = null;
    this._idCounter = 0;

    this.publish({
      'codeblock.blocks': [],
      'codeblock.collapsedIds': [],
      'codeblock.diffedId': null
    });
  }

  /**
   * Set edit mode (affects rendering)
   */
  setEditMode(mode: 'manual' | 'ask' | 'auto'): void {
    this._editMode = mode;
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

  // ============================================
  // Rendering
  // ============================================

  /**
   * Render a block into its shadow container
   */
  private renderBlock(block: CodeBlock): void {
    const container = this.getContainer(block.containerId);
    if (!container) return;

    const isAskOrAuto = this._editMode === 'ask' || this._editMode === 'auto';
    const showFullButtons = !isAskOrAuto || !block.isApplied;
    const appliedLabel = (isAskOrAuto && block.isApplied) ? ' (APPLIED)' : '';
    const displayLang = block.isToolOutput ? 'output' : block.language;

    const collapseIcon = block.collapsed ? '▶' : '▼';
    const collapseTitle = block.collapsed ? 'Expand' : 'Collapse';

    let actionsHtml = '';
    if (!block.isToolOutput) {
      if (showFullButtons) {
        actionsHtml = `
          <div class="actions">
            <button class="btn copy-btn" data-action="copy">Copy</button>
            <button class="btn diff-btn${this._diffedId === block.id ? ' active' : ''}" data-action="diff">Diff</button>
            <button class="btn apply-btn" data-action="apply">Apply</button>
            <button class="btn collapse-btn" data-action="collapse" title="${collapseTitle}">${collapseIcon}</button>
          </div>
        `;
      } else {
        actionsHtml = `
          <div class="actions">
            <button class="btn copy-btn" data-action="copy">Copy</button>
            <button class="btn collapse-btn" data-action="collapse" title="${collapseTitle}">${collapseIcon}</button>
          </div>
        `;
      }
    }

    // Update container classes
    this.updateBlockClasses(block);

    // Render content
    container.content.innerHTML = `
      <div class="header">
        <span class="lang">${displayLang}${appliedLabel}</span>
        ${actionsHtml}
      </div>
      <div class="content">
        <pre><code class="language-${block.language}">${this.highlightCode(block.code)}</code></pre>
      </div>
    `;

    // Bind event handlers
    this.delegateInContainer(block.containerId, 'click', '.btn', (_, el) => {
      const action = el.dataset.action;
      switch (action) {
        case 'copy':
          this.copy(block.id);
          break;
        case 'diff':
          this.toggleDiff(block.id);
          break;
        case 'apply':
          this.apply(block.id);
          break;
        case 'collapse':
          this.toggleCollapse(block.id);
          break;
      }
    });
  }

  /**
   * Update CSS classes on the container based on block state
   */
  private updateBlockClasses(block: CodeBlock): void {
    const container = this.getContainer(block.containerId);
    if (!container) return;

    container.content.classList.toggle('collapsed', block.collapsed);
    container.content.classList.toggle('diffed', this._diffedId === block.id);
    container.content.classList.toggle('tool-output', block.isToolOutput);
  }

  /**
   * Update collapse button state
   */
  private updateCollapseButton(block: CodeBlock): void {
    const btn = this.queryInContainer<HTMLButtonElement>(
      block.containerId,
      '.collapse-btn'
    );
    if (btn) {
      btn.textContent = block.collapsed ? '▶' : '▼';
      btn.title = block.collapsed ? 'Expand' : 'Collapse';
    }
  }

  /**
   * Update diff button state
   */
  private updateDiffButton(block: CodeBlock, active: boolean): void {
    const btn = this.queryInContainer<HTMLButtonElement>(
      block.containerId,
      '.diff-btn'
    );
    if (btn) {
      btn.classList.toggle('active', active);
    }
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

  // ============================================
  // Lifecycle
  // ============================================

  destroy(): void {
    this._blocks.clear();
    this._onAction = null;
    super.destroy();
  }
}
