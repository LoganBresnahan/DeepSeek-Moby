/**
 * Tests for wildcardMatch utility
 */

import { describe, it, expect } from 'vitest';
import { wildcardMatch } from '../../../media/utils/wildcardMatch';

describe('wildcardMatch', () => {
  describe('exact matches', () => {
    it('matches identical strings', () => {
      expect(wildcardMatch('streaming.active', 'streaming.active')).toBe(true);
      expect(wildcardMatch('foo', 'foo')).toBe(true);
    });

    it('does not match different strings', () => {
      expect(wildcardMatch('streaming.active', 'streaming.content')).toBe(false);
      expect(wildcardMatch('foo', 'bar')).toBe(false);
    });
  });

  describe('wildcard patterns', () => {
    it('matches single segment wildcards', () => {
      expect(wildcardMatch('streaming.active', 'streaming.*')).toBe(true);
      expect(wildcardMatch('streaming.content', 'streaming.*')).toBe(true);
      expect(wildcardMatch('streaming.thinking', 'streaming.*')).toBe(true);
    });

    it('does not match when namespace differs', () => {
      expect(wildcardMatch('session.active', 'streaming.*')).toBe(false);
      expect(wildcardMatch('message.content', 'streaming.*')).toBe(false);
    });

    it('matches prefix wildcards', () => {
      expect(wildcardMatch('streaming.active', '*.active')).toBe(true);
      expect(wildcardMatch('session.active', '*.active')).toBe(true);
      expect(wildcardMatch('foo.active', '*.active')).toBe(true);
    });

    it('matches global wildcard', () => {
      expect(wildcardMatch('anything', '*')).toBe(true);
      expect(wildcardMatch('streaming.active', '*')).toBe(true);
      expect(wildcardMatch('a.b.c.d', '*')).toBe(true);
    });

    it('matches multi-segment wildcards', () => {
      expect(wildcardMatch('a.b.c', 'a.*')).toBe(true);
      expect(wildcardMatch('a.b.c.d', 'a.*')).toBe(true);
    });

    it('matches middle wildcards', () => {
      expect(wildcardMatch('a.b.c', 'a.*.c')).toBe(true);
      expect(wildcardMatch('a.x.c', 'a.*.c')).toBe(true);
      expect(wildcardMatch('a.foo.c', 'a.*.c')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('handles empty strings', () => {
      expect(wildcardMatch('', '')).toBe(true);
      expect(wildcardMatch('foo', '')).toBe(false);
      expect(wildcardMatch('', 'foo')).toBe(false);
    });

    it('handles patterns without wildcards', () => {
      expect(wildcardMatch('foo.bar', 'foo.bar')).toBe(true);
      expect(wildcardMatch('foo.bar', 'foo.baz')).toBe(false);
    });

    it('handles dots in keys correctly', () => {
      expect(wildcardMatch('streaming.active', 'streaming.active')).toBe(true);
      expect(wildcardMatch('streaming-active', 'streaming.active')).toBe(false);
    });
  });

  describe('common subscription patterns', () => {
    it('matches namespace subscriptions', () => {
      // Actor subscribes to streaming.*
      expect(wildcardMatch('streaming.active', 'streaming.*')).toBe(true);
      expect(wildcardMatch('streaming.content', 'streaming.*')).toBe(true);
      expect(wildcardMatch('streaming.messageId', 'streaming.*')).toBe(true);
    });

    it('matches cross-namespace subscriptions', () => {
      // Actor subscribes to *.expanded
      expect(wildcardMatch('tools.expanded', '*.expanded')).toBe(true);
      expect(wildcardMatch('shell.expanded', '*.expanded')).toBe(true);
      expect(wildcardMatch('pending.expanded', '*.expanded')).toBe(true);
    });

    it('matches specific keys', () => {
      // Actor subscribes to specific key
      expect(wildcardMatch('session.id', 'session.id')).toBe(true);
      expect(wildcardMatch('session.model', 'session.id')).toBe(false);
    });
  });
});
