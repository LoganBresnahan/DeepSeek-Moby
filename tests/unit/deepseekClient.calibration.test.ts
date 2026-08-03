/**
 * Token-calibration guard for image-bearing requests.
 *
 * Found 2026-08-03 in dev-host testing: one `image-describe` route drove the
 * estimation counter's ratio to 0.0499 — about 10x off — and every later
 * estimate from that client with it.
 *
 * The cause is that crossValidateTokens measured the same image two
 * incompatible ways: `countRequestTokens` scored it as the literal '[image]'
 * (~2 tokens) while the calibration char count stringified the whole base64
 * data URI (~21,600 chars). Neither models what the API bills, so an
 * image-bearing request is not a usable calibration sample at all.
 */

import { describe, it, expect } from 'vitest';
import { hasImageContent } from '../../src/deepseekClient';

const DATA_URI = `data:image/webp;base64,${'A'.repeat(2000)}`;

describe('hasImageContent', () => {
  it('detects an image_url part', () => {
    expect(hasImageContent([
      { role: 'user', content: [{ type: 'text', text: 'describe' }, { type: 'image_url', image_url: { url: DATA_URI } }] }
    ])).toBe(true);
  });

  it('is false for plain string content', () => {
    expect(hasImageContent([{ role: 'user', content: 'hello' }])).toBe(false);
  });

  it('is false for a text-only content array', () => {
    expect(hasImageContent([
      { role: 'user', content: [{ type: 'text', text: 'still just text' }] }
    ])).toBe(false);
  });

  it('finds an image anywhere in the conversation, not just the last message', () => {
    expect(hasImageContent([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: DATA_URI } }] },
      { role: 'assistant', content: 'a screenshot of a form' },
      { role: 'user', content: 'what about the button?' }
    ])).toBe(true);
  });

  it('is false for an empty message list', () => {
    expect(hasImageContent([])).toBe(false);
  });

  it('tolerates malformed content without throwing', () => {
    expect(() => hasImageContent([
      { role: 'user', content: null },
      { role: 'user', content: undefined },
      { role: 'user', content: [null as unknown as Record<string, unknown>] },
      { role: 'user' }
    ])).not.toThrow();
    expect(hasImageContent([{ role: 'user', content: [null as unknown as Record<string, unknown>] }])).toBe(false);
  });

  it('ignores unknown part types', () => {
    expect(hasImageContent([
      { role: 'user', content: [{ type: 'audio_url', audio_url: { url: 'x' } }] }
    ])).toBe(false);
  });

  // The regression this guard exists for: the real numbers from the run.
  it('flags the payload shape that produced ratio=0.0499', () => {
    // 21,646-char data URI vs an API count of 1,133 tokens → 0.052.
    const realWorldish = [
      { role: 'user', content: [
        { type: 'text', text: 'Describe this image (filename: pharos.png).' },
        { type: 'image_url', image_url: { url: `data:image/webp;base64,${'A'.repeat(21600)}` } }
      ] }
    ];
    expect(hasImageContent(realWorldish)).toBe(true);
  });
});
