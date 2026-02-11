/**
 * Unit tests for SnapshotManager
 *
 * Tests snapshot creation, retrieval, and pruning.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../../src/events/SqlJsWrapper';
import { EventStore } from '../../../src/events/EventStore';
import { SnapshotManager, createExtractSummarizer } from '../../../src/events/SnapshotManager';

describe('SnapshotManager', () => {
  let db: Database;
  let eventStore: EventStore;
  let snapshotManager: SnapshotManager;

  beforeEach(() => {
    db = new Database(':memory:');

    // Create sessions table (normally created by ConversationManager)
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        event_count INTEGER DEFAULT 0,
        last_snapshot_sequence INTEGER DEFAULT 0,
        tags TEXT DEFAULT '[]',
        first_user_message TEXT,
        last_activity_preview TEXT
      );
    `);

    eventStore = new EventStore(db);
    snapshotManager = new SnapshotManager(
      db,
      eventStore,
      createExtractSummarizer(),
      {
        snapshotInterval: 5, // Create snapshot every 5 events for testing
        maxSnapshotsPerSession: 3
      }
    );
  });

  afterEach(() => {
    db.close();
  });

  describe('maybeCreateSnapshot', () => {
    it('should not create snapshot when below interval', async () => {
      // Add 3 events (below threshold of 5)
      for (let i = 0; i < 3; i++) {
        eventStore.append({
          sessionId: 'session-1',
          timestamp: Date.now(),
          type: 'user_message',
          content: `Message ${i}`
        });
      }

      const snapshot = await snapshotManager.maybeCreateSnapshot('session-1');

      expect(snapshot).toBeNull();
    });

    it('should create snapshot when at interval', async () => {
      // Add 5 events (at threshold)
      for (let i = 0; i < 5; i++) {
        eventStore.append({
          sessionId: 'session-1',
          timestamp: Date.now(),
          type: 'user_message',
          content: `Message ${i}`
        });
      }

      const snapshot = await snapshotManager.maybeCreateSnapshot('session-1');

      expect(snapshot).not.toBeNull();
      expect(snapshot!.sessionId).toBe('session-1');
      expect(snapshot!.upToSequence).toBe(5);
    });

    it('should track snapshot sequence correctly', async () => {
      // Add 5 events, create snapshot
      for (let i = 0; i < 5; i++) {
        eventStore.append({
          sessionId: 'session-1',
          timestamp: Date.now(),
          type: 'user_message',
          content: `Message ${i}`
        });
      }
      await snapshotManager.maybeCreateSnapshot('session-1');

      // Add 3 more events (below threshold since last snapshot)
      for (let i = 0; i < 3; i++) {
        eventStore.append({
          sessionId: 'session-1',
          timestamp: Date.now(),
          type: 'user_message',
          content: `More ${i}`
        });
      }

      const snapshot = await snapshotManager.maybeCreateSnapshot('session-1');
      expect(snapshot).toBeNull(); // Only 3 events since last snapshot

      // Add 2 more to reach threshold
      for (let i = 0; i < 2; i++) {
        eventStore.append({
          sessionId: 'session-1',
          timestamp: Date.now(),
          type: 'user_message',
          content: `Even more ${i}`
        });
      }

      const newSnapshot = await snapshotManager.maybeCreateSnapshot('session-1');
      expect(newSnapshot).not.toBeNull();
      expect(newSnapshot!.upToSequence).toBe(10);
    });
  });

  describe('createSnapshot', () => {
    it('should create snapshot with summary', async () => {
      eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'user_message',
        content: 'Help me fix the login bug'
      });
      eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'assistant_message',
        content: 'I can help with that',
        model: 'deepseek-chat',
        finishReason: 'stop'
      });

      const snapshot = await snapshotManager.createSnapshot('session-1');

      expect(snapshot.id).toBeDefined();
      expect(snapshot.sessionId).toBe('session-1');
      expect(snapshot.summary).toContain('Help me fix the login bug');
      expect(snapshot.upToSequence).toBe(2);
    });

    it('should extract files modified', async () => {
      eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'diff_created',
        diffId: 'diff-1',
        filePath: 'src/auth.ts',
        originalContent: 'old',
        newContent: 'new'
      });
      eventStore.append({
        sessionId: 'session-1',
        timestamp: Date.now(),
        type: 'diff_accepted',
        diffId: 'diff-1'
      });

      const snapshot = await snapshotManager.createSnapshot('session-1');

      expect(snapshot.filesModified).toContain('src/auth.ts');
    });
  });

  describe('getLatestSnapshot', () => {
    it('should return null when no snapshots', () => {
      const snapshot = snapshotManager.getLatestSnapshot('session-1');

      expect(snapshot).toBeNull();
    });

    it('should return most recent snapshot', async () => {
      // Create first snapshot
      for (let i = 0; i < 5; i++) {
        eventStore.append({
          sessionId: 'session-1',
          timestamp: Date.now(),
          type: 'user_message',
          content: `First batch ${i}`
        });
      }
      await snapshotManager.createSnapshot('session-1');

      // Create second snapshot
      for (let i = 0; i < 5; i++) {
        eventStore.append({
          sessionId: 'session-1',
          timestamp: Date.now(),
          type: 'user_message',
          content: `Second batch ${i}`
        });
      }
      await snapshotManager.createSnapshot('session-1');

      const latest = snapshotManager.getLatestSnapshot('session-1');

      expect(latest).not.toBeNull();
      expect(latest!.upToSequence).toBe(10);
    });
  });

  describe('getSnapshotById', () => {
    it('should return snapshot by id', async () => {
      for (let i = 0; i < 5; i++) {
        eventStore.append({
          sessionId: 'session-1',
          timestamp: Date.now(),
          type: 'user_message',
          content: `Message ${i}`
        });
      }
      const created = await snapshotManager.createSnapshot('session-1');

      const found = snapshotManager.getSnapshotById(created.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
    });

    it('should return null for non-existent id', () => {
      const found = snapshotManager.getSnapshotById('non-existent');

      expect(found).toBeNull();
    });
  });

  describe('pruning', () => {
    it('should keep only max snapshots per session', async () => {
      // Create 5 snapshots (max is 3)
      for (let batch = 0; batch < 5; batch++) {
        for (let i = 0; i < 5; i++) {
          eventStore.append({
            sessionId: 'session-1',
            timestamp: Date.now(),
            type: 'user_message',
            content: `Batch ${batch} Message ${i}`
          });
        }
        await snapshotManager.createSnapshot('session-1');
      }

      // Verify pruning by querying DB directly
      const stmt = db.prepare('SELECT up_to_sequence FROM snapshots WHERE session_id = ? ORDER BY up_to_sequence DESC');
      const rows = stmt.all('session-1') as any[];

      expect(rows).toHaveLength(3);
      // Should keep the most recent ones (sequences 15, 20, 25)
      expect(rows[0].up_to_sequence).toBe(25);
      expect(rows[1].up_to_sequence).toBe(20);
      expect(rows[2].up_to_sequence).toBe(15);
    });
  });

  describe('deleteSessionSnapshots', () => {
    it('should delete all snapshots for session', async () => {
      for (let i = 0; i < 5; i++) {
        eventStore.append({
          sessionId: 'session-1',
          timestamp: Date.now(),
          type: 'user_message',
          content: `Message ${i}`
        });
      }
      await snapshotManager.createSnapshot('session-1');

      snapshotManager.deleteSessionSnapshots('session-1');

      expect(snapshotManager.getLatestSnapshot('session-1')).toBeNull();
    });
  });
});

describe('createExtractSummarizer', () => {
  it('should extract summary from user messages', async () => {
    const summarizer = createExtractSummarizer();

    const events = [
      {
        id: '1',
        sessionId: 'session-1',
        sequence: 1,
        timestamp: Date.now(),
        type: 'user_message' as const,
        content: 'Help me implement authentication'
      },
      {
        id: '2',
        sessionId: 'session-1',
        sequence: 2,
        timestamp: Date.now(),
        type: 'assistant_message' as const,
        content: 'Sure, I can help with that',
        model: 'deepseek-chat',
        finishReason: 'stop' as const
      }
    ];

    const result = await summarizer(events);

    expect(result.summary).toContain('Help me implement authentication');
    expect(result.keyFacts.length).toBeGreaterThan(0);
    expect(result.tokenCount).toBeGreaterThan(0);
  });

  it('should extract files modified', async () => {
    const summarizer = createExtractSummarizer();

    const events = [
      {
        id: '1',
        sessionId: 'session-1',
        sequence: 1,
        timestamp: Date.now(),
        type: 'diff_created' as const,
        diffId: 'diff-1',
        filePath: 'src/auth.ts',
        originalContent: 'old',
        newContent: 'new'
      },
      {
        id: '2',
        sessionId: 'session-1',
        sequence: 2,
        timestamp: Date.now(),
        type: 'diff_accepted' as const,
        diffId: 'diff-1'
      }
    ];

    const result = await summarizer(events);

    expect(result.filesModified).toContain('src/auth.ts');
  });
});
