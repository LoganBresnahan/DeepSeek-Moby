/**
 * Integration Test Helpers
 *
 * Provides utilities for testing the Virtual Rendering architecture
 * (VirtualListActor + MessageTurnActor).
 *
 * NOTE: The full integration test system needs to be rebuilt for the new
 * architecture. These helpers provide basic utilities for future integration tests.
 */

import { vi } from 'vitest';

// VS Code API mock
export interface MockVSCodeAPI {
  postMessage: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
}

export function createMockVSCodeAPI(): MockVSCodeAPI {
  return {
    postMessage: vi.fn(),
    getState: vi.fn(() => ({})),
    setState: vi.fn()
  };
}

export interface TestDOMElements {
  chatMessages: HTMLDivElement;
  messageInput: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
  stopBtn: HTMLButtonElement;
  streamingRoot: HTMLDivElement;
}

/**
 * Creates a minimal DOM structure for testing
 */
export function createTestDOM(): TestDOMElements {
  const chatMessages = document.createElement('div');
  chatMessages.id = 'chatMessages';
  chatMessages.style.height = '500px';
  chatMessages.style.overflow = 'auto';
  document.body.appendChild(chatMessages);

  const messageInput = document.createElement('textarea');
  messageInput.id = 'messageInput';
  document.body.appendChild(messageInput);

  const sendBtn = document.createElement('button');
  sendBtn.id = 'sendBtn';
  sendBtn.style.display = 'flex';
  document.body.appendChild(sendBtn);

  const stopBtn = document.createElement('button');
  stopBtn.id = 'stopBtn';
  stopBtn.style.display = 'none';
  document.body.appendChild(stopBtn);

  const streamingRoot = document.createElement('div');
  streamingRoot.id = 'streamingRoot';
  streamingRoot.style.display = 'none';
  document.body.appendChild(streamingRoot);

  // Add optional elements that chat.ts looks for
  const toastContainer = document.createElement('div');
  toastContainer.id = 'toastContainer';
  document.body.appendChild(toastContainer);

  return {
    chatMessages,
    messageInput,
    sendBtn,
    stopBtn,
    streamingRoot
  };
}

/**
 * Wait for microtasks to complete (actor registration uses queueMicrotask)
 */
export function waitForMicrotasks(): Promise<void> {
  return new Promise(resolve => queueMicrotask(resolve));
}

/**
 * Wait for pub/sub propagation
 * Note: Also waits for microtasks first to ensure actors are registered
 */
export async function waitForPubSub(ms = 10): Promise<void> {
  // First wait for any pending microtasks (like actor registration)
  await waitForMicrotasks();
  // Then wait the specified time for pub/sub propagation
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get all text content from an element including Shadow DOM content
 * Shadow actors render inside shadow roots, so regular textContent won't work
 */
export function getShadowTextContent(element: Element): string {
  let text = '';

  // Get direct text content (text nodes only)
  element.childNodes.forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent || '';
    }
  });

  // Recursively get content from child elements (including shadow roots)
  element.querySelectorAll('*').forEach(child => {
    // If element has a shadow root, get content from it
    if (child.shadowRoot) {
      text += getShadowTextContent(child.shadowRoot as unknown as Element);
    }
    // Get text nodes directly in this element
    child.childNodes.forEach(node => {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent || '';
      }
    });
  });

  return text;
}

/**
 * Query selector that searches inside shadow roots
 */
export function queryShadowSelector(root: Element | Document, selector: string): Element | null {
  // First try direct query
  const direct = root.querySelector(selector);
  if (direct) return direct;

  // Search in shadow roots
  const elements = root.querySelectorAll('*');
  for (const el of elements) {
    if (el.shadowRoot) {
      const found = el.shadowRoot.querySelector(selector);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Query all matching selectors including inside shadow roots
 */
export function queryShadowSelectorAll(root: Element | Document, selector: string): Element[] {
  const results: Element[] = [];

  // Get direct matches
  root.querySelectorAll(selector).forEach(el => results.push(el));

  // Search in shadow roots
  root.querySelectorAll('*').forEach(el => {
    if (el.shadowRoot) {
      el.shadowRoot.querySelectorAll(selector).forEach(found => results.push(found));
    }
  });

  return results;
}
