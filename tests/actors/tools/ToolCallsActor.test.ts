/**
 * Unit tests for ToolCallsActor
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushMicrotasks } from '../../setup';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { ToolCallsActor } from '../../../media/actors/tools/ToolCallsActor';

describe('ToolCallsActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: ToolCallsActor;

  beforeEach(() => {
    ToolCallsActor.resetStylesInjected();

    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'tools-container';
    document.body.appendChild(element);

    actor = new ToolCallsActor(manager, element);
  });

  afterEach(() => {
    actor.destroy();
    document.body.innerHTML = '';
  });

  describe('initialization', () => {
    it('registers with the manager', async () => {
      await flushMicrotasks();
      expect(manager.hasActor('tools-container-ToolCallsActor')).toBe(true);
    });

    it('starts with empty state', () => {
      const state = actor.getState();
      expect(state.calls).toEqual([]);
      expect(state.activeCount).toBe(0);
      expect(state.expanded).toBe(false);
    });

    it('injects styles into document head', () => {
      const styleTag = document.querySelector('style[data-actor="tools"]');
      expect(styleTag).toBeTruthy();
    });

    it('renders empty initially', () => {
      expect(element.innerHTML).toBe('');
    });
  });

  describe('startBatch', () => {
    it('creates tools with running status', () => {
      actor.startBatch([
        { name: 'readFile', detail: '/path/to/file.ts' },
        { name: 'writeFile', detail: '/path/to/output.ts' }
      ]);

      const state = actor.getState();
      expect(state.calls.length).toBe(2);
      expect(state.calls[0].status).toBe('running');
      expect(state.calls[0].name).toBe('readFile');
    });

    it('renders dropdown in DOM', () => {
      actor.startBatch([{ name: 'readFile', detail: 'file.ts' }]);

      expect(element.querySelector('.tools-container')).toBeTruthy();
      expect(element.querySelector('.tools-header')).toBeTruthy();
      expect(element.querySelector('.tools-item')).toBeTruthy();
    });

    it('displays tool info', () => {
      actor.startBatch([{ name: 'readFile', detail: 'file.ts' }]);

      const nameEl = element.querySelector('.tools-name');
      const detailEl = element.querySelector('.tools-detail');
      expect(nameEl?.textContent).toBe('readFile');
      expect(detailEl?.textContent).toBe('file.ts');
    });

    it('shows running title', () => {
      actor.startBatch([
        { name: 'readFile', detail: 'file.ts' },
        { name: 'writeFile', detail: 'out.ts' }
      ]);

      const titleEl = element.querySelector('.tools-title');
      expect(titleEl?.textContent).toBe('Using 2 tools...');
    });

    it('publishes state', () => {
      const spy = vi.spyOn(manager, 'handleStateChange');
      actor.startBatch([{ name: 'readFile', detail: 'file.ts' }]);

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            'tools.calls': expect.any(Array)
          })
        })
      );
    });
  });

  describe('updateBatch', () => {
    it('updates existing tools', () => {
      actor.startBatch([{ name: 'readFile', detail: 'file.ts' }]);
      actor.updateBatch([{ name: 'readFile', detail: 'updated.ts', status: 'done' }]);

      const state = actor.getState();
      expect(state.calls[0].detail).toBe('updated.ts');
      expect(state.calls[0].status).toBe('done');
    });

    it('adds new tools if provided', () => {
      actor.startBatch([{ name: 'readFile', detail: 'file.ts' }]);
      actor.updateBatch([
        { name: 'readFile', detail: 'file.ts', status: 'done' },
        { name: 'writeFile', detail: 'out.ts' }
      ]);

      expect(actor.getState().calls.length).toBe(2);
    });
  });

  describe('addTool', () => {
    it('adds a single tool', () => {
      const id = actor.addTool('searchFiles', '*.ts');

      expect(id).toMatch(/^tool-\d+$/);
      expect(actor.getState().calls.length).toBe(1);
      expect(actor.getState().calls[0].status).toBe('running');
    });

    it('returns unique IDs', () => {
      const id1 = actor.addTool('tool1', 'detail1');
      const id2 = actor.addTool('tool2', 'detail2');

      expect(id1).not.toBe(id2);
    });
  });

  describe('updateTool', () => {
    it('updates tool by ID', () => {
      const id = actor.addTool('readFile', 'file.ts');
      actor.updateTool(id, { detail: 'updated.ts' });

      expect(actor.getState().calls[0].detail).toBe('updated.ts');
    });

    it('ignores invalid ID', () => {
      actor.addTool('readFile', 'file.ts');
      actor.updateTool('invalid-id', { detail: 'updated.ts' });

      expect(actor.getState().calls[0].detail).toBe('file.ts');
    });
  });

  describe('completeTool', () => {
    it('marks tool as done', () => {
      const id = actor.addTool('readFile', 'file.ts');
      actor.completeTool(id, true);

      expect(actor.getState().calls[0].status).toBe('done');
    });

    it('marks tool as error on failure', () => {
      const id = actor.addTool('readFile', 'file.ts');
      actor.completeTool(id, false);

      expect(actor.getState().calls[0].status).toBe('error');
    });

    it('updates DOM status', () => {
      const id = actor.addTool('readFile', 'file.ts');
      actor.completeTool(id, true);

      const item = element.querySelector('.tools-item');
      expect(item?.getAttribute('data-status')).toBe('done');
    });
  });

  describe('complete', () => {
    it('marks all tools as complete', () => {
      actor.startBatch([
        { name: 'tool1', detail: 'd1' },
        { name: 'tool2', detail: 'd2' }
      ]);
      actor.complete();

      const state = actor.getState();
      expect(state.calls.every(t => t.status === 'done')).toBe(true);
      expect(actor.isComplete()).toBe(true);
    });

    it('updates title to past tense', () => {
      actor.startBatch([{ name: 'readFile', detail: 'file.ts' }]);
      actor.complete();

      const titleEl = element.querySelector('.tools-title');
      expect(titleEl?.textContent).toBe('Used 1 tool');
    });

    it('shows error count in title', () => {
      const id = actor.addTool('readFile', 'file.ts');
      actor.addTool('writeFile', 'out.ts');
      actor.completeTool(id, false);
      actor.complete();

      const titleEl = element.querySelector('.tools-title');
      expect(titleEl?.textContent).toContain('1 failed');
    });

    it('adds complete class', () => {
      actor.addTool('readFile', 'file.ts');
      actor.complete();

      const container = element.querySelector('.tools-container');
      expect(container?.classList.contains('complete')).toBe(true);
    });
  });

  describe('expand/collapse', () => {
    it('toggleExpanded toggles state', () => {
      actor.addTool('readFile', 'file.ts');

      expect(actor.getState().expanded).toBe(false);

      actor.toggleExpanded();
      expect(actor.getState().expanded).toBe(true);

      actor.toggleExpanded();
      expect(actor.getState().expanded).toBe(false);
    });

    it('expand sets expanded true', () => {
      actor.addTool('readFile', 'file.ts');
      actor.expand();

      expect(actor.getState().expanded).toBe(true);
    });

    it('collapse sets expanded false', () => {
      actor.addTool('readFile', 'file.ts');
      actor.expand();
      actor.collapse();

      expect(actor.getState().expanded).toBe(false);
    });

    it('updates DOM class when expanded', () => {
      actor.addTool('readFile', 'file.ts');
      actor.expand();

      const container = element.querySelector('.tools-container');
      expect(container?.classList.contains('expanded')).toBe(true);
    });

    it('clicking header toggles expansion', () => {
      actor.addTool('readFile', 'file.ts');

      const header = element.querySelector('.tools-header') as HTMLElement;
      header.click();

      expect(actor.getState().expanded).toBe(true);
    });

    it('publishes expanded state', () => {
      actor.addTool('readFile', 'file.ts');
      const spy = vi.spyOn(manager, 'handleStateChange');

      actor.expand();

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            'tools.expanded': true
          })
        })
      );
    });
  });

  describe('clear', () => {
    it('removes all tools', () => {
      actor.addTool('tool1', 'd1');
      actor.addTool('tool2', 'd2');
      actor.clear();

      expect(actor.getState().calls.length).toBe(0);
      expect(element.innerHTML).toBe('');
    });

    it('resets expanded state', () => {
      actor.addTool('tool1', 'd1');
      actor.expand();
      actor.clear();

      expect(actor.getState().expanded).toBe(false);
    });

    it('resets complete state', () => {
      actor.addTool('tool1', 'd1');
      actor.complete();
      actor.clear();

      expect(actor.isComplete()).toBe(false);
    });
  });

  describe('streaming subscription', () => {
    it('completes tools when streaming ends', async () => {
      // Wait for actor registration to complete
      await flushMicrotasks();

      actor.addTool('readFile', 'file.ts');

      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.active': false },
        changedKeys: ['streaming.active'],
        publicationChain: [],
        timestamp: Date.now()
      });

      expect(actor.isComplete()).toBe(true);
      // After complete(), current batch is cleared but batch is in getBatches()
      const batches = actor.getBatches();
      expect(batches.length).toBe(1);
      expect(batches[0].calls[0].status).toBe('done');
    });
  });

  describe('getActiveCount', () => {
    it('counts running tools', () => {
      actor.addTool('tool1', 'd1');
      actor.addTool('tool2', 'd2');

      expect(actor.getActiveCount()).toBe(2);
    });

    it('excludes completed tools', () => {
      const id1 = actor.addTool('tool1', 'd1');
      actor.addTool('tool2', 'd2');
      actor.completeTool(id1, true);

      expect(actor.getActiveCount()).toBe(1);
    });
  });

  describe('hasErrors', () => {
    it('returns false when no errors', () => {
      actor.addTool('tool1', 'd1');
      actor.complete();

      expect(actor.hasErrors()).toBe(false);
    });

    it('returns true when has errors', () => {
      const id = actor.addTool('tool1', 'd1');
      actor.completeTool(id, false);

      expect(actor.hasErrors()).toBe(true);
    });
  });

  describe('getCalls', () => {
    it('returns copy of calls', () => {
      actor.addTool('tool1', 'd1');
      const calls = actor.getCalls();
      calls.push({
        id: 'fake',
        name: 'fake',
        detail: 'fake',
        status: 'done'
      });

      expect(actor.getState().calls.length).toBe(1);
    });
  });

  describe('escaping', () => {
    it('escapes HTML in tool names', () => {
      actor.addTool('<script>alert(1)</script>', 'detail');

      const nameEl = element.querySelector('.tools-name');
      expect(nameEl?.innerHTML).not.toContain('<script>');
      expect(nameEl?.textContent).toContain('<script>');
    });

    it('escapes HTML in details', () => {
      actor.addTool('tool', '<b>bold</b>');

      const detailEl = element.querySelector('.tools-detail');
      expect(detailEl?.innerHTML).not.toContain('<b>');
      expect(detailEl?.textContent).toContain('<b>bold</b>');
    });
  });
});
