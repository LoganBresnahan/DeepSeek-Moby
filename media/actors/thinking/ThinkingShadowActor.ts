/**
 * ThinkingShadowActor
 *
 * Shadow DOM version of ThinkingActor.
 * Manages display of reasoning/thinking content from DeepSeek Reasoner (R1).
 * Shows collapsible sections with chain-of-thought reasoning.
 *
 * Each thinking iteration gets its own Shadow DOM for complete style isolation.
 * No z-index coordination needed, no class name prefixes required.
 *
 * Publications:
 * - thinking.content: string - current thinking content
 * - thinking.iterations: ThinkingIteration[] - all thinking iterations
 * - thinking.expanded: Set<number> - which iterations are expanded
 * - thinking.streaming: boolean - whether currently streaming thinking
 *
 * Subscriptions:
 * - streaming.thinking: string - thinking content from streaming
 * - streaming.active: boolean - track streaming state
 */

import { InterleavedShadowActor } from '../../state/InterleavedShadowActor';
import { EventStateManager } from '../../state/EventStateManager';
import { thinkingShadowStyles } from './shadowStyles';

export interface ThinkingIteration {
  index: number;
  content: string;
  complete: boolean;
  containerId: string;
}

export interface ThinkingState {
  content: string;
  iterations: ThinkingIteration[];
  expandedIndices: number[];
  streaming: boolean;
}

export class ThinkingShadowActor extends InterleavedShadowActor {
  // Internal state
  private _iterations: ThinkingIteration[] = [];
  private _expandedIndices: Set<number> = new Set();
  private _streaming = false;
  private _currentIteration = 0;
  // Track the accumulated thinking length when each iteration starts
  // This allows us to extract only the current iteration's content from the full accumulated string
  private _iterationBaseOffset = 0;
  private _lastKnownThinkingLength = 0;

  constructor(manager: EventStateManager, element: HTMLElement) {
    super({
      manager,
      element,
      actorName: 'thinking',
      containerStyles: thinkingShadowStyles,
      publications: {
        'thinking.content': () => this.getCurrentContent(),
        'thinking.iterations': () => [...this._iterations],
        'thinking.expanded': () => [...this._expandedIndices],
        'thinking.streaming': () => this._streaming
      },
      subscriptions: {
        'streaming.thinking': (value: unknown) => this.handleStreamingThinking(value as string),
        'streaming.active': (value: unknown) => this.handleStreamingActive(value as boolean)
      }
    });
  }

  // ============================================
  // Subscription Handlers
  // ============================================

  private handleStreamingThinking(content: string): void {
    console.log('[ThinkingShadowActor] Received streaming.thinking, content length:', content?.length || 0, 'baseOffset:', this._iterationBaseOffset);
    if (!content) return;

    this._streaming = true;

    // Start iteration if needed (auto-expand happens in startIteration)
    if (this._iterations.length === 0) {
      console.log('[ThinkingShadowActor] Starting first iteration via subscription');
      this.startIteration();
    }

    // Track total length for next iteration's base offset
    this._lastKnownThinkingLength = content.length;

    // Update current iteration content - only use content AFTER the base offset
    // This ensures each iteration only shows its own thinking, not accumulated from previous iterations
    const currentIdx = this._currentIteration;
    const iteration = this._iterations.find(i => i.index === currentIdx);
    if (iteration) {
      const iterationContent = content.slice(this._iterationBaseOffset);
      console.log('[ThinkingShadowActor] Setting iteration', currentIdx, 'content from offset', this._iterationBaseOffset, 'length:', iterationContent.length);
      iteration.content = iterationContent;
    }

    // Render only the current iteration
    this.renderIteration(currentIdx);

    this.publish({
      'thinking.content': this.getCurrentContent(),
      'thinking.iterations': [...this._iterations],
      'thinking.streaming': true
    });
  }

