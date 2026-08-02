/**
 * AttachmentBlobStore — content-addressed storage for attachment payloads.
 *
 * ADR 0014. Attachment bytes are keyed by sha256 of their content and stored
 * in the `attachment_blobs` table; `events.data` carries only a reference.
 * Two consequences fall out of content-addressing for free:
 * - re-attaching the same file stores nothing new
 * - forking shares blobs by hash, so it stays zero-copy like event_sessions
 *
 * Lifetime is tied to events through `event_blobs`. Deleting an event cascades
 * its links away; `collectGarbage()` then removes blobs nothing points at.
 */

import { createHash } from 'crypto';
import { Database } from './SqlJsWrapper';
import { logger } from '../utils/logger';

interface Statement {
  run(...params: unknown[]): void;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

/** A stored blob's metadata — what gets embedded in an event. */
export interface BlobRef {
  blobId: string;
  mime: string;
  /** Size of the stored bytes (post-truncation, post-encode). */
  bytes: number;
  width?: number;
  height?: number;
}

export interface StoredBlob extends BlobRef {
  data: Buffer;
}

export class AttachmentBlobStore {
  private db: Database;
  private stmtPut: Statement;
  private stmtGet: Statement;
  private stmtLink: Statement;
  private stmtBlobsForEvent: Statement;

  constructor(db: Database) {
    this.db = db;
    this.stmtPut = this.db.prepare(`
      INSERT OR IGNORE INTO attachment_blobs
        (blob_id, mime, byte_size, width, height, created_at, data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtGet = this.db.prepare(`
      SELECT blob_id, mime, byte_size, width, height, data
      FROM attachment_blobs WHERE blob_id = ?
    `);
    this.stmtLink = this.db.prepare(`
      INSERT OR IGNORE INTO event_blobs (event_id, blob_id) VALUES (?, ?)
    `);
    this.stmtBlobsForEvent = this.db.prepare(`
      SELECT blob_id FROM event_blobs WHERE event_id = ?
    `);
  }

  /**
   * Store bytes, returning a reference. Idempotent — identical bytes yield the
   * same blobId and no second row.
   */
  put(
    data: Uint8Array | Buffer,
    mime: string,
    dimensions?: { width?: number; height?: number }
  ): BlobRef {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const blobId = createHash('sha256').update(buf).digest('hex');

    this.stmtPut.run(
      blobId,
      mime,
      buf.length,
      dimensions?.width ?? null,
      dimensions?.height ?? null,
      Date.now(),
      buf
    );

    return {
      blobId,
      mime,
      bytes: buf.length,
      ...(dimensions?.width !== undefined ? { width: dimensions.width } : {}),
      ...(dimensions?.height !== undefined ? { height: dimensions.height } : {})
    };
  }

  /** Store UTF-8 text. Convenience wrapper over {@link put}. */
  putText(text: string, mime = 'text/plain'): BlobRef {
    return this.put(Buffer.from(text, 'utf8'), mime);
  }

  get(blobId: string): StoredBlob | null {
    const row = this.stmtGet.get(blobId) as
      | { blob_id: string; mime: string; byte_size: number; width: number | null; height: number | null; data: Buffer }
      | undefined;
    if (!row) return null;
    return {
      blobId: row.blob_id,
      mime: row.mime,
      bytes: row.byte_size,
      ...(row.width !== null ? { width: row.width } : {}),
      ...(row.height !== null ? { height: row.height } : {}),
      data: Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data as any)
    };
  }

  /** Read a blob back as UTF-8 text. Returns null when the blob is missing. */
  getText(blobId: string): string | null {
    const blob = this.get(blobId);
    return blob ? blob.data.toString('utf8') : null;
  }

  /** Link a blob to the event that references it (drives GC lifetime). */
  link(eventId: string, blobId: string): void {
    this.stmtLink.run(eventId, blobId);
  }

  getBlobIdsForEvent(eventId: string): string[] {
    const rows = this.stmtBlobsForEvent.all(eventId) as { blob_id: string }[];
    return rows.map(r => r.blob_id);
  }

  /**
   * Delete blobs no event references any more. Callers run this inside the
   * same transaction as event deletion so a crash can't strand rows.
   */
  collectGarbage(): number {
    const before = this.count();
    this.db.prepare(
      'DELETE FROM attachment_blobs WHERE blob_id NOT IN (SELECT blob_id FROM event_blobs)'
    ).run();
    const removed = before - this.count();
    if (removed > 0) {
      logger.info(`[AttachmentBlobStore] Collected ${removed} orphaned blob(s)`);
    }
    return removed;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM attachment_blobs').get() as { count: number };
    return row.count;
  }
}
