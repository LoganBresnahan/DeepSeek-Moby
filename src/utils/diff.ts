import * as Diff from 'diff';
import { logger } from './logger';

export interface DiffResult {
  content: string;
  success: boolean;
  patchResults?: boolean[];
  operation: 'replace' | 'patch' | 'insert' | 'search-replace';
  message?: string;
}

/**
 * Represents a search/replace block in Aider-style format.
 * Format:
 * <<<<<<< SEARCH
 * original code
 * =======
 * replacement code
 * >>>>>>> REPLACE
 */
export interface SearchReplaceBlock {
  filePath?: string;  // Optional - from "# File:" header before the block
  search: string;
  replace: string;
}

export interface ApplyOptions {
  fuzzyMatch?: boolean;
  fuzzFactor?: number;
}

const DEFAULT_OPTIONS: ApplyOptions = {
  fuzzyMatch: true,
  fuzzFactor: 3,  // Allow up to 3 lines of context mismatch
};

/**
 * Language-agnostic diff utility using jsdiff library.
 *
 * Core approach: Use LINE-LEVEL diffing to compare original and AI output.
 * The diff results tell us exactly what's new (added) and what to keep (removed + unchanged).
 *
 * Reference: https://github.com/kpdecker/jsdiff
 */
export class DiffEngine {
  private options: ApplyOptions;

  constructor(options: ApplyOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Parse search/replace blocks from content.
   * Supports Aider-style format:
   *
   * # File: path/to/file.ts (optional)
   * <<<<<<< SEARCH
   * original code to find
   * =======
   * replacement code
   * >>>>>>> REPLACE
   */
  parseSearchReplaceBlocks(content: string): SearchReplaceBlock[] {
    const blocks: SearchReplaceBlock[] = [];

    // Normalize line endings for consistent matching
    const normalizedContent = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Log first 200 chars to debug
    logger.info(`[DiffEngine] parseSearchReplaceBlocks input (first 200): ${normalizedContent.substring(0, 200).replace(/\n/g, '\\n')}`);

    // Simple regex - just match the core pattern
    // <<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE
    // Note: (?:\n)? makes the newline before ======= optional to support empty SEARCH sections
    // The SEARCH/REPLACE labels on outer markers provide sufficient disambiguation
    const regex = /<{5,9}\s*SEARCH\s*\n([\s\S]*?)(?:\n)?={5,9}\s*\n([\s\S]*?)(?:\n)?>{5,9}\s*REPLACE/g;

    let match;
    while ((match = regex.exec(normalizedContent)) !== null) {
      let search = match[1];
      let replace = match[2];

      // Sanitize: Remove lines that are JUST conflict markers (=======, etc.)
      // These are format artifacts, not actual code
      const conflictMarkerLine = /^[=<>]{5,9}(\s*AND)?$/i;
      const sanitizeLines = (text: string): string => {
        return text
          .split('\n')
          .filter(line => !conflictMarkerLine.test(line.trim()))
          .join('\n');
      };

      search = sanitizeLines(search);
      replace = sanitizeLines(replace);

      logger.info(`[DiffEngine] Found block! Search length: ${search.length}, Replace length: ${replace.length}`);
      blocks.push({ search, replace });
    }

    logger.info(`[DiffEngine] Total blocks found: ${blocks.length}`);
    return blocks;
  }

  /**
   * Apply search/replace blocks to content.
   * Tries multiple strategies in order of reliability.
   */
  applySearchReplace(original: string, blocks: SearchReplaceBlock[]): DiffResult {
    let content = original;
    let appliedCount = 0;

    for (const block of blocks) {
      // Handle empty SEARCH - means "prepend to file" or "create new content"
      if (block.search.trim() === '') {
        logger.info(`[DiffEngine] Empty SEARCH block - treating as prepend/create`);

        if (content.trim() === '') {
          // File is empty - use REPLACE as full content
          content = block.replace;
          appliedCount++;
          logger.info(`[DiffEngine] Applied empty SEARCH to empty file (full content)`);
          continue;
        } else {
          // File has content - prepend REPLACE at top
          const needsNewline = !block.replace.endsWith('\n');
          content = block.replace + (needsNewline ? '\n' : '') + content;
          appliedCount++;
          logger.info(`[DiffEngine] Applied empty SEARCH by prepending to file`);
          continue;
        }
      }

      // Strategy 1: Exact match
      if (content.includes(block.search)) {
        content = content.replace(block.search, block.replace);
        appliedCount++;
        logger.info(`[DiffEngine] Applied via exact match`);
        continue;
      }

      // Strategy 2: Whitespace-normalized line matching
      let result = this.fuzzySearchReplace(content, block.search, block.replace);
      if (result !== null) {
        content = result;
        appliedCount++;
        logger.info(`[DiffEngine] Applied via fuzzy line match`);
        continue;
      }

      // Strategy 3: Patch-based matching using jsdiff
      // Create a unified diff patch and apply with fuzzFactor
      logger.info(`[DiffEngine] Trying patch-based match...`);
      result = this.patchBasedReplace(content, block.search, block.replace);
      if (result !== null) {
        content = result;
        appliedCount++;
        logger.info(`[DiffEngine] Applied via patch-based match`);
        continue;
      }

      // Strategy 4: Location-based matching as last resort
      logger.info(`[DiffEngine] Trying location-based match...`);
      result = this.locationBasedReplace(content, block.search, block.replace);
      if (result !== null) {
        content = result;
        appliedCount++;
        logger.info(`[DiffEngine] Applied via location-based match`);
        continue;
      }

      logger.info(`[DiffEngine] All match strategies failed for block`);
    }

    return {
      content,
      success: appliedCount > 0,
      operation: 'search-replace',
      message: appliedCount > 0
        ? `Applied ${appliedCount}/${blocks.length} search/replace blocks`
        : 'No matching code found for search/replace blocks'
    };
  }

  /**
   * Fuzzy search and replace - handles minor whitespace differences.
   * Normalizes whitespace when searching but preserves indentation in replacement.
   */
  private fuzzySearchReplace(content: string, search: string, replace: string): string | null {
    const contentLines = content.split('\n');
    const searchLines = search.split('\n');

    // Normalize for comparison (trim each line)
    const normalizedSearch = searchLines.map(l => l.trim());

    // Find the starting line by comparing normalized versions
    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
      let matches = true;
      for (let j = 0; j < searchLines.length; j++) {
        if (contentLines[i + j].trim() !== normalizedSearch[j]) {
          matches = false;
          break;
        }
      }

      if (matches) {
        // Found a match! Detect the indentation from the original
        const originalIndent = contentLines[i].match(/^(\s*)/)?.[1] || '';

        // Apply the replacement with proper indentation
        const replaceLines = replace.split('\n');
        const replaceBaseIndent = replaceLines[0].match(/^(\s*)/)?.[1] || '';

        // Calculate relative indentation
        const indentedReplace = replaceLines.map((line, idx) => {
          if (idx === 0) {
            // First line gets the original indentation
            return originalIndent + line.trimStart();
          }
          // Other lines: preserve their relative indentation from replacement
          const lineIndent = line.match(/^(\s*)/)?.[1] || '';
          const relativeIndent = lineIndent.length - replaceBaseIndent.length;
          const newIndent = originalIndent + ' '.repeat(Math.max(0, relativeIndent));
          return newIndent + line.trimStart();
        });

        // Replace the matched lines
        const before = contentLines.slice(0, i);
        const after = contentLines.slice(i + searchLines.length);
        return [...before, ...indentedReplace, ...after].join('\n');
      }
    }

    return null;
  }

