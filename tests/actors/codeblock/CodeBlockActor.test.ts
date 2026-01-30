/**
 * Unit tests for CodeBlockActor
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushMicrotasks } from '../../setup';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { CodeBlockActor } from '../../../media/actors/codeblock/CodeBlockActor';

describe('CodeBlockActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: CodeBlockActor;

  beforeEach(() => {
    CodeBlockActor.resetStylesInjected();

    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'codeblock-container';
    document.body.appendChild(element);

    actor = new CodeBlockActor(manager, element);
  });

  afterEach(() => {
    actor.destroy();
    document.body.innerHTML = '';
  });

  describe('initialization', () => {
    it('registers with the manager', async () => {
      await flushMicrotasks();
      expect(manager.hasActor('codeblock-container-CodeBlockActor')).toBe(true);
    });

    it('starts with empty state', () => {
      const state = actor.getState();
      expect(state.blocks).toEqual([]);
      expect(state.collapsedIds).toEqual([]);
      expect(state.diffedId).toBe(null);
    });

    it('injects styles into document head', () => {
      const styleTag = document.querySelector('style[data-actor="codeblock"]');
      expect(styleTag).toBeTruthy();
    });
  });

  describe('addBlock', () => {
    it('adds a code block', () => {
      const id = actor.addBlock('javascript', 'const x = 1;');

      expect(id).toMatch(/^codeblock-\d+-\d+$/);
      const state = actor.getState();
      expect(state.blocks.length).toBe(1);
      expect(state.blocks[0].language).toBe('javascript');
      expect(state.blocks[0].code).toBe('const x = 1;');
    });

    it('detects applied blocks by File header', () => {
      actor.addBlock('typescript', '# File: src/main.ts\nconst x = 1;');

      expect(actor.getState().blocks[0].isApplied).toBe(true);
    });

    it('detects tool output blocks', () => {
      actor.addBlock('tool-output', 'Some output');

      expect(actor.getState().blocks[0].isToolOutput).toBe(true);
    });

    it('publishes state', () => {
      const spy = vi.spyOn(manager, 'handleStateChange');
      actor.addBlock('javascript', 'code');

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            'codeblock.blocks': expect.any(Array)
          })
        })
      );
    });
  });

  describe('getBlock', () => {
    it('returns block by ID', () => {
      const id = actor.addBlock('javascript', 'const x = 1;');
      const block = actor.getBlock(id);

      expect(block?.code).toBe('const x = 1;');
    });

    it('returns undefined for invalid ID', () => {
      expect(actor.getBlock('invalid')).toBeUndefined();
    });
  });

  describe('collapse/expand', () => {
    it('toggleCollapse toggles state', () => {
      const id = actor.addBlock('javascript', 'code');

      expect(actor.isCollapsed(id)).toBe(false);

      actor.toggleCollapse(id);
      expect(actor.isCollapsed(id)).toBe(true);

      actor.toggleCollapse(id);
      expect(actor.isCollapsed(id)).toBe(false);
    });

    it('collapse sets collapsed true', () => {
      const id = actor.addBlock('javascript', 'code');
      actor.collapse(id);

      expect(actor.isCollapsed(id)).toBe(true);
    });

    it('expand sets collapsed false', () => {
      const id = actor.addBlock('javascript', 'code', { collapsed: true });
      actor.expand(id);

      expect(actor.isCollapsed(id)).toBe(false);
    });

    it('getCollapsedIds returns collapsed block IDs', () => {
      const id1 = actor.addBlock('js', 'code1');
      const id2 = actor.addBlock('js', 'code2');
      actor.collapse(id1);

      expect(actor.getCollapsedIds()).toContain(id1);
      expect(actor.getCollapsedIds()).not.toContain(id2);
    });

    it('publishes collapsed state', () => {
      const id = actor.addBlock('javascript', 'code');
      const spy = vi.spyOn(manager, 'handleStateChange');

      actor.collapse(id);

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            'codeblock.collapsedIds': expect.arrayContaining([id])
          })
        })
      );
    });
  });

  describe('copy', () => {
    it('copies code to clipboard', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true
      });

      const id = actor.addBlock('javascript', 'const x = 1;');
      const result = await actor.copy(id);

      expect(result).toBe(true);
      expect(writeText).toHaveBeenCalledWith('const x = 1;');
    });

    it('calls action handler', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true
      });

      const handler = vi.fn();
      actor.onAction(handler);

      const id = actor.addBlock('javascript', 'code');
      await actor.copy(id);

      expect(handler).toHaveBeenCalledWith(id, 'copy', 'code', 'javascript');
    });

    it('returns false on clipboard error', async () => {
      const writeText = vi.fn().mockRejectedValue(new Error('Clipboard error'));
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true
      });

      const id = actor.addBlock('javascript', 'code');
      const result = await actor.copy(id);

      expect(result).toBe(false);
    });
  });

  describe('diff', () => {
    it('toggleDiff sets diffed state', () => {
      const id = actor.addBlock('javascript', 'code');
      actor.toggleDiff(id);

      expect(actor.isDiffed(id)).toBe(true);
      expect(actor.getState().diffedId).toBe(id);
    });

    it('toggleDiff closes existing diff', () => {
      const id = actor.addBlock('javascript', 'code');
      actor.toggleDiff(id);
      actor.toggleDiff(id);

      expect(actor.isDiffed(id)).toBe(false);
      expect(actor.getState().diffedId).toBe(null);
    });

    it('only one block can be diffed at a time', () => {
      const id1 = actor.addBlock('javascript', 'code1');
      const id2 = actor.addBlock('javascript', 'code2');

      actor.toggleDiff(id1);
      actor.toggleDiff(id2);

      expect(actor.isDiffed(id1)).toBe(false);
      expect(actor.isDiffed(id2)).toBe(true);
    });

    it('closeDiff clears diffed state', () => {
      const id = actor.addBlock('javascript', 'code');
      actor.toggleDiff(id);
      actor.closeDiff();

      expect(actor.getState().diffedId).toBe(null);
    });

    it('calls action handler', () => {
      const handler = vi.fn();
      actor.onAction(handler);

      const id = actor.addBlock('javascript', 'code');
      actor.toggleDiff(id);

      expect(handler).toHaveBeenCalledWith(id, 'diff', 'code', 'javascript');
    });
  });

  describe('apply', () => {
    it('calls action handler', () => {
      const handler = vi.fn();
      actor.onAction(handler);

      const id = actor.addBlock('javascript', 'code');
      actor.apply(id);

      expect(handler).toHaveBeenCalledWith(id, 'apply', 'code', 'javascript');
    });
  });

  describe('removeBlock', () => {
    it('removes block', () => {
      const id = actor.addBlock('javascript', 'code');
      actor.removeBlock(id);

      expect(actor.getBlock(id)).toBeUndefined();
      expect(actor.getState().blocks.length).toBe(0);
    });

    it('clears diff if removed block was diffed', () => {
      const id = actor.addBlock('javascript', 'code');
      actor.toggleDiff(id);
      actor.removeBlock(id);

      expect(actor.getState().diffedId).toBe(null);
    });
  });

  describe('clear', () => {
    it('removes all blocks', () => {
      actor.addBlock('js', 'code1');
      actor.addBlock('js', 'code2');
      actor.clear();

      expect(actor.getState().blocks.length).toBe(0);
    });

    it('clears diff state', () => {
      const id = actor.addBlock('js', 'code');
      actor.toggleDiff(id);
      actor.clear();

      expect(actor.getState().diffedId).toBe(null);
    });
  });

  describe('streaming subscription', () => {
    it('auto-collapses applied blocks when streaming ends', () => {
      const id = actor.addBlock('js', '# File: test.js\ncode', { collapsed: false });

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

  describe('renderBlock', () => {
    it('renders block HTML', () => {
      const id = actor.addBlock('javascript', 'const x = 1;');
      const block = actor.getBlock(id)!;
      const html = actor.renderBlock(block);

      expect(html).toContain('codeblock-container');
      expect(html).toContain('javascript');
      expect(html).toContain('const');
    });

    it('shows (APPLIED) label in ask/auto mode', () => {
      const id = actor.addBlock('javascript', '# File: test.js\ncode');
      const block = actor.getBlock(id)!;
      const html = actor.renderBlock(block, 'ask');

      expect(html).toContain('(APPLIED)');
    });

    it('hides diff/apply buttons for applied blocks in ask mode', () => {
      const id = actor.addBlock('javascript', '# File: test.js\ncode');
      const block = actor.getBlock(id)!;
      const html = actor.renderBlock(block, 'ask');

      expect(html).toContain('copy-btn');
      expect(html).not.toContain('diff-btn');
      expect(html).not.toContain('apply-btn');
    });

    it('shows all buttons in manual mode', () => {
      const id = actor.addBlock('javascript', 'code');
      const block = actor.getBlock(id)!;
      const html = actor.renderBlock(block, 'manual');

      expect(html).toContain('copy-btn');
      expect(html).toContain('diff-btn');
      expect(html).toContain('apply-btn');
    });

    it('applies collapsed class', () => {
      const id = actor.addBlock('javascript', 'code', { collapsed: true });
      const block = actor.getBlock(id)!;
      const html = actor.renderBlock(block);

      expect(html).toContain('collapsed');
    });

    it('applies diffed class', () => {
      const id = actor.addBlock('javascript', 'code');
      actor.toggleDiff(id);
      const block = actor.getBlock(id)!;
      const html = actor.renderBlock(block);

      expect(html).toContain('diffed');
    });
  });

  describe('syntax highlighting', () => {
    it('highlights keywords', () => {
      const id = actor.addBlock('javascript', 'const x = function() {}');
      const block = actor.getBlock(id)!;
      const html = actor.renderBlock(block);

      expect(html).toContain('token keyword');
    });

    it('highlights strings', () => {
      const id = actor.addBlock('javascript', 'const x = "hello"');
      const block = actor.getBlock(id)!;
      const html = actor.renderBlock(block);

      expect(html).toContain('token string');
    });

    it('highlights numbers', () => {
      const id = actor.addBlock('javascript', 'const x = 42');
      const block = actor.getBlock(id)!;
      const html = actor.renderBlock(block);

      expect(html).toContain('token number');
    });

    it('escapes HTML in code', () => {
      const id = actor.addBlock('javascript', 'const x = "<script>"');
      const block = actor.getBlock(id)!;
      const html = actor.renderBlock(block);

      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });
  });

  describe('getBlocks', () => {
    it('returns copy of blocks', () => {
      actor.addBlock('js', 'code');
      const blocks = actor.getBlocks();
      blocks.push({
        id: 'fake',
        language: 'fake',
        code: 'fake',
        collapsed: false,
        isApplied: false,
        isToolOutput: false
      });

      expect(actor.getState().blocks.length).toBe(1);
    });
  });
});
