/**
 * `@` — workspace files.
 *
 * The only async provider, and the only one that talks to the extension. It
 * reuses the existing round trip whole: post `searchFiles`, results arrive on
 * the `files.searchResults` state key, and accepting posts `getFileContent`,
 * which FilesShadowActor already turns into a context chip.
 *
 * Results are FED to this provider (the actor owns the subscription, since
 * state keys must be declared at registration time) rather than subscribed to
 * here. The reply channel is SHARED with the files popup and carries no query
 * token, so the provider tracks its own outstanding query and ignores replies
 * it did not ask for — that is what keeps the popup's searches out of the
 * overlay.
 */

import type { Suggestion, SuggestionProvider } from '../types';

/** Long enough to swallow a fast typist's keystrokes, short enough to feel live. */
export const FILE_SEARCH_DEBOUNCE_MS = 150;

export const FILE_RESULT_LIMIT = 30;

export interface FilesProviderDeps {
  postMessage(message: unknown): void;
  /** Called when results for `query` arrive; the actor's own stale guard runs too. */
  onResults(query: string, suggestions: Suggestion[]): void;
  /** Injectable for tests. */
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

/** Pull the path list out of whatever shape the state key carries. */
export function extractSearchResults(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  const results = (value as { results?: unknown } | null | undefined)?.results;
  return Array.isArray(results) ? results.filter((v): v is string => typeof v === 'string') : [];
}

export class FilesProvider implements SuggestionProvider {
  readonly trigger = '@' as const;
  /**
   * 1, not 0: a bare `@` would search the whole workspace for nothing, and a
   * lone `@` is ordinary prose (handles, email addresses).
   */
  readonly minQueryLength = 1;

  private _outstandingQuery: string | null = null;
  private _debounce: ReturnType<typeof setTimeout> | null = null;
  private readonly _setTimeout: NonNullable<FilesProviderDeps['setTimeoutFn']>;
  private readonly _clearTimeout: NonNullable<FilesProviderDeps['clearTimeoutFn']>;

  constructor(private readonly _deps: FilesProviderDeps) {
    this._setTimeout = _deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = _deps.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
  }

  getSuggestions(query: string): 'pending' {
    this._outstandingQuery = query;
    if (this._debounce) this._clearTimeout(this._debounce);
    this._debounce = this._setTimeout(() => {
      this._debounce = null;
      this._deps.postMessage({ type: 'searchFiles', query });
    }, FILE_SEARCH_DEBOUNCE_MS);
    return 'pending';
  }

  /** Feed a `files.searchResults` payload in. Ignored unless we asked for one. */
  handleResults(value: unknown): void {
    const query = this._outstandingQuery;
    // Not ours — the files popup is searching, or we already cancelled.
    if (query === null) return;

    const suggestions: Suggestion[] = extractSearchResults(value)
      .slice(0, FILE_RESULT_LIMIT)
      .map(path => ({
        label: basename(path),
        detail: path,
        icon: '📄',
        action: { kind: 'attachFile', path }
      }));

    this._deps.onResults(query, suggestions);
  }

  /** Stop treating any in-flight reply as ours, and drop a pending search. */
  reset(): void {
    this._outstandingQuery = null;
    if (this._debounce) {
      this._clearTimeout(this._debounce);
      this._debounce = null;
    }
  }
}

function basename(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}
