/**
 * Unit tests for SnapshotManager
 *
 * Tests snapshot creation, retrieval, and pruning.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../../src/events/SqlJsWrapper';
import { runMigrations } from '../../../src/events/migrations';
import { EventStore } from '../../../src/events/EventStore';
import { SnapshotManager, createExtractSummarizer, createLLMSummarizer } from '../../../src/events/SnapshotManager';
import type { SummarizerChatFn } from '../../../src/events/SnapshotManager';

describe('SnapshotManager', () => {
  let db: Database;
  let eventStore: EventStore;
  let snapshotManager: SnapshotManager;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    // FK constraints require parent session to exist
    db.prepare('INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('session-1', 'Test', 'test', 1000, 1000);

    eventStore = new EventStore(db);
    snapshotManager = new SnapshotManager(
      db,
      eventStore,
      createExtractSummarizer(),
      {
        snapshotInterval: 5 // Create snapshot every 5 events for testing
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

  describe('snapshot retention', () => {
    it('should keep all snapshots (no pruning)', async () => {
      // Create 5 snapshots — all should be retained
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

      // Verify all snapshots are kept
      const stmt = db.prepare('SELECT up_to_sequence FROM snapshots WHERE session_id = ? ORDER BY up_to_sequence DESC');
      const rows = stmt.all('session-1') as any[];

      expect(rows).toHaveLength(5);
      expect(rows[0].up_to_sequence).toBe(25);
      expect(rows[4].up_to_sequence).toBe(5);
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

  it('should handle empty events array', async () => {
    const summarizer = createExtractSummarizer();

    const result = await summarizer([]);

    expect(result.summary).toBe('Empty conversation');
    expect(result.keyFacts).toEqual([]);
    expect(result.filesModified).toEqual([]);
    expect(result.tokenCount).toBeGreaterThan(0);
  });
});

describe('createLLMSummarizer', () => {
  /** Helper to create a mock chat function that records calls */
  function createMockChat(response: string = 'Summary of conversation') {
    const calls: Array<{ messages: any[]; systemPrompt?: string; options?: any }> = [];
    const chatFn: SummarizerChatFn = async (messages, systemPrompt, options) => {
      calls.push({ messages, systemPrompt, options });
      return { content: response };
    };
    return { chatFn, calls };
  }

  const sampleEvents = [
    {
      id: '1',
      sessionId: 'session-1',
      sequence: 1,
      timestamp: Date.now(),
      type: 'user_message' as const,
      content: 'Help me fix the login bug in auth.ts'
    },
    {
      id: '2',
      sessionId: 'session-1',
      sequence: 2,
      timestamp: Date.now(),
      type: 'assistant_message' as const,
      content: 'I found the issue in the validateToken function',
      model: 'deepseek-chat',
      finishReason: 'stop' as const
    },
    {
      id: '3',
      sessionId: 'session-1',
      sequence: 3,
      timestamp: Date.now(),
      type: 'diff_created' as const,
      diffId: 'diff-1',
      filePath: 'src/auth.ts',
      originalContent: 'old code',
      newContent: 'new code'
    }
  ];

  it('should call chatFn with first-summary prompt when no previous summary', async () => {
    const { chatFn, calls } = createMockChat();
    const summarizer = createLLMSummarizer(chatFn);

    await summarizer(sampleEvents);

    expect(calls).toHaveLength(1);
    expect(calls[0].messages).toHaveLength(1);
    expect(calls[0].messages[0].role).toBe('user');
    expect(calls[0].messages[0].content).toContain('Conversation:');
    expect(calls[0].messages[0].content).toContain('Help me fix the login bug');
    expect(calls[0].systemPrompt).toContain('Summarize the following conversation');
    expect(calls[0].systemPrompt).not.toContain('Previous summary');
  });

  it('should call chatFn with chained prompt when previous summary exists', async () => {
    const { chatFn, calls } = createMockChat();
    const summarizer = createLLMSummarizer(chatFn);

    await summarizer(sampleEvents, 'Previous: user was fixing auth bugs');

    expect(calls).toHaveLength(1);
    expect(calls[0].messages[0].content).toContain('Previous summary:');
    expect(calls[0].messages[0].content).toContain('Previous: user was fixing auth bugs');
    expect(calls[0].messages[0].content).toContain('New messages since then:');
    expect(calls[0].systemPrompt).toContain('updated summary');
  });

  it('should return LLM response as summary', async () => {
    const { chatFn } = createMockChat('The user is fixing a login bug in auth.ts');
    const summarizer = createLLMSummarizer(chatFn);

    const result = await summarizer(sampleEvents);

    expect(result.summary).toBe('The user is fixing a login bug in auth.ts');
  });

  it('should extract filesModified from events', async () => {
    const { chatFn } = createMockChat();
    const summarizer = createLLMSummarizer(chatFn);

    const result = await summarizer(sampleEvents);

    expect(result.filesModified).toContain('src/auth.ts');
  });

  it('should extract keyFacts from user messages', async () => {
    const { chatFn } = createMockChat();
    const summarizer = createLLMSummarizer(chatFn);

    const result = await summarizer(sampleEvents);

    expect(result.keyFacts).toHaveLength(1);
    expect(result.keyFacts[0]).toContain('Help me fix the login bug');
  });

  it('should estimate token count from summary length', async () => {
    const longSummary = 'A'.repeat(400); // 400 chars ≈ 100 tokens
    const { chatFn } = createMockChat(longSummary);
    const summarizer = createLLMSummarizer(chatFn);

    const result = await summarizer(sampleEvents);

    expect(result.tokenCount).toBe(100);
  });

  it('should pass maxTokens and temperature to chatFn', async () => {
    const { chatFn, calls } = createMockChat();
    const summarizer = createLLMSummarizer(chatFn, 2000);

    await summarizer(sampleEvents);

    expect(calls[0].options).toEqual({ maxTokens: 2000, temperature: 0.3 });
  });

  it('should format different event types correctly', async () => {
    const { chatFn, calls } = createMockChat();
    const summarizer = createLLMSummarizer(chatFn);

    const events = [
      {
        id: '1', sessionId: 's1', sequence: 1, timestamp: Date.now(),
        type: 'user_message' as const, content: 'Hello'
      },
      {
        id: '2', sessionId: 's1', sequence: 2, timestamp: Date.now(),
        type: 'tool_call' as const, toolCallId: 'tc1', toolName: 'read_file',
        arguments: { path: 'test.ts' }
      },
      {
        id: '3', sessionId: 's1', sequence: 3, timestamp: Date.now(),
        type: 'tool_result' as const, toolCallId: 'tc1',
        result: 'file contents here', success: true
      },
      {
        id: '4', sessionId: 's1', sequence: 4, timestamp: Date.now(),
        type: 'web_search' as const, query: 'typescript generics',
        resultCount: 5, resultsPreview: ['result1']
      },
      {
        id: '5', sessionId: 's1', sequence: 5, timestamp: Date.now(),
        type: 'assistant_message' as const, content: 'Here is the answer',
        model: 'deepseek-chat', finishReason: 'stop' as const
      }
    ];

    await summarizer(events);

    const prompt = calls[0].messages[0].content;
    expect(prompt).toContain('User: Hello');
    expect(prompt).toContain('[Tool: read_file]');
    expect(prompt).toContain('[Tool result: success');
    expect(prompt).toContain('[Web search: typescript generics]');
    expect(prompt).toContain('Assistant: Here is the answer');
  });

  it('should truncate long tool results', async () => {
    const { chatFn, calls } = createMockChat();
    const summarizer = createLLMSummarizer(chatFn);

    const events = [
      {
        id: '1', sessionId: 's1', sequence: 1, timestamp: Date.now(),
        type: 'tool_result' as const, toolCallId: 'tc1',
        result: 'x'.repeat(500), success: true
      }
    ];

    await summarizer(events);

    const prompt = calls[0].messages[0].content;
    expect(prompt).toContain('...');
    // Should be truncated, not the full 500 chars
    expect(prompt.length).toBeLessThan(500);
  });

  it('should propagate chatFn errors', async () => {
    const failingChatFn: SummarizerChatFn = async () => {
      throw new Error('LLM API unavailable');
    };
    const summarizer = createLLMSummarizer(failingChatFn);

    await expect(summarizer(sampleEvents)).rejects.toThrow('LLM API unavailable');
  });

  it('should handle empty events array', async () => {
    const { chatFn, calls } = createMockChat();
    const summarizer = createLLMSummarizer(chatFn);

    const result = await summarizer([]);

    expect(calls).toHaveLength(1);
    expect(result.summary).toBe('Summary of conversation');
    expect(result.filesModified).toEqual([]);
    expect(result.keyFacts).toEqual([]);
  });
});

