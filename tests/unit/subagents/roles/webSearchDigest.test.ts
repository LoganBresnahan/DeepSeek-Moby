/**
 * Unit tests for the web-search-digest role.
 *
 * Covers: threshold logic on result count and bytes, prompt construction
 * (with and without task context), schema validation pass/fail cases,
 * formatter output shape.
 */

import { describe, it, expect } from 'vitest';
import { makeWebSearchDigestRole } from '../../../../src/subagents/roles/webSearchDigest';
import type { WebSearchResponse, WebSearchResult } from '../../../../src/clients/webSearchProvider';

const webSearchDigestRole = makeWebSearchDigestRole({ maxResults: 5 });

function makeResult(overrides: Partial<WebSearchResult> = {}): WebSearchResult {
  return {
    title: 'Example title',
    url: 'https://example.com/a',
    content: 'Some content describing the result.',
    score: 0.9,
    ...overrides
  };
}

function makeResponse(results: WebSearchResult[], extras: Partial<WebSearchResponse> = {}): WebSearchResponse {
  return {
    query: 'test query',
    results,
    responseTime: 100,
    ...extras
  };
}

describe('webSearchDigestRole', () => {
  describe('shouldRoute (UI checkbox is the gate; role is defensive only)', () => {
    it('returns false for empty result sets — nothing to digest', () => {
      const response = makeResponse([]);
      expect(webSearchDigestRole.shouldRoute(response)).toBe(false);
    });

    it('returns true for any non-empty result set, even single-result', () => {
      expect(webSearchDigestRole.shouldRoute(makeResponse([makeResult()]))).toBe(true);
      expect(webSearchDigestRole.shouldRoute(makeResponse([
        makeResult(), makeResult(), makeResult(), makeResult(), makeResult()
      ]))).toBe(true);
    });
  });

  describe('maxResults config', () => {
    it('embeds the maxResults value in the system prompt', () => {
      const role = makeWebSearchDigestRole({ maxResults: 3 });
      const prompt = role.buildSystemPrompt({ recentUserPrompt: 'task' });
      expect(prompt).toContain('Pick the 3 result(s)');
      expect(prompt).toContain('at most 3 entries');
    });

    it('clamps maxResults to the [1, 20] range', () => {
      const tooLow = makeWebSearchDigestRole({ maxResults: 0 }).buildSystemPrompt({ recentUserPrompt: '' });
      const tooHigh = makeWebSearchDigestRole({ maxResults: 99 }).buildSystemPrompt({ recentUserPrompt: '' });
      expect(tooLow).toContain('Pick the 1 result(s)');
      expect(tooHigh).toContain('Pick the 20 result(s)');
    });
  });

  describe('buildSystemPrompt', () => {
    it('includes the user task verbatim when provided', () => {
      const prompt = webSearchDigestRole.buildSystemPrompt({ recentUserPrompt: 'debug auth flow' });
      expect(prompt).toContain('debug auth flow');
    });

    it('uses the unspecified-task fallback when prompt is empty', () => {
      const prompt = webSearchDigestRole.buildSystemPrompt({ recentUserPrompt: '' });
      expect(prompt).toContain('unspecified');
    });
  });

  describe('buildUserMessage', () => {
    it('includes the query and every result with score', () => {
      const response = makeResponse([
        makeResult({ title: 'First', url: 'https://a', content: 'aaa', score: 0.91 }),
        makeResult({ title: 'Second', url: 'https://b', content: 'bbb', score: 0.42 })
      ], { answer: 'top-line summary' });
      const msg = webSearchDigestRole.buildUserMessage(response);
      expect(msg).toContain('test query');
      expect(msg).toContain('First');
      expect(msg).toContain('Second');
      expect(msg).toContain('https://a');
      expect(msg).toContain('https://b');
      expect(msg).toContain('top-line summary');
      expect(msg).toContain('0.91');
    });
  });

  describe('parse (schema validation)', () => {
    it('returns the validated shape on well-formed JSON', () => {
      const parsed = webSearchDigestRole.parse({
        rankedResults: [
          { title: 'A', url: 'https://a', snippet: 'snip', reason: 'matters' }
        ],
        refinedAnswer: 'refined',
        discardedCount: 4
      });
      expect(parsed).toEqual({
        rankedResults: [{ title: 'A', url: 'https://a', snippet: 'snip', reason: 'matters' }],
        refinedAnswer: 'refined',
        discardedCount: 4
      });
    });

    it('returns null when rankedResults is missing', () => {
      expect(webSearchDigestRole.parse({ discardedCount: 0 })).toBeNull();
    });

    it('returns null when discardedCount is not a number', () => {
      expect(webSearchDigestRole.parse({ rankedResults: [], discardedCount: 'lots' })).toBeNull();
    });

    it('returns null when a rankedResults entry is missing a required field', () => {
      const bad = {
        rankedResults: [{ title: 'A', url: 'https://a', snippet: 'snip' /* reason missing */ }],
        discardedCount: 0
      };
      expect(webSearchDigestRole.parse(bad)).toBeNull();
    });

    it('omits refinedAnswer when not present', () => {
      const parsed = webSearchDigestRole.parse({ rankedResults: [], discardedCount: 0 });
      expect(parsed).toEqual({ rankedResults: [], discardedCount: 0, refinedAnswer: undefined });
    });

    it('returns null on non-object input', () => {
      expect(webSearchDigestRole.parse(null)).toBeNull();
      expect(webSearchDigestRole.parse('string')).toBeNull();
      expect(webSearchDigestRole.parse(42)).toBeNull();
    });
  });

  describe('formatForMain', () => {
    it('renders the query, summary, results, and a discarded-count note', () => {
      const original = makeResponse([], { query: 'orig query' });
      const out = webSearchDigestRole.formatForMain({
        rankedResults: [
          { title: 'First', url: 'https://a', snippet: 'snip a', reason: 'directly relevant' }
        ],
        refinedAnswer: 'refined summary',
        discardedCount: 3
      }, original);
      expect(out).toContain('orig query');
      expect(out).toContain('refined summary');
      expect(out).toContain('First');
      expect(out).toContain('https://a');
      expect(out).toContain('snip a');
      expect(out).toContain('directly relevant');
      expect(out).toMatch(/considered 4 results/);
    });

    it('omits the discarded-count line when none were discarded', () => {
      const original = makeResponse([]);
      const out = webSearchDigestRole.formatForMain({
        rankedResults: [
          { title: 'A', url: 'https://a', snippet: 's', reason: 'r' }
        ],
        discardedCount: 0
      }, original);
      expect(out).not.toMatch(/considered/);
    });
  });
});
