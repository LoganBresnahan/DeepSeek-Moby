/**
 * Tests for deepEqual utility
 */

import { describe, it, expect } from 'vitest';
import { deepEqual } from '../../../media/utils/deepEqual';

describe('deepEqual', () => {
  describe('primitives', () => {
    it('compares equal numbers', () => {
      expect(deepEqual(42, 42)).toBe(true);
      expect(deepEqual(0, 0)).toBe(true);
      expect(deepEqual(-1, -1)).toBe(true);
    });

    it('compares unequal numbers', () => {
      expect(deepEqual(1, 2)).toBe(false);
      expect(deepEqual(0, 1)).toBe(false);
    });

    it('compares equal strings', () => {
      expect(deepEqual('hello', 'hello')).toBe(true);
      expect(deepEqual('', '')).toBe(true);
    });

    it('compares unequal strings', () => {
      expect(deepEqual('hello', 'world')).toBe(false);
      expect(deepEqual('a', 'A')).toBe(false);
    });

    it('compares booleans', () => {
      expect(deepEqual(true, true)).toBe(true);
      expect(deepEqual(false, false)).toBe(true);
      expect(deepEqual(true, false)).toBe(false);
    });
  });

  describe('null and undefined', () => {
    it('compares null values', () => {
      expect(deepEqual(null, null)).toBe(true);
    });

    it('compares undefined values', () => {
      expect(deepEqual(undefined, undefined)).toBe(true);
    });

    it('distinguishes null from undefined', () => {
      expect(deepEqual(null, undefined)).toBe(false);
      expect(deepEqual(undefined, null)).toBe(false);
    });

    it('distinguishes null/undefined from other values', () => {
      expect(deepEqual(null, 0)).toBe(false);
      expect(deepEqual(undefined, '')).toBe(false);
      expect(deepEqual(null, false)).toBe(false);
    });
  });

  describe('arrays', () => {
    it('compares empty arrays', () => {
      expect(deepEqual([], [])).toBe(true);
    });

    it('compares equal arrays', () => {
      expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
      expect(deepEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    });

    it('compares unequal arrays - different values', () => {
      expect(deepEqual([1, 2, 3], [1, 2, 4])).toBe(false);
    });

    it('compares unequal arrays - different lengths', () => {
      expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
      expect(deepEqual([1, 2, 3], [1, 2])).toBe(false);
    });

    it('compares nested arrays', () => {
      expect(deepEqual([[1, 2], [3, 4]], [[1, 2], [3, 4]])).toBe(true);
      expect(deepEqual([[1, 2], [3, 4]], [[1, 2], [3, 5]])).toBe(false);
    });
  });

  describe('objects', () => {
    it('compares empty objects', () => {
      expect(deepEqual({}, {})).toBe(true);
    });

    it('compares equal objects', () => {
      expect(deepEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    });

    it('compares objects with different key order', () => {
      expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    });

    it('compares unequal objects - different values', () => {
      expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    });

    it('compares unequal objects - different keys', () => {
      expect(deepEqual({ a: 1 }, { b: 1 })).toBe(false);
    });

    it('compares unequal objects - extra keys', () => {
      expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
      expect(deepEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    });

    it('compares nested objects', () => {
      const a = { foo: { bar: [1, 2, 3] } };
      const b = { foo: { bar: [1, 2, 3] } };
      const c = { foo: { bar: [1, 2, 4] } };

      expect(deepEqual(a, b)).toBe(true);
      expect(deepEqual(a, c)).toBe(false);
    });
  });

  describe('special objects', () => {
    it('compares Date objects', () => {
      const d1 = new Date('2024-01-01');
      const d2 = new Date('2024-01-01');
      const d3 = new Date('2024-01-02');

      expect(deepEqual(d1, d2)).toBe(true);
      expect(deepEqual(d1, d3)).toBe(false);
    });

    it('compares RegExp objects', () => {
      expect(deepEqual(/abc/, /abc/)).toBe(true);
      expect(deepEqual(/abc/i, /abc/i)).toBe(true);
      expect(deepEqual(/abc/, /def/)).toBe(false);
      expect(deepEqual(/abc/, /abc/i)).toBe(false);
    });
  });

  describe('mixed types', () => {
    it('distinguishes arrays from objects', () => {
      expect(deepEqual([], {})).toBe(false);
      expect(deepEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
    });

    it('distinguishes primitives from objects', () => {
      expect(deepEqual(1, { valueOf: () => 1 })).toBe(false);
      expect(deepEqual('a', ['a'])).toBe(false);
    });
  });
});
