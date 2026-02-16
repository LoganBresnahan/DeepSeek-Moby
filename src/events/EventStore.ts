/**
 * EventStore - Append-only event storage using SQLite
 *
 * The EventStore is the foundation of the Event Sourcing architecture.
 * It provides:
 * - Append-only event storage (immutable history)
 * - Efficient querying by session, sequence, and type
 * - Automatic sequence number assignment
 */

import { v4 as uuidv4 } from 'uuid';
import { Database } from './SqlJsWrapper';
import {
  ConversationEvent,
  EventType,
  NewEvent
} from './EventTypes';

// Statement interface for our wrapper
interface Statement {
  run(...params: unknown[]): void;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

export class EventStore {
  private db: Database;

  // Prepared statements for performance
  private stmtInsertEvent!: Statement;
  private stmtGetNextSequence!: Statement;
  private stmtGetEvents!: Statement;
  private stmtGetEventById!: Statement;
  private stmtGetLatestSequence!: Statement;
  private stmtGetEventCount!: Statement;

  constructor(db: Database) {
    this.db = db;
    this.prepareStatements();
  }

  /**
   * Prepare SQL statements for reuse.
   */
  private prepareStatements(): void {
    this.stmtInsertEvent = this.db.prepare(`
      INSERT INTO events (id, session_id, sequence, timestamp, type, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetNextSequence = this.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 as next_seq
      FROM events WHERE session_id = ?
    `);

    this.stmtGetEvents = this.db.prepare(`
      SELECT data FROM events
      WHERE session_id = ? AND sequence > ?
      ORDER BY sequence ASC
    `);

    this.stmtGetEventById = this.db.prepare(`
      SELECT data FROM events WHERE id = ?
    `);

    this.stmtGetLatestSequence = this.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) as seq
      FROM events WHERE session_id = ?
    `);

    this.stmtGetEventCount = this.db.prepare(`
      SELECT COUNT(*) as count FROM events WHERE session_id = ?
    `);
  }

  /**
   * Append a new event to the store.
   * Automatically assigns id and sequence number.
   *
   * @param event - Event data without id and sequence
   * @returns The complete event with id and sequence assigned
   */
  append<T extends ConversationEvent>(event: NewEvent<T>): T {
    const id = uuidv4();

    // Get next sequence number for this session
    const { next_seq } = this.stmtGetNextSequence.get(event.sessionId) as { next_seq: number };

    const fullEvent = {
      ...event,
      id,
      sequence: next_seq
    } as unknown as T;

    // Store the event
    this.stmtInsertEvent.run(
      id,
      event.sessionId,
      next_seq,
      event.timestamp,
      event.type,
      JSON.stringify(fullEvent)
    );

    return fullEvent;
  }

  /**
   * Get all events for a session, optionally starting from a sequence number.
   *
   * @param sessionId - Session to get events for
   * @param fromSequence - Start from this sequence (exclusive, default 0 = all)
   * @returns Array of events in sequence order
   */
  getEvents(sessionId: string, fromSequence: number = 0): ConversationEvent[] {
    const rows = this.stmtGetEvents.all(sessionId, fromSequence) as { data: string }[];
    return rows.map(row => JSON.parse(row.data));
  }

  /**
   * Get events of specific types.
   * Useful for targeted queries like "all user messages".
   *
   * @param sessionId - Session to get events for
   * @param types - Event types to include
   * @param fromSequence - Start from this sequence (exclusive)
   * @returns Array of matching events in sequence order
   */
  getEventsByType(
    sessionId: string,
    types: EventType[],
    fromSequence: number = 0
  ): ConversationEvent[] {
    const placeholders = types.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT data FROM events
      WHERE session_id = ? AND sequence > ? AND type IN (${placeholders})
      ORDER BY sequence ASC
    `);

    const rows = stmt.all(sessionId, fromSequence, ...types) as { data: string }[];
    return rows.map(row => JSON.parse(row.data));
  }

  /**
   * Get a specific event by its ID.
   *
   * @param eventId - Event ID to look up
   * @returns The event or null if not found
   */
  getEventById(eventId: string): ConversationEvent | null {
    const row = this.stmtGetEventById.get(eventId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }

  /**
   * Get the latest sequence number for a session.
   *
   * @param sessionId - Session to check
   * @returns Latest sequence number (0 if no events)
   */
  getLatestSequence(sessionId: string): number {
    const { seq } = this.stmtGetLatestSequence.get(sessionId) as { seq: number };
    return seq;
  }

  /**
   * Get the total number of events in a session.
   *
   * @param sessionId - Session to count
   * @returns Number of events
   */
  getEventCount(sessionId: string): number {
    const { count } = this.stmtGetEventCount.get(sessionId) as { count: number };
    return count;
  }

  /**
   * Delete all events for a session.
   * Used when deleting a conversation.
   *
   * @param sessionId - Session to delete events for
   */
  deleteSessionEvents(sessionId: string): void {
    this.db.prepare('DELETE FROM events WHERE session_id = ?').run(sessionId);
  }

  /**
   * Get activity preview text for an event.
   * Used for session list display.
   *
   * @param event - Event to get preview for
   * @returns Short preview string
   */
  getActivityPreview(event: ConversationEvent): string {
    switch (event.type) {
      case 'user_message':
        return event.content.substring(0, 100);
      case 'assistant_message':
        return event.content.substring(0, 100);
      case 'tool_call':
        return `Tool: ${event.toolName}`;
      case 'tool_result':
        return `Tool result: ${event.success ? 'success' : 'failed'}`;
      case 'diff_created':
        return `Edit: ${event.filePath}`;
      case 'diff_accepted':
        return 'Change accepted';
      case 'diff_rejected':
        return 'Change rejected';
      case 'file_read':
        return `Read: ${event.filePath}`;
      case 'file_write':
        return `Write: ${event.filePath}`;
      case 'web_search':
        return `Search: ${event.query.substring(0, 50)}`;
      case 'error':
        return `Error: ${event.message.substring(0, 50)}`;
      case 'context_imported':
        return 'Context imported from previous session';
      default:
        return event.type;
    }
  }

}
