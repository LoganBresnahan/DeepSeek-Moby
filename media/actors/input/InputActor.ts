/**
 * InputActor
 *
 * Handles user input textarea and submit functionality.
 * Disables input during streaming and manages attached files.
 *
 * Publications:
 * - input.value: string - current input value
 * - input.submitting: boolean - whether a submit is in progress
 * - input.focused: boolean - whether the input is focused
 * - input.files: string[] - attached file paths
 *
 * Subscriptions:
 * - streaming.active: boolean - disable input during streaming
 */

import { EventStateActor } from '../../state/EventStateActor';
import { EventStateManager } from '../../state/EventStateManager';
import type { ActorConfig } from '../../state/types';
import { inputStyles as styles } from './styles';

export interface InputState {
  value: string;
  submitting: boolean;
  focused: boolean;
  files: string[];
  disabled: boolean;
}

export type SubmitHandler = (value: string, files: string[]) => void;

export class InputActor extends EventStateActor {
  private static stylesInjected = false;

  // Internal state
  private _value = '';
  private _submitting = false;
  private _focused = false;
  private _files: string[] = [];
  private _disabled = false;

  // DOM elements
  private _textarea: HTMLTextAreaElement | null = null;
  private _submitButton: HTMLButtonElement | null = null;
  private _filesContainer: HTMLElement | null = null;

  // Submit handler
  private _onSubmit: SubmitHandler | null = null;

  constructor(manager: EventStateManager, element: HTMLElement) {
    const config: ActorConfig = {
      manager,
      element,
      publications: {
        'input.value': () => this._value,
        'input.submitting': () => this._submitting,
        'input.focused': () => this._focused,
        'input.files': () => [...this._files]
      },
      subscriptions: {
        'streaming.active': (value: unknown) => this.handleStreamingActive(value as boolean)
      },
      enableDOMChangeDetection: false
    };

    super(config);
    this.injectStyles();
    this.setupDOM();
    this.bindEvents();
  }

  /**
   * Inject CSS styles (once per class)
   */
  private injectStyles(): void {
    if (InputActor.stylesInjected) return;
    if (typeof document === 'undefined') return;

    const style = document.createElement('style');
    style.setAttribute('data-actor', 'input');
    style.textContent = styles;
    document.head.appendChild(style);
    InputActor.stylesInjected = true;
  }

  /**
   * Setup DOM structure
   */
  private setupDOM(): void {
    const element = this.getElement();
    element.className = 'input-container';

    element.innerHTML = `
      <div class="input-files" style="display: none;"></div>
      <div class="input-wrapper">
        <textarea
          class="input-textarea"
          placeholder="Type a message..."
          rows="1"
        ></textarea>
        <button class="input-submit" type="button">Send</button>
      </div>
    `;

    this._textarea = element.querySelector('.input-textarea');
    this._submitButton = element.querySelector('.input-submit');
    this._filesContainer = element.querySelector('.input-files');
  }

  /**
   * Bind event handlers
   */
  private bindEvents(): void {
    if (!this._textarea || !this._submitButton) return;

    // Input events
    this._textarea.addEventListener('input', this.handleInput.bind(this));
    this._textarea.addEventListener('focus', this.handleFocus.bind(this));
    this._textarea.addEventListener('blur', this.handleBlur.bind(this));
    this._textarea.addEventListener('keydown', this.handleKeyDown.bind(this));

    // Submit button
    this._submitButton.addEventListener('click', this.handleSubmit.bind(this));
  }

  // ============================================
  // Event Handlers
  // ============================================

  private handleInput(e: Event): void {
    const target = e.target as HTMLTextAreaElement;
    this._value = target.value;
    this.autoResize();

    this.publish({
      'input.value': this._value
    });
  }

  private handleFocus(): void {
    this._focused = true;
    this.publish({
      'input.focused': true
    });
  }

  private handleBlur(): void {
    this._focused = false;
    this.publish({
      'input.focused': false
    });
  }

