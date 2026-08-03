/**
 * ADR 0014 — attachment persistence + replay.
 *
 * The gate for Phase 0: context built live and context rebuilt after a reload
 * must be byte-identical, the attachment block must appear EXACTLY ONCE (the
 * double-injection regression is the likeliest future re-break), and the block
 * must survive a fork.
 *
 * Written deliberately before images exist so it keeps holding once they do.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../../src/events/SqlJsWrapper';
import { runMigrations } from '../../../src/events/migrations';
import { EventStore } from '../../../src/events/EventStore';
import { AttachmentBlobStore } from '../../../src/events/AttachmentBlobStore';
import {
  formatAttachmentsForContext,
  prepareAttachmentsForPersistence,
  MAX_PERSISTED_ATTACHMENT_BYTES
} from '../../../src/events/attachmentContext';
import { UserMessageEvent } from '../../../src/events/EventTypes';

/**
 * The exact block the pre-ADR-0014 live path produced. Replay must match this
 * byte for byte — models and prompts must not be able to tell the difference.
 */
function legacyLiveInjection(attachments: Array<{ name: string; content: string }>): string {
  let fileContext = '\n\n--- Attached Files ---\n';
  for (const attachment of attachments) {
    const content = attachment.content || '';
    fileContext += `\n### File: ${attachment.name}\n\`\`\`\n${content}\n\`\`\`\n`;
  }
  fileContext += '--- End Attached Files ---\n';
  return fileContext;
}

