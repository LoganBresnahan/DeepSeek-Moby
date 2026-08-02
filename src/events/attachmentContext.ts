/**
 * Attachment persistence + replay (ADR 0014).
 *
 * Attachments used to be injected into model context live and never persisted,
 * so a reloaded session rebuilt context without them — silently differing from
 * the conversation that actually happened. These helpers are the two halves of
 * the fix: `prepareAttachmentsForPersistence` on the write side, and
 * `formatAttachmentsForContext` on the read side.
 *
 * The read side has exactly ONE call site (`getSessionMessagesCompat`). Because
 * the user message is recorded before context is built, replay covers the
 * current turn too — a second live injection would double the block.
 */

import { Attachment } from './EventTypes';
import { AttachmentBlobStore } from './AttachmentBlobStore';
import { logger } from '../utils/logger';

/**
 * Ceiling on the body we persist (and therefore replay) per attachment.
 * Bodies above it are truncated with an explicit marker so the model is told
 * the text is partial rather than silently reading a clipped file.
 */
export const MAX_PERSISTED_ATTACHMENT_BYTES = 256 * 1024;

/** Attachment as it arrives from the webview — body inline, nothing stored yet. */
export interface IncomingAttachment {
  content: string;
  name: string;
  size?: number;
  type?: 'file' | 'image' | 'selection';
  mimeType?: string;
  language?: string;
  filePath?: string;
}

function truncationMarker(originalBytes: number, keptBytes: number): string {
  return `\n\n[... truncated: ${originalBytes - keptBytes} of ${originalBytes} bytes omitted — attachment exceeded the ${MAX_PERSISTED_ATTACHMENT_BYTES} byte limit ...]`;
}

/**
 * Convert incoming attachments into the persisted shape: bodies go to the blob
 * store, the event keeps only a reference. Returns the attachments to embed in
 * the `user_message` event; caller links the blob ids to the event id.
 */
export function prepareAttachmentsForPersistence(
  attachments: IncomingAttachment[],
  blobStore: AttachmentBlobStore
): Attachment[] {
  return attachments.map(incoming => {
    const type = incoming.type ?? 'file';
    const base: Attachment = {
      type,
      name: incoming.name,
      ...(incoming.language ? { language: incoming.language } : {}),
      ...(incoming.filePath ? { filePath: incoming.filePath } : {}),
      ...(incoming.mimeType ? { mimeType: incoming.mimeType } : {})
    };

    const body = incoming.content ?? '';
    const originalBytes = Buffer.byteLength(body, 'utf8');
    let stored = body;
    let truncated = false;

    if (originalBytes > MAX_PERSISTED_ATTACHMENT_BYTES) {
      // Slice on a byte boundary, then drop any partial trailing UTF-8
      // sequence by round-tripping through the decoder.
      const kept = Buffer.from(body, 'utf8')
        .subarray(0, MAX_PERSISTED_ATTACHMENT_BYTES)
        .toString('utf8')
        .replace(/�$/, '');
      stored = kept + truncationMarker(originalBytes, Buffer.byteLength(kept, 'utf8'));
      truncated = true;
      logger.info(
        `[Attachments] Truncated "${incoming.name}" for persistence: ${originalBytes} → ${MAX_PERSISTED_ATTACHMENT_BYTES} bytes`
      );
    }

    const ref = blobStore.putText(stored, incoming.mimeType ?? 'text/plain');

    return {
      ...base,
      blobId: ref.blobId,
      bytes: ref.bytes,
      ...(truncated ? { truncated: true, originalBytes } : {})
    };
  });
}

/**
 * Rebuild the `--- Attached Files ---` context block from persisted
 * attachments. Byte-identical to the block the live path used to append.
 *
 * Images are skipped: they reach the model as a subagent digest, never as text
 * in this block.
 *
 * @param readBlobText resolves a blobId to its stored text (null if missing)
 */
export function formatAttachmentsForContext(
  attachments: Attachment[] | undefined,
  readBlobText: (blobId: string) => string | null
): string {
  if (!attachments || attachments.length === 0) return '';

  const textual = attachments.filter(a => a.type !== 'image');
  if (textual.length === 0) return '';

  let fileContext = '\n\n--- Attached Files ---\n';
  for (const attachment of textual) {
    fileContext += `\n### File: ${attachment.name}\n\`\`\`\n${resolveBody(attachment, readBlobText)}\n\`\`\`\n`;
  }
  fileContext += '--- End Attached Files ---\n';
  return fileContext;
}

function resolveBody(
  attachment: Attachment,
  readBlobText: (blobId: string) => string | null
): string {
  if (attachment.blobId) {
    const text = readBlobText(attachment.blobId);
    if (text !== null) return text;
    // A missing blob must be visible, not silently render as an empty file —
    // that would look to the model like the user attached a blank document.
    logger.warn(`[Attachments] Blob ${attachment.blobId.substring(0, 8)} missing for "${attachment.name}"`);
    return `[attachment content unavailable — blob ${attachment.blobId.substring(0, 8)} missing]`;
  }
  return attachment.content ?? '';
}
