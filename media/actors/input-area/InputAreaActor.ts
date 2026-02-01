/**
 * InputAreaActor
 *
 * Manages the input area by wrapping existing DOM elements (not generating them).
 * This allows the actor to work with the existing HTML structure from chatProvider.ts.
 *
 * This actor handles:
 * - Message textarea and auto-resize
 * - Send/Stop button visibility
 * - Mid-stream interrupt flow
 * - File attachments
 * - File chips (context files)
 *
 * Publications:
 * - input.value: string - current textarea value
 * - input.submitting: boolean - whether a message is being sent
 * - input.streaming: boolean - whether AI is currently streaming
 * - input.attachments: Array - pending file attachments
 *
 * Subscriptions:
 * - streaming.active: boolean - toggle send/stop buttons
 */

import { EventStateActor } from '../../state/EventStateActor';
import { EventStateManager } from '../../state/EventStateManager';
import type { ActorConfig } from '../../state/types';

export interface Attachment {
  content: string;
  name: string;
  size: number;
}

export interface InputAreaState {
  value: string;
  submitting: boolean;
  streaming: boolean;
  attachments: Attachment[];
  selectedFiles: Map<string, string>;
}

export type SendHandler = (content: string, attachments?: Attachment[]) => void;
export type StopHandler = () => void;
export type InterruptHandler = (content: string, attachments?: Attachment[]) => void;

interface VSCodeAPI {
  postMessage(message: unknown): void;
}

export class InputAreaActor extends EventStateActor {
  // DOM elements (found by ID from existing HTML)
  private _textarea: HTMLTextAreaElement | null = null;
  private _sendBtn: HTMLButtonElement | null = null;
  private _stopBtn: HTMLButtonElement | null = null;
  private _attachBtn: HTMLButtonElement | null = null;
  private _fileInput: HTMLInputElement | null = null;
  private _attachmentsContainer: HTMLElement | null = null;
  private _fileChipsContainer: HTMLElement | null = null;
  private _fileChips: HTMLElement | null = null;

  // State
  private _value = '';
  private _submitting = false;
  private _streaming = false;
  private _attachments: Attachment[] = [];
  private _selectedFiles = new Map<string, string>();

  // Mid-stream interrupt state
  private _pendingInterrupt: { content: string; attachments?: Attachment[] } | null = null;

  // Handlers
  private _onSend: SendHandler | null = null;
  private _onStop: StopHandler | null = null;
  private _onInterrupt: InterruptHandler | null = null;
  private _vscode: VSCodeAPI | null = null;

  constructor(manager: EventStateManager, element: HTMLElement, vscode?: VSCodeAPI) {
    const config: ActorConfig = {
      manager,
      element,
      publications: {
        'input.value': () => this._value,
        'input.submitting': () => this._submitting,
        'input.streaming': () => this._streaming,
        'input.attachments': () => [...this._attachments]
      },
      subscriptions: {
        'streaming.active': (value: unknown) => this.handleStreamingChange(value as boolean)
      },
      enableDOMChangeDetection: false
    };

    super(config);
    this._vscode = vscode || null;
    this.bindToExistingElements();
    this.setupEventHandlers();
  }

  /**
   * Find and bind to existing DOM elements by ID
   */
  private bindToExistingElements(): void {
    const root = this.getElement();
    const doc = root.ownerDocument || document;

    // Find elements by ID (these exist in chatProvider.ts HTML)
    this._textarea = doc.getElementById('messageInput') as HTMLTextAreaElement;
    this._sendBtn = doc.getElementById('sendBtn') as HTMLButtonElement;
    this._stopBtn = doc.getElementById('stopBtn') as HTMLButtonElement;
    this._attachBtn = doc.getElementById('attachBtn') as HTMLButtonElement;
    this._fileInput = doc.getElementById('fileInput') as HTMLInputElement;
    this._attachmentsContainer = doc.getElementById('attachments') as HTMLElement;
    this._fileChipsContainer = doc.getElementById('fileChipsContainer') as HTMLElement;
    this._fileChips = doc.getElementById('fileChips') as HTMLElement;

    // Log what we found for debugging
    console.log('[InputAreaActor] Bound to elements:', {
      textarea: !!this._textarea,
      sendBtn: !!this._sendBtn,
      stopBtn: !!this._stopBtn,
      attachBtn: !!this._attachBtn,
      fileInput: !!this._fileInput
    });
  }

