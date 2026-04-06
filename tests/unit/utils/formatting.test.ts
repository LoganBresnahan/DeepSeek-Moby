/**
 * Tests for FormattingEngine
 */

import { describe, it, expect } from 'vitest';
import { FormattingEngine } from '../../../src/utils/formatting';

describe('FormattingEngine', () => {
  const engine = new FormattingEngine();

  describe('extractCodeFromMarkdown', () => {
    it('strips markdown code block fences with language', () => {
      const input = '```typescript\nconst x = 1;\n```';
      const result = engine.extractCodeFromMarkdown(input);
      expect(result).toBe('const x = 1;');
    });

    it('strips markdown code block fences without language', () => {
      const input = '```\nconst x = 1;\n```';
      // The regex matches ```[\w]* so ``` with no lang still matches
      const result = engine.extractCodeFromMarkdown(input);
      expect(result).toBe('const x = 1;');
    });

    it('strips inline code markers', () => {
      const input = 'Use the `forEach` method';
      const result = engine.extractCodeFromMarkdown(input);
      expect(result).toBe('Use the forEach method');
    });

    it('strips bold markdown', () => {
      const input = 'This is **bold** text';
      const result = engine.extractCodeFromMarkdown(input);
      expect(result).toBe('This is bold text');
    });

    it('strips italic markdown (asterisks)', () => {
      const input = 'This is *italic* text';
      const result = engine.extractCodeFromMarkdown(input);
      expect(result).toBe('This is italic text');
    });

    it('strips italic markdown (underscores)', () => {
      const input = 'This is _italic_ text';
      const result = engine.extractCodeFromMarkdown(input);
      expect(result).toBe('This is italic text');
    });

    it('handles multiline code blocks', () => {
      const input = '```python\ndef hello():\n    print("hi")\n```';
      const result = engine.extractCodeFromMarkdown(input);
      expect(result).toContain('def hello():');
      expect(result).toContain('print("hi")');
    });

    it('returns plain text unchanged (trimmed)', () => {
      const input = 'No markdown here';
      const result = engine.extractCodeFromMarkdown(input);
      expect(result).toBe('No markdown here');
    });

    it('handles empty string', () => {
      const result = engine.extractCodeFromMarkdown('');
      expect(result).toBe('');
    });
  });

  describe('normalizeIndentation', () => {
    it('converts tabs to spaces', () => {
      const input = '\tconst x = 1;';
      const result = engine.normalizeIndentation(input, 2);
      expect(result).not.toContain('\t');
      expect(result).toBe('const x = 1;');
    });

    it('uses default indent size of 2', () => {
      const input = '\t\thello';
      const result = engine.normalizeIndentation(input);
      // Tab -> 2 spaces each, then min-indent stripped
      expect(result).not.toContain('\t');
    });

    it('removes minimum indentation from all lines', () => {
      const input = '    line1\n    line2\n      line3';
      const result = engine.normalizeIndentation(input, 2);
      expect(result).toBe('line1\nline2\n  line3');
    });

    it('preserves empty lines', () => {
      const input = '  line1\n\n  line2';
      const result = engine.normalizeIndentation(input, 2);
      const lines = result.split('\n');
      expect(lines[1]).toBe('');
    });

    it('handles all-empty-lines input', () => {
      const input = '\n\n\n';
      const result = engine.normalizeIndentation(input, 2);
      expect(result).toBe('\n\n\n');
    });

    it('handles single line with no indentation', () => {
      const input = 'no indent';
      const result = engine.normalizeIndentation(input, 2);
      expect(result).toBe('no indent');
    });

    it('handles mixed tabs and spaces', () => {
      const input = '\t  line1\n\t  line2';
      const result = engine.normalizeIndentation(input, 2);
      // Tabs converted, min indent stripped
      expect(result).not.toContain('\t');
    });
  });

  describe('formatCode', () => {
    it('normalizes CRLF to LF', () => {
      const input = 'line1\r\nline2\r\nline3';
      const result = engine.formatCode(input, 'generic');
      expect(result).not.toContain('\r\n');
      expect(result).toContain('line1');
      expect(result).toContain('line2');
    });

    describe('Python formatting', () => {
      it('converts tabs to 4 spaces', () => {
        const input = '\tdef hello():';
        const result = engine.formatCode(input, 'python');
        expect(result).not.toContain('\t');
      });

      it('removes trailing whitespace', () => {
        const input = 'x = 1   \ny = 2  ';
        const result = engine.formatCode(input, 'python');
        const lines = result.split('\n');
        for (const line of lines) {
          expect(line).toBe(line.trimEnd());
        }
      });

      it('adds spacing around operators', () => {
        const input = 'x=1';
        const result = engine.formatCode(input, 'python');
        // Both sides of the operator get spaced: x=1 -> x = 1
        expect(result).toContain('x = 1');
      });

      it('adds spaces after commas', () => {
        const input = 'foo(a,b,c)';
        const result = engine.formatCode(input, 'python');
        expect(result).toContain(', ');
      });
    });

    describe('JavaScript/TypeScript formatting', () => {
      it('converts tabs to 2 spaces', () => {
        const input = '\tconst x = 1;';
        const result = engine.formatCode(input, 'javascript');
        expect(result).not.toContain('\t');
      });

      it('handles typescript alias', () => {
        const input = '\tconst x = 1;';
        const result = engine.formatCode(input, 'typescript');
        expect(result).not.toContain('\t');
      });

      it('handles js alias', () => {
        const input = 'const x=1';
        const result = engine.formatCode(input, 'js');
        // Should go through formatJavaScript path
        expect(result).toBeDefined();
      });

      it('handles ts alias', () => {
        const input = 'const x=1';
        const result = engine.formatCode(input, 'ts');
        expect(result).toBeDefined();
      });

      it('spaces keywords before parens', () => {
        const input = 'if(true) {}';
        const result = engine.formatCode(input, 'javascript');
        expect(result).toContain('if (');
      });
    });

    describe('Java formatting', () => {
      it('converts tabs to 4 spaces', () => {
        const input = '\tint x = 1;';
        const result = engine.formatCode(input, 'java');
        expect(result).not.toContain('\t');
      });
    });

    describe('C++ formatting', () => {
      it('converts tabs to 2 spaces', () => {
        const input = '\tint x = 1;';
        const result = engine.formatCode(input, 'cpp');
        expect(result).not.toContain('\t');
      });

      it('handles c++ alias', () => {
        const input = 'int x=1;';
        const result = engine.formatCode(input, 'c++');
        expect(result).toBeDefined();
      });
    });

    describe('Go formatting', () => {
      it('handles go code', () => {
        const input = 'func main() {}';
        const result = engine.formatCode(input, 'go');
        expect(result).toBeDefined();
      });
    });

    describe('Rust formatting', () => {
      it('converts tabs to 4 spaces', () => {
        const input = '\tlet x = 1;';
        const result = engine.formatCode(input, 'rust');
        expect(result).not.toContain('\t');
      });
    });

    describe('Generic formatting', () => {
      it('removes multiple blank lines', () => {
        const input = 'line1\n\n\n\nline2';
        const result = engine.formatCode(input, 'unknown');
        // Should collapse triple+ newlines to double
        expect(result).not.toContain('\n\n\n');
      });

      it('trims trailing whitespace from lines', () => {
        const input = 'hello   \nworld   ';
        const result = engine.formatCode(input, 'unknown');
        const lines = result.split('\n');
        for (const line of lines) {
          expect(line).toBe(line.trimEnd());
        }
      });
    });
  });
});
