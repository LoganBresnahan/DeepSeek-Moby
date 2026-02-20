/**
 * Unit tests for EventStore
 *
 * Tests the append-only event storage with M:N join table.
 * Uses in-memory database for fast, isolated tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../../src/events/SqlJsWrapper';
import { runMigrations } from '../../../src/events/migrations';
import { EventStore } from '../../../src/events/EventStore';

describe('EventStore', () => {
  let db: Database;
  let eventStore: EventStore;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    // FK constraints require parent sessions to exist before inserting events
    db.prepare('INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('session-1', 'Test', 'test', 1000, 1000);
    db.prepare('INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('session-2', 'Test 2', 'test', 1000, 1000);
    eventStore = new EventStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('append', () => {
    it('should append an event with auto-generated id and sequence', () => {
      const event = eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'user_message',
        content: 'Hello world'
      });

      expect(event.id).toBeDefined();
      expect(event.id.length).toBe(36); // UUID length
      expect(event.sequence).toBe(1);
      expect(event.sessionId).toBe('session-1');
      expect(event.type).toBe('user_message');
      expect((event as any).content).toBe('Hello world');
    });

    it('should auto-increment sequence for same session', () => {
      const event1 = eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'user_message',
        content: 'First'
      });

      const event2 = eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'user_message',
        content: 'Second'
      });

      expect(event1.sequence).toBe(1);
      expect(event2.sequence).toBe(2);
    });

    it('should have independent sequences per session', () => {
      const event1 = eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'user_message',
        content: 'Session 1'
      });

      const event2 = eventStore.append({
        sessionId: 'session-2',
        timestamp: Date.now(),
        type: 'user_message',
        content: 'Session 2'
      });

      expect(event1.sequence).toBe(1);
      expect(event2.sequence).toBe(1);
    });

    it('should store event data WITHOUT sessionId/sequence in the JSON blob', () => {
      const event = eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'user_message',
        content: 'Hello'
      });

      // Read raw blob from events table
      const row = db.prepare('SELECT data FROM events WHERE id = ?').get(event.id) as any;
      const blob = JSON.parse(row.data);

      expect(blob.sessionId).toBeUndefined();
      expect(blob.sequence).toBeUndefined();
      expect(blob.id).toBe(event.id);
      expect(blob.type).toBe('user_message');
      expect(blob.content).toBe('Hello');
    });

    it('should create entries in both events and event_sessions tables', () => {
      const event = eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'user_message',
        content: 'Hello'
      });

      // events table has the raw event
      const eventRow = db.prepare('SELECT * FROM events WHERE id = ?').get(event.id);
      expect(eventRow).toBeDefined();

      // event_sessions has the link
      const linkRow = db.prepare(
        'SELECT * FROM event_sessions WHERE event_id = ? AND session_id = ?'
      ).get(event.id, 'session-1') as any;
      expect(linkRow).toBeDefined();
      expect(linkRow.sequence).toBe(1);
    });
  });

  describe('getEvents', () => {
    it('should return all events for a session (hydrated with sessionId/sequence)', () => {
      eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'user_message',
        content: 'First'
      });
      eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'assistant_message',
        content: 'Second',
        model: 'deepseek-chat',
        finishReason: 'stop' as const
      });

      const events = eventStore.getEvents('session-1');

      expect(events).toHaveLength(2);
      expect(events[0].sequence).toBe(1);
      expect(events[0].sessionId).toBe('session-1');
      expect(events[1].sequence).toBe(2);
      expect(events[1].sessionId).toBe('session-1');
    });

    it('should return events starting from a sequence', () => {
      eventStore.append({ sessionId: 'session-1', timestamp: Date.now(), type: 'user_message', content: 'First' });
      eventStore.append({ sessionId: 'session-1', timestamp: Date.now(), type: 'user_message', content: 'Second' });
      eventStore.append({ sessionId: 'session-1', timestamp: Date.now(), type: 'user_message', content: 'Third' });

      const events = eventStore.getEvents('session-1', 1); // After sequence 1

      expect(events).toHaveLength(2);
      expect(events[0].sequence).toBe(2);
      expect(events[1].sequence).toBe(3);
    });

    it('should return empty array for non-existent session', () => {
      const events = eventStore.getEvents('non-existent');
      expect(events).toHaveLength(0);
    });
  });

  describe('getEventsByType', () => {
    it('should filter events by type', () => {
      eventStore.append({ sessionId: 'session-1', timestamp: Date.now(), type: 'user_message', content: 'User' });
      eventStore.append({ sessionId: 'session-1', timestamp: Date.now(), type: 'assistant_message', content: 'Assistant', model: 'deepseek-chat', finishReason: 'stop' as const });
      eventStore.append({ sessionId: 'session-1', timestamp: Date.now(), type: 'tool_call', toolCallId: 'tc-1', toolName: 'read_file', arguments: {} });

      const userMessages = eventStore.getEventsByType('session-1', ['user_message']);

      expect(userMessages).toHaveLength(1);
      expect(userMessages[0].type).toBe('user_message');
      expect(userMessages[0].sessionId).toBe('session-1');
    });

    it('should filter by multiple types', () => {
      eventStore.append({ sessionId: 'session-1', timestamp: Date.now(), type: 'user_message', content: 'User' });
      eventStore.append({ sessionId: 'session-1', timestamp: Date.now(), type: 'assistant_message', content: 'Assistant', model: 'deepseek-chat', finishReason: 'stop' as const });
      eventStore.append({ sessionId: 'session-1', timestamp: Date.now(), type: 'tool_call', toolCallId: 'tc-1', toolName: 'read_file', arguments: {} });

      const messages = eventStore.getEventsByType('session-1', ['user_message', 'assistant_message']);

      expect(messages).toHaveLength(2);
    });
  });

  describe('getEventById', () => {
    it('should return event by id', () => {
      const created = eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'user_message',
        content: 'Test'
      });

      const found = eventStore.getEventById(created.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.type).toBe('user_message');
    });

    it('should return null for non-existent id', () => {
      const found = eventStore.getEventById('non-existent');
      expect(found).toBeNull();
    });
  });

  describe('getLatestSequence', () => {
    it('should return 0 for empty session', () => {
      const seq = eventStore.getLatestSequence('empty-session');
      expect(seq).toBe(0);
    });

    it('should return latest sequence number', () => {
      eventStore.append({ sessionId: 'session-1', timestamp: Date.now(), type: 'user_message', content: 'First' });
      eventStore.append({ sessionId: 'session-1', timestamp: Date.now(), type: 'user_message', content: 'Second' });

      const seq = eventStore.getLatestSequence('session-1');
      expect(seq).toBe(2);
    });
  });

  describe('getEventCount', () => {
    it('should return 0 for empty session', () => {
      const count = eventStore.getEventCount('empty-session');
      expect(count).toBe(0);
    });

    it('should return correct event count', () => {
      eventStore.append({ sessionId: 'session-1', timestamp: Date.now(), type: 'user_message', content: 'First' });
      eventStore.append({ sessionId: 'session-1', timestamp: Date.now(), type: 'user_message', content: 'Second' });

      const count = eventStore.getEventCount('session-1');
      expect(count).toBe(2);
    });
  });

  describe('deleteSessionEvents', () => {
    it('should delete all event links for a session and clean up orphans', () => {
      eventStore.append({ sessionId: 'session-1', timestamp: Date.now(), type: 'user_message', content: 'To delete' });

      eventStore.deleteSessionEvents('session-1');

      const events = eventStore.getEvents('session-1');
      expect(events).toHaveLength(0);

      // Orphaned events should be cleaned up too
      const allEvents = db.prepare('SELECT * FROM events').all();
      expect(allEvents).toHaveLength(0);
    });

    it('should not affect other sessions', () => {
      eventStore.append({ sessionId: 'session-1', timestamp: Date.now(), type: 'user_message', content: 'Session 1' });
      eventStore.append({ sessionId: 'session-2', timestamp: Date.now(), type: 'user_message', content: 'Session 2' });

      eventStore.deleteSessionEvents('session-1');

      const events1 = eventStore.getEvents('session-1');
      const events2 = eventStore.getEvents('session-2');

      expect(events1).toHaveLength(0);
      expect(events2).toHaveLength(1);
    });

    it('should NOT delete shared events still referenced by other sessions', () => {
      // Create an event in session-1
      const event = eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'user_message',
        content: 'Shared event'
      });

      // Manually link the same event to session-2 (simulating a fork)
      db.prepare(
        'INSERT INTO event_sessions (event_id, session_id, sequence) VALUES (?, ?, ?)'
      ).run(event.id, 'session-2', 1);

      // Delete session-1's events
      eventStore.deleteSessionEvents('session-1');

      // Event still exists (referenced by session-2)
      const allEvents = db.prepare('SELECT * FROM events').all();
      expect(allEvents).toHaveLength(1);

      // Session-2 still has the event
      const events2 = eventStore.getEvents('session-2');
      expect(events2).toHaveLength(1);
    });
  });

  describe('linkEventsToSession', () => {
    it('should link events from one session to another (zero-copy fork)', () => {
      eventStore.append({ sessionId: 'session-1', timestamp: 1000, type: 'user_message', content: 'Hello' });
      eventStore.append({ sessionId: 'session-1', timestamp: 2000, type: 'assistant_message', content: 'Hi', model: 'deepseek-chat', finishReason: 'stop' as const });
      eventStore.append({ sessionId: 'session-1', timestamp: 3000, type: 'user_message', content: 'Follow up' });

      // Fork at sequence 2 (after assistant response)
      const linked = eventStore.linkEventsToSession('session-1', 'session-2', 2);

      expect(linked).toBe(2);

      // Session-2 has the first 2 events
      const events2 = eventStore.getEvents('session-2');
      expect(events2).toHaveLength(2);
      expect(events2[0].sessionId).toBe('session-2');
      expect(events2[0].sequence).toBe(1);
      expect((events2[0] as any).content).toBe('Hello');
      expect(events2[1].sequence).toBe(2);

      // Session-1 still has all 3
      const events1 = eventStore.getEvents('session-1');
      expect(events1).toHaveLength(3);

      // No event data was duplicated — same event IDs
      expect(events2[0].id).toBe(events1[0].id);
      expect(events2[1].id).toBe(events1[1].id);
    });

    it('should allow independent sequences to diverge after fork', () => {
      eventStore.append({ sessionId: 'session-1', timestamp: 1000, type: 'user_message', content: 'Hello' });
      eventStore.append({ sessionId: 'session-1', timestamp: 2000, type: 'assistant_message', content: 'Hi', model: 'deepseek-chat', finishReason: 'stop' as const });

      // Fork all events to session-2
      eventStore.linkEventsToSession('session-1', 'session-2', 2);

      // Add new events to session-2 (diverging)
      const newEvent = eventStore.append({
        sessionId: 'session-2',
        timestamp: 3000,
        type: 'user_message',
        content: 'Different follow up'
      });

      expect(newEvent.sequence).toBe(3); // Continues from linked events

      const events2 = eventStore.getEvents('session-2');
      expect(events2).toHaveLength(3);
      expect((events2[2] as any).content).toBe('Different follow up');
    });
  });

  describe('getActivityPreview', () => {
    it('should return preview for user message', () => {
      const event = eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'user_message',
        content: 'Hello world'
      });

      const preview = eventStore.getActivityPreview(event);
      expect(preview).toBe('Hello world');
    });

    it('should truncate long messages', () => {
      const longContent = 'x'.repeat(200);
      const event = eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'user_message',
        content: longContent
      });

      const preview = eventStore.getActivityPreview(event);
      expect(preview.length).toBe(100);
    });

    it('should return preview for fork_created event', () => {
      const event = eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'fork_created',
        parentSessionId: 'parent-1',
        forkPointSequence: 5
      });

      const preview = eventStore.getActivityPreview(event);
      expect(preview).toBe('Forked from session');
    });
  });
});
