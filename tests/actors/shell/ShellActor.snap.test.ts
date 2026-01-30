/**
 * Snapshot tests for ShellActor
 * Captures DOM output for visual regression detection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { ShellActor } from '../../../media/actors/shell/ShellActor';

describe('ShellActor Snapshots', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: ShellActor;

  beforeEach(() => {
    ShellActor.resetStylesInjected();

    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'shell-container';
    document.body.appendChild(element);

    actor = new ShellActor(manager, element);
  });

  afterEach(() => {
    actor.destroy();
    document.body.innerHTML = '';
  });

  describe('empty state', () => {
    it('renders empty when no segments', () => {
      expect(element.innerHTML).toMatchSnapshot();
    });
  });

  describe('pending commands', () => {
    it('renders single pending command', () => {
      actor.createSegment(['npm install']);
      // Normalize dynamic IDs for snapshot
      const normalized = normalizeIds(element.innerHTML);
      expect(normalized).toMatchSnapshot();
    });

    it('renders multiple pending commands', () => {
      actor.createSegment(['npm install', 'npm test', 'npm build']);
      const normalized = normalizeIds(element.innerHTML);
      expect(normalized).toMatchSnapshot();
    });
  });

  describe('running commands', () => {
    it('renders running command with spinner', () => {
      const id = actor.createSegment(['npm install']);
      actor.startSegment(id);
      const normalized = normalizeIds(element.innerHTML);
      expect(normalized).toMatchSnapshot();
    });
  });

  describe('completed commands', () => {
    it('renders successful command', () => {
      const id = actor.createSegment(['npm install']);
      actor.startSegment(id);
      actor.setResults(id, [{ success: true, output: 'added 100 packages' }]);
      const normalized = normalizeIds(element.innerHTML);
      expect(normalized).toMatchSnapshot();
    });

    it('renders failed command', () => {
      const id = actor.createSegment(['npm test']);
      actor.startSegment(id);
      actor.setResults(id, [{ success: false, output: 'Error: Test failed at line 42' }]);
      const normalized = normalizeIds(element.innerHTML);
      expect(normalized).toMatchSnapshot();
    });

    it('renders mixed success/failure', () => {
      const id = actor.createSegment(['npm install', 'npm test']);
      actor.startSegment(id);
      actor.setResults(id, [
        { success: true, output: 'installed' },
        { success: false, output: 'failed' }
      ]);
      const normalized = normalizeIds(element.innerHTML);
      expect(normalized).toMatchSnapshot();
    });
  });

  describe('expanded state', () => {
    it('renders expanded segment', () => {
      const id = actor.createSegment(['npm install']);
      actor.expand(id);
      const normalized = normalizeIds(element.innerHTML);
      expect(normalized).toMatchSnapshot();
    });
  });

  describe('multiple segments', () => {
    it('renders multiple segments', () => {
      const id1 = actor.createSegment(['npm install']);
      const id2 = actor.createSegment(['git status', 'git add .']);
      actor.startSegment(id1);
      actor.setResults(id1, [{ success: true }]);
      actor.startSegment(id2);
      const normalized = normalizeIds(element.innerHTML);
      expect(normalized).toMatchSnapshot();
    });
  });

  describe('injected styles', () => {
    it('injects styles into document head', () => {
      const styleTag = document.querySelector('style[data-actor="shell"]');
      expect(styleTag).toBeTruthy();
      expect(styleTag?.textContent).toMatchSnapshot();
    });
  });
});

describe('ShellActor State Snapshots', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: ShellActor;

  beforeEach(() => {
    ShellActor.resetStylesInjected();
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'shell-container';
    document.body.appendChild(element);
    actor = new ShellActor(manager, element);
  });

  afterEach(() => {
    actor.destroy();
    document.body.innerHTML = '';
  });

  it('captures initial state', () => {
    expect(actor.getState()).toMatchSnapshot();
  });

  it('captures state with running commands', () => {
    const id = actor.createSegment(['npm install', 'npm test']);
    actor.startSegment(id);
    const state = actor.getState();
    // Normalize segment for snapshot - exclude element (has dynamic IDs)
    state.segments = state.segments.map(seg => ({
      id: 'shell-X-TIMESTAMP',
      commands: seg.commands,
      complete: seg.complete
    }));
    expect(state).toMatchSnapshot();
  });

  it('captures state with completed commands', () => {
    const id = actor.createSegment(['npm install']);
    actor.startSegment(id);
    actor.setResults(id, [{ success: true, output: 'done' }]);
    const state = actor.getState();
    // Normalize segment for snapshot - exclude element (has dynamic IDs)
    state.segments = state.segments.map(seg => ({
      id: 'shell-X-TIMESTAMP',
      commands: seg.commands,
      complete: seg.complete
    }));
    expect(state).toMatchSnapshot();
  });
});

/**
 * Helper to normalize dynamic IDs in HTML for consistent snapshots
 */
function normalizeIds(html: string): string {
  // Replace dynamic shell IDs: shell-1-1234567890123 -> shell-X-TIMESTAMP
  return html.replace(/shell-\d+-\d+/g, 'shell-X-TIMESTAMP');
}
