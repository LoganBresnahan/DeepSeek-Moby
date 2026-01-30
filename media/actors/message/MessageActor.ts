/**
 * MessageActor
 *
 * Handles rendering of message bubbles in the chat interface.
 * Subscribes to streaming state to create/update messages in real-time.
 *
 * Publications:
 * - message.count: number - total number of messages
 * - message.lastId: string | null - ID of the last message
 * - message.streaming: boolean - whether a message is currently streaming
 *
 * Subscriptions:
 * - streaming.active: boolean - when streaming starts/stops
 * - streaming.content: string - streaming content updates
 * - streaming.thinking: string - streaming thinking updates
 * - streaming.messageId: string | null - current message ID
 * - streaming.model: string - model being used
 */

import { EventStateActor } from '../../state/EventStateActor';
import { EventStateManager } from '../../state/EventStateManager';
import type { ActorConfig } from '../../state/types';
import { messageStyles as styles } from './styles';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  model?: string;
  timestamp: number;
  files?: string[];
}

export interface MessageState {
  count: number;
  lastId: string | null;
  streaming: boolean;
}

export class MessageActor extends EventStateActor {
  private static stylesInjected = false;

  // Internal state
  private _messages: Message[] = [];
  private _streamingMessageId: string | null = null;
  private _streamingElement: HTMLElement | null = null;

  // Interleaving support - track segments within a response
  private _segmentCounter = 0;
  private _currentSegmentContent = '';
  private _segmentsPaused = false; // True when waiting for new segment after tools/shell

