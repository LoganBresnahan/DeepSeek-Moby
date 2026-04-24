/**
 * ContentTransformBuffer - Progressive content transformation for streaming responses
 *
 * Uses a "lookahead" pattern common in lexers/parsers: emit safe content immediately,
 * only hold back when there's ambiguity (potential pattern start like "<" that could
 * become "<shell>").
 *
 * This provides smooth streaming while preventing jarring UI transitions when raw
 * <shell> or <think> tags would briefly appear before being handled separately.
 *
 * NOTE: Code blocks (```) are NOT filtered - they flow through as normal text and are
 * rendered by the frontend's markdown processing.
 *
 * Architecture:
 * - Tokens arrive via append()
 * - Safe content is emitted IMMEDIATELY (no debounce)
 * - Only potential pattern starts are held back (e.g., "<", "<s", "<sh"...)
 * - Debounce timer is a FALLBACK for releasing held-back content if stream pauses
 */

export type SegmentType = 'text' | 'shell' | 'thinking' | 'codeblock' | 'web_search' | 'dsml';

export interface BufferedSegment {
  type: SegmentType;
  content: string | ShellCommand[] | CodeBlockContent;
  complete: boolean;
}

export interface ShellCommand {
  command: string;
}

export interface CodeBlockContent {
  language: string;
  code: string;
}

export interface TransformPattern {
  type: SegmentType;
  // Regex to match the start of a block
  startPattern: RegExp;
  // Regex to match the end of a block
  endPattern: RegExp;
  // Extract structured content from raw block
  extract: (raw: string) => ShellCommand[] | CodeBlockContent | string;
}

export interface ContentTransformBufferOptions {
  /** Debounce delay in ms (default: 150) */
  debounceMs?: number;
  /** Callback when segments are ready */
  onFlush: (segments: BufferedSegment[]) => void;
  /** Optional: Custom patterns to add */
  additionalPatterns?: TransformPattern[];
  /**
   * Callback when a complete shell command is detected during streaming.
   * Used by interrupt-and-resume: the orchestrator aborts the stream,
   * executes the command, and resumes with a new API call.
   *
   * @param command - The raw command string (content between <shell> tags)
   * @param textBefore - The text content that appeared before the shell tag (already flushed)
   */
  onShellDetected?: (command: string, textBefore: string) => void;
}

/**
 * Default patterns for content transformation
 */
const DEFAULT_PATTERNS: TransformPattern[] = [
  {
    type: 'shell',
    startPattern: /<shell>/,
    endPattern: /<\/shell>/,
    extract: (raw: string): ShellCommand[] => {
      // Return the entire shell tag content as a single raw command.
      // The inline executor uses parseShellCommands() for proper
      // heredoc-aware parsing (multi-line commands stay together).
      const inner = raw.replace(/<\/?shell>/g, '').trim();
      if (!inner) return [];
      return [{ command: inner }];
    }
  },
  {
    type: 'thinking',
    startPattern: /<think>/,
    endPattern: /<\/think>/,
    extract: (raw: string): string => {
      return raw.replace(/<\/?think>/g, '').trim();
    }
  },
  {
    type: 'web_search',
    startPattern: /<web_search>/,
    endPattern: /<\/web_search>/,
    extract: (raw: string): string => {
      return raw.replace(/<\/?web_search>/g, '').trim();
    }
  },
  {
    // DeepSeek-Chat occasionally emits tool calls as DSML text instead of
    // structured `tool_calls`. `parseDSMLToolCalls` recovers the call at
    // end-of-response; here we hide the raw DSML from the streaming display
    // so the user doesn't see `<｜DSML｜function_calls>...` flash by.
    type: 'dsml',
    startPattern: /<｜DSML｜function_calls>/,
    endPattern: /<\/｜DSML｜function_calls>/,
    extract: (): string => ''
  }
  // NOTE: Code blocks are NOT filtered here - they flow through as normal text
  // and are rendered by the frontend's markdown processing. Only <shell>, <think>,
  // <web_search>, and DSML tags need special handling because they shouldn't appear
  // raw in the UI.
];

export class ContentTransformBuffer {
  private buffer = '';
  private debounceMs: number;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private onFlush: (segments: BufferedSegment[]) => void;
  private patterns: TransformPattern[];

  // Track emitted text to avoid duplicates
  private lastEmittedPosition = 0;

  // Debug logging
  private debug: boolean;
  private log: (message: string) => void;
  private appendCount = 0;
  private flushCount = 0;

  /** Callback for interrupt-and-resume shell execution */
  private onShellDetected: ((command: string, textBefore: string) => void) | null = null;

  /** Tracks whether a shell interrupt has been signaled (stops further processing) */
  private _shellInterrupted = false;

