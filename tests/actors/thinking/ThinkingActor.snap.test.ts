/**
 * Snapshot tests for ThinkingActor
 * Captures DOM output for visual regression detection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { ThinkingActor } from '../../../media/actors/thinking/ThinkingActor';

describe('ThinkingActor Snapshots', () => {
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

  describe('empty state', () => {
    it('renders empty when no iterations', () => {
      expect(element.innerHTML).toMatchSnapshot();
    });
  });

  describe('single iteration', () => {
    it('renders single thinking iteration', () => {
      actor.startIteration();
      actor.appendContent('Let me analyze this problem step by step...');
      expect(normalizeIds(element.innerHTML)).toMatchSnapshot();
    });

    it('renders completed iteration', () => {
      actor.startIteration();
      actor.appendContent('Analysis complete.');
      actor.completeIteration();
      expect(normalizeIds(element.innerHTML)).toMatchSnapshot();
    });
  });

  describe('multiple iterations', () => {
    it('renders multiple iterations', () => {
      actor.startIteration();
      actor.appendContent('First approach: trying method A');
      actor.completeIteration();

      actor.startIteration();
      actor.appendContent('Second approach: trying method B');
      actor.completeIteration();

      expect(normalizeIds(element.innerHTML)).toMatchSnapshot();
    });
  });

  describe('expanded/collapsed', () => {
    it('renders expanded iteration', () => {
      actor.startIteration();
      actor.appendContent('Thinking content here');
      actor.expand(1);
      expect(normalizeIds(element.innerHTML)).toMatchSnapshot();
    });

    it('renders collapsed iteration', () => {
      actor.startIteration();
      actor.appendContent('Thinking content here');
      actor.collapse(1);
      expect(normalizeIds(element.innerHTML)).toMatchSnapshot();
    });
  });

  describe('content formatting', () => {
    it('renders with code blocks', () => {
      actor.startIteration();
      actor.appendContent('Consider this code:\n```javascript\nconst x = 42;\n```\nThis sets x to 42.');
      expect(normalizeIds(element.innerHTML)).toMatchSnapshot();
    });

    it('renders with inline code', () => {
      actor.startIteration();
      actor.appendContent('Use the `map` function to transform the array.');
      expect(normalizeIds(element.innerHTML)).toMatchSnapshot();
    });
  });

  describe('injected styles', () => {
    it('injects styles into document head', () => {
      const styleTag = document.querySelector('style[data-actor="thinking"]');
      expect(styleTag).toBeTruthy();
      expect(styleTag?.textContent).toMatchSnapshot();
    });
  });
});

describe('ThinkingActor State Snapshots', () => {
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

  it('captures initial state', () => {
    expect(actor.getState()).toMatchSnapshot();
  });

  it('captures state with active thinking', () => {
    actor.startIteration();
    actor.appendContent('Processing...');
    const state = actor.getState();
    // Normalize IDs for snapshot
    state.iterations = state.iterations.map(iter => ({
      ...iter,
      containerId: 'thinking-iteration-X'
    }));
    expect(state).toMatchSnapshot();
  });

  it('captures state after completion', () => {
    actor.startIteration();
    actor.appendContent('Done thinking.');
    actor.completeIteration();
    const state = actor.getState();
    state.iterations = state.iterations.map(iter => ({
      ...iter,
      containerId: 'thinking-iteration-X'
    }));
    expect(state).toMatchSnapshot();
  });
});

/**
 * Helper to normalize dynamic IDs in HTML for consistent snapshots
 */
function normalizeIds(html: string): string {
  // Replace container IDs with timestamps: thinking-iteration-1-1234567890 -> thinking-iteration-X
  return html.replace(/thinking-iteration-\d+-\d+/g, 'thinking-iteration-X');
}
