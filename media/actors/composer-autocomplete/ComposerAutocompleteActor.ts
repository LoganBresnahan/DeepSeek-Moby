/**
 * ComposerAutocompleteActor
 *
 * The overlay behind typed invocation (`/` commands, `@` files, `:` emoji).
 * This slice owns the shell: the provider registry, the suggestion list state,
 * and the accept mechanics. Trigger detection, keyboard arbitration, and the
 * anchored overlay chrome arrive in later slices and drive this actor through
 * {@link openFor}, {@link moveSelection}, {@link acceptSelected} and
 * {@link cancel}.
 *
 * Publications:
 * - composer.autocomplete.visible: boolean - whether the overlay is showing
 *
 * Subscriptions:
 * - composer.autocomplete.open: boolean - request to open/close
 *
 * @see docs/architecture/decisions/0015-composer-autocomplete-typed-invocation.md
 */

import { PopupShadowActor, PopupConfig } from '../../state/PopupShadowActor';
import { EventStateManager } from '../../state/EventStateManager';
import type { SubscriptionMap, VSCodeAPI } from '../../state/types';
import { composerAutocompleteShadowStyles } from './shadowStyles';
import { ProviderRegistry } from './providerRegistry';
import type {
  ComposerHost,
  Suggestion,
  SuggestionAction,
  SuggestionProvider,
  TriggerChar,
  TriggerSpan
} from './types';
import { createLogger } from '../../logging';

const log = createLogger('ComposerAutocomplete');

/** Tallest the overlay ever gets, room permitting. */
const MAX_OVERLAY_HEIGHT = 260;
/** Floor for a pathologically short panel — a clipped list beats an invisible one. */
const MIN_OVERLAY_HEIGHT = 72;
/** Matches the base class's 4px offset from the anchor. */
const OVERLAY_ANCHOR_GAP = 4;

export class ComposerAutocompleteActor extends PopupShadowActor {
  private _host: ComposerHost;
  private _registry = new ProviderRegistry();

  private _span: TriggerSpan | null = null;
  private _suggestions: Suggestion[] = [];
  private _selectedIndex = 0;

  /** Set only while hiding for want of results, so a late async reply can still open. */
  private _retainSpanOnClose = false;

  /**
   * The Escape-dismissed trigger: same trigger char at the same offset stays
   * dismissed while the user keeps typing it. Forgotten when a different
   * trigger appears, on accept, or — via the `input.value` subscription —
   * whenever the composer text no longer carries that trigger char at that
   * offset (draft sent, cleared, or replaced). Without the text check, one
   * Escape at offset 0 would suppress every draft-initial trigger forever.
   */
  private _dismissed: { start: number; trigger: TriggerChar } | null = null;

  /**
   * Keyboard arbitration (ADR 0015 decision 4): a document-level CAPTURE
   * listener, attached only while the overlay is visible. Capture at the
   * document is the first invocation on any composed event path, so it
   * deterministically precedes InputAreaShadowActor's bubble-phase
   * Enter-to-send delegate — and with the overlay closed the listener is not
   * attached at all, leaving the composer byte-for-byte untouched.
   */
  private readonly _boundArbitrateKeydown = this.arbitrateKeydown.bind(this);

  /**
   * @param stateSubscriptions extra state keys to watch on a provider's
   *   behalf. Async providers cannot subscribe themselves — the manager
   *   indexes subscriptions at registration time, before any provider is
   *   registered — so the actor declares them and forwards.
   */
  constructor(
    manager: EventStateManager,
    element: HTMLElement,
    vscode: VSCodeAPI,
    host: ComposerHost,
    stateSubscriptions: SubscriptionMap = {}
  ) {
    const config: PopupConfig = {
      manager,
      element,
      vscode,
      position: 'top-left',
      publications: {},
      subscriptions: {
        ...stateSubscriptions,
        // The composer's programmatic edits (send-clear, draft restore) fire
        // no input events; its published value is the one signal they all
        // share. Used to drop state the real text no longer supports.
        'input.value': (value: unknown) => this.handleComposerValueChange(String(value ?? ''))
      },
      additionalStyles: composerAutocompleteShadowStyles,
      openRequestKey: 'composer.autocomplete.open',
      visibleStateKey: 'composer.autocomplete.visible'
    };

    super(config);
    this._host = host;

    // The base class renders during construction, before these fields exist.
    this.updateBodyContent(this.renderPopupContent());
  }

