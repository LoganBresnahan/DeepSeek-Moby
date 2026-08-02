/**
 * InputAreaShadowActor — drag-and-drop attach (image-describe Phase 1b).
 *
 * Playwright/happy-dom can synthesize a DataTransfer, so the handler, the
 * branch, the highlight counter and the navigation guard are all testable.
 * What no test can cross is the real OS → webview boundary, or what the VS
 * Code Explorer actually puts on a drag — those are dev-host only.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InputAreaShadowActor } from '../../../media/actors/input-area/InputAreaShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { ShadowActor } from '../../../media/state/ShadowActor';

/** Minimal DataTransfer stand-in — happy-dom does not construct drag events for us. */
function makeDataTransfer(opts: { files?: File[]; uriList?: string }): any {
  return {
    files: opts.files ?? [],
    dropEffect: '',
    getData: (type: string) => (type === 'text/uri-list' ? opts.uriList ?? '' : '')
  };
}

function makeFile(name: string, type: string, body = 'contents'): File {
  return new File([body], name, { type });
}

describe('InputAreaShadowActor — drag and drop', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: InputAreaShadowActor;
  let mockVscode: { postMessage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    manager = new EventStateManager({ batchBroadcasts: false });
    element = document.createElement('div');
    document.body.appendChild(element);
    mockVscode = { postMessage: vi.fn() };
    ShadowActor.resetInstanceCount();
    actor = new InputAreaShadowActor(manager, element, mockVscode);
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const asAny = () => actor as any;
  const zone = () => element.shadowRoot!.querySelector('.input-area') as HTMLElement;

  function fireDrag(type: string, dataTransfer?: any, target: EventTarget = zone()): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer ?? makeDataTransfer({}) });
    target.dispatchEvent(event);
    return event;
  }

  // ── Routing ──

  it('routes dropped files through the shared ingest path', () => {
    const ingest = vi.spyOn(asAny(), 'ingestFiles');
    const files = [makeFile('a.ts', 'text/plain')];

    asAny().handleDrop(makeDataTransfer({ files }));

    expect(ingest).toHaveBeenCalledWith(files);
  });

  it('sends a dropped image through the downscale branch, not the text branch', async () => {
    const downscale = vi.spyOn(asAny(), 'downscaleImage')
      .mockResolvedValue({ dataUrl: 'data:image/webp;base64,AA', bytes: 100 });

    asAny().handleDrop(makeDataTransfer({ files: [makeFile('shot.png', 'image/png')] }));
    await vi.waitFor(() => expect(actor.getState().attachments).toHaveLength(1));

    expect(downscale).toHaveBeenCalled();
    expect(actor.getState().attachments[0].type).toBe('image');
  });

  it('splits a mixed drop correctly', async () => {
    vi.spyOn(asAny(), 'downscaleImage').mockResolvedValue({ dataUrl: 'data:image/webp;base64,AA', bytes: 100 });

    asAny().handleDrop(makeDataTransfer({
      files: [makeFile('shot.png', 'image/png'), makeFile('notes.md', 'text/markdown')]
    }));
    await vi.waitFor(() => expect(actor.getState().attachments).toHaveLength(2));

    const types = actor.getState().attachments.map(a => a.type).sort();
    expect(types).toEqual(['file', 'image']);
  });

  it('ignores an empty drop', () => {
    asAny().handleDrop(makeDataTransfer({}));
    expect(actor.getState().attachments).toHaveLength(0);
    expect(mockVscode.postMessage).not.toHaveBeenCalled();
  });

  it('tolerates a null dataTransfer', () => {
    expect(() => asAny().handleDrop(null)).not.toThrow();
  });

  // ── uri-list (VS Code-internal drags) ──

  it('asks the extension to read a uri-list drop (webview cannot read disk)', () => {
    asAny().handleDrop(makeDataTransfer({ uriList: 'file:///repo/src/a.ts' }));

    expect(mockVscode.postMessage).toHaveBeenCalledWith({
      type: 'requestDroppedFiles',
      uris: ['file:///repo/src/a.ts']
    });
  });

  it('parses a multi-line uri-list and drops comments', () => {
    expect(asAny().parseUriList('# comment\r\nfile:///a.ts\r\nfile:///b.ts\r\n')).toEqual([
      'file:///a.ts',
      'file:///b.ts'
    ]);
    expect(asAny().parseUriList('')).toEqual([]);
  });

  it('prefers real files over the uri-list when a drop carries both', () => {
    const files = [makeFile('a.ts', 'text/plain')];
    asAny().handleDrop(makeDataTransfer({ files, uriList: 'file:///repo/a.ts' }));

    expect(mockVscode.postMessage).not.toHaveBeenCalled();
  });

  it('attaches text content returned by the extension', () => {
    actor.handleDroppedFileContents([{ name: 'a.ts', content: 'const x = 1;' }]);

    const [attachment] = actor.getState().attachments;
    expect(attachment.type).toBe('file');
    expect(attachment.content).toBe('const x = 1;');
    expect(attachment.name).toBe('a.ts');
  });

  it('downscales image content returned by the extension', async () => {
    const downscale = vi.spyOn(asAny(), 'downscaleFromUrl')
      .mockResolvedValue({ dataUrl: 'data:image/webp;base64,SMALL', bytes: 50 });

    actor.handleDroppedFileContents([
      { name: 'icon.png', content: 'data:image/png;base64,BIG', isImage: true, mimeType: 'image/png' }
    ]);
    await vi.waitFor(() => expect(actor.getState().attachments).toHaveLength(1));

    expect(downscale).toHaveBeenCalledWith('data:image/png;base64,BIG');
    // Stored as the downscaled WebP, never the original bytes.
    expect(actor.getState().attachments[0].content).toBe('data:image/webp;base64,SMALL');
    expect(actor.getState().attachments[0].mimeType).toBe('image/webp');
  });

  it('rejects an extension-read image that is still too large', async () => {
    vi.spyOn(asAny(), 'downscaleFromUrl').mockResolvedValue({ dataUrl: 'data:image/webp;base64,X', bytes: 9e6 });

    actor.handleDroppedFileContents([{ name: 'huge.png', content: 'data:image/png;base64,X', isImage: true }]);
    await vi.waitFor(() =>
      expect(mockVscode.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'showError', message: expect.stringContaining('huge.png') })
      )
    );
    expect(actor.getState().attachments).toHaveLength(0);
  });

  // ── Highlight (depth counter) ──

  it('highlights the input box on drag enter', () => {
    fireDrag('dragenter');
    expect(zone().classList.contains('dragging')).toBe(true);
  });

  it('keeps the highlight when the pointer crosses a child element', () => {
    const textarea = element.shadowRoot!.querySelector('textarea')!;

    fireDrag('dragenter');                 // enter the box
    fireDrag('dragenter', undefined, textarea); // enter a child — depth 2
    fireDrag('dragleave', undefined, textarea); // leave the child — depth 1

    expect(zone().classList.contains('dragging')).toBe(true);
  });

  it('clears the highlight only when the last leave fires', () => {
    fireDrag('dragenter');
    fireDrag('dragleave');
    expect(zone().classList.contains('dragging')).toBe(false);
  });

  it('clears the highlight on drop', () => {
    fireDrag('dragenter');
    fireDrag('drop', makeDataTransfer({}));
    expect(zone().classList.contains('dragging')).toBe(false);
  });

  it('never lets the depth counter go negative', () => {
    fireDrag('dragleave');
    fireDrag('dragleave');
    fireDrag('dragenter');
    expect(zone().classList.contains('dragging')).toBe(true);
  });

  // ── Navigation guard ──

  it('preventDefaults a drop outside the input box so the frame cannot navigate away', () => {
    const outside = document.createElement('div');
    document.body.appendChild(outside);

    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: makeDataTransfer({ files: [makeFile('x.ts', 'text/plain')] }) });
    outside.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    // Guard swallows only — it must not attach.
    expect(actor.getState().attachments).toHaveLength(0);
  });

  it('preventDefaults dragover outside the input box', () => {
    const event = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: makeDataTransfer({}) });
    document.body.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('removes the document-level guards on destroy', () => {
    actor.destroy();

    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: makeDataTransfer({}) });
    document.body.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });
});
