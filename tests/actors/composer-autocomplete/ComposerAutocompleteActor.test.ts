/**
 * Tests for ComposerAutocompleteActor (slice 1 — actor shell)
 *
 * Covers the accept mechanics and the state machine the later slices drive:
 * - provider registry resolution + minQueryLength gating
 * - span replacement on accept, one dispatch per SuggestionAction kind
 * - selection movement with wrap-around
 * - async 'pending' + stale-reply discard
 * - cancel vs. hide-keeping-span (a late reply must not resurrect a dismissal)
 *
 * Trigger detection and keyboard arbitration are later slices and are not
 * exercised here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ComposerAutocompleteActor } from '../../../media/actors/composer-autocomplete/ComposerAutocompleteActor';
import { createComposerHost } from '../../../media/actors/composer-autocomplete/composerHost';
import type {
  ComposerHost,
  Suggestion,
  SuggestionProvider,
  TriggerSpan
} from '../../../media/actors/composer-autocomplete/types';
import { EventStateManager } from '../../../media/state/EventStateManager';

const createMockVSCode = () => ({ postMessage: vi.fn() });

/** In-memory composer standing in for the textarea. */
const createFakeHost = (initial = '') => {
  const state = { text: initial, caret: initial.length };
  const host: ComposerHost = {
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
  return { host, state };
};

const suggestion = (label: string, action: Suggestion['action']): Suggestion => ({ label, action });

const staticProvider = (
  trigger: SuggestionProvider['trigger'],
  suggestions: Suggestion[],
  minQueryLength = 0
): SuggestionProvider => ({
  trigger,
  minQueryLength,
  getSuggestions: () => suggestions
});

const span = (trigger: TriggerSpan['trigger'], query: string, start = 0): TriggerSpan => ({
  trigger,
  query,
  start,
  end: start + 1 + query.length
});

describe('ComposerAutocompleteActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: ComposerAutocompleteActor;
  let mockVSCode: ReturnType<typeof createMockVSCode>;
  let fake: ReturnType<typeof createFakeHost>;

  const build = (initialText = '') => {
    fake = createFakeHost(initialText);
    actor = new ComposerAutocompleteActor(manager, element, mockVSCode, fake.host);
    return actor;
  };

  beforeEach(() => {
    manager = new EventStateManager({ batchBroadcasts: false });
    element = document.createElement('div');
    document.body.appendChild(element);
    mockVSCode = createMockVSCode();
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
  });

  describe('provider registry', () => {
    it('stays shut for a trigger with no provider', () => {
      build();
      expect(actor.openFor(span(':', 'smile'))).toBe(false);
      expect(actor.isVisible()).toBe(false);
    });

    it('reports only triggers that have providers', () => {
      build();
      actor.registerProvider(staticProvider(':', []));
      actor.registerProvider(staticProvider('/', []));
      expect(actor.activeTriggers().sort()).toEqual(['/', ':']);
    });

    it('honours minQueryLength', () => {
      build();
      actor.registerProvider(
        staticProvider(':', [suggestion('smile', { kind: 'insertText', text: '😄' })], 2)
      );

      expect(actor.openFor(span(':', 's'))).toBe(false);
      expect(actor.isVisible()).toBe(false);

      expect(actor.openFor(span(':', 'sm'))).toBe(true);
      expect(actor.isVisible()).toBe(true);
    });

    it('never shows an empty box', () => {
      build();
      actor.registerProvider(staticProvider('/', []));
      expect(actor.openFor(span('/', 'nope'))).toBe(false);
      expect(actor.isVisible()).toBe(false);
    });
  });

  describe('accept mechanics', () => {
    it('replaces the trigger span with inserted text', () => {
      build('hello :sm');
      actor.registerProvider(staticProvider(':', [suggestion('smile', { kind: 'insertText', text: '😄' })]));

      actor.openFor(span(':', 'sm', 6));
      expect(actor.acceptSelected()).toBe(true);

      expect(fake.state.text).toBe('hello 😄');
      expect(fake.state.caret).toBe('hello 😄'.length);
    });

    it('deletes the span and runs the command through the host', () => {
      build('/exp');
      actor.registerProvider(staticProvider('/', [suggestion('Export Logs', { kind: 'runCommand', id: 'moby.exportLogs' })]));

      actor.openFor(span('/', 'exp'));
      expect(actor.acceptSelected()).toBe(true);

      expect(fake.state.text).toBe('');
      // Routed through the host, not posted directly: several commands open
      // webview-local modals instead of reaching the extension.
      expect(fake.host.runCommand).toHaveBeenCalledWith('moby.exportLogs');
      expect(mockVSCode.postMessage).not.toHaveBeenCalled();
    });

    it('deletes the span and routes the path for attachFile', () => {
      build('see @src');
      actor.registerProvider(staticProvider('@', [suggestion('src/index.ts', { kind: 'attachFile', path: 'src/index.ts' })]));

      actor.openFor(span('@', 'src', 4));
      expect(actor.acceptSelected()).toBe(true);

      expect(fake.state.text).toBe('see ');
      expect(fake.host.attachFile).toHaveBeenCalledWith('src/index.ts');
    });

    it('closes and clears the span after accepting', () => {
      build(':sm');
      actor.registerProvider(staticProvider(':', [suggestion('smile', { kind: 'insertText', text: '😄' })]));

      actor.openFor(span(':', 'sm'));
      actor.acceptSelected();

      expect(actor.isVisible()).toBe(false);
      expect(actor.getActiveSpan()).toBeNull();
      expect(actor.getSuggestions()).toEqual([]);
    });

    it('refuses to accept while closed, so the key falls through to the composer', () => {
      build('plain text');
      actor.registerProvider(staticProvider(':', [suggestion('smile', { kind: 'insertText', text: '😄' })]));

      expect(actor.acceptSelected()).toBe(false);
      expect(fake.state.text).toBe('plain text');
      expect(mockVSCode.postMessage).not.toHaveBeenCalled();
    });

    it('accepts the clicked suggestion, not the highlighted one', () => {
      build(':a');
      actor.registerProvider(staticProvider(':', [
        suggestion('first', { kind: 'insertText', text: 'A' }),
        suggestion('second', { kind: 'insertText', text: 'B' })
      ]));

      actor.openFor(span(':', 'a'));
      const second = element.shadowRoot?.querySelector('[data-suggestion-index="1"]') as HTMLElement;
      second.click();

      expect(fake.state.text).toBe('B');
    });
  });

  describe('selection movement', () => {
    beforeEach(() => {
      build(':a');
      actor.registerProvider(staticProvider(':', [
        suggestion('one', { kind: 'insertText', text: '1' }),
        suggestion('two', { kind: 'insertText', text: '2' }),
        suggestion('three', { kind: 'insertText', text: '3' })
      ]));
      actor.openFor(span(':', 'a'));
    });

    it('starts at the first suggestion', () => {
      expect(actor.getSelectedIndex()).toBe(0);
    });

    it('moves down and up', () => {
      expect(actor.moveSelection(1)).toBe(true);
      expect(actor.getSelectedIndex()).toBe(1);
      expect(actor.moveSelection(-1)).toBe(true);
      expect(actor.getSelectedIndex()).toBe(0);
    });

    it('wraps at both ends', () => {
      actor.moveSelection(-1);
      expect(actor.getSelectedIndex()).toBe(2);
      actor.moveSelection(1);
      expect(actor.getSelectedIndex()).toBe(0);
    });

    it('reports false when closed', () => {
      actor.cancel();
      expect(actor.moveSelection(1)).toBe(false);
    });

    it('resets the highlight when the query changes', () => {
      actor.moveSelection(1);
      actor.openFor(span(':', 'ab'));
      expect(actor.getSelectedIndex()).toBe(0);
    });
  });

  describe('async providers', () => {
    const pendingProvider = (trigger: SuggestionProvider['trigger']): SuggestionProvider => ({
      trigger,
      minQueryLength: 0,
      getSuggestions: () => 'pending'
    });

    it('stays hidden while pending, then opens when results land', () => {
      build('@sr');
      actor.registerProvider(pendingProvider('@'));

      expect(actor.openFor(span('@', 'sr'))).toBe(false);
      expect(actor.isVisible()).toBe(false);

      const accepted = actor.updateSuggestions('sr', [
        suggestion('src/index.ts', { kind: 'attachFile', path: 'src/index.ts' })
      ]);

      expect(accepted).toBe(true);
      expect(actor.isVisible()).toBe(true);
    });

    it('discards a reply for a query that has moved on', () => {
      build('@srx');
      actor.registerProvider(pendingProvider('@'));
      actor.openFor(span('@', 'srx'));

      const accepted = actor.updateSuggestions('sr', [
        suggestion('stale.ts', { kind: 'attachFile', path: 'stale.ts' })
      ]);

      expect(accepted).toBe(false);
      expect(actor.isVisible()).toBe(false);
      expect(actor.getSuggestions()).toEqual([]);
    });

    it('does not resurrect a cancelled trigger', () => {
      build('@sr');
      actor.registerProvider(pendingProvider('@'));
      actor.openFor(span('@', 'sr'));
      actor.cancel();

      expect(actor.updateSuggestions('sr', [
        suggestion('src/index.ts', { kind: 'attachFile', path: 'src/index.ts' })
      ])).toBe(false);
      expect(actor.isVisible()).toBe(false);
    });

    it('rejects a reply whose span text is no longer in the composer', () => {
      build('@sr');
      actor.registerProvider(pendingProvider('@'));
      actor.openFor(span('@', 'sr'));

      // Draft cleared (e.g. sent) between request and reply.
      fake.state.text = '';
      fake.state.caret = 0;

      expect(actor.updateSuggestions('sr', [
        suggestion('src/index.ts', { kind: 'attachFile', path: 'src/index.ts' })
      ])).toBe(false);
      expect(actor.isVisible()).toBe(false);
      expect(actor.getActiveSpan()).toBeNull();
    });

    it('hides but keeps the trigger live when results go empty', () => {
      build('@sr');
      actor.registerProvider(pendingProvider('@'));
      actor.openFor(span('@', 'sr'));
      actor.updateSuggestions('sr', [suggestion('a.ts', { kind: 'attachFile', path: 'a.ts' })]);
      expect(actor.isVisible()).toBe(true);

      actor.updateSuggestions('sr', []);
      expect(actor.isVisible()).toBe(false);
      expect(actor.getActiveSpan()).not.toBeNull();

      actor.updateSuggestions('sr', [suggestion('b.ts', { kind: 'attachFile', path: 'b.ts' })]);
      expect(actor.isVisible()).toBe(true);
    });
  });

  describe('pub/sub', () => {
    it('publishes visibility', () => {
      build(':a');
      actor.registerProvider(staticProvider(':', [suggestion('one', { kind: 'insertText', text: '1' })]));

      actor.openFor(span(':', 'a'));
      expect(manager.getState('composer.autocomplete.visible')).toBe(true);

      actor.cancel();
      expect(manager.getState('composer.autocomplete.visible')).toBe(false);
    });

    it('ignores a stray open request with nothing to show', () => {
      build();
      manager.publishDirect('composer.autocomplete.open', true, 'test');
      expect(actor.isVisible()).toBe(false);
    });
  });
});

describe('createComposerHost', () => {
  it('forwards text operations and injects the side effects', () => {
    const surface = {
      getValue: vi.fn(() => 'hi @sr'),
      getCaret: vi.fn(() => 6),
      replaceRange: vi.fn(),
      focus: vi.fn()
    };
    const effects = { attachFile: vi.fn(), runCommand: vi.fn() };
    const host = createComposerHost(surface, effects);

    expect(host.getText()).toBe('hi @sr');
    expect(host.getCaret()).toBe(6);

    host.replaceRange(3, 6, '');
    expect(surface.replaceRange).toHaveBeenCalledWith(3, 6, '');

    host.attachFile('src/a.ts');
    expect(effects.attachFile).toHaveBeenCalledWith('src/a.ts');

    host.runCommand('moby.exportLogs');
    expect(effects.runCommand).toHaveBeenCalledWith('moby.exportLogs');

    host.focus();
    expect(surface.focus).toHaveBeenCalled();
  });
});
