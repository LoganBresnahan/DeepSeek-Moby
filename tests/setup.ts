/**
 * Vitest global test setup
 */

import { afterEach, vi } from 'vitest';

// Per-test cleanup. Note: we deliberately do NOT call `vi.resetModules()`
// per-test — vitest's `isolate: true` already gives each test file a fresh
// module graph, and tearing modules down ~2000 times per run accumulated
// uncollected v8 contexts that ran the worker out of heap (8 GB) mid-suite.
// Tests that need module-level state reset between cases should opt in
// locally with `beforeEach(() => vi.resetModules())`.
afterEach(() => {
  // Clear all mocks
  vi.clearAllMocks();

  // Clean up DOM
  document.body.innerHTML = '';
});

// Mock VS Code API
const mockVSCodeAPI = {
  postMessage: vi.fn(),
  getState: vi.fn(() => ({})),
  setState: vi.fn()
};

// Global acquireVsCodeApi mock
(globalThis as unknown as { acquireVsCodeApi: () => typeof mockVSCodeAPI }).acquireVsCodeApi = () => mockVSCodeAPI;

/**
 * Wait for microtasks to complete (actor registration uses queueMicrotask)
 */
export function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => queueMicrotask(resolve));
}

// Export for test access
export { mockVSCodeAPI };
