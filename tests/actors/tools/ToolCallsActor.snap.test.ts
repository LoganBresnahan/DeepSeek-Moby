/**
 * Snapshot tests for ToolCallsActor
 * Captures DOM output for visual regression detection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { ToolCallsActor } from '../../../media/actors/tools/ToolCallsActor';

describe('ToolCallsActor Snapshots', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: ToolCallsActor;

  beforeEach(() => {
    ToolCallsActor.resetStylesInjected();

    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'tools-container';
    document.body.appendChild(element);

    actor = new ToolCallsActor(manager, element);
  });

  afterEach(() => {
    actor.destroy();
    document.body.innerHTML = '';
  });

  describe('empty state', () => {
    it('renders empty when no tools', () => {
      expect(element.innerHTML).toMatchSnapshot();
    });
  });

  describe('running tools', () => {
    it('renders single running tool', () => {
      actor.startBatch([{ name: 'readFile', detail: '/path/to/file.ts' }]);
      const normalized = normalizeIds(element.innerHTML);
      expect(normalized).toMatchSnapshot();
    });

    it('renders multiple running tools', () => {
      actor.startBatch([
        { name: 'readFile', detail: '/src/main.ts' },
        { name: 'writeFile', detail: '/src/output.ts' },
        { name: 'searchFiles', detail: '*.test.ts' }
      ]);
      const normalized = normalizeIds(element.innerHTML);
      expect(normalized).toMatchSnapshot();
    });
  });

  describe('completed tools', () => {
    it('renders successful tools', () => {
      actor.startBatch([
        { name: 'readFile', detail: 'file.ts' },
        { name: 'writeFile', detail: 'out.ts' }
      ]);
      actor.complete();
      const normalized = normalizeIds(element.innerHTML);
      expect(normalized).toMatchSnapshot();
    });

    it('renders failed tools', () => {
      const id = actor.addTool('readFile', 'file.ts');
      actor.completeTool(id, false);
      const normalized = normalizeIds(element.innerHTML);
      expect(normalized).toMatchSnapshot();
    });

    it('renders mixed success/failure', () => {
      const id1 = actor.addTool('readFile', 'file.ts');
      const id2 = actor.addTool('writeFile', 'out.ts');
      actor.completeTool(id1, true);
      actor.completeTool(id2, false);
      const normalized = normalizeIds(element.innerHTML);
      expect(normalized).toMatchSnapshot();
    });
  });

  describe('expanded state', () => {
    it('renders expanded dropdown', () => {
      actor.startBatch([
        { name: 'readFile', detail: 'file.ts' },
        { name: 'writeFile', detail: 'out.ts' }
      ]);
      actor.expand();
      const normalized = normalizeIds(element.innerHTML);
      expect(normalized).toMatchSnapshot();
    });
  });

  describe('injected styles', () => {
    it('injects styles into document head', () => {
      const styleTag = document.querySelector('style[data-actor="tools"]');
      expect(styleTag).toBeTruthy();
      expect(styleTag?.textContent).toMatchSnapshot();
    });
  });
});

describe('ToolCallsActor State Snapshots', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: ToolCallsActor;

  beforeEach(() => {
    ToolCallsActor.resetStylesInjected();
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'tools-container';
    document.body.appendChild(element);
    actor = new ToolCallsActor(manager, element);
  });

  afterEach(() => {
    actor.destroy();
    document.body.innerHTML = '';
  });

  it('captures initial state', () => {
    expect(actor.getState()).toMatchSnapshot();
  });

  it('captures state with running tools', () => {
    actor.startBatch([
      { name: 'readFile', detail: 'file.ts' },
      { name: 'writeFile', detail: 'out.ts' }
    ]);
    const state = actor.getState();
    // Normalize IDs for snapshot
    state.calls = state.calls.map(call => ({
      ...call,
      id: 'tool-X'
    }));
    expect(state).toMatchSnapshot();
  });

  it('captures state after completion', () => {
    actor.startBatch([{ name: 'readFile', detail: 'file.ts' }]);
    actor.complete();
    const state = actor.getState();
    state.calls = state.calls.map(call => ({
      ...call,
      id: 'tool-X'
    }));
    expect(state).toMatchSnapshot();
  });
});

/**
 * Helper to normalize dynamic IDs in HTML for consistent snapshots
 */
function normalizeIds(html: string): string {
  // Replace dynamic tool IDs: tool-1, tool-2 -> tool-X
  let normalized = html.replace(/tool-\d+/g, 'tool-X');
  // Replace batch IDs with timestamps: tools-batch-1-1234567890 -> tools-batch-X
  normalized = normalized.replace(/tools-batch-\d+-\d+/g, 'tools-batch-X');
  return normalized;
}
