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
 * - Only recent snapshots are kept (old ones pruned)
 * - Snapshots can be generated via LLM or simple extraction
 */

import { v4 as uuidv4 } from 'uuid';
import { Database } from './SqlJsWrapper';
import { EventStore } from './EventStore';
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
 */
export type SummarizerFn = (events: ConversationEvent[]) => Promise<SnapshotContent>;

export class SnapshotManager {
  private db: Database;
  private eventStore: EventStore;
  private summarizer: SummarizerFn;

  // Configuration
  private readonly SNAPSHOT_INTERVAL: number;
  private readonly MAX_SNAPSHOTS_PER_SESSION: number;

  // Prepared statements
  private stmtInsertSnapshot!: Statement;
  private stmtGetLatestSnapshot!: Statement;
  private stmtGetSnapshotById!: Statement;
  private stmtGetAllSnapshots!: Statement;
  private stmtDeleteOldSnapshots!: Statement;
  private stmtDeleteSessionSnapshots!: Statement;

  constructor(
    db: Database,
    eventStore: EventStore,
    summarizer: SummarizerFn,
    options?: {
      snapshotInterval?: number;
      maxSnapshotsPerSession?: number;
    }
  ) {
    this.db = db;
    this.eventStore = eventStore;
    this.summarizer = summarizer;

    // Default: create snapshot every 20 events, keep max 5 per session
    this.SNAPSHOT_INTERVAL = options?.snapshotInterval ?? 20;
    this.MAX_SNAPSHOTS_PER_SESSION = options?.maxSnapshotsPerSession ?? 5;

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

    this.stmtDeleteOldSnapshots = this.db.prepare(`
      DELETE FROM snapshots
      WHERE session_id = ?
      AND id NOT IN (
        SELECT id FROM snapshots
        WHERE session_id = ?
        ORDER BY up_to_sequence DESC
        LIMIT ?
      )
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

    // Generate summary
    const content = await this.summarizer(events);

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

    // Prune old snapshots
    this.pruneSnapshots(sessionId);

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
   * Get all snapshots for a specific session.
   *
   * @param sessionId - Session to get snapshots for
   * @returns Array of snapshots in reverse chronological order
   */
  getSessionSnapshots(sessionId: string): Snapshot[] {
    const stmt = this.db.prepare(`
      SELECT * FROM snapshots
      WHERE session_id = ?
      ORDER BY up_to_sequence DESC
    `);

    const rows = stmt.all(sessionId) as any[];
    return rows.map(row => this.rowToSnapshot(row));
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
   * Keep only the most recent snapshots per session.
   *
   * @param sessionId - Session to prune
   */
  private pruneSnapshots(sessionId: string): void {
    this.stmtDeleteOldSnapshots.run(
      sessionId,
      sessionId,
      this.MAX_SNAPSHOTS_PER_SESSION
    );
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
// Default Summarizer (Simple Extraction)
// ============================================================================

/**
 * Simple extractive summarizer that doesn't require LLM.
 * Extracts key information from events without generating new text.
 */
export function createExtractSummarizer(): SummarizerFn {
  return async (events: ConversationEvent[]): Promise<SnapshotContent> => {
    // Collect user messages
    const userMessages = events.filter(isUserMessageEvent);

    // Collect files modified
    const filesModified = new Set<string>();
    events.forEach(event => {
      if (event.type === 'diff_accepted' || event.type === 'file_write') {
        const filePath = (event as any).filePath;
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

    return {
      summary,
      keyFacts,
      filesModified: Array.from(filesModified),
      tokenCount
    };
  };
}