  constructor(options: ContentTransformBufferOptions & { debug?: boolean; log?: (message: string) => void }) {
    this.debounceMs = options.debounceMs ?? 150;
    this.onFlush = options.onFlush;
    this.patterns = [...DEFAULT_PATTERNS, ...(options.additionalPatterns || [])];
    this.debug = options.debug ?? false;
    this.log = options.log ?? console.log;
    this.onShellDetected = options.onShellDetected ?? null;
  }

  private debugLog(message: string): void {
    if (this.debug) {
      this.log(`[Buffer] ${message}`);
    }
  }

  /**
   * Append a streaming token to the buffer.
   * Uses progressive flush: emit safe content immediately, only hold back potential pattern starts.
   */
  append(token: string): void {
    // After a shell interrupt, ignore further tokens — the stream is being aborted
    if (this._shellInterrupted) return;

    this.appendCount++;
    const tokenPreview = token.length > 30 ? token.slice(0, 30) + '...' : token;
    this.debugLog(`append #${this.appendCount}: "${tokenPreview.replace(/\n/g, '\\n')}" (${token.length} chars, buffer now ${this.buffer.length + token.length} chars, pending from pos ${this.lastEmittedPosition})`);
    this.buffer += token;

    // Progressive flush: process immediately to emit any safe content
    // This is the key change from debounce-only approach
    const emittedSomething = this.processBuffer(false);

    // If we're holding back content (potential pattern start), schedule a fallback timer
    // This releases held content if the stream pauses (e.g., "<" that never becomes "<shell>")
    const pendingLength = this.buffer.length - this.lastEmittedPosition;
    if (pendingLength > 0) {
      this.scheduleFlush();
    } else if (this.debounceTimer) {
      // Nothing pending, cancel any existing timer
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /**
   * Force an immediate flush of the buffer.
   * Call this when the stream ends.
   */
  flush(): void {
    this.flushCount++;
    const pendingContent = this.buffer.length - this.lastEmittedPosition;
    this.debugLog(`flush #${this.flushCount}: FORCED (pending ${pendingContent} chars from pos ${this.lastEmittedPosition}/${this.buffer.length})`);
    if (this.debounceTimer) {
      this.debugLog(`flush #${this.flushCount}: cancelled pending debounce timer`);
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.processBuffer(true);
  }

  /**
   * Reset the buffer state.
   * Call this when starting a new message/stream.
   */
  reset(): void {
    this.debugLog(`reset: clearing buffer (was ${this.buffer.length} chars, emitted up to pos ${this.lastEmittedPosition})`);
    this.buffer = '';
    this.lastEmittedPosition = 0;
    this.appendCount = 0;
    this.flushCount = 0;
    this._shellInterrupted = false;
    if (this.debounceTimer) {
      this.debugLog(`reset: cancelled pending debounce timer`);
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /**
   * Get current buffer contents (for debugging)
   */
  getBuffer(): string {
    return this.buffer;
  }

  /**
   * Check if the buffer is holding back content (potential partial tag).
   * Used by chatProvider to avoid flushing tokens while tags are being accumulated.
   */
  isHoldingBack(): boolean {
    return this.buffer.length > this.lastEmittedPosition;
  }

  /**
   * Check if the pending content contains a pattern start tag (e.g., <shell>)
   * without a matching end tag. If so, the debounce should NOT release this content.
   */
  private isInsideOpenTag(): boolean {
    const pending = this.buffer.slice(this.lastEmittedPosition);
    for (const pattern of this.patterns) {
      const startMatch = pattern.startPattern.exec(pending);
      if (startMatch) {
        // Found a start tag — check if there's a matching end tag
        const afterStart = pending.slice(startMatch.index + startMatch[0].length);
        const endMatch = pattern.endPattern.exec(afterStart);
        if (!endMatch) {
          // Start tag found but no end tag — we're inside an open tag
          return true;
        }
      }
    }
    return false;
  }

  private scheduleFlush(): void {
    if (this.debounceTimer) {
      this.debugLog(`scheduleFlush: resetting fallback timer (${this.debounceMs}ms)`);
      clearTimeout(this.debounceTimer);
    } else {
      const heldBack = this.buffer.length - this.lastEmittedPosition;
      this.debugLog(`scheduleFlush: starting fallback timer (${this.debounceMs}ms) for ${heldBack} held chars`);
    }
    this.debounceTimer = setTimeout(() => {
      const heldBack = this.buffer.length - this.lastEmittedPosition;

      // DON'T release content if we're inside an open tag (e.g., <shell> without </shell>).
      // The stream is still sending content that belongs inside the tag (heredoc blocks, etc.).
      // Only release when the held content is ambiguous partial starts (like "<" that might
      // or might not become "<shell>").
      if (this.isInsideOpenTag()) {
        this.debugLog(`scheduleFlush: inside open tag, NOT releasing ${heldBack} held chars — rescheduling`);
        // Reschedule — keep checking until the tag closes or the stream truly ends
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          this.scheduleFlush();
        }, this.debounceMs);
        return;
      }

      this.debugLog(`scheduleFlush: fallback timer fired, releasing ${heldBack} held chars`);
      // Use isFinal=true to release held content - stream has paused long enough
      // that we should assume any partial pattern start (like "<") is just text
      this.processBuffer(true);
      this.debounceTimer = null;
    }, this.debounceMs);
  }

  private processBuffer(isFinal: boolean): boolean {
    const pendingLength = this.buffer.length - this.lastEmittedPosition;
    this.debugLog(`processBuffer: isFinal=${isFinal}, cursor=${this.lastEmittedPosition}, bufferLen=${this.buffer.length}, pending=${pendingLength} chars`);

    const segments: BufferedSegment[] = [];
    let cursor = this.lastEmittedPosition;

    while (cursor < this.buffer.length) {
      // Check if any pattern starts at or after cursor
      let earliestMatch: {
        pattern: TransformPattern;
        startIndex: number;
        startMatch: RegExpExecArray;
      } | null = null;

      for (const pattern of this.patterns) {
        // Search from cursor position
        const searchText = this.buffer.slice(cursor);
        const startMatch = pattern.startPattern.exec(searchText);

        if (startMatch) {
          const absoluteStartIndex = cursor + startMatch.index;
          if (!earliestMatch || absoluteStartIndex < earliestMatch.startIndex) {
            earliestMatch = {
              pattern,
              startIndex: absoluteStartIndex,
              startMatch
            };
          }
        }
      }

      if (!earliestMatch) {
        // No patterns found in remaining buffer
        const remaining = this.buffer.slice(cursor);

        if (isFinal) {
          // Final flush - emit everything
          if (remaining.length > 0) {
            segments.push({
              type: 'text',
              content: remaining,
              complete: true
            });
          }
          cursor = this.buffer.length;
        } else {
          // Not final - check if trailing chars might be partial pattern start
          // Only hold back if we see potential pattern characters at the end
          const holdBackLength = this.getHoldBackLength(remaining);
          const safeEmitEnd = this.buffer.length - holdBackLength;

          if (safeEmitEnd > cursor) {
            const text = this.buffer.slice(cursor, safeEmitEnd);
            if (text.length > 0) {
              segments.push({
                type: 'text',
                content: text,
                complete: true
              });
            }
            cursor = safeEmitEnd;
          }
        }
        break;
      }

      // Emit any text before the pattern start
      if (earliestMatch.startIndex > cursor) {
        const text = this.buffer.slice(cursor, earliestMatch.startIndex);
        if (text.length > 0) {
          segments.push({
            type: 'text',
            content: text,
            complete: true
          });
          // Advance cursor so the text isn't re-emitted if the pattern is
          // incomplete and we break out below. (The shell-interrupt path
          // handles this explicitly; the generic break case was missing it.)
          cursor = earliestMatch.startIndex;
        }
      }

      // Try to find the end of this pattern
      const afterStartIndex = earliestMatch.startIndex + earliestMatch.startMatch[0].length;
      const searchForEnd = this.buffer.slice(afterStartIndex);
      const endMatch = earliestMatch.pattern.endPattern.exec(searchForEnd);

      if (endMatch) {
        // Complete block found!
        const blockEnd = afterStartIndex + endMatch.index + endMatch[0].length;
        const rawBlock = this.buffer.slice(earliestMatch.startIndex, blockEnd);

        // Interrupt-and-resume: if this is a shell tag and onShellDetected is set,
        // flush text segments accumulated so far, then fire the callback instead of
        // emitting the shell segment. The orchestrator will abort the stream.
        if (earliestMatch.pattern.type === 'shell' && this.onShellDetected && !isFinal) {
          // Flush any text segments we've accumulated before the shell tag
          if (segments.length > 0) {
            this.lastEmittedPosition = earliestMatch.startIndex;
            this.debugLog(`processBuffer: flushing ${segments.length} text segment(s) before shell interrupt`);
            this.onFlush(segments);
          }

          // Update cursor past the shell tag
          this.lastEmittedPosition = blockEnd;

          // Extract the command
          const command = rawBlock.replace(/<\/?shell>/g, '').trim();

          // Collect text that was emitted before this shell tag in this stream
          const textBefore = segments
            .filter(s => s.type === 'text' && typeof s.content === 'string')
            .map(s => s.content as string)
            .join('');

          this.debugLog(`processBuffer: shell interrupt — command="${command.substring(0, 50)}...", textBefore=${textBefore.length} chars`);
          this._shellInterrupted = true;
          this.onShellDetected(command, textBefore);

          // Return true — we emitted segments. The stream will be aborted by the callback.
          return true;
        }

        segments.push({
          type: earliestMatch.pattern.type,
          content: earliestMatch.pattern.extract(rawBlock),
          complete: true
        });

        cursor = blockEnd;
        // Continue loop to process anything after this block
      } else {
        // Incomplete block
        if (isFinal) {
          // Final flush - emit as incomplete
          const rawBlock = this.buffer.slice(earliestMatch.startIndex);
          segments.push({
            type: earliestMatch.pattern.type,
            content: rawBlock, // Raw, couldn't parse
            complete: false
          });
          cursor = this.buffer.length;
        } else {
          // Not final - wait for more content
          // Don't emit anything past this point
          break;
        }
      }
    }

    // Update position tracker
    this.lastEmittedPosition = cursor;

    // Emit segments if we have any
    if (segments.length > 0) {
      const segmentSummary = segments.map(s => {
        const contentPreview = typeof s.content === 'string'
          ? (s.content.length > 50 ? s.content.slice(0, 50) + '...' : s.content).replace(/\n/g, '\\n')
          : Array.isArray(s.content) ? `[${s.content.length} items]` : JSON.stringify(s.content);
        return `${s.type}(${s.complete ? 'complete' : 'incomplete'}): "${contentPreview}"`;
      }).join(', ');
      this.debugLog(`processBuffer: emitting ${segments.length} segment(s): ${segmentSummary}`);
      this.onFlush(segments);
      return true;
    } else {
      const heldBack = this.buffer.length - this.lastEmittedPosition;
      this.debugLog(`processBuffer: no segments to emit (holding back ${heldBack} chars for potential pattern)`);
      return false;
    }
  }

  /**
   * Determine how many trailing characters to hold back for potential pattern starts.
   * Returns 0 if the ending is safe to emit.
   */
  private getHoldBackLength(text: string): number {
    if (text.length === 0) return 0;

    // Check trailing characters for potential pattern starts.
    // Longest pattern start: `<｜DSML｜function_calls>` (23 chars).
    const maxCheck = Math.min(23, text.length);

    for (let len = maxCheck; len >= 1; len--) {
      const suffix = text.slice(-len);
      if (this.couldBePatternStart(suffix)) {
        return len;
      }
    }

    return 0;
  }

  /**
   * Check if a string could be the beginning of a pattern.
   */
  private couldBePatternStart(text: string): boolean {
    if (!text.startsWith('<')) return false;

    // Shell tag prefixes
    if ('<shell>'.startsWith(text)) return true;
    if ('</shell>'.startsWith(text)) return true;

    // Think tag prefixes
    if ('<think>'.startsWith(text)) return true;
    if ('</think>'.startsWith(text)) return true;

    // Web search tag prefixes
    if ('<web_search>'.startsWith(text)) return true;
    if ('</web_search>'.startsWith(text)) return true;

    // DSML tool-call tag prefixes (DeepSeek-Chat text-format fallback)
    if ('<｜DSML｜function_calls>'.startsWith(text)) return true;
    if ('</｜DSML｜function_calls>'.startsWith(text)) return true;

    // NOTE: Code block prefixes (```) are NOT checked - they flow through as normal text

    return false;
  }
}

/**
 * Helper to check if a string ends with a potential pattern start.
 * Useful for deciding whether to hold back text.
 */
export function mightContainPatternStart(text: string): boolean {
  if (text.length === 0) return false;

  // Check trailing characters up to the longest pattern start (`<｜DSML｜function_calls>` = 23 chars)
  const maxCheck = Math.min(23, text.length);

  for (let len = maxCheck; len >= 1; len--) {
    const suffix = text.slice(-len);
    if (!suffix.startsWith('<')) continue;

    if ('<shell>'.startsWith(suffix)) return true;
    if ('</shell>'.startsWith(suffix)) return true;
    if ('<think>'.startsWith(suffix)) return true;
    if ('</think>'.startsWith(suffix)) return true;
    if ('<web_search>'.startsWith(suffix)) return true;
    if ('</web_search>'.startsWith(suffix)) return true;
    if ('<｜DSML｜function_calls>'.startsWith(suffix)) return true;
    if ('</｜DSML｜function_calls>'.startsWith(suffix)) return true;

    // NOTE: Code block prefixes (```) are NOT checked - they flow through as normal text
  }

  return false;
}
