/**
 * Vitest global test setup
 */

import { beforeEach, afterEach, vi } from 'vitest';

// Reset unique ID counter before each test
beforeEach(() => {
  // Import dynamically to reset module state
  vi.resetModules();
});

// Cleanup after each test
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
