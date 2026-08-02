/**
 * image-describe role (plan Phase 2).
 *
 * The role is pure — no vscode, no transport — so everything here is about the
 * contract it offers the router: image content in, validated digest out, null
 * on anything it can't trust.
 */

import { describe, it, expect } from 'vitest';
import { makeImageDescribeRole, DIGEST_PREFIX } from '../../../../src/subagents/roles/imageDescribe';

const role = makeImageDescribeRole();
const input = { dataUrl: 'data:image/webp;base64,AAAA', name: 'screenshot.png' };

describe('image-describe role', () => {
  describe('identity + gating', () => {
    it('declares the image-describe role name', () => {
      expect(role.name).toBe('image-describe');
    });

    it('requires image support so a text-only backend is never selected', () => {
      expect(role.requiresImageSupport).toBe(true);
    });

    it('routes whenever there is an image — attaching one IS the request', () => {
      expect(role.shouldRoute(input)).toBe(true);
    });

    it('refuses to route an empty payload', () => {
      expect(role.shouldRoute({ dataUrl: '', name: 'x.png' })).toBe(false);
    });
  });

  describe('buildUserContent', () => {
    it('emits a text part and an image_url part', () => {
      const content = role.buildUserContent!(input);
      expect(Array.isArray(content)).toBe(true);
      const parts = content as Array<Record<string, any>>;
      expect(parts[0]).toEqual({ type: 'text', text: 'Describe this image (filename: screenshot.png).' });
      expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: input.dataUrl } });
    });

    it('keeps a string fallback in buildUserMessage', () => {
      expect(typeof role.buildUserMessage(input)).toBe('string');
      expect(role.buildUserMessage(input)).toContain('screenshot.png');
    });
  });

  describe('buildSystemPrompt', () => {
    it('biases toward the user task when one is present', () => {
      const prompt = role.buildSystemPrompt({ recentUserPrompt: 'why is my button misaligned' });
      expect(prompt).toContain('why is my button misaligned');
    });

    it('stands alone when there is no user prompt', () => {
      const prompt = role.buildSystemPrompt({ recentUserPrompt: '' });
      expect(prompt).toContain('no accompanying prompt');
    });

    it('truncates a very long user prompt', () => {
      const prompt = role.buildSystemPrompt({ recentUserPrompt: 'x'.repeat(2000) });
      expect(prompt).toContain('…');
      expect(prompt.length).toBeLessThan(2000);
    });

    it('instructs verbatim transcription — the highest-value part for screenshots', () => {
      const prompt = role.buildSystemPrompt({ recentUserPrompt: '' });
      expect(prompt).toContain('VERBATIM');
    });

    it('forbids inventing detail', () => {
      const prompt = role.buildSystemPrompt({ recentUserPrompt: '' });
      expect(prompt.toLowerCase()).toContain('never guess');
    });
  });

  describe('parse', () => {
    it('accepts a minimal valid response', () => {
      expect(role.parse({ description: 'a whale' })).toEqual({ description: 'a whale' });
    });

    it('accepts the full shape', () => {
      expect(role.parse({ description: 'a form', text: 'Submit', caveats: 'blurry' })).toEqual({
        description: 'a form',
        text: 'Submit',
        caveats: 'blurry'
      });
    });

    it('rejects a missing description', () => {
      expect(role.parse({ text: 'only text' })).toBeNull();
    });

    it('rejects an empty or whitespace description', () => {
      expect(role.parse({ description: '' })).toBeNull();
      expect(role.parse({ description: '   ' })).toBeNull();
    });

    it('rejects non-string description', () => {
      expect(role.parse({ description: 42 })).toBeNull();
    });

    it('rejects garbage', () => {
      expect(role.parse(null)).toBeNull();
      expect(role.parse('a string')).toBeNull();
      expect(role.parse([])).toBeNull();
    });

    it('drops optional fields of the wrong type rather than failing', () => {
      expect(role.parse({ description: 'ok', text: 99, caveats: {} })).toEqual({ description: 'ok' });
    });
  });

  describe('formatForMain', () => {
    it('marks the digest as second-hand', () => {
      const out = role.formatForMain({ description: 'a whale' }, input);
      expect(out).toContain(DIGEST_PREFIX);
      expect(out).toContain('cannot see the image');
      expect(out).toContain('screenshot.png');
    });

    it('fences transcribed text so code survives intact', () => {
      const out = role.formatForMain({ description: 'code', text: 'const x = 1;' }, input);
      expect(out).toContain('```');
      expect(out).toContain('const x = 1;');
    });

    it('surfaces caveats', () => {
      const out = role.formatForMain({ description: 'a chart', caveats: 'axis labels illegible' }, input);
      expect(out).toContain('Uncertain: axis labels illegible');
    });

    it('omits empty sections', () => {
      const out = role.formatForMain({ description: 'plain' }, input);
      expect(out).not.toContain('```');
      expect(out).not.toContain('Uncertain');
    });
  });
});
