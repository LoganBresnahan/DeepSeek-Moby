/**
 * Fence-length-aware code block parser following CommonMark spec.
 *
 * A closing fence must use the same character and at least as many characters
 * as the opening fence. This means ```` (4 backticks) is NOT closed by ``` (3),
 * allowing nested code fences to work correctly.
 *
 * This module is pure TypeScript with no runtime dependencies on vscode, DOM,
 * or Node APIs — so both the extension bundle (src/) and the webview bundle
 * (media/) import it directly. See ADR 0003.
 */

export interface CodeBlock {
  /** Language tag after opening fence (e.g., 'typescript', 'markdown') */
  language: string;
  /** Content between opening and closing fences (not including fences) */
  content: string;
  /** Start index in the original text (position of opening fence) */
  startIndex: number;
  /** End index in the original text (position after closing fence's newline) */
  endIndex: number;
  /** The full matched text including fences */
  raw: string;
}

/**
 * Extract fenced code blocks from text, respecting CommonMark fence-length rules.
 * A closing fence must use the same character and at least as many characters
 * as the opening fence. This correctly handles nested fences.
 */
export function extractCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    // Match opening fence: 3+ backticks or tildes, optional language tag
    const openMatch = lines[i].match(/^(`{3,}|~{3,})(\w*)\s*$/);
    if (!openMatch) { i++; continue; }

    const fenceChar = openMatch[1][0]; // '`' or '~'
    const fenceLen = openMatch[1].length;
    const language = openMatch[2] || '';
    const startLine = i;
    const contentLines: string[] = [];
    i++;

    // Scan for closing fence: same char, >= length, no info string
    let closed = false;
    while (i < lines.length) {
      const escapedChar = fenceChar === '`' ? '`' : '~';
      const closeMatch = lines[i].match(new RegExp(`^(${escapedChar}{${fenceLen},})\\s*$`));
      if (closeMatch) {
        const startIndex = lines.slice(0, startLine).join('\n').length + (startLine > 0 ? 1 : 0);
        const endIndex = lines.slice(0, i + 1).join('\n').length + (i + 1 < lines.length ? 1 : 0);
        const content = contentLines.join('\n');
        const raw = lines.slice(startLine, i + 1).join('\n');
        blocks.push({ language: language || 'plaintext', content, startIndex, endIndex, raw });
        i++;
        closed = true;
        break;
      }
      contentLines.push(lines[i]);
      i++;
    }

    // If never closed, the rest of the document is inside the fence (CommonMark rule).
    // For our purposes, skip it — an unclosed fence during streaming is expected.
    if (!closed) break;
  }

  return blocks;
}

/**
 * Detect whether the text has an unclosed top-level code fence.
 * Returns the character index of the last unclosed opening fence.
 * Used for segment splitting during streaming.
 */
export function hasIncompleteFence(text: string): { incomplete: boolean; lastOpenIndex: number } {
  const lines = text.split('\n');
  let i = 0;
  let lastOpenIndex = -1;
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;

  while (i < lines.length) {
    if (!inFence) {
      const openMatch = lines[i].match(/^(`{3,}|~{3,})(\w*)\s*$/);
      if (openMatch) {
        fenceChar = openMatch[1][0];
        fenceLen = openMatch[1].length;
        inFence = true;
        // Calculate char index of this line
        lastOpenIndex = lines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0);
      }
    } else {
      const escapedChar = fenceChar === '`' ? '`' : '~';
      const closeRegex = new RegExp(`^(${escapedChar}{${fenceLen},})\\s*$`);
      if (closeRegex.test(lines[i])) {
        inFence = false;
      }
    }
    i++;
  }

  return { incomplete: inFence, lastOpenIndex };
}
