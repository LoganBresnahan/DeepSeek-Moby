/**
 * Tests for PendingChangesShadowActor
 *
 * Tests Shadow DOM encapsulation, file state management,
 * edit modes, and integration with the pub/sub system.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PendingChangesShadowActor, PendingFile } from '../../../media/actors/pending/PendingChangesShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { InterleavedShadowActor } from '../../../media/state/InterleavedShadowActor';

describe('PendingChangesShadowActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: PendingChangesShadowActor;

  beforeEach(() => {
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'pending-container';
    document.body.appendChild(element);
    InterleavedShadowActor.resetInstanceCount();
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  describe('Shadow DOM creation', () => {
    it('creates shadow container when files are added', () => {
      actor = new PendingChangesShadowActor(manager, element);
      actor.addFile('/path/to/file.ts');

      const containers = element.querySelectorAll('[data-container-id]');
      expect(containers.length).toBe(1);
      expect(containers[0].shadowRoot).toBeTruthy();
    });

    it('reuses same container for multiple files', () => {
      actor = new PendingChangesShadowActor(manager, element);
      actor.addFile('/path/to/file1.ts');
      actor.addFile('/path/to/file2.ts');

      const containers = element.querySelectorAll('[data-container-id]');
      expect(containers.length).toBe(1);
    });

    it('injects styles into shadow root', () => {
      actor = new PendingChangesShadowActor(manager, element);
      actor.addFile('/path/to/file.ts');

      const container = element.querySelector('[data-container-id]');
      const styleTag = container?.shadowRoot?.querySelector('style');
      expect(styleTag).toBeTruthy();
      expect(styleTag?.textContent).toContain('.container');
      expect(styleTag?.textContent).toContain('.header');
    });
  });

  describe('File operations', () => {
    beforeEach(() => {
      actor = new PendingChangesShadowActor(manager, element);
    });

    it('adds a file with pending status', () => {
      const id = actor.addFile('/path/to/file.ts');

      expect(id).toBeTruthy();
      const files = actor.getFiles();
      expect(files.length).toBe(1);
      expect(files[0].status).toBe('pending');
      expect(files[0].fileName).toBe('file.ts');
    });

    it('adds file with auto-applied status in auto mode', () => {
      actor.setEditMode('auto');
      actor.addFile('/path/to/file.ts');

      const files = actor.getFiles();
      expect(files[0].status).toBe('applied');
    });

    it('supersedes previous pending file for same path', () => {
      actor.addFile('/path/to/file.ts', 'diff1', 1);
      actor.addFile('/path/to/file.ts', 'diff2', 2);

      const files = actor.getFiles();
      expect(files[0].superseded).toBe(true);
      expect(files[1].superseded).toBe(false);
    });

    it('shows iteration in filename', () => {
      actor.addFile('/path/to/file.ts', 'diff1', 1);
      actor.addFile('/path/to/file.ts', 'diff2', 2);

      const files = actor.getFiles();
      expect(files[0].fileName).toBe('file.ts');
      expect(files[1].fileName).toBe('file.ts (2)');
    });

    it('publishes file state on add', async () => {
      const received: unknown[] = [];
      const subscriberEl = document.createElement('div');
      subscriberEl.id = 'subscriber';
      document.body.appendChild(subscriberEl);

      subscriberEl.addEventListener('state-changed', ((e: CustomEvent) => {
        if (e.detail.state['pending.files']) {
          received.push(e.detail.state['pending.files']);
        }
      }) as EventListener);

      manager.register({
        actorId: 'subscriber',
        element: subscriberEl,
        publicationKeys: [],
        subscriptionKeys: ['pending.*']
      }, {});

      actor.addFile('/path/to/file.ts');
      await Promise.resolve();

      expect(received.length).toBeGreaterThan(0);
    });
  });

  describe('File actions', () => {
    beforeEach(() => {
      actor = new PendingChangesShadowActor(manager, element);
    });

    it('accepts a file', () => {
      const id = actor.addFile('/path/to/file.ts');
      actor.acceptFile(id);

      const files = actor.getFiles();
      expect(files[0].status).toBe('applied');
    });

    it('rejects a file', () => {
      const id = actor.addFile('/path/to/file.ts');
      actor.rejectFile(id);

      const files = actor.getFiles();
      expect(files[0].status).toBe('rejected');
    });

    it('calls action handler on accept', () => {
      const handler = vi.fn();
      actor.onAction(handler);

      const id = actor.addFile('/path/to/file.ts');
      actor.acceptFile(id);

      expect(handler).toHaveBeenCalledWith(id, 'accept');
    });

    it('calls action handler on reject', () => {
      const handler = vi.fn();
      actor.onAction(handler);

      const id = actor.addFile('/path/to/file.ts');
      actor.rejectFile(id);

      expect(handler).toHaveBeenCalledWith(id, 'reject');
    });

    it('calls action handler on focus', () => {
      const handler = vi.fn();
      actor.onAction(handler);

      const id = actor.addFile('/path/to/file.ts');
      actor.focusFile(id);

      expect(handler).toHaveBeenCalledWith(id, 'focus');
    });

    it('does not focus superseded files', () => {
      const handler = vi.fn();
      actor.onAction(handler);

      const id = actor.addFile('/path/to/file.ts');
      actor.supersede(id);
      actor.focusFile(id);

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('Edit modes', () => {
    beforeEach(() => {
      actor = new PendingChangesShadowActor(manager, element);
    });

    it('hides container in manual mode', () => {
      actor.addFile('/path/to/file.ts');
      actor.setEditMode('manual');

      const container = element.querySelector('[data-container-id]');
      expect(container?.hasAttribute('hidden')).toBe(true);
    });

    it('shows title as Pending Changes in ask mode', () => {
      actor.setEditMode('ask');
      actor.addFile('/path/to/file.ts');

      const container = element.querySelector('[data-container-id]');
      const title = container?.shadowRoot?.querySelector('.title');
      expect(title?.textContent).toBe('Pending Changes');
    });

    it('shows title as Modified Files in auto mode', () => {
      actor.setEditMode('auto');
      actor.addFile('/path/to/file.ts');

      const container = element.querySelector('[data-container-id]');
      const title = container?.shadowRoot?.querySelector('.title');
      expect(title?.textContent).toBe('Modified Files');
    });

    it('applies auto-mode class in auto mode', () => {
      actor.setEditMode('auto');
      actor.addFile('/path/to/file.ts');

      const container = element.querySelector('[data-container-id]');
      const content = container?.shadowRoot?.querySelector('.container');
      expect(content?.classList.contains('auto-mode')).toBe(true);
    });
  });

  describe('Expand/collapse', () => {
    beforeEach(() => {
      actor = new PendingChangesShadowActor(manager, element);
      actor.addFile('/path/to/file.ts');
    });

    it('starts expanded by default', () => {
      expect(actor.getState().expanded).toBe(true);
    });

    it('toggles expansion state', () => {
      actor.toggleExpanded();
      expect(actor.getState().expanded).toBe(false);

      actor.toggleExpanded();
      expect(actor.getState().expanded).toBe(true);
    });

    it('applies expanded class to container', () => {
      const container = element.querySelector('[data-container-id]');
      const content = container?.shadowRoot?.querySelector('.container');

      expect(content?.classList.contains('expanded')).toBe(true);

      actor.collapse();
      expect(content?.classList.contains('expanded')).toBe(false);

      actor.expand();
      expect(content?.classList.contains('expanded')).toBe(true);
    });

    it('publishes expanded state changes', async () => {
      const received: boolean[] = [];
      const subscriberEl = document.createElement('div');
      subscriberEl.id = 'subscriber';
      document.body.appendChild(subscriberEl);

      subscriberEl.addEventListener('state-changed', ((e: CustomEvent) => {
        if (e.detail.state['pending.expanded'] !== undefined) {
          received.push(e.detail.state['pending.expanded']);
        }
      }) as EventListener);

      manager.register({
        actorId: 'subscriber',
        element: subscriberEl,
        publicationKeys: [],
        subscriptionKeys: ['pending.*']
      }, {});

      actor.collapse();
      await Promise.resolve();

      expect(received).toContain(false);
    });
  });

  describe('Rendering', () => {
    beforeEach(() => {
      actor = new PendingChangesShadowActor(manager, element);
    });

    it('renders file count badge', () => {
      actor.addFile('/path/to/file1.ts');
      actor.addFile('/path/to/file2.ts');

      const container = element.querySelector('[data-container-id]');
      const count = container?.shadowRoot?.querySelector('.count');
      expect(count?.textContent).toBe('2');
    });

    it('renders file items', () => {
      actor.addFile('/path/to/file.ts');

      const container = element.querySelector('[data-container-id]');
      const items = container?.shadowRoot?.querySelectorAll('.item');
      expect(items?.length).toBe(1);
    });

    it('renders accept/reject buttons for pending files', () => {
      actor.addFile('/path/to/file.ts');

      const container = element.querySelector('[data-container-id]');
      const acceptBtn = container?.shadowRoot?.querySelector('.accept-btn');
      const rejectBtn = container?.shadowRoot?.querySelector('.reject-btn');
      expect(acceptBtn).toBeTruthy();
      expect(rejectBtn).toBeTruthy();
    });

    it('renders label instead of buttons for applied files', () => {
      const id = actor.addFile('/path/to/file.ts');
      actor.acceptFile(id);

      const container = element.querySelector('[data-container-id]');
      const label = container?.shadowRoot?.querySelector('.label.applied');
      const buttons = container?.shadowRoot?.querySelector('.actions');
      expect(label?.textContent).toBe('Accepted');
      expect(buttons).toBeNull();
    });

    it('renders Auto Applied label in auto mode', () => {
      actor.setEditMode('auto');
      actor.addFile('/path/to/file.ts');

      const container = element.querySelector('[data-container-id]');
      const label = container?.shadowRoot?.querySelector('.label.auto');
      expect(label?.textContent).toBe('Auto Applied');
    });
  });

  describe('Click handlers', () => {
    beforeEach(() => {
      actor = new PendingChangesShadowActor(manager, element);
    });

    it('toggles on header click', () => {
      actor.addFile('/path/to/file.ts');

      const container = element.querySelector('[data-container-id]');
      const header = container?.shadowRoot?.querySelector('.header') as HTMLElement;

      header?.click();
      expect(actor.getState().expanded).toBe(false);

      header?.click();
      expect(actor.getState().expanded).toBe(true);
    });

    it('focuses file on file name click', () => {
      const handler = vi.fn();
      actor.onAction(handler);

      const id = actor.addFile('/path/to/file.ts');

      const container = element.querySelector('[data-container-id]');
      const fileEl = container?.shadowRoot?.querySelector(`#${id} .file`) as HTMLElement;

      fileEl?.click();
      expect(handler).toHaveBeenCalledWith(id, 'focus');
    });

    it('accepts on accept button click', () => {
      const handler = vi.fn();
      actor.onAction(handler);

      const id = actor.addFile('/path/to/file.ts');

      const container = element.querySelector('[data-container-id]');
      const acceptBtn = container?.shadowRoot?.querySelector(`#${id} .accept-btn`) as HTMLElement;

      acceptBtn?.click();
      expect(handler).toHaveBeenCalledWith(id, 'accept');
    });

    it('rejects on reject button click', () => {
      const handler = vi.fn();
      actor.onAction(handler);

      const id = actor.addFile('/path/to/file.ts');

      const container = element.querySelector('[data-container-id]');
      const rejectBtn = container?.shadowRoot?.querySelector(`#${id} .reject-btn`) as HTMLElement;

      rejectBtn?.click();
      expect(handler).toHaveBeenCalledWith(id, 'reject');
    });
  });

  describe('State helpers', () => {
    beforeEach(() => {
      actor = new PendingChangesShadowActor(manager, element);
    });

    it('counts pending files correctly', () => {
      actor.addFile('/path/to/file1.ts');
      actor.addFile('/path/to/file2.ts');
      const id3 = actor.addFile('/path/to/file3.ts');

      expect(actor.getPendingCount()).toBe(3);

      actor.acceptFile(id3);
      expect(actor.getPendingCount()).toBe(2);
    });

    it('excludes superseded from pending count', () => {
      const id = actor.addFile('/path/to/file.ts', 'diff1', 1);
      actor.addFile('/path/to/file.ts', 'diff2', 2);

      // First file is superseded
      expect(actor.getPendingCount()).toBe(1);
    });

    it('hasPending returns true when pending files exist', () => {
      expect(actor.hasPending()).toBe(false);

      actor.addFile('/path/to/file.ts');
      expect(actor.hasPending()).toBe(true);
    });

    it('returns full state via getState()', () => {
      actor.addFile('/path/to/file.ts');
      actor.setEditMode('auto');

      const state = actor.getState();

      expect(state.files.length).toBe(1);
      expect(state.expanded).toBe(true);
      expect(state.editMode).toBe('auto');
    });
  });

  describe('Clear and cleanup', () => {
    beforeEach(() => {
      actor = new PendingChangesShadowActor(manager, element);
    });

    it('clears all files', () => {
      actor.addFile('/path/to/file1.ts');
      actor.addFile('/path/to/file2.ts');

      expect(actor.getFiles().length).toBe(2);

      actor.clear();

      expect(actor.getFiles().length).toBe(0);
      expect(element.querySelectorAll('[data-container-id]').length).toBe(0);
    });

    it('publishes empty files on clear', async () => {
      const received: unknown[] = [];
      const subscriberEl = document.createElement('div');
      subscriberEl.id = 'subscriber';
      document.body.appendChild(subscriberEl);

      subscriberEl.addEventListener('state-changed', ((e: CustomEvent) => {
        if (e.detail.state['pending.files'] !== undefined) {
          received.push(e.detail.state['pending.files']);
        }
      }) as EventListener);

      manager.register({
        actorId: 'subscriber',
        element: subscriberEl,
        publicationKeys: [],
        subscriptionKeys: ['pending.*']
      }, {});

      actor.addFile('/path/to/file.ts');
      actor.clear();
      await Promise.resolve();

      expect(received[received.length - 1]).toEqual([]);
    });
  });

  describe('Lifecycle', () => {
    it('cleans up on destroy', () => {
      actor = new PendingChangesShadowActor(manager, element);
      actor.addFile('/path/to/file.ts');

      actor.destroy();

      expect(element.querySelectorAll('[data-container-id]').length).toBe(0);
    });
  });
});
