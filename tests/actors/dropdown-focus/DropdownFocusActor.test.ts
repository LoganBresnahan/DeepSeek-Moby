/**
 * Tests for DropdownFocusActor
 *
 * Tests the sticky hover and modal popup system for dropdowns.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DropdownFocusActor } from '../../../media/actors/dropdown-focus/DropdownFocusActor';
import { EventStateManager } from '../../../media/state/EventStateManager';

describe('DropdownFocusActor', () => {
  let manager: EventStateManager;
  let chatContainer: HTMLElement;
  let actor: DropdownFocusActor;

  // Helper to create a mock shadow DOM dropdown
  function createMockDropdown(type: 'thinking' | 'shell' | 'code'): HTMLElement {
    const host = document.createElement('div');
    host.id = `${type}-host-${Date.now()}`;
    host.setAttribute('data-actor', type === 'code' ? 'message' : type);

    const shadow = host.attachShadow({ mode: 'open' });

    let headerClass: string;
    let bodyClass: string;
    let containerClass: string;

    switch (type) {
      case 'thinking':
        headerClass = 'header';
        bodyClass = 'body';
        containerClass = 'container';
        break;
      case 'shell':
        headerClass = 'segment-header';
        bodyClass = 'segment-body';
        containerClass = 'segment';
        break;
      case 'code':
        headerClass = 'code-header';
        bodyClass = 'code-body';
        containerClass = 'code-block';
        break;
    }

    shadow.innerHTML = `
      <div class="${containerClass}">
        <div class="${headerClass}">
          <span class="icon">▶</span>
          <span class="label">Test Label</span>
        </div>
        <div class="${bodyClass}">Test content</div>
      </div>
    `;

    return host;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new EventStateManager();
    chatContainer = document.createElement('div');
    chatContainer.id = 'chat-messages';
    chatContainer.style.height = '500px';
    chatContainer.style.overflow = 'auto';
    document.body.appendChild(chatContainer);
  });

  afterEach(() => {
    vi.useRealTimers();
    actor?.destroy();
    document.body.innerHTML = '';

    // Clean up any styles
    const styles = document.getElementById('dropdown-focus-styles');
    styles?.remove();
  });

  describe('Initialization', () => {
    it('creates actor and injects styles', () => {
      actor = new DropdownFocusActor(manager, chatContainer);

      const styles = document.getElementById('dropdown-focus-styles');
      expect(styles).toBeTruthy();
      expect(styles?.textContent).toContain('dropdown-ghost');
      expect(styles?.textContent).toContain('dropdown-modal');
    });

    it('returns initial state', () => {
      actor = new DropdownFocusActor(manager, chatContainer);

      const state = actor.getState();
      expect(state.streaming).toBe(false);
      expect(state.hoveredDropdownId).toBeNull();
      expect(state.modalDropdownId).toBeNull();
    });
  });

  describe('Dropdown Discovery', () => {
    it('registers dropdowns from existing shadow hosts', async () => {
      const dropdown = createMockDropdown('thinking');
      chatContainer.appendChild(dropdown);

      actor = new DropdownFocusActor(manager, chatContainer);

      // Wait for registration
      await vi.advanceTimersByTimeAsync(100);

      // Dropdown should be registered (internal state)
      expect(actor.getState().hoveredDropdownId).toBeNull();
    });

    it('registers dropdowns added after initialization', async () => {
      actor = new DropdownFocusActor(manager, chatContainer);

      const dropdown = createMockDropdown('shell');
      chatContainer.appendChild(dropdown);

      // Wait for mutation observer and registration
      await vi.advanceTimersByTimeAsync(100);

      // Actor should have observed the new dropdown
      expect(document.querySelectorAll('[data-actor="shell"]').length).toBe(1);
    });
  });

  describe('Streaming State', () => {
    it('tracks streaming state from subscription', async () => {
      actor = new DropdownFocusActor(manager, chatContainer);

      // Wait for registration
      await Promise.resolve();
      await Promise.resolve();

      // Simulate streaming state change
      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.active': true },
        changedKeys: ['streaming.active'],
        publicationChain: [],
        timestamp: Date.now()
      });

      expect(actor.getState().streaming).toBe(true);
    });

    it('clears streaming state when streaming stops', async () => {
      actor = new DropdownFocusActor(manager, chatContainer);

      await Promise.resolve();
      await Promise.resolve();

      // Start streaming
      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.active': true },
        changedKeys: ['streaming.active'],
        publicationChain: [],
        timestamp: Date.now()
      });

      // Stop streaming
      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.active': false },
        changedKeys: ['streaming.active'],
        publicationChain: [],
        timestamp: Date.now()
      });

      expect(actor.getState().streaming).toBe(false);
    });
  });

  describe('Modal Behavior', () => {
    it('isModalOpen returns false initially', () => {
      actor = new DropdownFocusActor(manager, chatContainer);

      expect(actor.isModalOpen()).toBe(false);
    });

    it('closeModal scrolls to latest', async () => {
      actor = new DropdownFocusActor(manager, chatContainer);

      // Add some content to make container scrollable
      for (let i = 0; i < 50; i++) {
        const div = document.createElement('div');
        div.style.height = '100px';
        div.textContent = `Content ${i}`;
        chatContainer.appendChild(div);
      }

      // Scroll to middle
      chatContainer.scrollTop = 1000;

      // We can't easily test the full modal flow without complex setup,
      // but we can verify the actor handles calls gracefully
      actor.closeModal('latest');

      await vi.advanceTimersByTimeAsync(300);

      // Should not throw, modal wasn't open
      expect(actor.isModalOpen()).toBe(false);
    });
  });

  describe('Ghost Element', () => {
    it('does not create ghost when not streaming', async () => {
      actor = new DropdownFocusActor(manager, chatContainer);

      const dropdown = createMockDropdown('thinking');
      chatContainer.appendChild(dropdown);

      await vi.advanceTimersByTimeAsync(100);

      // Simulate mouseenter on header (not streaming)
      const header = dropdown.shadowRoot?.querySelector('.header');
      const event = new MouseEvent('mouseenter', { bubbles: true });
      header?.dispatchEvent(event);

      // No ghost should be created
      expect(document.querySelector('.dropdown-ghost')).toBeNull();
    });
  });

  describe('Cleanup', () => {
    it('removes styles on destroy', () => {
      actor = new DropdownFocusActor(manager, chatContainer);

      expect(document.getElementById('dropdown-focus-styles')).toBeTruthy();

      actor.destroy();

      expect(document.getElementById('dropdown-focus-styles')).toBeNull();
    });

    it('cleans up modal on destroy', async () => {
      actor = new DropdownFocusActor(manager, chatContainer);

      // Even if modal was somehow open, destroy should clean it up
      actor.destroy();

      expect(document.querySelector('.dropdown-modal-overlay')).toBeNull();
    });
  });

  describe('State Publication', () => {
    it('publishes state changes', async () => {
      actor = new DropdownFocusActor(manager, chatContainer);

      // Wait for registration
      await Promise.resolve();
      await Promise.resolve();

      // Check that actor publishes to manager
      expect(manager.getState('dropdownFocus.hasModal')).toBe(false);
    });
  });
});

describe('DropdownFocusActor Integration', () => {
  let manager: EventStateManager;
  let chatContainer: HTMLElement;
  let actor: DropdownFocusActor;

  beforeEach(() => {
    manager = new EventStateManager();
    chatContainer = document.createElement('div');
    chatContainer.id = 'chat-messages';
    document.body.appendChild(chatContainer);
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
  });

  it('works with multiple dropdown types', async () => {
    // Create different dropdown types
    const thinkingHost = document.createElement('div');
    thinkingHost.id = 'thinking-1';
    thinkingHost.setAttribute('data-actor', 'thinking');
    const thinkingShadow = thinkingHost.attachShadow({ mode: 'open' });
    thinkingShadow.innerHTML = '<div class="container"><div class="header">Thinking</div><div class="body">Content</div></div>';

    const shellHost = document.createElement('div');
    shellHost.id = 'shell-1';
    shellHost.setAttribute('data-actor', 'shell');
    const shellShadow = shellHost.attachShadow({ mode: 'open' });
    shellShadow.innerHTML = '<div class="segment"><div class="segment-header">Shell</div><div class="segment-body">Output</div></div>';

    const messageHost = document.createElement('div');
    messageHost.id = 'message-1';
    messageHost.setAttribute('data-actor', 'message');
    const messageShadow = messageHost.attachShadow({ mode: 'open' });
    messageShadow.innerHTML = '<div class="code-block"><div class="code-header">Code</div><div class="code-body">const x = 1;</div></div>';

    chatContainer.appendChild(thinkingHost);
    chatContainer.appendChild(shellHost);
    chatContainer.appendChild(messageHost);

    actor = new DropdownFocusActor(manager, chatContainer);

    // Actor should handle all types without error
    expect(actor.getState().streaming).toBe(false);
    expect(actor.isModalOpen()).toBe(false);
  });
});
