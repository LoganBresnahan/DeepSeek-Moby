/**
 * Tests for ShellShadowActor
 *
 * Tests Shadow DOM encapsulation, command state management,
 * segment lifecycle, and integration with the pub/sub system.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ShellShadowActor, ShellCommand } from '../../../media/actors/shell/ShellShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { InterleavedShadowActor } from '../../../media/state/InterleavedShadowActor';

describe('ShellShadowActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: ShellShadowActor;

  beforeEach(() => {
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'shell-container';
    document.body.appendChild(element);
    InterleavedShadowActor.resetInstanceCount();
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  describe('Shadow DOM creation', () => {
    it('creates shadow containers for segments', () => {
      actor = new ShellShadowActor(manager, element);
      actor.createSegment(['npm install']);

      // Should have created a shadow container
      const containers = element.querySelectorAll('[data-container-id]');
      expect(containers.length).toBe(1);
    });

    it('each segment gets its own shadow root', () => {
      vi.useFakeTimers();
      actor = new ShellShadowActor(manager, element);

      actor.createSegment(['npm install']);
      vi.advanceTimersByTime(1);
      actor.createSegment(['npm test']);

      const containers = element.querySelectorAll('[data-container-id]');
      expect(containers.length).toBe(2);

      // Each should have its own shadow root
      containers.forEach(container => {
        expect(container.shadowRoot).toBeTruthy();
      });
    });

    it('adopts stylesheets into each shadow root', () => {
      actor = new ShellShadowActor(manager, element);
      actor.createSegment(['npm install']);

      const container = element.querySelector('[data-container-id]');
      const sheets = container?.shadowRoot?.adoptedStyleSheets;
      expect(sheets?.length).toBeGreaterThan(0);
    });
  });

  describe('Segment creation', () => {
    beforeEach(() => {
      actor = new ShellShadowActor(manager, element);
    });

    it('creates a segment with pending commands', () => {
      const segmentId = actor.createSegment(['npm install', 'npm test']);

      expect(segmentId).toBeTruthy();
      const segments = actor.getSegments();
      expect(segments.length).toBe(1);
      expect(segments[0].commands.length).toBe(2);
      expect(segments[0].commands[0].status).toBe('pending');
      expect(segments[0].commands[1].status).toBe('pending');
    });

    it('renders commands in the segment', () => {
      actor.createSegment(['npm install']);

      const container = element.querySelector('[data-container-id]');
      const command = container?.shadowRoot?.querySelector('.command');
      expect(command?.textContent).toContain('npm install');
    });

    it('publishes segment state on creation', async () => {
      const received: unknown[] = [];
      const subscriberEl = document.createElement('div');
      subscriberEl.id = 'subscriber';
      document.body.appendChild(subscriberEl);

      subscriberEl.addEventListener('state-changed', ((e: CustomEvent) => {
        if (e.detail.state['shell.segments']) {
          received.push(e.detail.state['shell.segments']);
        }
      }) as EventListener);

      manager.register({
        actorId: 'subscriber',
        element: subscriberEl,
        publicationKeys: [],
        subscriptionKeys: ['shell.*']
      }, {});

      actor.createSegment(['npm install']);
      await Promise.resolve();

      expect(received.length).toBeGreaterThan(0);
    });
  });

  describe('Segment execution', () => {
    beforeEach(() => {
      actor = new ShellShadowActor(manager, element);
    });

    it('starts segment execution', () => {
      const segmentId = actor.createSegment(['npm install']);
      actor.startSegment(segmentId);

      const segments = actor.getSegments();
      expect(segments[0].commands[0].status).toBe('running');
    });

    it('calls execute handler when starting', () => {
      const handler = vi.fn();
      actor.onExecute(handler);

      const segmentId = actor.createSegment(['npm install', 'npm test']);
      actor.startSegment(segmentId);

      expect(handler).toHaveBeenCalledWith(['npm install', 'npm test']);
    });

    it('shows spinning icon for running commands', () => {
      const segmentId = actor.createSegment(['npm install']);
      actor.startSegment(segmentId);

      const container = element.querySelector('[data-container-id]');
      const statusEl = container?.shadowRoot?.querySelector('.status');
      expect(statusEl?.classList.contains('spinning')).toBe(true);
    });

    it('updates active count during execution', () => {
      const segmentId = actor.createSegment(['npm install', 'npm test']);
      actor.startSegment(segmentId);

      expect(actor.getActiveCount()).toBe(2);
    });
  });

  describe('Result handling', () => {
    beforeEach(() => {
      actor = new ShellShadowActor(manager, element);
    });

    it('sets results for a segment', () => {
      const segmentId = actor.createSegment(['npm install']);
      actor.startSegment(segmentId);
      actor.setResults(segmentId, [{ success: true, output: 'added 100 packages' }]);

      const segments = actor.getSegments();
      expect(segments[0].commands[0].status).toBe('done');
      expect(segments[0].commands[0].output).toBe('added 100 packages');
      expect(segments[0].complete).toBe(true);
    });

    it('marks failed commands as error', () => {
      const segmentId = actor.createSegment(['npm install']);
      actor.startSegment(segmentId);
      actor.setResults(segmentId, [{ success: false, output: 'ENOENT' }]);

      const segments = actor.getSegments();
      expect(segments[0].commands[0].status).toBe('error');
    });

    it('updates active count after completion', () => {
      const segmentId = actor.createSegment(['npm install']);
      actor.startSegment(segmentId);
      expect(actor.getActiveCount()).toBe(1);

      actor.setResults(segmentId, [{ success: true }]);
      expect(actor.getActiveCount()).toBe(0);
    });

    it('renders output in the segment', () => {
      const segmentId = actor.createSegment(['npm install']);
      actor.startSegment(segmentId);
      actor.setResults(segmentId, [{ success: true, output: 'done!' }]);

      const container = element.querySelector('[data-container-id]');
      const output = container?.shadowRoot?.querySelector('.output');
      expect(output?.textContent).toContain('done!');
    });
  });

  describe('Command updates', () => {
    beforeEach(() => {
      actor = new ShellShadowActor(manager, element);
    });

    it('updates individual command status', () => {
      const segmentId = actor.createSegment(['npm install', 'npm test']);
      actor.startSegment(segmentId);

      actor.updateCommand(segmentId, 0, { status: 'done', success: true });

      const segments = actor.getSegments();
      expect(segments[0].commands[0].status).toBe('done');
      expect(segments[0].commands[1].status).toBe('running');
      expect(segments[0].complete).toBe(false);
    });

    it('marks segment complete when all commands done', () => {
      const segmentId = actor.createSegment(['npm install', 'npm test']);
      actor.startSegment(segmentId);

      actor.updateCommand(segmentId, 0, { status: 'done', success: true });
      actor.updateCommand(segmentId, 1, { status: 'done', success: true });

      const segments = actor.getSegments();
      expect(segments[0].complete).toBe(true);
    });

    it('updates command output incrementally', () => {
      const segmentId = actor.createSegment(['npm install']);
      actor.startSegment(segmentId);

      actor.updateCommand(segmentId, 0, { output: 'Installing...' });

      const container = element.querySelector('[data-container-id]');
      const output = container?.shadowRoot?.querySelector('.output');
      expect(output?.textContent).toContain('Installing...');
    });
  });

  describe('Expand/collapse', () => {
    beforeEach(() => {
      actor = new ShellShadowActor(manager, element);
    });

    it('toggles expansion state', () => {
      const segmentId = actor.createSegment(['npm install']);

      actor.toggleExpanded(segmentId);
      expect(actor.getState().expandedIds).toContain(segmentId);

      actor.toggleExpanded(segmentId);
      expect(actor.getState().expandedIds).not.toContain(segmentId);
    });

    it('applies expanded class to container', () => {
      const segmentId = actor.createSegment(['npm install']);

      const container = element.querySelector('[data-container-id]');
      const content = container?.shadowRoot?.querySelector('.container');

      expect(content?.classList.contains('expanded')).toBe(false);

      actor.expand(segmentId);
      expect(content?.classList.contains('expanded')).toBe(true);

      actor.collapse(segmentId);
      expect(content?.classList.contains('expanded')).toBe(false);
    });

    it('publishes expanded state changes', async () => {
      const received: unknown[] = [];
      const subscriberEl = document.createElement('div');
      subscriberEl.id = 'subscriber';
      document.body.appendChild(subscriberEl);

      subscriberEl.addEventListener('state-changed', ((e: CustomEvent) => {
        if (e.detail.state['shell.expanded']) {
          received.push(e.detail.state['shell.expanded']);
        }
      }) as EventListener);

      manager.register({
        actorId: 'subscriber',
        element: subscriberEl,
        publicationKeys: [],
        subscriptionKeys: ['shell.*']
      }, {});

      const segmentId = actor.createSegment(['npm install']);
      actor.expand(segmentId);
      await Promise.resolve();

      expect(received.some(r => (r as string[]).includes(segmentId))).toBe(true);
    });

    it('handles click on header to toggle', () => {
      const segmentId = actor.createSegment(['npm install']);

      const container = element.querySelector('[data-container-id]');
      const header = container?.shadowRoot?.querySelector('.header') as HTMLElement;

      expect(actor.getState().expandedIds).not.toContain(segmentId);

      header?.click();
      expect(actor.getState().expandedIds).toContain(segmentId);

      header?.click();
      expect(actor.getState().expandedIds).not.toContain(segmentId);
    });
  });

  describe('Title rendering', () => {
    beforeEach(() => {
      actor = new ShellShadowActor(manager, element);
    });

    it('shows running title for pending commands', () => {
      actor.createSegment(['npm install', 'npm test']);

      const container = element.querySelector('[data-container-id]');
      const title = container?.shadowRoot?.querySelector('.title');
      expect(title?.textContent).toBe('Running 2 commands...');
    });

    it('shows progress during execution', () => {
      const segmentId = actor.createSegment(['npm install', 'npm test']);
      actor.startSegment(segmentId);
      actor.updateCommand(segmentId, 0, { status: 'done', success: true });

      const container = element.querySelector('[data-container-id]');
      const title = container?.shadowRoot?.querySelector('.title');
      expect(title?.textContent).toContain('1/2 done');
    });

    it('shows completed title', () => {
      const segmentId = actor.createSegment(['npm install']);
      actor.startSegment(segmentId);
      actor.setResults(segmentId, [{ success: true }]);

      const container = element.querySelector('[data-container-id]');
      const title = container?.shadowRoot?.querySelector('.title');
      expect(title?.textContent).toBe('Ran 1 command');
    });

    it('shows failure count in title', () => {
      const segmentId = actor.createSegment(['npm install', 'npm test']);
      actor.startSegment(segmentId);
      actor.setResults(segmentId, [
        { success: true },
        { success: false, output: 'Error' }
      ]);

      const container = element.querySelector('[data-container-id]');
      const title = container?.shadowRoot?.querySelector('.title');
      expect(title?.textContent).toContain('1 failed');
    });
  });

  describe('Error handling', () => {
    beforeEach(() => {
      actor = new ShellShadowActor(manager, element);
    });

    it('tracks if any segment has errors', () => {
      const segmentId = actor.createSegment(['npm install']);
      actor.startSegment(segmentId);

      expect(actor.hasErrors()).toBe(false);

      actor.setResults(segmentId, [{ success: false }]);
      expect(actor.hasErrors()).toBe(true);
    });

    it('applies error class to container', () => {
      const segmentId = actor.createSegment(['npm install']);
      actor.startSegment(segmentId);
      actor.setResults(segmentId, [{ success: false }]);

      const container = element.querySelector('[data-container-id]');
      const content = container?.shadowRoot?.querySelector('.container');
      expect(content?.classList.contains('has-errors')).toBe(true);
    });
  });

  describe('Streaming subscription', () => {
    beforeEach(() => {
      actor = new ShellShadowActor(manager, element);
    });

    it('marks segments complete when streaming ends', async () => {
      const segmentId = actor.createSegment(['npm install']);
      actor.startSegment(segmentId);

      // Wait for actor registration
      await Promise.resolve();
      await Promise.resolve();

      // Simulate streaming end
      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.active': false },
        changedKeys: ['streaming.active'],
        publicationChain: [],
        timestamp: Date.now()
      });

      const segments = actor.getSegments();
      expect(segments[0].complete).toBe(true);
      expect(segments[0].commands[0].status).toBe('done');
    });
  });

  describe('Clear and cleanup', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      actor = new ShellShadowActor(manager, element);
    });

    it('clears all segments', () => {
      actor.createSegment(['npm install']);
      vi.advanceTimersByTime(1);
      actor.createSegment(['npm test']);

      expect(actor.getSegments().length).toBe(2);

      actor.clear();

      expect(actor.getSegments().length).toBe(0);
      expect(element.querySelectorAll('[data-container-id]').length).toBe(0);
    });

    it('resets expanded state on clear', () => {
      const segmentId = actor.createSegment(['npm install']);
      actor.expand(segmentId);

      expect(actor.getState().expandedIds.length).toBe(1);

      actor.clear();
      expect(actor.getState().expandedIds.length).toBe(0);
    });

    it('publishes empty state on clear', async () => {
      vi.useRealTimers();

      const received: unknown[] = [];
      const subscriberEl = document.createElement('div');
      subscriberEl.id = 'subscriber';
      document.body.appendChild(subscriberEl);

      subscriberEl.addEventListener('state-changed', ((e: CustomEvent) => {
        if (e.detail.state['shell.segments'] !== undefined) {
          received.push(e.detail.state['shell.segments']);
        }
      }) as EventListener);

      manager.register({
        actorId: 'subscriber',
        element: subscriberEl,
        publicationKeys: [],
        subscriptionKeys: ['shell.*']
      }, {});

      actor.createSegment(['npm install']);
      actor.clear();
      await Promise.resolve();

      expect(received[received.length - 1]).toEqual([]);
    });
  });

  describe('State management', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      actor = new ShellShadowActor(manager, element);
    });

    it('returns full state via getState()', () => {
      const segmentId = actor.createSegment(['npm install']);
      actor.expand(segmentId);
      actor.startSegment(segmentId);

      const state = actor.getState();

      expect(state.segments.length).toBe(1);
      expect(state.segments[0].commands[0].status).toBe('running');
      expect(state.activeCount).toBe(1);
      expect(state.expandedIds).toContain(segmentId);
    });

    it('handles multiple segments independently', () => {
      const seg1 = actor.createSegment(['npm install']);
      vi.advanceTimersByTime(1);
      const seg2 = actor.createSegment(['npm test']);

      actor.startSegment(seg1);
      actor.setResults(seg1, [{ success: true }]);

      actor.startSegment(seg2);

      const state = actor.getState();
      expect(state.segments[0].complete).toBe(true);
      expect(state.segments[1].complete).toBe(false);
      expect(state.activeCount).toBe(1);
    });
  });

  describe('Lifecycle', () => {
    it('cleans up on destroy', () => {
      vi.useFakeTimers();
      actor = new ShellShadowActor(manager, element);
      actor.createSegment(['npm install']);
      vi.advanceTimersByTime(1);
      actor.createSegment(['npm test']);

      const handler = vi.fn();
      actor.onExecute(handler);

      actor.destroy();

      // Containers should be cleared
      expect(element.querySelectorAll('[data-container-id]').length).toBe(0);
    });
  });
});
