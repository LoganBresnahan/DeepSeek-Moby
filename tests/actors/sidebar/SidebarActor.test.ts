/**
 * Unit tests for SidebarActor
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushMicrotasks } from '../../setup';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { SidebarActor, HistoryItem } from '../../../media/actors/sidebar/SidebarActor';

describe('SidebarActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: SidebarActor;

  // Factory function to get fresh mock sessions for each test
  const getMockSessions = (): HistoryItem[] => [
    {
      id: 'session-1',
      title: 'TypeScript Help',
      model: 'deepseek-chat',
      messageCount: 10,
      updatedAt: Date.now() - 1000 * 60 * 30 // 30 min ago
    },
    {
      id: 'session-2',
      title: 'React Components',
      model: 'deepseek-reasoner',
      messageCount: 5,
      updatedAt: Date.now() - 1000 * 60 * 60 * 24 // 1 day ago
    },
    {
      id: 'session-3',
      title: 'Database Design',
      model: 'deepseek-chat',
      messageCount: 15,
      updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 7 // 1 week ago
    }
  ];

  beforeEach(() => {
    SidebarActor.resetStylesInjected();

    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'chat-sidebar';
    document.body.appendChild(element);

    actor = new SidebarActor(manager, element);
  });

  afterEach(() => {
    actor.destroy();
    document.body.innerHTML = '';
  });

  describe('initialization', () => {
    it('registers with the manager', async () => {
      await flushMicrotasks();
      expect(manager.hasActor('chat-sidebar-SidebarActor')).toBe(true);
    });

    it('creates DOM structure', () => {
      expect(element.querySelector('.sidebar-header')).toBeTruthy();
      expect(element.querySelector('.sidebar-search-input')).toBeTruthy();
      expect(element.querySelector('.sidebar-list')).toBeTruthy();
    });

    it('starts with empty state', () => {
      const state = actor.getState();
      expect(state.sessions).toEqual([]);
      expect(state.selectedId).toBe(null);
      expect(state.searchQuery).toBe('');
      expect(state.loading).toBe(false);
    });

    it('injects styles into document head', () => {
      const styleTag = document.querySelector('style[data-actor="sidebar"]');
      expect(styleTag).toBeTruthy();
    });

    it('shows empty state message', () => {
      const emptyEl = element.querySelector('.sidebar-empty');
      expect(emptyEl).toBeTruthy();
      expect(emptyEl?.textContent).toContain('No chat history');
    });
  });

  describe('setSessions', () => {
    it('renders session list', () => {
      actor.setSessions(getMockSessions());

      const items = element.querySelectorAll('.sidebar-item');
      expect(items.length).toBe(3);
    });

    it('sorts sessions by date (newest first)', () => {
      actor.setSessions(getMockSessions());

      const items = element.querySelectorAll('.sidebar-item');
      expect(items[0].getAttribute('data-session-id')).toBe('session-1');
    });

    it('displays session titles', () => {
      actor.setSessions(getMockSessions());

      const titles = element.querySelectorAll('.sidebar-item-title');
      expect(titles[0].textContent).toBe('TypeScript Help');
    });

    it('shows model indicator', () => {
      actor.setSessions(getMockSessions());

      const chatModel = element.querySelector('[data-session-id="session-1"] .sidebar-item-model');
      expect(chatModel?.textContent).toContain('Chat');

      const reasonerModel = element.querySelector('[data-session-id="session-2"] .sidebar-item-model');
      expect(reasonerModel?.textContent).toContain('R1');
    });

    it('shows message count', () => {
      actor.setSessions(getMockSessions());

      const count = element.querySelector('[data-session-id="session-1"] .sidebar-item-count');
      expect(count?.textContent).toContain('10');
    });
  });

  describe('session selection', () => {
    it('calls onSelect handler when clicking session', () => {
      const handler = vi.fn();
      actor.onSelect(handler);
      actor.setSessions(getMockSessions());

      const item = element.querySelector('[data-session-id="session-1"]') as HTMLElement;
      item.click();

      expect(handler).toHaveBeenCalledWith('session-1');
    });

    it('highlights active session', () => {
      actor.setSessions(getMockSessions());

      // Simulate session.id change
      manager.handleStateChange({
        source: 'test',
        state: { 'session.id': 'session-2' },
        changedKeys: ['session.id'],
        publicationChain: [],
        timestamp: Date.now()
      });

      const activeItem = element.querySelector('.sidebar-item.active');
      expect(activeItem?.getAttribute('data-session-id')).toBe('session-2');
    });
  });

  describe('search', () => {
    it('filters sessions by title', () => {
      actor.setSessions(getMockSessions());

      const searchInput = element.querySelector('.sidebar-search-input') as HTMLInputElement;
      searchInput.value = 'TypeScript';
      searchInput.dispatchEvent(new Event('input'));

      const items = element.querySelectorAll('.sidebar-item');
      expect(items.length).toBe(1);
      expect(items[0].getAttribute('data-session-id')).toBe('session-1');
    });

    it('shows empty message when no matches', () => {
      actor.setSessions(getMockSessions());

      const searchInput = element.querySelector('.sidebar-search-input') as HTMLInputElement;
      searchInput.value = 'nonexistent';
      searchInput.dispatchEvent(new Event('input'));

      const emptyEl = element.querySelector('.sidebar-empty');
      expect(emptyEl?.textContent).toContain('No matching conversations');
    });

    it('publishes search query changes', () => {
      const spy = vi.spyOn(manager, 'handleStateChange');

      const searchInput = element.querySelector('.sidebar-search-input') as HTMLInputElement;
      searchInput.value = 'test';
      searchInput.dispatchEvent(new Event('input'));

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            'sidebar.searchQuery': 'test'
          })
        })
      );
    });

    it('clearSearch resets filter', () => {
      actor.setSessions(getMockSessions());

      const searchInput = element.querySelector('.sidebar-search-input') as HTMLInputElement;
      searchInput.value = 'TypeScript';
      searchInput.dispatchEvent(new Event('input'));

      expect(element.querySelectorAll('.sidebar-item').length).toBe(1);

      actor.clearSearch();

      expect(element.querySelectorAll('.sidebar-item').length).toBe(3);
      expect(searchInput.value).toBe('');
    });
  });

  describe('updateSession', () => {
    it('updates existing session', () => {
      actor.setSessions(getMockSessions());

      actor.updateSession({
        id: 'session-1',
        title: 'Updated Title',
        model: 'deepseek-chat',
        messageCount: 12,
        updatedAt: Date.now()
      });

      const title = element.querySelector('[data-session-id="session-1"] .sidebar-item-title');
      expect(title?.textContent).toBe('Updated Title');
    });

    it('adds new session', () => {
      actor.setSessions(getMockSessions());

      actor.updateSession({
        id: 'session-4',
        title: 'New Session',
        model: 'deepseek-chat',
        messageCount: 1,
        updatedAt: Date.now()
      });

      expect(element.querySelectorAll('.sidebar-item').length).toBe(4);
    });
  });

  describe('removeSession', () => {
    it('removes session from list', () => {
      actor.setSessions(getMockSessions());

      actor.removeSession('session-1');

      expect(element.querySelectorAll('.sidebar-item').length).toBe(2);
      expect(element.querySelector('[data-session-id="session-1"]')).toBeFalsy();
    });
  });

  describe('loading state', () => {
    it('shows loading spinner', () => {
      actor.setLoading(true);

      const spinner = element.querySelector('.sidebar-loading-spinner');
      expect(spinner).toBeTruthy();
    });

    it('hides loading spinner when sessions loaded', () => {
      actor.setLoading(true);
      actor.setSessions(getMockSessions());

      const spinner = element.querySelector('.sidebar-loading-spinner');
      expect(spinner).toBeFalsy();
    });
  });

  describe('date grouping', () => {
    it('groups sessions by date', () => {
      actor.setSessions(getMockSessions());

      const headers = element.querySelectorAll('.sidebar-group-header');
      expect(headers.length).toBeGreaterThan(0);
    });

    it('shows Today group for recent sessions', () => {
      actor.setSessions([{
        id: 'today-session',
        title: 'Today Session',
        model: 'deepseek-chat',
        messageCount: 1,
        updatedAt: Date.now() - 1000 * 60 * 5 // 5 minutes ago
      }]);

      const headers = element.querySelectorAll('.sidebar-group-header');
      expect(headers[0].textContent).toBe('Today');
    });
  });

  describe('getSessions', () => {
    it('returns copy of sessions', () => {
      actor.setSessions(getMockSessions());

      const sessions = actor.getSessions();
      sessions.push({
        id: 'fake',
        title: 'Fake',
        model: 'deepseek-chat',
        messageCount: 0,
        updatedAt: 0
      });

      expect(actor.getState().sessions.length).toBe(3);
    });
  });
});
