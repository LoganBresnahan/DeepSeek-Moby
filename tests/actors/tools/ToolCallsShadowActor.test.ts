/**
 * Tests for ToolCallsShadowActor
 *
 * Tests Shadow DOM encapsulation, tool call state management,
 * batch lifecycle, and integration with the pub/sub system.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolCallsShadowActor, ToolCall } from '../../../media/actors/tools/ToolCallsShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { InterleavedShadowActor } from '../../../media/state/InterleavedShadowActor';

describe('ToolCallsShadowActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: ToolCallsShadowActor;

  beforeEach(() => {
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'tools-container';
    document.body.appendChild(element);
    InterleavedShadowActor.resetInstanceCount();
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  describe('Shadow DOM creation', () => {
    it('creates shadow containers for batches', () => {
      actor = new ToolCallsShadowActor(manager, element);
      actor.startBatch([{ name: 'test', detail: 'testing' }]);

      const containers = element.querySelectorAll('[data-container-id]');
      expect(containers.length).toBe(1);
    });

    it('each batch gets its own shadow root', () => {
      vi.useFakeTimers();
      actor = new ToolCallsShadowActor(manager, element);

      actor.startBatch([{ name: 'test1', detail: 'testing 1' }]);
      actor.complete();
      vi.advanceTimersByTime(1);
      actor.startBatch([{ name: 'test2', detail: 'testing 2' }]);

      const containers = element.querySelectorAll('[data-container-id]');
      expect(containers.length).toBe(2);

      containers.forEach(container => {
        expect(container.shadowRoot).toBeTruthy();
      });
    });

    it('adopts stylesheets into each shadow root', () => {
      actor = new ToolCallsShadowActor(manager, element);
      actor.startBatch([{ name: 'test', detail: 'testing' }]);

      const container = element.querySelector('[data-container-id]');
      const sheets = container?.shadowRoot?.adoptedStyleSheets;
      expect(sheets?.length).toBeGreaterThan(0);
    });
  });

  describe('Batch creation', () => {
    beforeEach(() => {
      actor = new ToolCallsShadowActor(manager, element);
    });

    it('creates a batch with running tools', () => {
      actor.startBatch([
        { name: 'search', detail: 'searching files' },
        { name: 'read', detail: 'reading config' }
      ]);

      const calls = actor.getCalls();
      expect(calls.length).toBe(2);
      expect(calls[0].status).toBe('running');
      expect(calls[1].status).toBe('running');
    });

    it('renders tools in the batch', () => {
      actor.startBatch([{ name: 'search', detail: 'searching files' }]);

      const container = element.querySelector('[data-container-id]');
      const name = container?.shadowRoot?.querySelector('.name');
      expect(name?.textContent).toContain('search');
    });

    it('publishes batch state on creation', async () => {
      const received: unknown[] = [];
      const subscriberEl = document.createElement('div');
      subscriberEl.id = 'subscriber';
      document.body.appendChild(subscriberEl);

      subscriberEl.addEventListener('state-changed', ((e: CustomEvent) => {
        if (e.detail.state['tools.calls']) {
          received.push(e.detail.state['tools.calls']);
        }
      }) as EventListener);

      manager.register({
        actorId: 'subscriber',
        element: subscriberEl,
        publicationKeys: [],
        subscriptionKeys: ['tools.*']
      }, {});

      actor.startBatch([{ name: 'test', detail: 'testing' }]);
      await Promise.resolve();

      expect(received.length).toBeGreaterThan(0);
    });
  });

  describe('Tool operations', () => {
    beforeEach(() => {
      actor = new ToolCallsShadowActor(manager, element);
    });

    it('adds a tool to current batch', () => {
      actor.startBatch([{ name: 'tool1', detail: 'detail1' }]);
      actor.addTool('tool2', 'detail2');

      expect(actor.getCalls().length).toBe(2);
    });

    it('creates new batch if adding tool with no current batch', () => {
      actor.addTool('tool1', 'detail1');

      expect(actor.getBatches().length).toBe(1);
      expect(actor.getCalls().length).toBe(1);
    });

    it('updates a specific tool', () => {
      actor.startBatch([{ name: 'tool1', detail: 'detail1' }]);
      const toolId = actor.getCalls()[0].id;

      actor.updateTool(toolId, { status: 'done', detail: 'updated' });

      const calls = actor.getCalls();
      expect(calls[0].status).toBe('done');
      expect(calls[0].detail).toBe('updated');
    });

    it('completes a tool successfully', () => {
      actor.startBatch([{ name: 'tool1', detail: 'detail1' }]);
      const toolId = actor.getCalls()[0].id;

      actor.completeTool(toolId, true);

      expect(actor.getCalls()[0].status).toBe('done');
    });

    it('completes a tool with error', () => {
      actor.startBatch([{ name: 'tool1', detail: 'detail1' }]);
      const toolId = actor.getCalls()[0].id;

      actor.completeTool(toolId, false);

      expect(actor.getCalls()[0].status).toBe('error');
    });
  });

  describe('Batch completion', () => {
    beforeEach(() => {
      actor = new ToolCallsShadowActor(manager, element);
    });

    it('marks batch as complete', () => {
      actor.startBatch([{ name: 'tool1', detail: 'detail1' }]);
      actor.complete();

      expect(actor.isComplete()).toBe(true);
    });

    it('marks all running tools as done on complete', () => {
      actor.startBatch([
        { name: 'tool1', detail: 'detail1' },
        { name: 'tool2', detail: 'detail2' }
      ]);
      actor.complete();

      const batch = actor.getBatches()[0];
      expect(batch.calls.every(t => t.status === 'done')).toBe(true);
    });

    it('resets active count after complete', () => {
      actor.startBatch([{ name: 'tool1', detail: 'detail1' }]);
      expect(actor.getActiveCount()).toBe(1);

      actor.complete();
      expect(actor.getActiveCount()).toBe(0);
    });

    it('allows starting new batch after complete', () => {
      vi.useFakeTimers();
      actor.startBatch([{ name: 'tool1', detail: 'detail1' }]);
      actor.complete();
      vi.advanceTimersByTime(1);

      actor.startBatch([{ name: 'tool2', detail: 'detail2' }]);

      expect(actor.getBatches().length).toBe(2);
    });
  });

  describe('Expand/collapse', () => {
    beforeEach(() => {
      actor = new ToolCallsShadowActor(manager, element);
    });

    it('toggles expansion state', () => {
      actor.startBatch([{ name: 'tool1', detail: 'detail1' }]);

      actor.toggleExpanded();
      expect(actor.getState().expanded).toBe(true);

      actor.toggleExpanded();
      expect(actor.getState().expanded).toBe(false);
    });

    it('applies expanded class to container', () => {
      actor.startBatch([{ name: 'tool1', detail: 'detail1' }]);

      const container = element.querySelector('[data-container-id]');
      const content = container?.shadowRoot?.querySelector('.container');

      expect(content?.classList.contains('expanded')).toBe(false);

      actor.expand();
      expect(content?.classList.contains('expanded')).toBe(true);

      actor.collapse();
      expect(content?.classList.contains('expanded')).toBe(false);
    });

    it('toggles specific batch by ID', () => {
      vi.useFakeTimers();
      actor.startBatch([{ name: 'tool1', detail: 'detail1' }]);
      const batch1Id = actor.getBatches()[0].id;
      actor.complete();
      vi.advanceTimersByTime(1);

      actor.startBatch([{ name: 'tool2', detail: 'detail2' }]);

      actor.toggleBatchExpanded(batch1Id);

      const batch1 = actor.getBatches()[0];
      expect(batch1.expanded).toBe(true);
    });

    it('handles click on header to toggle', () => {
      actor.startBatch([{ name: 'tool1', detail: 'detail1' }]);

      const container = element.querySelector('[data-container-id]');
      const header = container?.shadowRoot?.querySelector('.header') as HTMLElement;

      expect(actor.getState().expanded).toBe(false);

      header?.click();
      expect(actor.getState().expanded).toBe(true);

      header?.click();
      expect(actor.getState().expanded).toBe(false);
    });
  });

  describe('Title rendering', () => {
    beforeEach(() => {
      actor = new ToolCallsShadowActor(manager, element);
    });

    it('shows using title for running tools', () => {
      actor.startBatch([{ name: 'tool1', detail: 'detail1' }, { name: 'tool2', detail: 'detail2' }]);

      const container = element.querySelector('[data-container-id]');
      const title = container?.shadowRoot?.querySelector('.title');
      expect(title?.textContent).toBe('Using 2 tools...');
    });

    it('shows progress during execution', () => {
      actor.startBatch([{ name: 'tool1', detail: 'detail1' }, { name: 'tool2', detail: 'detail2' }]);
      actor.completeTool(actor.getCalls()[0].id, true);

      const container = element.querySelector('[data-container-id]');
      const title = container?.shadowRoot?.querySelector('.title');
      expect(title?.textContent).toContain('1/2 done');
    });

    it('shows completed title', () => {
      actor.startBatch([{ name: 'tool1', detail: 'detail1' }]);
      actor.complete();

      const container = element.querySelector('[data-container-id]');
      const title = container?.shadowRoot?.querySelector('.title');
      expect(title?.textContent).toBe('Used 1 tool');
    });

    it('shows failure count in title', () => {
      actor.startBatch([{ name: 'tool1', detail: 'detail1' }, { name: 'tool2', detail: 'detail2' }]);
      actor.completeTool(actor.getCalls()[0].id, true);
      actor.completeTool(actor.getCalls()[1].id, false);
      actor.complete();

      const container = element.querySelector('[data-container-id]');
      const title = container?.shadowRoot?.querySelector('.title');
      expect(title?.textContent).toContain('1 failed');
    });
  });

  describe('Error handling', () => {
    beforeEach(() => {
      actor = new ToolCallsShadowActor(manager, element);
    });

    it('tracks if batch has errors', () => {
      actor.startBatch([{ name: 'tool1', detail: 'detail1' }]);
      expect(actor.hasErrors()).toBe(false);

      actor.completeTool(actor.getCalls()[0].id, false);
      expect(actor.hasErrors()).toBe(true);
    });

    it('applies error class to container', () => {
      actor.startBatch([{ name: 'tool1', detail: 'detail1' }]);
      actor.completeTool(actor.getCalls()[0].id, false);

      const container = element.querySelector('[data-container-id]');
      const content = container?.shadowRoot?.querySelector('.container');
      expect(content?.classList.contains('has-errors')).toBe(true);
    });
  });

  describe('Streaming subscription', () => {
    beforeEach(() => {
      actor = new ToolCallsShadowActor(manager, element);
    });

    it('marks batch complete when streaming ends', async () => {
      actor.startBatch([{ name: 'tool1', detail: 'detail1' }]);

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

      expect(actor.isComplete()).toBe(true);
    });
  });

  describe('Clear and cleanup', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      actor = new ToolCallsShadowActor(manager, element);
    });

    it('clears all batches', () => {
      actor.startBatch([{ name: 'tool1', detail: 'detail1' }]);
      actor.complete();
      vi.advanceTimersByTime(1);
      actor.startBatch([{ name: 'tool2', detail: 'detail2' }]);

      expect(actor.getBatches().length).toBe(2);

      actor.clear();

      expect(actor.getBatches().length).toBe(0);
      expect(element.querySelectorAll('[data-container-id]').length).toBe(0);
    });

    it('publishes empty state on clear', async () => {
      vi.useRealTimers();

      const received: unknown[] = [];
      const subscriberEl = document.createElement('div');
      subscriberEl.id = 'subscriber';
      document.body.appendChild(subscriberEl);

      subscriberEl.addEventListener('state-changed', ((e: CustomEvent) => {
        if (e.detail.state['tools.calls'] !== undefined) {
          received.push(e.detail.state['tools.calls']);
        }
      }) as EventListener);

      manager.register({
        actorId: 'subscriber',
        element: subscriberEl,
        publicationKeys: [],
        subscriptionKeys: ['tools.*']
      }, {});

      actor.startBatch([{ name: 'tool1', detail: 'detail1' }]);
      actor.clear();
      await Promise.resolve();

      expect(received[received.length - 1]).toEqual([]);
    });
  });

  describe('State management', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      actor = new ToolCallsShadowActor(manager, element);
    });

    it('returns full state via getState()', () => {
      actor.startBatch([{ name: 'tool1', detail: 'detail1' }]);
      actor.expand();

      const state = actor.getState();

      expect(state.calls.length).toBe(1);
      expect(state.calls[0].status).toBe('running');
      expect(state.activeCount).toBe(1);
      expect(state.expanded).toBe(true);
    });

    it('handles multiple batches independently', () => {
      actor.startBatch([{ name: 'tool1', detail: 'detail1' }]);
      actor.complete();
      vi.advanceTimersByTime(1);

      actor.startBatch([{ name: 'tool2', detail: 'detail2' }]);

      const batches = actor.getBatches();
      expect(batches[0].complete).toBe(true);
      expect(batches[1].complete).toBe(false);
    });
  });

  describe('Lifecycle', () => {
    it('cleans up on destroy', () => {
      vi.useFakeTimers();
      actor = new ToolCallsShadowActor(manager, element);
      actor.startBatch([{ name: 'tool1', detail: 'detail1' }]);
      actor.complete();
      vi.advanceTimersByTime(1);
      actor.startBatch([{ name: 'tool2', detail: 'detail2' }]);

      actor.destroy();

      expect(element.querySelectorAll('[data-container-id]').length).toBe(0);
    });
  });
});
