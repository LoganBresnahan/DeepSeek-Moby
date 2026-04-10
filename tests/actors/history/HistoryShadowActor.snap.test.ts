/**
 * Snapshot tests for HistoryShadowActor
 * Captures DOM output for visual regression detection
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HistoryShadowActor, HistorySession } from '../../../media/actors/history/HistoryShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';

// Mock VSCode API
const createMockVSCode = () => ({
  postMessage: vi.fn()
});

// Helper to normalize dynamic IDs in HTML for stable snapshots
function normalizeHtml(html: string): string {
  return html
    // Normalize session IDs
    .replace(/data-session-id="[^"]+"/g, 'data-session-id="SESSION_ID"')
    .replace(/data-entry-menu="[^"]+"/g, 'data-entry-menu="SESSION_ID"')
    .replace(/data-entry-dropdown="[^"]+"/g, 'data-entry-dropdown="SESSION_ID"')
    .replace(/data-export-submenu="[^"]+"/g, 'data-export-submenu="SESSION_ID"')
    // Normalize timestamps
    .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g, 'YYYY-MM-DD HH:MM:SS');
}

// Helper to get shadow root content
function getShadowContent(element: HTMLElement): string {
  const shadowRoot = element.shadowRoot;
  if (!shadowRoot) return '';

  // Get innerHTML but exclude style tag
  const clone = shadowRoot.cloneNode(true) as DocumentFragment;
  const style = clone.querySelector('style');
  style?.remove();

  const container = document.createElement('div');
  container.appendChild(clone);
  return container.innerHTML;
}

// Helper to create test sessions
const createTestSession = (overrides: Partial<HistorySession> = {}): HistorySession => ({
  id: `session-${Math.random().toString(36).substr(2, 9)}`,
  title: 'Test Session',
  messages: [
    { role: 'user', content: 'Hello', timestamp: new Date('2024-01-15T10:30:00') },
    { role: 'assistant', content: 'Hi there!', timestamp: new Date('2024-01-15T10:30:05') }
  ],
  createdAt: new Date('2024-01-15T10:00:00'),
  updatedAt: new Date('2024-01-15T10:30:00'),
  model: 'deepseek-chat',
  ...overrides
});

// Helper to wait for actor registration (deferred via queueMicrotask)
const waitForRegistration = () => new Promise(resolve => queueMicrotask(resolve));

describe('HistoryShadowActor Snapshots', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: HistoryShadowActor;
  let mockVSCode: ReturnType<typeof createMockVSCode>;

  beforeEach(() => {
    manager = new EventStateManager({ batchBroadcasts: false });
    element = document.createElement('div');
    element.id = 'history-container';
    document.body.appendChild(element);
    mockVSCode = createMockVSCode();
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
  });

  describe('Modal structure', () => {
    it('renders initial hidden state', () => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);

      expect(normalizeHtml(getShadowContent(element))).toMatchSnapshot();
    });

    it('renders modal header', () => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);

      const header = element.shadowRoot?.querySelector('.history-header');
      expect(header?.innerHTML).toMatchSnapshot();
    });

    it('renders search input', () => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);

      const search = element.shadowRoot?.querySelector('.history-search');
      expect(search?.innerHTML).toMatchSnapshot();
    });

    it('renders footer with actions', () => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);

      const footer = element.shadowRoot?.querySelector('.history-footer');
      expect(footer?.innerHTML).toMatchSnapshot();
    });
  });

  describe('Empty state', () => {
    it('renders empty state when no sessions', () => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);
      actor.open();
      manager.publishDirect('history.sessions', []);

      const list = element.shadowRoot?.querySelector('[data-history-list]');
      expect(list?.innerHTML).toMatchSnapshot();
    });
  });

  describe('Session list', () => {
    it('renders single session', () => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);
      actor.open();

      const session = createTestSession({
        title: 'My First Chat',
        model: 'deepseek-chat'
      });
      manager.publishDirect('history.sessions', [session]);

      const list = element.shadowRoot?.querySelector('[data-history-list]');
      expect(normalizeHtml(list?.innerHTML || '')).toMatchSnapshot();
    });

    it('renders session with reasoner model', () => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);
      actor.open();

      const session = createTestSession({
        title: 'Complex Problem',
        model: 'deepseek-reasoner'
      });
      manager.publishDirect('history.sessions', [session]);

      const list = element.shadowRoot?.querySelector('[data-history-list]');
      expect(normalizeHtml(list?.innerHTML || '')).toMatchSnapshot();
    });

    it('renders active session highlight', () => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);
      actor.open();

      const session = createTestSession({ id: 'active-session' });
      manager.publishDirect('history.sessions', [session]);
      manager.publishDirect('session.id', 'active-session');

      const entry = element.shadowRoot?.querySelector('.history-entry');
      expect(entry?.outerHTML ? normalizeHtml(entry.outerHTML) : '').toMatchSnapshot();
    });

    it('renders session with long preview', () => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);
      actor.open();

      const session = createTestSession({
        messages: [{
          role: 'user',
          content: 'This is a very long message that should be truncated in the preview. It goes on and on with lots of details about the question being asked.',
          timestamp: new Date('2024-01-15T10:30:00')
        }]
      });
      manager.publishDirect('history.sessions', [session]);

      const preview = element.shadowRoot?.querySelector('.history-entry-preview');
      expect(preview?.innerHTML).toMatchSnapshot();
    });

    it('renders session with no messages', () => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);
      actor.open();

      const session = createTestSession({
        title: 'Empty Chat',
        messages: []
      });
      manager.publishDirect('history.sessions', [session]);

      const preview = element.shadowRoot?.querySelector('.history-entry-preview');
      expect(preview?.innerHTML).toMatchSnapshot();
    });
  });

  describe('Date grouping', () => {
    it('renders date group header', () => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);
      actor.open();

      const today = new Date();
      const session = createTestSession({ updatedAt: today });
      manager.publishDirect('history.sessions', [session]);

      const groupTitle = element.shadowRoot?.querySelector('.history-group-title');
      expect(groupTitle?.innerHTML).toMatchSnapshot();
    });

    it('renders multiple date groups', async () => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);
      await waitForRegistration();
      actor.open();

      const today = new Date();
      // Use a date from last month to ensure it falls into "This Year" category
      // (or "This Month" if we're at the start of the year)
      const lastMonth = new Date(today);
      lastMonth.setMonth(lastMonth.getMonth() - 2);

      const sessions = [
        createTestSession({ id: 'sess1', title: 'Today Session', updatedAt: today }),
        createTestSession({ id: 'sess2', title: 'Older Session', updatedAt: lastMonth })
      ];
      manager.publishDirect('history.sessions', sessions);
      await waitForRegistration();

      const groups = element.shadowRoot?.querySelectorAll('.history-group');
      expect(groups?.length).toBeGreaterThan(1);

      const groupTitles = Array.from(groups || []).map(
        g => g.querySelector('.history-group-title')?.textContent
      );
      expect(groupTitles).toMatchSnapshot();
    });
  });

  describe('Entry dropdown menu', () => {
    it('renders entry menu button', () => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);
      actor.open();
      manager.publishDirect('history.sessions', [createTestSession()]);

      const menuBtn = element.shadowRoot?.querySelector('.history-entry-menu');
      expect(menuBtn?.outerHTML).toMatchSnapshot();
    });

    it('renders dropdown menu structure', () => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);
      actor.open();
      manager.publishDirect('history.sessions', [createTestSession()]);

      const dropdown = element.shadowRoot?.querySelector('.history-entry-dropdown');
      expect(normalizeHtml(dropdown?.innerHTML || '')).toMatchSnapshot();
    });
  });

  describe('Session count', () => {
    it('renders singular session count', () => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);
      actor.open();
      manager.publishDirect('history.sessions', [createTestSession()]);

      const count = element.shadowRoot?.querySelector('[data-history-count]');
      expect(count?.textContent).toMatchSnapshot();
    });

    it('renders plural session count', () => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);
      actor.open();
      manager.publishDirect('history.sessions', [
        createTestSession({ id: 'sess1' }),
        createTestSession({ id: 'sess2' }),
        createTestSession({ id: 'sess3' })
      ]);

      const count = element.shadowRoot?.querySelector('[data-history-count]');
      expect(count?.textContent).toMatchSnapshot();
    });
  });

  describe('Export dropdown', () => {
    it('renders export dropdown structure', () => {
      actor = new HistoryShadowActor(manager, element, mockVSCode);
      actor.open();

      const exportDropdown = element.shadowRoot?.querySelector('[data-export-dropdown]');
      expect(exportDropdown?.innerHTML).toMatchSnapshot();
    });
  });
});
