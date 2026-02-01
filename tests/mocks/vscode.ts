/**
 * Mock VS Code API for testing
 */

import { vi } from 'vitest';

export interface MockVSCodeAPI {
  postMessage: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
}

/**
 * Create a fresh mock VS Code API
 */
export function createMockVSCodeAPI(): MockVSCodeAPI {
  const state: Record<string, unknown> = {};

  return {
    postMessage: vi.fn(),
    getState: vi.fn(() => ({ ...state })),
    setState: vi.fn((newState: Record<string, unknown>) => {
      Object.assign(state, newState);
    })
  };
}
