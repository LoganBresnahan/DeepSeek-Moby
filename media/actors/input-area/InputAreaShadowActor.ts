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
  /** Text body, or a data URI for images. */
  content: string;
  name: string;
  size: number;
  /** Absent means 'file' — the extension side defaults it. */
  type?: 'file' | 'image';
  mimeType?: string;
}

/**
 * Longest edge of the copy sent to the vision subagent. Most VLM encoders
 * downsample to 336–448px tiles, so this is near-lossless from a model's
 * point of view while keeping the data URI small enough to post.
 */
const IMAGE_MAX_EDGE = 1024;

/** Hard ceiling on an encoded image, enforced AFTER re-encode. */
const IMAGE_MAX_BYTES = 1.5 * 1024 * 1024;

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];

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

  // Drag-drop: depth counter (dragenter/leave fire per child crossing) and
  // the teardown for the document-level navigation guard.
  private _dragDepth = 0;
  private _dragGuards: (() => void) | null = null;

  // Handlers
  private _onSend: SendHandler | null = null;
  private _onStop: StopHandler | null = null;
  private _vscode: VSCodeAPI | null = null;
  private _sendDisabled = false;

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

  private _collapsed = false;

  private renderInputArea(): void {
    this.render(`
      <div class="input-area">
        <div class="textarea-wrapper">
          <textarea placeholder="Seek deep..." rows="1"></textarea>
          <button class="collapse-toggle" title="Expand input">▴</button>
        </div>
        <div class="attachments"></div>
        <div class="file-chips-container hidden">
          <span class="file-chips-label">Context:</span>
          <div class="file-chips"></div>
        </div>
        <input type="file" class="hidden-input" accept=".js,.ts,.jsx,.tsx,.py,.java,.go,.rs,.cpp,.c,.h,.cs,.rb,.php,.swift,.kt,.scala,.vue,.svelte,.json,.yaml,.yml,.toml,.xml,.env,.ini,.conf,.md,.txt,.rst,.log,.html,.css,.scss,.less,.sh,.bash,.zsh,.sql,.graphql,.proto,.png,.jpg,.jpeg,.webp,.gif,.bmp" multiple>
      </div>
    `);
  }

  private setupEventHandlers(): void {
    // Textarea events
    this.delegate('input', 'textarea', () => this.handleTextareaInput());
    this.delegate('keydown', 'textarea', (e) => this.handleTextareaKeydown(e as KeyboardEvent));

    // Collapse/expand toggle
    this.delegate('click', '.collapse-toggle', () => this.toggleCollapse());

    // File input
    this.delegate('change', '.hidden-input', (e) => this.handleFileSelect(e));

    this.setupDragAndDrop();

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

    // Typing should exit manual collapse (a collapsed box should grow with
    // content) but preserve manual expand — if the user explicitly expanded,
    // they want it to stay open while they type.
    if (this._collapsed) {
      this._collapsed = false;
    }
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
    this.ingestFiles(Array.from(input.files || []));
    input.value = ''; // Reset for next selection
  }

  /**
   * The one place a File becomes an attachment. Both entry points — the
   * picker and drag-drop — funnel through here so an image can never take the
   * text branch (which would store it as mojibake in a code fence).
   */
  private ingestFiles(files: File[]): void {
    files.forEach(file => {
      if (this.isImage(file)) {
        void this.attachImage(file);
        return;
      }
      const reader = new FileReader();
      reader.onload = (event) => {
        const content = event.target?.result as string;
        this.addAttachment({ content, name: file.name, size: file.size, type: 'file' });
      };
      reader.readAsText(file);
    });
  }

  // ============================================
  // Drag and drop
  // ============================================

  /**
   * Drop-to-attach on the input box.
   *
   * Two listener sets with different jobs:
   * - The **panel guard** on `document` exists because an unhandled drop makes
   *   the webview frame navigate to the dropped file, blanking the chat and
   *   losing the in-flight turn. It swallows drops everywhere outside the
   *   input box; it never attaches anything.
   * - The **input-box listeners** do the attaching. `dragenter`/`dragleave`
   *   fire on every child crossing (chips, textarea), so the highlight tracks
   *   a depth counter rather than a boolean or it flickers as the pointer
   *   moves within the box.
   */
  private setupDragAndDrop(): void {
    const swallow = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
    };
    document.addEventListener('dragover', swallow);
    document.addEventListener('drop', swallow);
    this._dragGuards = () => {
      document.removeEventListener('dragover', swallow);
      document.removeEventListener('drop', swallow);
    };

    const zone = this.query<HTMLElement>('.input-area');
    if (!zone) return;

    zone.addEventListener('dragenter', (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      this._dragDepth++;
      zone.classList.add('dragging');
    });

    zone.addEventListener('dragover', (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });

    zone.addEventListener('dragleave', (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      this._dragDepth = Math.max(0, this._dragDepth - 1);
      if (this._dragDepth === 0) zone.classList.remove('dragging');
    });

    zone.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      this._dragDepth = 0;
      zone.classList.remove('dragging');
      this.handleDrop(e.dataTransfer);
    });
  }

  /**
   * A drop carries either real Files (OS file manager) or only a uri-list
   * (dragged from the VS Code Explorer or an editor tab — the webview has no
   * filesystem access, so the extension has to read those for us).
   */
  private handleDrop(dataTransfer: DataTransfer | null): void {
    if (!dataTransfer) return;

    const files = Array.from(dataTransfer.files || []);
    if (files.length > 0) {
      this.ingestFiles(files);
      return;
    }

    const uris = this.parseUriList(dataTransfer.getData('text/uri-list'));
    if (uris.length > 0) {
      this._vscode?.postMessage({ type: 'requestDroppedFiles', uris });
    }
  }

  private parseUriList(raw: string): string[] {
    if (!raw) return [];
    return raw
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));
  }

  /**
   * Extension's reply to `requestDroppedFiles`. Images come back as data URIs
   * (they still need the canvas downscale); text comes back as text.
   */
  handleDroppedFileContents(files: Array<{ name: string; content: string; isImage?: boolean; mimeType?: string }>): void {
    for (const file of files) {
      if (file.isImage) {
        void this.attachImageFromDataUrl(file.content, file.name);
      } else {
        this.addAttachment({ content: file.content, name: file.name, size: file.content.length, type: 'file' });
      }
    }
  }

  private isImage(file: File): boolean {
    if (file.type.startsWith('image/')) return true;
    const lower = file.name.toLowerCase();
    return IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext));
  }

  /**
   * Downscale an image to {@link IMAGE_MAX_EDGE} and attach it as a data URI.
   * The cap is checked after re-encoding and the attachment is rejected rather
   * than truncated — a clipped image decodes to garbage, unlike clipped text.
   */
  private async attachImage(file: File): Promise<void> {
    try {
      const { dataUrl, bytes } = await this.downscaleImage(file);
      if (bytes > IMAGE_MAX_BYTES) {
        this.reportAttachmentError(
          `"${file.name}" is too large to attach (${(bytes / 1024 / 1024).toFixed(1)}MB after downscaling).`
        );
        return;
      }
      this.addAttachment({
        content: dataUrl,
        name: file.name,
        size: bytes,
        type: 'image',
        mimeType: 'image/webp'
      });
    } catch (err) {
      this.reportAttachmentError(
        `Could not read "${file.name}" as an image: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** Same guards as {@link attachImage}, for bytes the extension read for us. */
  private async attachImageFromDataUrl(dataUrl: string, name: string): Promise<void> {
    try {
      const scaled = await this.downscaleFromUrl(dataUrl);
      if (scaled.bytes > IMAGE_MAX_BYTES) {
        this.reportAttachmentError(
          `"${name}" is too large to attach (${(scaled.bytes / 1024 / 1024).toFixed(1)}MB after downscaling).`
        );
        return;
      }
      this.addAttachment({
        content: scaled.dataUrl,
        name,
        size: scaled.bytes,
        type: 'image',
        mimeType: 'image/webp'
      });
    } catch (err) {
      this.reportAttachmentError(
        `Could not read "${name}" as an image: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private downscaleImage(file: File): Promise<{ dataUrl: string; bytes: number }> {
    const url = URL.createObjectURL(file);
    return this.downscaleFromUrl(url).finally(() => URL.revokeObjectURL(url));
  }

  /** Downscale from any loadable source — an object URL or a data URI. */
  private downscaleFromUrl(url: string): Promise<{ dataUrl: string; bytes: number }> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('canvas 2d context unavailable'));
            return;
          }
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/webp', 0.8);
          // Data URI length overstates payload by ~4/3; report decoded bytes.
          const bytes = Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);
          resolve({ dataUrl, bytes });
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      img.onerror = () => reject(new Error('not a decodable image'));
      img.src = url;
    });
  }

  private addAttachment(attachment: Attachment): void {
    this._attachments.push(attachment);
    this.renderAttachments();
    this.publish({ 'input.attachments': [...this._attachments] });
  }

  private reportAttachmentError(message: string): void {
    this._vscode?.postMessage({ type: 'showError', message });
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

  /** Disable/enable sending (e.g., when API key is not configured) */
  setSendDisabled(disabled: boolean): void {
    this._sendDisabled = disabled;
  }

  /** Called by Toolbar's send button or Enter key */
  submit(): void {
    if (this._sendDisabled) return;
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

    // Don't auto-resize if user manually expanded or collapsed
    if (this._collapsed) {
      textarea.style.height = '68px';
      textarea.classList.remove('expanded');
      return;
    }
    if (textarea.classList.contains('force-expanded')) {
      return;
    }

    textarea.style.height = 'auto';
    const newHeight = Math.min(textarea.scrollHeight, 300);
    textarea.style.height = `${newHeight}px`;

    const isExpanded = newHeight > 68;
    textarea.classList.toggle('expanded', isExpanded);

    // Update toggle to show collapse option when content has grown
    const toggle = this.query<HTMLButtonElement>('.collapse-toggle');
    if (toggle) {
      if (isExpanded) {
        toggle.textContent = '▾';
        toggle.title = 'Collapse input';
        toggle.classList.add('expanded');
      } else {
        toggle.textContent = '▴';
        toggle.title = 'Expand input';
        toggle.classList.remove('expanded');
      }
    }
  }

  private toggleCollapse(): void {
    const textarea = this.query<HTMLTextAreaElement>('textarea');
    const toggle = this.query<HTMLButtonElement>('.collapse-toggle');
    if (!textarea || !toggle) return;

    const isCurrentlyExpanded = textarea.offsetHeight > 68;

    if (isCurrentlyExpanded) {
      // Collapse to min height
      this._collapsed = true;
      textarea.classList.remove('force-expanded', 'expanded');
      textarea.style.height = '68px';
      toggle.textContent = '▴';
      toggle.title = 'Expand input';
      toggle.classList.remove('expanded');
    } else {
      // Expand to max height
      this._collapsed = false;
      textarea.style.height = '300px';
      textarea.classList.add('expanded', 'force-expanded');
      toggle.textContent = '▾';
      toggle.title = 'Collapse input';
      toggle.classList.add('expanded');
    }
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
      // Images show a thumbnail of themselves; the data URI is already in hand.
      const icon = att.type === 'image'
        ? `<img class="thumb" src="${this.escapeHtml(att.content)}" alt="">`
        : '<span class="icon">📄</span>';
      return `
        <div class="attachment" data-index="${idx}">
          ${icon}
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

  /**
   * Append text to the composer (blank-line separated if it isn't empty),
   * then place the cursor at the end. Used to stage external content — e.g. an
   * ASCII diagram from the drawing server — as a draft for the user to review
   * and edit, instead of auto-sending it. Pass `{ focus: false }` to stage
   * without stealing focus.
   */
  appendText(text: string, opts?: { focus?: boolean }): void {
    if (!text) return;
    const existing = this._value;
    const next = existing.trim().length > 0 ? `${existing}\n\n${text}` : text;
    this.setValue(next);
    if (opts?.focus !== false) {
      const textarea = this.query<HTMLTextAreaElement>('textarea');
      textarea?.focus();
      textarea?.setSelectionRange(next.length, next.length);
    }
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
    // Document-level listeners outlive the shadow root — remove them explicitly.
    this._dragGuards?.();
    this._dragGuards = null;
    super.destroy();
  }
}
