/**
 * Snapshot tests for CodeBlockActor
 * Captures rendered output for visual regression detection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { CodeBlockActor } from '../../../media/actors/codeblock/CodeBlockActor';

describe('CodeBlockActor Snapshots', () => {
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

  describe('renderBlock output', () => {
    it('renders basic code block', () => {
      const id = actor.addBlock('javascript', 'const x = 1;\nconst y = 2;');
      const block = actor.getBlock(id)!;
      const html = normalizeIds(actor.renderBlock(block));
      expect(html).toMatchSnapshot();
    });

    it('renders collapsed code block', () => {
      const id = actor.addBlock('javascript', 'const x = 1;', { collapsed: true });
      const block = actor.getBlock(id)!;
      const html = normalizeIds(actor.renderBlock(block));
      expect(html).toMatchSnapshot();
    });

    it('renders applied code block in ask mode', () => {
      const id = actor.addBlock('typescript', '# File: src/main.ts\nconst x: number = 1;');
      const block = actor.getBlock(id)!;
      const html = normalizeIds(actor.renderBlock(block, 'ask'));
      expect(html).toMatchSnapshot();
    });

    it('renders tool output block', () => {
      const id = actor.addBlock('tool-output', 'Command executed successfully');
      const block = actor.getBlock(id)!;
      const html = normalizeIds(actor.renderBlock(block));
      expect(html).toMatchSnapshot();
    });

    it('renders diffed code block', () => {
      const id = actor.addBlock('javascript', 'const x = 1;');
      actor.toggleDiff(id);
      const block = actor.getBlock(id)!;
      const html = normalizeIds(actor.renderBlock(block));
      expect(html).toMatchSnapshot();
    });
  });

  describe('syntax highlighting', () => {
    it('highlights JavaScript code', () => {
      const id = actor.addBlock('javascript', `
const greeting = "Hello World";
let count = 42;
// This is a comment
function sayHello() {
  return greeting;
}
      `.trim());
      const block = actor.getBlock(id)!;
      const html = normalizeIds(actor.renderBlock(block));
      expect(html).toMatchSnapshot();
    });

    it('highlights Python code', () => {
      const id = actor.addBlock('python', `
def hello():
    # Comment
    message = "Hello"
    return message
      `.trim());
      const block = actor.getBlock(id)!;
      const html = normalizeIds(actor.renderBlock(block));
      expect(html).toMatchSnapshot();
    });
  });

  describe('injected styles', () => {
    it('injects styles into document head', () => {
      const styleTag = document.querySelector('style[data-actor="codeblock"]');
      expect(styleTag).toBeTruthy();
      expect(styleTag?.textContent).toMatchSnapshot();
    });
  });
});

describe('CodeBlockActor State Snapshots', () => {
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

  it('captures initial state', () => {
    expect(actor.getState()).toMatchSnapshot();
  });

  it('captures state with blocks', () => {
    actor.addBlock('javascript', 'const x = 1;');
    actor.addBlock('python', 'x = 1');
    const state = actor.getState();
    // Normalize IDs
    state.blocks = state.blocks.map(b => ({
      ...b,
      id: 'codeblock-X'
    }));
    expect(state).toMatchSnapshot();
  });

  it('captures state with collapsed block', () => {
    const id = actor.addBlock('javascript', 'code', { collapsed: true });
    const state = actor.getState();
    state.blocks = state.blocks.map(b => ({
      ...b,
      id: 'codeblock-X'
    }));
    state.collapsedIds = state.collapsedIds.map(() => 'codeblock-X');
    expect(state).toMatchSnapshot();
  });
});

/**
 * Helper to normalize dynamic IDs in HTML for consistent snapshots
 */
function normalizeIds(html: string): string {
  return html.replace(/codeblock-\d+-\d+/g, 'codeblock-X');
}
