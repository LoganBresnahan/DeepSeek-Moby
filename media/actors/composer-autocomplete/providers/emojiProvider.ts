/**
 * `:` — emoji.
 *
 * Fully local and synchronous: the dataset is statically imported, so there
 * is no network and nothing for the CSP to object to.
 *
 * Two behaviours beyond plain filtering:
 * - Prefix matches outrank substring matches, then shorter shortcodes win, so
 *   `:sm` offers `smile` before `smiley` and long before `sweat_smile`.
 * - A closed shortcode (`:smile:`) accepts itself — the trailing colon is an
 *   unambiguous "I meant exactly this", so it never waits for Enter.
 */

import { EMOJI, type EmojiEntry } from './emojiData';
import type { Suggestion, SuggestionProvider } from '../types';

/** Enough to keep the list scannable; ranking guarantees the best are first. */
export const EMOJI_RESULT_LIMIT = 30;

export function rankEmoji(entries: readonly EmojiEntry[], query: string, limit = EMOJI_RESULT_LIMIT): EmojiEntry[] {
  const q = query.toLowerCase();
  if (!q) return [];

  const prefix: EmojiEntry[] = [];
  const substring: EmojiEntry[] = [];
  for (const entry of entries) {
    const name = entry[0];
    if (name.startsWith(q)) prefix.push(entry);
    else if (name.includes(q)) substring.push(entry);
  }

  // Within a tier, the shorter shortcode is the more likely intent; ties keep
  // dataset order, which is category-grouped with common emoji first.
  const byLength = (a: EmojiEntry, b: EmojiEntry) => a[0].length - b[0].length;
  prefix.sort(byLength);
  substring.sort(byLength);
  return [...prefix, ...substring].slice(0, limit);
}

export class EmojiProvider implements SuggestionProvider {
  readonly trigger = ':' as const;
  /** A bare colon is far too common in prose and code to open a popup on. */
  readonly minQueryLength = 2;

  constructor(private readonly _entries: readonly EmojiEntry[] = EMOJI) {}

  getSuggestions(query: string): Suggestion[] {
    // `:smile:` — the user closed the shortcode, so complete it outright.
    if (query.endsWith(':')) {
      const name = query.slice(0, -1).toLowerCase();
      const exact = this._entries.find(entry => entry[0] === name);
      return exact ? [{ ...this.toSuggestion(exact), autoAccept: true }] : [];
    }

    return rankEmoji(this._entries, query).map(entry => this.toSuggestion(entry));
  }

  private toSuggestion(entry: EmojiEntry): Suggestion {
    const [name, char] = entry;
    return {
      label: `:${name}:`,
      icon: char,
      action: { kind: 'insertText', text: char }
    };
  }
}
