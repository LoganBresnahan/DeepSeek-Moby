/**
 * Tests for WebviewLogStore
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WebviewLogStore } from '../../../src/logging/WebviewLogStore';
import type { WebviewLogEntry } from '../../../src/logging/WebviewLogStore';

describe('WebviewLogStore', () => {
  let store: WebviewLogStore;

  beforeEach(() => {
    // Create a fresh instance for each test
    store = new (WebviewLogStore as any)();
  });

  describe('import', () => {
    it('adds entries to the store', () => {
      const entries: WebviewLogEntry[] = [
        { timestamp: '2026-01-01T00:00:00.000Z', level: 'info', component: 'Test', message: 'hello' },
        { timestamp: '2026-01-01T00:00:01.000Z', level: 'warn', component: 'Test', message: 'warning' }
      ];

      store.import(entries);

      expect(store.size).toBe(2);
      expect(store.getAll()).toHaveLength(2);
      expect(store.getAll()[0].message).toBe('hello');
      expect(store.getAll()[1].message).toBe('warning');
    });

    it('accumulates entries across multiple imports', () => {
      store.import([
        { timestamp: '2026-01-01T00:00:00.000Z', level: 'info', component: 'A', message: 'first' }
      ]);
      store.import([
        { timestamp: '2026-01-01T00:00:01.000Z', level: 'info', component: 'B', message: 'second' }
      ]);

      expect(store.size).toBe(2);
    });

    it('evicts oldest entries when store exceeds max size', () => {
      // Max size is 5000 - fill it up and then add more
      const batch1: WebviewLogEntry[] = [];
      for (let i = 0; i < 4999; i++) {
        batch1.push({
          timestamp: '2026-01-01T00:00:00.000Z',
          level: 'info',
          component: 'Test',
          message: `msg-${i}`
        });
      }
      store.import(batch1);

      // Add 10 more to overflow
      const batch2: WebviewLogEntry[] = [];
      for (let i = 0; i < 10; i++) {
        batch2.push({
          timestamp: '2026-01-01T00:00:01.000Z',
          level: 'info',
          component: 'Test',
          message: `overflow-${i}`
        });
      }
      store.import(batch2);

      expect(store.size).toBe(5000);
      // Last entries should be the overflow ones
      const all = store.getAll();
      expect(all[all.length - 1].message).toBe('overflow-9');
    });
  });

  describe('getAll', () => {
    it('returns a copy', () => {
      store.import([
        { timestamp: '2026-01-01T00:00:00.000Z', level: 'info', component: 'Test', message: 'hello' }
      ]);

      const entries = store.getAll();
      entries.push({ timestamp: '2026-01-01T00:00:01.000Z', level: 'info', component: 'Test', message: 'extra' });

      expect(store.size).toBe(1);
    });

    it('returns empty array when no entries', () => {
      expect(store.getAll()).toEqual([]);
    });
  });

  describe('clear', () => {
    it('removes all entries', () => {
      store.import([
        { timestamp: '2026-01-01T00:00:00.000Z', level: 'info', component: 'Test', message: 'hello' },
        { timestamp: '2026-01-01T00:00:01.000Z', level: 'info', component: 'Test', message: 'world' }
      ]);

      store.clear();

      expect(store.size).toBe(0);
      expect(store.getAll()).toEqual([]);
    });
  });

  describe('size', () => {
    it('returns 0 when empty', () => {
      expect(store.size).toBe(0);
    });

    it('returns correct count', () => {
      store.import([
        { timestamp: '2026-01-01T00:00:00.000Z', level: 'info', component: 'A', message: 'a' },
        { timestamp: '2026-01-01T00:00:01.000Z', level: 'info', component: 'B', message: 'b' },
        { timestamp: '2026-01-01T00:00:02.000Z', level: 'info', component: 'C', message: 'c' }
      ]);

      expect(store.size).toBe(3);
    });
  });
});
