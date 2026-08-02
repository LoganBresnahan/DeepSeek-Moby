/**
 * tolerantJsonParse (plan Phase 2).
 *
 * Lives in the router rather than in a role's `parse` because the router does
 * the JSON.parse — a fenced response fails there and never reaches the role.
 * Vision backends are the worst offenders (many ignore `response_format`), but
 * every role benefits.
 */

import { describe, it, expect } from 'vitest';
import { tolerantJsonParse } from '../../../src/subagents/router';

describe('tolerantJsonParse', () => {
  it('parses clean JSON', () => {
    expect(tolerantJsonParse('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses JSON with surrounding whitespace', () => {
    expect(tolerantJsonParse('\n  {"a":1}\n ')).toEqual({ a: 1 });
  });

  it('strips a ```json fence', () => {
    expect(tolerantJsonParse('```json\n{"description":"a whale"}\n```')).toEqual({ description: 'a whale' });
  });

  it('strips a bare ``` fence', () => {
    expect(tolerantJsonParse('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('recovers JSON wrapped in prose', () => {
    expect(tolerantJsonParse('Sure! Here is the result:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  it('recovers from a fence followed by trailing commentary', () => {
    expect(tolerantJsonParse('```json\n{"a":1}\n```\nLet me know if you need more.')).toEqual({ a: 1 });
  });

  it('handles nested objects when scanning for braces', () => {
    expect(tolerantJsonParse('noise {"a":{"b":[1,2]}} noise')).toEqual({ a: { b: [1, 2] } });
  });

  it('preserves arrays at the top level', () => {
    expect(tolerantJsonParse('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('throws on unparseable input so the caller keeps its parse-fail path', () => {
    expect(() => tolerantJsonParse('not json at all')).toThrow();
    expect(() => tolerantJsonParse('')).toThrow();
  });

  it('throws when the braces contain malformed JSON', () => {
    expect(() => tolerantJsonParse('{this is not, valid}')).toThrow();
  });
});
