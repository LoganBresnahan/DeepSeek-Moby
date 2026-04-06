/**
 * Tests for DSML Parser - DeepSeek Markup Language tool call parsing
 */

import { describe, it, expect } from 'vitest';
import {
  parseDSMLToolCalls,
  containsDSML,
  stripDSML,
  type DSMLToolCall
} from '../../../src/utils/dsmlParser';

describe('dsmlParser', () => {
  describe('parseDSMLToolCalls', () => {
    it('parses a single tool call with parameters', () => {
      const content = `<｜DSML｜function_calls> <｜DSML｜invoke name="read_file"> <｜DSML｜parameter name="path" string="true">src/main.ts<｜DSML｜parameter> </｜DSML｜invoke> </｜DSML｜function_calls>`;

      const result = parseDSMLToolCalls(content);

      expect(result).not.toBeNull();
      expect(result).toHaveLength(1);
      expect(result![0].name).toBe('read_file');
      expect(result![0].arguments.path).toBe('src/main.ts');
      expect(result![0].id).toMatch(/^dsml_call_0_/);
    });

    it('parses a tool call with multiple parameters', () => {
      const content = `<｜DSML｜function_calls> <｜DSML｜invoke name="write_file"> <｜DSML｜parameter name="path" string="true">test.ts<｜DSML｜parameter> <｜DSML｜parameter name="content" string="true">hello world<｜DSML｜parameter> </｜DSML｜invoke> </｜DSML｜function_calls>`;

      const result = parseDSMLToolCalls(content);

      expect(result).not.toBeNull();
      expect(result).toHaveLength(1);
      expect(result![0].name).toBe('write_file');
      expect(result![0].arguments.path).toBe('test.ts');
      expect(result![0].arguments.content).toBe('hello world');
    });

    it('parses multiple tool calls in one block', () => {
      const content = `<｜DSML｜function_calls> <｜DSML｜invoke name="read_file"> <｜DSML｜parameter name="path" string="true">a.ts<｜DSML｜parameter> </｜DSML｜invoke> <｜DSML｜invoke name="read_file"> <｜DSML｜parameter name="path" string="true">b.ts<｜DSML｜parameter> </｜DSML｜invoke> </｜DSML｜function_calls>`;

      const result = parseDSMLToolCalls(content);

      expect(result).not.toBeNull();
      expect(result).toHaveLength(2);
      expect(result![0].name).toBe('read_file');
      expect(result![0].arguments.path).toBe('a.ts');
      expect(result![1].name).toBe('read_file');
      expect(result![1].arguments.path).toBe('b.ts');
    });

    it('assigns incrementing IDs to multiple tool calls', () => {
      const content = `<｜DSML｜function_calls> <｜DSML｜invoke name="foo"> <｜DSML｜parameter name="x" string="true">1<｜DSML｜parameter> </｜DSML｜invoke> <｜DSML｜invoke name="bar"> <｜DSML｜parameter name="y" string="true">2<｜DSML｜parameter> </｜DSML｜invoke> </｜DSML｜function_calls>`;

      const result = parseDSMLToolCalls(content);

      expect(result).not.toBeNull();
      expect(result![0].id).toMatch(/^dsml_call_0_/);
      expect(result![1].id).toMatch(/^dsml_call_1_/);
    });

    it('returns null for plain text without DSML', () => {
      const result = parseDSMLToolCalls('This is just regular text.');
      expect(result).toBeNull();
    });

    it('returns null for empty string', () => {
      const result = parseDSMLToolCalls('');
      expect(result).toBeNull();
    });

    it('returns null for undefined-like empty content', () => {
      const result = parseDSMLToolCalls('' as string);
      expect(result).toBeNull();
    });

    it('returns null when DSML markers are present but no invoke blocks', () => {
      const content = `<｜DSML｜function_calls> </｜DSML｜function_calls>`;
      const result = parseDSMLToolCalls(content);
      expect(result).toBeNull();
    });

    it('handles tool call with no parameters', () => {
      const content = `<｜DSML｜function_calls> <｜DSML｜invoke name="list_files"> </｜DSML｜invoke> </｜DSML｜function_calls>`;

      const result = parseDSMLToolCalls(content);

      expect(result).not.toBeNull();
      expect(result).toHaveLength(1);
      expect(result![0].name).toBe('list_files');
      expect(result![0].arguments).toEqual({});
    });

    it('handles DSML without closing function_calls tag', () => {
      const content = `<｜DSML｜function_calls> <｜DSML｜invoke name="read_file"> <｜DSML｜parameter name="path" string="true">test.ts<｜DSML｜parameter> </｜DSML｜invoke>`;

      const result = parseDSMLToolCalls(content);

      expect(result).not.toBeNull();
      expect(result).toHaveLength(1);
      expect(result![0].name).toBe('read_file');
    });

    it('trims parameter values', () => {
      const content = `<｜DSML｜function_calls> <｜DSML｜invoke name="read_file"> <｜DSML｜parameter name="path" string="true">  spaced.ts  <｜DSML｜parameter> </｜DSML｜invoke> </｜DSML｜function_calls>`;

      const result = parseDSMLToolCalls(content);

      expect(result).not.toBeNull();
      expect(result![0].arguments.path).toBe('spaced.ts');
    });

    it('handles multiline DSML content', () => {
      const content = `Some text before
<｜DSML｜function_calls>
<｜DSML｜invoke name="write_file">
<｜DSML｜parameter name="path" string="true">file.ts<｜DSML｜parameter>
<｜DSML｜parameter name="content" string="true">line1<｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜function_calls>
Some text after`;

      const result = parseDSMLToolCalls(content);

      expect(result).not.toBeNull();
      expect(result).toHaveLength(1);
      expect(result![0].name).toBe('write_file');
      expect(result![0].arguments.path).toBe('file.ts');
    });
  });

  describe('containsDSML', () => {
    it('returns true for content with DSML markers', () => {
      expect(containsDSML('<｜DSML｜function_calls>')).toBe(true);
    });

    it('returns true when DSML is embedded in other text', () => {
      expect(containsDSML('Some text <｜DSML｜invoke name="foo"> more text')).toBe(true);
    });

    it('returns false for plain text', () => {
      expect(containsDSML('This is just regular text.')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(containsDSML('')).toBe(false);
    });

    it('returns false for HTML-like content that is not DSML', () => {
      expect(containsDSML('<div>some html</div>')).toBe(false);
    });

    it('returns false for content with partial DSML-like markers', () => {
      expect(containsDSML('<DSML>')).toBe(false);
      expect(containsDSML('DSML function_calls')).toBe(false);
    });
  });

  describe('stripDSML', () => {
    it('removes DSML function_calls block entirely', () => {
      const content = `Hello <｜DSML｜function_calls> <｜DSML｜invoke name="read_file"> <｜DSML｜parameter name="path" string="true">test.ts<｜DSML｜parameter> </｜DSML｜invoke> </｜DSML｜function_calls> world`;

      const result = stripDSML(content);

      expect(result).toBe('Hello  world');
    });

    it('returns input unchanged when no DSML is present', () => {
      const text = 'No DSML content here.';
      expect(stripDSML(text)).toBe(text);
    });

    it('handles empty string', () => {
      expect(stripDSML('')).toBe('');
    });

    it('preserves text before DSML block', () => {
      const content = `Here is some analysis. <｜DSML｜function_calls> <｜DSML｜invoke name="foo"> </｜DSML｜invoke> </｜DSML｜function_calls>`;

      const result = stripDSML(content);

      expect(result).toBe('Here is some analysis.');
    });

    it('preserves text after DSML block', () => {
      const content = `<｜DSML｜function_calls> <｜DSML｜invoke name="foo"> </｜DSML｜invoke> </｜DSML｜function_calls> Done.`;

      const result = stripDSML(content);

      expect(result).toBe('Done.');
    });

    it('strips DSML without closing function_calls tag', () => {
      const content = `Text <｜DSML｜function_calls> <｜DSML｜invoke name="foo"> </｜DSML｜invoke>`;

      const result = stripDSML(content);

      expect(result).toBe('Text');
    });

    it('handles multiline DSML content', () => {
      const content = `Analysis:\n<｜DSML｜function_calls>\n<｜DSML｜invoke name="read_file">\n<｜DSML｜parameter name="path" string="true">test.ts<｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜function_calls>\nEnd.`;

      const result = stripDSML(content);

      expect(result).toContain('Analysis:');
    });
  });
});
