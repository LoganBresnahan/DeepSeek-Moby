/**
 * MessageShadowActor
 *
 * Interleaved Shadow DOM version of MessageActor.
 * Each message segment gets its own shadow container, allowing proper
 * interleaving with thinking/shell/tools content.
 *
 * Architecture:
 * - Each user message = one shadow container
 * - Each assistant message segment = one shadow container
 * - Containers are siblings in chatMessages, interleaved with other actors
 * - DOM order = visual order
 *
 * Publications:
 * - message.count: number - total number of messages
 * - message.lastId: string | null - ID of the last message
 * - message.streaming: boolean - whether a message is currently streaming
 *
 * Subscriptions:
 * - streaming.active: boolean - when streaming starts/stops
 * - streaming.content: string - streaming content updates
 * - streaming.messageId: string | null - current message ID
 * - streaming.model: string - model being used
 */

import { InterleavedShadowActor, ShadowContainer } from '../../state/InterleavedShadowActor';
import { EventStateManager } from '../../state/EventStateManager';
import { messageShadowStyles } from './shadowStyles';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  model?: string;
  timestamp: number;
  files?: string[];
  containerId?: string;
}

export interface MessageState {
  count: number;
  lastId: string | null;
  streaming: boolean;
}

export class MessageShadowActor extends InterleavedShadowActor {
  // Internal state
  private _messages: Message[] = [];
  private _streamingMessageId: string | null = null;
  private _streamingContainerId: string | null = null;

  // Interleaving support
  private _segmentCounter = 0;
  private _currentSegmentContent = '';
  private _segmentsPaused = false;
  private _useDirectContentUpdates = false;

  // Edit mode for code block collapse behavior
  private _editMode: 'manual' | 'ask' | 'auto' = 'manual';

  constructor(manager: EventStateManager, element: HTMLElement) {
    super({
      manager,
      element,
      actorName: 'message',
      containerStyles: messageShadowStyles,
      publications: {
        'message.count': () => this._messages.length,
        'message.lastId': () => this._messages.length > 0
          ? this._messages[this._messages.length - 1].id
          : null,
        'message.streaming': () => this._streamingMessageId !== null
      },
      subscriptions: {
        'streaming.active': (value: unknown) => this.handleStreamingActive(value as boolean),
        'streaming.content': (value: unknown) => this.handleStreamingContent(value as string),
        'streaming.messageId': (value: unknown) => this.handleStreamingMessageId(value as string | null),
        'streaming.model': (value: unknown) => this.handleStreamingModel(value as string)
      }
    });
  }

  // ============================================
  // Subscription Handlers
  // ============================================

  private handleStreamingActive(active: boolean): void {
    if (!active && this._streamingContainerId) {
      // Streaming ended - finalize the message
      const container = this.getContainer(this._streamingContainerId);
      if (container) {
        container.host.classList.remove('streaming');
      }
      this._streamingContainerId = null;
      this._useDirectContentUpdates = false;

      this.publish({
        'message.streaming': false
      });
    }
  }

  private handleStreamingContent(content: string): void {
    if (!this._streamingContainerId) return;

    // Skip pub/sub content updates when direct content management is active
    if (this._useDirectContentUpdates) return;

    const container = this.getContainer(this._streamingContainerId);
    if (container) {
      const contentEl = container.content.querySelector('.content');
      if (contentEl) {
        contentEl.innerHTML = this.formatContent(content);
      }
    }

    // Update stored message
    const msg = this._messages.find(m => m.id === this._streamingMessageId);
    if (msg) {
      msg.content = content;
    }
  }

  private handleStreamingMessageId(messageId: string | null): void {
    if (messageId && !this._streamingContainerId) {
      // New streaming message starting - reset segment state
      this._streamingMessageId = messageId;
      this._segmentCounter = 0;
      this._currentSegmentContent = '';
      this._segmentsPaused = false;
      this._useDirectContentUpdates = false;

      this.createStreamingMessage(messageId);

      this.publish({
        'message.count': this._messages.length,
        'message.lastId': messageId,
        'message.streaming': true
      });
    } else if (!messageId) {
      this._streamingMessageId = null;
      this._segmentsPaused = false;
      this._useDirectContentUpdates = false;
    }
  }

  private handleStreamingModel(model: string): void {
    const msg = this._messages.find(m => m.id === this._streamingMessageId);
    if (msg) {
      msg.model = model;
    }
  }

  // ============================================
  // Message Management
  // ============================================