  private handleStreamingActive(active: boolean): void {
    if (!active && this._streaming) {
      // Mark current iteration as complete
      const iteration = this._iterations.find(i => i.index === this._currentIteration);
      if (iteration) {
        iteration.complete = true;
      }

      this._streaming = false;
      this.renderIteration(this._currentIteration);
      this.publish({
        'thinking.streaming': false,
        'thinking.iterations': [...this._iterations]
      });
    }
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Start a new thinking iteration.
   * Creates a new shadow-encapsulated container.
   */
  startIteration(): number {
    this._currentIteration++;

    // Set the base offset for this iteration to the current accumulated thinking length
    // This ensures we only show content from THIS iteration, not previous ones
    this._iterationBaseOffset = this._lastKnownThinkingLength;
    console.log('[ThinkingShadowActor] Creating container for iteration', this._currentIteration, 'baseOffset:', this._iterationBaseOffset);

    // Iterations start collapsed by default - user can click to expand
    // (Previously auto-expanded which broke scroll tracking)

    // Create shadow-encapsulated container
    const container = this.createContainer('thinking', {
      dataAttributes: { iteration: this._currentIteration.toString() }
    });

    // Add entering animation only (starts collapsed)
    container.content.classList.add('entering');

    // Debug: Log container position and visibility
    const childIndex = Array.from(this.element.children).indexOf(container.host);
    const rect = container.host.getBoundingClientRect();
    console.log('[ThinkingShadowActor] Container created:', container.id,
      'childIndex:', childIndex, 'of', this.element.children.length,
      'rect:', { top: rect.top, height: rect.height, visible: rect.height > 0 });

    this._iterations.push({
      index: this._currentIteration,
      content: '',
      complete: false,
      containerId: container.id
    });

    // If multiple iterations, update all labels
    if (this._iterations.length > 1) {
      this.renderAllIterations();
    } else {
      this.renderIteration(this._currentIteration);
    }

    this.publish({
      'thinking.iterations': [...this._iterations],
      'thinking.expanded': [...this._expandedIndices]
    });

    return this._currentIteration;
  }

  /**
   * Append content to current iteration
   */
  appendContent(text: string): void {
    const iteration = this._iterations.find(i => i.index === this._currentIteration);
    if (iteration) {
      iteration.content += text;
      this.renderIteration(this._currentIteration);
      this.publish({
        'thinking.content': this.getCurrentContent(),
        'thinking.iterations': [...this._iterations]
      });
    }
  }

  /**
   * Set content for specific iteration
   */
  setIterationContent(index: number, content: string): void {
    const iteration = this._iterations.find(i => i.index === index);
    if (iteration) {
      iteration.content = content;
      this.renderIteration(index);
      this.publish({
        'thinking.content': this.getCurrentContent(),
        'thinking.iterations': [...this._iterations]
      });
    }
  }

  /**
   * Complete current iteration
   */
  completeIteration(): void {
    const iteration = this._iterations.find(i => i.index === this._currentIteration);
    if (iteration) {
      iteration.complete = true;
      this.renderIteration(this._currentIteration);
      this.publish({
        'thinking.iterations': [...this._iterations],
        'thinking.expanded': [...this._expandedIndices]
      });
    }
  }

  /**
   * Toggle expansion of an iteration.
   */
  toggleExpanded(index: number): void {
    if (this._expandedIndices.has(index)) {
      this._expandedIndices.delete(index);
    } else {
      this._expandedIndices.add(index);
    }

    this.renderIteration(index);
    this.publish({ 'thinking.expanded': [...this._expandedIndices] });
  }

  /**
   * Expand an iteration
   */
  expand(index: number): void {
    if (!this._expandedIndices.has(index)) {
      this._expandedIndices.add(index);
      this.renderIteration(index);
      this.publish({ 'thinking.expanded': [...this._expandedIndices] });
    }
  }

  /**
   * Collapse an iteration
   */
  collapse(index: number): void {
    if (this._expandedIndices.has(index)) {
      this._expandedIndices.delete(index);
      this.renderIteration(index);
      this.publish({ 'thinking.expanded': [...this._expandedIndices] });
    }
  }

  /**
   * Expand all iterations
   */
  expandAll(): void {
    this._iterations.forEach(i => this._expandedIndices.add(i.index));
    this.renderAllIterations();
    this.publish({ 'thinking.expanded': [...this._expandedIndices] });
  }

  /**
   * Collapse all iterations
   */
  collapseAll(): void {
    this._expandedIndices.clear();
    this.renderAllIterations();
    this.publish({ 'thinking.expanded': [] });
  }

  /**
   * Clear all thinking content
   */
  clear(): void {
    this.clearContainers();

    this._iterations = [];
    this._expandedIndices.clear();
    this._streaming = false;
    this._currentIteration = 0;
    this._iterationBaseOffset = 0;
    this._lastKnownThinkingLength = 0;

    this.publish({
      'thinking.content': '',
      'thinking.iterations': [],
      'thinking.expanded': [],
      'thinking.streaming': false
    });
  }

  /**
   * Get current state
   */
  getState(): ThinkingState {
    return {
      content: this.getCurrentContent(),
      iterations: [...this._iterations],
      expandedIndices: [...this._expandedIndices],
      streaming: this._streaming
    };
  }

  /**
   * Get current iteration content
   */
  getCurrentContent(): string {
    const iteration = this._iterations.find(i => i.index === this._currentIteration);
    return iteration?.content || '';
  }

  /**
   * Get all iterations
   */
  getIterations(): ThinkingIteration[] {
    return [...this._iterations];
  }

  /**
   * Check if has any thinking content
   */
  hasContent(): boolean {
    return this._iterations.some(i => i.content.length > 0);
  }

  /**
   * Check if currently streaming
   */
  isStreaming(): boolean {
    return this._streaming;
  }

  // ============================================
  // Rendering
  // ============================================

  /**
   * Render all iterations
   */
  private renderAllIterations(): void {
    this._iterations.forEach(iteration => {
      this.renderIteration(iteration.index);
    });
  }

  /**
   * Render a single iteration into its shadow container.
   * Uses incremental updates to preserve event handlers.
   * Note: container.content already has class="container" from base class.
   */
  private renderIteration(index: number): void {
    const iteration = this._iterations.find(i => i.index === index);
    if (!iteration) {
      console.warn('[ThinkingShadowActor] renderIteration: iteration not found for index', index);
      return;
    }

    const container = this.getContainer(iteration.containerId);
    if (!container) {
      console.warn('[ThinkingShadowActor] renderIteration: container not found for', iteration.containerId);
      return;
    }

    // Check expansion state
    const isExpanded = this._expandedIndices.has(iteration.index);
    const isStreaming = this._streaming && iteration.index === this._currentIteration;
    console.log('[ThinkingShadowActor] renderIteration', index, 'expanded:', isExpanded, 'streaming:', isStreaming, 'contentLen:', iteration.content.length);

    // Apply state classes
    container.content.classList.toggle('expanded', isExpanded);
    container.content.classList.toggle('streaming', isStreaming);

    const toggleIcon = isExpanded ? '−' : '+';
    const label = this.getIterationLabel(iteration);
    const preview = this.getPreviewText(iteration.content, isExpanded);

    // Check if structure already exists (header element)
    const existingHeader = container.content.querySelector('.header');

    if (existingHeader) {
      // Incremental update - preserve event handlers
      const toggleEl = container.content.querySelector('.toggle');
      if (toggleEl) toggleEl.textContent = toggleIcon;

      const labelEl = container.content.querySelector('.label');
      if (labelEl) labelEl.textContent = label;

      const previewEl = container.content.querySelector('.preview');
      if (previewEl) previewEl.textContent = preview;

      // Update body content
      const body = container.content.querySelector('.body');
      if (body) {
        body.innerHTML = this.formatContent(iteration.content);
        if (isStreaming && isExpanded) {
          body.scrollTop = body.scrollHeight;
        }
      }
    } else {
      // First render - clean HTML with dotted border from CSS
      container.content.innerHTML = `
<div class="header">
  <span class="toggle">${toggleIcon}</span>
  <span class="emoji">💭</span>
  <span class="label">${label}</span>
  <span class="preview">${preview}</span>
</div>
<div class="body">${this.formatContent(iteration.content)}</div>`;

      // Bind click handler to header only
      const header = container.content.querySelector('.header');
      header?.addEventListener('click', () => {
        this.toggleExpanded(iteration.index);
      });
    }
  }

  /**
   * Get label for iteration
   */
  private getIterationLabel(iteration: ThinkingIteration): string {
    if (this._streaming && iteration.index === this._currentIteration) {
      return 'Thinking...';
    }
    return iteration.complete ? 'Thought' : 'Thinking...';
  }

  /**
   * Get preview text for collapsed state
   */
  private getPreviewText(content: string, isExpanded: boolean): string {
    if (isExpanded || !content) return '';
    const firstLine = content.split('\n')[0].trim();
    const preview = firstLine.slice(0, 50);
    return preview.length < firstLine.length ? `  ${preview}...` : `  ${preview}`;
  }

  /**
   * Format thinking content
   */
  private formatContent(content: string): string {
    if (!content) return '';

    let formatted = this.escapeHtml(content);

    // Code blocks
    formatted = formatted.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      return `<pre><code>${code.trim()}</code></pre>`;
    });

    // Inline code
    formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');

    return formatted;
  }

  /**
   * Escape HTML
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
    this._iterations = [];
    this._expandedIndices.clear();
    super.destroy();
  }
}
