/**
 * TriggerDetectionController — the event half of trigger detection.
 *
 * Listens at the DOCUMENT level and never touches the input area's shadow
 * root: `input`, `compositionstart`/`compositionend` and `focusin` are
 * composed events that retarget to the input-area host element by the time
 * they reach the document, and `selectionchange` fires on the document
 * anyway. Composer state is read exclusively through {@link ComposerHost}.
 *
 * The rules this enforces (ADR 0015 decision 3):
 *
 * - Only KEYED input can open the overlay. Paste, drop, history undo and
 *   anything else re-detect silently: they may close a stale overlay, never
 *   open one. Discrimination is by `InputEvent.inputType`, and an event with
 *   no recognisable inputType is treated as silent — programmatic and
 *   synthetic edits must never pop UI.
 * - While IME composition is active, detection idles entirely. Composition
 *   state is tracked via compositionstart/end because `selectionchange`
 *   carries no `isComposing`.
 * - Moving the caret off the live span (click, arrow keys) cancels it.
 * - Focus landing outside the composer and the overlay cancels it.
 */

import type { ComposerAutocompleteActor } from './ComposerAutocompleteActor';
import type { ComposerHost } from './types';
import { detectTriggerSpan } from './triggerDetection';

/**
 * inputTypes that count as the user typing or deleting at the keyboard.
 * `insertCompositionText` is deliberately absent (IME), as are the
 * paste/drop/undo families.
 */
const KEYED_INPUT_TYPES = new Set([
  'insertText',
  'insertLineBreak',
  'deleteContentBackward',
  'deleteContentForward',
  'deleteWordBackward',
  'deleteWordForward'
]);

export class TriggerDetectionController {
  private _composing = false;
  private _attached = false;

  private readonly _boundOnInput = this.onInput.bind(this);
  private readonly _boundOnSelectionChange = this.onSelectionChange.bind(this);
  private readonly _boundOnCompositionStart = this.onCompositionStart.bind(this);
  private readonly _boundOnCompositionEnd = this.onCompositionEnd.bind(this);
  private readonly _boundOnFocusIn = this.onFocusIn.bind(this);

  constructor(
    private readonly _actor: ComposerAutocompleteActor,
    private readonly _host: ComposerHost,
    /** The input area's host element — composed events retarget to it. */
    private readonly _composerRoot: HTMLElement,
    /** The overlay's host element — focus moving here must not cancel. */
    private readonly _overlayRoot?: HTMLElement
  ) {}

  attach(): void {
    if (this._attached) return;
    this._attached = true;
    document.addEventListener('input', this._boundOnInput);
    document.addEventListener('selectionchange', this._boundOnSelectionChange);
    document.addEventListener('compositionstart', this._boundOnCompositionStart);
    document.addEventListener('compositionend', this._boundOnCompositionEnd);
    document.addEventListener('focusin', this._boundOnFocusIn);
  }

  detach(): void {
    if (!this._attached) return;
    this._attached = false;
    document.removeEventListener('input', this._boundOnInput);
    document.removeEventListener('selectionchange', this._boundOnSelectionChange);
    document.removeEventListener('compositionstart', this._boundOnCompositionStart);
    document.removeEventListener('compositionend', this._boundOnCompositionEnd);
    document.removeEventListener('focusin', this._boundOnFocusIn);
  }

  isComposing(): boolean {
    return this._composing;
  }

  // ============================================
  // Handlers
  // ============================================

  private onInput(e: Event): void {
    if (!this.isComposerEvent(e)) return;
    if (this._composing) return;
    // No providers registered (today's shipped state): nothing can ever be
    // open or pending, so don't even scan.
    if (this._actor.activeTriggers().length === 0) return;

    const inputType = e instanceof InputEvent ? e.inputType : '';
    const span = detectTriggerSpan(
      this._host.getText(),
      this._host.getCaret(),
      this._actor.activeTriggers()
    );

    if (KEYED_INPUT_TYPES.has(inputType)) {
      if (span) {
        this._actor.openFor(span);
      } else {
        this._actor.cancel();
      }
      return;
    }

    // Silent re-detect: a non-keyed edit may invalidate the live span but
    // must never open the overlay.
    const active = this._actor.getActiveSpan();
    if (!active) return;
    if (!span || span.start !== active.start || span.trigger !== active.trigger || span.query !== active.query) {
      this._actor.cancel();
    }
  }

  private onSelectionChange(): void {
    if (this._composing) return;

    const active = this._actor.getActiveSpan();
    if (!active) return;

    // Keyed input re-evaluates through onInput before this fires; anything
    // that leaves the caret off the span's end is a caret move away from it.
    if (this._host.getCaret() !== active.end) {
      this._actor.cancel();
    }
  }

  private onCompositionStart(e: Event): void {
    if (!this.isComposerEvent(e)) return;
    this._composing = true;
    // A suggestion list frozen mid-composition is stale by definition.
    this._actor.cancel();
  }

  private onCompositionEnd(e: Event): void {
    if (!this.isComposerEvent(e)) return;
    this._composing = false;
    // No re-open here: committed composition text is not keyed input. The
    // next keystroke re-detects from scratch.
  }

  private onFocusIn(e: FocusEvent): void {
    const active = this._actor.getActiveSpan();
    if (!active && !this._actor.isVisible()) return;

    if (this.eventHits(e, this._composerRoot)) return;
    if (this._overlayRoot && this.eventHits(e, this._overlayRoot)) return;

    this._actor.cancel();
  }

  // ============================================
  // Helpers
  // ============================================

  private isComposerEvent(e: Event): boolean {
    return this.eventHits(e, this._composerRoot);
  }

  /**
   * Composed events from inside a shadow root retarget to the host, but the
   * path is the portable answer — `target` alone depends on retargeting the
   * DOM implementation may not do, and `contains` never crosses a shadow
   * boundary.
   */
  private eventHits(e: Event, root: HTMLElement): boolean {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (path.length > 0) {
      return path.some(node => node === root);
    }
    const target = e.target;
    return target instanceof Node && this.isWithin(target, root);
  }

  private isWithin(target: Node, root: HTMLElement): boolean {
    return target === root || root.contains(target);
  }
}
