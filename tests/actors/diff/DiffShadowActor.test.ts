/**
 * Tests for DiffShadowActor
 *
 * Tests Shadow DOM encapsulation, diff rendering,
 * action handling, and state management.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DiffShadowActor } from '../../../media/actors/diff/DiffShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { ShadowActor } from '../../../media/state/ShadowActor';

describe('DiffShadowActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: DiffShadowActor;

  beforeEach(() => {
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'diff-container';
    document.body.appendChild(element);
    ShadowActor.resetInstanceCount();
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
  });

  describe('Shadow DOM creation', () => {
    it('creates shadow root on element', () => {
      actor = new DiffShadowActor(manager, element);
      expect(element.shadowRoot).toBeTruthy();
    });

    it('does not render content initially', () => {
      actor = new DiffShadowActor(manager, element);
      const container = element.shadowRoot?.querySelector('.container');
      expect(container).toBeNull();
    });
  });

  describe('Show diff', () => {
    beforeEach(() => {
      actor = new DiffShadowActor(manager, element);
    });

    it('renders diff view', () => {
      actor.showDiff('block-1', 'test.ts', 'line1\nline2', 'line1\nline2\nline3');

      const container = element.shadowRoot?.querySelector('.container');
      expect(container).toBeTruthy();
    });

    it('shows file name', () => {
      actor.showDiff('block-1', '/path/to/test.ts', 'old', 'new');

      const filename = element.shadowRoot?.querySelector('.filename');
      expect(filename?.textContent).toBe('test.ts');
    });

    it('renders diff lines', () => {
      actor.showDiff('block-1', 'test.ts', 'line1', 'line1\nline2');

      const lines = element.shadowRoot?.querySelectorAll('.line');
      expect(lines?.length).toBeGreaterThan(0);
    });

    it('marks added lines', () => {
      actor.showDiff('block-1', 'test.ts', 'line1', 'line1\nline2');

      const addedLines = element.shadowRoot?.querySelectorAll('.line-added');
      expect(addedLines?.length).toBe(1);
    });

    it('marks removed lines', () => {
      actor.showDiff('block-1', 'test.ts', 'line1\nline2', 'line1');

      const removedLines = element.shadowRoot?.querySelectorAll('.line-removed');
      expect(removedLines?.length).toBe(1);
    });

    it('shows stats', () => {
      actor.showDiff('block-1', 'test.ts', 'line1', 'line1\nline2\nline3');

      const stats = element.shadowRoot?.querySelector('.stats');
      expect(stats?.textContent).toContain('+2 added');
    });

    it('includes action buttons', () => {
      actor.showDiff('block-1', 'test.ts', 'old', 'new');

      expect(element.shadowRoot?.querySelector('.apply-btn')).toBeTruthy();
      expect(element.shadowRoot?.querySelector('.reject-btn')).toBeTruthy();
      expect(element.shadowRoot?.querySelector('.close-btn')).toBeTruthy();
    });

    it('sets active state', () => {
      actor.showDiff('block-1', 'test.ts', 'old', 'new');

      expect(actor.isActive()).toBe(true);
    });

    it('publishes state', async () => {
      const received: unknown[] = [];
      const subscriberEl = document.createElement('div');
      subscriberEl.id = 'subscriber';
      document.body.appendChild(subscriberEl);

      subscriberEl.addEventListener('state-changed', ((e: CustomEvent) => {
        if (e.detail.state['diff.active'] !== undefined) {
          received.push(e.detail.state['diff.active']);
        }
      }) as EventListener);

      manager.register({
        actorId: 'subscriber',
        element: subscriberEl,
        publicationKeys: [],
        subscriptionKeys: ['diff.*']
      }, {});

      actor.showDiff('block-1', 'test.ts', 'old', 'new');
      await Promise.resolve();

      expect(received).toContain(true);
    });
  });

  describe('Close diff', () => {
    beforeEach(() => {
      actor = new DiffShadowActor(manager, element);
    });

    it('clears diff view', () => {
      actor.showDiff('block-1', 'test.ts', 'old', 'new');
      actor.close();

      const container = element.shadowRoot?.querySelector('.container');
      expect(container).toBeNull();
    });

    it('resets state', () => {
      actor.showDiff('block-1', 'test.ts', 'old', 'new');
      actor.close();

      expect(actor.isActive()).toBe(false);
      expect(actor.getCurrentFile()).toBeNull();
    });

    it('calls action handler', () => {
      const handler = vi.fn();
      actor.onAction(handler);

      actor.showDiff('block-1', 'test.ts', 'old', 'new');
      actor.close();

      expect(handler).toHaveBeenCalledWith('close', 'test.ts', 'block-1');
    });
  });

  describe('Action buttons', () => {
    beforeEach(() => {
      actor = new DiffShadowActor(manager, element);
    });

    it('apply button calls handler', () => {
      const handler = vi.fn();
      actor.onAction(handler);

      actor.showDiff('block-1', 'test.ts', 'old', 'new');

      const applyBtn = element.shadowRoot?.querySelector('.apply-btn') as HTMLButtonElement;
      applyBtn.click();

      expect(handler).toHaveBeenCalledWith('apply', 'test.ts', 'block-1');
    });

    it('reject button calls handler and closes', () => {
      const handler = vi.fn();
      actor.onAction(handler);

      actor.showDiff('block-1', 'test.ts', 'old', 'new');

      const rejectBtn = element.shadowRoot?.querySelector('.reject-btn') as HTMLButtonElement;
      rejectBtn.click();

      expect(handler).toHaveBeenCalledWith('reject', 'test.ts', 'block-1');
      expect(actor.isActive()).toBe(false);
    });

    it('close button closes diff', () => {
      const handler = vi.fn();
      actor.onAction(handler);

      actor.showDiff('block-1', 'test.ts', 'old', 'new');

      const closeBtn = element.shadowRoot?.querySelector('.close-btn') as HTMLButtonElement;
      closeBtn.click();

      expect(actor.isActive()).toBe(false);
      expect(handler).toHaveBeenCalledWith('close', 'test.ts', 'block-1');
    });
  });

  describe('Subscription', () => {
    beforeEach(async () => {
      actor = new DiffShadowActor(manager, element);
      await Promise.resolve();
      await Promise.resolve();
    });

    it('closes when codeblock.diffedId becomes null', () => {
      actor.showDiff('block-1', 'test.ts', 'old', 'new');
      expect(actor.isActive()).toBe(true);

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

  describe('State', () => {
    beforeEach(() => {
      actor = new DiffShadowActor(manager, element);
    });

    it('returns state when inactive', () => {
      const state = actor.getState();

      expect(state.active).toBe(false);
      expect(state.file).toBeNull();
      expect(state.stats).toEqual({ added: 0, removed: 0 });
      expect(state.codeBlockId).toBeNull();
    });

    it('returns state when active', () => {
      actor.showDiff('block-1', 'test.ts', 'line1', 'line1\nline2');

      const state = actor.getState();

      expect(state.active).toBe(true);
      expect(state.file).toBe('test.ts');
      expect(state.stats.added).toBe(1);
      expect(state.codeBlockId).toBe('block-1');
    });

    it('getCurrentFile returns file path', () => {
      actor.showDiff('block-1', 'test.ts', 'old', 'new');
      expect(actor.getCurrentFile()).toBe('test.ts');
    });

    it('getDiffData returns diff data', () => {
      actor.showDiff('block-1', 'test.ts', 'old', 'new');

      const data = actor.getDiffData();
      expect(data).toBeTruthy();
      expect(data?.filePath).toBe('test.ts');
      expect(data?.lines.length).toBeGreaterThan(0);
    });

    it('getCodeBlockId returns code block ID', () => {
      actor.showDiff('block-1', 'test.ts', 'old', 'new');
      expect(actor.getCodeBlockId()).toBe('block-1');
    });
  });

  describe('Diff computation', () => {
    beforeEach(() => {
      actor = new DiffShadowActor(manager, element);
    });

    it('computes unchanged lines', () => {
      actor.showDiff('block-1', 'test.ts', 'same\nsame', 'same\nsame');

      const data = actor.getDiffData();
      const unchangedCount = data?.lines.filter(l => l.type === 'unchanged').length;
      expect(unchangedCount).toBe(2);
    });

    it('computes mixed changes', () => {
      actor.showDiff('block-1', 'test.ts', 'line1\nline2\nline3', 'line1\nmodified\nline3');

      const data = actor.getDiffData();
      expect(data?.stats.added).toBeGreaterThan(0);
      expect(data?.stats.removed).toBeGreaterThan(0);
    });

    it('handles empty old content', () => {
      // Note: ''.split('\n') returns [''] (1 empty line), not []
      // So diff sees: old has 1 empty line removed, new has 1 line added
      actor.showDiff('block-1', 'test.ts', '', 'new content');

      const data = actor.getDiffData();
      expect(data?.stats.added).toBe(1);
      expect(data?.stats.removed).toBe(1); // The empty string counts as 1 empty line
    });

    it('handles empty new content', () => {
      // Note: ''.split('\n') returns [''] (1 empty line), not []
      // So diff sees: old has 1 line removed, new has 1 empty line added
      actor.showDiff('block-1', 'test.ts', 'old content', '');

      const data = actor.getDiffData();
      expect(data?.stats.added).toBe(1); // The empty string counts as 1 empty line
      expect(data?.stats.removed).toBe(1);
    });
  });

  describe('Lifecycle', () => {
    it('cleans up on destroy', () => {
      actor = new DiffShadowActor(manager, element);
      actor.showDiff('block-1', 'test.ts', 'old', 'new');

      actor.destroy();

      expect(element.shadowRoot?.innerHTML).toBe('');
    });
  });
});