  /**
   * Setup event handlers on existing elements
   */
  private setupEventHandlers(): void {
    // Textarea events
    if (this._textarea) {
      this._textarea.addEventListener('input', this.handleTextareaInput.bind(this));
      this._textarea.addEventListener('keydown', this.handleTextareaKeydown.bind(this));
    }

    // Send button
    if (this._sendBtn) {
      this._sendBtn.addEventListener('click', this.handleSendClick.bind(this));
    }

    // Stop button
    if (this._stopBtn) {
      this._stopBtn.addEventListener('click', this.handleStopClick.bind(this));
    }

    // Attach button
    if (this._attachBtn && this._fileInput) {
      this._attachBtn.addEventListener('click', () => this._fileInput?.click());
      this._fileInput.addEventListener('change', this.handleFileSelect.bind(this));
    }
  }

  // ============================================
  // Event Handlers
  // ============================================

  private handleTextareaInput(): void {
    if (!this._textarea) return;

    this._value = this._textarea.value;
    this.autoResize();

    this.publish({
      'input.value': this._value
    });
  }

  private handleTextareaKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.submit();
    }
  }

  private handleSendClick(): void {
    this.submit();
  }

  private handleStopClick(): void {
    this._onStop?.();
    this._vscode?.postMessage({ type: 'stopGeneration' });
  }

  private handleFileSelect(e: Event): void {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files || []);

    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const content = event.target?.result as string;
        const attachment: Attachment = { content, name: file.name, size: file.size };
        this._attachments.push(attachment);
        this.renderAttachments();

        this.publish({
          'input.attachments': [...this._attachments]
        });
      };
      reader.readAsText(file);
    });

    input.value = ''; // Reset for next selection
  }

  // ============================================
  // Subscription Handlers
  // ============================================

  private handleStreamingChange(streaming: boolean): void {
    const wasStreaming = this._streaming;
    this._streaming = streaming;

    // Update button visibility
    if (this._sendBtn && this._stopBtn) {
      this._sendBtn.style.display = streaming ? 'none' : 'flex';
      this._stopBtn.style.display = streaming ? 'flex' : 'none';
    }

    // Handle interrupt completion
    if (wasStreaming && !streaming && this._pendingInterrupt) {
      const { content, attachments } = this._pendingInterrupt;
      this._pendingInterrupt = null;

      // Remove interrupting state
      this._sendBtn?.classList.remove('interrupting');

      // Send the queued message after a small delay
      setTimeout(() => {
        this.doSend(content, attachments);
      }, 100);
    }

    this.publish({
      'input.streaming': streaming
    });
  }

  // ============================================
  // Core Logic
  // ============================================

  /**
   * Submit the current input (handles interrupt if streaming)
   */
  private submit(): void {
    const content = this._value.trim();
    if (!content && this._attachments.length === 0) return;

    // If streaming, trigger interrupt flow
    if (this._streaming) {
      const alreadyInterrupting = this._pendingInterrupt !== null;

      // Queue message for after stop
      this._pendingInterrupt = {
        content,
        attachments: this._attachments.length > 0 ? [...this._attachments] : undefined
      };

      // Clear input immediately for UX
      this.clearInput();

      // Only send stop if not already interrupting
      if (!alreadyInterrupting) {
        this._sendBtn?.classList.add('interrupting');
        this._onStop?.();
        this._vscode?.postMessage({ type: 'stopGeneration' });
      }
      return;
    }

    // Normal send
    this.doSend(content, this._attachments.length > 0 ? this._attachments : undefined);
  }

  /**
   * Actually send the message
   */
  private doSend(content: string, attachments?: Attachment[]): void {
    this._submitting = true;

    // Call handler
    this._onSend?.(content, attachments);

    // Clear state
    this.clearInput();
    this._attachments = [];
    this.renderAttachments();

    this.publish({
      'input.submitting': true,
      'input.value': '',
      'input.attachments': []
    });

    // Reset submitting after a tick
    queueMicrotask(() => {
      this._submitting = false;
      this.publish({ 'input.submitting': false });
    });
  }

  /**
   * Clear the input textarea
   */
  private clearInput(): void {
    this._value = '';
    if (this._textarea) {
      this._textarea.value = '';
      this._textarea.style.height = 'auto';
    }
  }

  /**
   * Auto-resize textarea to fit content
   */
  private autoResize(): void {
    if (!this._textarea) return;

    this._textarea.style.height = 'auto';
    const newHeight = Math.min(this._textarea.scrollHeight, 200);
    this._textarea.style.height = `${newHeight}px`;
  }

  // ============================================
  // Attachments
  // ============================================

  /**
   * Render attachment previews
   */
  private renderAttachments(): void {
    if (!this._attachmentsContainer) return;

    if (this._attachments.length === 0) {
      this._attachmentsContainer.innerHTML = '';
      return;
    }

    this._attachmentsContainer.innerHTML = this._attachments.map((att, idx) => {
      const sizeKB = (att.size / 1024).toFixed(1);
      return `
        <div class="attachment-preview file-attachment" data-index="${idx}">
          <span class="file-icon">📄</span>
          <span class="file-name" title="${this.escapeHtml(att.name)}">${this.escapeHtml(att.name)}</span>
          <span class="file-size">${sizeKB}KB</span>
          <button class="attachment-remove" title="Remove">×</button>
        </div>
      `;
    }).join('');

    // Bind remove handlers
    this._attachmentsContainer.querySelectorAll('.attachment-remove').forEach((btn, idx) => {
      btn.addEventListener('click', () => this.removeAttachment(idx));
    });
  }

  /**
   * Remove an attachment by index
   */
  private removeAttachment(index: number): void {
    this._attachments.splice(index, 1);
    this.renderAttachments();

    this.publish({
      'input.attachments': [...this._attachments]
    });
  }

  // ============================================
  // File Chips (Selected Context Files)
  // ============================================

  /**
   * Update file chips display
   */
  updateFileChips(files: Map<string, string>): void {
    this._selectedFiles = files;

    if (!this._fileChipsContainer || !this._fileChips) return;

    if (files.size === 0) {
      this._fileChipsContainer.style.display = 'none';
      this._fileChips.innerHTML = '';
      return;
    }

    this._fileChipsContainer.style.display = 'flex';
    this._fileChips.innerHTML = Array.from(files.keys()).map(path => `
      <div class="file-chip" data-path="${this.escapeHtml(path)}">
        <span class="file-chip-name" title="${this.escapeHtml(path)}">${this.escapeHtml(path)}</span>
        <button class="file-chip-remove" title="Remove">×</button>
      </div>
    `).join('');

    // Bind remove handlers
    this._fileChips.querySelectorAll('.file-chip-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const chip = (e.target as HTMLElement).closest('.file-chip');
        const path = chip?.getAttribute('data-path');
        if (path) {
          this._selectedFiles.delete(path);
          this.updateFileChips(this._selectedFiles);
        }
      });
    });
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Set the send handler
   */
  onSend(handler: SendHandler): void {
    this._onSend = handler;
  }

  /**
   * Set the stop handler
   */
  onStop(handler: StopHandler): void {
    this._onStop = handler;
  }

  /**
   * Set VS Code API for posting messages
   */
  setVSCodeAPI(vscode: VSCodeAPI): void {
    this._vscode = vscode;
  }

  /**
   * Get current value
   */
  getValue(): string {
    return this._value;
  }

  /**
   * Set value programmatically
   */
  setValue(value: string): void {
    this._value = value;
    if (this._textarea) {
      this._textarea.value = value;
      this.autoResize();
    }

    this.publish({
      'input.value': value
    });
  }

  /**
   * Focus the textarea
   */
  focus(): void {
    this._textarea?.focus();
  }

  /**
   * Get current state
   */
  getState(): InputAreaState {
    return {
      value: this._value,
      submitting: this._submitting,
      streaming: this._streaming,
      attachments: [...this._attachments],
      selectedFiles: new Map(this._selectedFiles)
    };
  }

  /**
   * Check if currently streaming
   */
  isStreaming(): boolean {
    return this._streaming;
  }

  /**
   * Check if interrupt is pending
   */
  hasPendingInterrupt(): boolean {
    return this._pendingInterrupt !== null;
  }

  // ============================================
  // Utilities
  // ============================================

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ============================================
  // Lifecycle
  // ============================================

  destroy(): void {
    this._textarea = null;
    this._sendBtn = null;
    this._stopBtn = null;
    this._attachBtn = null;
    this._fileInput = null;
    this._attachmentsContainer = null;
    this._fileChipsContainer = null;
    this._fileChips = null;
    this._onSend = null;
    this._onStop = null;
    this._vscode = null;
    super.destroy();
  }
}
