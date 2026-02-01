/**
 * Tests for deepClone utility
 */

import { describe, it, expect } from 'vitest';
import { deepClone } from '../../../media/utils/deepClone';

describe('deepClone', () => {
  describe('primitives', () => {
    it('clones numbers', () => {
      expect(deepClone(42)).toBe(42);
      expect(deepClone(0)).toBe(0);
      expect(deepClone(-1)).toBe(-1);
    });

    it('clones strings', () => {
      expect(deepClone('hello')).toBe('hello');
      expect(deepClone('')).toBe('');
    });

    it('clones booleans', () => {
      expect(deepClone(true)).toBe(true);
      expect(deepClone(false)).toBe(false);
    });

    it('clones null', () => {
      expect(deepClone(null)).toBe(null);
    });

    it('clones undefined', () => {
      expect(deepClone(undefined)).toBe(undefined);
    });
  });

  describe('arrays', () => {
    it('clones empty arrays', () => {
      const arr: unknown[] = [];
      const cloned = deepClone(arr);
      expect(cloned).toEqual([]);
      expect(cloned).not.toBe(arr);
    });

    it('clones flat arrays', () => {
      const arr = [1, 2, 3];
      const cloned = deepClone(arr);
      expect(cloned).toEqual([1, 2, 3]);
      expect(cloned).not.toBe(arr);
    });

    it('clones nested arrays', () => {
      const arr = [[1, 2], [3, 4]];
      const cloned = deepClone(arr);
      expect(cloned).toEqual([[1, 2], [3, 4]]);
      expect(cloned).not.toBe(arr);
      expect(cloned[0]).not.toBe(arr[0]);
    });

    it('mutations do not affect original', () => {
      const arr = [1, 2, 3];
      const cloned = deepClone(arr);
      cloned.push(4);
      expect(arr).toEqual([1, 2, 3]);
      expect(cloned).toEqual([1, 2, 3, 4]);
    });
  });

  describe('objects', () => {
    it('clones empty objects', () => {
      const obj = {};
      const cloned = deepClone(obj);
      expect(cloned).toEqual({});
      expect(cloned).not.toBe(obj);
    });

    it('clones flat objects', () => {
      const obj = { a: 1, b: 2 };
      const cloned = deepClone(obj);
      expect(cloned).toEqual({ a: 1, b: 2 });
      expect(cloned).not.toBe(obj);
    });

    it('clones nested objects', () => {
      const obj = { foo: { bar: { baz: 1 } } };
      const cloned = deepClone(obj);
      expect(cloned).toEqual({ foo: { bar: { baz: 1 } } });
      expect(cloned).not.toBe(obj);
      expect(cloned.foo).not.toBe(obj.foo);
      expect(cloned.foo.bar).not.toBe(obj.foo.bar);
    });

    it('mutations do not affect original', () => {
      const obj = { a: 1, nested: { b: 2 } };
      const cloned = deepClone(obj);
      cloned.a = 99;
      cloned.nested.b = 99;
      expect(obj.a).toBe(1);
      expect(obj.nested.b).toBe(2);
    });
  });

  describe('special objects', () => {
    it('clones Date objects', () => {
      const date = new Date('2024-01-01');
      const cloned = deepClone(date);
      expect(cloned).toEqual(date);
      expect(cloned).not.toBe(date);
      expect(cloned.getTime()).toBe(date.getTime());
    });

    it('clones RegExp objects', () => {
      const regex = /abc/gi;
      const cloned = deepClone(regex);
      expect(cloned.source).toBe(regex.source);
      expect(cloned.flags).toBe(regex.flags);
      expect(cloned).not.toBe(regex);
    });
  });

  describe('mixed structures', () => {
    it('clones complex nested structures', () => {
      const complex = {
        arr: [1, { a: 2 }, [3, 4]],
        obj: { nested: { deep: true } },
        date: new Date('2024-01-01'),
        str: 'hello',
        num: 42,
        bool: true,
        nil: null
      };

      const cloned = deepClone(complex);

      expect(cloned).toEqual(complex);
      expect(cloned).not.toBe(complex);
      expect(cloned.arr).not.toBe(complex.arr);
      expect(cloned.obj).not.toBe(complex.obj);
      expect(cloned.date).not.toBe(complex.date);
    });
  });
});
