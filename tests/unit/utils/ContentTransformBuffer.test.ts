/**
 * Unit tests for ContentTransformBuffer
 *
 * Tests the progressive flush behavior: safe content emits immediately,
 * only potential pattern starts are held back.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ContentTransformBuffer,
  BufferedSegment,
  mightContainPatternStart
} from '../../../src/utils/ContentTransformBuffer';

describe('ContentTransformBuffer', () => {
  let buffer: ContentTransformBuffer;
  let flushedSegments: BufferedSegment[];

  beforeEach(() => {
    vi.useFakeTimers();
    flushedSegments = [];
    buffer = new ContentTransformBuffer({
      debounceMs: 150,
      onFlush: (segments) => {
        flushedSegments.push(...segments);
      }
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('progressive flush behavior', () => {
    it('emits safe content immediately (no debounce)', () => {
      buffer.append('Hello world!');

      // Safe content (no pattern start) should emit immediately
      expect(flushedSegments).toHaveLength(1);
      expect(flushedSegments[0].content).toBe('Hello world!');
    });

    it('holds back potential pattern starts', () => {
      buffer.append('Hello <');

      // "Hello " should emit, but "<" is held back
      expect(flushedSegments).toHaveLength(1);
      expect(flushedSegments[0].content).toBe('Hello ');

      // After fallback timer, the "<" should be released
      vi.advanceTimersByTime(150);
      expect(flushedSegments).toHaveLength(2);
      expect(flushedSegments[1].content).toBe('<');
    });

    it('flush() emits everything including held content', () => {
      buffer.append('Hello <');
      buffer.flush();

      // Should emit both segments
      expect(flushedSegments.length).toBeGreaterThanOrEqual(1);
      const allContent = flushedSegments
        .filter(s => s.type === 'text')
        .map(s => s.content)
        .join('');
      expect(allContent).toBe('Hello <');
    });

    it('reset() clears buffer state', () => {
      buffer.append('Hello');
      flushedSegments = []; // Clear from first append
      buffer.reset();
      buffer.append('World');

      expect(flushedSegments).toHaveLength(1);
      expect(flushedSegments[0].content).toBe('World');
    });
  });

  describe('shell tag detection', () => {
    it('detects complete shell tags', () => {
      buffer.append('<shell>ls -la</shell>');

      expect(flushedSegments).toHaveLength(1);
      expect(flushedSegments[0]).toEqual({
        type: 'shell',
        content: [{ command: 'ls -la' }],
        complete: true
      });
    });

    it('returns multi-line shell content as single raw command', () => {
      buffer.append('<shell>ls -la\ncat file.txt\npwd</shell>');

      expect(flushedSegments).toHaveLength(1);
      expect(flushedSegments[0].type).toBe('shell');
      // Raw content returned as single command — parseShellCommands handles splitting
      expect(flushedSegments[0].content).toEqual([
        { command: 'ls -la\ncat file.txt\npwd' }
      ]);
    });

    it('holds back incomplete shell tags', () => {
      buffer.append('Text before <shell>ls -');

      // Text before should emit, incomplete tag held
      expect(flushedSegments).toHaveLength(1);
      expect(flushedSegments[0].type).toBe('text');
      expect(flushedSegments[0].content).toBe('Text before ');
    });

    it('completes shell tag when rest arrives', () => {
      buffer.append('Text <shell>ls');
      flushedSegments = [];

      buffer.append('</shell> more text');

      expect(flushedSegments.some(s => s.type === 'shell')).toBe(true);
    });

    it('handles text before and after shell tag', () => {
      buffer.append('Before <shell>pwd</shell> After');

      expect(flushedSegments).toHaveLength(3);
      expect(flushedSegments[0]).toEqual({ type: 'text', content: 'Before ', complete: true });
      expect(flushedSegments[1]).toEqual({ type: 'shell', content: [{ command: 'pwd' }], complete: true });
      expect(flushedSegments[2]).toEqual({ type: 'text', content: ' After', complete: true });
    });

    it('emits incomplete shell tag on final flush', () => {
      buffer.append('<shell>incomplete command');
      buffer.flush();

      expect(flushedSegments).toHaveLength(1);
      expect(flushedSegments[0].type).toBe('shell');
      expect(flushedSegments[0].complete).toBe(false);
    });
  });

  describe('thinking tag detection', () => {
    it('detects complete think tags', () => {
      buffer.append('<think>I should analyze this carefully...</think>');

      expect(flushedSegments).toHaveLength(1);
      expect(flushedSegments[0]).toEqual({
        type: 'thinking',
        content: 'I should analyze this carefully...',
        complete: true
      });
    });

    it('strips whitespace from thinking content', () => {
      buffer.append('<think>  \n  thinking with whitespace  \n  </think>');

      expect(flushedSegments[0].content).toBe('thinking with whitespace');
    });

    it('holds back incomplete think tags', () => {
      buffer.append('Text <think>thinking...');

      // Text should emit, incomplete tag held
      expect(flushedSegments).toHaveLength(1);
      expect(flushedSegments[0].type).toBe('text');
      expect(flushedSegments[0].content).toBe('Text ');
    });
  });

  describe('code block handling', () => {
    // NOTE: Code blocks are NOT filtered by the buffer - they flow through as normal text
    // and are rendered by the frontend's markdown processing.

    it('passes code blocks through as text immediately', () => {
      buffer.append('```typescript\nconst x = 42;\n```');

      expect(flushedSegments).toHaveLength(1);
      expect(flushedSegments[0].type).toBe('text');
      expect(flushedSegments[0].content).toBe('```typescript\nconst x = 42;\n```');
    });

    it('does not buffer incomplete code blocks', () => {
      buffer.append('```javascript\nfunction foo() {');

      // Code blocks flow through immediately as text
      expect(flushedSegments).toHaveLength(1);
      expect(flushedSegments[0].type).toBe('text');
    });

    it('handles multiple code blocks as text', () => {
      buffer.append('```js\ncode1\n```\ntext\n```py\ncode2\n```');

      // All content flows through as text
      expect(flushedSegments).toHaveLength(1);
      expect(flushedSegments[0].type).toBe('text');
    });
  });

  describe('mixed content', () => {
    it('handles shell followed by text', () => {
      buffer.append('<shell>ls</shell>Done!');

      expect(flushedSegments).toHaveLength(2);
      expect(flushedSegments[0].type).toBe('shell');
      expect(flushedSegments[1].type).toBe('text');
    });

    it('handles complex interleaved content', () => {
      buffer.append('Let me check. <shell>ls</shell> Found it.\n```js\nx=1\n```');

      // Code blocks flow through as text
      const types = flushedSegments.map(s => s.type);
      expect(types).toEqual(['text', 'shell', 'text']);
    });

    it('handles thinking followed by shell', () => {
      buffer.append('<think>analyzing</think><shell>pwd</shell>');

      expect(flushedSegments).toHaveLength(2);
      expect(flushedSegments[0].type).toBe('thinking');
      expect(flushedSegments[1].type).toBe('shell');
    });
  });

  describe('streaming simulation', () => {
    it('handles character-by-character streaming of shell tags', () => {
      const fullContent = 'Hi <shell>ls</shell> done';

      // Simulate slow streaming
      for (const char of fullContent) {
        buffer.append(char);
      }

      // After all chars, wait for any held content
      vi.advanceTimersByTime(150);

      // Collect all text and shell segments
      const textContent = flushedSegments
        .filter(s => s.type === 'text')
        .map(s => s.content)
        .join('');
      const hasShell = flushedSegments.some(s => s.type === 'shell');

      expect(textContent).toBe('Hi  done');
      expect(hasShell).toBe(true);
    });

    it('emits each safe token immediately', () => {
      // Progressive flush emits safe content immediately
      buffer.append('Hello');
      expect(flushedSegments.length).toBeGreaterThanOrEqual(1);

      buffer.append(' world');
      expect(flushedSegments.length).toBeGreaterThanOrEqual(2);

      buffer.append('!');
      expect(flushedSegments.length).toBeGreaterThanOrEqual(3);

      // All content should be there
      const allText = flushedSegments
        .filter(s => s.type === 'text')
        .map(s => s.content)
        .join('');
      expect(allText).toBe('Hello world!');
    });

    it('handles partial tag streaming correctly', () => {
      // Streaming "<shell>cmd</shell>" in chunks
      buffer.append('<');
      vi.advanceTimersByTime(30);
      buffer.append('shell');
      vi.advanceTimersByTime(30);
      buffer.append('>');
      vi.advanceTimersByTime(30);
      buffer.append('pwd');
      vi.advanceTimersByTime(30);
      buffer.append('</shell>');
      vi.advanceTimersByTime(150);

      expect(flushedSegments.some(s => s.type === 'shell')).toBe(true);
      const shellSegment = flushedSegments.find(s => s.type === 'shell');
      expect(shellSegment?.content).toEqual([{ command: 'pwd' }]);
    });
  });

  describe('fallback timer behavior', () => {
    it('releases held content after fallback timer', () => {
      // Append content ending with potential pattern start
      buffer.append('Text ending with <');

      // Immediately: "Text ending with " should emit, "<" held
      expect(flushedSegments).toHaveLength(1);
      expect(flushedSegments[0].content).toBe('Text ending with ');

      // After fallback timer, held "<" should be released
      vi.advanceTimersByTime(150);
      expect(flushedSegments).toHaveLength(2);
      expect(flushedSegments[1].content).toBe('<');
    });

    it('uses custom fallback delay', () => {
      const customBuffer = new ContentTransformBuffer({
        debounceMs: 300,
        onFlush: (segments) => flushedSegments.push(...segments)
      });

      customBuffer.append('test <');

      // "test " should emit immediately
      expect(flushedSegments).toHaveLength(1);
      expect(flushedSegments[0].content).toBe('test ');

      vi.advanceTimersByTime(200);
      expect(flushedSegments).toHaveLength(1); // Still holding "<"

      vi.advanceTimersByTime(100);
      expect(flushedSegments).toHaveLength(2); // Now released
    });
  });

  describe('edge cases', () => {
    it('handles empty buffer', () => {
      buffer.flush();
      expect(flushedSegments).toHaveLength(0);
    });

    it('handles whitespace-only content', () => {
      buffer.append('   \n\t  ');

      expect(flushedSegments).toHaveLength(1);
      expect(flushedSegments[0].type).toBe('text');
    });

    it('handles nested-looking but invalid tags', () => {
      buffer.append('<shell>outer <shell>inner</shell></shell>');

      // Should match first valid pair
      expect(flushedSegments.some(s => s.type === 'shell')).toBe(true);
    });

    it('handles malformed tags gracefully', () => {
      buffer.append('<shell>unclosed command');
      buffer.append('<shellbad>not a tag</shellbad>');
      buffer.flush();

      // Should have content including the malformed shell as incomplete
      expect(flushedSegments.length).toBeGreaterThan(0);
    });

    it('handles text that looks like but is not a pattern start', () => {
      buffer.append('a < b and c < d');

      // This should emit immediately since "< b" doesn't start a pattern
      // The holdback only triggers when we see exactly "<" or "<s", "<sh" etc at the END
      expect(flushedSegments.length).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('mightContainPatternStart', () => {
  it('detects partial shell tag starts', () => {
    expect(mightContainPatternStart('<')).toBe(true);
    expect(mightContainPatternStart('<s')).toBe(true);
    expect(mightContainPatternStart('<sh')).toBe(true);
    expect(mightContainPatternStart('<she')).toBe(true);
    expect(mightContainPatternStart('<shel')).toBe(true);
    expect(mightContainPatternStart('<shell')).toBe(true);
  });

  it('detects partial think tag starts', () => {
    expect(mightContainPatternStart('<t')).toBe(true);
    expect(mightContainPatternStart('<th')).toBe(true);
    expect(mightContainPatternStart('<thi')).toBe(true);
    expect(mightContainPatternStart('<thin')).toBe(true);
    expect(mightContainPatternStart('<think')).toBe(true);
  });

  it('does not detect code block prefixes (they flow through as text)', () => {
    // Code blocks are no longer detected - they flow through as normal text
    expect(mightContainPatternStart('`')).toBe(false);
    expect(mightContainPatternStart('``')).toBe(false);
    expect(mightContainPatternStart('```')).toBe(false);
  });

  it('returns false for safe text', () => {
    expect(mightContainPatternStart('hello')).toBe(false);
    expect(mightContainPatternStart('regular text')).toBe(false);
    expect(mightContainPatternStart('a < b')).toBe(false);
  });

  it('detects DSML tool-call tag prefixes', () => {
    expect(mightContainPatternStart('<｜')).toBe(true);
    expect(mightContainPatternStart('<｜D')).toBe(true);
    expect(mightContainPatternStart('<｜DSML')).toBe(true);
    expect(mightContainPatternStart('<｜DSML｜function_c')).toBe(true);
  });
});

describe('ContentTransformBuffer DSML stripping', () => {
  let buffer: ContentTransformBuffer;
  let flushedSegments: BufferedSegment[];

  beforeEach(() => {
    vi.useFakeTimers();
    flushedSegments = [];
    buffer = new ContentTransformBuffer({
      debounceMs: 150,
      onFlush: (segments) => {
        flushedSegments.push(...segments);
      }
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('detects complete DSML blocks and emits empty content', () => {
    buffer.append('<｜DSML｜function_calls><｜DSML｜invoke name="read_file"></｜DSML｜invoke></｜DSML｜function_calls>');

    const dsmlSegments = flushedSegments.filter(s => s.type === 'dsml');
    expect(dsmlSegments).toHaveLength(1);
    expect(dsmlSegments[0].content).toBe('');
    expect(dsmlSegments[0].complete).toBe(true);
  });

  it('does not leak raw DSML tokens to text segments', () => {
    buffer.append('Here are the steps: <｜DSML｜function_calls><｜DSML｜invoke name="x"></｜DSML｜invoke></｜DSML｜function_calls> done.');

    const textContent = flushedSegments
      .filter(s => s.type === 'text')
      .map(s => s.content as string)
      .join('');
    expect(textContent).not.toContain('DSML');
    expect(textContent).not.toContain('<｜');
    expect(textContent).toContain('Here are the steps:');
    expect(textContent).toContain('done.');
  });

  it('holds back partial DSML across multiple chunks until complete', () => {
    buffer.append('Text before <｜DSML｜function_calls>');
    // The start tag is complete but no end — should hold back everything from the start
    expect(flushedSegments.some(s => typeof s.content === 'string' && (s.content as string).includes('<｜'))).toBe(false);

    buffer.append('<｜DSML｜invoke name="x"></｜DSML｜invoke></｜DSML｜function_calls>');
    buffer.flush();

    const textContent = flushedSegments
      .filter(s => s.type === 'text')
      .map(s => s.content as string)
      .join('');
    expect(textContent).toBe('Text before ');
    expect(flushedSegments.some(s => s.type === 'dsml')).toBe(true);
  });
});
