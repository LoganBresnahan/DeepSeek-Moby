/**
 * Tests for keyboard arbitration (slice 3)
 *
 * The seam under test: the overlay's document-level CAPTURE keydown listener
 * must beat InputAreaShadowActor's bubble-phase Enter-to-send delegate while
 * the overlay is open, and must not exist at all while it is closed. These
 * tests run against the REAL InputAreaShadowActor — a fake composer here
 * would make the ordering claim vacuous.
 *
 * Keydown events are dispatched on the actual textarea inside the input
 * area's shadow root with { bubbles: true, composed: true }, the flags real
 * keyboard events carry.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ComposerAutocompleteActor } from '../../../media/actors/composer-autocomplete/ComposerAutocompleteActor';
import { createComposerHost } from '../../../media/actors/composer-autocomplete/composerHost';
import type { SuggestionProvider } from '../../../media/actors/composer-autocomplete/types';
import { InputAreaShadowActor } from '../../../media/actors/input-area/InputAreaShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';

const createMockVSCode = () => ({ postMessage: vi.fn() });

const emojiProvider: SuggestionProvider = {
  trigger: ':',
  minQueryLength: 2,
  getSuggestions: (query) =>
    'smile'.startsWith(query) ? [{ label: 'smile', action: { kind: 'insertText' as const, text: '😄' } }] : []
};

const multiProvider: SuggestionProvider = {
  trigger: '/',
  minQueryLength: 0,
  getSuggestions: () => [
    { label: 'one', action: { kind: 'runCommand' as const, id: 'moby.one' } },
    { label: 'two', action: { kind: 'runCommand' as const, id: 'moby.two' } },
    { label: 'three', action: { kind: 'runCommand' as const, id: 'moby.three' } }
  ]
};

describe('keydown arbitration', () => {
  let manager: EventStateManager;
  let inputAreaElement: HTMLElement;
  let overlayElement: HTMLElement;
  let inputArea: InputAreaShadowActor;
  let overlay: ComposerAutocompleteActor;
  let onSend: ReturnType<typeof vi.fn>;
  let textarea: HTMLTextAreaElement;

  const key = (init: KeyboardEventInit & { key: string }) =>
    new KeyboardEvent('keydown', { bubbles: true, composed: true, cancelable: true, ...init });

  /** Put text in the composer the way a user would leave it. */
  const setComposerText = (text: string) => {
    textarea.value = text;
    textarea.setSelectionRange(text.length, text.length);
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  };

  beforeEach(() => {
    manager = new EventStateManager({ batchBroadcasts: false });
    inputAreaElement = document.createElement('div');
    overlayElement = document.createElement('div');
    document.body.appendChild(inputAreaElement);
    document.body.appendChild(overlayElement);

    const vscode = createMockVSCode();
    inputArea = new InputAreaShadowActor(manager, inputAreaElement, vscode);
    onSend = vi.fn();
    inputArea.onSend(onSend);

    const host = createComposerHost(inputArea, vi.fn());
    overlay = new ComposerAutocompleteActor(manager, overlayElement, vscode, host);
    overlay.registerProvider(emojiProvider);
    overlay.registerProvider(multiProvider);

    textarea = inputAreaElement.shadowRoot!.querySelector('textarea')!;
  });

  afterEach(() => {
    overlay?.destroy();
    inputArea?.destroy();
    document.body.innerHTML = '';
  });

  describe('overlay closed — byte-for-byte composer behaviour', () => {
    it('plain Enter sends', () => {
      setComposerText('hello world');
      textarea.dispatchEvent(key({ key: 'Enter' }));
      expect(onSend).toHaveBeenCalledWith('hello world', undefined);
    });

    it('arrow keys are untouched', () => {
      setComposerText('hello');
      const e = key({ key: 'ArrowUp' });
      textarea.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
    });

    it('Escape is untouched', () => {
      setComposerText('hello');
      const e = key({ key: 'Escape' });
      textarea.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
    });
  });

  describe('overlay open — the overlay wins its keys', () => {
    beforeEach(() => {
      setComposerText(':sm');
      overlay.openFor({ trigger: ':', query: 'sm', start: 0, end: 3 });
      expect(overlay.isVisible()).toBe(true);
    });

    it('Enter accepts instead of sending', () => {
      textarea.dispatchEvent(key({ key: 'Enter' }));

      expect(onSend).not.toHaveBeenCalled();
      expect(inputArea.getValue()).toBe('😄');
      expect(overlay.isVisible()).toBe(false);
    });

    it('Tab accepts and is consumed', () => {
      const e = key({ key: 'Tab' });
      textarea.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(true);
      expect(inputArea.getValue()).toBe('😄');
    });

    it('Shift+Enter passes through to the composer', () => {
      const e = key({ key: 'Enter', shiftKey: true });
      textarea.dispatchEvent(e);

      expect(e.defaultPrevented).toBe(false);
      expect(onSend).not.toHaveBeenCalled(); // input area ignores Shift+Enter too
      expect(overlay.isVisible()).toBe(true);
    });

    it('Escape dismisses without sending or clearing the input', () => {
      textarea.dispatchEvent(key({ key: 'Escape' }));

      expect(overlay.isVisible()).toBe(false);
      expect(onSend).not.toHaveBeenCalled();
      expect(inputArea.getValue()).toBe(':sm');
    });

    it('a composition keydown passes through the overlay untouched', () => {
      const e = key({ key: 'Enter' });
      // happy-dom's KeyboardEvent constructor drops `isComposing`; shadow it
      // on the instance so the event still travels the real dispatch path.
      Object.defineProperty(e, 'isComposing', { value: true });
      textarea.dispatchEvent(e);

      // The overlay must not accept: no emoji replacement, overlay unmoved
      // by the key itself.
      expect(inputArea.getValue()).not.toBe('😄');
      // Proof the overlay did NOT consume the event: it reached the input
      // area's own Enter handler, which (with no composition guard of its
      // own — pre-existing behaviour, not this feature's) sent the draft.
      expect(onSend).toHaveBeenCalledWith(':sm', undefined);
    });

    it('plain typing keys are never consumed', () => {
      const e = key({ key: 'x' });
      textarea.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
    });
  });

  describe('selection keys', () => {
    beforeEach(() => {
      setComposerText('/');
      overlay.openFor({ trigger: '/', query: '', start: 0, end: 1 });
    });

    it('ArrowDown/ArrowUp move the highlight and are consumed', () => {
      const down = key({ key: 'ArrowDown' });
      textarea.dispatchEvent(down);
      expect(down.defaultPrevented).toBe(true);
      expect(overlay.getSelectedIndex()).toBe(1);

      const up = key({ key: 'ArrowUp' });
      textarea.dispatchEvent(up);
      expect(up.defaultPrevented).toBe(true);
      expect(overlay.getSelectedIndex()).toBe(0);
    });
  });

  describe('the listener lifecycle', () => {
    it('after closing, keys reach the composer again', () => {
      setComposerText(':sm');
      overlay.openFor({ trigger: ':', query: 'sm', start: 0, end: 3 });
      overlay.cancel();

      setComposerText('hello');
      textarea.dispatchEvent(key({ key: 'Enter' }));
      expect(onSend).toHaveBeenCalledWith('hello', undefined);
    });

    it('destroy removes the listener even when visible', () => {
      setComposerText(':sm');
      overlay.openFor({ trigger: ':', query: 'sm', start: 0, end: 3 });
      overlay.destroy();

      setComposerText('hello');
      textarea.dispatchEvent(key({ key: 'Enter' }));
      expect(onSend).toHaveBeenCalledWith('hello', undefined);
    });
  });

  describe('dismissal vs. the draft lifecycle (adversarial-verify regressions)', () => {
    it('sending the draft clears the dismissal — a new draft-initial trigger opens', () => {
      // The refuted sequence: /one → Esc → Enter (send) → /two suppressed forever.
      setComposerText('/one');
      overlay.openFor({ trigger: '/', query: 'one', start: 0, end: 4 });
      textarea.dispatchEvent(key({ key: 'Escape' }));
      expect(overlay.isVisible()).toBe(false);

      textarea.dispatchEvent(key({ key: 'Enter' }));
      expect(onSend).toHaveBeenCalledWith('/one', undefined); // sent; input.value '' published

      setComposerText('/two');
      expect(overlay.openFor({ trigger: '/', query: 'two', start: 0, end: 4 })).toBe(true);
      expect(overlay.isVisible()).toBe(true);
    });

    it('a different trigger char at the same offset is not suppressed', () => {
      setComposerText(':sm');
      overlay.openFor({ trigger: ':', query: 'sm', start: 0, end: 3 });
      textarea.dispatchEvent(key({ key: 'Escape' }));

      // Select-all-replace: now a slash command starts at the same offset.
      setComposerText('/on');
      expect(overlay.openFor({ trigger: '/', query: 'on', start: 0, end: 3 })).toBe(true);
    });

    it('a programmatic draft replacement cancels a live span', () => {
      setComposerText(':sm');
      overlay.openFor({ trigger: ':', query: 'sm', start: 0, end: 3 });
      expect(overlay.isVisible()).toBe(true);

      // Same length, same caret — the caret-equality backstop alone misses this.
      inputArea.setValue('abc');

      expect(overlay.isVisible()).toBe(false);
      expect(overlay.getActiveSpan()).toBeNull();
    });
  });

  describe('Escape dismissal memory', () => {
    it('suppresses reopening at the same span start', () => {
      setComposerText(':sm');
      overlay.openFor({ trigger: ':', query: 'sm', start: 0, end: 3 });
      textarea.dispatchEvent(key({ key: 'Escape' }));
      expect(overlay.isVisible()).toBe(false);

      // User keeps typing the same trigger — detection re-offers the span.
      expect(overlay.openFor({ trigger: ':', query: 'smi', start: 0, end: 4 })).toBe(false);
      expect(overlay.isVisible()).toBe(false);
    });

    it('a trigger at a new offset clears the dismissal', () => {
      setComposerText(':sm');
      overlay.openFor({ trigger: ':', query: 'sm', start: 0, end: 3 });
      textarea.dispatchEvent(key({ key: 'Escape' }));

      expect(overlay.openFor({ trigger: ':', query: 'sm', start: 7, end: 10 })).toBe(true);
      expect(overlay.isVisible()).toBe(true);
    });

    it('an accept clears the dismissal', () => {
      setComposerText(':sm');
      overlay.openFor({ trigger: ':', query: 'sm', start: 0, end: 3 });
      textarea.dispatchEvent(key({ key: 'Escape' }));

      overlay.openFor({ trigger: ':', query: 'sm', start: 7, end: 10 });
      overlay.acceptSelected();

      // Same offset as the old dismissal — must open normally now.
      expect(overlay.openFor({ trigger: ':', query: 'sm', start: 0, end: 3 })).toBe(true);
    });
  });
});