  /**
   * Finalize the last streaming message with final content/thinking
   */
  finalizeLastMessage(options?: {
    content?: string;
    thinking?: string;
    model?: string;
  }): void {
    if (this._messages.length === 0) return;

    const lastMsg = this._messages[this._messages.length - 1];
    if (lastMsg.role !== 'assistant') return;

    // Update message data
    if (options?.content !== undefined) {
      lastMsg.content = options.content;
    }
    if (options?.thinking !== undefined) {
      lastMsg.thinking = options.thinking;
    }
    if (options?.model !== undefined) {
      lastMsg.model = options.model;
    }

    // Update DOM if the container exists
    if (lastMsg.containerId) {
      const container = this.getContainer(lastMsg.containerId);
      if (container) {
        // Update content
        if (options?.content !== undefined) {
          const contentEl = container.content.querySelector('.content');
          if (contentEl) {
            contentEl.innerHTML = this.formatContent(options.content);
          }
        }
      }
    }
  }

  // ============================================
  // Interleaving Support
  // ============================================

  /**
   * Finalize the current streaming segment before tools/shell content
   */
  finalizeCurrentSegment(): void {
    if (!this._streamingContainerId) return;

    const container = this.getContainer(this._streamingContainerId);
    if (container) {
      container.host.classList.remove('streaming');
    }

    const msg = this._messages.find(m => m.id === this._streamingMessageId);
    if (msg) {
      this._currentSegmentContent = msg.content;
    }

    this._streamingContainerId = null;
    this._segmentsPaused = true;
  }

  /**
   * Resume streaming with a new segment after tools/shell content.
   * Creates a NEW shadow container for the continuation, allowing
   * proper interleaving with thinking/shell content.
   */
  resumeWithNewSegment(): void {
    if (!this._streamingMessageId || !this._segmentsPaused) return;

    this._segmentCounter++;
    this._segmentsPaused = false;

    const segmentId = `${this._streamingMessageId}-seg-${this._segmentCounter}`;

    // Create a new shadow container for the continuation segment
    const container = this.createContainer('message', {
      hostClasses: ['assistant', 'continuation', 'streaming'],
      dataAttributes: {
        'message-id': segmentId,
        'parent-message': this._streamingMessageId
      }
    });

    // Render the continuation message structure
    container.content.innerHTML = `
      <div class="message assistant continuation">
        <div class="content"></div>
      </div>
    `;

    this._streamingContainerId = container.id;
    this._currentSegmentContent = '';

    // Setup code block handlers for this container
    this.setupCodeBlockHandlersForContainer(container.id);
  }

  /**
   * Check if we need to create a new segment
   */
  needsNewSegment(): boolean {
    return this._segmentsPaused && this._streamingMessageId !== null;
  }

  /**
   * Update the current segment with new content
   */
  updateCurrentSegmentContent(segmentContent: string): void {
    if (!this._streamingContainerId) return;

    this._useDirectContentUpdates = true;

    const container = this.getContainer(this._streamingContainerId);
    if (container) {
      const contentEl = container.content.querySelector('.content');
      if (contentEl) {
        contentEl.innerHTML = this.formatContent(segmentContent);
      }
    }

    this._currentSegmentContent = segmentContent;
  }

  /**
   * Get the content accumulated in the current segment
   */
  getCurrentSegmentContent(): string {
    return this._currentSegmentContent;
  }

  /**
   * Check if currently streaming
   */
  isStreaming(): boolean {
    return this._streamingMessageId !== null;
  }

  /**
   * Set edit mode
   */
  setEditMode(mode: 'manual' | 'ask' | 'auto'): void {
    this._editMode = mode;
  }

