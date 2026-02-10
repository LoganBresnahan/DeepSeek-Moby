/**
 * Tests for WebviewLogBuffer
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebviewLogBuffer } from '../../../media/logging/WebviewLogBuffer';
import type { WebviewLogEntry } from '../../../media/logging/WebviewLogBuffer';

describe('WebviewLogBuffer', () => {
  let buffer: WebviewLogBuffer;

  beforeEach(() => {
    // Create a fresh instance for each test
    buffer = new (WebviewLogBuffer as any)();
  });

  describe('push', () => {
    it('adds entries to the buffer', () => {
      buffer.push({ timestamp: '2026-01-01T00:00:00.000Z', level: 'info', component: 'Test', message: 'hello' });

      expect(buffer.size).toBe(1);
      expect(buffer.getAll()[0].message).toBe('hello');
    });

    it('does not add entries when disabled', () => {
      buffer.enabled = false;
      buffer.push({ timestamp: '2026-01-01T00:00:00.000Z', level: 'info', component: 'Test', message: 'hello' });

      expect(buffer.size).toBe(0);
    });

    it('evicts oldest entries when buffer is full', () => {
      // Push more than MAX_BUFFER_SIZE (5000) entries
      for (let i = 0; i < 5005; i++) {
        buffer.push({
          timestamp: '2026-01-01T00:00:00.000Z',
          level: 'info',
          component: 'Test',
          message: `msg-${i}`
        });
      }

      expect(buffer.size).toBe(5000);
      const entries = buffer.getAll();
      // First entry should be msg-5 (oldest 5 were evicted)
      expect(entries[0].message).toBe('msg-5');
      expect(entries[entries.length - 1].message).toBe('msg-5004');
    });
  });

  describe('sync', () => {
    it('sends entries via vscode.postMessage', () => {
      const mockVscode = {
        postMessage: vi.fn(),
        getState: vi.fn(),
        setState: vi.fn()
      };

      buffer.initialize(mockVscode);

      buffer.push({ timestamp: '2026-01-01T00:00:00.000Z', level: 'warn', component: 'Test', message: 'warning' });
      buffer.push({ timestamp: '2026-01-01T00:00:01.000Z', level: 'error', component: 'Test', message: 'error' });

      buffer.sync();

      expect(mockVscode.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'webviewLogs',
          entries: expect.arrayContaining([
            expect.objectContaining({ message: 'warning' }),
            expect.objectContaining({ message: 'error' })
          ]),
          webviewSyncTime: expect.any(String)
        })
      );
    });

    it('clears buffer after sync', () => {
      const mockVscode = {
        postMessage: vi.fn(),
        getState: vi.fn(),
        setState: vi.fn()
      };

      buffer.initialize(mockVscode);
      buffer.push({ timestamp: '2026-01-01T00:00:00.000Z', level: 'info', component: 'Test', message: 'hello' });

      expect(buffer.size).toBe(1);
      buffer.sync();
      expect(buffer.size).toBe(0);
    });

    it('does nothing without vscode API', () => {
      buffer.push({ timestamp: '2026-01-01T00:00:00.000Z', level: 'info', component: 'Test', message: 'hello' });

      // Should not throw
      expect(() => buffer.sync()).not.toThrow();
      expect(buffer.size).toBe(1); // Buffer not cleared
    });

    it('does nothing when buffer is empty', () => {
      const mockVscode = {
        postMessage: vi.fn(),
        getState: vi.fn(),
        setState: vi.fn()
      };

      buffer.initialize(mockVscode);
      buffer.sync();

      // postMessage should not have been called (no entries)
      expect(mockVscode.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    it('removes all entries', () => {
      buffer.push({ timestamp: '2026-01-01T00:00:00.000Z', level: 'info', component: 'Test', message: 'hello' });
      buffer.push({ timestamp: '2026-01-01T00:00:01.000Z', level: 'info', component: 'Test', message: 'world' });

      expect(buffer.size).toBe(2);
      buffer.clear();
      expect(buffer.size).toBe(0);
      expect(buffer.getAll()).toHaveLength(0);
    });
  });

  describe('enabled', () => {
    it('can disable and enable', () => {
      buffer.enabled = false;
      buffer.push({ timestamp: '2026-01-01T00:00:00.000Z', level: 'info', component: 'Test', message: 'disabled' });
      expect(buffer.size).toBe(0);

      buffer.enabled = true;
      buffer.push({ timestamp: '2026-01-01T00:00:00.000Z', level: 'info', component: 'Test', message: 'enabled' });
      expect(buffer.size).toBe(1);
    });
  });

  describe('getAll', () => {
    it('returns a copy of the buffer', () => {
      buffer.push({ timestamp: '2026-01-01T00:00:00.000Z', level: 'info', component: 'Test', message: 'hello' });

      const entries = buffer.getAll();
      entries.push({ timestamp: '2026-01-01T00:00:01.000Z', level: 'info', component: 'Test', message: 'extra' });

      // Original buffer should not be affected
      expect(buffer.size).toBe(1);
    });
  });

  describe('dispose', () => {
    it('clears buffer and stops syncing', () => {
      const mockVscode = {
        postMessage: vi.fn(),
        getState: vi.fn(),
        setState: vi.fn()
      };

      buffer.initialize(mockVscode);
      buffer.push({ timestamp: '2026-01-01T00:00:00.000Z', level: 'info', component: 'Test', message: 'hello' });

      buffer.dispose();

      expect(buffer.size).toBe(0);
      // Sync should do nothing after dispose
      buffer.push({ timestamp: '2026-01-01T00:00:00.000Z', level: 'info', component: 'Test', message: 'after' });
      buffer.sync();
      expect(mockVscode.postMessage).not.toHaveBeenCalled();
    });
  });
});
