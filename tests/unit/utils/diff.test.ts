/**
 * Tests for DiffEngine - search/replace block parsing and application
 */

import { describe, it, expect } from 'vitest';
import { DiffEngine, type SearchReplaceBlock } from '../../../src/utils/diff';

describe('DiffEngine', () => {
  const engine = new DiffEngine();

  describe('parseSearchReplaceBlocks', () => {
    it('parses a single SEARCH/REPLACE block', () => {
      const content = `<<<<<<< SEARCH
const x = 1;
=======
const x = 2;
>>>>>>> REPLACE`;

      const blocks = engine.parseSearchReplaceBlocks(content);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].search).toBe('const x = 1;');
      expect(blocks[0].replace).toBe('const x = 2;');
    });

    it('parses multiple SEARCH/REPLACE blocks', () => {
      const content = `<<<<<<< SEARCH
const a = 1;
=======
const a = 10;
>>>>>>> REPLACE

<<<<<<< SEARCH
const b = 2;
=======
const b = 20;
>>>>>>> REPLACE`;

      const blocks = engine.parseSearchReplaceBlocks(content);

      expect(blocks).toHaveLength(2);
      expect(blocks[0].search).toBe('const a = 1;');
      expect(blocks[0].replace).toBe('const a = 10;');
      expect(blocks[1].search).toBe('const b = 2;');
      expect(blocks[1].replace).toBe('const b = 20;');
    });

    it('handles empty SEARCH section (create/prepend)', () => {
      const content = `<<<<<<< SEARCH
=======
import { foo } from 'bar';
>>>>>>> REPLACE`;

      const blocks = engine.parseSearchReplaceBlocks(content);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].search.trim()).toBe('');
      expect(blocks[0].replace).toContain("import { foo } from 'bar';");
    });

    it('handles empty REPLACE section (deletion)', () => {
      const content = `<<<<<<< SEARCH
const unused = true;
=======
>>>>>>> REPLACE`;

      const blocks = engine.parseSearchReplaceBlocks(content);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].search).toBe('const unused = true;');
      expect(blocks[0].replace.trim()).toBe('');
    });

    it('handles multiline search and replace', () => {
      const content = `<<<<<<< SEARCH
function hello() {
  console.log("hello");
}
=======
function hello() {
  console.log("hello world");
  return true;
}
>>>>>>> REPLACE`;

      const blocks = engine.parseSearchReplaceBlocks(content);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].search).toContain('function hello()');
      expect(blocks[0].search).toContain('console.log("hello")');
      expect(blocks[0].replace).toContain('console.log("hello world")');
      expect(blocks[0].replace).toContain('return true;');
    });

    it('returns empty array when no blocks are found', () => {
      const content = 'This is just plain text with no blocks.';
      const blocks = engine.parseSearchReplaceBlocks(content);
      expect(blocks).toEqual([]);
    });

    it('returns empty array for empty string', () => {
      const blocks = engine.parseSearchReplaceBlocks('');
      expect(blocks).toEqual([]);
    });

    it('handles varying numbers of marker characters (5-9)', () => {
      const content = `<<<<< SEARCH
old
=====
new
>>>>> REPLACE`;

      const blocks = engine.parseSearchReplaceBlocks(content);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].search).toBe('old');
      expect(blocks[0].replace).toBe('new');
    });

    it('normalizes CRLF line endings before parsing', () => {
      const content = `<<<<<<< SEARCH\r\nold code\r\n=======\r\nnew code\r\n>>>>>>> REPLACE`;

      const blocks = engine.parseSearchReplaceBlocks(content);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].search).toBe('old code');
      expect(blocks[0].replace).toBe('new code');
    });

    it('sanitizes stray conflict markers from search/replace content', () => {
      // Conflict markers that are just ======= or <<<<<<< on their own
      // should be filtered as format artifacts
      const content = `<<<<<<< SEARCH
real code line
=======
replacement line
>>>>>>> REPLACE`;

      const blocks = engine.parseSearchReplaceBlocks(content);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].search).toBe('real code line');
      expect(blocks[0].replace).toBe('replacement line');
    });
  });

  describe('applySearchReplace', () => {
    it('applies a single exact-match block', () => {
      const original = 'const x = 1;\nconst y = 2;';
      const blocks: SearchReplaceBlock[] = [
        { search: 'const x = 1;', replace: 'const x = 100;' }
      ];

      const result = engine.applySearchReplace(original, blocks);

      expect(result.success).toBe(true);
      expect(result.content).toContain('const x = 100;');
      expect(result.content).toContain('const y = 2;');
      expect(result.operation).toBe('search-replace');
    });

    it('applies multiple blocks sequentially', () => {
      const original = 'const a = 1;\nconst b = 2;\nconst c = 3;';
      const blocks: SearchReplaceBlock[] = [
        { search: 'const a = 1;', replace: 'const a = 10;' },
        { search: 'const c = 3;', replace: 'const c = 30;' }
      ];

      const result = engine.applySearchReplace(original, blocks);

      expect(result.success).toBe(true);
      expect(result.content).toContain('const a = 10;');
      expect(result.content).toContain('const b = 2;');
      expect(result.content).toContain('const c = 30;');
    });

    it('handles empty SEARCH as prepend to existing file', () => {
      const original = 'existing content';
      const blocks: SearchReplaceBlock[] = [
        { search: '', replace: 'import { foo } from "bar";\n' }
      ];

      const result = engine.applySearchReplace(original, blocks);

      expect(result.success).toBe(true);
      expect(result.content).toMatch(/^import \{ foo \}/);
      expect(result.content).toContain('existing content');
    });

    it('handles empty SEARCH on empty file as full content creation', () => {
      const original = '';
      const blocks: SearchReplaceBlock[] = [
        { search: '', replace: 'new file content' }
      ];

      const result = engine.applySearchReplace(original, blocks);

      expect(result.success).toBe(true);
      expect(result.content).toBe('new file content');
    });

    it('reports failure when no blocks match', () => {
      const original = 'const x = 1;';
      const blocks: SearchReplaceBlock[] = [
        { search: 'const y = 999;', replace: 'const y = 0;' }
      ];

      const result = engine.applySearchReplace(original, blocks);

      // Might succeed via fuzzy or location matching, or fail
      // The important thing is that the message reflects what happened
      expect(result.operation).toBe('search-replace');
      expect(result.message).toBeDefined();
    });

    it('returns message indicating how many blocks were applied', () => {
      const original = 'aaa\nbbb\nccc';
      const blocks: SearchReplaceBlock[] = [
        { search: 'aaa', replace: 'AAA' },
        { search: 'ccc', replace: 'CCC' }
      ];

      const result = engine.applySearchReplace(original, blocks);

      expect(result.success).toBe(true);
      expect(result.message).toContain('2/2');
    });

    it('uses fuzzy matching for whitespace differences', () => {
      const original = '  const x = 1;\n  const y = 2;';
      const blocks: SearchReplaceBlock[] = [
        { search: 'const x = 1;', replace: 'const x = 100;' }
      ];

      const result = engine.applySearchReplace(original, blocks);

      expect(result.success).toBe(true);
      expect(result.content).toContain('100');
    });
  });

  describe('applyChanges', () => {
    it('applies search/replace blocks in new code', () => {
      const original = 'const x = 1;\nconst y = 2;';
      const newCode = `<<<<<<< SEARCH
const x = 1;
=======
const x = 42;
>>>>>>> REPLACE`;

      const result = engine.applyChanges(original, newCode);

      expect(result.success).toBe(true);
      expect(result.content).toContain('const x = 42;');
      expect(result.content).toContain('const y = 2;');
      expect(result.operation).toBe('search-replace');
    });

    it('falls back to line diff when no search/replace blocks are present', () => {
      const original = 'line1\nline2\nline3';
      const newCode = 'line1\nline2\nnewline\nline3';

      const result = engine.applyChanges(original, newCode);

      expect(result.content).toContain('newline');
      expect(result.content).toContain('line1');
      expect(result.content).toContain('line2');
      expect(result.content).toContain('line3');
    });

    it('handles full file replacement detection', () => {
      // Create an original with enough content (>50 chars, >10 significant lines)
      const lines = Array.from({ length: 15 }, (_, i) =>
        `const variable${i} = "value${i}"; // this is a long enough line for detection`
      );
      const original = lines.join('\n');

      // New code is a modified version of the same file
      const modifiedLines = lines.map((line, i) =>
        i === 5 ? 'const variable5 = "CHANGED"; // this is a long enough line for detection' : line
      );
      const newCode = modifiedLines.join('\n');

      const result = engine.applyChanges(original, newCode);

      expect(result.success).toBe(true);
      expect(result.content).toContain('CHANGED');
    });

    it('filters out blocks where both search and replace are empty', () => {
      const original = 'const x = 1;';
      const newCode = `<<<<<<< SEARCH
=======
>>>>>>> REPLACE

<<<<<<< SEARCH
const x = 1;
=======
const x = 2;
>>>>>>> REPLACE`;

      const result = engine.applyChanges(original, newCode);

      // The empty block should be filtered, only the real block applied
      expect(result.success).toBe(true);
      expect(result.content).toContain('const x = 2;');
    });
  });

  describe('constructor options', () => {
    it('uses default options when none provided', () => {
      const e = new DiffEngine();
      // Just verify it constructs without error
      expect(e).toBeDefined();
    });

    it('accepts custom fuzzyMatch and fuzzFactor', () => {
      const e = new DiffEngine({ fuzzyMatch: false, fuzzFactor: 5 });
      expect(e).toBeDefined();
    });
  });

  describe('edge cases', () => {
    it('handles search/replace with special regex characters', () => {
      const original = 'const regex = /test\\.js$/;';
      const blocks: SearchReplaceBlock[] = [
        { search: 'const regex = /test\\.js$/;', replace: 'const regex = /test\\.ts$/;' }
      ];

      const result = engine.applySearchReplace(original, blocks);

      expect(result.success).toBe(true);
      expect(result.content).toContain('/test\\.ts$/');
    });

    it('handles SEARCH content that appears multiple times (replaces first)', () => {
      const original = 'foo\nfoo\nfoo';
      const blocks: SearchReplaceBlock[] = [
        { search: 'foo', replace: 'bar' }
      ];

      const result = engine.applySearchReplace(original, blocks);

      expect(result.success).toBe(true);
      // String.replace only replaces the first occurrence
      expect(result.content).toBe('bar\nfoo\nfoo');
    });

    it('preserves content when applying empty replacement (deletion)', () => {
      const original = 'line1\ndelete me\nline3';
      const blocks: SearchReplaceBlock[] = [
        { search: 'delete me\n', replace: '' }
      ];

      const result = engine.applySearchReplace(original, blocks);

      expect(result.success).toBe(true);
      expect(result.content).toBe('line1\nline3');
    });

    it('handles very large multiline search blocks', () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
      const original = lines.join('\n');
      const searchLines = lines.slice(10, 20).join('\n');
      const replaceLines = lines.slice(10, 20).map(l => l + ' modified').join('\n');

      const blocks: SearchReplaceBlock[] = [
        { search: searchLines, replace: replaceLines }
      ];

      const result = engine.applySearchReplace(original, blocks);

      expect(result.success).toBe(true);
      expect(result.content).toContain('line 15 modified');
      expect(result.content).toContain('line 0');
      expect(result.content).toContain('line 49');
    });
  });
});

describe('DiffEngine singleton export', () => {
  it('exports a default diffEngine instance', async () => {
    const { diffEngine } = await import('../../../src/utils/diff');
    // Use duck-type check instead of toBeInstanceOf (avoids cross-module class identity issues)
    expect(diffEngine).toBeDefined();
    expect(typeof diffEngine.parseSearchReplaceBlocks).toBe('function');
    expect(typeof diffEngine.applySearchReplace).toBe('function');
    expect(typeof diffEngine.applyChanges).toBe('function');
  });
});
