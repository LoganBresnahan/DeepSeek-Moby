/**
 * StreamingActor
 *
 * Handles streaming response state from the VS Code extension.
 * This is the source of truth for all streaming-related state.
 *
 * Publications:
 * - streaming.active: boolean - whether streaming is in progress
 * - streaming.content: string - accumulated response content
 * - streaming.thinking: string - accumulated thinking/reasoning content
 * - streaming.messageId: string | null - ID of current message being streamed
 * - streaming.model: string - model being used for this stream
 *
 * Subscriptions: None (source of truth)
 */

import { EventStateActor } from '../../state/EventStateActor';
import { EventStateManager } from '../../state/EventStateManager';
import type { ActorConfig } from '../../state/types';
import { streamingStyles as styles } from './styles';
import { createLogger } from '../../logging';

const log = createLogger('StreamingActor');

export interface StreamingState {
  active: boolean;
  content: string;
  thinking: string;
  messageId: string | null;
  model: string;
}

export class StreamingActor extends EventStateActor {
  // Internal state
  private _active = false;
  private _content = '';
  private _thinking = '';
  private _messageId: string | null = null;
  private _model = 'deepseek-chat';

  constructor(manager: EventStateManager, element: HTMLElement) {
    const config: ActorConfig = {
      manager,
      element,
      publications: {
        'streaming.active': () => this._active,
        'streaming.content': () => this._content,
        'streaming.thinking': () => this._thinking,
        'streaming.messageId': () => this._messageId,
        'streaming.model': () => this._model
      },
      subscriptions: {},
      enableDOMChangeDetection: false // No DOM to observe for this actor
    };

    super(config);
    manager.injectStyles('streaming', styles);
  }

  /**
   * Start a new streaming session
   */
  startStream(messageId: string, model = 'deepseek-chat'): void {
    this._active = true;
    this._content = '';
    this._thinking = '';
    this._messageId = messageId;
    this._model = model;

    // Publish all state (messageId first so MessageActor creates element before content updates)
    this.publish({
      'streaming.messageId': messageId,
      'streaming.model': model,
      'streaming.active': true,
      'streaming.content': '',
      'streaming.thinking': ''
    });

    // Update DOM indicator
    this.updateIndicator();
  }

  /**
   * Handle incoming content chunk
   */
  handleContentChunk(chunk: string): void {
    if (!this._active) return;

    this._content += chunk;

    this.publish({
      'streaming.content': this._content
    });
  }

  /**
   * Handle incoming thinking chunk (for reasoner model)
   */
  handleThinkingChunk(chunk: string): void {
    if (!this._active) {
      log.warn('handleThinkingChunk called but stream not active');
      return;
    }

    this._thinking += chunk;

    log.debug('Publishing streaming.thinking, length:', this._thinking.length);
    this.publish({
      'streaming.thinking': this._thinking
    });
  }

  /**
   * End the streaming session
   */
  endStream(): void {
    this._active = false;

    this.publish({
      'streaming.active': false
    });

    // Update DOM indicator
    this.updateIndicator();
  }

  /**
   * Abort/cancel the streaming session
   */
  abortStream(): void {
    this._active = false;
    this._content = '';
    this._thinking = '';
    this._messageId = null;

    this.publish({
      'streaming.active': false,
      'streaming.content': '',
      'streaming.thinking': '',
      'streaming.messageId': null
    });

    // Update DOM indicator
    this.updateIndicator();
  }

  /**
   * Update the streaming indicator in the DOM
   */
  private updateIndicator(): void {
    // Get or create indicator element
    let indicator = this.getElement().querySelector('.streaming-indicator');

    if (this._active) {
      if (!indicator) {
        indicator = document.createElement('div');
        indicator.className = 'streaming-indicator';
        indicator.innerHTML = `
          <span class="streaming-dot"></span>
          <span class="streaming-dot"></span>
          <span class="streaming-dot"></span>
        `;
        this.getElement().appendChild(indicator);
      }
      indicator.classList.add('active');
    } else {
      if (indicator) {
        indicator.classList.remove('active');
      }
    }
  }

  // Getters for testing/inspection

  get isActive(): boolean {
    return this._active;
  }

  get content(): string {
    return this._content;
  }

  get thinking(): string {
    return this._thinking;
  }

  get messageId(): string | null {
    return this._messageId;
  }

  get model(): string {
    return this._model;
  }

  /**
   * Get current state snapshot
   */
  getState(): StreamingState {
    return {
      active: this._active,
      content: this._content,
      thinking: this._thinking,
      messageId: this._messageId,
      model: this._model
    };
  }

  /**
   * Reset styles injection flag and remove style tag (for testing)
   */
  static resetStylesInjected(): void {
    StreamingActor.stylesInjected = false;
    // Also remove the style tag if it exists
    if (typeof document !== 'undefined') {
      const styleTag = document.querySelector('style[data-actor="streaming"]');
      if (styleTag) {
        styleTag.remove();
      }
    }
  }
}
