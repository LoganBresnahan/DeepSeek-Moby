/**
 * Tests for TriggerDetectionController (slice 2 — the event half)
 *
 * The controller listens at document level and reads composer state only
 * through ComposerHost, so these tests use a real actor + provider, a fake
 * host over a plain state object, and a light-DOM div standing in for the
 * composer root (events dispatched on it bubble to the document listeners
 * exactly like retargeted composed events do in the real webview).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ComposerAutocompleteActor } from '../../../media/actors/composer-autocomplete/ComposerAutocompleteActor';
import { TriggerDetectionController } from '../../../media/actors/composer-autocomplete/TriggerDetectionController';
import type { ComposerHost, SuggestionProvider } from '../../../media/actors/composer-autocomplete/types';
import { EventStateManager } from '../../../media/state/EventStateManager';

const createMockVSCode = () => ({ postMessage: vi.fn() });

describe('TriggerDetectionController', () => {
  let manager: EventStateManager;
  let overlayElement: HTMLElement;
  let composerRoot: HTMLElement;
  let actor: ComposerAutocompleteActor;
  let controller: TriggerDetectionController;
  let state: { text: string; caret: number };
  let host: ComposerHost;

  const emojiProvider: SuggestionProvider = {
    trigger: ':',
    minQueryLength: 2,
    getSuggestions: (query) =>
      'smile'.startsWith(query) ? [{ label: 'smile', action: { kind: 'insertText', text: '😄' } }] : []
  };

  /** Simulate the composer reaching `text` with the caret at its end. */
  const setComposer = (text: string, caret = text.length) => {
    state.text = text;
    state.caret = caret;
  };

  const fireInput = (inputType: string | null, target: HTMLElement = composerRoot) => {
    const e = inputType === null
      ? new Event('input', { bubbles: true })
      : new InputEvent('input', { bubbles: true, inputType });
    target.dispatchEvent(e);
  };

  const typed = (text: string) => {
    setComposer(text);
    fireInput('insertText');
  };

  beforeEach(() => {
    manager = new EventStateManager({ batchBroadcasts: false });
    overlayElement = document.createElement('div');
    composerRoot = document.createElement('div');
    document.body.appendChild(overlayElement);
    document.body.appendChild(composerRoot);

    state = { text: '', caret: 0 };
    host = {
      getText: () => state.text,
      getCaret: () => state.caret,
      replaceRange: (start, end, text) => {
        state.text = state.text.slice(0, start) + text + state.text.slice(end);
        state.caret = start + text.length;
      },
      attachFile: vi.fn(),
      runCommand: vi.fn(),
      focus: vi.fn()
    };

    actor = new ComposerAutocompleteActor(manager, overlayElement, createMockVSCode(), host);
    actor.registerProvider(emojiProvider);
    controller = new TriggerDetectionController(actor, host, composerRoot, overlayElement);
    controller.attach();
  });

  afterEach(() => {
    controller.detach();
    actor?.destroy();
    document.body.innerHTML = '';
  });

  describe('keyed input', () => {
    it('opens the overlay when a trigger is typed', () => {
      typed(':sm');
      expect(actor.isVisible()).toBe(true);
      expect(actor.getActiveSpan()).toEqual({ trigger: ':', query: 'sm', start: 0, end: 3 });
    });

    it('narrows and closes as the query stops matching', () => {
      typed(':sm');
      expect(actor.isVisible()).toBe(true);

      typed(':smx');
      // Provider returns no matches — hidden, but the trigger is still live.
      expect(actor.isVisible()).toBe(false);
    });

    it('closes when whitespace ends the trigger', () => {
      typed(':sm');
      typed(':sm ');
      expect(actor.isVisible()).toBe(false);
      expect(actor.getActiveSpan()).toBeNull();
    });

    it('stays shut below minQueryLength', () => {
      typed(':s');
      expect(actor.isVisible()).toBe(false);
    });

    it('reopens on backspace back into a matching query', () => {
      typed(':smx');
      setComposer(':sm');
      fireInput('deleteContentBackward');
      expect(actor.isVisible()).toBe(true);
    });

    it('ignores input events from outside the composer', () => {
      const other = document.createElement('input');
      document.body.appendChild(other);
      setComposer(':sm');
      fireInput('insertText', other as unknown as HTMLElement);
      expect(actor.isVisible()).toBe(false);
    });
  });

  describe('silent input (paste / drop / unknown)', () => {
    it('does not open on paste even when the result looks like a trigger', () => {
      setComposer(':sm');
      fireInput('insertFromPaste');
      expect(actor.isVisible()).toBe(false);
    });

    it('requires a further keystroke after paste to open', () => {
      setComposer(':s');
      fireInput('insertFromPaste');
      setComposer(':sm');
      fireInput('insertText');
      expect(actor.isVisible()).toBe(true);
    });

    it('cancels a live span that paste invalidated', () => {
      typed(':sm');
      expect(actor.isVisible()).toBe(true);

      setComposer(':smile extra words');
      fireInput('insertFromPaste');
      expect(actor.isVisible()).toBe(false);
      expect(actor.getActiveSpan()).toBeNull();
    });

    it('treats an event with no inputType as silent', () => {
      setComposer(':sm');
      fireInput(null);
      expect(actor.isVisible()).toBe(false);
    });

    it('leaves a still-valid span alone', () => {
      typed(':sm');
      // A silent event that does not change the span (e.g. sanitize pass).
      fireInput('insertReplacementText');
      expect(actor.isVisible()).toBe(true);
    });
  });

  describe('IME composition', () => {
    it('cancels on compositionstart and idles until compositionend', () => {
      typed(':sm');
      expect(actor.isVisible()).toBe(true);

      composerRoot.dispatchEvent(new Event('compositionstart', { bubbles: true }));
      expect(actor.isVisible()).toBe(false);
      expect(controller.isComposing()).toBe(true);

      // Keyed input during composition is ignored entirely.
      setComposer(':sm');
      fireInput('insertText');
      expect(actor.isVisible()).toBe(false);

      composerRoot.dispatchEvent(new Event('compositionend', { bubbles: true }));
      expect(controller.isComposing()).toBe(false);

      // Composition committed nothing trigger-like; the NEXT keystroke opens.
      typed(':sm');
      expect(actor.isVisible()).toBe(true);
    });

    it('ignores composition events from outside the composer', () => {
      typed(':sm');
      const other = document.createElement('div');
      document.body.appendChild(other);
      other.dispatchEvent(new Event('compositionstart', { bubbles: true }));
      expect(actor.isVisible()).toBe(true);
      expect(controller.isComposing()).toBe(false);
    });
  });

  describe('caret movement', () => {
    it('cancels when the caret leaves the span', () => {
      typed(':sm');
      state.caret = 1; // arrow-left twice
      document.dispatchEvent(new Event('selectionchange'));
      expect(actor.isVisible()).toBe(false);
      expect(actor.getActiveSpan()).toBeNull();
    });

    it('keeps the overlay when the caret is still at the span end', () => {
      typed(':sm');
      document.dispatchEvent(new Event('selectionchange'));
      expect(actor.isVisible()).toBe(true);
    });
  });

  describe('focus', () => {
    it('cancels when focus lands outside composer and overlay', () => {
      typed(':sm');
      const other = document.createElement('input');
      document.body.appendChild(other);
      other.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      expect(actor.isVisible()).toBe(false);
    });

    it('does not cancel for focus within the composer', () => {
      typed(':sm');
      composerRoot.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      expect(actor.isVisible()).toBe(true);
    });

    it('does not cancel for focus within the overlay', () => {
      typed(':sm');
      overlayElement.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      expect(actor.isVisible()).toBe(true);
    });
  });

  describe('lifecycle', () => {
    it('detach stops all handling', () => {
      controller.detach();
      typed(':sm');
      expect(actor.isVisible()).toBe(false);
    });

    it('attach is idempotent (no duplicate registrations)', () => {
      // DOM dedupe would mask a missing guard for identical handlers, so pin
      // the guard itself: no addEventListener churn on a re-attach.
      const spy = vi.spyOn(document, 'addEventListener');
      controller.attach(); // already attached in beforeEach
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('a controller with no providers ignores composer input entirely', () => {
      const bareActor = new ComposerAutocompleteActor(
        manager, document.createElement('div'), createMockVSCode(), host
      );
      const cancelSpy = vi.spyOn(bareActor, 'cancel');
      const bareController = new TriggerDetectionController(bareActor, host, composerRoot);
      bareController.attach();

      typed(':sm');
      expect(cancelSpy).not.toHaveBeenCalled();
      expect(bareActor.isVisible()).toBe(false);

      bareController.detach();
      bareActor.destroy();
    });
  });
});
