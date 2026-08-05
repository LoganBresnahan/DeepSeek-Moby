/**
 * End-to-end: type → detect → rank → arbitrate → accept (phase 3)
 *
 * Wires the real InputAreaShadowActor, the real detection controller and the
 * three real providers the way chat.ts does, then drives it with keyboard
 * events. This is the check that the slices compose — each one's own suite
 * tests it in isolation against a fake on at least one side.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ComposerAutocompleteActor } from '../../../media/actors/composer-autocomplete/ComposerAutocompleteActor';
import { TriggerDetectionController } from '../../../media/actors/composer-autocomplete/TriggerDetectionController';
import { createComposerHost } from '../../../media/actors/composer-autocomplete/composerHost';
import { CommandsProvider } from '../../../media/actors/composer-autocomplete/providers/commandsProvider';
import { EmojiProvider } from '../../../media/actors/composer-autocomplete/providers/emojiProvider';
import { FilesProvider } from '../../../media/actors/composer-autocomplete/providers/filesProvider';
import { InputAreaShadowActor } from '../../../media/actors/input-area/InputAreaShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';

describe('composer autocomplete end to end', () => {
  let manager: EventStateManager;
  let inputAreaElement: HTMLElement;
  let overlayElement: HTMLElement;
  let inputArea: InputAreaShadowActor;
  let overlay: ComposerAutocompleteActor;
  let controller: TriggerDetectionController;
  let filesProvider: FilesProvider;
  let textarea: HTMLTextAreaElement;
  let vscode: { postMessage: ReturnType<typeof vi.fn> };
  let onSend: ReturnType<typeof vi.fn>;
  let runCommand: ReturnType<typeof vi.fn>;
  let fileTimers: Array<() => void>;

  /**
   * Type `text` the way a keyboard would: value, caret, keyed input event.
   * `composed: true` is what native InputEvents carry and is what lets the
   * event escape the input area's shadow root to reach the controller.
   */
  const type = (text: string) => {
    textarea.value = text;
    textarea.setSelectionRange(text.length, text.length);
    textarea.dispatchEvent(new InputEvent('input', {
      bubbles: true, composed: true, inputType: 'insertText'
    }));
  };

  const press = (key: string) => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key, bubbles: true, composed: true, cancelable: true
    }));
  };

  const flushFileSearch = () => {
    const pending = [...fileTimers];
    fileTimers.length = 0;
    pending.forEach(fn => fn());
  };

  beforeEach(() => {
    manager = new EventStateManager({ batchBroadcasts: false });
    inputAreaElement = document.createElement('div');
    overlayElement = document.createElement('div');
    document.body.appendChild(inputAreaElement);
    document.body.appendChild(overlayElement);
    fileTimers = [];

    vscode = { postMessage: vi.fn() };
    inputArea = new InputAreaShadowActor(manager, inputAreaElement, vscode);
    onSend = vi.fn();
    inputArea.onSend(onSend);
    runCommand = vi.fn();

    const host = createComposerHost(inputArea, {
      attachFile: (path) => vscode.postMessage({ type: 'getFileContent', filePath: path }),
      runCommand
    });

    filesProvider = new FilesProvider({
      postMessage: (m) => vscode.postMessage(m),
      onResults: (query, suggestions) => overlay.updateSuggestions(query, suggestions),
      setTimeoutFn: (fn) => {
        fileTimers.push(fn);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: () => { fileTimers.length = 0; }
    });

    overlay = new ComposerAutocompleteActor(manager, overlayElement, vscode, host, {
      'files.searchResults': (value: unknown) => filesProvider.handleResults(value)
    });
    overlay.registerProvider(new EmojiProvider());
    overlay.registerProvider(new CommandsProvider());
    overlay.registerProvider(filesProvider);
    overlay.setTriggerElement(inputAreaElement);

    controller = new TriggerDetectionController(overlay, host, inputAreaElement, overlayElement);
    controller.attach();

    textarea = inputAreaElement.shadowRoot!.querySelector('textarea')!;
  });

  afterEach(() => {
    controller.detach();
    overlay?.destroy();
    inputArea?.destroy();
    document.body.innerHTML = '';
  });

  describe(': emoji', () => {
    it('types :smi, Enter, gets the emoji', () => {
      type(':smi');
      expect(overlay.isVisible()).toBe(true);
      expect(overlay.getSuggestions()[0].label).toBe(':smile:');

      press('Enter');

      expect(inputArea.getValue()).toBe('😄');
      expect(overlay.isVisible()).toBe(false);
      expect(onSend).not.toHaveBeenCalled();
    });

    it('completes mid-sentence without disturbing the rest', () => {
      type('nice work :smi');
      press('Enter');
      expect(inputArea.getValue()).toBe('nice work 😄');
    });

    it('arrow-down picks the second suggestion', () => {
      type(':sm');
      const second = overlay.getSuggestions()[1];
      press('ArrowDown');
      press('Enter');

      const inserted = second.action.kind === 'insertText' ? second.action.text : '';
      expect(inputArea.getValue()).toBe(inserted);
    });

    it('a closed shortcode lands without any keypress', () => {
      type(':smile:');
      expect(inputArea.getValue()).toBe('😄');
      expect(overlay.isVisible()).toBe(false);
    });

    it('stays out of the way inside code-ish text', () => {
      type('std::vec');
      expect(overlay.isVisible()).toBe(false);
      type('https://exa');
      expect(overlay.isVisible()).toBe(false);
    });
  });

  describe('/ commands', () => {
    it('types /exp, Enter, runs the command and clears the trigger', () => {
      type('/exp');
      expect(overlay.isVisible()).toBe(true);

      press('Enter');

      expect(runCommand).toHaveBeenCalledWith('moby.exportChatHistory');
      expect(inputArea.getValue()).toBe('');
      expect(onSend).not.toHaveBeenCalled();
    });

    it('a bare slash offers the whole catalog', () => {
      type('/');
      expect(overlay.isVisible()).toBe(true);
      expect(overlay.getSuggestions().length).toBeGreaterThan(3);
    });
  });

  describe('@ files', () => {
    it('searches after the debounce and attaches the picked file', () => {
      type('@ind');
      expect(overlay.isVisible()).toBe(false); // pending

      flushFileSearch();
      expect(vscode.postMessage).toHaveBeenCalledWith({ type: 'searchFiles', query: 'ind' });

      manager.publishDirect('files.searchResults', { results: ['src/actors/index.ts'] }, 'test');
      expect(overlay.isVisible()).toBe(true);
      expect(overlay.getSuggestions()[0].label).toBe('index.ts');

      press('Enter');

      expect(vscode.postMessage).toHaveBeenCalledWith({
        type: 'getFileContent',
        filePath: 'src/actors/index.ts'
      });
      expect(inputArea.getValue()).toBe('');
    });

    it('ignores results arriving for the files popup, not us', () => {
      type('hello');
      manager.publishDirect('files.searchResults', { results: ['src/other.ts'] }, 'test');
      expect(overlay.isVisible()).toBe(false);
    });

    it('drops a reply that lands after the trigger is gone', () => {
      type('@ind');
      flushFileSearch();
      type('@ind ');  // whitespace ends the trigger

      manager.publishDirect('files.searchResults', { results: ['src/actors/index.ts'] }, 'test');
      expect(overlay.isVisible()).toBe(false);
    });
  });

  describe('the composer is unharmed', () => {
    it('plain text still sends on Enter', () => {
      type('just a message');
      press('Enter');
      expect(onSend).toHaveBeenCalledWith('just a message', undefined);
    });

    it('Escape leaves the draft alone and lets the next Enter send it', () => {
      type(':smi');
      press('Escape');
      expect(overlay.isVisible()).toBe(false);
      expect(inputArea.getValue()).toBe(':smi');

      press('Enter');
      expect(onSend).toHaveBeenCalledWith(':smi', undefined);
    });

    it('an emoji accepted then a message sent works end to end', () => {
      type(':smi');
      press('Enter');
      type('😄 shipping');
      press('Enter');
      expect(onSend).toHaveBeenCalledWith('😄 shipping', undefined);
    });
  });
});
