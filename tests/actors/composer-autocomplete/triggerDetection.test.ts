/**
 * Tests for detectTriggerSpan (slice 2 — the pure half)
 *
 * The plan's boundary matrix plus the edges the scan rule implies. The rule:
 * the whitespace-delimited run containing the caret's left context must START
 * with a registered trigger character.
 */

import { describe, it, expect } from 'vitest';
import { detectTriggerSpan, MAX_TRIGGER_SPAN_LENGTH } from '../../../media/actors/composer-autocomplete/triggerDetection';

const ALL = ['/', '@', ':'];

describe('detectTriggerSpan', () => {
  describe('the boundary matrix', () => {
    it('detects `:sm` at start of input', () => {
      expect(detectTriggerSpan(':sm', 3, ALL)).toEqual({ trigger: ':', query: 'sm', start: 0, end: 3 });
    });

    it('detects `:sm` after a space', () => {
      expect(detectTriggerSpan('hello :sm', 9, ALL)).toEqual({ trigger: ':', query: 'sm', start: 6, end: 9 });
    });

    it('rejects `std::sm` (run starts with a non-trigger)', () => {
      expect(detectTriggerSpan('std::sm', 7, ALL)).toBeNull();
    });

    it('rejects a path inside `http://`', () => {
      expect(detectTriggerSpan('http://a', 8, ALL)).toBeNull();
    });

    it('rejects `note:sm` (colon glued to prose)', () => {
      expect(detectTriggerSpan('note:sm', 7, ALL)).toBeNull();
    });
  });

  describe('boundaries', () => {
    it('treats a newline as a boundary', () => {
      expect(detectTriggerSpan('a\n:sm', 5, ALL)).toEqual({ trigger: ':', query: 'sm', start: 2, end: 5 });
    });

    it('treats a tab as a boundary', () => {
      expect(detectTriggerSpan('a\t@x', 4, ALL)).toEqual({ trigger: '@', query: 'x', start: 2, end: 4 });
    });

    it('returns null when the caret sits directly after whitespace', () => {
      expect(detectTriggerSpan('hi ', 3, ALL)).toBeNull();
    });

    it('returns null at caret 0 and out-of-range carets', () => {
      expect(detectTriggerSpan(':sm', 0, ALL)).toBeNull();
      expect(detectTriggerSpan(':sm', 4, ALL)).toBeNull();
      expect(detectTriggerSpan('', 0, ALL)).toBeNull();
    });
  });

  describe('queries', () => {
    it('yields an empty query for a bare trigger', () => {
      expect(detectTriggerSpan(':', 1, ALL)).toEqual({ trigger: ':', query: '', start: 0, end: 1 });
      expect(detectTriggerSpan('hi @', 4, ALL)).toEqual({ trigger: '@', query: '', start: 3, end: 4 });
    });

    it('allows another trigger char inside the query', () => {
      expect(detectTriggerSpan('@src/:ab', 8, ALL)).toEqual({ trigger: '@', query: 'src/:ab', start: 0, end: 8 });
    });

    it('detects file-path queries under @', () => {
      expect(detectTriggerSpan('see @src/index.ts', 17, ALL))
        .toEqual({ trigger: '@', query: 'src/index.ts', start: 4, end: 17 });
    });

    it('uses only the text left of the caret', () => {
      expect(detectTriggerSpan(':smile', 3, ALL)).toEqual({ trigger: ':', query: 'sm', start: 0, end: 3 });
    });
  });

  describe('trigger registration', () => {
    it('ignores unregistered trigger chars', () => {
      expect(detectTriggerSpan('@abc', 4, [':'])).toBeNull();
    });

    it('returns null with no registered triggers', () => {
      expect(detectTriggerSpan(':sm', 3, [])).toBeNull();
    });
  });

  describe('limits', () => {
    it('gives up on runs longer than MAX_TRIGGER_SPAN_LENGTH', () => {
      const longRun = ':' + 'a'.repeat(MAX_TRIGGER_SPAN_LENGTH + 10);
      expect(detectTriggerSpan(longRun, longRun.length, ALL)).toBeNull();
    });

    it('accepts a run at exactly the limit', () => {
      const run = ':' + 'a'.repeat(MAX_TRIGGER_SPAN_LENGTH - 1);
      expect(detectTriggerSpan(run, run.length, ALL)).not.toBeNull();
    });
  });
});
