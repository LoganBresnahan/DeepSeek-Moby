/**
 * InputAreaShadowActor — image capture (image-describe Phase 1).
 *
 * The accept-list now admits images, so the branch that decides "is this an
 * image?" is the thing standing between a PNG and the text FileReader path.
 * If an image ever took the text branch it would reach the model as mojibake
 * inside a code fence, so these tests pin the routing, the failure handling,
 * and the chip rendering rather than the canvas math (happy-dom has no real
 * canvas encoder — that part is dev-host territory).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InputAreaShadowActor } from '../../../media/actors/input-area/InputAreaShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { ShadowActor } from '../../../media/state/ShadowActor';

describe('InputAreaShadowActor — image attachments', () => {
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

  // ── Detection ──

  it('detects images by MIME type', () => {
    expect(asAny().isImage({ name: 'whatever', type: 'image/png' })).toBe(true);
    expect(asAny().isImage({ name: 'x.ts', type: 'text/plain' })).toBe(false);
  });

  it('detects images by extension when MIME is missing', () => {
    for (const name of ['shot.PNG', 'a.jpg', 'b.jpeg', 'c.webp', 'd.gif', 'e.bmp']) {
      expect(asAny().isImage({ name, type: '' })).toBe(true);
    }
  });

  it('does not mistake a source file for an image', () => {
    for (const name of ['index.ts', 'notes.md', 'gif.txt', 'image.json']) {
      expect(asAny().isImage({ name, type: '' })).toBe(false);
    }
  });

  it('accepts image extensions on the file input', () => {
    const input = element.shadowRoot?.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toContain('.png');
    expect(input.accept).toContain('.webp');
    // Text types must survive alongside them.
    expect(input.accept).toContain('.ts');
  });

  // ── Attach path ──

  it('attaches a downscaled image with type "image"', async () => {
    vi.spyOn(asAny(), 'downscaleImage').mockResolvedValue({
      dataUrl: 'data:image/webp;base64,AAAA',
      bytes: 2048
    });

    await asAny().attachImage({ name: 'screenshot.png', size: 999_999, type: 'image/png' });

    const [attachment] = actor.getState().attachments;
    expect(attachment.type).toBe('image');
    expect(attachment.mimeType).toBe('image/webp');
    expect(attachment.content).toBe('data:image/webp;base64,AAAA');
    // Size reports the encoded payload, not the original file size.
    expect(attachment.size).toBe(2048);
  });

  it('rejects an image that is still too large after downscaling', async () => {
    vi.spyOn(asAny(), 'downscaleImage').mockResolvedValue({
      dataUrl: 'data:image/webp;base64,AAAA',
      bytes: 5 * 1024 * 1024
    });

    await asAny().attachImage({ name: 'huge.png', size: 20_000_000, type: 'image/png' });

    expect(actor.getState().attachments).toHaveLength(0);
    expect(mockVscode.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'showError', message: expect.stringContaining('huge.png') })
    );
  });

  it('surfaces a decode failure instead of attaching a broken image', async () => {
    vi.spyOn(asAny(), 'downscaleImage').mockRejectedValue(new Error('not a decodable image'));

    await asAny().attachImage({ name: 'corrupt.png', size: 10, type: 'image/png' });

    expect(actor.getState().attachments).toHaveLength(0);
    expect(mockVscode.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'showError', message: expect.stringContaining('corrupt.png') })
    );
  });

  it('publishes attachment state so the toolbar send-gate sees it', async () => {
    vi.spyOn(asAny(), 'downscaleImage').mockResolvedValue({ dataUrl: 'data:image/webp;base64,AA', bytes: 10 });

    await asAny().attachImage({ name: 'a.png', size: 10, type: 'image/png' });

    const published = manager.getState('input.attachments') as Array<{ name: string }>;
    expect(published).toHaveLength(1);
    expect(published[0].name).toBe('a.png');
  });

  // ── Chip rendering ──

  it('renders an image chip as a thumbnail, not a document icon', async () => {
    vi.spyOn(asAny(), 'downscaleImage').mockResolvedValue({ dataUrl: 'data:image/webp;base64,AA', bytes: 10 });
    await asAny().attachImage({ name: 'pic.png', size: 10, type: 'image/png' });

    const chip = element.shadowRoot?.querySelector('.attachment');
    expect(chip?.querySelector('img.thumb')).toBeTruthy();
    expect(chip?.querySelector('.icon')).toBeNull();
    expect(chip?.querySelector('img.thumb')?.getAttribute('src')).toBe('data:image/webp;base64,AA');
  });

  it('still renders text attachments with the document icon', () => {
    asAny().addAttachment({ content: 'body', name: 'a.ts', size: 4, type: 'file' });

    const chip = element.shadowRoot?.querySelector('.attachment');
    expect(chip?.querySelector('.icon')).toBeTruthy();
    expect(chip?.querySelector('img.thumb')).toBeNull();
  });

  it('removes an image attachment like any other', async () => {
    vi.spyOn(asAny(), 'downscaleImage').mockResolvedValue({ dataUrl: 'data:image/webp;base64,AA', bytes: 10 });
    await asAny().attachImage({ name: 'pic.png', size: 10, type: 'image/png' });
    expect(actor.getState().attachments).toHaveLength(1);

    asAny().removeAttachment(0);
    expect(actor.getState().attachments).toHaveLength(0);
    expect(element.shadowRoot?.querySelector('.attachment')).toBeNull();
  });
});
