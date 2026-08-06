import { describe, it, expect } from 'vitest';
import { translateCallResult } from '../../../src/mcp/callResult';

const NAME = 'mcp__pharos__hover';

describe('translateCallResult', () => {
  it('concatenates text blocks with a blank line', () => {
    const result = translateCallResult(NAME, {
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' }
      ]
    });
    expect(result).toBe('first\n\nsecond');
  });

  it('maps isError to the Error: prefix the orchestrator keys on', () => {
    const result = translateCallResult(NAME, {
      content: [{ type: 'text', text: 'file not found' }],
      isError: true
    });
    expect(result).toBe('Error: file not found');
    expect(result.startsWith('Error:')).toBe(true);
  });

  it('names an error that carries no message — never a bare "Error:"', () => {
    const result = translateCallResult(NAME, { content: [], isError: true });
    expect(result.startsWith('Error:')).toBe(true);
    expect(result).toContain(NAME);
    expect(result.length).toBeGreaterThan('Error: '.length);
  });

  it('replaces a non-text block with a NAMED placeholder, never silence', () => {
    const result = translateCallResult(NAME, {
      content: [
        { type: 'text', text: 'caption' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' }
      ]
    });
    expect(result).toContain('caption');
    expect(result).toContain('[MCP tool returned image content — not supported yet]');
    expect(result).not.toContain('AAAA');
  });

  it('labels a typeless block as unknown rather than dropping it', () => {
    const result = translateCallResult(NAME, { content: [{}] });
    expect(result).toBe('[MCP tool returned unknown content — not supported yet]');
  });

  it('names an empty result instead of returning an empty string', () => {
    expect(translateCallResult(NAME, { content: [] })).toBe(
      `(MCP tool ${NAME} returned no content)`
    );
    // Missing content entirely — same rule.
    expect(translateCallResult(NAME, {})).toBe(`(MCP tool ${NAME} returned no content)`);
  });

  it('falls back to structuredContent when the server sent no text block', () => {
    const result = translateCallResult(NAME, {
      content: [],
      structuredContent: { symbols: 3 }
    });
    expect(JSON.parse(result)).toEqual({ symbols: 3 });
  });

  it('prefers text blocks over structuredContent when both exist', () => {
    const result = translateCallResult(NAME, {
      content: [{ type: 'text', text: 'serialized' }],
      structuredContent: { other: true }
    });
    expect(result).toBe('serialized');
  });

  it('turns a malformed result into a named error', () => {
    for (const bad of [null, undefined, 'string', 42, []]) {
      const result = translateCallResult(NAME, bad);
      expect(result.startsWith('Error:')).toBe(true);
      expect(result).toContain(NAME);
    }
  });

  it('tolerates a text block whose text is not a string', () => {
    const result = translateCallResult(NAME, {
      content: [{ type: 'text', text: 42 }]
    });
    expect(result).toBe('[MCP tool returned text content — not supported yet]');
  });

  it('keeps the Error: prefix when an error result carries only non-text blocks', () => {
    const result = translateCallResult(NAME, {
      content: [{ type: 'image', data: 'x' }],
      isError: true
    });
    expect(result.startsWith('Error:')).toBe(true);
    expect(result).toContain('not supported yet');
  });
});
