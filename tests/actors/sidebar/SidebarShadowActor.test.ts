/**
 * Tests for SidebarShadowActor
 *
 * Tests Shadow DOM encapsulation, session list rendering,
 * search filtering, and session actions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SidebarShadowActor, HistoryItem } from '../../../media/actors/sidebar/SidebarShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { ShadowActor } from '../../../media/state/ShadowActor';

describe('SidebarShadowActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: SidebarShadowActor;

  const createSession = (overrides: Partial<HistoryItem> = {}): HistoryItem => ({
    id: `session-${Date.now()}-${Math.random()}`,
    title: 'Test Session',
    model: 'deepseek-chat',
    messageCount: 5,
    updatedAt: Date.now(),
    ...overrides
  });

  beforeEach(() => {
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'sidebar-container';
    document.body.appendChild(element);
    ShadowActor.resetInstanceCount();
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
  });

  describe('Shadow DOM creation', () => {
    it('creates shadow root on element', () => {
      actor = new SidebarShadowActor(manager, element);
      expect(element.shadowRoot).toBeTruthy();
    });

    it('renders sidebar structure', () => {
      actor = new SidebarShadowActor(manager, element);

      expect(element.shadowRoot?.querySelector('.sidebar-container')).toBeTruthy();
      expect(element.shadowRoot?.querySelector('.header')).toBeTruthy();
      expect(element.shadowRoot?.querySelector('.search-input')).toBeTruthy();
      expect(element.shadowRoot?.querySelector('.list')).toBeTruthy();
    });
  });

  describe('Session list', () => {
    beforeEach(() => {
      actor = new SidebarShadowActor(manager, element);
    });

    it('shows empty state when no sessions', () => {
      const empty = element.shadowRoot?.querySelector('.empty');
      expect(empty).toBeTruthy();
      expect(empty?.textContent).toContain('No chat history yet');
    });

    it('renders sessions', () => {
      const sessions = [
        createSession({ title: 'Session 1' }),
        createSession({ title: 'Session 2' })
      ];

      actor.setSessions(sessions);

      const items = element.shadowRoot?.querySelectorAll('.item');
      expect(items?.length).toBe(2);
    });

    it('shows session title', () => {
      actor.setSessions([createSession({ title: 'My Chat' })]);

      const title = element.shadowRoot?.querySelector('.item-title');
      expect(title?.textContent).toBe('My Chat');
    });

    it('shows session metadata', () => {
      actor.setSessions([createSession({ messageCount: 10, model: 'deepseek-chat' })]);

      const count = element.shadowRoot?.querySelector('.item-count');
      expect(count?.textContent).toContain('10');
    });

    it('shows reasoner badge for R1 sessions', () => {
      actor.setSessions([createSession({ model: 'deepseek-reasoner' })]);

      const model = element.shadowRoot?.querySelector('.item-model');
      expect(model?.classList.contains('reasoner')).toBe(true);
    });

    it('sorts sessions by updatedAt descending', () => {
      const older = createSession({ title: 'Older', updatedAt: Date.now() - 10000 });
      const newer = createSession({ title: 'Newer', updatedAt: Date.now() });

      actor.setSessions([older, newer]);

      const items = element.shadowRoot?.querySelectorAll('.item-title');
      expect(items?.[0].textContent).toBe('Newer');
      expect(items?.[1].textContent).toBe('Older');
    });
  });

  describe('Date grouping', () => {
    beforeEach(() => {
      actor = new SidebarShadowActor(manager, element);
    });

    it('groups sessions by date', () => {
      const today = createSession({ title: 'Today', updatedAt: Date.now() });
      const yesterday = createSession({ title: 'Yesterday', updatedAt: Date.now() - 24 * 60 * 60 * 1000 });

      actor.setSessions([today, yesterday]);

      const headers = element.shadowRoot?.querySelectorAll('.group-header');
      expect(headers?.length).toBe(2);
    });
  });

  describe('Session selection', () => {
    beforeEach(() => {
      actor = new SidebarShadowActor(manager, element);
    });

    it('calls handler when session clicked', () => {
      const handler = vi.fn();
      actor.onSelect(handler);

      const session = createSession({ id: 'test-id' });
      actor.setSessions([session]);

      const item = element.shadowRoot?.querySelector('.item') as HTMLElement;
      item.click();

      expect(handler).toHaveBeenCalledWith('test-id');
    });

    it('highlights selected session', async () => {
      const session = createSession({ id: 'selected-id' });
      actor.setSessions([session]);

      await Promise.resolve();
      await Promise.resolve();

      manager.handleStateChange({
        source: 'session-actor',
        state: { 'session.id': 'selected-id' },
        changedKeys: ['session.id'],
        publicationChain: [],
        timestamp: Date.now()
      });

      const item = element.shadowRoot?.querySelector('.item');
      expect(item?.classList.contains('active')).toBe(true);
    });
  });

  describe('Session deletion', () => {
    beforeEach(() => {
      actor = new SidebarShadowActor(manager, element);
    });

    it('calls handler when delete clicked', () => {
      const handler = vi.fn();
      actor.onDelete(handler);

      const session = createSession({ id: 'delete-id' });
      actor.setSessions([session]);

      const deleteBtn = element.shadowRoot?.querySelector('.item-delete') as HTMLElement;
      deleteBtn.click();

      expect(handler).toHaveBeenCalledWith('delete-id');
    });

    it('does not select when delete clicked', () => {
      const selectHandler = vi.fn();
      const deleteHandler = vi.fn();
      actor.onSelect(selectHandler);
      actor.onDelete(deleteHandler);

      const session = createSession();
      actor.setSessions([session]);

      const deleteBtn = element.shadowRoot?.querySelector('.item-delete') as HTMLElement;
      deleteBtn.click();

      expect(selectHandler).not.toHaveBeenCalled();
      expect(deleteHandler).toHaveBeenCalled();
    });

    it('removes session from list', () => {
      const session = createSession({ id: 'to-remove' });
      actor.setSessions([session]);

      expect(element.shadowRoot?.querySelectorAll('.item').length).toBe(1);

      actor.removeSession('to-remove');

      expect(element.shadowRoot?.querySelectorAll('.item').length).toBe(0);
    });
  });

  describe('Search', () => {
    beforeEach(() => {
      actor = new SidebarShadowActor(manager, element);
    });

    it('filters sessions by search query', () => {
      const sessions = [
        createSession({ title: 'JavaScript help' }),
        createSession({ title: 'Python tutorial' }),
        createSession({ title: 'Java basics' })
      ];

      actor.setSessions(sessions);
      expect(element.shadowRoot?.querySelectorAll('.item').length).toBe(3);

      const searchInput = element.shadowRoot?.querySelector('.search-input') as HTMLInputElement;
      searchInput.value = 'Java';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));

      // Should show JavaScript and Java
      expect(element.shadowRoot?.querySelectorAll('.item').length).toBe(2);
    });

    it('shows empty state when no matches', () => {
      actor.setSessions([createSession({ title: 'Test' })]);

      const searchInput = element.shadowRoot?.querySelector('.search-input') as HTMLInputElement;
      searchInput.value = 'xyz';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));

      const empty = element.shadowRoot?.querySelector('.empty');
      expect(empty?.textContent).toContain('No matching conversations');
    });

    it('clears search', () => {
      actor.setSessions([createSession({ title: 'Test' })]);

      const searchInput = element.shadowRoot?.querySelector('.search-input') as HTMLInputElement;
      searchInput.value = 'xyz';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));

      actor.clearSearch();

      expect(searchInput.value).toBe('');
      expect(element.shadowRoot?.querySelectorAll('.item').length).toBe(1);
    });
  });

  describe('Loading state', () => {
    beforeEach(() => {
      actor = new SidebarShadowActor(manager, element);
    });

    it('shows loading spinner', () => {
      actor.setLoading(true);

      const loading = element.shadowRoot?.querySelector('.loading');
      expect(loading).toBeTruthy();
    });

    it('hides loading when sessions loaded', () => {
      actor.setLoading(true);
      actor.setSessions([createSession()]);

      const loading = element.shadowRoot?.querySelector('.loading');
      expect(loading).toBeNull();
    });
  });

  describe('Session management', () => {
    beforeEach(() => {
      actor = new SidebarShadowActor(manager, element);
    });

    it('updates existing session', () => {
      const session = createSession({ id: 'update-id', title: 'Original' });
      actor.setSessions([session]);

      actor.updateSession({ ...session, title: 'Updated' });

      const title = element.shadowRoot?.querySelector('.item-title');
      expect(title?.textContent).toBe('Updated');
    });

    it('adds new session if not exists', () => {
      actor.setSessions([createSession({ id: 'existing' })]);
      actor.updateSession(createSession({ id: 'new', title: 'New Session' }));

      expect(element.shadowRoot?.querySelectorAll('.item').length).toBe(2);
    });
  });

  describe('State', () => {
    beforeEach(() => {
      actor = new SidebarShadowActor(manager, element);
    });

    it('returns current state', () => {
      const session = createSession();
      actor.setSessions([session]);

      const state = actor.getState();

      expect(state.sessions.length).toBe(1);
      expect(state.selectedId).toBeNull();
      expect(state.searchQuery).toBe('');
      expect(state.loading).toBe(false);
    });

    it('returns sessions array', () => {
      const sessions = [createSession(), createSession()];
      actor.setSessions(sessions);

      expect(actor.getSessions().length).toBe(2);
    });
  });

  describe('Lifecycle', () => {
    it('cleans up on destroy', () => {
      actor = new SidebarShadowActor(manager, element);
      actor.setSessions([createSession()]);

      actor.destroy();

      expect(element.shadowRoot?.innerHTML).toBe('');
    });
  });
});
