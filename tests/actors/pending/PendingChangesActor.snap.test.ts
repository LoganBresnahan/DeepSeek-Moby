/**
 * Snapshot tests for PendingChangesActor
 * Captures DOM output for visual regression detection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { PendingChangesActor } from '../../../media/actors/pending/PendingChangesActor';

describe('PendingChangesActor Snapshots', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: PendingChangesActor;

  beforeEach(() => {
    PendingChangesActor.resetStylesInjected();

    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'pending-container';
    document.body.appendChild(element);

    actor = new PendingChangesActor(manager, element);
  });

  afterEach(() => {
    actor.destroy();
    document.body.innerHTML = '';
  });

  describe('empty state', () => {
    it('renders empty when no files', () => {
      expect(element.innerHTML).toMatchSnapshot();
    });
  });

  describe('ask mode', () => {
    it('renders single pending file', () => {
      actor.addFile('/src/components/Button.tsx');
      const normalized = normalizeIds(element.innerHTML);
      expect(normalized).toMatchSnapshot();
    });

    it('renders multiple pending files', () => {
      actor.addFile('/src/index.ts');
      actor.addFile('/src/components/Header.tsx');
      actor.addFile('/src/utils/helpers.ts');
      const normalized = normalizeIds(element.innerHTML);
      expect(normalized).toMatchSnapshot();
    });

    it('renders accepted file', () => {
      const id = actor.addFile('/src/file.ts');
      actor.acceptFile(id);
      const normalized = normalizeIds(element.innerHTML);
      expect(normalized).toMatchSnapshot();
    });

    it('renders rejected file', () => {
      const id = actor.addFile('/src/file.ts');
      actor.rejectFile(id);
      const normalized = normalizeIds(element.innerHTML);
      expect(normalized).toMatchSnapshot();
    });

    it('renders superseded file', () => {
      actor.addFile('/src/file.ts');
      actor.addFile('/src/file.ts', undefined, 2);
      const normalized = normalizeIds(element.innerHTML);
      expect(normalized).toMatchSnapshot();
    });
  });

  describe('auto mode', () => {
    it('renders auto-applied files', () => {
      actor.setEditMode('auto');
      actor.addFile('/src/file.ts');
      actor.addFile('/src/other.ts');
      const normalized = normalizeIds(element.innerHTML);
      expect(normalized).toMatchSnapshot();
    });
  });

  describe('manual mode', () => {
    it('renders empty in manual mode', () => {
      actor.setEditMode('manual');
      actor.addFile('/src/file.ts');
      expect(element.innerHTML).toMatchSnapshot();
    });
  });

  describe('collapsed state', () => {
    it('renders collapsed dropdown', () => {
      actor.addFile('/src/file.ts');
      actor.collapse();
      const normalized = normalizeIds(element.innerHTML);
      expect(normalized).toMatchSnapshot();
    });
  });

  describe('injected styles', () => {
    it('injects styles into document head', () => {
      const styleTag = document.querySelector('style[data-actor="pending"]');
      expect(styleTag).toBeTruthy();
      expect(styleTag?.textContent).toMatchSnapshot();
    });
  });
});

describe('PendingChangesActor State Snapshots', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: PendingChangesActor;

  beforeEach(() => {
    PendingChangesActor.resetStylesInjected();
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'pending-container';
    document.body.appendChild(element);
    actor = new PendingChangesActor(manager, element);
  });

  afterEach(() => {
    actor.destroy();
    document.body.innerHTML = '';
  });

  it('captures initial state', () => {
    expect(actor.getState()).toMatchSnapshot();
  });

  it('captures state with files', () => {
    actor.addFile('/src/index.ts');
    actor.addFile('/src/utils.ts');
    const state = actor.getState();
    // Normalize IDs for snapshot
    state.files = state.files.map(file => ({
      ...file,
      id: 'pending-X'
    }));
    expect(state).toMatchSnapshot();
  });

  it('captures state after accept', () => {
    const id = actor.addFile('/src/file.ts');
    actor.acceptFile(id);
    const state = actor.getState();
    state.files = state.files.map(file => ({
      ...file,
      id: 'pending-X'
    }));
    expect(state).toMatchSnapshot();
  });
});

/**
 * Helper to normalize dynamic IDs in HTML for consistent snapshots
 */
function normalizeIds(html: string): string {
  // Replace dynamic pending IDs: pending-1, pending-2 -> pending-X
  let normalized = html.replace(/pending-\d+/g, 'pending-X');
  // Replace container IDs with timestamps: pending-1-1234567890 -> pending-X
  normalized = normalized.replace(/pending-X-\d+/g, 'pending-X');
  return normalized;
}
