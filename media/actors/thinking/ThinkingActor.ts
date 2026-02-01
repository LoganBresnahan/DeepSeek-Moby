/**
 * ThinkingActor
 *
 * Manages display of reasoning/thinking content from DeepSeek Reasoner (R1).
 * Shows collapsible sections with chain-of-thought reasoning.
 *
 * Uses dynamic element positioning - creates iteration containers on demand
 * and appends them to the parent element at the current position.
 * This allows thinking to appear inline with the response flow.
 *
 * Extends InterleavedContentActor for shared container management.
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

import { InterleavedContentActor } from '../../state/InterleavedContentActor';
import { EventStateManager } from '../../state/EventStateManager';
import { thinkingStyles as styles } from './styles';

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

export class ThinkingActor extends InterleavedContentActor {
  // Internal state
  private _iterations: ThinkingIteration[] = [];
  private _expandedIndices: Set<number> = new Set();
  private _streaming = false;
  private _currentIteration = 0;

  constructor(manager: EventStateManager, element: HTMLElement) {
    super({
      manager,
      element,
      publications: {
        'thinking.content': () => this.getCurrentContent(),
        'thinking.iterations': () => [...this._iterations],
        'thinking.expanded': () => [...this._expandedIndices],
        'thinking.streaming': () => this._streaming
      },
      subscriptions: {
        'streaming.thinking': (value: unknown) => this.handleStreamingThinking(value as string),
        'streaming.active': (value: unknown) => this.handleStreamingActive(value as boolean)
      },
      actorName: 'thinking',
      containerClassName: 'thinking-iteration-wrapper',
      styles
    });
    // Don't render on construction - only when iterations are started
  }

  // ============================================
  // Subscription Handlers
  // ============================================

  private handleStreamingThinking(content: string): void {
    if (!content) return;

    this._streaming = true;

    // Update current iteration content
    if (this._iterations.length === 0) {
      this.startIteration();
    }

    const currentIdx = this._currentIteration;
    const iteration = this._iterations.find(i => i.index === currentIdx);
    if (iteration) {
      iteration.content = content;
    }

    // Only render the current iteration, not all of them
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
   * Start a new thinking iteration
   * Creates a new container element and appends it to the parent at the current position
   */
  startIteration(): number {
    this._currentIteration++;

    // Create container using base class method
    const container = this.createContainer(
      'thinking-iteration',
      [],
      { iteration: this._currentIteration.toString() }
    );

    this._iterations.push({
      index: this._currentIteration,
      content: '',
      complete: false,
      containerId: container.id
    });

    // Keep collapsed by default - user can expand if interested
    // (removed auto-expand during streaming)

    // If we now have multiple iterations, update all iteration labels
    // (they change from "Chain of Thought" to "Thinking (Iteration N)")
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

      // Already collapsed by default, just render the final state
      this.renderIteration(this._currentIteration);
      this.publish({
        'thinking.iterations': [...this._iterations],
        'thinking.expanded': [...this._expandedIndices]
      });
    }
  }

  /**
   * Toggle expansion of an iteration
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
   * Removes all iteration containers from the DOM
   */
  clear(): void {
    // Use base class container cleanup
    this.clearContainers();

    this._iterations = [];
    this._expandedIndices.clear();
    this._streaming = false;
    this._currentIteration = 0;

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
   * Render all iterations (used for bulk expand/collapse)
   */
  private renderAllIterations(): void {
    this._iterations.forEach(iteration => {
      this.renderIteration(iteration.index);
    });
  }

  /**
   * Render a single iteration into its container
   * If the structure already exists and we're just updating content, only update the body
   * This preserves click handlers and prevents flickering during streaming
   */
  private renderIteration(index: number): void {
    const iteration = this._iterations.find(i => i.index === index);
    if (!iteration) return;

    const container = this.getContainer(iteration.containerId);
    if (!container) return;

    const isExpanded = this._expandedIndices.has(iteration.index);
    const isStreaming = this._streaming && iteration.index === this._currentIteration;

    // Check if structure already exists
    const existingContainer = container.element.querySelector('.thinking-container');

    if (existingContainer) {
      // Just update the necessary parts without replacing the whole structure
      // This preserves click handlers and prevents flickering

      // Update collapsed/streaming state via classes
      existingContainer.classList.toggle('collapsed', !isExpanded);
      existingContainer.classList.toggle('streaming', isStreaming);

      // Update label if needed (for iteration count changes)
      const label = this._iterations.length > 1
        ? `Thinking (Iteration ${iteration.index})`
        : 'Chain of Thought';
      const labelEl = existingContainer.querySelector('.thinking-label');
      if (labelEl && labelEl.textContent !== label) {
        labelEl.textContent = label;
      }

      // Update body content
      const body = existingContainer.querySelector('.thinking-body');
      if (body) {
        body.innerHTML = this.formatContent(iteration.content);
        // Auto-scroll if streaming and expanded
        if (isStreaming && isExpanded) {
          body.scrollTop = body.scrollHeight;
        }
      }
    } else {
      // First render - create the full structure
      const label = this._iterations.length > 1
        ? `Thinking (Iteration ${iteration.index})`
        : 'Chain of Thought';

      const classes = [
        'thinking-container',
        isExpanded ? '' : 'collapsed',
        isStreaming ? 'streaming' : ''
      ].filter(Boolean).join(' ');

      container.element.innerHTML = `
        <div class="${classes}" id="thinking-${iteration.index}">
          <div class="thinking-header">
            <span class="thinking-icon">💭</span>
            <span class="thinking-label">${label}</span>
            <span class="thinking-toggle">▼</span>
          </div>
          <div class="thinking-body">${this.formatContent(iteration.content)}</div>
        </div>
      `;

      // Bind click handler for this iteration (only once on creation)
      const header = container.element.querySelector('.thinking-header');
      if (header) {
        header.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggleExpanded(iteration.index);
        });
      }
    }
  }

  /**
   * Format thinking content (basic text formatting)
   */
  private formatContent(content: string): string {
    if (!content) return '';

    // Escape HTML
    let formatted = this.escapeHtml(content);

    // Convert code blocks (```...```)
    formatted = formatted.replace(/```(\w*)\n?([\s\S]*?)```/g, (match, lang, code) => {
      return `<pre><code>${code.trim()}</code></pre>`;
    });

    // Convert inline code (`...`)
    formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');

    return formatted;
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
   * Removes all iteration containers from the DOM
   */
  destroy(): void {
    this._iterations = [];
    this._expandedIndices.clear();
    super.destroy();
  }

  /**
   * Reset styles injection flag and remove style tag (for testing)
   */
  static resetStylesInjected(): void {
    InterleavedContentActor.resetStylesInjectedFor('thinking');
  }
}