  /**
   * Get current edit mode
   */
  getEditMode(): 'manual' | 'ask' | 'auto' {
    return this._editMode;
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Add a user message
   */
  addUserMessage(content: string, files?: string[]): string {
    const id = `msg-user-${Date.now()}`;

    // Create shadow container for this message
    const container = this.createContainer('message', {
      hostClasses: ['user'],
      dataAttributes: { 'message-id': id }
    });

    const message: Message = {
      id,
      role: 'user',
      content,
      timestamp: Date.now(),
      files,
      containerId: container.id
    };

    console.log('[MessageShadowActor] addUserMessage:', content.substring(0, 50), 'id:', id, 'containerId:', container.id);

    this._messages.push(message);
    this.renderMessageInContainer(message, container);

    this.publish({
      'message.count': this._messages.length,
      'message.lastId': id
    });

    return id;
  }

  /**
   * Add a complete assistant message (from history)
   */
  addAssistantMessage(content: string, options?: {
    id?: string;
    thinking?: string;
    model?: string;
    timestamp?: number;
  }): string {
    const id = options?.id || `msg-assistant-${Date.now()}`;

    // Create shadow container for this message
    const container = this.createContainer('message', {
      hostClasses: ['assistant'],
      dataAttributes: { 'message-id': id }
    });

    const message: Message = {
      id,
      role: 'assistant',
      content,
      thinking: options?.thinking,
      model: options?.model,
      timestamp: options?.timestamp || Date.now(),
      containerId: container.id
    };

    this._messages.push(message);
    this.renderMessageInContainer(message, container);

    // Setup code block handlers
    this.setupCodeBlockHandlersForContainer(container.id);

    this.publish({
      'message.count': this._messages.length,
      'message.lastId': id
    });

    return id;
  }

  /**
   * Create a streaming message element
   */
  private createStreamingMessage(messageId: string): void {
    // Create shadow container for this streaming message
    const container = this.createContainer('message', {
      hostClasses: ['assistant', 'streaming'],
      dataAttributes: { 'message-id': messageId }
    });

    const message: Message = {
      id: messageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      containerId: container.id
    };

    this._messages.push(message);

    // Render initial streaming structure
    container.content.innerHTML = `
      <div class="message assistant streaming">
        <div class="role">DEEPSEEK MOBY</div>
        <div class="content"></div>
      </div>
    `;

    this._streamingContainerId = container.id;

    // Setup code block handlers
    this.setupCodeBlockHandlersForContainer(container.id);
  }

  /**
   * Render a complete message into a container
   */
  private renderMessageInContainer(message: Message, container: ShadowContainer): void {
    const roleLabel = message.role === 'user' ? 'YOU' : 'DEEPSEEK MOBY';
    const roleClass = message.role;

    let html = `<div class="message ${roleClass}">`;
    html += `<div class="role">${roleLabel}</div>`;

    // Files
    if (message.files && message.files.length > 0) {
      html += `<div class="files">`;
      for (const file of message.files) {
        html += `<span class="file-tag">📄 ${this.escapeHtml(file)}</span>`;
      }
      html += `</div>`;
    }

    // Content
    html += `<div class="content">${this.formatContent(message.content)}</div>`;
    html += `</div>`;

    container.content.innerHTML = html;
  }

  /**
   * Setup code block handlers for a specific container
   */
  private setupCodeBlockHandlersForContainer(containerId: string): void {
    // Collapse toggle
    this.delegateInContainer(containerId, 'click', '.collapse-toggle-btn', (e, btn) => {
      const codeBlock = btn.closest('.code-block');
      if (codeBlock) {
        const isCollapsed = codeBlock.classList.toggle('collapsed');
        btn.textContent = isCollapsed ? '▶' : '▼';
        btn.title = isCollapsed ? 'Expand' : 'Collapse';
      }
    });

    // Copy button
    this.delegateInContainer(containerId, 'click', '.copy-btn', (e, btn) => {
      const codeBlock = btn.closest('.code-block');
      const code = codeBlock?.querySelector('code')?.textContent;
      if (code) {
        navigator.clipboard.writeText(code);
        btn.textContent = 'Copied!';
        setTimeout(() => {
          btn.textContent = 'Copy';
        }, 1500);
      }
    });
  }

  /**
   * Format message content with markdown support
   */
  private formatContent(content: string): string {
    if (!content) return '';

    const shouldCollapse = this._editMode === 'ask' || this._editMode === 'auto';

    // Process fenced code blocks
    let result = content.replace(
      /```(\w*)\n([\s\S]*?)```/g,
      (_, lang, code) => {
        const language = lang || 'text';
        const escapedCode = this.escapeHtml(code.trimEnd());
        const collapsedClass = shouldCollapse ? ' collapsed' : '';
        const collapseIcon = shouldCollapse ? '▶' : '▼';
        const collapseTitle = shouldCollapse ? 'Expand' : 'Collapse';
        return `<div class="code-block${collapsedClass}">
          <div class="code-header">
            <span class="code-lang">${language}</span>
            <div class="code-actions">
              <button class="code-action-btn copy-btn">Copy</button>
              <button class="code-action-btn collapse-toggle-btn" title="${collapseTitle}">${collapseIcon}</button>
            </div>
          </div>
          <pre><code class="language-${language}">${escapedCode}</code></pre>
        </div>`;
      }
    );

    // Process inline code
    result = result.replace(
      /`([^`\n]+)`/g,
      '<code class="inline-code">$1</code>'
    );

    // Process bold
    result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Process italic
    result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Process line breaks
    result = result.replace(/\n/g, '<br>');

    return result;
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
  // State Access
  // ============================================

  /**
   * Get all messages
   */
  getMessages(): Message[] {
    return [...this._messages];
  }

  /**
   * Clear all messages
   */
  clear(): void {
    this.clearContainers();
    this._messages = [];
    this._streamingMessageId = null;
    this._streamingContainerId = null;
    this._segmentCounter = 0;
    this._currentSegmentContent = '';
    this._segmentsPaused = false;

    this.publish({
      'message.count': 0,
      'message.lastId': null,
      'message.streaming': false
    });
  }

  // ============================================
  // Lifecycle
  // ============================================

  destroy(): void {
    this._messages = [];
    this._streamingMessageId = null;
    this._streamingContainerId = null;
    super.destroy();
  }
}
