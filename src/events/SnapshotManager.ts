/**
 * SnapshotManager - Periodic conversation summaries for context optimization
 *
 * Snapshots are compressed summaries of conversation history that allow
 * efficient context building for long conversations. Instead of replaying
 * all events, we use the snapshot summary + recent events.
 *
 * Key concepts:
 * - Snapshots are created periodically (every N events)
 * - Each snapshot summarizes events UP TO a certain sequence
 * - All snapshots are kept (cleaned up when session is deleted)
 * - Snapshots can be generated via LLM or simple extraction
 */

import { v4 as uuidv4 } from 'uuid';
import { Database } from './SqlJsWrapper';
import { EventStore } from './EventStore';
import { logger } from '../utils/logger';
import {
  ConversationEvent,
  isUserMessageEvent,
  isAssistantMessageEvent,
  isDiffAcceptedEvent
} from './EventTypes';

// Statement interface for our wrapper
interface Statement {
  run(...params: unknown[]): void;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

/**
 * Snapshot data structure.
 */
export interface Snapshot {
  id: string;
  sessionId: string;
  /** Events up to and including this sequence are summarized */
  upToSequence: number;
  timestamp: number;
  /** Human-readable summary of the conversation so far */
  summary: string;
  /** Key facts/decisions extracted from the conversation */
  keyFacts: string[];
  /** Files that were modified in the summarized portion */
  filesModified: string[];
  /** Estimated token count of the summary */
  tokenCount: number;
}

/**
 * Content generated for a snapshot.
 */
export interface SnapshotContent {
  summary: string;
  keyFacts: string[];
  filesModified: string[];
  tokenCount: number;
}

/**
 * Function type for generating snapshot summaries.
 * Can be simple extraction or LLM-powered.
 *
 * @param events - Events to summarize (since last snapshot, or all if first)
 * @param previousSummary - Summary from the previous snapshot, if chaining
 */
export type SummarizerFn = (events: ConversationEvent[], previousSummary?: string) => Promise<SnapshotContent>;

export class SnapshotManager {
  private db: Database;
  private eventStore: EventStore;
  private summarizer: SummarizerFn;

  // Configuration
  private readonly SNAPSHOT_INTERVAL: number;

  // Prepared statements
  private stmtInsertSnapshot!: Statement;
  private stmtGetLatestSnapshot!: Statement;
  private stmtGetSnapshotById!: Statement;
  private stmtGetAllSnapshots!: Statement;
  private stmtDeleteSessionSnapshots!: Statement;

  constructor(
    db: Database,
    eventStore: EventStore,
    summarizer: SummarizerFn,
    options?: {
      snapshotInterval?: number;
    }
  ) {
    this.db = db;
    this.eventStore = eventStore;
    this.summarizer = summarizer;

    // Default: create snapshot every 20 events
    this.SNAPSHOT_INTERVAL = options?.snapshotInterval ?? 20;

    this.initSchema();
    this.prepareStatements();
  }

  /**
   * Initialize the snapshots table schema.
   */
  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        up_to_sequence INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        summary TEXT NOT NULL,
        key_facts TEXT NOT NULL,
        files_modified TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        UNIQUE(session_id, up_to_sequence)
      );

      CREATE INDEX IF NOT EXISTS idx_snapshots_session
        ON snapshots(session_id, up_to_sequence DESC);
    `);
  }

  /**
   * Prepare SQL statements for reuse.
   */
  private prepareStatements(): void {
    this.stmtInsertSnapshot = this.db.prepare(`
      INSERT INTO snapshots (id, session_id, up_to_sequence, timestamp,
                            summary, key_facts, files_modified, token_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetLatestSnapshot = this.db.prepare(`
      SELECT * FROM snapshots
      WHERE session_id = ?
      ORDER BY up_to_sequence DESC
      LIMIT 1
    `);

    this.stmtGetSnapshotById = this.db.prepare(`
      SELECT * FROM snapshots WHERE id = ?
    `);

    this.stmtGetAllSnapshots = this.db.prepare(`
      SELECT s.*, sess.title as session_title
      FROM snapshots s
      LEFT JOIN sessions sess ON s.session_id = sess.id
      ORDER BY s.timestamp DESC
    `);

    this.stmtDeleteSessionSnapshots = this.db.prepare(`
      DELETE FROM snapshots WHERE session_id = ?
    `);
  }

