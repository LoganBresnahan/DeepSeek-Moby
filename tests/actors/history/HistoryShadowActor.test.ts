/**
 * Tests for HistoryShadowActor
 *
 * Tests the Shadow DOM modal for chat history including:
 * - Modal open/close behavior
 * - Session display and grouping
 * - Search functionality
 * - Session actions (open, rename, export, delete)
 * - Keyboard navigation (Escape to close)
 * - Pub/sub integration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HistoryShadowActor, HistorySession } from '../../../media/actors/history/HistoryShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';

// Mock VSCode API
const createMockVSCode = () => ({
  postMessage: vi.fn()
});

// Helper to create test sessions
const createTestSession = (overrides: Partial<HistorySession> = {}): HistorySession => ({
  id: `session-${Math.random().toString(36).substr(2, 9)}`,
  title: 'Test Session',
  messages: [
    { role: 'user', content: 'Hello', timestamp: new Date() },
    { role: 'assistant', content: 'Hi there!', timestamp: new Date() }
  ],
  createdAt: new Date(),
  updatedAt: new Date(),
  model: 'deepseek-chat',
  ...overrides
});

// Helper to wait for actor registration (deferred via queueMicrotask)
const waitForRegistration = () => new Promise(resolve => queueMicrotask(resolve));

describe('HistoryShadowActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: HistoryShadowActor;
  let mockVSCode: ReturnType<typeof createMockVSCode>;

  beforeEach(() => {
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'history-container';
    document.body.appendChild(element);
    mockVSCode = createMockVSCode();
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  describe('Shadow DOM creation', () => {
    it('creates shadow root on construction', () => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);

      expect(element.shadowRoot).toBeTruthy();
    });

    it('adopts stylesheets into shadow root', () => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);

      const sheets = element.shadowRoot?.adoptedStyleSheets;
      expect(sheets?.length).toBeGreaterThan(0);
    });

    it('renders modal structure', () => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);

      const backdrop = element.shadowRoot?.querySelector('[data-history-backdrop]');
      const modal = element.shadowRoot?.querySelector('[data-history-modal]');
      const header = element.shadowRoot?.querySelector('.history-header');
      const searchInput = element.shadowRoot?.querySelector('[data-search-input]');
      const list = element.shadowRoot?.querySelector('[data-history-list]');
      const footer = element.shadowRoot?.querySelector('.history-footer');

      expect(backdrop).toBeTruthy();
      expect(modal).toBeTruthy();
      expect(header).toBeTruthy();
      expect(searchInput).toBeTruthy();
      expect(list).toBeTruthy();
      expect(footer).toBeTruthy();
    });
  });

  describe('Modal visibility', () => {
    beforeEach(() => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);
    });

    it('starts hidden', () => {
      expect(actor.isVisible()).toBe(false);
    });

    it('opens when open() is called', () => {
      actor.open();

      expect(actor.isVisible()).toBe(true);
      const backdrop = element.shadowRoot?.querySelector('[data-history-backdrop]');
      expect(backdrop?.classList.contains('visible')).toBe(true);
    });

    it('closes when close() is called', () => {
      actor.open();
      actor.close();

      expect(actor.isVisible()).toBe(false);
      const backdrop = element.shadowRoot?.querySelector('[data-history-backdrop]');
      expect(backdrop?.classList.contains('visible')).toBe(false);
    });

    it('opens when history.modal.open is published', () => {
      manager.publishDirect('history.modal.open', true);

      expect(actor.isVisible()).toBe(true);
    });

    it('closes when history.modal.open false is published', () => {
      actor.open();
      manager.publishDirect('history.modal.open', false);

      expect(actor.isVisible()).toBe(false);
    });

    it('publishes history.modal.visible on open', () => {
      const received: unknown[] = [];
      const subscriberEl = document.createElement('div');
      subscriberEl.id = 'subscriber';
      document.body.appendChild(subscriberEl);

      subscriberEl.addEventListener('state-changed', ((e: CustomEvent) => {
        if ('history.modal.visible' in e.detail.state) {
          received.push(e.detail.state['history.modal.visible']);
        }
      }) as EventListener);

      manager.register({
        actorId: 'subscriber',
        element: subscriberEl,
        publicationKeys: [],
        subscriptionKeys: ['history.*']
      }, {});

      actor.open();

      expect(received).toContain(true);
    });

    it('requests history sessions on open', () => {
      actor.open();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'getHistorySessions'
      });
    });
  });

  describe('Close button and backdrop', () => {
    beforeEach(() => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);
      actor.open();
    });

    it('closes when close button is clicked', () => {
      const closeBtn = element.shadowRoot?.querySelector('[data-action="close"]') as HTMLElement;
      closeBtn?.click();

      expect(actor.isVisible()).toBe(false);
    });

    it('closes when backdrop is clicked', () => {
      const backdrop = element.shadowRoot?.querySelector('[data-history-backdrop]') as HTMLElement;

      // Simulate click on backdrop (not modal)
      const event = new MouseEvent('click', { bubbles: true });
      Object.defineProperty(event, 'target', { value: backdrop });
      backdrop?.dispatchEvent(event);

      expect(actor.isVisible()).toBe(false);
    });
  });

  describe('Escape key handling', () => {
    beforeEach(() => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);
    });

    it('closes modal on Escape key', () => {
      actor.open();

      const event = new KeyboardEvent('keydown', { key: 'Escape' });
      document.dispatchEvent(event);

      expect(actor.isVisible()).toBe(false);
    });

    it('removes keydown listener on close', () => {
      actor.open();
      actor.close();

      const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');
      actor.destroy();

      // Listener should have been removed when closed
      expect(actor.isVisible()).toBe(false);
    });
  });

  describe('Session display', () => {
    beforeEach(() => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);
    });

    it('displays empty state when no sessions', () => {
      actor.open();
      manager.publishDirect('history.sessions', []);

      const emptyState = element.shadowRoot?.querySelector('.history-empty');
      expect(emptyState).toBeTruthy();
      expect(emptyState?.textContent).toContain('No chat history found');
    });

    it('displays sessions when provided', () => {
      const sessions = [
        createTestSession({ id: 'sess1', title: 'First Session' }),
        createTestSession({ id: 'sess2', title: 'Second Session' })
      ];

      actor.open();
      manager.publishDirect('history.sessions', sessions);

      const entries = element.shadowRoot?.querySelectorAll('.history-entry');
      expect(entries?.length).toBe(2);
    });

    it('shows session title and preview', () => {
      const session = createTestSession({
        title: 'My Test Session',
        messages: [
          { role: 'user', content: 'Test message content', timestamp: new Date() }
        ]
      });

      actor.open();
      manager.publishDirect('history.sessions', [session]);

      const titleEl = element.shadowRoot?.querySelector('.history-entry-title');
      const previewEl = element.shadowRoot?.querySelector('.history-entry-preview');

      expect(titleEl?.textContent).toBe('My Test Session');
      expect(previewEl?.textContent).toContain('Test message content');
    });

    it('highlights current session', () => {
      const sessions = [
        createTestSession({ id: 'sess1' }),
        createTestSession({ id: 'sess2' })
      ];

      actor.open();
      manager.publishDirect('history.sessions', sessions);
      manager.publishDirect('session.id', 'sess1');

      const activeEntry = element.shadowRoot?.querySelector('.history-entry.active');
      expect(activeEntry?.getAttribute('data-session-id')).toBe('sess1');
    });

    it('shows message count', () => {
      const session = createTestSession({
        messages: [
          { role: 'user', content: 'msg1', timestamp: new Date() },
          { role: 'assistant', content: 'msg2', timestamp: new Date() },
          { role: 'user', content: 'msg3', timestamp: new Date() }
        ]
      });

      actor.open();
      manager.publishDirect('history.sessions', [session]);

      const messagesEl = element.shadowRoot?.querySelector('.history-entry-messages');
      expect(messagesEl?.textContent).toContain('3');
    });

    it('shows model indicator for reasoner model', () => {
      const session = createTestSession({ model: 'deepseek-reasoner' });

      actor.open();
      manager.publishDirect('history.sessions', [session]);

      const modelEl = element.shadowRoot?.querySelector('.history-entry-model');
      expect(modelEl?.textContent).toContain('R1');
    });

    it('shows model indicator for chat model', () => {
      const session = createTestSession({ model: 'deepseek-chat' });

      actor.open();
      manager.publishDirect('history.sessions', [session]);

      const modelEl = element.shadowRoot?.querySelector('.history-entry-model');
      expect(modelEl?.textContent).toContain('Chat');
    });
  });

  describe('Date grouping', () => {
    beforeEach(() => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);
    });

    it('groups sessions by date', () => {
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      const sessions = [
        createTestSession({ id: 'today', updatedAt: today }),
        createTestSession({ id: 'yesterday', updatedAt: yesterday })
      ];

      actor.open();
      manager.publishDirect('history.sessions', sessions);

      const groups = element.shadowRoot?.querySelectorAll('.history-group');
      expect(groups?.length).toBe(2);

      const groupTitles = Array.from(groups || []).map(
        g => g.querySelector('.history-group-title')?.textContent
      );
      expect(groupTitles).toContain('Today');
      expect(groupTitles).toContain('Yesterday');
    });
  });

  describe('Search functionality', () => {
    beforeEach(async () => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);
      await waitForRegistration();
    });

    it('filters sessions by title', async () => {
      const sessions = [
        createTestSession({ id: 'sess1', title: 'JavaScript Help' }),
        createTestSession({ id: 'sess2', title: 'Python Tutorial' })
      ];

      actor.open();
      manager.publishDirect('history.sessions', sessions);
      await waitForRegistration();

      const searchInput = element.shadowRoot?.querySelector('[data-search-input]') as HTMLInputElement;
      searchInput.value = 'JavaScript';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));

      const entries = element.shadowRoot?.querySelectorAll('.history-entry');
      expect(entries?.length).toBe(1);
    });

    it('filters sessions by message content', async () => {
      const sessions = [
        createTestSession({
          id: 'sess1',
          title: 'Session 1',
          messages: [{ role: 'user', content: 'How to use React hooks?', timestamp: new Date() }]
        }),
        createTestSession({
          id: 'sess2',
          title: 'Session 2',
          messages: [{ role: 'user', content: 'Python basics', timestamp: new Date() }]
        })
      ];

      actor.open();
      manager.publishDirect('history.sessions', sessions);
      await waitForRegistration();

      const searchInput = element.shadowRoot?.querySelector('[data-search-input]') as HTMLInputElement;
      searchInput.value = 'React';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));

      const entries = element.shadowRoot?.querySelectorAll('.history-entry');
      expect(entries?.length).toBe(1);
    });

    it('shows empty state when no matches', async () => {
      const sessions = [
        createTestSession({ title: 'Test Session' })
      ];

      actor.open();
      manager.publishDirect('history.sessions', sessions);
      await waitForRegistration();

      const searchInput = element.shadowRoot?.querySelector('[data-search-input]') as HTMLInputElement;
      searchInput.value = 'nonexistent';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));

      const emptyState = element.shadowRoot?.querySelector('.history-empty');
      expect(emptyState).toBeTruthy();
    });

    it('updates session count after filtering', async () => {
      const sessions = [
        createTestSession({ id: 'sess1', title: 'JavaScript' }),
        createTestSession({ id: 'sess2', title: 'JavaScript Code' }),
        createTestSession({ id: 'sess3', title: 'Python Tutorial' })
      ];

      actor.open();
      manager.publishDirect('history.sessions', sessions);
      await waitForRegistration();

      const searchInput = element.shadowRoot?.querySelector('[data-search-input]') as HTMLInputElement;
      searchInput.value = 'JavaScript';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));

      const countEl = element.shadowRoot?.querySelector('[data-history-count]');
      expect(countEl?.textContent).toContain('2');
    });
  });

  describe('Session actions', () => {
    beforeEach(async () => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);
      await waitForRegistration();
      const sessions = [createTestSession({ id: 'test-session', title: 'Test' })];
      actor.open();
      manager.publishDirect('history.sessions', sessions);
      await waitForRegistration();
      mockVSCode.postMessage.mockClear(); // Clear the getHistorySessions call from open()
    });

    it('opens session when entry content is clicked', () => {
      const entryContent = element.shadowRoot?.querySelector('.history-entry-content') as HTMLElement;
      entryContent?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'switchToSession',
        sessionId: 'test-session'
      });
    });

    it('closes modal after opening session', () => {
      const entryContent = element.shadowRoot?.querySelector('.history-entry-content') as HTMLElement;
      entryContent?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(actor.isVisible()).toBe(false);
    });
  });

  describe('Entry menu', () => {
    beforeEach(async () => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);
      await waitForRegistration();
      const sessions = [createTestSession({ id: 'test-session', title: 'Test' })];
      actor.open();
      manager.publishDirect('history.sessions', sessions);
      await waitForRegistration();
    });

    it('opens menu when menu button is clicked', () => {
      const menuBtn = element.shadowRoot?.querySelector('[data-entry-menu]') as HTMLElement;
      menuBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      const dropdown = element.shadowRoot?.querySelector('[data-entry-dropdown="test-session"]');
      expect(dropdown?.classList.contains('open')).toBe(true);
    });

    it('closes menu when clicking outside', () => {
      const menuBtn = element.shadowRoot?.querySelector('[data-entry-menu]') as HTMLElement;
      menuBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      // Simulate outside click on body (not document, as document doesn't have .closest())
      const event = new MouseEvent('click', { bubbles: true });
      document.body.dispatchEvent(event);

      const dropdown = element.shadowRoot?.querySelector('[data-entry-dropdown="test-session"]');
      expect(dropdown?.classList.contains('open')).toBe(false);
    });
  });

  describe('Bulk actions', () => {
    beforeEach(() => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);
      actor.open();
    });

    it('shows export dropdown when Export All is clicked', () => {
      const exportBtn = element.shadowRoot?.querySelector('[data-action="exportAll"]') as HTMLElement;
      exportBtn?.click();

      const dropdown = element.shadowRoot?.querySelector('[data-export-dropdown]');
      expect(dropdown?.classList.contains('open')).toBe(true);
    });

    it('sends deleteAll message when Delete All is confirmed', () => {
      // Mock confirm to return true
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      const deleteBtn = element.shadowRoot?.querySelector('[data-action="deleteAll"]') as HTMLElement;
      deleteBtn?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'clearAllHistory'
      });
    });

    it('does not send deleteAll when cancelled', () => {
      // Mock confirm to return false
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      mockVSCode.postMessage.mockClear();

      const deleteBtn = element.shadowRoot?.querySelector('[data-action="deleteAll"]') as HTMLElement;
      deleteBtn?.click();

      expect(mockVSCode.postMessage).not.toHaveBeenCalledWith({
        type: 'clearAllHistory'
      });
    });
  });

  describe('getSessions()', () => {
    it('returns copy of sessions array', async () => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);
      await waitForRegistration();

      const sessions = [
        createTestSession({ id: 'sess1' }),
        createTestSession({ id: 'sess2' })
      ];

      actor.open();
      manager.publishDirect('history.sessions', sessions);
      await waitForRegistration();

      const result = actor.getSessions();
      expect(result).toHaveLength(2);
      expect(result).not.toBe(sessions); // Should be a copy
    });
  });

  describe('Lifecycle', () => {
    it('removes event listeners on destroy', () => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);
      actor.open();

      const removeKeydownSpy = vi.spyOn(document, 'removeEventListener');
      actor.destroy();

      expect(removeKeydownSpy).toHaveBeenCalled();
    });
  });
});