describe('ADR 0014 — attachment replay', () => {
  let db: Database;
  let eventStore: EventStore;
  let blobStore: AttachmentBlobStore;

  const readBlobText = (blobId: string) => blobStore.getText(blobId);

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.prepare('INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('session-1', 'Test', 'test', 1000, 1000);
    db.prepare('INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('fork-1', 'Fork', 'test', 1000, 1000);
    eventStore = new EventStore(db);
    blobStore = new AttachmentBlobStore(db);
  });

  afterEach(() => db.close());

  /** Record a user message the way ConversationManager does. */
  function record(sessionId: string, content: string, attachments: Array<{ name: string; content: string }>) {
    const persisted = prepareAttachmentsForPersistence(attachments, blobStore);
    const event = eventStore.append({
      sessionId,
      timestamp: Date.now(),
      type: 'user_message',
      content,
      attachments: persisted
    } as any);
    for (const a of persisted) {
      if (a.blobId) blobStore.link(event.id, a.blobId);
    }
    return event;
  }

  /** Rebuild context the way getSessionMessagesCompat does. */
  function rebuildContext(sessionId: string): string[] {
    return eventStore.getEvents(sessionId)
      .filter(e => e.type === 'user_message')
      .map(e => (e as any).content + formatAttachmentsForContext((e as UserMessageEvent).attachments, readBlobText));
  }

  // ── Byte-identical replay ──

  it('rebuilds context byte-identically to the old live injection', () => {
    const attachments = [
      { name: 'config.json', content: '{\n  "a": 1\n}' },
      { name: 'notes.md', content: '# Heading\n\ntext with ``` fences and \\backslashes' }
    ];
    record('session-1', 'look at these', attachments);

    const expected = 'look at these' + legacyLiveInjection(attachments);
    expect(rebuildContext('session-1')).toEqual([expected]);
  });

  it('survives a reload — a fresh store over the same file sees the same bytes', () => {
    const attachments = [{ name: 'a.ts', content: 'export const x = 1;' }];
    record('session-1', 'hello', attachments);
    const live = rebuildContext('session-1');

    // Simulate reload: brand-new store objects against the same database.
    const reloadedEvents = new EventStore(db);
    const reloadedBlobs = new AttachmentBlobStore(db);
    const afterReload = reloadedEvents.getEvents('session-1')
      .filter(e => e.type === 'user_message')
      .map(e => (e as any).content + formatAttachmentsForContext(
        (e as UserMessageEvent).attachments,
        id => reloadedBlobs.getText(id)
      ));

    expect(afterReload).toEqual(live);
  });

  // ── Exactly once (pins the deleted live injection) ──

  it('emits the attachment block exactly once per user message', () => {
    record('session-1', 'one', [{ name: 'f.txt', content: 'body' }]);
    const [context] = rebuildContext('session-1');

    expect(context.match(/--- Attached Files ---/g)).toHaveLength(1);
    expect(context.match(/--- End Attached Files ---/g)).toHaveLength(1);
    expect(context.match(/### File: f\.txt/g)).toHaveLength(1);
  });

  it('leaves the persisted event content raw — the block is never baked in', () => {
    const event = record('session-1', 'raw text', [{ name: 'f.txt', content: 'body' }]);
    const stored = eventStore.getEventById(event.id) as any;

    expect(stored.content).toBe('raw text');
    expect(stored.content).not.toContain('--- Attached Files ---');
  });

  it('adds nothing for a message with no attachments', () => {
    eventStore.append({ sessionId: 'session-1', timestamp: Date.now(), type: 'user_message', content: 'plain' } as any);
    expect(rebuildContext('session-1')).toEqual(['plain']);
  });

  // ── Fork ──

  it('carries the attachment block across a zero-copy fork', () => {
    const attachments = [{ name: 'shared.ts', content: 'const shared = true;' }];
    const event = record('session-1', 'fork me', attachments);

    // Zero-copy fork: link the same event row to the new session.
    db.prepare('INSERT INTO event_sessions (event_id, session_id, sequence) VALUES (?, ?, ?)')
      .run(event.id, 'fork-1', 1);

    expect(rebuildContext('fork-1')).toEqual(rebuildContext('session-1'));
    expect(rebuildContext('fork-1')[0]).toContain('const shared = true;');
  });

  // ── Blob storage behavior ──

  it('deduplicates identical attachment bodies by content hash', () => {
    record('session-1', 'first', [{ name: 'a.txt', content: 'same bytes' }]);
    record('session-1', 'second', [{ name: 'b-renamed.txt', content: 'same bytes' }]);

    expect(blobStore.count()).toBe(1);
    // Both messages still rebuild their own content.
    const contexts = rebuildContext('session-1');
    expect(contexts[0]).toContain('### File: a.txt');
    expect(contexts[1]).toContain('### File: b-renamed.txt');
    expect(contexts[0]).toContain('same bytes');
    expect(contexts[1]).toContain('same bytes');
  });

  it('renders an explicit marker when a blob is missing rather than an empty file', () => {
    const persisted = prepareAttachmentsForPersistence([{ name: 'gone.txt', content: 'x' }], blobStore);
    db.prepare('DELETE FROM attachment_blobs').run();

    const block = formatAttachmentsForContext(persisted, readBlobText);
    expect(block).toContain('attachment content unavailable');
    expect(block).not.toMatch(/```\n\n```/);
  });

  it('collects blobs orphaned by event deletion', () => {
    const event = record('session-1', 'temp', [{ name: 'tmp.txt', content: 'disposable' }]);
    expect(blobStore.count()).toBe(1);

    db.prepare('DELETE FROM event_sessions WHERE session_id = ?').run('session-1');
    db.prepare('DELETE FROM events WHERE id NOT IN (SELECT event_id FROM event_sessions)').run();
    expect(blobStore.collectGarbage()).toBe(1);
    expect(blobStore.count()).toBe(0);
    expect(eventStore.getEventById(event.id)).toBeNull();
  });

  it('keeps blobs still referenced by another session', () => {
    const event = record('session-1', 'shared', [{ name: 's.txt', content: 'keep me' }]);
    db.prepare('INSERT INTO event_sessions (event_id, session_id, sequence) VALUES (?, ?, ?)')
      .run(event.id, 'fork-1', 1);

    db.prepare('DELETE FROM event_sessions WHERE session_id = ?').run('session-1');
    db.prepare('DELETE FROM events WHERE id NOT IN (SELECT event_id FROM event_sessions)').run();

    expect(blobStore.collectGarbage()).toBe(0);
    expect(rebuildContext('fork-1')[0]).toContain('keep me');
  });

  // ── Size cap ──

  it('truncates oversized bodies with an explicit marker', () => {
    const huge = 'x'.repeat(MAX_PERSISTED_ATTACHMENT_BYTES + 5000);
    const persisted = prepareAttachmentsForPersistence([{ name: 'huge.log', content: huge }], blobStore);

    expect(persisted[0].truncated).toBe(true);
    expect(persisted[0].originalBytes).toBe(MAX_PERSISTED_ATTACHMENT_BYTES + 5000);

    const block = formatAttachmentsForContext(persisted, readBlobText);
    expect(block).toContain('truncated: 5000 of');
    expect(block).toContain('bytes omitted');
    expect(persisted[0].bytes!).toBeLessThan(MAX_PERSISTED_ATTACHMENT_BYTES + 500);
  });

  it('leaves bodies at or under the cap untouched', () => {
    const body = 'y'.repeat(MAX_PERSISTED_ATTACHMENT_BYTES);
    const persisted = prepareAttachmentsForPersistence([{ name: 'edge.txt', content: body }], blobStore);

    expect(persisted[0].truncated).toBeUndefined();
    expect(blobStore.getText(persisted[0].blobId!)).toBe(body);
  });

  it('does not split a multi-byte character across the truncation boundary', () => {
    // '€' is 3 bytes; fill so the cap lands mid-character.
    const body = '€'.repeat(MAX_PERSISTED_ATTACHMENT_BYTES);
    const persisted = prepareAttachmentsForPersistence([{ name: 'utf8.txt', content: body }], blobStore);
    const stored = blobStore.getText(persisted[0].blobId!)!;

    expect(stored).not.toContain('�');
  });

  // ── Images never ride the text path ──

  it('keeps images out of the text block — they carry a digest, never bytes', () => {
    const attachments = [
      { type: 'image' as const, name: 'shot.png', blobId: 'deadbeef', bytes: 10, digest: 'a screenshot of a form' },
      { type: 'file' as const, name: 'code.ts', content: 'const a = 1;' }
    ];

    const block = formatAttachmentsForContext(attachments, () => 'RAW-IMAGE-BYTES');

    const filesBlock = block.slice(
      block.indexOf('--- Attached Files ---'),
      block.indexOf('--- End Attached Files ---')
    );
    expect(filesBlock).toContain('### File: code.ts');
    expect(filesBlock).not.toContain('shot.png');
    // The blob reader is never consulted for an image, in either block.
    expect(block).not.toContain('RAW-IMAGE-BYTES');
    expect(block).toContain('a screenshot of a form');
  });

  it('stores an image as decoded binary, exempt from the text cap', () => {
    // 3 raw bytes, base64-encoded into a data URI.
    const raw = Buffer.from([0x89, 0x50, 0x4e]);
    const dataUri = `data:image/webp;base64,${raw.toString('base64')}`;
    const [persisted] = prepareAttachmentsForPersistence(
      [{ type: 'image', name: 'shot.webp', content: dataUri, mimeType: 'image/webp' }],
      blobStore
    );

    expect(persisted.type).toBe('image');
    expect(persisted.truncated).toBeUndefined();
    // Decoded bytes, not the ~4/3-inflated data URI text.
    expect(persisted.bytes).toBe(3);
    expect(blobStore.get(persisted.blobId!)!.data).toEqual(raw);
    expect(blobStore.get(persisted.blobId!)!.mime).toBe('image/webp');
  });

  it('does not truncate a large image the way it truncates large text', () => {
    const raw = Buffer.alloc(MAX_PERSISTED_ATTACHMENT_BYTES + 10_000, 7);
    const dataUri = `data:image/webp;base64,${raw.toString('base64')}`;
    const [persisted] = prepareAttachmentsForPersistence(
      [{ type: 'image', name: 'big.webp', content: dataUri, mimeType: 'image/webp' }],
      blobStore
    );

    expect(persisted.truncated).toBeUndefined();
    expect(blobStore.get(persisted.blobId!)!.data).toEqual(raw);
  });

  // ── Archive rendition (plan Phase 4) ──
  //
  // The failure this phase exists to prevent is SILENT: persisting the large
  // copy the vision subagent read looks fine until a transcript full of them
  // makes hydration crawl. These pin which rendition reaches the table.

  function dataUri(bytes: Buffer) {
    return `data:image/webp;base64,${bytes.toString('base64')}`;
  }

  it('persists the archive rendition, not the copy the subagent read', () => {
    const subCopy = Buffer.alloc(40_000, 1);   // ~1024px, ephemeral
    const archive = Buffer.alloc(6_000, 2);    // 512px, the one we keep

    const [persisted] = prepareAttachmentsForPersistence(
      [{
        type: 'image', name: 'shot.png', mimeType: 'image/webp',
        content: dataUri(subCopy),
        archive: { dataUrl: dataUri(archive), bytes: archive.length, width: 512, height: 288 }
      }],
      blobStore
    );

    expect(persisted.bytes).toBe(archive.length);
    expect(blobStore.get(persisted.blobId!)!.data).toEqual(archive);
    // The larger copy must not be in the table at all.
    expect(blobStore.count()).toBe(1);
  });

  it('records the archive dimensions so the transcript can reserve space', () => {
    const archive = Buffer.alloc(100, 3);
    const [persisted] = prepareAttachmentsForPersistence(
      [{
        type: 'image', name: 'wide.png', content: dataUri(Buffer.alloc(500, 9)),
        archive: { dataUrl: dataUri(archive), bytes: archive.length, width: 512, height: 288 }
      }],
      blobStore
    );

    expect(persisted.width).toBe(512);
    expect(persisted.height).toBe(288);
    const stored = blobStore.get(persisted.blobId!)!;
    expect(stored.width).toBe(512);
    expect(stored.height).toBe(288);
  });

  it('falls back to the full copy when no archive was produced, and says so', () => {
    const only = Buffer.alloc(700, 4);
    const [persisted] = prepareAttachmentsForPersistence(
      [{ type: 'image', name: 'legacy.png', content: dataUri(only) }],
      blobStore
    );

    // Degrades rather than dropping the image — but the warning is the signal
    // that the webview did not send what this path expects.
    expect(blobStore.get(persisted.blobId!)!.data).toEqual(only);
    expect(persisted.width).toBeUndefined();
  });

  it('keeps the digest alongside the archive', () => {
    const archive = Buffer.alloc(50, 5);
    const [persisted] = prepareAttachmentsForPersistence(
      [{
        type: 'image', name: 'x.png', content: dataUri(Buffer.alloc(900, 8)),
        archive: { dataUrl: dataUri(archive), bytes: archive.length, width: 512, height: 512 },
        digest: 'a login form'
      }],
      blobStore
    );

    expect(persisted.digest).toBe('a login form');
    expect(persisted.bytes).toBe(archive.length);
  });

  // ── Digest replay (plan Phase 3): the whole reason digests are resolved
  // before the record rather than injected live. ──

  it('rebuilds an image digest identically after a reload', () => {
    const raw = Buffer.from([1, 2, 3]);
    const persisted = prepareAttachmentsForPersistence(
      [{
        type: 'image',
        name: 'mock.png',
        content: `data:image/webp;base64,${raw.toString('base64')}`,
        mimeType: 'image/webp',
        digest: 'A signup form with email and password fields.'
      }],
      blobStore
    );
    const event = eventStore.append({
      sessionId: 'session-1', timestamp: Date.now(), type: 'user_message',
      content: 'what is wrong with this?', attachments: persisted
    } as any);
    blobStore.link(event.id, persisted[0].blobId!);

    const live = rebuildContext('session-1');

    const reloadedEvents = new EventStore(db);
    const reloadedBlobs = new AttachmentBlobStore(db);
    const afterReload = reloadedEvents.getEvents('session-1')
      .filter(e => e.type === 'user_message')
      .map(e => (e as any).content + formatAttachmentsForContext(
        (e as UserMessageEvent).attachments,
        id => reloadedBlobs.getText(id)
      ));

    expect(afterReload).toEqual(live);
    expect(afterReload[0]).toContain('A signup form with email and password fields.');
  });

  it('replays a routing-failure placeholder as the placeholder, not silence', () => {
    const raw = Buffer.from([9]);
    const placeholder = '[Image "x.png" was attached but could not be described — no vision backend is configured.]';
    const persisted = prepareAttachmentsForPersistence(
      [{ type: 'image', name: 'x.png', content: `data:image/webp;base64,${raw.toString('base64')}`, digest: placeholder }],
      blobStore
    );
    const event = eventStore.append({
      sessionId: 'session-1', timestamp: Date.now(), type: 'user_message', content: 'see this', attachments: persisted
    } as any);
    blobStore.link(event.id, persisted[0].blobId!);

    expect(rebuildContext('session-1')[0]).toContain(placeholder);
  });

  it('carries an image digest across a fork', () => {
    const persisted = prepareAttachmentsForPersistence(
      [{ type: 'image', name: 'shared.png', content: 'data:image/webp;base64,AQID', digest: 'a shared diagram' }],
      blobStore
    );
    const event = eventStore.append({
      sessionId: 'session-1', timestamp: Date.now(), type: 'user_message', content: 'fork me', attachments: persisted
    } as any);
    blobStore.link(event.id, persisted[0].blobId!);
    db.prepare('INSERT INTO event_sessions (event_id, session_id, sequence) VALUES (?, ?, ?)')
      .run(event.id, 'fork-1', 1);

    expect(rebuildContext('fork-1')).toEqual(rebuildContext('session-1'));
    expect(rebuildContext('fork-1')[0]).toContain('a shared diagram');
  });

  it('emits only the images block when every attachment is an image', () => {
    const block = formatAttachmentsForContext(
      [{ type: 'image' as const, name: 'a.png', blobId: 'x', bytes: 1, digest: 'a whale' }],
      () => null
    );
    expect(block).toContain('--- Attached Images ---');
    expect(block).toContain('a whale');
    expect(block).not.toContain('--- Attached Files ---');
  });
});
