/**
 * Context-file chips in the composer (dev-host bug, 2026-08-05)
 *
 * `@`-accept posts `getFileContent`, FilesShadowActor stores the reply and
 * tells the extension — but nothing rendered a chip, so a successful attach
 * looked exactly like nothing happening. These pin the visible half of the
 * round trip, both doors, plus the removal path back to the owner.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InputAreaShadowActor } from '../../../media/actors/input-area/InputAreaShadowActor';
import { FilesShadowActor } from '../../../media/actors/files/FilesShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';

describe('composer context-file chips', () => {
  let manager: EventStateManager;
  let inputAreaElement: HTMLElement;
  let filesElement: HTMLElement;
  let inputArea: InputAreaShadowActor;
  let files: FilesShadowActor;
  let vscode: { postMessage: ReturnType<typeof vi.fn> };

  const chipPaths = () =>
    Array.from(inputAreaElement.shadowRoot!.querySelectorAll('.file-chip'))
      .map(el => el.getAttribute('data-path'));

  const chipsHidden = () =>
    inputAreaElement.shadowRoot!
      .querySelector('.file-chips-container')!
      .classList.contains('hidden');

  /** The extension's reply to `getFileContent`. */
  const deliverFile = (path: string, content: string) => {
    manager.publishDirect('files.content', { path, content, _ts: Date.now() }, 'extension');
  };

  beforeEach(async () => {
    manager = new EventStateManager({ batchBroadcasts: false });
    inputAreaElement = document.createElement('div');
    filesElement = document.createElement('div');
    document.body.appendChild(inputAreaElement);
    document.body.appendChild(filesElement);
    vscode = { postMessage: vi.fn() };

    inputArea = new InputAreaShadowActor(manager, inputAreaElement, vscode);
    files = new FilesShadowActor(manager, filesElement, vscode);
    // Actors register on a microtask (EventStateActor:100), so nothing is
    // subscribed until the queue drains.
    await Promise.resolve();
  });

  afterEach(() => {
    files?.destroy();
    inputArea?.destroy();
    document.body.innerHTML = '';
  });

  it('starts with the chip row hidden', () => {
    expect(chipsHidden()).toBe(true);
    expect(chipPaths()).toEqual([]);
  });

  it('renders a chip when an attached file arrives', () => {
    deliverFile('src/actors/index.ts', 'export {};');

    expect(chipsHidden()).toBe(false);
    expect(chipPaths()).toEqual(['src/actors/index.ts']);
  });

  it('tells the extension the file is in context', () => {
    deliverFile('src/a.ts', 'a');

    expect(vscode.postMessage).toHaveBeenCalledWith({
      type: 'setSelectedFiles',
      files: [{ path: 'src/a.ts', content: 'a' }]
    });
  });

  it('accumulates chips across several attaches', () => {
    deliverFile('src/a.ts', 'a');
    deliverFile('src/b.ts', 'b');

    expect(chipPaths()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  describe('removing a chip', () => {
    beforeEach(() => {
      deliverFile('src/a.ts', 'a');
      deliverFile('src/b.ts', 'b');
      vscode.postMessage.mockClear();
    });

    it('drops the chip and tells the extension the reduced set', () => {
      const remove = inputAreaElement.shadowRoot!
        .querySelector('.file-chip[data-path="src/a.ts"] .file-chip-remove') as HTMLElement;
      remove.click();

      expect(chipPaths()).toEqual(['src/b.ts']);
      // The owning actor must have dropped it too, or the file stays in the
      // model's context while the UI says it left.
      expect(vscode.postMessage).toHaveBeenCalledWith({
        type: 'setSelectedFiles',
        files: [{ path: 'src/b.ts', content: 'b' }]
      });
    });

    it('hides the row again once the last chip goes', () => {
      const shadow = inputAreaElement.shadowRoot!;
      (shadow.querySelector('.file-chip[data-path="src/a.ts"] .file-chip-remove') as HTMLElement).click();
      (shadow.querySelector('.file-chip[data-path="src/b.ts"] .file-chip-remove') as HTMLElement).click();

      expect(chipPaths()).toEqual([]);
      expect(chipsHidden()).toBe(true);
    });
  });
});
