/**
 * InputAreaShadowActor
 *
 * Shadow DOM version of InputAreaActor.
 * This actor OWNS its DOM - just the textarea and attachments.
 * Buttons (send/stop/attach) are in ToolbarShadowActor.
 *
 * Publications:
 * - input.value: string - current textarea value
 * - input.submitting: boolean - whether a message is being sent
 * - input.streaming: boolean - whether AI is currently streaming
 * - input.attachments: Attachment[] - pending file attachments
 *
 * Subscriptions:
 * - streaming.active: boolean - track streaming state
 */

import { ShadowActor } from '../../state/ShadowActor';
import { EventStateManager } from '../../state/EventStateManager';
import { inputAreaShadowStyles } from './shadowStyles';

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

interface VSCodeAPI {
  postMessage(message: unknown): void;
}

export class InputAreaShadowActor extends ShadowActor {
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
  private _vscode: VSCodeAPI | null = null;

  constructor(manager: EventStateManager, element: HTMLElement, vscode?: VSCodeAPI) {
    super({
      manager,
      element,
      styles: inputAreaShadowStyles,
      publications: {
        'input.value': () => this._value,
        'input.submitting': () => this._submitting,
        'input.streaming': () => this._streaming,
        'input.attachments': () => [...this._attachments]
      },
      subscriptions: {
        'streaming.active': (value: unknown) => this.handleStreamingChange(value as boolean)
      }
    });

    this._vscode = vscode || null;
    this.renderInputArea();
    this.setupEventHandlers();
  }

  // ============================================
  // Rendering
  // ============================================

  private renderInputArea(): void {
    this.render(`
      <div class="input-area">
        <textarea placeholder="Seek deep..." rows="1"></textarea>
        <div class="attachments"></div>
        <div class="file-chips-container hidden">
          <span class="file-chips-label">Context:</span>
          <div class="file-chips"></div>
        </div>
        <input type="file" class="hidden-input" accept=".js,.ts,.jsx,.tsx,.py,.java,.go,.rs,.cpp,.c,.h,.cs,.rb,.php,.swift,.kt,.scala,.vue,.svelte,.json,.yaml,.yml,.toml,.xml,.env,.ini,.conf,.md,.txt,.rst,.log,.html,.css,.scss,.less,.sh,.bash,.zsh,.sql,.graphql,.proto" multiple>
      </div>
    `);
  }

  private setupEventHandlers(): void {
    // Textarea events
    this.delegate('input', 'textarea', () => this.handleTextareaInput());
    this.delegate('keydown', 'textarea', (e) => this.handleTextareaKeydown(e as KeyboardEvent));

    // File input
    this.delegate('change', '.hidden-input', (e) => this.handleFileSelect(e));

    // Attachment remove
    this.delegate('click', '.attachment .remove', (_, el) => {
      const index = parseInt(el.closest('.attachment')?.getAttribute('data-index') || '0', 10);
      this.removeAttachment(index);
    });

    // File chip remove
    this.delegate('click', '.file-chip-remove', (_, el) => {
      const path = el.closest('.file-chip')?.getAttribute('data-path');
      if (path) {
        this._selectedFiles.delete(path);
        this.renderFileChips();
      }
    });
  }

  // ============================================
  // Event Handlers
  // ============================================

  private handleTextareaInput(): void {
    const textarea = this.query<HTMLTextAreaElement>('textarea');
    if (!textarea) return;

    this._value = textarea.value;
    this.autoResize();

    this.publish({ 'input.value': this._value });
  }

