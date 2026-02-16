import { describe, it, expect } from 'vitest';
import { extractCodeBlocks, hasIncompleteFence } from '../../../src/utils/codeBlocks';

describe('extractCodeBlocks', () => {
  it('should extract a simple code block', () => {
    const text = '```typescript\nconst x = 1;\n```';
    const blocks = extractCodeBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].language).toBe('typescript');
    expect(blocks[0].content).toBe('const x = 1;');
    expect(blocks[0].raw).toBe(text);
    expect(blocks[0].startIndex).toBe(0);
    expect(blocks[0].endIndex).toBe(text.length);
  });

  it('should extract multiple code blocks', () => {
    const text = 'Hello\n```js\nfoo();\n```\nMiddle\n```py\nbar()\n```\nEnd';
    const blocks = extractCodeBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].language).toBe('js');
    expect(blocks[0].content).toBe('foo();');
    expect(blocks[1].language).toBe('py');
    expect(blocks[1].content).toBe('bar()');
  });

  it('should handle code block without language tag', () => {
    const text = '```\nplain code\n```';
    const blocks = extractCodeBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].language).toBe('plaintext');
    expect(blocks[0].content).toBe('plain code');
  });

  it('should handle nested fences with longer outer fence', () => {
    // 4-backtick outer fence should NOT be closed by 3-backtick inner fence
    const text = [
      '````markdown',
      '# Example',
      '```elixir',
      'IO.puts("hello")',
      '```',
      '````',
    ].join('\n');
    const blocks = extractCodeBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].language).toBe('markdown');
    expect(blocks[0].content).toBe('# Example\n```elixir\nIO.puts("hello")\n```');
  });

  it('should handle deeply nested fences', () => {
    const text = [
      '`````markdown',
      'Outer content',
      '````elixir',
      'defmodule Foo do',
      '```',
      'inner triple',
      '```',
      '````',
      'More outer',
      '`````',
    ].join('\n');
    const blocks = extractCodeBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].language).toBe('markdown');
    // The entire content between outer fences, including inner fences
    expect(blocks[0].content).toContain('````elixir');
    expect(blocks[0].content).toContain('inner triple');
    expect(blocks[0].content).toContain('````');
  });

  it('should handle tilde fences', () => {
    const text = '~~~python\nprint("hi")\n~~~';
    const blocks = extractCodeBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].language).toBe('python');
    expect(blocks[0].content).toBe('print("hi")');
  });

  it('should not cross tilde and backtick fence types', () => {
    // Backtick fence should not be closed by tilde fence
    const text = '```typescript\nconst x = 1;\n~~~\nmore code\n```';
    const blocks = extractCodeBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe('const x = 1;\n~~~\nmore code');
  });

  it('should handle empty code block', () => {
    const text = '```\n```';
    const blocks = extractCodeBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe('');
    expect(blocks[0].language).toBe('plaintext');
  });

  it('should skip unclosed fence at end (streaming scenario)', () => {
    const text = 'Hello\n```typescript\nconst x = 1;\nconst y = 2;';
    const blocks = extractCodeBlocks(text);
    expect(blocks).toHaveLength(0);
  });

  it('should extract completed blocks before an unclosed fence', () => {
    const text = '```js\nfoo();\n```\nSome text\n```py\nbar();';
    const blocks = extractCodeBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].language).toBe('js');
    expect(blocks[0].content).toBe('foo();');
  });

  it('should compute correct startIndex and endIndex', () => {
    const prefix = 'Some prefix text\n';
    const codeBlock = '```ts\ncode\n```';
    const suffix = '\nSome suffix';
    const text = prefix + codeBlock + suffix;
    const blocks = extractCodeBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].startIndex).toBe(prefix.length);
    // endIndex includes trailing newline when more text follows (for clean replacement)
    expect(blocks[0].endIndex).toBe(prefix.length + codeBlock.length + 1);
  });

  it('should compute endIndex without trailing newline at end of text', () => {
    const text = '```ts\ncode\n```';
    const blocks = extractCodeBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].startIndex).toBe(0);
    expect(blocks[0].endIndex).toBe(text.length);
  });

  it('should handle the R1 nested SEARCH/REPLACE scenario', () => {
    // This is the real-world case: R1 wraps code in ````markdown
    // and the inner content contains ```elixir fences
    const text = [
      'Here is the file:',
      '````markdown',
      '# File: lib/example.ex',
      '<<<<<<< SEARCH',
      '=======',
      '```elixir',
      'defmodule Example do',
      '  def hello, do: "world"',
      'end',
      '```',
      '>>>>>>> REPLACE',
      '````',
    ].join('\n');
    const blocks = extractCodeBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].language).toBe('markdown');
    expect(blocks[0].content).toContain('<<<<<<< SEARCH');
    expect(blocks[0].content).toContain('>>>>>>> REPLACE');
    expect(blocks[0].content).toContain('```elixir');
  });

  it('should handle closing fence with more backticks than opening', () => {
    // A closing fence can have MORE backticks than the opening
    const text = '```ts\ncode\n`````';
    const blocks = extractCodeBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe('code');
  });

  it('should handle whitespace after closing fence', () => {
    const text = '```ts\ncode\n```   ';
    const blocks = extractCodeBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe('code');
  });

  it('should not match fence with info string on closing', () => {
    // CommonMark: closing fence must not have info string
    // Our regex requires only fence chars + optional whitespace
    const text = '```ts\ncode\n```ts\nmore\n```';
    const blocks = extractCodeBlocks(text);
    expect(blocks).toHaveLength(1);
    // The ```ts line is not a valid closing fence, so content continues
    expect(blocks[0].content).toBe('code\n```ts\nmore');
  });

  it('should handle text with no code blocks', () => {
    const text = 'Just plain text\nwith no fences';
    const blocks = extractCodeBlocks(text);
    expect(blocks).toHaveLength(0);
  });

  it('should handle multiline content in code block', () => {
    const text = '```\nline1\nline2\nline3\n```';
    const blocks = extractCodeBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe('line1\nline2\nline3');
  });
});