  /**
   * Patch-based replacement using jsdiff's applyPatch with fuzzFactor.
   *
   * Creates a unified diff patch from search->replace transformation,
   * then applies it to the file content with fuzzy matching enabled.
   */
  private patchBasedReplace(content: string, search: string, replace: string): string | null {
    try {
      // Create a unified diff patch that transforms search into replace
      const patch = Diff.createPatch('file', search, replace, '', '');

      logger.info(`[DiffEngine] Created patch (${patch.length} chars)`);

      // Apply with fuzzFactor to allow context line mismatches
      // Also use compareLine for whitespace-tolerant matching
      const result = Diff.applyPatch(content, patch, {
        fuzzFactor: this.options.fuzzFactor ?? 3,
        compareLine: (lineNumber, line, operation, patchContent) => {
          // Guard against undefined values (can happen in edge cases)
          if (line === undefined || patchContent === undefined) {
            return false;
          }
          // Allow whitespace differences in context lines
          return line.trim() === patchContent.trim();
        }
      });

      if (result !== false) {
        logger.info(`[DiffEngine] Patch applied successfully`);
        return result;
      }

      logger.info(`[DiffEngine] Patch application failed`);
      return null;
    } catch (e) {
      logger.info(`[DiffEngine] patchBasedReplace error: ${e}`);
      return null;
    }
  }