  // ============================================
  // Providers
  // ============================================

  registerProvider(provider: SuggestionProvider): void {
    this._registry.register(provider);
  }

  /** Trigger characters that actually have a provider — detection watches these. */
  activeTriggers(): string[] {
    return this._registry.triggers();
  }

  // ============================================
  // Drive points (detection + arbitration call these)
  // ============================================

  /**
   * Offer a live trigger to its provider. Returns whether the overlay is
   * showing afterwards — a pending async provider returns false here and opens
   * later via {@link updateSuggestions}.
   */
  openFor(span: TriggerSpan): boolean {
    if (this._dismissed) {
      if (span.start === this._dismissed.start && span.trigger === this._dismissed.trigger) {
        return false; // the dismissed trigger, still being typed
      }
      this._dismissed = null; // a different trigger — forget the dismissal
    }

    const provider = this._registry.get(span.trigger);
    if (!provider || span.query.length < provider.minQueryLength) {
      this.cancel();
      return false;
    }

    this._span = span;
    const result = provider.getSuggestions(span.query);
    if (result === 'pending') {
      this.showSuggestions([]);
      return false;
    }

    this.showSuggestions(result);
    return this.isVisible();
  }

  /**
   * Deliver async results. Ignored when the query has moved on, which is the
   * stale-reply guard for providers whose transport carries no query token —
   * and re-checked against the live text, so a reply cannot resurrect a span
   * whose characters are no longer in the composer.
   */
  updateSuggestions(query: string, suggestions: Suggestion[]): boolean {
    const span = this._span;
    if (!span || span.query !== query) return false;
    if (this._host.getText().slice(span.start, span.end) !== span.trigger + span.query) {
      this.cancel();
      return false;
    }
    this.showSuggestions(suggestions);
    return true;
  }

  /**
   * Escape's version of cancel: additionally remembers the span start so
   * continuing to type the SAME trigger does not reopen the overlay on every
   * keystroke. A trigger at a new offset (or an accept) forgets the dismissal.
   */
  dismiss(): void {
    const span = this._span;
    this.cancel();
    this._dismissed = span ? { start: span.start, trigger: span.trigger } : null;
  }

  /** Drop the active trigger entirely — the overlay will not reopen on its own. */
  cancel(): void {
    // Already idle — keep this a true no-op so detection can call it freely
    // on every keystroke without re-rendering a hidden popup.
    if (!this._span && !this.isVisible() && this._suggestions.length === 0) return;

    // Tell an async provider its reply is no longer wanted.
    if (this._span) this._registry.get(this._span.trigger)?.reset?.();

    this._span = null;
    if (this.isVisible()) {
      this.close();
      return;
    }
    this._suggestions = [];
    this._selectedIndex = 0;
    this.renderSuggestions();
  }

  /** Move the highlight, wrapping at both ends. Returns false when there is nothing to move. */
  moveSelection(delta: number): boolean {
    if (!this.isVisible() || this._suggestions.length === 0) return false;

    const count = this._suggestions.length;
    this._selectedIndex = (((this._selectedIndex + delta) % count) + count) % count;
    this.renderSuggestions();
    this.scrollSelectionIntoView();
    return true;
  }

  /**
   * Accept the highlighted suggestion: remove the trigger+query span, then run
   * the action. Returns false when there is nothing to accept, which is how
   * keyboard arbitration knows to let the key through to the composer.
   */
  acceptSelected(): boolean {
    const suggestion = this._suggestions[this._selectedIndex];
    if (!this._span || !suggestion || !this.isVisible()) return false;
    return this.performAccept(suggestion);
  }