describe('SnapshotManager with chaining', () => {
  let db: Database;
  let eventStore: EventStore;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    // FK constraints require parent session to exist
    db.prepare('INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('session-1', 'Test', 'test', 1000, 1000);
    eventStore = new EventStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should pass previous summary to summarizer on second snapshot', async () => {
    const calls: Array<{ events: any[]; previousSummary?: string }> = [];
    const trackingSummarizer = async (events: any[], previousSummary?: string) => {
      calls.push({ events, previousSummary });
      return {
        summary: `Summary #${calls.length}`,
        keyFacts: [],
        filesModified: [],
        tokenCount: 50
      };
    };

    const snapshotManager = new SnapshotManager(
      db, eventStore, trackingSummarizer,
      { snapshotInterval: 3 }
    );

    // Create first batch of events + snapshot
    for (let i = 0; i < 3; i++) {
      eventStore.append({
        sessionId: 'session-1', timestamp: Date.now(),
        type: 'user_message', content: `First batch ${i}`
      });
    }
    await snapshotManager.createSnapshot('session-1');

    // Create second batch of events + snapshot
    for (let i = 0; i < 3; i++) {
      eventStore.append({
        sessionId: 'session-1', timestamp: Date.now(),
        type: 'user_message', content: `Second batch ${i}`
      });
    }
    await snapshotManager.createSnapshot('session-1');

    // First call: no previous summary
    expect(calls[0].previousSummary).toBeUndefined();
    expect(calls[0].events).toHaveLength(3);

    // Second call: previous summary from first snapshot
    expect(calls[1].previousSummary).toBe('Summary #1');
    expect(calls[1].events).toHaveLength(3); // Only events since last snapshot
  });
});
