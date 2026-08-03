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
import { countRequestChars, EstimationTokenCounter } from '../../src/services/tokenCounter';

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

/**
 * The other calibration poisoner, found 2026-08-03 in the same dev-host run:
 * the sample's char count covered message content only, while the API's
 * prompt_tokens bills messages + tool-call metadata + the tools JSON. A short
 * tool-bearing turn (11 tool schemas dwarfing a one-line question) inflated
 * the ratio to 0.7642 tokens/char — ~3× the English norm — and the next
 * estimate overshot the API by 3.4× (ours=10,187 vs api=3,012). The image
 * correlation in the original bug report was incidental: image turns are
 * short turns, so the uncounted tools share dominates exactly there.
 */
describe('countRequestChars (calibration numerator)', () => {
  const TOOLS = [
    { type: 'function', function: { name: 'read_file', description: 'Read a file from disk', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
    { type: 'function', function: { name: 'write_file', description: 'Write a file to disk', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } } }
  ];

  it('counts plain string content', () => {
    expect(countRequestChars([{ role: 'user', content: 'hello' }])).toBe(5);
  });

  it('includes the tools-definition JSON — the share the old count dropped', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    const withoutTools = countRequestChars(messages);
    const withTools = countRequestChars(messages, TOOLS);
    expect(withTools).toBe(withoutTools + JSON.stringify(TOOLS).length);
  });

  it('includes tool-call names, arguments, and tool_call_id linkage', () => {
    const chars = countRequestChars([
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
      { role: 'tool', content: 'file body', tool_call_id: 'call_1' }
    ]);
    expect(chars).toBe('read_file'.length + '{"path":"a.ts"}'.length + 'file body'.length + 'call_1'.length);
  });

  it('stringifies array content like the token counter path it mirrors', () => {
    const content = [{ type: 'text', text: 'look' }];
    expect(countRequestChars([{ role: 'user', content }])).toBe(JSON.stringify(content).length);
  });

  it('a tool-heavy short turn no longer inflates the calibrated ratio', () => {
    // Model the failing sample's SHAPE: ~600 chars of message content, a
    // tools payload several times that size, and an API count that bills
    // both at a sane ~0.25 tokens/char.
    const messages = [{ role: 'user', content: 'q'.repeat(600) }];
    const bigTools = [{ type: 'function', function: { name: 'x', description: 'y'.repeat(3000), parameters: {} } }];
    const apiTokens = Math.round((600 + JSON.stringify(bigTools).length) * 0.25);

    const poisoned = new EstimationTokenCounter();
    poisoned.calibrate(600, apiTokens);                     // old numerator: messages only

    const honest = new EstimationTokenCounter();
    honest.calibrate(countRequestChars(messages, bigTools), apiTokens);

    // The old sample lands ~6× the true ratio; the fixed one is within 5%.
    expect(poisoned.ratio).toBeGreaterThan(1.0);
    expect(honest.ratio).toBeGreaterThan(0.23);
    expect(honest.ratio).toBeLessThan(0.27);
  });
});