  /** The accept path itself, shared with the auto-accept case (which fires while hidden). */
  private performAccept(suggestion: Suggestion): boolean {
    const span = this._span;
    if (!span) return false;

    const action = suggestion.action;
    // One edit either way: `insertText` writes its text over the span, the
    // other kinds just delete it and do their work outside the composer.
    this._host.replaceRange(span.start, span.end, action.kind === 'insertText' ? action.text : '');

    log.debug(`accept: ${action.kind} from "${span.trigger}${span.query}"`);
    this._dismissed = null;

    // Close before the side effect so a command that opens its own UI does not
    // fight the overlay for focus.
    this.cancel();
    this.dispatchAction(action);
    this._host.focus();
    return true;
  }

  // ============================================
  // Internals
  // ============================================

  /**
   * Re-validate against the composer's published value. Programmatic edits
   * (send-clear, draft restore) fire no input events, so this subscription is
   * how a span or a dismissal whose text is gone gets dropped.
   */
  private handleComposerValueChange(text: string): void {
    if (this._dismissed && text[this._dismissed.start] !== this._dismissed.trigger) {
      this._dismissed = null;
    }

    const span = this._span;
    if (span && text.slice(span.start, span.end) !== span.trigger + span.query) {
      this.cancel();
    }
  }

  private dispatchAction(action: SuggestionAction): void {
    switch (action.kind) {
      case 'insertText':
        break; // replaceRange already wrote it
      case 'runCommand':
        this._host.runCommand(action.id);
        break;
      case 'attachFile':
        this._host.attachFile(action.path);
        break;
    }
  }

  private showSuggestions(suggestions: Suggestion[]): void {
    // An unambiguous single completion accepts itself — `:smile:` should land
    // the emoji without a keystroke, whether or not the list ever showed.
    if (suggestions.length === 1 && suggestions[0].autoAccept) {
      this._suggestions = suggestions;
      this._selectedIndex = 0;
      this.performAccept(suggestions[0]);
      return;
    }

    this._suggestions = suggestions;
    this._selectedIndex = 0;
    this.renderSuggestions();

    if (suggestions.length === 0) {
      this.hideKeepingSpan();
      return;
    }
    if (!this.isVisible()) this.open();
  }

  /** Hide while a trigger is still live (no matches yet, or results went empty). */
  private hideKeepingSpan(): void {
    if (!this.isVisible()) return;
    this._retainSpanOnClose = true;
    this.close();
    this._retainSpanOnClose = false;
  }

  private renderSuggestions(): void {
    this.updateBodyContent(this.renderPopupContent());
    // Re-anchor on every render: the composer's textarea auto-resizes as the
    // draft grows, so a position computed once at open() drifts out from
    // under the overlay and can end up overlapping it.
    if (this.isVisible()) this.syncToAnchor();
  }

  private scrollSelectionIntoView(): void {
    const active = this.query<HTMLElement>('.popup-item.active');
    // jsdom/happy-dom have no layout; guard so tests don't need a stub.
    active?.scrollIntoView?.({ block: 'nearest' });
  }

  // ============================================
  // Keyboard arbitration
  // ============================================

  private arbitrateKeydown(e: KeyboardEvent): void {
    if (!this.isVisible()) return;
    // Never fight an IME — composition keydowns pass through untouched.
    if (e.isComposing) return;

    switch (e.key) {
      case 'ArrowDown':
        if (this.moveSelection(1)) this.consumeKey(e);
        break;
      case 'ArrowUp':
        if (this.moveSelection(-1)) this.consumeKey(e);
        break;
      case 'Enter':
        // Modified Enter (Shift for newline, etc.) belongs to the composer.
        if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
        if (this.acceptSelected()) this.consumeKey(e);
        break;
      case 'Tab':
        if (this.acceptSelected()) this.consumeKey(e);
        break;
      case 'Escape':
        this.dismiss();
        this.consumeKey(e);
        break;
      // Every other key falls through to the composer untouched.
    }
  }

  /**
   * Capture-phase stopPropagation at the document suppresses every later
   * node on the composed path — including the input area's bubble-phase
   * Enter-to-send delegate and the popup base class's own document-bubble
   * Escape listener.
   */
  private consumeKey(e: KeyboardEvent): void {
    e.preventDefault();
    e.stopPropagation();
  }

