/**
 * Orchestrator image branch (plan Phase 3).
 *
 * Three guard rails, in order of how badly each would fail:
 *  1. An image must NEVER ride the text `--- Attached Files ---` formatter —
 *     its bytes would arrive as mojibake in a code fence.
 *  2. A `routed: false` image must NEVER be silently dropped — the model would
 *     answer about an image nobody told it existed.
 *  3. The digest is resolved BEFORE the turn is recorded, so it persists and
 *     replays. Injecting it live instead reintroduces exactly the reload-drift
 *     ADR 0014 fixed for text.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => await import('../../__mocks__/vscode'));

import { assertNoArrayContent } from '../../../src/providers/requestOrchestrator';
import { formatAttachmentsForContext } from '../../../src/events/attachmentContext';

describe('image attachment injection', () => {
  // ── Guard rail 1: images never take the text path ──

  describe('context formatting', () => {
    const readBlob = (_id: string) => 'RAW-IMAGE-BYTES-SHOULD-NEVER-APPEAR';

    it('renders an image as its digest, never as bytes', () => {
      const block = formatAttachmentsForContext(
        [{ type: 'image', name: 'shot.png', blobId: 'abc', bytes: 100, digest: 'A login form with two fields.' }],
        readBlob
      );

      expect(block).toContain('A login form with two fields.');
      expect(block).not.toContain('RAW-IMAGE-BYTES-SHOULD-NEVER-APPEAR');
      expect(block).toContain('--- Attached Images ---');
    });

    it('never puts an image inside the Attached Files block', () => {
      const block = formatAttachmentsForContext(
        [
          { type: 'image', name: 'shot.png', blobId: 'abc', bytes: 1, digest: 'a screenshot' },
          { type: 'file', name: 'a.ts', blobId: 'def', bytes: 1 }
        ],
        (id) => (id === 'def' ? 'const x = 1;' : 'BYTES')
      );

      const filesBlock = block.slice(
        block.indexOf('--- Attached Files ---'),
        block.indexOf('--- End Attached Files ---')
      );
      expect(filesBlock).toContain('a.ts');
      expect(filesBlock).not.toContain('shot.png');
      expect(filesBlock).not.toContain('BYTES');
    });

    it('leaves the text block byte-identical when there are no images', () => {
      const withoutImages = formatAttachmentsForContext(
        [{ type: 'file', name: 'a.ts', blobId: 'x', bytes: 1 }],
        () => 'body'
      );
      expect(withoutImages).toBe('\n\n--- Attached Files ---\n\n### File: a.ts\n```\nbody\n```\n--- End Attached Files ---\n');
    });

    // ── Guard rail 2: never silently dropped ──

    it('emits an explicit placeholder when an image has no digest', () => {
      const block = formatAttachmentsForContext(
        [{ type: 'image', name: 'mystery.png', blobId: 'abc', bytes: 1 }],
        readBlob
      );

      expect(block).toContain('mystery.png');
      expect(block).toContain('no description was recorded');
      expect(block).toContain('cannot see this image');
    });

    it('tells the model not to guess rather than staying silent', () => {
      const block = formatAttachmentsForContext(
        [{ type: 'image', name: 'x.png', blobId: 'a', bytes: 1 }],
        readBlob
      );
      expect(block).toContain('rather than guessing');
    });

    it('renders several images each with its own digest', () => {
      const block = formatAttachmentsForContext(
        [
          { type: 'image', name: 'one.png', blobId: 'a', bytes: 1, digest: 'first image' },
          { type: 'image', name: 'two.png', blobId: 'b', bytes: 1, digest: 'second image' }
        ],
        readBlob
      );
      expect(block).toContain('first image');
      expect(block).toContain('second image');
      expect(block.match(/--- Attached Images ---/g)).toHaveLength(1);
    });
  });

  // ── Guard rail 3 (the transport contract): no array content ──

  describe('assertNoArrayContent', () => {
    it('leaves string content untouched', () => {
      const messages = [{ role: 'user', content: 'hello' }];
      assertNoArrayContent(messages);
      expect(messages[0].content).toBe('hello');
    });

    it('flattens array content rather than letting it reach the API', () => {
      const messages: Array<{ role: string; content: unknown }> = [{
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image_url', image_url: { url: 'data:image/webp;base64,AAAA' } }
        ]
      }];

      assertNoArrayContent(messages);

      expect(typeof messages[0].content).toBe('string');
      expect(messages[0].content).toContain('look at this');
      // The base64 payload must not survive into the request body.
      expect(messages[0].content).not.toContain('AAAA');
      expect(messages[0].content).toContain('[image omitted]');
    });

    it('degrades rather than throwing — a bad message must not kill the turn', () => {
      expect(() => assertNoArrayContent([{ role: 'user', content: [] }])).not.toThrow();
    });

    it('checks every message, not just the last', () => {
      const messages: Array<{ role: string; content: unknown }> = [
        { role: 'user', content: [{ type: 'text', text: 'first' }] },
        { role: 'assistant', content: 'fine' },
        { role: 'user', content: [{ type: 'text', text: 'third' }] }
      ];

      assertNoArrayContent(messages);

      expect(messages.every(m => typeof m.content === 'string')).toBe(true);
    });
  });
});
