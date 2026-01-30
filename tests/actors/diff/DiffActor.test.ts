/**
 * Unit tests for DiffActor
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushMicrotasks } from '../../setup';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { DiffActor } from '../../../media/actors/diff/DiffActor';

describe('DiffActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: DiffActor;

  beforeEach(() => {
    DiffActor.resetStylesInjected();

    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'diff-container';
    document.body.appendChild(element);

    actor = new DiffActor(manager, element);
  });

  afterEach(() => {
    actor.destroy();
    document.body.innerHTML = '';
  });

  describe('initialization', () => {
    it('registers with the manager', async () => {
      await flushMicrotasks();
      // DiffActor doesn't extend EventStateActor, it uses element.id directly as actorId
      expect(manager.hasActor('diff-container')).toBe(true);
    });

    it('starts with inactive state', () => {
      const state = actor.getState();
      expect(state.active).toBe(false);
      expect(state.file).toBe(null);
      expect(state.stats).toEqual({ added: 0, removed: 0 });
      expect(state.codeBlockId).toBe(null);
    });

    it('injects styles into document head', () => {
      const styleTag = document.querySelector('style[data-actor="diff"]');
      expect(styleTag).toBeTruthy();
    });

    it('renders empty initially', () => {
      expect(element.innerHTML).toBe('');
    });
  });

  describe('showDiff', () => {
    it('activates diff view', () => {
      actor.showDiff('block-1', 'test.ts', 'old content', 'new content');

      expect(actor.isActive()).toBe(true);
      expect(actor.getCurrentFile()).toBe('test.ts');
    });

    it('computes diff stats', () => {
      actor.showDiff(
        'block-1',
        'test.ts',
        'line1\nline2\nline3',
        'line1\nmodified\nline3\nnew line'
      );

      const state = actor.getState();
      expect(state.stats.added).toBeGreaterThan(0);
    });

    it('renders diff container', () => {
      actor.showDiff('block-1', 'test.ts', 'old', 'new');

      expect(element.querySelector('.diff-container')).toBeTruthy();
      expect(element.querySelector('.diff-header')).toBeTruthy();
      expect(element.querySelector('.diff-content')).toBeTruthy();
    });

    it('shows filename in header', () => {
      actor.showDiff('block-1', 'src/utils/helper.ts', 'old', 'new');

      const filename = element.querySelector('.diff-header-filename');
      expect(filename?.textContent).toBe('helper.ts');
    });

    it('publishes state', () => {
      const spy = vi.spyOn(manager, 'handleStateChange');
      actor.showDiff('block-1', 'test.ts', 'old', 'new');

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            'diff.active': true,
            'diff.file': 'test.ts'
          })
        })
      );
    });

    it('stores code block ID', () => {
      actor.showDiff('block-123', 'test.ts', 'old', 'new');

      expect(actor.getCodeBlockId()).toBe('block-123');
    });
  });

  describe('close', () => {
    it('deactivates diff view', () => {
      actor.showDiff('block-1', 'test.ts', 'old', 'new');
      actor.close();

      expect(actor.isActive()).toBe(false);
      expect(actor.getCurrentFile()).toBe(null);
    });

    it('clears DOM content', () => {
      actor.showDiff('block-1', 'test.ts', 'old', 'new');
      actor.close();

      expect(element.innerHTML).toBe('');
    });

    it('publishes inactive state', () => {
      actor.showDiff('block-1', 'test.ts', 'old', 'new');
      const spy = vi.spyOn(manager, 'handleStateChange');
      spy.mockClear();

      actor.close();

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            'diff.active': false,
            'diff.file': null
          })
        })
      );
    });

    it('resets stats', () => {
      actor.showDiff('block-1', 'test.ts', 'old\nold2', 'new\nnew2');
      actor.close();

      expect(actor.getState().stats).toEqual({ added: 0, removed: 0 });
    });
  });

  describe('diff computation', () => {
    it('detects added lines', () => {
      actor.showDiff(
        'block-1',
        'test.ts',
        'line1\nline2',
        'line1\nline2\nline3'
      );

      const diff = actor.getDiffData();
      expect(diff?.stats.added).toBe(1);
      expect(diff?.stats.removed).toBe(0);
    });

    it('detects removed lines', () => {
      actor.showDiff(
        'block-1',
        'test.ts',
        'line1\nline2\nline3',
        'line1\nline3'
      );

      const diff = actor.getDiffData();
      expect(diff?.stats.removed).toBe(1);
    });

    it('detects unchanged lines', () => {
      actor.showDiff(
        'block-1',
        'test.ts',
        'line1\nline2\nline3',
        'line1\nmodified\nline3'
      );

      const diff = actor.getDiffData();
      const unchangedCount = diff?.lines.filter(l => l.type === 'unchanged').length;
      expect(unchangedCount).toBeGreaterThan(0);
    });

    it('handles empty old content', () => {
      actor.showDiff(
        'block-1',
        'test.ts',
        '',
        'new line 1\nnew line 2'
      );

      const diff = actor.getDiffData();
      // New lines are added
      expect(diff?.stats.added).toBe(2);
      // Empty string split produces [''], counts as 1 removed
      expect(diff?.stats.removed).toBe(1);
    });

    it('handles empty new content', () => {
      actor.showDiff(
        'block-1',
        'test.ts',
        'old line 1\nold line 2',
        ''
      );

      const diff = actor.getDiffData();
      // Old lines are removed
      expect(diff?.stats.removed).toBe(2);
      // Empty string split produces [''], counts as 1 added
      expect(diff?.stats.added).toBe(1);
    });
  });

  describe('action handling', () => {
    it('calls action handler on apply', () => {
      const handler = vi.fn();
      actor.onAction(handler);
      actor.showDiff('block-1', 'test.ts', 'old', 'new');

      const applyBtn = element.querySelector('[data-action="apply"]') as HTMLElement;
      applyBtn.click();

      expect(handler).toHaveBeenCalledWith('apply', 'test.ts', 'block-1');
    });

    it('calls action handler on reject', () => {
      const handler = vi.fn();
      actor.onAction(handler);
      actor.showDiff('block-1', 'test.ts', 'old', 'new');

      const rejectBtn = element.querySelector('[data-action="reject"]') as HTMLElement;
      rejectBtn.click();

      expect(handler).toHaveBeenCalledWith('reject', 'test.ts', 'block-1');
    });

    it('closes diff on reject', () => {
      actor.showDiff('block-1', 'test.ts', 'old', 'new');

      const rejectBtn = element.querySelector('[data-action="reject"]') as HTMLElement;
      rejectBtn.click();

      expect(actor.isActive()).toBe(false);
    });

    it('calls action handler on close', () => {
      const handler = vi.fn();
      actor.onAction(handler);
      actor.showDiff('block-1', 'test.ts', 'old', 'new');

      const closeBtn = element.querySelector('[data-action="close"]') as HTMLElement;
      closeBtn.click();

      expect(handler).toHaveBeenCalledWith('close', 'test.ts', 'block-1');
    });

    it('keeps diff open after apply (for external confirmation)', () => {
      actor.showDiff('block-1', 'test.ts', 'old', 'new');

      const applyBtn = element.querySelector('[data-action="apply"]') as HTMLElement;
      applyBtn.click();

      // Diff should remain open until externally closed
      expect(actor.isActive()).toBe(true);
    });
  });

  describe('rendering', () => {
    it('renders line numbers', () => {
      actor.showDiff(
        'block-1',
        'test.ts',
        'line1\nline2',
        'line1\nline2\nline3'
      );

      const lineNums = element.querySelectorAll('.diff-line-num');
      expect(lineNums.length).toBeGreaterThan(0);
    });

    it('renders stats summary', () => {
      actor.showDiff(
        'block-1',
        'test.ts',
        'old line',
        'new line'
      );

      const stats = element.querySelector('.diff-stats');
      expect(stats).toBeTruthy();
      expect(stats?.textContent).toContain('added');
      expect(stats?.textContent).toContain('removed');
    });

    it('applies correct class for added lines', () => {
      actor.showDiff(
        'block-1',
        'test.ts',
        'line1',
        'line1\nline2'
      );

      const addedLines = element.querySelectorAll('.diff-line-added');
      expect(addedLines.length).toBeGreaterThan(0);
    });

    it('applies correct class for removed lines', () => {
      actor.showDiff(
        'block-1',
        'test.ts',
        'line1\nline2',
        'line1'
      );

      const removedLines = element.querySelectorAll('.diff-line-removed');
      expect(removedLines.length).toBeGreaterThan(0);
    });

    it('escapes HTML in content', () => {
      actor.showDiff(
        'block-1',
        'test.ts',
        'const x = "<script>"',
        'const x = "<script>"'
      );

      expect(element.innerHTML).not.toContain('<script>');
      expect(element.textContent).toContain('<script>');
    });

    it('shows action buttons', () => {
      actor.showDiff('block-1', 'test.ts', 'old', 'new');

      expect(element.querySelector('.diff-apply-btn')).toBeTruthy();
      expect(element.querySelector('.diff-reject-btn')).toBeTruthy();
      expect(element.querySelector('.diff-close-btn')).toBeTruthy();
    });
  });

  describe('state getters', () => {
    it('getState returns current state', () => {
      actor.showDiff('block-1', 'test.ts', 'old', 'new');

      const state = actor.getState();
      expect(state).toHaveProperty('active');
      expect(state).toHaveProperty('file');
      expect(state).toHaveProperty('stats');
      expect(state).toHaveProperty('codeBlockId');
    });

    it('isActive returns active state', () => {
      expect(actor.isActive()).toBe(false);

      actor.showDiff('block-1', 'test.ts', 'old', 'new');
      expect(actor.isActive()).toBe(true);

      actor.close();
      expect(actor.isActive()).toBe(false);
    });

    it('getCurrentFile returns file path', () => {
      expect(actor.getCurrentFile()).toBe(null);

      actor.showDiff('block-1', 'src/test.ts', 'old', 'new');
      expect(actor.getCurrentFile()).toBe('src/test.ts');
    });

    it('getDiffData returns computed diff', () => {
      expect(actor.getDiffData()).toBe(null);

      actor.showDiff('block-1', 'test.ts', 'old', 'new');
      const diff = actor.getDiffData();
      expect(diff).toBeTruthy();
      expect(diff?.filePath).toBe('test.ts');
      expect(diff?.lines).toBeDefined();
    });

    it('getCodeBlockId returns code block ID', () => {
      expect(actor.getCodeBlockId()).toBe(null);

      actor.showDiff('block-xyz', 'test.ts', 'old', 'new');
      expect(actor.getCodeBlockId()).toBe('block-xyz');
    });
  });

  describe('codeblock.diffedId subscription', () => {
    it('closes when diffedId becomes null externally', () => {
      actor.showDiff('block-1', 'test.ts', 'old', 'new');

      // Simulate external event saying diff was closed
      manager.handleStateChange({
        source: 'codeblock-actor',
        state: { 'codeblock.diffedId': null },
        changedKeys: ['codeblock.diffedId'],
        publicationChain: [],
        timestamp: Date.now()
      });

      expect(actor.isActive()).toBe(false);
    });
  });

  describe('destroy', () => {
    it('unregisters from manager', () => {
      actor.destroy();

      expect(manager.hasActor('diff-container-DiffActor')).toBe(false);
    });

    it('clears DOM content', () => {
      actor.showDiff('block-1', 'test.ts', 'old', 'new');
      actor.destroy();

      expect(element.innerHTML).toBe('');
    });
  });
});
