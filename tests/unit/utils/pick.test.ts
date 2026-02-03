/**
 * Tests for pick utility
 */

import { describe, it, expect } from 'vitest';
import { pick } from '../../../media/utils/pick';

describe('pick', () => {
  it('picks specified keys from object', () => {
    const obj = { a: 1, b: 2, c: 3 };
    const result = pick(obj, ['a', 'c']);

    expect(result).toEqual({ a: 1, c: 3 });
  });

  it('returns empty object when no keys specified', () => {
    const obj = { a: 1, b: 2 };
    const result = pick(obj, []);

    expect(result).toEqual({});
  });

  it('ignores keys that do not exist', () => {
    const obj = { a: 1, b: 2 };
    const result = pick(obj, ['a', 'nonexistent' as keyof typeof obj]);

    expect(result).toEqual({ a: 1 });
  });

  it('works with nested objects (shallow copy)', () => {
    const nested = { inner: true };
    const obj = { a: 1, b: nested, c: 3 };
    const result = pick(obj, ['b']);

    expect(result).toEqual({ b: nested });
    // Should be same reference (shallow copy)
    expect(result.b).toBe(nested);
  });

  it('works with various value types', () => {
    const obj = {
      str: 'hello',
      num: 42,
      bool: true,
      nul: null,
      undef: undefined,
      arr: [1, 2, 3],
      fn: () => 'test'
    };

    const result = pick(obj, ['str', 'num', 'bool', 'nul', 'arr']);

    expect(result.str).toBe('hello');
    expect(result.num).toBe(42);
    expect(result.bool).toBe(true);
    expect(result.nul).toBe(null);
    expect(result.arr).toEqual([1, 2, 3]);
  });

  it('does not include inherited properties', () => {
    const proto = { inherited: 'value' };
    const obj = Object.create(proto);
    obj.own = 'property';

    const result = pick(obj, ['own', 'inherited' as keyof typeof obj]);

    expect(result).toEqual({ own: 'property' });
    expect('inherited' in result).toBe(false);
  });

  it('preserves undefined values for existing keys', () => {
    const obj = { a: undefined, b: 2 };
    const result = pick(obj, ['a', 'b']);

    expect(result).toEqual({ a: undefined, b: 2 });
    expect('a' in result).toBe(true);
  });
});
