/**
 * Unit tests for PendingChangesActor
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushMicrotasks } from '../../setup';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { PendingChangesActor } from '../../../media/actors/pending/PendingChangesActor';

describe('PendingChangesActor', () => {
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

  describe('initialization', () => {
    it('registers with the manager', async () => {
      await flushMicrotasks();
      expect(manager.hasActor('pending-container-PendingChangesActor')).toBe(true);
    });

    it('starts with empty state', () => {
      const state = actor.getState();
      expect(state.files).toEqual([]);
      expect(state.expanded).toBe(true);
      expect(state.editMode).toBe('ask');
    });

    it('injects styles into document head', () => {
      const styleTag = document.querySelector('style[data-actor="pending"]');
      expect(styleTag).toBeTruthy();
    });

    it('renders empty initially', () => {
      expect(element.innerHTML).toBe('');
    });
  });

  describe('setEditMode', () => {
    it('changes edit mode', () => {
      actor.setEditMode('auto');
      expect(actor.getState().editMode).toBe('auto');
    });

    it('hides in manual mode', () => {
      actor.addFile('/src/file.ts');
      actor.setEditMode('manual');
      // Container should be hidden (display: none) in manual mode
      const wrapper = element.querySelector('.pending-changes-wrapper') as HTMLElement;
      expect(wrapper?.style.display).toBe('none');
    });

    it('shows in ask mode', () => {
      actor.addFile('/src/file.ts');
      actor.setEditMode('ask');
      expect(element.querySelector('.pending-container')).toBeTruthy();
    });
  });

  describe('addFile', () => {
    it('adds file with pending status', () => {
      const id = actor.addFile('/src/file.ts');

      expect(id).toMatch(/^pending-\d+$/);
      const state = actor.getState();
      expect(state.files.length).toBe(1);
      expect(state.files[0].status).toBe('pending');
      expect(state.files[0].filePath).toBe('/src/file.ts');
    });

    it('extracts filename from path', () => {
      actor.addFile('/src/components/Button.tsx');
      expect(actor.getState().files[0].fileName).toBe('Button.tsx');
    });

    it('adds iteration suffix', () => {
      actor.addFile('/src/file.ts', undefined, 2);
      expect(actor.getState().files[0].fileName).toBe('file.ts (2)');
    });

    it('marks previous same-path files as superseded', () => {
      const id1 = actor.addFile('/src/file.ts');
      const id2 = actor.addFile('/src/file.ts', undefined, 2);

      const state = actor.getState();
      expect(state.files.find(f => f.id === id1)?.superseded).toBe(true);
      expect(state.files.find(f => f.id === id2)?.superseded).toBe(false);
    });

    it('renders in DOM', () => {
      actor.addFile('/src/file.ts');
      expect(element.querySelector('.pending-container')).toBeTruthy();
      expect(element.querySelector('.pending-item')).toBeTruthy();
    });

    it('shows action buttons in ask mode', () => {
      actor.addFile('/src/file.ts');
      expect(element.querySelector('.accept-btn')).toBeTruthy();
      expect(element.querySelector('.reject-btn')).toBeTruthy();
    });

    it('shows auto-applied label in auto mode', () => {
      actor.setEditMode('auto');
      actor.addFile('/src/file.ts');

      expect(element.querySelector('.accept-btn')).toBeFalsy();
      const label = element.querySelector('.pending-label');
      expect(label?.textContent).toBe('Auto Applied');
    });

    it('publishes state', () => {
      const spy = vi.spyOn(manager, 'handleStateChange');
      actor.addFile('/src/file.ts');

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            'pending.files': expect.any(Array)
          })
        })
      );
    });
  });

  describe('updateFile', () => {
    it('updates file properties', () => {
      const id = actor.addFile('/src/file.ts');
      actor.updateFile(id, { status: 'applied' });

      expect(actor.getState().files[0].status).toBe('applied');
    });

    it('ignores invalid ID', () => {
      actor.addFile('/src/file.ts');
      actor.updateFile('invalid-id', { status: 'applied' });

      expect(actor.getState().files[0].status).toBe('pending');
    });
  });

  describe('acceptFile', () => {
    it('marks file as applied', () => {
      const id = actor.addFile('/src/file.ts');
      actor.acceptFile(id);

      expect(actor.getState().files[0].status).toBe('applied');
    });

    it('calls action handler', () => {
      const handler = vi.fn();
      actor.onAction(handler);

      const id = actor.addFile('/src/file.ts');
      actor.acceptFile(id);

      expect(handler).toHaveBeenCalledWith(id, 'accept');
    });

    it('shows accepted label', () => {
      const id = actor.addFile('/src/file.ts');
      actor.acceptFile(id);

      const label = element.querySelector('.pending-label');
      expect(label?.textContent).toBe('Accepted');
    });
  });

  describe('rejectFile', () => {
    it('marks file as rejected', () => {
      const id = actor.addFile('/src/file.ts');
      actor.rejectFile(id);

      expect(actor.getState().files[0].status).toBe('rejected');
    });

    it('calls action handler', () => {
      const handler = vi.fn();
      actor.onAction(handler);

      const id = actor.addFile('/src/file.ts');
      actor.rejectFile(id);

      expect(handler).toHaveBeenCalledWith(id, 'reject');
    });

    it('shows rejected label', () => {
      const id = actor.addFile('/src/file.ts');
      actor.rejectFile(id);

      const label = element.querySelector('.pending-label');
      expect(label?.textContent).toBe('Rejected');
    });
  });

  describe('focusFile', () => {
    it('calls action handler for pending file', () => {
      const handler = vi.fn();
      actor.onAction(handler);

      const id = actor.addFile('/src/file.ts');
      actor.focusFile(id);

      expect(handler).toHaveBeenCalledWith(id, 'focus');
    });

    it('ignores superseded file', () => {
      const handler = vi.fn();
      actor.onAction(handler);

      const id1 = actor.addFile('/src/file.ts');
      actor.addFile('/src/file.ts', undefined, 2);
      actor.focusFile(id1);

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('supersede', () => {
    it('marks file as superseded', () => {
      const id = actor.addFile('/src/file.ts');
      actor.supersede(id);

      expect(actor.getState().files[0].superseded).toBe(true);
    });

    it('shows superseded label', () => {
      const id = actor.addFile('/src/file.ts');
      actor.supersede(id);

      const label = element.querySelector('.pending-label');
      expect(label?.textContent).toContain('Superseded');
    });
  });

  describe('expand/collapse', () => {
    it('toggleExpanded toggles state', () => {
      actor.addFile('/src/file.ts');
      expect(actor.getState().expanded).toBe(true);

      actor.toggleExpanded();
      expect(actor.getState().expanded).toBe(false);

      actor.toggleExpanded();
      expect(actor.getState().expanded).toBe(true);
    });

    it('expand sets expanded true', () => {
      actor.addFile('/src/file.ts');
      actor.collapse();
      actor.expand();

      expect(actor.getState().expanded).toBe(true);
    });

    it('collapse sets expanded false', () => {
      actor.addFile('/src/file.ts');
      actor.collapse();

      expect(actor.getState().expanded).toBe(false);
    });

    it('updates DOM class when expanded', () => {
      actor.addFile('/src/file.ts');
      actor.expand();

      const container = element.querySelector('.pending-container');
      expect(container?.classList.contains('expanded')).toBe(true);
    });

    it('clicking header toggles expansion', () => {
      actor.addFile('/src/file.ts');

      const header = element.querySelector('.pending-header') as HTMLElement;
      header.click();

      expect(actor.getState().expanded).toBe(false);
    });
  });

  describe('clear', () => {
    it('removes all files', () => {
      actor.addFile('/src/file1.ts');
      actor.addFile('/src/file2.ts');
      actor.clear();

      expect(actor.getState().files.length).toBe(0);
      expect(element.innerHTML).toBe('');
    });
  });

  describe('getPendingCount', () => {
    it('counts only pending non-superseded files', () => {
      const id1 = actor.addFile('/src/file1.ts');
      actor.addFile('/src/file2.ts');
      actor.addFile('/src/file3.ts');

      expect(actor.getPendingCount()).toBe(3);

      actor.acceptFile(id1);
      expect(actor.getPendingCount()).toBe(2);
    });

    it('excludes superseded files', () => {
      actor.addFile('/src/file.ts');
      actor.addFile('/src/file.ts', undefined, 2);

      expect(actor.getPendingCount()).toBe(1);
    });
  });

  describe('hasPending', () => {
    it('returns true when has pending files', () => {
      actor.addFile('/src/file.ts');
      expect(actor.hasPending()).toBe(true);
    });

    it('returns false when no pending files', () => {
      expect(actor.hasPending()).toBe(false);
    });

    it('returns false when all files are processed', () => {
      const id = actor.addFile('/src/file.ts');
      actor.acceptFile(id);

      expect(actor.hasPending()).toBe(false);
    });
  });

  describe('getFiles', () => {
    it('returns copy of files', () => {
      actor.addFile('/src/file.ts');
      const files = actor.getFiles();
      files.push({
        id: 'fake',
        filePath: '/fake',
        fileName: 'fake',
        status: 'pending',
        iteration: 1
      });

      expect(actor.getState().files.length).toBe(1);
    });
  });

  describe('escaping', () => {
    it('escapes HTML in filenames', () => {
      actor.addFile('/src/<script>.ts');

      const fileEl = element.querySelector('.pending-file');
      expect(fileEl?.innerHTML).not.toContain('<script>');
      expect(fileEl?.textContent).toContain('<script>');
    });
  });

  describe('button clicks', () => {
    it('clicking accept button accepts file', () => {
      const id = actor.addFile('/src/file.ts');

      const acceptBtn = element.querySelector('.accept-btn') as HTMLElement;
      acceptBtn.click();

      expect(actor.getState().files[0].status).toBe('applied');
    });

    it('clicking reject button rejects file', () => {
      const id = actor.addFile('/src/file.ts');

      const rejectBtn = element.querySelector('.reject-btn') as HTMLElement;
      rejectBtn.click();

      expect(actor.getState().files[0].status).toBe('rejected');
    });

    it('clicking file focuses it', () => {
      const handler = vi.fn();
      actor.onAction(handler);

      const id = actor.addFile('/src/file.ts');

      const fileEl = element.querySelector('.pending-file') as HTMLElement;
      fileEl.click();

      expect(handler).toHaveBeenCalledWith(id, 'focus');
    });
  });
});
