/**
 * Snapshot tests for SidebarActor
 * Captures DOM output for visual regression detection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { SidebarActor, HistoryItem } from '../../../media/actors/sidebar/SidebarActor';

describe('SidebarActor Snapshots', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: SidebarActor;

  // Use fixed timestamps for consistent snapshots
  const baseTime = 1700000000000; // Fixed timestamp

  const mockSessions: HistoryItem[] = [
    {
      id: 'session-snap-1',
      title: 'TypeScript Help',
      model: 'deepseek-chat',
      messageCount: 10,
      updatedAt: baseTime - 1000 * 60 * 30 // 30 min before base
    },
    {
      id: 'session-snap-2',
      title: 'React Components',
      model: 'deepseek-reasoner',
      messageCount: 5,
      updatedAt: baseTime - 1000 * 60 * 60 * 24 // 1 day before base
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

  describe('empty state', () => {
    it('renders empty sidebar', () => {
      expect(element.innerHTML).toMatchSnapshot();
    });
  });

  describe('with sessions', () => {
    it('renders session list', () => {
      actor.setSessions(mockSessions);
      expect(element.innerHTML).toMatchSnapshot();
    });
  });

  describe('loading state', () => {
    it('renders loading spinner', () => {
      actor.setLoading(true);
      expect(element.innerHTML).toMatchSnapshot();
    });
  });

  describe('injected styles', () => {
    it('injects styles into document head', () => {
      const styleTag = document.querySelector('style[data-actor="sidebar"]');
      expect(styleTag).toBeTruthy();
      expect(styleTag?.textContent).toMatchSnapshot();
    });
  });
});

describe('SidebarActor State Snapshots', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: SidebarActor;

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

  it('captures initial state', () => {
    expect(actor.getState()).toMatchSnapshot();
  });

  it('captures state with search query', () => {
    const searchInput = element.querySelector('.sidebar-search-input') as HTMLInputElement;
    searchInput.value = 'typescript';
    searchInput.dispatchEvent(new Event('input'));
    expect(actor.getState()).toMatchSnapshot();
  });
});
