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
import type { VSCodeAPI } from '../../state/types';
import { composerAutocompleteShadowStyles } from './shadowStyles';
import { ProviderRegistry } from './providerRegistry';
import type {
  ComposerHost,
  Suggestion,
  SuggestionAction,
  SuggestionProvider,
  TriggerSpan
} from './types';
import { createLogger } from '../../logging';

const log = createLogger('ComposerAutocomplete');

export class ComposerAutocompleteActor extends PopupShadowActor {
  private _host: ComposerHost;
  private _registry = new ProviderRegistry();

  private _span: TriggerSpan | null = null;
  private _suggestions: Suggestion[] = [];
  private _selectedIndex = 0;

  /** Set only while hiding for want of results, so a late async reply can still open. */
  private _retainSpanOnClose = false;

  constructor(manager: EventStateManager, element: HTMLElement, vscode: VSCodeAPI, host: ComposerHost) {
    const config: PopupConfig = {
      manager,
      element,
      vscode,
      position: 'top-left',
      publications: {},
      subscriptions: {},
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
   * stale-reply guard for providers whose transport carries no query token.
   */
  updateSuggestions(query: string, suggestions: Suggestion[]): boolean {
    if (!this._span || this._span.query !== query) return false;
    this.showSuggestions(suggestions);
    return true;
  }

  /** Drop the active trigger entirely — the overlay will not reopen on its own. */
  cancel(): void {
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
    return true;
  }

  /**
   * Accept the highlighted suggestion: remove the trigger+query span, then run
   * the action. Returns false when there is nothing to accept, which is how
   * keyboard arbitration knows to let the key through to the composer.
   */
  acceptSelected(): boolean {
    const span = this._span;
    const suggestion = this._suggestions[this._selectedIndex];
    if (!span || !suggestion || !this.isVisible()) return false;

    const action = suggestion.action;
    // One edit either way: `insertText` writes its text over the span, the
    // other kinds just delete it and do their work outside the composer.
    this._host.replaceRange(span.start, span.end, action.kind === 'insertText' ? action.text : '');

    log.debug(`accept: ${action.kind} from "${span.trigger}${span.query}"`);

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

  private dispatchAction(action: SuggestionAction): void {
    switch (action.kind) {
      case 'insertText':
        break; // replaceRange already wrote it
      case 'runCommand':
        this._vscode.postMessage({ type: 'executeCommand', command: action.id });
        break;
      case 'attachFile':
        this._host.attachFile(action.path);
        break;
    }
  }

  private showSuggestions(suggestions: Suggestion[]): void {
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
  }

  // ============================================
  // PopupShadowActor overrides
  // ============================================

  /** Never show an empty box — including for a stray `composer.autocomplete.open` publish. */
  open(): void {
    if (this._suggestions.length === 0) return;
    super.open();
  }

  protected onClose(): void {
    this._suggestions = [];
    this._selectedIndex = 0;
    if (!this._retainSpanOnClose) this._span = null;
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
