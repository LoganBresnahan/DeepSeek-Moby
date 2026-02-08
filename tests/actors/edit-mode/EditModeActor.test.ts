/**
 * Unit tests for EditModeActor
 *
 * Tests edit mode state management including:
 * - Initial state
 * - Mode changes via setMode()
 * - Mode changes via pub/sub (edit.mode.set)
 * - Validation of invalid modes
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EditModeActor, EditMode } from '../../../media/actors/edit-mode/EditModeActor';
import { EventStateManager } from '../../../media/state/EventStateManager';

describe('EditModeActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: EditModeActor;

  beforeEach(() => {
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'edit-mode-root';
    document.body.appendChild(element);

    actor = new EditModeActor(manager, element);
  });

  afterEach(() => {
    actor.destroy();
    document.body.innerHTML = '';
  });

  describe('initialization', () => {
    it('registers with the manager', async () => {
      await new Promise(resolve => queueMicrotask(resolve));
      expect(manager.hasActor('edit-mode-root-EditModeActor')).toBe(true);
    });

    it('starts with default mode (manual)', () => {
      expect(actor.getMode()).toBe('manual');
    });

    it('publishes initial state on construction', async () => {
      const handleStateSpy = vi.spyOn(manager, 'handleStateChange');

      const newActor = new EditModeActor(manager, document.createElement('div'));

      expect(handleStateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({ 'edit.mode': 'manual' })
        })
      );

      newActor.destroy();
    });
  });

  describe('setMode', () => {
    it('changes mode to ask', () => {
      actor.setMode('ask');
      expect(actor.getMode()).toBe('ask');
    });

    it('changes mode to auto', () => {
      actor.setMode('auto');
      expect(actor.getMode()).toBe('auto');
    });

    it('changes mode back to manual', () => {
      actor.setMode('auto');
      actor.setMode('manual');
      expect(actor.getMode()).toBe('manual');
    });

    it('publishes mode change', () => {
      const handleStateSpy = vi.spyOn(manager, 'handleStateChange');

      actor.setMode('auto');

      expect(handleStateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({ 'edit.mode': 'auto' })
        })
      );
    });

    it('does not publish if mode is unchanged', () => {
      actor.setMode('manual'); // Already manual
      const handleStateSpy = vi.spyOn(manager, 'handleStateChange');

      actor.setMode('manual');

      expect(handleStateSpy).not.toHaveBeenCalled();
    });

    it('ignores invalid mode strings', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      actor.setMode('invalid' as EditMode);

      expect(actor.getMode()).toBe('manual');
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('pub/sub mode changes', () => {
    it('changes mode when edit.mode.set is published', () => {
      manager.publishDirect('edit.mode.set', 'ask');

      expect(actor.getMode()).toBe('ask');
    });

    it('ignores invalid mode via pub/sub', () => {
      manager.publishDirect('edit.mode.set', 'invalid');

      expect(actor.getMode()).toBe('manual');
    });
  });

  describe('isValidMode', () => {
    it('returns true for valid modes', () => {
      expect(actor.isValidMode('manual')).toBe(true);
      expect(actor.isValidMode('ask')).toBe(true);
      expect(actor.isValidMode('auto')).toBe(true);
    });

    it('returns false for invalid modes', () => {
      expect(actor.isValidMode('invalid')).toBe(false);
      expect(actor.isValidMode('')).toBe(false);
      expect(actor.isValidMode(null)).toBe(false);
      expect(actor.isValidMode(undefined)).toBe(false);
      expect(actor.isValidMode(123)).toBe(false);
    });
  });

  describe('getValidModes', () => {
    it('returns all valid modes', () => {
      const modes = actor.getValidModes();

      expect(modes).toContain('manual');
      expect(modes).toContain('ask');
      expect(modes).toContain('auto');
      expect(modes.length).toBe(3);
    });

    it('returns readonly array', () => {
      const modes = actor.getValidModes();

      // TypeScript would catch this at compile time, but we can verify at runtime
      expect(Array.isArray(modes)).toBe(true);
    });
  });
});