  /**
   * Check if a snapshot should be created and create it if needed.
   * Called after recording events.
   *
   * @param sessionId - Session to check
   * @returns The new snapshot if created, null otherwise
   */
  async maybeCreateSnapshot(sessionId: string): Promise<Snapshot | null> {
    const latestSeq = this.eventStore.getLatestSequence(sessionId);
    const lastSnapshot = this.getLatestSnapshot(sessionId);

    const eventsSinceSnapshot = latestSeq - (lastSnapshot?.upToSequence ?? 0);

    if (eventsSinceSnapshot < this.SNAPSHOT_INTERVAL) {
      logger.debug(
        `[Snapshot] maybeCreateSnapshot skipped` +
        ` | events=${eventsSinceSnapshot}/${this.SNAPSHOT_INTERVAL}` +
        ` | session=${sessionId.substring(0, 8)}`
      );
      return null;
    }

    return this.createSnapshot(sessionId);
  }

  /**
   * Force create a snapshot at the current point.
   *
   * @param sessionId - Session to snapshot
   * @returns The created snapshot
   */
  async createSnapshot(sessionId: string): Promise<Snapshot> {
    const lastSnapshot = this.getLatestSnapshot(sessionId);
    const fromSeq = lastSnapshot?.upToSequence ?? 0;
    const latestSeq = this.eventStore.getLatestSequence(sessionId);

    // Get events since last snapshot
    const events = this.eventStore.getEvents(sessionId, fromSeq);

    logger.info(
      `[Snapshot] Creating snapshot for session=${sessionId.substring(0, 8)}` +
      ` | events=${events.length} (seq ${fromSeq + 1}..${latestSeq})` +
      ` | chained=${!!lastSnapshot}`
    );

    const startTime = Date.now();

    // Generate summary (pass previous summary for chaining)
    const content = await this.summarizer(events, lastSnapshot?.summary);

    const duration = Date.now() - startTime;

    const snapshot: Snapshot = {
      id: uuidv4(),
      sessionId,
      upToSequence: latestSeq,
      timestamp: Date.now(),
      summary: content.summary,
      keyFacts: content.keyFacts,
      filesModified: content.filesModified,
      tokenCount: content.tokenCount
    };

    logger.info(
      `[Snapshot] Created in ${duration}ms` +
      ` | summary=${content.summary.length} chars (~${content.tokenCount} tokens)` +
      ` | files=${content.filesModified.length}` +
      ` | facts=${content.keyFacts.length}`
    );

    // Store the snapshot
    this.stmtInsertSnapshot.run(
      snapshot.id,
      snapshot.sessionId,
      snapshot.upToSequence,
      snapshot.timestamp,
      snapshot.summary,
      JSON.stringify(snapshot.keyFacts),
      JSON.stringify(snapshot.filesModified),
      snapshot.tokenCount
    );

    return snapshot;
  }

  /**
   * Get the most recent snapshot for a session.
   *
   * @param sessionId - Session to get snapshot for
   * @returns The latest snapshot or null
   */
  getLatestSnapshot(sessionId: string): Snapshot | null {
    const row = this.stmtGetLatestSnapshot.get(sessionId) as any;
    return row ? this.rowToSnapshot(row) : null;
  }

  /**
   * Get a specific snapshot by ID.
   *
   * @param snapshotId - Snapshot ID to look up
   * @returns The snapshot or null
   */
  getSnapshotById(snapshotId: string): Snapshot | null {
    const row = this.stmtGetSnapshotById.get(snapshotId) as any;
    return row ? this.rowToSnapshot(row) : null;
  }

  /**
   * Get all snapshots across all sessions.
   * Used for the session picker UI.
   *
   * @returns Array of snapshots with session titles
   */
  getAllSnapshots(): Array<Snapshot & { sessionTitle: string }> {
    const rows = this.stmtGetAllSnapshots.all() as any[];
    return rows.map(row => ({
      ...this.rowToSnapshot(row),
      sessionTitle: row.session_title || 'Unknown Session'
    }));
  }

