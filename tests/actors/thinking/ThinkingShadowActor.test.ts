/**
 * Tests for ThinkingShadowActor
 *
 * Tests the Shadow DOM version of ThinkingActor including:
 * - Shadow DOM encapsulation
 * - Iteration management
 * - Expand/collapse behavior
 * - Streaming integration
 * - Style isolation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ThinkingShadowActor } from '../../../media/actors/thinking/ThinkingShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';

describe('ThinkingShadowActor', () => {
  let manager: EventStateManager;
  let parentElement: HTMLElement;
  let actor: ThinkingShadowActor;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new EventStateManager();
    parentElement = document.createElement('div');
    parentElement.id = 'chat-messages';
    document.body.appendChild(parentElement);
  });

  afterEach(() => {
    vi.useRealTimers();
    actor?.destroy();
    document.body.innerHTML = '';
  });

  describe('Construction', () => {
    it('creates actor without rendering content', () => {
      actor = new ThinkingShadowActor(manager, parentElement);

      expect(parentElement.children.length).toBe(0);
      expect(actor.getIterations()).toHaveLength(0);
    });

    it('marks parent element with actor name', () => {
      actor = new ThinkingShadowActor(manager, parentElement);

      expect(parentElement.getAttribute('data-interleaved-actor')).toBe('thinking');
    });
  });

  describe('Shadow DOM encapsulation', () => {
    it('creates shadow root for each iteration', () => {
      actor = new ThinkingShadowActor(manager, parentElement);
      actor.startIteration();

      const iterationHost = parentElement.querySelector('[data-actor="thinking"]');
      expect(iterationHost).toBeTruthy();
      expect(iterationHost?.shadowRoot).toBeTruthy();
    });

    it('injects styles into each iteration shadow', () => {
      actor = new ThinkingShadowActor(manager, parentElement);
      actor.startIteration();

      const iterationHost = parentElement.querySelector('[data-actor="thinking"]');
      const styleTag = iterationHost?.shadowRoot?.querySelector('style');
      expect(styleTag).toBeTruthy();
      expect(styleTag?.textContent).toContain('.container');
      expect(styleTag?.textContent).toContain('.header');
    });

    it('each iteration has isolated styles', () => {
      actor = new ThinkingShadowActor(manager, parentElement);
      actor.startIteration();
      vi.advanceTimersByTime(1);
      actor.startIteration();

      const iterations = parentElement.querySelectorAll('[data-actor="thinking"]');
      expect(iterations.length).toBe(2);

      // Each has its own shadow and style tag
      const style1 = iterations[0].shadowRoot?.querySelector('style');
      const style2 = iterations[1].shadowRoot?.querySelector('style');
      expect(style1).toBeTruthy();
      expect(style2).toBeTruthy();
      expect(style1).not.toBe(style2);
    });
  });

  describe('Iteration management', () => {
    beforeEach(() => {
      actor = new ThinkingShadowActor(manager, parentElement);
    });

    it('startIteration creates container with data-iteration attribute', () => {
      actor.startIteration();

      const container = parentElement.querySelector('[data-iteration="1"]');
      expect(container).toBeTruthy();
    });

    it('startIteration returns iteration index', () => {
      const idx1 = actor.startIteration();
      vi.advanceTimersByTime(1);
      const idx2 = actor.startIteration();

      expect(idx1).toBe(1);
      expect(idx2).toBe(2);
    });

    it('getIterations returns all iterations', () => {
      actor.startIteration();
      vi.advanceTimersByTime(1);
      actor.startIteration();

      const iterations = actor.getIterations();
      expect(iterations).toHaveLength(2);
      expect(iterations[0].index).toBe(1);
      expect(iterations[1].index).toBe(2);
    });

    it('appendContent adds to current iteration', () => {
      actor.startIteration();
      actor.appendContent('Hello ');
      actor.appendContent('World');

      expect(actor.getCurrentContent()).toBe('Hello World');
    });

    it('setIterationContent sets specific iteration content', () => {
      actor.startIteration();
      vi.advanceTimersByTime(1);
      actor.startIteration();

      actor.setIterationContent(1, 'First');
      actor.setIterationContent(2, 'Second');

      const iterations = actor.getIterations();
      expect(iterations[0].content).toBe('First');
      expect(iterations[1].content).toBe('Second');
    });

    it('completeIteration marks iteration as complete', () => {
      actor.startIteration();
      actor.appendContent('Content');
      actor.completeIteration();

      const iterations = actor.getIterations();
      expect(iterations[0].complete).toBe(true);
    });
  });

  describe('Expand/collapse behavior', () => {
    beforeEach(() => {
      actor = new ThinkingShadowActor(manager, parentElement);
      actor.startIteration();
      actor.setIterationContent(1, 'Test content');
    });

    it('iterations start expanded (auto-expand for streaming visibility)', () => {
      // New behavior: iterations auto-expand so users can see content during streaming
      const state = actor.getState();
      expect(state.expandedIndices).toHaveLength(1);
      expect(state.expandedIndices).toContain(1);
    });

    it('toggleExpanded collapses auto-expanded iteration', () => {
      // Since iterations start expanded, toggle collapses them
      actor.toggleExpanded(1);

      const state = actor.getState();
      expect(state.expandedIndices).not.toContain(1);
    });

    it('toggleExpanded expands collapsed iteration', () => {
      // First collapse, then toggle to expand
      actor.collapse(1);
      actor.toggleExpanded(1);

      const state = actor.getState();
      expect(state.expandedIndices).toContain(1);
    });

    it('expand adds to expanded set', () => {
      actor.collapse(1);  // First collapse
      actor.expand(1);    // Then expand

      expect(actor.getState().expandedIndices).toContain(1);
    });

    it('collapse removes from expanded set', () => {
      // Already expanded by default, so just collapse
      actor.collapse(1);

      expect(actor.getState().expandedIndices).not.toContain(1);
    });

    it('expandAll expands all iterations', () => {
      vi.advanceTimersByTime(1);
      actor.startIteration();
      vi.advanceTimersByTime(1);
      actor.startIteration();

      // Even if we collapse first, expandAll should expand all
      actor.collapseAll();
      actor.expandAll();

      const state = actor.getState();
      expect(state.expandedIndices).toContain(1);
      expect(state.expandedIndices).toContain(2);
      expect(state.expandedIndices).toContain(3);
    });

    it('collapseAll collapses all iterations', () => {
      vi.advanceTimersByTime(1);
      actor.startIteration();
      actor.collapseAll();

      expect(actor.getState().expandedIndices).toHaveLength(0);
    });

    it('expanded by default, collapsed class applied after collapse', () => {
      const iterationHost = parentElement.querySelector('[data-actor="thinking"]');
      const container = iterationHost?.shadowRoot?.querySelector('.container');

      // Starts expanded (no collapsed class)
      expect(container?.classList.contains('collapsed')).toBe(false);

      actor.collapse(1);

      expect(container?.classList.contains('collapsed')).toBe(true);
    });
  });

  describe('Rendering', () => {
    beforeEach(() => {
      actor = new ThinkingShadowActor(manager, parentElement);
    });

    it('renders header with icon, label, and toggle', () => {
      actor.startIteration();

      const iterationHost = parentElement.querySelector('[data-actor="thinking"]');
      const header = iterationHost?.shadowRoot?.querySelector('.header');

      expect(header?.querySelector('.icon')?.textContent).toBe('💭');
      expect(header?.querySelector('.label')).toBeTruthy();
      expect(header?.querySelector('.toggle')).toBeTruthy();
    });

    it('renders "Chain of Thought" label for single iteration', () => {
      actor.startIteration();

      const iterationHost = parentElement.querySelector('[data-actor="thinking"]');
      const label = iterationHost?.shadowRoot?.querySelector('.label');

      expect(label?.textContent).toBe('Chain of Thought');
    });

    it('renders "Thinking (Iteration N)" for multiple iterations', () => {
      actor.startIteration();
      vi.advanceTimersByTime(1);
      actor.startIteration();

      const iterations = parentElement.querySelectorAll('[data-actor="thinking"]');
      const label1 = iterations[0].shadowRoot?.querySelector('.label');
      const label2 = iterations[1].shadowRoot?.querySelector('.label');

      expect(label1?.textContent).toBe('Thinking (Iteration 1)');
      expect(label2?.textContent).toBe('Thinking (Iteration 2)');
    });

    it('renders content in body', () => {
      actor.startIteration();
      actor.setIterationContent(1, 'Test content');
      actor.expand(1);

      const iterationHost = parentElement.querySelector('[data-actor="thinking"]');
      const body = iterationHost?.shadowRoot?.querySelector('.body');

      expect(body?.textContent).toContain('Test content');
    });

    it('escapes HTML in content', () => {
      actor.startIteration();
      actor.setIterationContent(1, '<script>alert("xss")</script>');
      actor.expand(1);

      const iterationHost = parentElement.querySelector('[data-actor="thinking"]');
      const body = iterationHost?.shadowRoot?.querySelector('.body');

      expect(body?.innerHTML).toContain('&lt;script&gt;');
      expect(body?.innerHTML).not.toContain('<script>');
    });

    it('converts code blocks to pre/code elements', () => {
      actor.startIteration();
      actor.setIterationContent(1, '```javascript\nconst x = 1;\n```');
      actor.expand(1);

      const iterationHost = parentElement.querySelector('[data-actor="thinking"]');
      const pre = iterationHost?.shadowRoot?.querySelector('.body pre');
      const code = pre?.querySelector('code');

      expect(pre).toBeTruthy();
      expect(code?.textContent).toContain('const x = 1;');
    });
  });

  describe('Click handling', () => {
    it('clicking header toggles expansion', () => {
      actor = new ThinkingShadowActor(manager, parentElement);
      actor.startIteration();
      actor.setIterationContent(1, 'Content');

      const iterationHost = parentElement.querySelector('[data-actor="thinking"]');
      const header = iterationHost?.shadowRoot?.querySelector('.header') as HTMLElement;

      // Starts expanded (auto-expand behavior)
      expect(actor.getState().expandedIndices).toContain(1);

      // First click collapses
      header?.click();
      expect(actor.getState().expandedIndices).not.toContain(1);

      // Second click expands
      header?.click();
      expect(actor.getState().expandedIndices).toContain(1);
    });
  });

  describe('Streaming integration', () => {
    it('hasContent returns false initially', () => {
      actor = new ThinkingShadowActor(manager, parentElement);

      expect(actor.hasContent()).toBe(false);
    });

    it('hasContent returns true after content added', () => {
      actor = new ThinkingShadowActor(manager, parentElement);
      actor.startIteration();
      actor.appendContent('Content');

      expect(actor.hasContent()).toBe(true);
    });

    it('isStreaming returns false initially', () => {
      actor = new ThinkingShadowActor(manager, parentElement);

      expect(actor.isStreaming()).toBe(false);
    });

    it('streaming class added during streaming', async () => {
      actor = new ThinkingShadowActor(manager, parentElement);

      // Wait for registration
      await Promise.resolve();
      await Promise.resolve();

      // Create streaming actor to trigger subscription
      const streamingEl = document.createElement('div');
      streamingEl.id = 'streaming';
      document.body.appendChild(streamingEl);

      manager.register({
        actorId: 'streaming',
        element: streamingEl,
        publicationKeys: ['streaming.thinking'],
        subscriptionKeys: []
      }, {});

      // Publish thinking content
      manager.handleStateChange({
        source: 'streaming',
        state: { 'streaming.thinking': 'Thinking...' },
        changedKeys: ['streaming.thinking'],
        publicationChain: [],
        timestamp: Date.now()
      });

      const iterationHost = parentElement.querySelector('[data-actor="thinking"]');
      const container = iterationHost?.shadowRoot?.querySelector('.container');

      expect(container?.classList.contains('streaming')).toBe(true);
    });
  });

  describe('Clear and destroy', () => {
    it('clear removes all iterations', () => {
      actor = new ThinkingShadowActor(manager, parentElement);
      actor.startIteration();
      vi.advanceTimersByTime(1);
      actor.startIteration();

      actor.clear();

      expect(actor.getIterations()).toHaveLength(0);
      expect(parentElement.children.length).toBe(0);
    });

    it('clear resets state', () => {
      actor = new ThinkingShadowActor(manager, parentElement);
      actor.startIteration();
      actor.appendContent('Content');
      actor.expand(1);

      actor.clear();

      const state = actor.getState();
      expect(state.content).toBe('');
      expect(state.iterations).toHaveLength(0);
      expect(state.expandedIndices).toHaveLength(0);
      expect(state.streaming).toBe(false);
    });

    it('destroy cleans up', () => {
      actor = new ThinkingShadowActor(manager, parentElement);
      actor.startIteration();

      actor.destroy();

      expect(parentElement.children.length).toBe(0);
    });
  });

  describe('getState', () => {
    it('returns complete state object', () => {
      actor = new ThinkingShadowActor(manager, parentElement);
      actor.startIteration();
      actor.appendContent('Test');
      actor.expand(1);

      const state = actor.getState();

      expect(state).toHaveProperty('content', 'Test');
      expect(state).toHaveProperty('iterations');
      expect(state.iterations).toHaveLength(1);
      expect(state).toHaveProperty('expandedIndices');
      expect(state.expandedIndices).toContain(1);
      expect(state).toHaveProperty('streaming', false);
    });
  });
});
