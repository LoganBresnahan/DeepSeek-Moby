import { describe, it, expect } from 'vitest';
import { highlightCode } from '../../../media/utils/syntaxHighlight';

// Helper: extract text content (strip HTML tags, decode entities)
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&#10;/g, '\n')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Helper: check if a span with given class wraps the expected text
function hasSpan(html: string, cls: string, text: string): boolean {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<span class="${cls}">[^<]*${escaped}[^<]*</span>`);
  return re.test(html);
}

describe('syntaxHighlight', () => {
  // ── Fallback behavior ──

  describe('unknown/plain languages', () => {
    it('returns escaped code for unknown language', () => {
      const result = highlightCode('<div>', 'unknownlang');
      expect(result).toBe('&lt;div&gt;');
    });

    it('returns escaped code for empty language', () => {
      const result = highlightCode('hello', '');
      expect(result).toBe('hello');
    });

    it('returns escaped code for "text"', () => {
      const result = highlightCode('hello <world>', 'text');
      expect(result).toBe('hello &lt;world&gt;');
    });

    it('returns escaped code for "plaintext"', () => {
      const result = highlightCode('x & y', 'plaintext');
      expect(result).toBe('x &amp; y');
    });

    it('converts newlines to &#10;', () => {
      const result = highlightCode('a\nb', 'text');
      expect(result).toBe('a&#10;b');
    });
  });

  // ── Language aliases ──

  describe('language aliases', () => {
    it('resolves js to javascript', () => {
      const result = highlightCode('const x = 1;', 'js');
      expect(hasSpan(result, 'hl-keyword', 'const')).toBe(true);
    });

    it('resolves ts to typescript', () => {
      const result = highlightCode('interface Foo {}', 'ts');
      expect(hasSpan(result, 'hl-keyword', 'interface')).toBe(true);
    });

    it('resolves py to python', () => {
      const result = highlightCode('def foo():', 'py');
      expect(hasSpan(result, 'hl-keyword', 'def')).toBe(true);
    });

    it('resolves sh to bash', () => {
      const result = highlightCode('if [ -f file ]; then', 'sh');
      expect(hasSpan(result, 'hl-keyword', 'if')).toBe(true);
    });

    it('resolves cs to csharp', () => {
      const result = highlightCode('namespace Foo {}', 'cs');
      expect(hasSpan(result, 'hl-keyword', 'namespace')).toBe(true);
    });
  });

  // ── Standard tokenizer: Keywords ──

  describe('keyword highlighting', () => {
    it('highlights JavaScript keywords', () => {
      const result = highlightCode('function foo() { return true; }', 'javascript');
      expect(hasSpan(result, 'hl-keyword', 'function')).toBe(true);
      expect(hasSpan(result, 'hl-keyword', 'return')).toBe(true);
      expect(hasSpan(result, 'hl-keyword', 'true')).toBe(true);
    });

    it('highlights Python keywords', () => {
      const result = highlightCode('if x is not None:\n  pass', 'python');
      expect(hasSpan(result, 'hl-keyword', 'if')).toBe(true);
      expect(hasSpan(result, 'hl-keyword', 'is')).toBe(true);
      expect(hasSpan(result, 'hl-keyword', 'not')).toBe(true);
      expect(hasSpan(result, 'hl-keyword', 'None')).toBe(true);
      expect(hasSpan(result, 'hl-keyword', 'pass')).toBe(true);
    });

    it('highlights Go keywords', () => {
      const result = highlightCode('func main() { defer close(ch) }', 'go');
      expect(hasSpan(result, 'hl-keyword', 'func')).toBe(true);
      expect(hasSpan(result, 'hl-keyword', 'defer')).toBe(true);
    });

    it('highlights Rust keywords', () => {
      const result = highlightCode('fn main() { let mut x = 5; }', 'rust');
      expect(hasSpan(result, 'hl-keyword', 'fn')).toBe(true);
      expect(hasSpan(result, 'hl-keyword', 'let')).toBe(true);
      expect(hasSpan(result, 'hl-keyword', 'mut')).toBe(true);
    });

    it('does not highlight non-keywords', () => {
      const result = highlightCode('const myVar = foo;', 'javascript');
      expect(hasSpan(result, 'hl-keyword', 'myVar')).toBe(false);
      expect(hasSpan(result, 'hl-keyword', 'foo')).toBe(false);
    });
  });

  // ── Standard tokenizer: Types ──

  describe('type highlighting', () => {
    it('highlights TypeScript types', () => {
      const result = highlightCode('let x: string = "hi";', 'typescript');
      expect(hasSpan(result, 'hl-type', 'string')).toBe(true);
    });

    it('highlights Go types', () => {
      const result = highlightCode('var x int = 42', 'go');
      expect(hasSpan(result, 'hl-type', 'int')).toBe(true);
    });

    it('highlights Rust types', () => {
      const result = highlightCode('let v: Vec<i32> = vec![];', 'rust');
      expect(hasSpan(result, 'hl-type', 'Vec')).toBe(true);
      expect(hasSpan(result, 'hl-type', 'i32')).toBe(true);
    });
  });

  // ── Standard tokenizer: Built-ins ──

  describe('builtin highlighting', () => {
    it('highlights Python builtins', () => {
      const result = highlightCode('print(len(items))', 'python');
      expect(hasSpan(result, 'hl-builtin', 'print')).toBe(true);
      expect(hasSpan(result, 'hl-builtin', 'len')).toBe(true);
    });

    it('highlights JavaScript builtins', () => {
      const result = highlightCode('console.log(JSON.parse(x))', 'javascript');
      expect(hasSpan(result, 'hl-builtin', 'console')).toBe(true);
      expect(hasSpan(result, 'hl-builtin', 'JSON')).toBe(true);
    });
  });

  // ── Standard tokenizer: Strings ──

  describe('string highlighting', () => {
    it('highlights double-quoted strings', () => {
      const result = highlightCode('const s = "hello world";', 'javascript');
      expect(hasSpan(result, 'hl-string', '&quot;hello world&quot;')).toBe(true);
    });

    it('highlights single-quoted strings', () => {
      const result = highlightCode("x = 'test'", 'python');
      expect(result).toContain('<span class="hl-string">');
    });

    it('highlights template literals', () => {
      const result = highlightCode('const s = `hello`;', 'javascript');
      expect(result).toContain('<span class="hl-string">');
    });

    it('handles escaped quotes', () => {
      const result = highlightCode('s = "he said \\"hi\\""', 'python');
      expect(result).toContain('<span class="hl-string">');
      // The entire string including escapes should be one span
      const stringSpans = result.match(/<span class="hl-string">[^<]+<\/span>/g);
      expect(stringSpans).toHaveLength(1);
    });

    it('highlights Python triple-quoted strings', () => {
      const result = highlightCode('s = """multi\nline"""', 'python');
      expect(result).toContain('<span class="hl-string">');
    });

    it('does not highlight keywords inside strings', () => {
      const result = highlightCode('s = "if else return"', 'python');
      // "if else return" should be in ONE string span, not individual keyword spans
      expect(hasSpan(result, 'hl-keyword', 'if')).toBe(false);
    });
  });

  // ── Standard tokenizer: Comments ──

  describe('comment highlighting', () => {
    it('highlights C-style line comments', () => {
      const result = highlightCode('x = 1; // comment', 'javascript');
      expect(hasSpan(result, 'hl-comment', '// comment')).toBe(true);
    });

    it('highlights hash comments', () => {
      const result = highlightCode('x = 1  # comment', 'python');
      expect(hasSpan(result, 'hl-comment', '# comment')).toBe(true);
    });

    it('highlights block comments', () => {
      const result = highlightCode('/* block */\nx = 1;', 'javascript');
      expect(hasSpan(result, 'hl-comment', '/* block */')).toBe(true);
    });

    it('highlights SQL double-dash comments', () => {
      const result = highlightCode('SELECT * FROM t; -- comment', 'sql');
      expect(hasSpan(result, 'hl-comment', '-- comment')).toBe(true);
    });

    it('highlights Lua block comments', () => {
      const result = highlightCode('--[[ block comment ]]', 'lua');
      expect(hasSpan(result, 'hl-comment', '--[[ block comment ]]')).toBe(true);
    });

    it('does not highlight keywords inside comments', () => {
      const result = highlightCode('// function return class', 'javascript');
      expect(hasSpan(result, 'hl-keyword', 'function')).toBe(false);
    });
  });

  // ── Standard tokenizer: Numbers ──

  describe('number highlighting', () => {
    it('highlights integers', () => {
      const result = highlightCode('x = 42', 'python');
      expect(hasSpan(result, 'hl-number', '42')).toBe(true);
    });

    it('highlights floats', () => {
      const result = highlightCode('x = 3.14', 'python');
      expect(hasSpan(result, 'hl-number', '3.14')).toBe(true);
    });

    it('highlights hex numbers', () => {
      const result = highlightCode('x = 0xFF', 'javascript');
      expect(hasSpan(result, 'hl-number', '0xFF')).toBe(true);
    });

    it('highlights binary numbers', () => {
      const result = highlightCode('x = 0b1010', 'python');
      expect(hasSpan(result, 'hl-number', '0b1010')).toBe(true);
    });
  });

  // ── Preprocessor directives ──

  describe('preprocessor directives', () => {
    it('highlights C preprocessor as keyword', () => {
      const result = highlightCode('#include <stdio.h>\nint main() {}', 'c');
      expect(hasSpan(result, 'hl-keyword', '#include &lt;stdio.h&gt;')).toBe(true);
    });

    it('highlights C++ #define', () => {
      const result = highlightCode('#define MAX 100', 'cpp');
      expect(hasSpan(result, 'hl-keyword', '#define MAX 100')).toBe(true);
    });

    it('does not treat # as preprocessor in Python', () => {
      const result = highlightCode('# this is a comment', 'python');
      expect(hasSpan(result, 'hl-comment', '# this is a comment')).toBe(true);
    });
  });

  // ── HTML / XML tokenizer ──

  describe('HTML highlighting', () => {
    it('highlights tag names', () => {
      const result = highlightCode('<div class="foo">text</div>', 'html');
      expect(hasSpan(result, 'hl-tag', '&lt;div')).toBe(true);
      expect(hasSpan(result, 'hl-tag', '&lt;/div')).toBe(true);
    });

    it('highlights attribute names', () => {
      const result = highlightCode('<div class="foo">', 'html');
      expect(hasSpan(result, 'hl-attr', 'class')).toBe(true);
    });

    it('highlights attribute values as strings', () => {
      const result = highlightCode('<div class="foo">', 'html');
      expect(hasSpan(result, 'hl-string', '&quot;foo&quot;')).toBe(true);
    });

    it('highlights HTML comments', () => {
      const result = highlightCode('<!-- comment -->', 'html');
      expect(hasSpan(result, 'hl-comment', '&lt;!-- comment --&gt;')).toBe(true);
    });

    it('highlights self-closing tags', () => {
      const result = highlightCode('<br />', 'html');
      expect(hasSpan(result, 'hl-tag', '&lt;br')).toBe(true);
    });

    it('highlights DOCTYPE', () => {
      const result = highlightCode('<!DOCTYPE html>', 'html');
      expect(hasSpan(result, 'hl-keyword', '&lt;!DOCTYPE html&gt;')).toBe(true);
    });

    it('resolves xml alias', () => {
      const result = highlightCode('<root attr="val"/>', 'xml');
      expect(hasSpan(result, 'hl-tag', '&lt;root')).toBe(true);
    });
  });

  // ── CSS tokenizer ──

  describe('CSS highlighting', () => {
    it('highlights @-rules as keywords', () => {
      const result = highlightCode('@media screen {}', 'css');
      expect(hasSpan(result, 'hl-keyword', '@media')).toBe(true);
    });

    it('highlights class selectors', () => {
      const result = highlightCode('.foo { }', 'css');
      expect(hasSpan(result, 'hl-selector', '.foo')).toBe(true);
    });

    it('highlights id selectors', () => {
      const result = highlightCode('#bar { }', 'css');
      expect(hasSpan(result, 'hl-selector', '#bar')).toBe(true);
    });

    it('highlights property names inside blocks', () => {
      const result = highlightCode('.foo { color: red; }', 'css');
      expect(hasSpan(result, 'hl-property', 'color')).toBe(true);
    });

    it('highlights numbers with units', () => {
      const result = highlightCode('.foo { margin: 10px; }', 'css');
      expect(hasSpan(result, 'hl-number', '10px')).toBe(true);
    });

    it('highlights CSS comments', () => {
      const result = highlightCode('/* comment */ .foo {}', 'css');
      expect(hasSpan(result, 'hl-comment', '/* comment */')).toBe(true);
    });

    it('highlights pseudo-selectors', () => {
      const result = highlightCode('.foo:hover { }', 'css');
      expect(hasSpan(result, 'hl-selector', ':hover')).toBe(true);
    });
  });

  // ── JSON ──

  describe('JSON highlighting', () => {
    it('highlights boolean keywords', () => {
      const result = highlightCode('{ "a": true, "b": false, "c": null }', 'json');
      expect(hasSpan(result, 'hl-keyword', 'true')).toBe(true);
      expect(hasSpan(result, 'hl-keyword', 'false')).toBe(true);
      expect(hasSpan(result, 'hl-keyword', 'null')).toBe(true);
    });

    it('highlights strings', () => {
      const result = highlightCode('{ "key": "value" }', 'json');
      expect(result).toContain('<span class="hl-string">');
    });

    it('highlights numbers', () => {
      const result = highlightCode('{ "n": 42 }', 'json');
      expect(hasSpan(result, 'hl-number', '42')).toBe(true);
    });
  });

  // ── Preserves text content for Copy button ──

  describe('text content preservation', () => {
    it('textContent matches original code after stripping tags', () => {
      const code = 'function foo(x) {\n  if (x > 0) return "yes";\n  // comment\n  return null;\n}';
      const html = highlightCode(code, 'javascript');
      expect(textOf(html)).toBe(code);
    });

    it('preserves text for Python code', () => {
      const code = 'def greet(name):\n    print(f"Hello {name}")\n    # comment\n    return True';
      const html = highlightCode(code, 'python');
      expect(textOf(html)).toBe(code);
    });

    it('preserves text for HTML code', () => {
      const code = '<div class="foo"><!-- comment --><span>text</span></div>';
      const html = highlightCode(code, 'html');
      expect(textOf(html)).toBe(code);
    });

    it('preserves text for CSS code', () => {
      const code = '.foo { color: red; /* comment */ margin: 10px; }';
      const html = highlightCode(code, 'css');
      expect(textOf(html)).toBe(code);
    });
  });

  // ── Edge cases ──

  describe('edge cases', () => {
    it('handles empty code', () => {
      expect(highlightCode('', 'javascript')).toBe('');
    });

    it('handles code with only whitespace', () => {
      const result = highlightCode('   \n  ', 'python');
      expect(textOf(result)).toBe('   \n  ');
    });

    it('handles unclosed string', () => {
      const result = highlightCode('x = "unclosed', 'python');
      expect(result).toContain('<span class="hl-string">');
      expect(textOf(result)).toBe('x = "unclosed');
    });

    it('handles unclosed block comment', () => {
      const result = highlightCode('/* unclosed comment', 'javascript');
      expect(result).toContain('<span class="hl-comment">');
      expect(textOf(result)).toBe('/* unclosed comment');
    });

    it('handles special HTML characters in code', () => {
      const result = highlightCode('if (a < b && c > d) {}', 'javascript');
      expect(result).toContain('&lt;');
      expect(result).toContain('&gt;');
      expect(result).toContain('&amp;');
    });

    it('handles code with no highlightable tokens', () => {
      const result = highlightCode('x y z', 'javascript');
      expect(result).toBe('x y z');
    });
  });

  // ── Language coverage spot checks ──

  describe('language coverage', () => {
    const languageSamples: [string, string, string][] = [
      ['java', 'public class Main {}', 'public'],
      ['csharp', 'namespace Foo { class Bar {} }', 'namespace'],
      ['ruby', 'def hello; end', 'def'],
      ['swift', 'func greet() -> String {}', 'func'],
      ['kotlin', 'fun main(args: Array<String>) {}', 'fun'],
      ['dart', 'void main() { var x = 1; }', 'void'],
      ['lua', 'local x = 1; while true do end', 'local'],
      ['haskell', 'module Main where', 'module'],
      ['elixir', 'defmodule Foo do end', 'defmodule'],
      ['perl', 'use strict; my $x = 1;', 'use'],
      ['powershell', 'function Get-Item { param() }', 'function'],
      ['sql', 'SELECT * FROM users WHERE id = 1;', 'SELECT'],
      ['r', 'for (i in 1:10) { print(i) }', 'for'],
      ['scala', 'object Main extends App {}', 'object'],
      ['fortran', 'program hello; end program', 'program'],
      ['ada', 'procedure Hello is begin null; end Hello;', 'procedure'],
      ['pascal', 'program Hello; begin end.', 'program'],
      ['fsharp', 'let x = 42 in x', 'let'],
      ['ocaml', 'let x = 42 in x', 'let'],
      ['zig', 'const std = @import("std");', 'const'],
      ['nim', 'proc hello() = echo "hi"', 'proc'],
      ['solidity', 'contract MyToken { function mint() public {} }', 'contract'],
      ['dockerfile', 'FROM node:18\nRUN npm install', 'FROM'],
      ['bash', 'if [ -f file ]; then echo "yes"; fi', 'if'],
      ['yaml', 'key: true', 'true'],
      ['toml', 'enabled = true', 'true'],
    ];

    languageSamples.forEach(([lang, code, expectedKeyword]) => {
      it(`highlights ${lang} keyword "${expectedKeyword}"`, () => {
        const result = highlightCode(code, lang);
        expect(hasSpan(result, 'hl-keyword', expectedKeyword)).toBe(true);
      });
    });
  });
});