  /**
   * Delete all snapshots for a session.
   *
   * @param sessionId - Session to delete snapshots for
   */
  deleteSessionSnapshots(sessionId: string): void {
    this.stmtDeleteSessionSnapshots.run(sessionId);
  }


  /**
   * Convert a database row to a Snapshot object.
   */
  private rowToSnapshot(row: any): Snapshot {
    return {
      id: row.id,
      sessionId: row.session_id,
      upToSequence: row.up_to_sequence,
      timestamp: row.timestamp,
      summary: row.summary,
      keyFacts: JSON.parse(row.key_facts),
      filesModified: JSON.parse(row.files_modified),
      tokenCount: row.token_count
    };
  }
}

// ============================================================================
// LLM-Powered Summarizer (with Chaining)
// ============================================================================

/**
 * Minimal chat function interface for the LLM summarizer.
 * Keeps the events module independent of DeepSeekClient.
 */
export interface SummarizerChatFn {
  (messages: Array<{ role: string; content: string }>, systemPrompt?: string, options?: { maxTokens?: number; temperature?: number }): Promise<{ content: string }>;
}

const FIRST_SUMMARY_PROMPT = `Summarize the following conversation history. Your summary will be injected as context at the start of future requests in this conversation when older messages are dropped to fit the context window.

Include:
- What the user is working on and their goals
- Key decisions made and their rationale
- Current state of any code changes (files modified, what was done)
- Any constraints or preferences the user expressed
- Important technical details that would be needed to continue the conversation

Be concise but thorough. Focus on information that would be lost if the original messages were dropped.`;

const CHAINED_SUMMARY_PROMPT = `Below is a summary of the earlier portion of this conversation, followed by the new messages since that summary was created. Produce an updated summary that incorporates both.

Your summary will be injected as context at the start of future requests when older messages are dropped to fit the context window.

Preserve important details from the previous summary while integrating new information. If new messages contradict or supersede earlier decisions, reflect the current state.`;

/**
 * Format conversation events into a readable text block for the LLM.
 * Focuses on the conversation flow: messages, tool usage, and file edits.
 */
function formatEventsForSummary(events: ConversationEvent[]): string {
  const parts: string[] = [];

  for (const event of events) {
    switch (event.type) {
      case 'user_message':
        parts.push(`User: ${event.content}`);
        break;
      case 'assistant_message':
        parts.push(`Assistant: ${event.content}`);
        break;
      case 'tool_call':
        parts.push(`[Tool: ${event.toolName}]`);
        break;
      case 'tool_result':
        // Truncate long tool results
        const result = event.result.length > 200
          ? event.result.substring(0, 200) + '...'
          : event.result;
        parts.push(`[Tool result: ${event.success ? 'success' : 'error'} — ${result}]`);
        break;
      case 'diff_created':
        parts.push(`[File edit: ${event.filePath}]`);
        break;
      case 'diff_accepted':
        parts.push(`[Change accepted]`);
        break;
      case 'web_search':
        parts.push(`[Web search: ${event.query}]`);
        break;
      // Skip: assistant_reasoning, diff_rejected, file_read, file_write, errors, session events
    }
  }

  return parts.join('\n');
}

/**
 * LLM-powered summarizer with chaining support.
 *
 * First call: summarizes all raw events.
 * Subsequent calls: takes previous summary + new events, produces updated summary.
 * This bounds summarizer input to O(1) per cycle instead of O(n).
 *
 * @param chatFn - Function that calls the LLM (wraps DeepSeekClient.chat())
 * @param maxTokens - Max output tokens for the summary (default: 4000)
 */
