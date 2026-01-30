/**
 * Unit tests for ThinkingActor
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushMicrotasks } from '../../setup';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { ThinkingActor } from '../../../media/actors/thinking/ThinkingActor';

describe('ThinkingActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: ThinkingActor;

  beforeEach(() => {
    ThinkingActor.resetStylesInjected();

    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'thinking-container';
    document.body.appendChild(element);

    actor = new ThinkingActor(manager, element);
  });

  afterEach(() => {
    actor.destroy();
    document.body.innerHTML = '';
  });

  describe('initialization', () => {
    it('registers with the manager', async () => {
      await flushMicrotasks();
      expect(manager.hasActor('thinking-container-ThinkingActor')).toBe(true);
    });

    it('starts with empty state', () => {
      const state = actor.getState();
      expect(state.content).toBe('');
      expect(state.iterations).toEqual([]);
      expect(state.expandedIndices).toEqual([]);
      expect(state.streaming).toBe(false);
    });

    it('injects styles into document head', () => {
      const styleTag = document.querySelector('style[data-actor="thinking"]');
      expect(styleTag).toBeTruthy();
    });

    it('renders empty initially', () => {
      expect(element.innerHTML).toBe('');
    });
  });

  describe('startIteration', () => {
    it('creates a new iteration', () => {
      const index = actor.startIteration();

      expect(index).toBe(1);
      expect(actor.getState().iterations.length).toBe(1);
      expect(actor.getState().iterations[0].index).toBe(1);
      expect(actor.getState().iterations[0].complete).toBe(false);
    });

    it('starts collapsed by default (no auto-expand)', () => {
      const index = actor.startIteration();
      expect(actor.getState().expandedIndices).not.toContain(index);
    });

    it('increments iteration index', () => {
      actor.startIteration();
      const index2 = actor.startIteration();

      expect(index2).toBe(2);
      expect(actor.getState().iterations.length).toBe(2);
    });

    it('renders iteration in DOM', () => {
      actor.startIteration();
      expect(element.querySelector('.thinking-container')).toBeTruthy();
    });
  });

  describe('appendContent', () => {
    it('appends to current iteration', () => {
      actor.startIteration();
      actor.appendContent('Hello ');
      actor.appendContent('World');

      expect(actor.getCurrentContent()).toBe('Hello World');
    });

    it('publishes content update', () => {
      actor.startIteration();
      const spy = vi.spyOn(manager, 'handleStateChange');
      actor.appendContent('test');

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            'thinking.content': 'test'
          })
        })
      );
    });
  });

  describe('setIterationContent', () => {
    it('sets content for specific iteration', () => {
      actor.startIteration();
      actor.startIteration();
      actor.setIterationContent(1, 'First iteration');
      actor.setIterationContent(2, 'Second iteration');

      const iterations = actor.getIterations();
      expect(iterations[0].content).toBe('First iteration');
      expect(iterations[1].content).toBe('Second iteration');
    });
  });

  describe('completeIteration', () => {
    it('marks iteration as complete', () => {
      actor.startIteration();
      actor.appendContent('thinking...');
      actor.completeIteration();

      expect(actor.getState().iterations[0].complete).toBe(true);
    });

    it('collapses completed iteration', () => {
      const index = actor.startIteration();
      actor.completeIteration();

      expect(actor.getState().expandedIndices).not.toContain(index);
    });
  });

  describe('expand/collapse', () => {
    it('toggleExpanded toggles state', () => {
      const index = actor.startIteration();
      actor.completeIteration();

      expect(actor.getState().expandedIndices).not.toContain(index);

      actor.toggleExpanded(index);
      expect(actor.getState().expandedIndices).toContain(index);

      actor.toggleExpanded(index);
      expect(actor.getState().expandedIndices).not.toContain(index);
    });

    it('expand adds to expandedIndices', () => {
      const index = actor.startIteration();
      actor.collapse(index);
      actor.expand(index);

      expect(actor.getState().expandedIndices).toContain(index);
    });

    it('collapse removes from expandedIndices', () => {
      const index = actor.startIteration();
      actor.collapse(index);

      expect(actor.getState().expandedIndices).not.toContain(index);
    });

    it('expandAll expands all iterations', () => {
      actor.startIteration();
      actor.completeIteration();
      actor.startIteration();
      actor.completeIteration();
      actor.collapseAll();

      actor.expandAll();

      expect(actor.getState().expandedIndices).toContain(1);
      expect(actor.getState().expandedIndices).toContain(2);
    });

    it('collapseAll collapses all iterations', () => {
      actor.startIteration();
      actor.startIteration();

      actor.collapseAll();

      expect(actor.getState().expandedIndices.length).toBe(0);
    });

    it('clicking header toggles expansion', () => {
      const index = actor.startIteration();

      // Starts collapsed, click should expand
      const header = element.querySelector('.thinking-header') as HTMLElement;
      header.click();
      expect(actor.getState().expandedIndices).toContain(index);

      // Click again should collapse
      header.click();
      expect(actor.getState().expandedIndices).not.toContain(index);
    });

    it('updates DOM class when collapsed', () => {
      actor.startIteration();
      actor.collapse(1);

      const container = element.querySelector('.thinking-container');
      expect(container?.classList.contains('collapsed')).toBe(true);
    });
  });

  describe('clear', () => {
    it('removes all iterations', () => {
      actor.startIteration();
      actor.appendContent('test');
      actor.startIteration();
      actor.clear();

      expect(actor.getState().iterations.length).toBe(0);
      expect(actor.getState().content).toBe('');
      expect(element.innerHTML).toBe('');
    });

    it('resets streaming state', () => {
      // Simulate streaming
      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.thinking': 'thinking...' },
        changedKeys: ['streaming.thinking'],
        publicationChain: [],
        timestamp: Date.now()
      });

      actor.clear();

      expect(actor.isStreaming()).toBe(false);
    });
  });

  describe('streaming subscription', () => {
    it('creates iteration on first thinking content', () => {
      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.thinking': 'Let me think...' },
        changedKeys: ['streaming.thinking'],
        publicationChain: [],
        timestamp: Date.now()
      });

      expect(actor.getState().iterations.length).toBe(1);
      expect(actor.getCurrentContent()).toBe('Let me think...');
    });

    it('sets streaming state true', () => {
      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.thinking': 'thinking' },
        changedKeys: ['streaming.thinking'],
        publicationChain: [],
        timestamp: Date.now()
      });

      expect(actor.isStreaming()).toBe(true);
    });

    it('completes iteration when streaming ends', () => {
      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.thinking': 'done thinking' },
        changedKeys: ['streaming.thinking'],
        publicationChain: [],
        timestamp: Date.now()
      });

      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.active': false },
        changedKeys: ['streaming.active'],
        publicationChain: [],
        timestamp: Date.now()
      });

      expect(actor.isStreaming()).toBe(false);
      expect(actor.getState().iterations[0].complete).toBe(true);
    });
  });

  describe('hasContent', () => {
    it('returns false when empty', () => {
      expect(actor.hasContent()).toBe(false);
    });

    it('returns true when has content', () => {
      actor.startIteration();
      actor.appendContent('test');

      expect(actor.hasContent()).toBe(true);
    });
  });

  describe('getIterations', () => {
    it('returns copy of iterations', () => {
      actor.startIteration();
      const iterations = actor.getIterations();
      iterations.push({
        index: 99,
        content: 'fake',
        complete: true
      });

      expect(actor.getState().iterations.length).toBe(1);
    });
  });

  describe('rendering', () => {
    it('shows single iteration label', () => {
      actor.startIteration();
      actor.appendContent('thinking...');

      const label = element.querySelector('.thinking-label');
      expect(label?.textContent).toContain('Chain of Thought');
    });

    it('shows iteration number for multiple', () => {
      actor.startIteration();
      actor.startIteration();

      const labels = element.querySelectorAll('.thinking-label');
      expect(labels[0]?.textContent).toContain('Iteration 1');
      expect(labels[1]?.textContent).toContain('Iteration 2');
    });

    it('shows streaming indicator via class', () => {
      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.thinking': 'thinking' },
        changedKeys: ['streaming.thinking'],
        publicationChain: [],
        timestamp: Date.now()
      });

      // Streaming state is indicated via .streaming class on container
      expect(element.querySelector('.thinking-container.streaming')).toBeTruthy();
    });

    it('removes streaming class when not streaming', () => {
      actor.startIteration();
      actor.appendContent('done');
      actor.completeIteration();

      // After completion, streaming class should be removed
      expect(element.querySelector('.thinking-container.streaming')).toBeFalsy();
    });
  });

  describe('content formatting', () => {
    it('escapes HTML', () => {
      actor.startIteration();
      actor.appendContent('<script>alert(1)</script>');

      const body = element.querySelector('.thinking-body');
      expect(body?.innerHTML).not.toContain('<script>');
      expect(body?.textContent).toContain('<script>');
    });

    it('formats code blocks', () => {
      actor.startIteration();
      actor.appendContent('```\nconst x = 1;\n```');

      const pre = element.querySelector('.thinking-body pre');
      expect(pre).toBeTruthy();
    });

    it('formats inline code', () => {
      actor.startIteration();
      actor.appendContent('Use `const` keyword');

      const code = element.querySelector('.thinking-body code');
      expect(code?.textContent).toBe('const');
    });
  });
});
