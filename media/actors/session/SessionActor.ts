/**
 * SessionActor
 *
 * Manages session lifecycle, persistence, and coordination with VS Code extension.
 * This is the source of truth for session state in the webview.
 *
 * Publications:
 * - session.id: string | null - current session ID
 * - session.title: string - current session title
 * - session.model: string - model being used
 * - session.loading: boolean - whether session is loading
 * - session.error: string | null - error message if any
 *
 * Subscriptions:
 * - message.count: number - track message count for title generation
 * - input.submitting: boolean - when user submits a message
 */

import { EventStateActor } from '../../state/EventStateActor';
import { EventStateManager } from '../../state/EventStateManager';
import type { ActorConfig } from '../../state/types';
import { sessionStyles as styles } from './styles';

export interface SessionData {
  id: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface SessionState {
  id: string | null;
  title: string;
  model: string;
  loading: boolean;
  error: string | null;
}

export type VSCodeAPI = {
  postMessage: (message: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
};

export class SessionActor extends EventStateActor {
  private static stylesInjected = false;

  // Internal state
  private _sessionId: string | null = null;
  private _title = 'New Chat';
  private _model = 'deepseek-chat';
  private _loading = false;
  private _error: string | null = null;

  // VS Code API
  private _vscode: VSCodeAPI | null = null;

  // Message handler
  private _messageHandler: ((event: MessageEvent) => void) | null = null;

  constructor(manager: EventStateManager, element: HTMLElement, vscode?: VSCodeAPI) {
    const config: ActorConfig = {
      manager,
      element,
      publications: {
        'session.id': () => this._sessionId,
        'session.title': () => this._title,
        'session.model': () => this._model,
        'session.loading': () => this._loading,
        'session.error': () => this._error
      },
      subscriptions: {
        'message.count': (value: unknown) => this.handleMessageCount(value as number),
        'input.submitting': (value: unknown) => this.handleInputSubmitting(value as boolean)
      },
      enableDOMChangeDetection: false
    };

    super(config);
    this._vscode = vscode || null;
    this.injectStyles();
    this.setupMessageListener();
  }

  /**
   * Inject CSS styles (once per class)
   */
  private injectStyles(): void {
    if (SessionActor.stylesInjected) return;
    if (typeof document === 'undefined') return;

    const style = document.createElement('style');
    style.setAttribute('data-actor', 'session');
    style.textContent = styles;
    document.head.appendChild(style);
    SessionActor.stylesInjected = true;
  }

  /**
   * Setup listener for VS Code messages
   */
  private setupMessageListener(): void {
    if (typeof window === 'undefined') return;

    this._messageHandler = (event: MessageEvent) => {
      const message = event.data;
      this.handleVSCodeMessage(message);
    };

    window.addEventListener('message', this._messageHandler);
  }

  // ============================================
  // VS Code Message Handling
  // ============================================

  private handleVSCodeMessage(message: { type: string; [key: string]: unknown }): void {
    switch (message.type) {
      case 'sessionLoaded':
        this.handleSessionLoaded(message as {
          type: string;
          sessionId: string;
          title: string;
          model: string;
        });
        break;

      case 'sessionCreated':
        this.handleSessionCreated(message as {
          type: string;
          sessionId: string;
          model: string;
        });
        break;

      case 'sessionError':
        this.handleSessionError(message as {
          type: string;
          error: string;
        });
        break;

      case 'modelChanged':
        this.handleModelChanged(message as {
          type: string;
          model: string;
        });
        break;

      case 'loadHistory':
        // History is being loaded - handled by MessageActor
        this._loading = false;
        this.publish({ 'session.loading': false });
        break;
    }
  }

  private handleSessionLoaded(message: { sessionId: string; title: string; model: string }): void {
    this._sessionId = message.sessionId;
    this._title = message.title;
    this._model = message.model;
    this._loading = false;
    this._error = null;

    this.publish({
      'session.id': this._sessionId,
      'session.title': this._title,
      'session.model': this._model,
      'session.loading': false,
      'session.error': null
    });
  }

  private handleSessionCreated(message: { sessionId: string; model: string }): void {
    this._sessionId = message.sessionId;
    this._title = 'New Chat';
    this._model = message.model;
    this._loading = false;
    this._error = null;

    this.publish({
      'session.id': this._sessionId,
      'session.title': this._title,
      'session.model': this._model,
      'session.loading': false,
      'session.error': null
    });
  }

  private handleSessionError(message: { error: string }): void {
    this._loading = false;
    this._error = message.error;

    this.publish({
      'session.loading': false,
      'session.error': this._error
    });
  }

  private handleModelChanged(message: { model: string }): void {
    this._model = message.model;

    this.publish({
      'session.model': this._model
    });

    // Notify VS Code of model change
    this.postMessage({ type: 'modelChanged', model: this._model });
  }

  // ============================================
  // Subscription Handlers
  // ============================================

  private handleMessageCount(count: number): void {
    // Could use this to auto-generate title from first message
    // For now, just track it
  }

  private handleInputSubmitting(submitting: boolean): void {
    if (submitting && !this._sessionId) {
      // Create a new session if none exists
      this.createSession();
    }
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Create a new session
   */
  createSession(model?: string): void {
    this._loading = true;
    this._error = null;

    this.publish({
      'session.loading': true,
      'session.error': null
    });

    this.postMessage({
      type: 'createSession',
      model: model || this._model
    });
  }

  /**
   * Load a session by ID
   */
  loadSession(sessionId: string): void {
    this._loading = true;
    this._error = null;

    this.publish({
      'session.loading': true,
      'session.error': null
    });

    this.postMessage({
      type: 'loadSession',
      sessionId
    });
  }

  /**
   * Clear current session (start fresh)
   */
  clearSession(): void {
    this._sessionId = null;
    this._title = 'New Chat';
    this._error = null;

    this.publish({
      'session.id': null,
      'session.title': 'New Chat',
      'session.error': null
    });

    this.postMessage({ type: 'clearSession' });
  }

  /**
   * Rename current session
   */
  renameSession(newTitle: string): void {
    if (!this._sessionId) return;

    this._title = newTitle;

    this.publish({
      'session.title': this._title
    });

    this.postMessage({
      type: 'renameSession',
      sessionId: this._sessionId,
      title: newTitle
    });
  }

  /**
   * Delete current session
   */
  deleteSession(): void {
    if (!this._sessionId) return;

    this.postMessage({
      type: 'deleteSession',
      sessionId: this._sessionId
    });

    this.clearSession();
  }

  /**
   * Change the model
   */
  setModel(model: string): void {
    this._model = model;

    this.publish({
      'session.model': model
    });

    this.postMessage({
      type: 'setModel',
      model
    });
  }

  /**
   * Export current session
   */
  exportSession(format: 'json' | 'markdown' | 'txt' = 'json'): void {
    if (!this._sessionId) return;

    this.postMessage({
      type: 'exportSession',
      sessionId: this._sessionId,
      format
    });
  }

  /**
   * Request history list from extension
   */
  requestHistoryList(): void {
    this.postMessage({ type: 'getHistoryList' });
  }

  /**
   * Post message to VS Code extension
   */
  private postMessage(message: unknown): void {
    this._vscode?.postMessage(message);
  }

  /**
   * Set VS Code API (for late binding)
   */
  setVSCodeAPI(vscode: VSCodeAPI): void {
    this._vscode = vscode;
  }

  /**
   * Get current state
   */
  getState(): SessionState {
    return {
      id: this._sessionId,
      title: this._title,
      model: this._model,
      loading: this._loading,
      error: this._error
    };
  }

  /**
   * Get current session ID
   */
  get sessionId(): string | null {
    return this._sessionId;
  }

  /**
   * Get current title
   */
  get title(): string {
    return this._title;
  }

  /**
   * Get current model
   */
  get model(): string {
    return this._model;
  }

  /**
   * Check if loading
   */
  get isLoading(): boolean {
    return this._loading;
  }

  /**
   * Get error message
   */
  get error(): string | null {
    return this._error;
  }

  /**
   * Destroy and cleanup
   */
  destroy(): void {
    if (this._messageHandler) {
      window.removeEventListener('message', this._messageHandler);
      this._messageHandler = null;
    }
    this._vscode = null;
    super.destroy();
  }

  /**
   * Reset styles injection flag and remove style tag (for testing)
   */
  static resetStylesInjected(): void {
    SessionActor.stylesInjected = false;
    if (typeof document !== 'undefined') {
      const styleTag = document.querySelector('style[data-actor="session"]');
      if (styleTag) {
        styleTag.remove();
      }
    }
  }
}
