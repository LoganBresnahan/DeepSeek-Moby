/**
 * Tests for `withLspTimeout` — bounded race against `vscode.commands.executeCommand`.
 *
 * Critical safety net: a misbehaving language server can leave a tool call
 * awaiting forever, stalling the entire chat request. Every behaviour
 * covered here is one the live tool surface depends on.
 */

import { describe, it, expect, vi } from 'vitest';

import { withLspTimeout, LspTimeoutError } from '../../../src/utils/lspTimeout';

describe('withLspTimeout', () => {
  it('resolves with the promise value when it settles before the timeout', async () => {
    const result = await withLspTimeout(Promise.resolve('hello'), 100);
    expect(result).toBe('hello');
  });

  it('throws LspTimeoutError when the promise exceeds the timeout', async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve('late'), 200));
    await expect(withLspTimeout(slow, 50)).rejects.toBeInstanceOf(LspTimeoutError);
  });

  it('LspTimeoutError carries the configured timeout in ms', async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve(null), 200));
    try {
      await withLspTimeout(slow, 75);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(LspTimeoutError);
      expect((e as LspTimeoutError).timeoutMs).toBe(75);
      expect((e as LspTimeoutError).message).toContain('75ms');
    }
  });

  it('re-throws the original error when the underlying promise rejects', async () => {
    const original = new Error('LSP exploded');
    await expect(withLspTimeout(Promise.reject(original), 100)).rejects.toBe(original);
  });

  it('does not fire the timeout after the promise settles', async () => {
    // Spy on setTimeout / clearTimeout to confirm the timer is cancelled.
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    await withLspTimeout(Promise.resolve(42), 1_000);
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('does not race the underlying promise after the timeout fires', async () => {
    let lateResolved = false;
    const slow = new Promise<string>((resolve) => {
      setTimeout(() => {
        lateResolved = true;
        resolve('too late');
      }, 100);
    });
    await expect(withLspTimeout(slow, 30)).rejects.toBeInstanceOf(LspTimeoutError);
    // The promise still resolved internally — we just don't propagate it.
    await new Promise((r) => setTimeout(r, 120));
    expect(lateResolved).toBe(true);
  });

  it('propagates non-Error rejections without coercing', async () => {
    await expect(withLspTimeout(Promise.reject('string-rejection'), 100)).rejects.toBe('string-rejection');
  });

  it('handles a Thenable that is not a real Promise', async () => {
    const thenable: PromiseLike<number> = {
      then(onFulfilled) {
        if (onFulfilled) onFulfilled(7);
        return undefined as never;
      }
    };
    const result = await withLspTimeout(thenable, 100);
    expect(result).toBe(7);
  });
});

describe('LspTimeoutError', () => {
  it('has the expected name for instanceof + telemetry filtering', () => {
    const err = new LspTimeoutError(5000);
    expect(err.name).toBe('LspTimeoutError');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LspTimeoutError);
  });
});