  private handleKeyDown(e: KeyboardEvent): void {
    // Submit on Enter (without Shift)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.handleSubmit();
    }
  }

  private handleSubmit(): void {
    if (this._submitting || this._disabled || !this._value.trim()) return;

    this._submitting = true;
    this.updateDisabledState();

    this.publish({
      'input.submitting': true
    });

    // Call the submit handler
    if (this._onSubmit) {
      this._onSubmit(this._value.trim(), [...this._files]);
    }
  }

  // ============================================
  // Subscription Handlers
  // ============================================

  private handleStreamingActive(active: boolean): void {
    this._disabled = active;

    if (!active && this._submitting) {
      // Streaming ended - reset submitting state
      this._submitting = false;
      this.clear();

      this.publish({
        'input.submitting': false
      });
    }

    this.updateDisabledState();
  }

  // ============================================
  // State Management
  // ============================================

  private updateDisabledState(): void {
    const disabled = this._disabled || this._submitting;

    if (this._textarea) {
      this._textarea.disabled = disabled;
    }
    if (this._submitButton) {
      this._submitButton.disabled = disabled;
      this._submitButton.classList.toggle('submitting', this._submitting);
    }
  }

  private autoResize(): void {
    if (!this._textarea) return;

    // Reset height to auto to get proper scrollHeight
    this._textarea.style.height = 'auto';

    // Set to scrollHeight but cap at max-height (200px)
    const newHeight = Math.min(this._textarea.scrollHeight, 200);
    this._textarea.style.height = `${newHeight}px`;
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Set the submit handler
   */
  onSubmit(handler: SubmitHandler): void {
    this._onSubmit = handler;
  }

  /**
   * Set the input value
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
   * Get the current value
   */
  getValue(): string {
    return this._value;
  }

  /**
   * Clear the input
   */
  clear(): void {
    this._value = '';
    this._files = [];

    if (this._textarea) {
      this._textarea.value = '';
      this.autoResize();
    }

    this.renderFiles();

    this.publish({
      'input.value': '',
      'input.files': []
    });
  }

  /**
   * Focus the input
   */
  focus(): void {
    this._textarea?.focus();
  }

  /**
   * Add an attached file
   */
  addFile(filePath: string): void {
    if (!this._files.includes(filePath)) {
      this._files.push(filePath);
      this.renderFiles();

      this.publish({
        'input.files': [...this._files]
      });
    }
  }

  /**
   * Remove an attached file
   */
  removeFile(filePath: string): void {
    const index = this._files.indexOf(filePath);
    if (index !== -1) {
      this._files.splice(index, 1);
      this.renderFiles();

      this.publish({
        'input.files': [...this._files]
      });
    }
  }

  /**
   * Render file tags
   */
  private renderFiles(): void {
    if (!this._filesContainer) return;

    if (this._files.length === 0) {
      this._filesContainer.style.display = 'none';
      this._filesContainer.innerHTML = '';
      return;
    }

    this._filesContainer.style.display = 'flex';
    this._filesContainer.innerHTML = this._files.map(file => `
      <span class="input-file-tag">
        📄 ${this.escapeHtml(this.getFileName(file))}
        <button class="input-file-remove" data-file="${this.escapeHtml(file)}" title="Remove">×</button>
      </span>
    `).join('');

    // Bind remove handlers
    this._filesContainer.querySelectorAll('.input-file-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const file = (e.target as HTMLElement).getAttribute('data-file');
        if (file) this.removeFile(file);
      });
    });
  }

  /**
   * Get filename from path
   */
  private getFileName(filePath: string): string {
    return filePath.split(/[/\\]/).pop() || filePath;
  }

  /**
   * Escape HTML
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Get current state
   */
  getState(): InputState {
    return {
      value: this._value,
      submitting: this._submitting,
      focused: this._focused,
      files: [...this._files],
      disabled: this._disabled
    };
  }

  /**
   * Destroy and cleanup
   */
  destroy(): void {
    this._textarea = null;
    this._submitButton = null;
    this._filesContainer = null;
    this._onSubmit = null;
    super.destroy();
  }

  /**
   * Reset styles injection flag and remove style tag (for testing)
   */
  static resetStylesInjected(): void {
    InputActor.stylesInjected = false;
    if (typeof document !== 'undefined') {
      const styleTag = document.querySelector('style[data-actor="input"]');
      if (styleTag) {
        styleTag.remove();
      }
    }
  }
}
