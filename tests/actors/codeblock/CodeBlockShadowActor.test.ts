/**
 * Tests for CodeBlockShadowActor
 *
 * Tests Shadow DOM encapsulation, code block rendering,
 * collapse/expand, diff, and apply actions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CodeBlockShadowActor } from '../../../media/actors/codeblock/CodeBlockShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { InterleavedShadowActor } from '../../../media/state/InterleavedShadowActor';

describe('CodeBlockShadowActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: CodeBlockShadowActor;

  beforeEach(() => {
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'codeblock-container';
    document.body.appendChild(element);
    InterleavedShadowActor.resetInstanceCount();
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
  });

  describe('Shadow DOM creation', () => {
    it('creates shadow containers for each block', () => {
      actor = new CodeBlockShadowActor(manager, element);
      actor.addBlock('typescript', 'const x = 1;');

      const containers = element.querySelectorAll('[data-container-id]');
      expect(containers.length).toBe(1);
    });

    it('each block has its own shadow root', () => {
      actor = new CodeBlockShadowActor(manager, element);
      actor.addBlock('typescript', 'const x = 1;');
      actor.addBlock('python', 'x = 1');

      const containers = element.querySelectorAll('[data-container-id]');
      expect(containers.length).toBe(2);
      containers.forEach(container => {
        expect(container.shadowRoot).toBeTruthy();
      });
    });
  });

  describe('Block rendering', () => {
    beforeEach(() => {
      actor = new CodeBlockShadowActor(manager, element);
    });

    it('renders code block with language', () => {
      actor.addBlock('typescript', 'const x = 1;');

      const container = element.querySelector('[data-container-id]');
      const lang = container?.shadowRoot?.querySelector('.lang');
      expect(lang?.textContent).toContain('typescript');
    });

    it('renders code content', () => {
      actor.addBlock('javascript', 'console.log("hello");');

      const container = element.querySelector('[data-container-id]');
      const code = container?.shadowRoot?.querySelector('code');
      expect(code?.textContent).toContain('console.log');
    });

    it('returns block ID', () => {
      const id = actor.addBlock('python', 'print("hello")');
      expect(id).toMatch(/^codeblock-/);
    });

    it('includes action buttons', () => {
      actor.addBlock('typescript', 'const x = 1;');

      const container = element.querySelector('[data-container-id]');
      expect(container?.shadowRoot?.querySelector('.copy-btn')).toBeTruthy();
      expect(container?.shadowRoot?.querySelector('.diff-btn')).toBeTruthy();
      expect(container?.shadowRoot?.querySelector('.apply-btn')).toBeTruthy();
      expect(container?.shadowRoot?.querySelector('.collapse-btn')).toBeTruthy();
    });
  });

  describe('Collapse/Expand', () => {
    beforeEach(() => {
      actor = new CodeBlockShadowActor(manager, element);
    });

    it('toggles collapse state', () => {
      const id = actor.addBlock('typescript', 'const x = 1;');

      expect(actor.isCollapsed(id)).toBe(false);

      actor.toggleCollapse(id);
      expect(actor.isCollapsed(id)).toBe(true);

      actor.toggleCollapse(id);
      expect(actor.isCollapsed(id)).toBe(false);
    });

    it('collapse() collapses block', () => {
      const id = actor.addBlock('typescript', 'const x = 1;');

      actor.collapse(id);
      expect(actor.isCollapsed(id)).toBe(true);
    });

    it('expand() expands block', () => {
      const id = actor.addBlock('typescript', 'const x = 1;', { collapsed: true });

      actor.expand(id);
      expect(actor.isCollapsed(id)).toBe(false);
    });

    it('updates button icon on toggle', () => {
      const id = actor.addBlock('typescript', 'const x = 1;');

      const container = element.querySelector('[data-container-id]');
      const collapseBtn = container?.shadowRoot?.querySelector('.collapse-btn');

      expect(collapseBtn?.textContent).toBe('▼');

      actor.collapse(id);
      expect(collapseBtn?.textContent).toBe('▶');
    });

    it('tracks collapsed state in getCollapsedIds', () => {
      const id = actor.addBlock('typescript', 'const x = 1;');

      expect(actor.getCollapsedIds()).not.toContain(id);

      actor.collapse(id);
      expect(actor.getCollapsedIds()).toContain(id);
    });

    it('handles click on collapse button', () => {
      const id = actor.addBlock('typescript', 'const x = 1;');

      const container = element.querySelector('[data-container-id]');
      const collapseBtn = container?.shadowRoot?.querySelector('.collapse-btn') as HTMLButtonElement;
      collapseBtn.click();

      expect(actor.isCollapsed(id)).toBe(true);
    });
  });

  describe('Diff functionality', () => {
    beforeEach(() => {
      actor = new CodeBlockShadowActor(manager, element);
    });

    it('toggles diff mode', () => {
      const id = actor.addBlock('typescript', 'const x = 1;');

      expect(actor.isDiffed(id)).toBe(false);

      actor.toggleDiff(id);
      expect(actor.isDiffed(id)).toBe(true);

      actor.toggleDiff(id);
      expect(actor.isDiffed(id)).toBe(false);
    });

    it('only one block can be diffed at a time', () => {
      const id1 = actor.addBlock('typescript', 'const x = 1;');
      const id2 = actor.addBlock('typescript', 'const y = 2;');

      actor.toggleDiff(id1);
      expect(actor.isDiffed(id1)).toBe(true);

      actor.toggleDiff(id2);
      expect(actor.isDiffed(id1)).toBe(false);
      expect(actor.isDiffed(id2)).toBe(true);
    });

    it('closes diff', () => {
      const id = actor.addBlock('typescript', 'const x = 1;');

      actor.toggleDiff(id);
      expect(actor.isDiffed(id)).toBe(true);

      actor.closeDiff();
      expect(actor.isDiffed(id)).toBe(false);
    });

    it('calls action handler on diff', () => {
      const handler = vi.fn();
      actor.onAction(handler);

      const id = actor.addBlock('typescript', 'const x = 1;');
      actor.toggleDiff(id);

      expect(handler).toHaveBeenCalledWith(id, 'diff', 'const x = 1;', 'typescript');
    });
  });

  describe('Apply functionality', () => {
    beforeEach(() => {
      actor = new CodeBlockShadowActor(manager, element);
    });

    it('calls action handler on apply', () => {
      const handler = vi.fn();
      actor.onAction(handler);

      const id = actor.addBlock('typescript', 'const x = 1;');
      actor.apply(id);

      expect(handler).toHaveBeenCalledWith(id, 'apply', 'const x = 1;', 'typescript');
    });
  });

  describe('Block management', () => {
    beforeEach(() => {
      actor = new CodeBlockShadowActor(manager, element);
    });

    it('gets block by ID', () => {
      const id = actor.addBlock('typescript', 'const x = 1;');

      const block = actor.getBlock(id);
      expect(block).toBeTruthy();
      expect(block?.language).toBe('typescript');
    });

    it('gets all blocks', () => {
      actor.addBlock('typescript', 'const x = 1;');
      actor.addBlock('python', 'x = 1');

      expect(actor.getBlocks().length).toBe(2);
    });

    it('removes block from state', () => {
      const id = actor.addBlock('typescript', 'const x = 1;');

      actor.removeBlock(id);

      expect(actor.getBlock(id)).toBeUndefined();
    });

    it('clears all blocks', () => {
      actor.addBlock('typescript', 'const x = 1;');
      actor.addBlock('python', 'x = 1');

      actor.clear();

      expect(actor.getBlocks().length).toBe(0);
    });
  });

  describe('Edit mode', () => {
    beforeEach(() => {
      actor = new CodeBlockShadowActor(manager, element);
    });

    it('detects applied blocks', () => {
      const id = actor.addBlock('typescript', '# File: test.ts\nconst x = 1;');
      const block = actor.getBlock(id);
      expect(block?.isApplied).toBe(true);
    });
  });

  describe('Streaming subscription', () => {
    beforeEach(async () => {
      actor = new CodeBlockShadowActor(manager, element);
      await Promise.resolve();
      await Promise.resolve();
    });

    it('auto-collapses applied blocks when streaming ends', () => {
      const id = actor.addBlock('typescript', '# File: test.ts\nconst x = 1;', { isApplied: true });

      expect(actor.isCollapsed(id)).toBe(false);

      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.active': false },
        changedKeys: ['streaming.active'],
        publicationChain: [],
        timestamp: Date.now()
      });

      expect(actor.isCollapsed(id)).toBe(true);
    });
  });

  describe('State', () => {
    beforeEach(() => {
      actor = new CodeBlockShadowActor(manager, element);
    });

    it('returns current state', () => {
      const id = actor.addBlock('typescript', 'const x = 1;');
      actor.collapse(id);

      const state = actor.getState();

      expect(state.blocks.length).toBe(1);
      expect(state.collapsedIds).toContain(id);
      expect(state.diffedId).toBeNull();
    });

    it('returns collapsed IDs', () => {
      const id1 = actor.addBlock('typescript', 'const x = 1;');
      const id2 = actor.addBlock('python', 'x = 1');

      actor.collapse(id1);

      expect(actor.getCollapsedIds()).toEqual([id1]);
    });
  });

  describe('Lifecycle', () => {
    it('cleans up on destroy', () => {
      actor = new CodeBlockShadowActor(manager, element);
      actor.addBlock('typescript', 'const x = 1;');

      actor.destroy();

      expect(actor.getBlocks().length).toBe(0);
    });
  });
});
