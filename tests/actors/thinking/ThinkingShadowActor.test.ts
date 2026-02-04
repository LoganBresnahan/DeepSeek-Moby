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

    it('adopts stylesheets into each iteration shadow', () => {
      actor = new ThinkingShadowActor(manager, parentElement);
      actor.startIteration();

      const iterationHost = parentElement.querySelector('[data-actor="thinking"]');
      const sheets = iterationHost?.shadowRoot?.adoptedStyleSheets;
      expect(sheets?.length).toBeGreaterThan(0);
    });

    it('iterations share adopted stylesheets for efficiency', () => {
      actor = new ThinkingShadowActor(manager, parentElement);
      actor.startIteration();
      vi.advanceTimersByTime(1);
      actor.startIteration();

      const iterations = parentElement.querySelectorAll('[data-actor="thinking"]');
      expect(iterations.length).toBe(2);

      // Optimization: same CSSStyleSheet objects are shared across containers
      const sheets1 = iterations[0].shadowRoot?.adoptedStyleSheets;
      const sheets2 = iterations[1].shadowRoot?.adoptedStyleSheets;
      expect(sheets1?.length).toBeGreaterThan(0);
      expect(sheets2?.length).toBeGreaterThan(0);
      expect(sheets1?.[0]).toBe(sheets2?.[0]); // Same base sheet
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

    it('iterations start collapsed (user must click to expand)', () => {
      // Iterations start collapsed so scroll behavior works correctly
      const state = actor.getState();
      expect(state.expandedIndices).toHaveLength(0);
      expect(state.expandedIndices).not.toContain(1);
    });

    it('toggleExpanded expands collapsed iteration', () => {
      // Since iterations start collapsed, toggle expands them
      actor.toggleExpanded(1);

      const state = actor.getState();
      expect(state.expandedIndices).toContain(1);
    });

    it('toggleExpanded collapses expanded iteration', () => {
      // First expand, then toggle to collapse
      actor.expand(1);
      actor.toggleExpanded(1);

      const state = actor.getState();
      expect(state.expandedIndices).not.toContain(1);
    });

    it('expand adds to expanded set', () => {
      // Start collapsed, then expand
      actor.expand(1);

      expect(actor.getState().expandedIndices).toContain(1);
    });

    it('collapse removes from expanded set', () => {
      // First expand, then collapse
      actor.expand(1);
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

    it('collapsed by default, expanded class added after expand', () => {
      const iterationHost = parentElement.querySelector('[data-actor="thinking"]');
      const container = iterationHost?.shadowRoot?.querySelector('.container');

      // Starts collapsed (no expanded class)
      expect(container?.classList.contains('expanded')).toBe(false);

      actor.expand(1);

      // Expanded = has expanded class
      expect(container?.classList.contains('expanded')).toBe(true);

      actor.collapse(1);

      // Collapsed again = no expanded class
      expect(container?.classList.contains('expanded')).toBe(false);
    });
  });

  describe('Rendering', () => {
    beforeEach(() => {
      actor = new ThinkingShadowActor(manager, parentElement);
    });

    it('renders header with toggle, emoji, and label', () => {
      actor.startIteration();

      const iterationHost = parentElement.querySelector('[data-actor="thinking"]');
      const header = iterationHost?.shadowRoot?.querySelector('.header');

      // +/- toggle on left (ASCII art style)
      expect(header?.querySelector('.toggle')?.textContent).toBe('+');
      // Emoji after toggle
      expect(header?.querySelector('.emoji')?.textContent).toBe('💭');
      expect(header?.querySelector('.label')).toBeTruthy();
    });

    it('renders "Thinking..." label for single incomplete iteration', () => {
      actor.startIteration();

      const iterationHost = parentElement.querySelector('[data-actor="thinking"]');
      const label = iterationHost?.shadowRoot?.querySelector('.label');

      expect(label?.textContent).toBe('Thinking...');
    });

    it('renders "Thought" for complete iterations and "Thinking..." for incomplete', () => {
      actor.startIteration();
      actor.completeIteration();
      vi.advanceTimersByTime(1);
      actor.startIteration();

      const iterations = parentElement.querySelectorAll('[data-actor="thinking"]');
      const label1 = iterations[0].shadowRoot?.querySelector('.label');
      const label2 = iterations[1].shadowRoot?.querySelector('.label');

      // Complete iteration shows "Thought", incomplete shows "Thinking..."
      expect(label1?.textContent).toBe('Thought');
      expect(label2?.textContent).toBe('Thinking...');
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

      // Starts collapsed (collapsed by default)
      expect(actor.getState().expandedIndices).not.toContain(1);

      // First click expands
      header?.click();
      expect(actor.getState().expandedIndices).toContain(1);

      // Second click collapses
      header?.click();
      expect(actor.getState().expandedIndices).not.toContain(1);
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

  describe('Multi-iteration baseOffset tracking', () => {
    /**
     * These tests verify the critical baseOffset tracking feature that ensures
     * each iteration only displays its own thinking content, not the accumulated
     * content from all iterations.
     *
     * The flow is:
     * 1. Backend sends `streaming.thinking` with ACCUMULATED content (iteration1 + iteration2 + ...)
     * 2. ThinkingShadowActor tracks `_iterationBaseOffset` when each iteration starts
     * 3. Content is sliced from the baseOffset to extract only the current iteration's content
     */

    async function setupStreamingActor(): Promise<void> {
      const streamingEl = document.createElement('div');
      streamingEl.id = 'streaming';
      document.body.appendChild(streamingEl);

      manager.register({
        actorId: 'streaming',
        element: streamingEl,
        publicationKeys: ['streaming.thinking', 'streaming.active'],
        subscriptionKeys: []
      }, {});

      // Wait for registration
      await Promise.resolve();
      await Promise.resolve();
    }

    function publishThinkingContent(content: string): void {
      manager.handleStateChange({
        source: 'streaming',
        state: { 'streaming.thinking': content },
        changedKeys: ['streaming.thinking'],
        publicationChain: [],
        timestamp: Date.now()
      });
    }

    function publishStreamingActive(active: boolean): void {
      manager.handleStateChange({
        source: 'streaming',
        state: { 'streaming.active': active },
        changedKeys: ['streaming.active'],
        publicationChain: [],
        timestamp: Date.now()
      });
    }

    it('first iteration receives full accumulated content (baseOffset = 0)', async () => {
      actor = new ThinkingShadowActor(manager, parentElement);
      await setupStreamingActor();

      // Simulate streaming.thinking with content for first iteration
      publishThinkingContent('First iteration thinking');

      const iterations = actor.getIterations();
      expect(iterations).toHaveLength(1);
      expect(iterations[0].content).toBe('First iteration thinking');
    });

    it('second iteration only receives its own content (baseOffset = iteration1.length)', async () => {
      actor = new ThinkingShadowActor(manager, parentElement);
      await setupStreamingActor();

      // Iteration 1: thinking content arrives
      publishThinkingContent('First thinking');

      // Iteration 1 ends, iteration 2 starts via startIteration()
      // (In real flow, this is triggered by 'iterationStart' message in chat.ts)
      vi.advanceTimersByTime(1);
      actor.startIteration();

      // Iteration 2: more thinking content arrives (accumulated)
      // Backend sends "First thinking" + "Second thinking" = full accumulated content
      publishThinkingContent('First thinkingSecond thinking');

      const iterations = actor.getIterations();
      expect(iterations).toHaveLength(2);
      // Iteration 1 should have only "First thinking"
      expect(iterations[0].content).toBe('First thinking');
      // Iteration 2 should have only "Second thinking" (sliced from baseOffset)
      expect(iterations[1].content).toBe('Second thinking');
    });

    it('three iterations each receive only their own content', async () => {
      actor = new ThinkingShadowActor(manager, parentElement);
      await setupStreamingActor();

      // Iteration 1
      publishThinkingContent('AAA');

      // Start iteration 2
      vi.advanceTimersByTime(1);
      actor.startIteration();

      // Iteration 2 content (accumulated: AAA + BBB)
      publishThinkingContent('AAABBB');

      // Start iteration 3
      vi.advanceTimersByTime(1);
      actor.startIteration();

      // Iteration 3 content (accumulated: AAA + BBB + CCC)
      publishThinkingContent('AAABBBCCC');

      const iterations = actor.getIterations();
      expect(iterations).toHaveLength(3);
      expect(iterations[0].content).toBe('AAA');
      expect(iterations[1].content).toBe('BBB');
      expect(iterations[2].content).toBe('CCC');
    });

    it('streaming content updates only current iteration', async () => {
      actor = new ThinkingShadowActor(manager, parentElement);
      await setupStreamingActor();

      // Iteration 1: streaming chunks
      publishThinkingContent('Chunk1');
      publishThinkingContent('Chunk1Chunk2');
      publishThinkingContent('Chunk1Chunk2Chunk3');

      const iterations = actor.getIterations();
      expect(iterations).toHaveLength(1);
      expect(iterations[0].content).toBe('Chunk1Chunk2Chunk3');
    });

    it('clear resets baseOffset tracking for next session', async () => {
      actor = new ThinkingShadowActor(manager, parentElement);
      await setupStreamingActor();

      // First session
      publishThinkingContent('Session1 Content');
      vi.advanceTimersByTime(1);
      actor.startIteration();
      publishThinkingContent('Session1 ContentMore content');

      // Clear for new session
      actor.clear();

      // New session starts fresh
      publishThinkingContent('New session');

      const iterations = actor.getIterations();
      expect(iterations).toHaveLength(1);
      expect(iterations[0].content).toBe('New session');
    });

    it('iteration auto-created via subscription when no iterations exist', async () => {
      actor = new ThinkingShadowActor(manager, parentElement);
      await setupStreamingActor();

      // No explicit startIteration() call - should auto-create via subscription
      expect(actor.getIterations()).toHaveLength(0);

      publishThinkingContent('Auto-created');

      expect(actor.getIterations()).toHaveLength(1);
      expect(actor.getIterations()[0].content).toBe('Auto-created');
    });

    it('explicit startIteration before content prevents duplicate creation', async () => {
      actor = new ThinkingShadowActor(manager, parentElement);
      await setupStreamingActor();

      // Explicit startIteration (simulating 'iterationStart' message)
      actor.startIteration();
      expect(actor.getIterations()).toHaveLength(1);

      // Content arrives - should NOT create another iteration
      publishThinkingContent('Content for iteration 1');

      expect(actor.getIterations()).toHaveLength(1);
      expect(actor.getIterations()[0].content).toBe('Content for iteration 1');
    });

    it('streaming.active false marks current iteration as complete', async () => {
      actor = new ThinkingShadowActor(manager, parentElement);
      await setupStreamingActor();

      publishThinkingContent('Thinking content');
      expect(actor.getIterations()[0].complete).toBe(false);
      expect(actor.isStreaming()).toBe(true);

      // End streaming
      publishStreamingActive(false);

      expect(actor.getIterations()[0].complete).toBe(true);
      expect(actor.isStreaming()).toBe(false);
    });

    it('handles rapid iteration switches with correct content isolation', async () => {
      actor = new ThinkingShadowActor(manager, parentElement);
      await setupStreamingActor();

      // Rapid sequence simulating R1 multi-iteration shell flow
      const content1 = 'Let me analyze the codebase...';
      const content2 = 'Now executing the fix...';
      const content3 = 'Verifying the changes...';

      // Iteration 1
      publishThinkingContent(content1);

      // Quick switch to iteration 2
      vi.advanceTimersByTime(1);
      actor.startIteration();
      publishThinkingContent(content1 + content2);

      // Quick switch to iteration 3
      vi.advanceTimersByTime(1);
      actor.startIteration();
      publishThinkingContent(content1 + content2 + content3);

      const iterations = actor.getIterations();
      expect(iterations[0].content).toBe(content1);
      expect(iterations[1].content).toBe(content2);
      expect(iterations[2].content).toBe(content3);
    });

    it('content with newlines and special characters isolated correctly', async () => {
      actor = new ThinkingShadowActor(manager, parentElement);
      await setupStreamingActor();

      const content1 = 'Line 1\nLine 2\n```code```\n';
      const content2 = '<special>&chars\nMore lines';

      publishThinkingContent(content1);
      vi.advanceTimersByTime(1);
      actor.startIteration();
      publishThinkingContent(content1 + content2);

      const iterations = actor.getIterations();
      expect(iterations[0].content).toBe(content1);
      expect(iterations[1].content).toBe(content2);
    });
  });
});
