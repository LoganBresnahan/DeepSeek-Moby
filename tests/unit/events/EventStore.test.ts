/**
 * Unit tests for EventStore
 *
 * Tests the append-only event storage with SQLite.
 * Uses in-memory database for fast, isolated tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../../src/events/SqlJsWrapper';
import { EventStore } from '../../../src/events/EventStore';

describe('EventStore', () => {
  let db: Database;
  let eventStore: EventStore;

  beforeEach(() => {
    // Use in-memory database for each test
    db = new Database(':memory:');
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
  });

  describe('getEvents', () => {
    it('should return all events for a session', () => {
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
      expect(events[1].sequence).toBe(2);
    });

    it('should return events starting from a sequence', () => {
      eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'user_message',
        content: 'First'
      });
      eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'user_message',
        content: 'Second'
      });
      eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'user_message',
        content: 'Third'
      });

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
      eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'user_message',
        content: 'User'
      });
      eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'assistant_message',
        content: 'Assistant',
        model: 'deepseek-chat',
        finishReason: 'stop' as const
      });
      eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'tool_call',
        toolCallId: 'tc-1',
        toolName: 'read_file',
        arguments: {}
      });

      const userMessages = eventStore.getEventsByType('session-1', ['user_message']);

      expect(userMessages).toHaveLength(1);
      expect(userMessages[0].type).toBe('user_message');
    });

    it('should filter by multiple types', () => {
      eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'user_message',
        content: 'User'
      });
      eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'assistant_message',
        content: 'Assistant',
        model: 'deepseek-chat',
        finishReason: 'stop' as const
      });
      eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'tool_call',
        toolCallId: 'tc-1',
        toolName: 'read_file',
        arguments: {}
      });

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
      eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'user_message',
        content: 'First'
      });
      eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'user_message',
        content: 'Second'
      });

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
      eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'user_message',
        content: 'First'
      });
      eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'user_message',
        content: 'Second'
      });

      const count = eventStore.getEventCount('session-1');

      expect(count).toBe(2);
    });
  });

  describe('deleteSessionEvents', () => {
    it('should delete all events for a session', () => {
      eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'user_message',
        content: 'To delete'
      });

      eventStore.deleteSessionEvents('session-1');

      const events = eventStore.getEvents('session-1');
      expect(events).toHaveLength(0);
    });

    it('should not affect other sessions', () => {
      eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'user_message',
        content: 'Session 1'
      });
      eventStore.append({
        sessionId: 'session-2',
        timestamp: Date.now(),
        type: 'user_message',
        content: 'Session 2'
      });

      eventStore.deleteSessionEvents('session-1');

      const events1 = eventStore.getEvents('session-1');
      const events2 = eventStore.getEvents('session-2');

      expect(events1).toHaveLength(0);
      expect(events2).toHaveLength(1);
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
  });

});
