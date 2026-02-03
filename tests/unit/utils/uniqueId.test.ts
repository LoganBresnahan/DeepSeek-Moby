/**
 * Tests for uniqueId utility
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { uniqueId, resetUniqueIdCounter } from '../../../media/utils/uniqueId';

describe('uniqueId', () => {
  beforeEach(() => {
    resetUniqueIdCounter();
  });

  it('generates unique IDs', () => {
    const id1 = uniqueId();
    const id2 = uniqueId();
    const id3 = uniqueId();

    expect(id1).not.toBe(id2);
    expect(id2).not.toBe(id3);
    expect(id1).not.toBe(id3);
  });

  it('generates incrementing IDs', () => {
    const id1 = uniqueId();
    const id2 = uniqueId();
    const id3 = uniqueId();

    expect(id1).toBe('1');
    expect(id2).toBe('2');
    expect(id3).toBe('3');
  });

  it('applies prefix to IDs', () => {
    const id1 = uniqueId('actor-');
    const id2 = uniqueId('component-');

    expect(id1).toBe('actor-1');
    expect(id2).toBe('component-2');
  });

  it('handles empty prefix', () => {
    const id = uniqueId('');

    expect(id).toBe('1');
  });

  it('continues incrementing across different prefixes', () => {
    const id1 = uniqueId('a-');
    const id2 = uniqueId('b-');
    const id3 = uniqueId('c-');

    expect(id1).toBe('a-1');
    expect(id2).toBe('b-2');
    expect(id3).toBe('c-3');
  });
});

describe('resetUniqueIdCounter', () => {
  it('resets counter to zero', () => {
    uniqueId(); // 1
    uniqueId(); // 2
    uniqueId(); // 3

    resetUniqueIdCounter();

    const id = uniqueId();
    expect(id).toBe('1');
  });

  it('allows full reset between test runs', () => {
    resetUniqueIdCounter();
    expect(uniqueId('test-')).toBe('test-1');

    resetUniqueIdCounter();
    expect(uniqueId('test-')).toBe('test-1');
  });
});