  /**
   * Location-based replacement using Patience-style anchor matching.
   *
   * Algorithm:
   * 1. Find "anchor" lines - distinctive lines from SEARCH that appear exactly (trimmed) in the file
   * 2. Find where those anchors appear in the file
   * 3. Verify anchors appear in the same relative order
   * 4. Use the anchor positions to determine the replacement region
   * 5. Validate with jsdiff similarity scoring
   */
  private locationBasedReplace(content: string, search: string, replace: string): string | null {
    const contentLines = content.split('\n');
    const searchLines = search.split('\n');
    const replaceLines = replace.split('\n');

    // Build a map of trimmed content lines to their line numbers (for fast lookup)
    const contentLineMap = new Map<string, number[]>();
    contentLines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        const existing = contentLineMap.get(trimmed) || [];
        existing.push(idx);
        contentLineMap.set(trimmed, existing);
      }
    });

    // Find anchor lines from SEARCH - distinctive lines that exist in the file
    // An anchor must: be substantial (>10 chars), exist in the file, and ideally be unique
    interface Anchor {
      searchLineIdx: number;
      contentLineIdx: number;
      line: string;
      isUnique: boolean;
    }

    const anchors: Anchor[] = [];
    const seenSearchLines = new Set<string>();

    for (let i = 0; i < searchLines.length; i++) {
      const trimmed = searchLines[i].trim();

      // Skip short lines, empty lines, and duplicates within search
      if (trimmed.length <= 10 || seenSearchLines.has(trimmed)) {
        continue;
      }
      seenSearchLines.add(trimmed);

      const contentPositions = contentLineMap.get(trimmed);
      if (contentPositions && contentPositions.length > 0) {
        // Prefer unique lines (appear only once in file)
        const isUnique = contentPositions.length === 1;
        anchors.push({
          searchLineIdx: i,
          contentLineIdx: contentPositions[0], // Will refine later if multiple
          line: trimmed,
          isUnique
        });
      }
    }

    logger.info(`[DiffEngine] Found ${anchors.length} anchor lines (${anchors.filter(a => a.isUnique).length} unique)`);

    if (anchors.length === 0) {
      logger.info(`[DiffEngine] Location match failed - no anchor lines found`);
      return null;
    }

    // Sort anchors by their position in SEARCH
    anchors.sort((a, b) => a.searchLineIdx - b.searchLineIdx);

    // Find the best starting position by trying to match anchor order
    // For each possible starting position of the first anchor, check if subsequent anchors follow
    const firstAnchor = anchors[0];
    const possibleStarts = contentLineMap.get(firstAnchor.line) || [];

    let bestMatch: { startLine: number; endLine: number; score: number } | null = null;

    for (const firstAnchorPos of possibleStarts) {
      // Calculate expected start of the search block based on this anchor position
      const expectedStart = firstAnchorPos - firstAnchor.searchLineIdx;

      if (expectedStart < 0) continue;

      // Check if other anchors follow in order
      let anchorsInOrder = 1;
      let lastContentPos = firstAnchorPos;

      for (let i = 1; i < anchors.length; i++) {
        const anchor = anchors[i];
        const expectedPos = expectedStart + anchor.searchLineIdx;
        const actualPositions = contentLineMap.get(anchor.line) || [];

        // Check if this anchor exists at or near the expected position
        const nearbyPos = actualPositions.find(pos =>
          pos > lastContentPos && Math.abs(pos - expectedPos) <= 3
        );

        if (nearbyPos !== undefined) {
          anchorsInOrder++;
          lastContentPos = nearbyPos;
        }
      }

      // Calculate match quality
      const anchorScore = anchorsInOrder / anchors.length;

      // Only consider if at least 60% of anchors are in order
      if (anchorScore >= 0.6) {
        const endLine = Math.min(expectedStart + searchLines.length, contentLines.length);

        // Use jsdiff to compute actual similarity between regions
        const windowContent = contentLines.slice(expectedStart, endLine).join('\n');
        const diffScore = this.computeSimilarity(search, windowContent);

        const combinedScore = (anchorScore * 0.6) + (diffScore * 0.4);

        logger.info(`[DiffEngine] Candidate at line ${expectedStart}: anchors=${anchorScore.toFixed(2)}, diff=${diffScore.toFixed(2)}, combined=${combinedScore.toFixed(2)}`);

        if (!bestMatch || combinedScore > bestMatch.score) {
          bestMatch = { startLine: expectedStart, endLine, score: combinedScore };
        }
      }
    }

    if (!bestMatch || bestMatch.score < 0.5) {
      logger.info(`[DiffEngine] Location match failed - best score ${bestMatch?.score.toFixed(2) || 0} below threshold`);
      return null;
    }

    logger.info(`[DiffEngine] Best match at lines ${bestMatch.startLine}-${bestMatch.endLine} with score ${bestMatch.score.toFixed(2)}`);

    // Detect indentation from original
    const originalIndent = contentLines[bestMatch.startLine].match(/^(\s*)/)?.[1] || '';
    const replaceBaseIndent = replaceLines[0]?.match(/^(\s*)/)?.[1] || '';

    // Apply indentation to replacement
    const indentedReplace = replaceLines.map((line, idx) => {
      if (line.trim() === '') return line; // Keep empty lines as-is
      if (idx === 0) {
        return originalIndent + line.trimStart();
      }
      const lineIndent = line.match(/^(\s*)/)?.[1] || '';
      const relativeIndent = lineIndent.length - replaceBaseIndent.length;
      const newIndent = originalIndent + ' '.repeat(Math.max(0, relativeIndent));
      return newIndent + line.trimStart();
    });

    // Replace the lines
    const before = contentLines.slice(0, bestMatch.startLine);
    const after = contentLines.slice(bestMatch.endLine);

    logger.info(`[DiffEngine] Replacing lines ${bestMatch.startLine}-${bestMatch.endLine} with ${indentedReplace.length} lines`);

    return [...before, ...indentedReplace, ...after].join('\n');
  }

  /**
   * Compute similarity between two code blocks using jsdiff.
   * Returns a score from 0 to 1.
   */
  private computeSimilarity(text1: string, text2: string): number {
    const changes = Diff.diffLines(text1, text2);

    let unchanged = 0;
    let total = 0;

    for (const change of changes) {
      const lines = (change.value.match(/\n/g) || []).length + 1;
      total += lines;
      if (!change.added && !change.removed) {
        unchanged += lines;
      }
    }

    return total > 0 ? unchanged / total : 0;
  }

  /**
   * Apply new code to original content using LINE-LEVEL diffing.
   *
   * The key insight: diff returns changes in order. When we see:
   * - unchanged: shared content - keep it
   * - removed: in original but not in AI output - KEEP IT (AI just didn't show it)
   * - added: in AI output but not in original - ADD IT (this is new!)
   */
  applyChanges(original: string, newCode: string, options: ApplyOptions = {}): DiffResult {
    const opts = { ...this.options, ...options };

    // Debug: log what we're receiving
    logger.info(`[DiffEngine] applyChanges - code length: ${newCode.length}, has SEARCH: ${newCode.includes('SEARCH')}, has REPLACE: ${newCode.includes('REPLACE')}`);

    // Strategy 0: Try search/replace blocks first (most reliable)
    const rawBlocks = this.parseSearchReplaceBlocks(newCode);

    // Filter out invalid blocks (both search AND replace empty)
    const searchReplaceBlocks = rawBlocks.filter(block => {
      if (block.search.trim() === '' && block.replace.trim() === '') {
        logger.warn(`[DiffEngine] Skipping block with empty search AND empty replace`);
        return false;
      }
      return true;
    });
    logger.info(`[DiffEngine] Parsed ${searchReplaceBlocks.length} valid search/replace blocks (filtered from ${rawBlocks.length})`);

    if (searchReplaceBlocks.length > 0) {
      logger.info(`[DiffEngine] Block 0 search length: ${searchReplaceBlocks[0].search.length}, replace length: ${searchReplaceBlocks[0].replace.length}`);
      const result = this.applySearchReplace(original, searchReplaceBlocks);
      logger.info(`[DiffEngine] Search/replace result: success=${result.success}, message=${result.message}`);

      if (result.success) {
        return result;
      }
      // If search/replace failed, strip markers before falling through
      // This prevents markers from confusing subsequent strategies
      logger.info(`[DiffEngine] Search/replace failed, stripping markers for fallback strategies`);
    }

    // For fallback strategies, use clean code without search/replace markers
    let cleanCode = newCode;
    if (searchReplaceBlocks.length > 0) {
      // Extract just the REPLACE content for fallback
      cleanCode = searchReplaceBlocks.map(b => b.replace).join('\n\n');
    }
    cleanCode = cleanCode.replace(/^#\s*File:.*\n/i, '');

    // Strategy 1: Full file replacement
    if (this.shouldReplaceWholeFile(original, cleanCode)) {
      return { content: cleanCode, success: true, operation: 'replace' };
    }

    // Strategy 2: Use LINE-LEVEL diff to merge
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
   */
  private mergeWithLineDiff(original: string, cleanCode: string): DiffResult | null {
    try {
      const changes = Diff.diffLines(original, cleanCode);

      // Build result: KEEP original content (unchanged + removed), ADD new content (added)
      let result = '';
      let hasInsertions = false;

      for (const change of changes) {
        if (!change.added && !change.removed) {
          // Unchanged: shared between original and AI output - keep it
          result += change.value;
        } else if (change.added) {
          // Added: in AI output but not in original - this is NEW, add it
          result += change.value;
          hasInsertions = true;
        } else if (change.removed) {
          // Removed: in original but not in AI output - KEEP IT
          // The AI just showed a snippet, we don't want to delete original content
          result += change.value;
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
}

export const diffEngine = new DiffEngine();
