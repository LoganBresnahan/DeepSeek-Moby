/**
 * Composer autocomplete — shared contract.
 *
 * These types are the seam every later slice builds on: trigger detection
 * produces a TriggerSpan, providers turn its query into Suggestions, and the
 * actor turns the accepted Suggestion's action into an edit or a side effect.
 *
 * See ADR 0015 for why the composer stays a plain textarea and why accept
 * semantics (not inline tokens) carry the richness.
 */

/** The characters that can open the overlay. */
export type TriggerChar = '/' | '@' | ':';

/**
 * What accepting a suggestion does, once the trigger+query span has been
 * removed from the composer.
 *
 * - `insertText` — the span is replaced by `text` (emoji today; MCP prompt
 *   templates later).
 * - `runCommand` — the span is deleted and the command is posted to the
 *   extension (moby.* commands today; MCP prompts later).
 * - `attachFile` — the span is deleted and the path enters the attach
 *   pipeline as a chip (workspace files today; MCP resources later).
 */
export type SuggestionAction =
  | { kind: 'insertText'; text: string }
  | { kind: 'runCommand'; id: string }
  | { kind: 'attachFile'; path: string };

export interface Suggestion {
  /** Primary text, and what filtering/ranking matched against. */
  label: string;
  /** Secondary text shown dimmed beside the label. */
  detail?: string;
  /** Leading glyph. An emoji suggestion uses the emoji itself. */
  icon?: string;
  action: SuggestionAction;
  /**
   * Accept without waiting for a keystroke. Only honoured when a provider
   * returns exactly one suggestion, i.e. the completion is unambiguous — the
   * closed emoji shortcode `:smile:` is the case this exists for.
   */
  autoAccept?: boolean;
}

/**
 * A live trigger in the composer: the caret sits at `end`, and
 * `text.slice(start, end)` is the trigger char followed by the query.
 * Accepting replaces exactly that range.
 */
export interface TriggerSpan {
  trigger: TriggerChar;
  query: string;
  /** Index of the trigger character itself. */
  start: number;
  /** Index just past the query — normally the caret. */
  end: number;
}

export interface SuggestionProvider {
  readonly trigger: TriggerChar;
  /**
   * Query length below which the overlay stays shut. `:` needs 2 (a bare
   * colon is far too common in prose and code); `/` and `@` fire at 0.
   */
  readonly minQueryLength: number;
  /**
   * Synchronous providers return their matches. Async providers return
   * `'pending'` and later push results through
   * {@link ComposerAutocompleteActor.updateSuggestions}.
   */
  getSuggestions(query: string): Suggestion[] | 'pending';
  /**
   * Called when the trigger dies. Async providers use it to stop treating an
   * in-flight reply as theirs; synchronous ones can omit it.
   */
  reset?(): void;
}

/**
 * The composer surface, as the autocomplete actor is allowed to see it.
 *
 * Deliberately narrow: the overlay lives in its own Shadow DOM and must never
 * reach into InputAreaShadowActor's, and a fake host keeps the actor testable
 * without a real textarea.
 */
export interface ComposerHost {
  getText(): string;
  /** Caret offset (`selectionStart`). */
  getCaret(): number;
  /** Replace `[start, end)` with `text`; the caret lands after what was written. */
  replaceRange(start: number, end: number, text: string): void;
  /** Route a workspace-relative path into the attach pipeline. */
  attachFile(path: string): void;
  /**
   * Run a command by id. Injected rather than posted directly: several
   * commands open webview-local modals instead of reaching the extension,
   * and CommandsShadowActor already owns that routing.
   */
  runCommand(id: string): void;
  focus(): void;
}