  private handleTextareaKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.submit();
    }
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
        this.publish({ 'input.attachments': [...this._attachments] });
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

    // Handle interrupt completion
    if (wasStreaming && !streaming && this._pendingInterrupt) {
      const { content, attachments } = this._pendingInterrupt;
      this._pendingInterrupt = null;

      // Send the queued message after a small delay
      setTimeout(() => {
        this.doSend(content, attachments);
      }, 100);
    }

    this.publish({ 'input.streaming': streaming });
  }

  // ============================================
  // Core Logic
  // ============================================

  /** Called by Toolbar's send button or Enter key */
  submit(): void {
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
        this._onStop?.();
        this._vscode?.postMessage({ type: 'stopGeneration' });
        // Show status feedback
        this.manager.publishDirect('status.message', { type: 'info', message: 'Interrupting... your message will be sent next' });
      }
      return;
    }

    // Normal send
    this.doSend(content, this._attachments.length > 0 ? this._attachments : undefined);
  }

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

  private clearInput(): void {
    this._value = '';
    const textarea = this.query<HTMLTextAreaElement>('textarea');
    if (textarea) {
      textarea.value = '';
      textarea.style.height = 'auto';
    }
  }

  private autoResize(): void {
    const textarea = this.query<HTMLTextAreaElement>('textarea');
    if (!textarea) return;

    textarea.style.height = 'auto';
    const newHeight = Math.min(textarea.scrollHeight, 300);
    textarea.style.height = `${newHeight}px`;
    textarea.classList.toggle('expanded', newHeight > 68);
  }

  /** Called by Toolbar's attach button */
  triggerAttach(): void {
    const fileInput = this.query<HTMLInputElement>('.hidden-input');
    fileInput?.click();
  }

  // ============================================
  // Attachments
  // ============================================

  private renderAttachments(): void {
    const container = this.query<HTMLElement>('.attachments');
    if (!container) return;

    if (this._attachments.length === 0) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = this._attachments.map((att, idx) => {
      const sizeKB = (att.size / 1024).toFixed(1);
      return `
        <div class="attachment" data-index="${idx}">
          <span class="icon">📄</span>
          <span class="name" title="${this.escapeHtml(att.name)}">${this.escapeHtml(att.name)}</span>
          <span class="size">${sizeKB}KB</span>
          <button class="remove" title="Remove">×</button>
        </div>
      `;
    }).join('');
  }

  private removeAttachment(index: number): void {
    this._attachments.splice(index, 1);
    this.renderAttachments();
    this.publish({ 'input.attachments': [...this._attachments] });
  }

  // ============================================
  // File Chips
  // ============================================

  updateFileChips(files: Map<string, string>): void {
    this._selectedFiles = files;
    this.renderFileChips();
  }

  private renderFileChips(): void {
    const container = this.query<HTMLElement>('.file-chips-container');
    const chipsEl = this.query<HTMLElement>('.file-chips');
    if (!container || !chipsEl) return;

    if (this._selectedFiles.size === 0) {
      container.classList.add('hidden');
      chipsEl.innerHTML = '';
      return;
    }

    container.classList.remove('hidden');
    chipsEl.innerHTML = Array.from(this._selectedFiles.keys()).map(path => `
      <div class="file-chip" data-path="${this.escapeHtml(path)}">
        <span class="file-chip-name" title="${this.escapeHtml(path)}">${this.escapeHtml(path)}</span>
        <button class="file-chip-remove" title="Remove">×</button>
      </div>
    `).join('');
  }

  // ============================================
  // Public API
  // ============================================

  onSend(handler: SendHandler): void {
    this._onSend = handler;
  }

  onStop(handler: StopHandler): void {
    this._onStop = handler;
  }

  setVSCodeAPI(vscode: VSCodeAPI): void {
    this._vscode = vscode;
  }

  getValue(): string {
    return this._value;
  }

  setValue(value: string): void {
    this._value = value;
    const textarea = this.query<HTMLTextAreaElement>('textarea');
    if (textarea) {
      textarea.value = value;
      this.autoResize();
    }
    this.publish({ 'input.value': value });
  }

  focus(): void {
    this.query<HTMLTextAreaElement>('textarea')?.focus();
  }

  getState(): InputAreaState {
    return {
      value: this._value,
      submitting: this._submitting,
      streaming: this._streaming,
      attachments: [...this._attachments],
      selectedFiles: new Map(this._selectedFiles)
    };
  }

  isStreaming(): boolean {
    return this._streaming;
  }

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
    this._onSend = null;
    this._onStop = null;
    this._vscode = null;
    super.destroy();
  }
}