  constructor(manager: EventStateManager, element: HTMLElement) {
    const config: ActorConfig = {
      manager,
      element,
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
        // NOTE: streaming.thinking is NOT subscribed here - ThinkingActor owns thinking display
        'streaming.messageId': (value: unknown) => this.handleStreamingMessageId(value as string | null),
        'streaming.model': (value: unknown) => this.handleStreamingModel(value as string)
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
    if (MessageActor.stylesInjected) return;
    if (typeof document === 'undefined') return;

    const style = document.createElement('style');
    style.setAttribute('data-actor', 'message');
    style.textContent = styles;
    document.head.appendChild(style);
    MessageActor.stylesInjected = true;
  }

  // ============================================
  // Subscription Handlers
  // ============================================

  private handleStreamingActive(active: boolean): void {
    if (!active && this._streamingElement) {
      // Streaming ended - finalize the message
      this._streamingElement.classList.remove('streaming');
      this._streamingElement = null;

      this.publish({
        'message.streaming': false
      });
    }
  }

  private handleStreamingContent(content: string): void {
    if (!this._streamingElement) return;

    const contentEl = this._streamingElement.querySelector('.content');
    if (contentEl) {
      contentEl.innerHTML = this.formatContent(content);
    }

    // Update stored message
    const msg = this._messages.find(m => m.id === this._streamingMessageId);
    if (msg) {
      msg.content = content;
    }
  }

  private handleStreamingThinking(thinking: string): void {
    if (!this._streamingElement || !thinking) return;

    let thinkingEl = this._streamingElement.querySelector('.thinking-content');
    if (!thinkingEl && thinking) {
      // Create thinking section
      thinkingEl = document.createElement('div');
      thinkingEl.className = 'thinking-content';
      const contentEl = this._streamingElement.querySelector('.content');
      if (contentEl) {
        this._streamingElement.insertBefore(thinkingEl, contentEl);
      }
    }

    if (thinkingEl) {
      thinkingEl.innerHTML = `<div class="thinking-label">💭 Thinking...</div><div class="thinking-body">${this.escapeHtml(thinking)}</div>`;
    }

    // Update stored message
    const msg = this._messages.find(m => m.id === this._streamingMessageId);
    if (msg) {
      msg.thinking = thinking;
    }
  }

  private handleStreamingMessageId(messageId: string | null): void {
    if (messageId && !this._streamingElement) {
      // New streaming message starting - reset segment state
      this._streamingMessageId = messageId;
      this._segmentCounter = 0;
      this._currentSegmentContent = '';
      this._segmentsPaused = false;

      this.createStreamingMessage(messageId);

      this.publish({
        'message.count': this._messages.length,
        'message.lastId': messageId,
        'message.streaming': true
      });
    } else if (!messageId) {
      this._streamingMessageId = null;
      this._segmentsPaused = false;
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
   * Finalize the last streaming message with final content/thinking.
   * Called from endResponse to update the message with cleaned/final data.
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

    // Update DOM if the element exists
    const el = this.getElement().querySelector(`[data-message-id="${lastMsg.id}"]`);
    if (el) {
      // Update content
      if (options?.content !== undefined) {
        const contentEl = el.querySelector('.content');
        if (contentEl) {
          contentEl.innerHTML = this.formatContent(options.content);
        }
      }

      // Update thinking
      if (options?.thinking !== undefined) {
        let thinkingEl = el.querySelector('.thinking-content');
        if (!thinkingEl && options.thinking) {
          // Create thinking section
          thinkingEl = document.createElement('div');
          thinkingEl.className = 'thinking-content';
          const contentEl = el.querySelector('.content');
          if (contentEl) {
            el.insertBefore(thinkingEl, contentEl);
          }
        }
        if (thinkingEl) {
          thinkingEl.innerHTML = `<div class="thinking-label">💭 Thinking</div><div class="thinking-body">${this.escapeHtml(options.thinking)}</div>`;
        }
      }
    }
  }

  // ============================================
  // Interleaving Support
  // ============================================

  /**
   * Finalize the current streaming segment before tools/shell content.
   * This removes the 'streaming' class but keeps the segment visible.
   * Call this when toolCallsStart or shellExecuting arrives.
   */
  finalizeCurrentSegment(): void {
    if (!this._streamingElement) return;

    // Remove streaming class (keeps content visible)
    this._streamingElement.classList.remove('streaming');

    // Store the current content for this segment
    const msg = this._messages.find(m => m.id === this._streamingMessageId);
    if (msg) {
      // The message content stays as accumulated so far
      this._currentSegmentContent = msg.content;
    }

    // Clear the streaming element reference
    // This signals that we need a new segment for future content
    this._streamingElement = null;
    this._segmentsPaused = true;
  }

  /**
   * Resume streaming with a new segment after tools/shell content.
   * Creates a new streaming element at the current position in the chat.
   * Call this when streamToken arrives after tools/shell have started.
   */
  resumeWithNewSegment(): void {
    if (!this._streamingMessageId || !this._segmentsPaused) return;

    this._segmentCounter++;
    this._segmentsPaused = false;

    // Create a new streaming segment
    const segmentId = `${this._streamingMessageId}-seg-${this._segmentCounter}`;
    const el = document.createElement('div');
    el.className = 'message assistant streaming continuation';
    el.setAttribute('data-message-id', segmentId);
    el.setAttribute('data-parent-message', this._streamingMessageId);
    el.innerHTML = `<div class="content"></div>`;

    // Append to container (will be after tools/shell since they were added before)
    this.getElement().appendChild(el);
    this._streamingElement = el;

    // Reset segment content tracking
    this._currentSegmentContent = '';
  }

  /**
   * Check if we need to create a new segment (after tools/shell interrupted)
   */
  needsNewSegment(): boolean {
    return this._segmentsPaused && this._streamingMessageId !== null;
  }

  /**
   * Update the current segment with new content.
   * This is the incremental content for the current segment only.
   */
  updateCurrentSegmentContent(segmentContent: string): void {
    if (!this._streamingElement) return;

    const contentEl = this._streamingElement.querySelector('.content');
    if (contentEl) {
      contentEl.innerHTML = this.formatContent(segmentContent);
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
   * Add a user message
   */
  addUserMessage(content: string, files?: string[]): string {
    const id = `msg-user-${Date.now()}`;
    const message: Message = {
      id,
      role: 'user',
      content,
      timestamp: Date.now(),
      files
    };

    this._messages.push(message);
    this.renderMessage(message);

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
    const message: Message = {
      id,
      role: 'assistant',
      content,
      thinking: options?.thinking,
      model: options?.model,
      timestamp: options?.timestamp || Date.now()
    };

    this._messages.push(message);
    this.renderMessage(message);

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
    const message: Message = {
      id: messageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now()
    };

    this._messages.push(message);

    const el = document.createElement('div');
    el.className = 'message assistant streaming';
    el.setAttribute('data-message-id', messageId);
    el.innerHTML = `
      <div class="role">DEEPSEEK MOBY</div>
      <div class="content"></div>
    `;

    this.getElement().appendChild(el);
    this._streamingElement = el;
  }

  /**
   * Render a complete message
   */
  private renderMessage(message: Message): void {
    const el = document.createElement('div');
    el.className = `message ${message.role}`;
    el.setAttribute('data-message-id', message.id);

    const roleLabel = message.role === 'user' ? 'YOU' : 'DEEPSEEK MOBY';

    let html = `<div class="role">${roleLabel}</div>`;

    // Files
    if (message.files && message.files.length > 0) {
      html += `<div class="message-files">`;
      for (const file of message.files) {
        html += `<span class="message-file-tag">📄 ${this.escapeHtml(file)}</span>`;
      }
      html += `</div>`;
    }

    // Thinking (for assistant messages)
    if (message.thinking) {
      html += `
        <div class="thinking-content">
          <div class="thinking-label">💭 Thinking</div>
          <div class="thinking-body">${this.escapeHtml(message.thinking)}</div>
        </div>
      `;
    }

    // Content
    html += `<div class="content">${this.formatContent(message.content)}</div>`;

    el.innerHTML = html;
    this.getElement().appendChild(el);
  }

  /**
   * Format message content with markdown support
   */
  private formatContent(content: string): string {
    if (!content) return '';

    // Process fenced code blocks first (```language\ncode\n```)
    let result = content.replace(
      /```(\w*)\n([\s\S]*?)```/g,
      (_, lang, code) => {
        const language = lang || 'text';
        const escapedCode = this.escapeHtml(code.trimEnd());
        return `<div class="code-block">
          <div class="code-header">
            <span class="code-lang">${language}</span>
            <div class="code-actions">
              <button class="code-action-btn copy-btn" onclick="navigator.clipboard.writeText(this.closest('.code-block').querySelector('code').textContent)">Copy</button>
            </div>
          </div>
          <pre><code class="language-${language}">${escapedCode}</code></pre>
        </div>`;
      }
    );

    // Process inline code (`code`)
    result = result.replace(
      /`([^`\n]+)`/g,
      (_, code) => `<code class="inline">${this.escapeHtml(code)}</code>`
    );

    // Escape remaining HTML and convert newlines (outside code blocks)
    // Split by code blocks, process non-code parts
    const parts = result.split(/(<div class="code-block">[\s\S]*?<\/div>)/g);
    result = parts.map(part => {
      if (part.startsWith('<div class="code-block">')) {
        return part; // Already processed
      }
      // Process regular text: escape HTML entities that aren't already part of our formatting
      return part
        .replace(/&(?!lt;|gt;|amp;|quot;)/g, '&amp;')
        .replace(/<(?!code|\/code|div|\/div|pre|\/pre|button|\/button|span|\/span|br)/g, '&lt;')
        .replace(/\n/g, '<br>');
    }).join('');

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

  /**
   * Clear all messages
   * Note: Only removes message elements, preserves other actors' content in the container
   */
  clear(): void {
    this._messages = [];
    this._streamingMessageId = null;
    this._streamingElement = null;

    // Only remove message elements, not the entire container
    // This preserves content from other actors (ToolCalls, Shell, Thinking)
    const container = this.getElement();
    const messages = container.querySelectorAll('.message');
    messages.forEach(msg => msg.remove());

    this.publish({
      'message.count': 0,
      'message.lastId': null,
      'message.streaming': false
    });
  }

  /**
   * Get message by ID
   */
  getMessage(id: string): Message | undefined {
    return this._messages.find(m => m.id === id);
  }

  /**
   * Get all messages
   */
  getMessages(): Message[] {
    return [...this._messages];
  }

  /**
   * Get current state
   */
  getState(): MessageState {
    return {
      count: this._messages.length,
      lastId: this._messages.length > 0
        ? this._messages[this._messages.length - 1].id
        : null,
      streaming: this._streamingMessageId !== null
    };
  }

  /**
   * Reset styles injection flag and remove style tag (for testing)
   */
  static resetStylesInjected(): void {
    MessageActor.stylesInjected = false;
    if (typeof document !== 'undefined') {
      const styleTag = document.querySelector('style[data-actor="message"]');
      if (styleTag) {
        styleTag.remove();
      }
    }
  }
}
