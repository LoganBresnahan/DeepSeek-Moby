/**
 * Trigger detection — the pure half.
 *
 * A trigger is live only when the caret sits after
 * `<boundary><trigger-char><query>` where boundary = start-of-input or
 * whitespace. Equivalently: take the whitespace-delimited run the caret is
 * in; the run's FIRST character must be a registered trigger. One rule, no
 * heuristics — it rejects `std::v`, `http://a` and `note:sm` (run starts
 * with a non-trigger) while allowing `@src/:ab` (a query that merely
 * contains another trigger char).
 */

import type { TriggerChar, TriggerSpan } from './types';

/**
 * Longest trigger+query span detection will consider. Anything longer is not
 * a trigger being typed — it is prose or pasted content the caret happens to
 * sit in.
 */
export const MAX_TRIGGER_SPAN_LENGTH = 100;

export function detectTriggerSpan(
  text: string,
  caret: number,
  triggers: readonly string[]
): TriggerSpan | null {
  if (caret < 1 || caret > text.length || triggers.length === 0) return null;

  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1])) {
    start--;
    if (caret - start > MAX_TRIGGER_SPAN_LENGTH) return null;
  }

  // Caret directly after whitespace (or at position 0): no run.
  if (start >= caret) return null;

  const trigger = text[start];
  if (!triggers.includes(trigger)) return null;

  return {
    trigger: trigger as TriggerChar,
    query: text.slice(start + 1, caret),
    start,
    end: caret
  };
}