  // ============================================
  // PopupShadowActor overrides
  // ============================================

  /** Never show an empty box — including for a stray `composer.autocomplete.open` publish. */
  open(): void {
    if (this._suggestions.length === 0) return;
    const wasVisible = this.isVisible();
    super.open();
    if (!wasVisible && this.isVisible()) {
      document.addEventListener('keydown', this._boundArbitrateKeydown, true);
    }
    this.syncToAnchor();
  }

  /**
   * Size and place the overlay against the composer (ADR 0015 decision 5: a
   * full-width bar at the composer, not a caret-anchored box).
   *
   * Above is the intended side and is used whenever it fits. The base class
   * pins the container's *bottom* to the anchor, so an overlay taller than
   * the room above renders off the top of the viewport — invisible and
   * unclickable — which is why this both caps the height and flips below when
   * above cannot hold a usable list.
   */
  private syncToAnchor(): void {
    const anchor = this._config.triggerElement;
    const container = this.query<HTMLElement>('[data-popup-container]');
    if (!anchor || !container) return;

    const rect = anchor.getBoundingClientRect();
    container.style.width = `${rect.width}px`;

    const roomAbove = rect.top - OVERLAY_ANCHOR_GAP;
    const roomBelow = window.innerHeight - rect.bottom - OVERLAY_ANCHOR_GAP;
    const placeAbove = roomAbove >= MIN_OVERLAY_HEIGHT || roomAbove >= roomBelow;

    const capped = Math.max(0, Math.min(MAX_OVERLAY_HEIGHT, placeAbove ? roomAbove : roomBelow));
    container.style.maxHeight = `${capped}px`;
    const body = this.query<HTMLElement>('[data-popup-body]');
    if (body) body.style.maxHeight = `${capped}px`;

    if (placeAbove) {
      container.style.bottom = `${window.innerHeight - rect.top + OVERLAY_ANCHOR_GAP}px`;
      container.style.top = 'auto';
    } else {
      container.style.top = `${rect.bottom + OVERLAY_ANCHOR_GAP}px`;
      container.style.bottom = 'auto';
    }
  }

  protected onClose(): void {
    document.removeEventListener('keydown', this._boundArbitrateKeydown, true);
    this._suggestions = [];
    this._selectedIndex = 0;
    if (!this._retainSpanOnClose) this._span = null;
  }

  destroy(): void {
    document.removeEventListener('keydown', this._boundArbitrateKeydown, true);
    super.destroy();
  }

  protected renderPopupContent(): string {
    const suggestions = this._suggestions || [];
    if (suggestions.length === 0) {
      return '<div class="autocomplete-empty">No matches</div>';
    }

    return suggestions.map((suggestion, index) => `
      <div class="popup-item${index === this._selectedIndex ? ' active' : ''}" data-suggestion-index="${index}">
        ${suggestion.icon ? `<span class="popup-item-icon">${this.escapeHtml(suggestion.icon)}</span>` : ''}
        <span class="popup-item-label">${this.escapeHtml(suggestion.label)}</span>
        ${suggestion.detail ? `<span class="autocomplete-item-detail">${this.escapeHtml(suggestion.detail)}</span>` : ''}
      </div>
    `).join('');
  }

  protected setupPopupEvents(): void {
    // Keep composer focus while clicking a suggestion — a mousedown that
    // blurred the textarea would race the accept's span replacement.
    this.delegate('mousedown', '[data-popup-container]', (e) => e.preventDefault());

    this.delegate('click', '[data-suggestion-index]', (_e, el) => {
      const index = parseInt(el.getAttribute('data-suggestion-index') || '', 10);
      if (Number.isNaN(index)) return;
      this._selectedIndex = index;
      this.acceptSelected();
    });
  }

  // ============================================
  // Inspection (tests + later slices)
  // ============================================

  getSuggestions(): Suggestion[] {
    return [...this._suggestions];
  }

  getSelectedIndex(): number {
    return this._selectedIndex;
  }

  getActiveSpan(): TriggerSpan | null {
    return this._span ? { ...this._span } : null;
  }
}
