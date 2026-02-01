/**
 * Unit tests for ShellActor
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushMicrotasks } from '../../setup';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { ShellActor } from '../../../media/actors/shell/ShellActor';

describe('ShellActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: ShellActor;

  beforeEach(() => {
    ShellActor.resetStylesInjected();

    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'shell-container';
    document.body.appendChild(element);

    actor = new ShellActor(manager, element);
  });

  afterEach(() => {
    actor.destroy();
    document.body.innerHTML = '';
  });

  describe('initialization', () => {
    it('registers with the manager', async () => {
      await flushMicrotasks();
      expect(manager.hasActor('shell-container-ShellActor')).toBe(true);
    });

    it('starts with empty state', () => {
      const state = actor.getState();
      expect(state.segments).toEqual([]);
      expect(state.activeCount).toBe(0);
      expect(state.expandedIds).toEqual([]);
    });

    it('injects styles into document head', () => {
      const styleTag = document.querySelector('style[data-actor="shell"]');
      expect(styleTag).toBeTruthy();
    });

    it('renders empty initially', () => {
      expect(element.innerHTML).toBe('');
    });
  });

  describe('createSegment', () => {
    it('creates a segment with pending commands', () => {
      const segmentId = actor.createSegment(['npm install', 'npm test']);

      expect(segmentId).toMatch(/^shell-\d+-\d+$/);

      const state = actor.getState();
      expect(state.segments.length).toBe(1);
      expect(state.segments[0].commands.length).toBe(2);
      expect(state.segments[0].commands[0].status).toBe('pending');
      expect(state.segments[0].commands[0].command).toBe('npm install');
    });

    it('renders segment in DOM', () => {
      actor.createSegment(['npm install']);

      expect(element.querySelector('.shell-container')).toBeTruthy();
      expect(element.querySelector('.shell-header')).toBeTruthy();
      expect(element.querySelector('.shell-item')).toBeTruthy();
    });

    it('displays command text', () => {
      actor.createSegment(['npm install']);

      const cmdEl = element.querySelector('.shell-command');
      expect(cmdEl?.textContent).toBe('npm install');
    });

    it('publishes segment state', () => {
      const spy = vi.spyOn(manager, 'handleStateChange');
      actor.createSegment(['npm install']);

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            'shell.segments': expect.any(Array)
          })
        })
      );
    });
  });

  describe('startSegment', () => {
    it('changes command status to running', () => {
      const segmentId = actor.createSegment(['npm install']);
      actor.startSegment(segmentId);

      const state = actor.getState();
      expect(state.segments[0].commands[0].status).toBe('running');
    });

    it('updates active count', () => {
      const segmentId = actor.createSegment(['npm install', 'npm test']);
      actor.startSegment(segmentId);

      expect(actor.getActiveCount()).toBe(2);
    });

    it('shows spinning indicator', () => {
      const segmentId = actor.createSegment(['npm install']);
      actor.startSegment(segmentId);

      const statusEl = element.querySelector('.shell-status');
      expect(statusEl?.classList.contains('spinning')).toBe(true);
    });

    it('calls onExecute handler', () => {
      const handler = vi.fn();
      actor.onExecute(handler);

      const segmentId = actor.createSegment(['npm install', 'npm test']);
      actor.startSegment(segmentId);

      expect(handler).toHaveBeenCalledWith(['npm install', 'npm test']);
    });
  });

  describe('setResults', () => {
    it('updates command results', () => {
      const segmentId = actor.createSegment(['npm install']);
      actor.startSegment(segmentId);
      actor.setResults(segmentId, [{ success: true, output: 'added 100 packages' }]);

      const state = actor.getState();
      expect(state.segments[0].commands[0].status).toBe('done');
      expect(state.segments[0].commands[0].output).toBe('added 100 packages');
    });

    it('marks segment as complete', () => {
      const segmentId = actor.createSegment(['npm install']);
      actor.startSegment(segmentId);
      actor.setResults(segmentId, [{ success: true }]);

      expect(actor.getState().segments[0].complete).toBe(true);
    });

    it('handles error results', () => {
      const segmentId = actor.createSegment(['npm test']);
      actor.startSegment(segmentId);
      actor.setResults(segmentId, [{ success: false, output: 'Tests failed' }]);

      const state = actor.getState();
      expect(state.segments[0].commands[0].status).toBe('error');
      expect(actor.hasErrors()).toBe(true);
    });

    it('renders output in DOM', () => {
      const segmentId = actor.createSegment(['npm install']);
      actor.startSegment(segmentId);
      actor.setResults(segmentId, [{ success: true, output: 'Success!' }]);

      const outputEl = element.querySelector('.shell-output');
      expect(outputEl?.textContent).toBe('Success!');
    });

    it('updates title with done count', () => {
      const segmentId = actor.createSegment(['npm install', 'npm test']);
      actor.startSegment(segmentId);
      actor.setResults(segmentId, [
        { success: true },
        { success: true }
      ]);

      const titleEl = element.querySelector('.shell-title');
      expect(titleEl?.textContent).toBe('Ran 2 commands');
    });

    it('shows error count in title', () => {
      const segmentId = actor.createSegment(['npm install', 'npm test']);
      actor.startSegment(segmentId);
      actor.setResults(segmentId, [
        { success: true },
        { success: false }
      ]);

      const titleEl = element.querySelector('.shell-title');
      expect(titleEl?.textContent).toContain('1 failed');
    });
  });

  describe('updateCommand', () => {
    it('updates individual command', () => {
      const segmentId = actor.createSegment(['cmd1', 'cmd2']);
      actor.startSegment(segmentId);
      actor.updateCommand(segmentId, 0, { status: 'done', success: true });

      const state = actor.getState();
      expect(state.segments[0].commands[0].status).toBe('done');
      expect(state.segments[0].commands[1].status).toBe('running');
    });

    it('marks segment complete when all commands done', () => {
      const segmentId = actor.createSegment(['cmd1', 'cmd2']);
      actor.startSegment(segmentId);
      actor.updateCommand(segmentId, 0, { status: 'done', success: true });
      actor.updateCommand(segmentId, 1, { status: 'done', success: true });

      expect(actor.getState().segments[0].complete).toBe(true);
    });
  });

  describe('expand/collapse', () => {
    it('toggleExpanded toggles state', () => {
      const segmentId = actor.createSegment(['npm install']);

      expect(actor.getState().expandedIds).not.toContain(segmentId);

      actor.toggleExpanded(segmentId);
      expect(actor.getState().expandedIds).toContain(segmentId);

      actor.toggleExpanded(segmentId);
      expect(actor.getState().expandedIds).not.toContain(segmentId);
    });

    it('expand adds to expandedIds', () => {
      const segmentId = actor.createSegment(['npm install']);
      actor.expand(segmentId);

      expect(actor.getState().expandedIds).toContain(segmentId);
    });

    it('collapse removes from expandedIds', () => {
      const segmentId = actor.createSegment(['npm install']);
      actor.expand(segmentId);
      actor.collapse(segmentId);

      expect(actor.getState().expandedIds).not.toContain(segmentId);
    });

    it('updates DOM class when expanded', () => {
      const segmentId = actor.createSegment(['npm install']);
      actor.expand(segmentId);

      const container = element.querySelector('.shell-container');
      expect(container?.classList.contains('expanded')).toBe(true);
    });

    it('clicking header toggles expansion', () => {
      const segmentId = actor.createSegment(['npm install']);

      const header = element.querySelector('.shell-header') as HTMLElement;
      header.click();

      expect(actor.getState().expandedIds).toContain(segmentId);
    });
  });

  describe('clear', () => {
    it('removes all segments', () => {
      actor.createSegment(['cmd1']);
      actor.createSegment(['cmd2']);
      actor.clear();

      expect(actor.getState().segments.length).toBe(0);
      expect(element.innerHTML).toBe('');
    });

    it('resets expanded state', () => {
      const segmentId = actor.createSegment(['cmd1']);
      actor.expand(segmentId);
      actor.clear();

      expect(actor.getState().expandedIds.length).toBe(0);
    });

    it('publishes cleared state', () => {
      const spy = vi.spyOn(manager, 'handleStateChange');
      // Start the segment so activeCount > 0
      const segmentId = actor.createSegment(['cmd1']);
      actor.startSegment(segmentId);
      spy.mockClear();

      actor.clear();

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            'shell.segments': [],
            'shell.activeCount': 0
          })
        })
      );
    });
  });

  describe('streaming subscription', () => {
    it('marks all segments complete when streaming ends', () => {
      const segmentId = actor.createSegment(['npm install']);
      actor.startSegment(segmentId);

      // Simulate streaming ending
      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.active': false },
        changedKeys: ['streaming.active'],
        publicationChain: [],
        timestamp: Date.now()
      });

      const state = actor.getState();
      expect(state.segments[0].complete).toBe(true);
      expect(state.segments[0].commands[0].status).toBe('done');
      expect(state.activeCount).toBe(0);
    });
  });

  describe('multiple segments', () => {
    it('handles multiple segments', () => {
      const id1 = actor.createSegment(['cmd1']);
      const id2 = actor.createSegment(['cmd2', 'cmd3']);

      expect(actor.getState().segments.length).toBe(2);
      expect(element.querySelectorAll('.shell-container').length).toBe(2);
    });

    it('tracks active count across segments', () => {
      const id1 = actor.createSegment(['cmd1']);
      const id2 = actor.createSegment(['cmd2', 'cmd3']);
      actor.startSegment(id1);
      actor.startSegment(id2);

      expect(actor.getActiveCount()).toBe(3);
    });
  });

  describe('getSegments', () => {
    it('returns copy of segments', () => {
      actor.createSegment(['cmd1']);
      const segments = actor.getSegments();
      segments.push({
        id: 'fake',
        commands: [],
        complete: false
      });

      expect(actor.getState().segments.length).toBe(1);
    });
  });

  describe('escaping', () => {
    it('escapes HTML in commands', () => {
      actor.createSegment(['echo "<script>alert(1)</script>"']);

      const cmdEl = element.querySelector('.shell-command');
      expect(cmdEl?.innerHTML).not.toContain('<script>');
      expect(cmdEl?.textContent).toContain('<script>');
    });

    it('escapes HTML in output', () => {
      const segmentId = actor.createSegment(['cmd']);
      actor.startSegment(segmentId);
      actor.setResults(segmentId, [{ success: true, output: '<b>bold</b>' }]);

      const outputEl = element.querySelector('.shell-output');
      expect(outputEl?.innerHTML).not.toContain('<b>');
      expect(outputEl?.textContent).toContain('<b>bold</b>');
    });
  });
});
