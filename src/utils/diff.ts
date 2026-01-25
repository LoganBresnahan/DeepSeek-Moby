import DiffMatchPatch from 'diff-match-patch';

// Type aliases - the @types/diff-match-patch has incorrect type definitions
type Diff = [number, string];
type Patch = object;

export interface DiffResult {
  content: string;
  success: boolean;
  patchResults?: boolean[];
  operation: 'replace' | 'patch' | 'insert';
}

export interface ApplyOptions {
  fuzzyMatch?: boolean;
  matchThreshold?: number;
  matchDistance?: number;
}

const DEFAULT_OPTIONS: ApplyOptions = {
  fuzzyMatch: true,
  matchThreshold: 0.5,
  matchDistance: 1000,
};

/**
 * Language-agnostic diff utility using Google's diff-match-patch library.
 *
 * Core approach: Use LINE-LEVEL diffing to compare original and AI output.
 * The diff results tell us exactly what's new (INSERT) and what to keep (EQUAL + DELETE).
 *
 * Reference: https://github.com/google/diff-match-patch/wiki/Line-or-Word-Diffs
 */
export class DiffEngine {
  private dmp: DiffMatchPatch;

  constructor(options: ApplyOptions = {}) {
    this.dmp = new DiffMatchPatch();
    const opts = { ...DEFAULT_OPTIONS, ...options };
    this.dmp.Match_Threshold = opts.matchThreshold ?? 0.5;
    this.dmp.Match_Distance = opts.matchDistance ?? 1000;
    this.dmp.Patch_DeleteThreshold = 0.5;
  }

  computeDiff(original: string, modified: string): Diff[] {
    const diffs = this.dmp.diff_main(original, modified);
    this.dmp.diff_cleanupSemantic(diffs);
    return diffs as Diff[];
  }

  createPatches(original: string, modified: string): Patch[] {
    const diffs = this.computeDiff(original, modified);
    return this.dmp.patch_make(original, diffs as any) as Patch[];
  }

  applyPatches(content: string, patches: Patch[]): DiffResult {
    const [result, patchResults] = this.dmp.patch_apply(patches as any, content);
    return {
      content: result,
      success: patchResults.every(r => r),
      patchResults,
      operation: 'patch',
    };
  }

  /**
   * Apply new code to original content using LINE-LEVEL diffing.
   *
   * The key insight: diff_main returns operations in order. When we see:
   * - EQUAL (0): shared content - keep it
   * - DELETE (-1): in original but not in AI output - KEEP IT (AI just didn't show it)
   * - INSERT (1): in AI output but not in original - ADD IT (this is new!)
   *
   * By processing diffs in order and keeping both EQUAL and DELETE while adding INSERT,
   * we get: original content + new insertions at the right locations.
   */
  applyChanges(original: string, newCode: string, options: ApplyOptions = {}): DiffResult {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    if (opts.matchThreshold !== undefined) {
      this.dmp.Match_Threshold = opts.matchThreshold;
    }
    if (opts.matchDistance !== undefined) {
      this.dmp.Match_Distance = opts.matchDistance;
    }

    const cleanCode = newCode.replace(/^#\s*File:.*\n/i, '');

    // Strategy 1: Full file replacement
    if (this.shouldReplaceWholeFile(original, cleanCode)) {
      return { content: cleanCode, success: true, operation: 'replace' };
    }

    // Strategy 2: Use LINE-LEVEL diff to merge
    // This is the recommended approach from diff-match-patch wiki
    const result = this.mergeWithLineDiff(original, cleanCode);
    if (result) {
      return result;
    }

    // Fallback: append at end
    const needsNewline = original.length > 0 && !original.endsWith('\n');
    return {
      content: original + (needsNewline ? '\n\n' : '\n') + cleanCode,
      success: false,
      operation: 'insert',
    };
  }

  /**
   * Merge AI output into original using line-level diff.
   *
   * From diff-match-patch wiki:
   * 1. diff_linesToChars_ converts each line to a unique Unicode character
   * 2. diff_main compares these characters (fast line-level comparison)
   * 3. diff_charsToLines_ converts back to actual lines
   * 4. diff_cleanupSemantic makes it more readable
   */
  private mergeWithLineDiff(original: string, cleanCode: string): DiffResult | null {
    try {
      // Convert to line-based representation
      // diff_linesToChars_ returns { chars1, chars2, lineArray }
      const lineData = (this.dmp as any).diff_linesToChars_(original, cleanCode);
      const lineText1 = lineData.chars1;
      const lineText2 = lineData.chars2;
      const lineArray = lineData.lineArray;

      // Diff the line-encoded strings
      const diffs = this.dmp.diff_main(lineText1, lineText2, false);

      // Convert back to actual line content
      (this.dmp as any).diff_charsToLines_(diffs, lineArray);

      // Clean up for better results
      this.dmp.diff_cleanupSemantic(diffs);

      // Build result: KEEP original content (EQUAL + DELETE), ADD new content (INSERT)
      let result = '';
      let hasInsertions = false;

      for (const [op, text] of diffs as Diff[]) {
        if (op === 0) {
          // EQUAL: shared between original and AI output - keep it
          result += text;
        } else if (op === 1) {
          // INSERT: in AI output but not in original - this is NEW, add it
          result += text;
          hasInsertions = true;
        } else if (op === -1) {
          // DELETE: in original but not in AI output - KEEP IT
          // The AI just showed a snippet, we don't want to delete original content
          result += text;
        }
      }

      // Only return success if we actually had insertions
      if (hasInsertions) {
        return {
          content: result,
          success: true,
          operation: 'insert',
        };
      }

      // No new content found
      return null;
    } catch (e) {
      // If line-level diff fails, return null to fall back
      return null;
    }
  }

  /**
   * Determine if new code should replace the entire file.
   */
  private shouldReplaceWholeFile(original: string, newCode: string): boolean {
    // Skip if original is very small
    if (original.trim().length < 50) {
      return false;
    }

    // Skip if new code is much smaller (likely a snippet)
    if (newCode.length < original.length * 0.5) {
      return false;
    }

    // Check for explicit file header
    if (/^#\s*File:/im.test(newCode)) {
      return true;
    }

    // Check for very high line overlap with similar structure
    const originalLines = original.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const newLines = newCode.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    // Need both to have substantial content
    if (originalLines.length < 10 || newLines.length < 10) {
      return false;
    }

    // Check if new code contains most of original's significant lines
    const originalSet = new Set(originalLines.filter(l => l.length > 20));
    let matches = 0;
    for (const line of newLines) {
      if (originalSet.has(line)) {
        matches++;
      }
    }

    // If >70% of original's significant lines appear in new code AND
    // new code is similar in size, it's likely a full replacement
    const overlapRatio = originalSet.size > 0 ? matches / originalSet.size : 0;
    const sizeRatio = newLines.length / originalLines.length;

    return overlapRatio > 0.7 && sizeRatio > 0.8 && sizeRatio < 1.3;
  }

  generateUnifiedDiff(original: string, modified: string, _filename: string = 'file'): string {
    const patches = this.createPatches(original, modified);
    return this.dmp.patch_toText(patches as any);
  }

  parseUnifiedDiff(patchText: string): Patch[] {
    return this.dmp.patch_fromText(patchText) as Patch[];
  }
}

export const diffEngine = new DiffEngine();
export default DiffEngine;
