/**
 * EventStore - Append-only event storage using SQLite with M:N join table
 *
 * Events are session-agnostic: they store immutable facts without session_id
 * or sequence. The event_sessions join table maps events to sessions with
 * per-session sequence numbering.
 *
 * This enables zero-copy forking: linking existing events to a new session
 * via INSERT...SELECT on the join table, without duplicating event data.
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
  private stmtInsertEventSession!: Statement;
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
    // Insert into events table (session-agnostic)
    this.stmtInsertEvent = this.db.prepare(`
      INSERT INTO events (id, timestamp, type, data)
      VALUES (?, ?, ?, ?)
    `);

    // Insert into join table (links event to session with sequence)
    this.stmtInsertEventSession = this.db.prepare(`
      INSERT INTO event_sessions (event_id, session_id, sequence)
      VALUES (?, ?, ?)
    `);

    // Next sequence for a session (from join table)
    this.stmtGetNextSequence = this.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 as next_seq
      FROM event_sessions WHERE session_id = ?
    `);

    // Get events for a session via JOIN
    this.stmtGetEvents = this.db.prepare(`
      SELECT e.data, es.sequence, es.session_id
      FROM events e
      JOIN event_sessions es ON e.id = es.event_id
      WHERE es.session_id = ? AND es.sequence > ?
      ORDER BY es.sequence ASC
    `);

    // Get event by ID (no session context — returns raw event data)
    this.stmtGetEventById = this.db.prepare(`
      SELECT data FROM events WHERE id = ?
    `);

    // Latest sequence for a session (from join table)
    this.stmtGetLatestSequence = this.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) as seq
      FROM event_sessions WHERE session_id = ?
    `);

    // Event count for a session (from join table)
    this.stmtGetEventCount = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM event_sessions WHERE session_id = ?
    `);
  }

  /**
   * Append a new event to the store and link it to a session.
   * Automatically assigns id and sequence number.
   *
   * The JSON blob stored in the events table does NOT contain sessionId
   * or sequence — those are hydrated from the join table during reads.
   *
   * @param event - Event data without id and sequence
   * @returns The complete event with id, sessionId, and sequence
   */
  append<T extends ConversationEvent>(event: NewEvent<T>): T {
    const id = uuidv4();

    // Get next sequence number for this session (from join table)
    const { next_seq } = this.stmtGetNextSequence.get(event.sessionId) as { next_seq: number };

    // Build the full event object (returned to caller)
    const fullEvent = {
      ...event,
      id,
      sequence: next_seq
    } as unknown as T;

    // Build the storage blob WITHOUT sessionId and sequence
    const blobData = { ...fullEvent };
    delete (blobData as any).sessionId;
    delete (blobData as any).sequence;

    // Insert event into events table
    this.stmtInsertEvent.run(
      id,
      event.timestamp,
      event.type,
      JSON.stringify(blobData)
    );

    // Link event to session via join table
    this.stmtInsertEventSession.run(id, event.sessionId, next_seq);

    return fullEvent;
  }

  /**
   * Get all events for a session, optionally starting from a sequence number.
   * Hydrates sessionId and sequence from the join table.
   *
   * @param sessionId - Session to get events for
   * @param fromSequence - Start from this sequence (exclusive, default 0 = all)
   * @returns Array of events in sequence order
   */
  getEvents(sessionId: string, fromSequence: number = 0): ConversationEvent[] {
    const rows = this.stmtGetEvents.all(sessionId, fromSequence) as { data: string; sequence: number; session_id: string }[];
    return rows.map(row => {
      const event = JSON.parse(row.data);
      event.sessionId = sessionId;
      event.sequence = row.sequence;
      return event;
    });
  }

  /**
   * Get events of specific types for a session.
   * Hydrates sessionId and sequence from the join table.
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
      SELECT e.data, es.sequence
      FROM events e
      JOIN event_sessions es ON e.id = es.event_id
      WHERE es.session_id = ? AND es.sequence > ? AND e.type IN (${placeholders})
      ORDER BY es.sequence ASC
    `);

    const rows = stmt.all(sessionId, fromSequence, ...types) as { data: string; sequence: number }[];
    return rows.map(row => {
      const event = JSON.parse(row.data);
      event.sessionId = sessionId;
      event.sequence = row.sequence;
      return event;
    });
  }

  /**
   * Get a specific event by its ID.
   * Returns the event without session context (sessionId/sequence will be
   * from the stored blob, which may be absent for join-table events).
   *
   * @param eventId - Event ID to look up
   * @returns The event or null if not found
   */
  getEventById(eventId: string): ConversationEvent | null {
    const row = this.stmtGetEventById.get(eventId) as { data: string } | undefined;
    if (!row) return null;
    const event = JSON.parse(row.data);
    event.id = eventId;
    return event;
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
   * Delete all event links for a session and clean up orphaned events.
   * Used when deleting a conversation.
   *
   * Steps:
   * 1. Delete join table rows for this session (via CASCADE from session delete,
   *    or explicitly here)
   * 2. Delete orphaned events (events no longer referenced by any session)
   *
   * @param sessionId - Session to delete events for
   */
  deleteSessionEvents(sessionId: string): void {
    // Remove join table links for this session
    this.db.prepare('DELETE FROM event_sessions WHERE session_id = ?').run(sessionId);
    // Clean up orphaned events (no remaining session references)
    this.db.prepare(
      'DELETE FROM events WHERE id NOT IN (SELECT event_id FROM event_sessions)'
    ).run();
  }

  /**
   * Link existing events from one session to another (for forking).
   * Copies join table rows up to a given sequence — zero-copy, no event
   * data duplication.
   *
   * @param sourceSessionId - Session to copy event links from
   * @param targetSessionId - Session to link events to
   * @param upToSequence - Copy events with sequence <= this value
   * @returns Number of events linked
   */
  linkEventsToSession(
    sourceSessionId: string,
    targetSessionId: string,
    upToSequence: number
  ): number {
    const stmt = this.db.prepare(`
      INSERT INTO event_sessions (event_id, session_id, sequence)
      SELECT event_id, ?, sequence
      FROM event_sessions
      WHERE session_id = ? AND sequence <= ?
    `);
    stmt.run(targetSessionId, sourceSessionId, upToSequence);

    // Return the count of linked events
    const { count } = this.db.prepare(
      'SELECT COUNT(*) as count FROM event_sessions WHERE session_id = ?'
    ).get(targetSessionId) as { count: number };
    return count;
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
      case 'fork_created':
        return `Forked from session`;
      default:
        return event.type;
    }
  }

}
