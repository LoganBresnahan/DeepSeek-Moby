/**
 * ADR 0014 — content-addressed attachment blob store.
 *
 * The binary round-trip cases matter beyond text: Phase 4 of the image-describe
 * plan stores WebP thumbnails through this same path, and StatementWrapper had
 * only ever carried strings and numbers before this table existed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../../src/events/SqlJsWrapper';
import { runMigrations } from '../../../src/events/migrations';
import { AttachmentBlobStore } from '../../../src/events/AttachmentBlobStore';

describe('AttachmentBlobStore', () => {
  let db: Database;
  let store: AttachmentBlobStore;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.prepare('INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('s1', 'Test', 'test', 1000, 1000);
    db.prepare('INSERT INTO events (id, timestamp, type, data) VALUES (?, ?, ?, ?)')
      .run('e1', 1000, 'user_message', '{}');
    store = new AttachmentBlobStore(db);
  });

  afterEach(() => db.close());

  it('round-trips arbitrary binary bytes intact', () => {
    // Includes NUL, high bytes, and newline/CR — the values most likely to be
    // mangled if a blob were ever coerced through a string path.
    const bytes = Buffer.from([0x00, 0xff, 0x0a, 0x0d, 0x80, 0x7f, 0x00, 0xc3, 0x28]);
    const ref = store.put(bytes, 'application/octet-stream');

    const read = store.get(ref.blobId);
    expect(read).not.toBeNull();
    expect(read!.data).toEqual(bytes);
    expect(read!.bytes).toBe(bytes.length);
    expect(read!.mime).toBe('application/octet-stream');
  });

  it('accepts a Uint8Array as well as a Buffer', () => {
    const ref = store.put(new Uint8Array([1, 2, 3]), 'image/webp');
    expect(store.get(ref.blobId)!.data).toEqual(Buffer.from([1, 2, 3]));
  });

  it('keys blobs by sha256 of their content', () => {
    const ref = store.putText('hello');
    // sha256("hello")
    expect(ref.blobId).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('is idempotent — identical bytes store once and yield the same id', () => {
    const a = store.put(Buffer.from('same'), 'text/plain');
    const b = store.put(Buffer.from('same'), 'text/plain');

    expect(a.blobId).toBe(b.blobId);
    expect(store.count()).toBe(1);
  });

  it('distinguishes different bytes', () => {
    store.putText('one');
    store.putText('two');
    expect(store.count()).toBe(2);
  });

  it('stores optional image dimensions', () => {
    const ref = store.put(Buffer.from([1]), 'image/webp', { width: 512, height: 288 });

    expect(ref.width).toBe(512);
    expect(ref.height).toBe(288);
    const read = store.get(ref.blobId)!;
    expect(read.width).toBe(512);
    expect(read.height).toBe(288);
  });

  it('omits dimensions when not supplied', () => {
    const ref = store.putText('no dims');
    expect(ref.width).toBeUndefined();
    expect(store.get(ref.blobId)!.height).toBeUndefined();
  });

  it('returns null for an unknown blob id', () => {
    expect(store.get('nope')).toBeNull();
    expect(store.getText('nope')).toBeNull();
  });

  it('round-trips UTF-8 text including multi-byte characters', () => {
    const text = 'héllo — 世界 🐋\n\ttabbed';
    const ref = store.putText(text);
    expect(store.getText(ref.blobId)).toBe(text);
  });

  // ── Linking + GC ──

  it('links blobs to events and lists them back', () => {
    const ref = store.putText('linked');
    store.link('e1', ref.blobId);

    expect(store.getBlobIdsForEvent('e1')).toEqual([ref.blobId]);
  });

  it('link is idempotent', () => {
    const ref = store.putText('linked');
    store.link('e1', ref.blobId);
    store.link('e1', ref.blobId);

    expect(store.getBlobIdsForEvent('e1')).toHaveLength(1);
  });

  it('collects unreferenced blobs and keeps referenced ones', () => {
    const kept = store.putText('kept');
    store.putText('orphan');
    store.link('e1', kept.blobId);

    expect(store.collectGarbage()).toBe(1);
    expect(store.get(kept.blobId)).not.toBeNull();
    expect(store.count()).toBe(1);
  });

  it('drops links when the referencing event is deleted (CASCADE)', () => {
    const ref = store.putText('doomed');
    store.link('e1', ref.blobId);

    db.prepare('DELETE FROM events WHERE id = ?').run('e1');
    expect(store.getBlobIdsForEvent('e1')).toHaveLength(0);
    expect(store.collectGarbage()).toBe(1);
  });

  it('collectGarbage is a no-op when everything is referenced', () => {
    const ref = store.putText('a');
    store.link('e1', ref.blobId);
    expect(store.collectGarbage()).toBe(0);
  });
});
