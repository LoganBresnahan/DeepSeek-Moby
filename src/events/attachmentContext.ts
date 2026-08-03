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
  /** Images only — the digest resolved before the turn was recorded. */
  digest?: string;
  /** Images only — the 512px copy to persist. `content` holds the larger copy
   *  the vision subagent read, which must never reach the database. */
  archive?: { dataUrl: string; bytes: number; width: number; height: number };
}

/** Split a `data:<mime>;base64,<payload>` URI into its mime and raw bytes. */
function decodeDataUri(uri: string): { mime: string; bytes: Buffer } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(uri);
  if (!match) return null;
  try {
    return { mime: match[1], bytes: Buffer.from(match[2], 'base64') };
  } catch {
    return null;
  }
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

    // Images arrive as data URIs. They store as decoded binary and are exempt
    // from the text cap — truncating an image yields bytes that don't decode,
    // where truncating text still reads.
    if (type === 'image') {
      // Persist the ARCHIVE rendition, never `content` — that one is the
      // larger copy the vision subagent read, and storing it is the silent
      // failure this phase exists to prevent (a transcript full of full-size
      // images looks fine until hydration slows to a crawl).
      const source = incoming.archive?.dataUrl ?? incoming.content ?? '';
      const decoded = decodeDataUri(source);
      if (decoded) {
        const ref = blobStore.put(decoded.bytes, incoming.mimeType ?? decoded.mime, {
          width: incoming.archive?.width,
          height: incoming.archive?.height
        });
        if (!incoming.archive) {
          logger.warn(`[Attachments] No archive rendition for "${incoming.name}" — persisting the full copy`);
        }
        return {
          ...base,
          mimeType: incoming.mimeType ?? decoded.mime,
          blobId: ref.blobId,
          bytes: ref.bytes,
          ...(ref.width !== undefined ? { width: ref.width } : {}),
          ...(ref.height !== undefined ? { height: ref.height } : {}),
          ...(incoming.digest ? { digest: incoming.digest } : {})
        };
      }
      logger.warn(`[Attachments] Image "${incoming.name}" is not a decodable data URI; storing verbatim`);
    }

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
 * Rebuild the attachment context blocks from persisted attachments. The
 * `--- Attached Files ---` block is byte-identical to what the live path used
 * to append, so text-only turns are unchanged.
 *
 * Images get their own block carrying the vision subagent's *digest* — their
 * bytes never appear here, and never reach the main model.
 *
 * @param readBlobText resolves a blobId to its stored text (null if missing)
 */
export function formatAttachmentsForContext(
  attachments: Attachment[] | undefined,
  readBlobText: (blobId: string) => string | null
): string {
  if (!attachments || attachments.length === 0) return '';

  const textual = attachments.filter(a => a.type !== 'image');
  const images = attachments.filter(a => a.type === 'image');

  let context = '';

  if (textual.length > 0) {
    context += '\n\n--- Attached Files ---\n';
    for (const attachment of textual) {
      context += `\n### File: ${attachment.name}\n\`\`\`\n${resolveBody(attachment, readBlobText)}\n\`\`\`\n`;
    }
    context += '--- End Attached Files ---\n';
  }

  // Images contribute their DIGEST — the description a vision subagent
  // produced at attach time — and never their bytes. The digest is persisted
  // on the attachment, so this rebuilds identically after a reload.
  if (images.length > 0) {
    context += '\n\n--- Attached Images ---\n';
    for (const image of images) {
      context += `\n${image.digest ?? missingDigestPlaceholder(image.name)}\n`;
    }
    context += '--- End Attached Images ---\n';
  }

  return context;
}

function missingDigestPlaceholder(name: string): string {
  return `[Image "${name}" was attached but no description was recorded. You cannot see this image; say so rather than guessing at its contents.]`;
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