describe('hasIncompleteFence', () => {
  it('should return incomplete=false for no fences', () => {
    const result = hasIncompleteFence('Just text');
    expect(result.incomplete).toBe(false);
    expect(result.lastOpenIndex).toBe(-1);
  });

  it('should return incomplete=false for complete fence', () => {
    const result = hasIncompleteFence('```ts\ncode\n```');
    expect(result.incomplete).toBe(false);
  });

  it('should return incomplete=true for unclosed fence', () => {
    const text = '```ts\ncode';
    const result = hasIncompleteFence(text);
    expect(result.incomplete).toBe(true);
    expect(result.lastOpenIndex).toBe(0);
  });

  it('should return correct lastOpenIndex with prefix text', () => {
    const text = 'Hello\n```ts\ncode';
    const result = hasIncompleteFence(text);
    expect(result.incomplete).toBe(true);
    expect(result.lastOpenIndex).toBe(6); // "Hello\n" = 6 chars
  });

  it('should return incomplete=false for multiple complete fences', () => {
    const text = '```ts\ncode\n```\ntext\n```js\nmore\n```';
    const result = hasIncompleteFence(text);
    expect(result.incomplete).toBe(false);
  });

  it('should return incomplete=true for second unclosed fence', () => {
    const text = '```ts\ncode\n```\ntext\n```js\nmore';
    const result = hasIncompleteFence(text);
    expect(result.incomplete).toBe(true);
    // lastOpenIndex should point to the second opening fence
    expect(text.substring(result.lastOpenIndex)).toBe('```js\nmore');
  });

  it('should handle nested fences correctly', () => {
    // 4-backtick outer fence with 3-backtick inner — outer is still open
    const text = '````markdown\n```elixir\ncode\n```\nmore';
    const result = hasIncompleteFence(text);
    expect(result.incomplete).toBe(true);
    expect(result.lastOpenIndex).toBe(0);
  });

  it('should handle nested fences that are closed', () => {
    const text = '````markdown\n```elixir\ncode\n```\n````';
    const result = hasIncompleteFence(text);
    expect(result.incomplete).toBe(false);
  });

  it('should handle tilde fences', () => {
    const text = '~~~py\ncode';
    const result = hasIncompleteFence(text);
    expect(result.incomplete).toBe(true);
  });

  it('should not cross fence types', () => {
    // Backtick fence not closed by tilde
    const text = '```ts\ncode\n~~~';
    const result = hasIncompleteFence(text);
    expect(result.incomplete).toBe(true);
  });
});