export function createLLMSummarizer(chatFn: SummarizerChatFn, maxTokens: number = 4000): SummarizerFn {
  return async (events: ConversationEvent[], previousSummary?: string): Promise<SnapshotContent> => {
    const conversationText = formatEventsForSummary(events);
    const mode = previousSummary ? 'chained' : 'first';

    let userPrompt: string;
    if (previousSummary) {
      // Chained summarization
      userPrompt = `Previous summary:\n${previousSummary}\n\nNew messages since then:\n${conversationText}`;
    } else {
      // First summarization
      userPrompt = `Conversation:\n${conversationText}`;
    }

    const systemPrompt = previousSummary ? CHAINED_SUMMARY_PROMPT : FIRST_SUMMARY_PROMPT;
    const promptChars = userPrompt.length + systemPrompt.length;

    logger.info(
      `[Snapshot] LLM summarize (${mode})` +
      ` | input=${promptChars.toLocaleString()} chars (~${Math.ceil(promptChars / 4).toLocaleString()} tokens)` +
      ` | events=${events.length}`
    );

    const startTime = Date.now();

    let response: { content: string };
    try {
      response = await chatFn(
        [{ role: 'user', content: userPrompt }],
        systemPrompt,
        { maxTokens, temperature: 0.3 }
      );
    } catch (error: any) {
      logger.error(`[Snapshot] LLM summarize failed: ${error.message}`);
      throw error;
    }

    const duration = Date.now() - startTime;
    const summary = response.content;

    logger.info(
      `[Snapshot] LLM summarize complete in ${duration}ms` +
      ` | output=${summary.length} chars (~${Math.ceil(summary.length / 4)} tokens)`
    );

    // Extract files modified from the events (same logic as extractive)
    const filesModified = new Set<string>();
    events.forEach(event => {
      if (event.type === 'diff_created') {
        filesModified.add(event.filePath);
      }
      if ((event.type === 'diff_accepted' || event.type === 'file_write') && 'filePath' in event) {
        const filePath = (event as any).filePath;
        if (filePath) filesModified.add(filePath);
      }
    });

    // Extract key facts from user messages
    const userMessages = events.filter(isUserMessageEvent);
    const keyFacts = userMessages
      .slice(0, 5)
      .map(e => {
        const content = e.content.substring(0, 100);
        return content + (e.content.length > 100 ? '...' : '');
      });

    // Estimate token count (~4 chars per token for DeepSeek BPE)
    const tokenCount = Math.ceil(summary.length / 4);

    return {
      summary,
      keyFacts,
      filesModified: Array.from(filesModified),
      tokenCount
    };
  };
}

// ============================================================================
// Default Summarizer (Simple Extraction)
// ============================================================================

/**
 * Simple extractive summarizer that doesn't require LLM.
 * Extracts key information from events without generating new text.
 */
export function createExtractSummarizer(): SummarizerFn {
  return async (events: ConversationEvent[]): Promise<SnapshotContent> => {
    logger.debug(`[Snapshot] Extractive summarizer called | events=${events.length}`);
    // Collect user messages
    const userMessages = events.filter(isUserMessageEvent);

    // Collect files modified
    const filesModified = new Set<string>();
    events.forEach(event => {
      if (event.type === 'diff_accepted' || event.type === 'file_write') {
        const filePath = 'filePath' in event ? event.filePath : undefined;
        if (filePath) filesModified.add(filePath);
      }
      if (event.type === 'diff_created') {
        filesModified.add(event.filePath);
      }
    });

    // Build summary from user messages
    const summaryParts = userMessages
      .slice(0, 5) // Take first 5 user messages
      .map(e => e.content.substring(0, 150));

    const summary = summaryParts.length > 0
      ? `Conversation topics:\n${summaryParts.map(s => `- ${s}${s.length >= 150 ? '...' : ''}`).join('\n')}`
      : 'Empty conversation';

    // Extract key facts from user requests
    const keyFacts = userMessages
      .slice(0, 3)
      .map(e => {
        const content = e.content.substring(0, 80);
        return `User requested: ${content}${content.length >= 80 ? '...' : ''}`;
      });

    // Estimate token count (~4 chars per token)
    const tokenCount = Math.ceil(summary.length / 4);

    logger.debug(
      `[Snapshot] Extractive summarizer complete` +
      ` | summary=${summary.length} chars (~${tokenCount} tokens)` +
      ` | files=${filesModified.size} | facts=${keyFacts.length}`
    );

    return {
      summary,
      keyFacts,
      filesModified: Array.from(filesModified),
      tokenCount
    };
  };
}
