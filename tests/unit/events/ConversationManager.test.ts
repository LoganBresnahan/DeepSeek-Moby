/**
 * Tests for ConversationManager.getSessionRichHistory() and getLatestSnapshotSummary()
 *
 * Uses in-memory database and directly injects EventStore
 * to test the event grouping logic without full initialization.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../../src/events/SqlJsWrapper';
import { runMigrations } from '../../../src/events/migrations';
import { EventStore } from '../../../src/events/EventStore';
import { SnapshotManager } from '../../../src/events/SnapshotManager';
import type { SummarizerFn } from '../../../src/events/SnapshotManager';
import { ConversationManager, RichHistoryTurn } from '../../../src/events/ConversationManager';

/** Simple deterministic mock summarizer for tests */
const mockSummarizer: SummarizerFn = async (events) => ({
  summary: events.map(e => 'content' in e ? (e as any).content : `[${e.type}]`).join('; ') || 'Empty conversation',
  filesModified: events.filter(e => e.type === 'diff_created').map(e => (e as any).filePath),
  keyFacts: events.filter(e => e.type === 'user_message').map(e => (e as any).content),
  tokenCount: Math.ceil(JSON.stringify(events).length / 4)
});

// Bind getSessionRichHistory to a lightweight mock that has just the eventStore.
// This avoids the full ConversationManager constructor (which needs vscode context).
const getSessionRichHistory = ConversationManager.prototype.getSessionRichHistory;

describe('ConversationManager.getSessionRichHistory', () => {
  let db: Database;
  let eventStore: EventStore;
  let callRichHistory: (sessionId: string) => Promise<RichHistoryTurn[]>;
  const SESSION_ID = 'test-session-1';

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    // FK constraints require parent sessions to exist
    db.prepare('INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(SESSION_ID, 'Test', 'test', 1000, 1000);
    db.prepare('INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('session-A', 'A', 'test', 1000, 1000);
    db.prepare('INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('session-B', 'B', 'test', 1000, 1000);
    eventStore = new EventStore(db);

    // Create a lightweight mock with just the fields getSessionRichHistory needs
    const mockCm = {
      eventStore
    };
    callRichHistory = (sessionId: string) => getSessionRichHistory.call(mockCm, sessionId);
  });

  afterEach(() => {
    db.close();
  });

  it('returns empty array for session with no events', async () => {
    const turns = await callRichHistory(SESSION_ID);
    expect(turns).toEqual([]);
  });

  it('groups a single user message into one turn', async () => {
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 1000,
      type: 'user_message',
      content: 'Hello'
    });

    const turns = await callRichHistory(SESSION_ID);
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe('user');
    expect(turns[0].content).toBe('Hello');
    expect(turns[0].timestamp).toBe(1000);
  });

  it('groups user message + assistant message into two turns', async () => {
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 1000,
      type: 'user_message',
      content: 'Hello'
    });
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 2000,
      type: 'assistant_message',
      content: 'Hi there!',
      model: 'deepseek-chat',
      finishReason: 'stop'
    });

    const turns = await callRichHistory(SESSION_ID);
    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe('user');
    expect(turns[0].content).toBe('Hello');
    expect(turns[1].role).toBe('assistant');
    expect(turns[1].content).toBe('Hi there!');
    expect(turns[1].model).toBe('deepseek-chat');
  });

  it('cleans up empty arrays from turns', async () => {
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 1000,
      type: 'user_message',
      content: 'Hello'
    });
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 2000,
      type: 'assistant_message',
      content: 'Hi!',
      model: 'deepseek-chat',
      finishReason: 'stop'
    });

    const turns = await callRichHistory(SESSION_ID);

    // Assistant turn with no reasoning/tools/shell should not have those arrays
    const assistantTurn = turns[1];
    expect(assistantTurn.reasoning_iterations).toBeUndefined();
    expect(assistantTurn.toolCalls).toBeUndefined();
    expect(assistantTurn.shellResults).toBeUndefined();

    // User turn should not have files if none
    expect(turns[0].files).toBeUndefined();
  });

  it('preserves user attachment file names', async () => {
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 1000,
      type: 'user_message',
      content: 'Check this file',
      attachments: [
        { type: 'file', name: 'index.ts', content: 'const x = 1;' },
        { type: 'file', name: 'utils.ts', content: 'export {}' }
      ]
    });

    const turns = await callRichHistory(SESSION_ID);
    expect(turns[0].files).toEqual(['index.ts', 'utils.ts']);
  });

  it('handles events from different sessions independently', async () => {
    // Session 1
    eventStore.append({
      sessionId: 'session-A',
      timestamp: 1000,
      type: 'user_message',
      content: 'Session A message'
    });
    // Session 2
    eventStore.append({
      sessionId: 'session-B',
      timestamp: 1000,
      type: 'user_message',
      content: 'Session B message'
    });

    const turnsA = await callRichHistory('session-A');
    const turnsB = await callRichHistory('session-B');

    expect(turnsA).toHaveLength(1);
    expect(turnsA[0].content).toBe('Session A message');

    expect(turnsB).toHaveLength(1);
    expect(turnsB[0].content).toBe('Session B message');
  });

  it('omits contentIterations when not present in event', async () => {
    eventStore.append({ sessionId: SESSION_ID, timestamp: 1000, type: 'user_message', content: 'Hello' });
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 2000,
      type: 'assistant_message',
      content: 'Simple response',
      model: 'deepseek-chat',
      finishReason: 'stop'
    });

    const turns = await callRichHistory(SESSION_ID);
    expect(turns[1].contentIterations).toBeUndefined();
  });

  it('includes event sequence numbers in turns', async () => {
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 1000,
      type: 'user_message',
      content: 'Hello'
    });
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 2000,
      type: 'assistant_message',
      content: 'Hi there',
      model: 'deepseek-chat',
      finishReason: 'stop'
    });

    const turns = await callRichHistory(SESSION_ID);
    expect(turns).toHaveLength(2);

    // User turn should have the user_message sequence
    expect(turns[0].sequence).toBeDefined();
    expect(typeof turns[0].sequence).toBe('number');
    expect(turns[0].sequence).toBe(1);

    // Assistant turn should have the assistant_message sequence
    expect(turns[1].sequence).toBeDefined();
    expect(typeof turns[1].sequence).toBe('number');
    expect(turns[1].sequence).toBe(2);
  });

  // ── Phase 3: structural event hydration ──
  // These tests exercise the flipped hydration path — reading from
  // structural_turn_event rows and resolving the authoritative assistant_message
  // by status. Fidelity test #1: extension-only coverage.

  function appendStructuralEvent(sessionId: string, turnId: string, indexInTurn: number, payload: Record<string, unknown>, timestamp = 2000 + indexInTurn) {
    eventStore.append({
      sessionId, timestamp, type: 'structural_turn_event',
      turnId, indexInTurn, payload,
    } as any);
  }

  it('Phase 3: populates turnEvents from structural_turn_event rows keyed by turnId', async () => {
    const TURN_ID = 'turn-abc';
    eventStore.append({ sessionId: SESSION_ID, timestamp: 1000, type: 'user_message', content: 'Hi' });
    // Placeholder
    eventStore.append({
      sessionId: SESSION_ID, timestamp: 1001, type: 'assistant_message',
      content: '', model: 'deepseek-reasoner', finishReason: 'stop',
      status: 'in_progress', turnId: TURN_ID,
    } as any);
    // Three structural events
    appendStructuralEvent(SESSION_ID, TURN_ID, 0, { type: 'text-append', content: 'Hello', iteration: 0, ts: 2000 });
    appendStructuralEvent(SESSION_ID, TURN_ID, 1, { type: 'text-append', content: ' world', iteration: 0, ts: 2001 });
    appendStructuralEvent(SESSION_ID, TURN_ID, 2, { type: 'iteration-end', iteration: 0, ts: 2002 });
    // Final
    eventStore.append({
      sessionId: SESSION_ID, timestamp: 3000, type: 'assistant_message',
      content: 'Hello world', model: 'deepseek-reasoner', finishReason: 'stop',
      status: 'complete', turnId: TURN_ID,
    } as any);

    const turns = await callRichHistory(SESSION_ID);
    expect(turns).toHaveLength(2);
    expect(turns[1].content).toBe('Hello world');
    expect(turns[1].turnEvents).toHaveLength(3);
    expect((turns[1].turnEvents![0] as any).type).toBe('text-append');
    expect((turns[1].turnEvents![2] as any).type).toBe('iteration-end');
  });

  it('Phase 3: picks complete row over in_progress placeholder for same turnId', async () => {
    const TURN_ID = 'turn-xyz';
    eventStore.append({ sessionId: SESSION_ID, timestamp: 1000, type: 'user_message', content: 'Hi' });
    eventStore.append({
      sessionId: SESSION_ID, timestamp: 1001, type: 'assistant_message',
      content: '', model: 'deepseek-chat', finishReason: 'stop',
      status: 'in_progress', turnId: TURN_ID,
    } as any);
    eventStore.append({
      sessionId: SESSION_ID, timestamp: 2000, type: 'assistant_message',
      content: 'final answer', model: 'deepseek-chat', finishReason: 'stop',
      status: 'complete', turnId: TURN_ID,
    } as any);

    const turns = await callRichHistory(SESSION_ID);
    // Turn is emitted once at the position of the first (placeholder) row.
    expect(turns.filter(t => t.role === 'assistant')).toHaveLength(1);
    expect(turns[1].content).toBe('final answer');
  });

  it('Phase 3: synthesizes shutdown-interrupted event when only in_progress row exists', async () => {
    const TURN_ID = 'turn-crash';
    eventStore.append({ sessionId: SESSION_ID, timestamp: 1000, type: 'user_message', content: 'Hi' });
    eventStore.append({
      sessionId: SESSION_ID, timestamp: 1001, type: 'assistant_message',
      content: '', model: 'deepseek-reasoner', finishReason: 'stop',
      status: 'in_progress', turnId: TURN_ID,
    } as any);
    appendStructuralEvent(SESSION_ID, TURN_ID, 0, { type: 'text-append', content: 'partial', iteration: 0, ts: 2000 });
    // No finalization — simulates host death mid-turn

    const turns = await callRichHistory(SESSION_ID);
    const events = turns[1].turnEvents!;
    const last = events[events.length - 1] as any;
    expect(last.type).toBe('shutdown-interrupted');
    expect(last.iteration).toBe(0);
  });

  it('Phase 3: does NOT synthesize shutdown-interrupted when a complete row exists', async () => {
    const TURN_ID = 'turn-clean';
    eventStore.append({ sessionId: SESSION_ID, timestamp: 1000, type: 'user_message', content: 'Hi' });
    eventStore.append({
      sessionId: SESSION_ID, timestamp: 1001, type: 'assistant_message',
      content: '', model: 'deepseek-chat', finishReason: 'stop',
      status: 'in_progress', turnId: TURN_ID,
    } as any);
    appendStructuralEvent(SESSION_ID, TURN_ID, 0, { type: 'text-append', content: 'ok', iteration: 0, ts: 2000 });
    eventStore.append({
      sessionId: SESSION_ID, timestamp: 3000, type: 'assistant_message',
      content: 'ok', model: 'deepseek-chat', finishReason: 'stop',
      status: 'complete', turnId: TURN_ID,
    } as any);

    const turns = await callRichHistory(SESSION_ID);
    const events = turns[1].turnEvents!;
    expect(events.every(e => (e as any).type !== 'shutdown-interrupted')).toBe(true);
  });

  it('Phase 3: interrupted status is preferred over in_progress when no complete exists', async () => {
    const TURN_ID = 'turn-stopped';
    eventStore.append({ sessionId: SESSION_ID, timestamp: 1000, type: 'user_message', content: 'Hi' });
    eventStore.append({
      sessionId: SESSION_ID, timestamp: 1001, type: 'assistant_message',
      content: '', model: 'deepseek-chat', finishReason: 'stop',
      status: 'in_progress', turnId: TURN_ID,
    } as any);
    eventStore.append({
      sessionId: SESSION_ID, timestamp: 3000, type: 'assistant_message',
      content: 'partial\n\n*[User interrupted]*', model: 'deepseek-chat', finishReason: 'stop',
      status: 'interrupted', turnId: TURN_ID,
    } as any);

    const turns = await callRichHistory(SESSION_ID);
    expect(turns[1].content).toBe('partial\n\n*[User interrupted]*');
    // And no shutdown-interrupted synthesis because the interrupted row exists
    const events = turns[1].turnEvents ?? [];
    expect(events.every(e => (e as any).type !== 'shutdown-interrupted')).toBe(true);
  });

  it('Phase 3: structural events for one turn do not bleed into another', async () => {
    const TURN_A = 'turn-A';
    const TURN_B = 'turn-B';
    eventStore.append({ sessionId: SESSION_ID, timestamp: 1000, type: 'user_message', content: 'First' });
    eventStore.append({
      sessionId: SESSION_ID, timestamp: 1001, type: 'assistant_message',
      content: 'a', model: 'deepseek-chat', finishReason: 'stop',
      status: 'complete', turnId: TURN_A,
    } as any);
    appendStructuralEvent(SESSION_ID, TURN_A, 0, { type: 'text-append', content: 'a', iteration: 0, ts: 2000 });
    eventStore.append({ sessionId: SESSION_ID, timestamp: 3000, type: 'user_message', content: 'Second' });
    eventStore.append({
      sessionId: SESSION_ID, timestamp: 3001, type: 'assistant_message',
      content: 'b', model: 'deepseek-chat', finishReason: 'stop',
      status: 'complete', turnId: TURN_B,
    } as any);
    appendStructuralEvent(SESSION_ID, TURN_B, 0, { type: 'text-append', content: 'b', iteration: 0, ts: 4000 });

    const turns = await callRichHistory(SESSION_ID);
    const assistantTurns = turns.filter(t => t.role === 'assistant');
    expect(assistantTurns).toHaveLength(2);
    expect((assistantTurns[0].turnEvents![0] as any).content).toBe('a');
    expect((assistantTurns[1].turnEvents![0] as any).content).toBe('b');
    expect(assistantTurns[0].turnEvents).toHaveLength(1);
    expect(assistantTurns[1].turnEvents).toHaveLength(1);
  });
});

// ADR 0003 Phase 2/3: getSessionMessagesCompat feeds API context. It must
// filter out in_progress placeholder rows — otherwise DeepSeek rejects the
// request with "Invalid consecutive assistant message". Regression guard.
describe('ConversationManager.getSessionMessagesCompat — placeholder filtering', () => {
  const getCompat = ConversationManager.prototype.getSessionMessagesCompat;
  let db: Database;
  let eventStore: EventStore;
  const SESSION_ID = 'compat-test';

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.prepare('INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(SESSION_ID, 'Test', 'test', 1000, 1000);
    eventStore = new EventStore(db);
  });

  afterEach(() => { db.close(); });

  it('skips assistant_message rows with status=in_progress (Phase 2 placeholders)', async () => {
    const TURN_ID = 'turn-1';
    eventStore.append({ sessionId: SESSION_ID, timestamp: 1000, type: 'user_message', content: 'Hello' } as any);
    // Placeholder — MUST NOT appear in API context
    eventStore.append({
      sessionId: SESSION_ID, timestamp: 1001, type: 'assistant_message',
      content: '', model: 'deepseek-chat', finishReason: 'stop',
      status: 'in_progress', turnId: TURN_ID,
    } as any);

    const messages = await getCompat.call({ eventStore } as any, SESSION_ID);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('Hello');
  });

  it('includes assistant_message rows with status=complete', async () => {
    const TURN_ID = 'turn-1';
    eventStore.append({ sessionId: SESSION_ID, timestamp: 1000, type: 'user_message', content: 'Hello' } as any);
    eventStore.append({
      sessionId: SESSION_ID, timestamp: 1001, type: 'assistant_message',
      content: '', model: 'deepseek-chat', finishReason: 'stop',
      status: 'in_progress', turnId: TURN_ID,
    } as any);
    eventStore.append({
      sessionId: SESSION_ID, timestamp: 2000, type: 'assistant_message',
      content: 'Hi there', model: 'deepseek-chat', finishReason: 'stop',
      status: 'complete', turnId: TURN_ID,
    } as any);

    const messages = await getCompat.call({ eventStore } as any, SESSION_ID);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toBe('Hi there');
  });

  it('includes assistant_message rows with status=interrupted', async () => {
    const TURN_ID = 'turn-1';
    eventStore.append({ sessionId: SESSION_ID, timestamp: 1000, type: 'user_message', content: 'Hello' } as any);
    eventStore.append({
      sessionId: SESSION_ID, timestamp: 2000, type: 'assistant_message',
      content: 'partial\n\n*[User interrupted]*', model: 'deepseek-chat', finishReason: 'stop',
      status: 'interrupted', turnId: TURN_ID,
    } as any);

    const messages = await getCompat.call({ eventStore } as any, SESSION_ID);
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toContain('*[User interrupted]*');
  });

  it('includes pre-Phase-2 rows without status field (backward compat)', async () => {
    eventStore.append({ sessionId: SESSION_ID, timestamp: 1000, type: 'user_message', content: 'Hi' } as any);
    eventStore.append({
      sessionId: SESSION_ID, timestamp: 2000, type: 'assistant_message',
      content: 'legacy response', model: 'deepseek-chat', finishReason: 'stop',
    } as any);

    const messages = await getCompat.call({ eventStore } as any, SESSION_ID);
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toBe('legacy response');
  });
});

// Bind hasFreshSummary / createSnapshot to lightweight mocks
const hasFreshSummary = ConversationManager.prototype.hasFreshSummary;
const createSnapshot = ConversationManager.prototype.createSnapshot;

describe('ConversationManager.hasFreshSummary', () => {
  let db: Database;
  let eventStore: EventStore;
  let snapshotManager: SnapshotManager;
  let callHasFreshSummary: (sessionId: string, threshold?: number) => boolean;
  const SESSION_ID = 'test-session-fresh';

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    // FK constraints require parent session to exist
    db.prepare('INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(SESSION_ID, 'Test', 'test', 1000, 1000);
    eventStore = new EventStore(db);
    snapshotManager = new SnapshotManager(db, eventStore, mockSummarizer);

    const mockCm = { snapshotManager, eventStore };
    callHasFreshSummary = (sessionId: string, threshold?: number) =>
      hasFreshSummary.call(mockCm, sessionId, threshold);
  });

  afterEach(() => {
    db.close();
  });

  it('returns false when no snapshots exist', () => {
    expect(callHasFreshSummary(SESSION_ID)).toBe(false);
  });

  it('returns true when snapshot covers recent events (within threshold)', async () => {
    // Add 10 events
    for (let i = 0; i < 10; i++) {
      eventStore.append({
        sessionId: SESSION_ID,
        timestamp: 1000 + i * 100,
        type: 'user_message',
        content: `Message ${i}`
      });
    }
    // Create snapshot at event 10
    await snapshotManager.createSnapshot(SESSION_ID);

    // Add 3 more events (within default threshold of 5)
    for (let i = 0; i < 3; i++) {
      eventStore.append({
        sessionId: SESSION_ID,
        timestamp: 2000 + i * 100,
        type: 'user_message',
        content: `New message ${i}`
      });
    }

    expect(callHasFreshSummary(SESSION_ID)).toBe(true);
  });

  it('returns false when snapshot is stale (many events since)', async () => {
    // Add 10 events and snapshot
    for (let i = 0; i < 10; i++) {
      eventStore.append({
        sessionId: SESSION_ID,
        timestamp: 1000 + i * 100,
        type: 'user_message',
        content: `Message ${i}`
      });
    }
    await snapshotManager.createSnapshot(SESSION_ID);

    // Add 10 more events (beyond default threshold of 5)
    for (let i = 0; i < 10; i++) {
      eventStore.append({
        sessionId: SESSION_ID,
        timestamp: 2000 + i * 100,
        type: 'user_message',
        content: `New message ${i}`
      });
    }

    expect(callHasFreshSummary(SESSION_ID)).toBe(false);
  });

  it('respects custom threshold parameter', async () => {
    for (let i = 0; i < 5; i++) {
      eventStore.append({
        sessionId: SESSION_ID,
        timestamp: 1000 + i * 100,
        type: 'user_message',
        content: `Message ${i}`
      });
    }
    await snapshotManager.createSnapshot(SESSION_ID);

    // Add 2 events
    eventStore.append({ sessionId: SESSION_ID, timestamp: 2000, type: 'user_message', content: 'new 1' });
    eventStore.append({ sessionId: SESSION_ID, timestamp: 2100, type: 'user_message', content: 'new 2' });

    // With threshold=3, 2 events since snapshot → fresh
    expect(callHasFreshSummary(SESSION_ID, 3)).toBe(true);
    // With threshold=1, 2 events since snapshot → stale
    expect(callHasFreshSummary(SESSION_ID, 1)).toBe(false);
  });

  it('returns true when snapshot covers ALL events (0 since)', async () => {
    for (let i = 0; i < 5; i++) {
      eventStore.append({
        sessionId: SESSION_ID,
        timestamp: 1000 + i * 100,
        type: 'user_message',
        content: `Message ${i}`
      });
    }
    await snapshotManager.createSnapshot(SESSION_ID);

    // No new events since snapshot
    expect(callHasFreshSummary(SESSION_ID)).toBe(true);
  });
});

describe('ConversationManager.createSnapshot', () => {
  let db: Database;
  let eventStore: EventStore;
  let snapshotManager: SnapshotManager;
  let callCreateSnapshot: (sessionId: string) => Promise<void>;
  const SESSION_ID = 'test-session-snap-create';

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    // FK constraints require parent session to exist
    db.prepare('INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(SESSION_ID, 'Test', 'test', 1000, 1000);
    eventStore = new EventStore(db);
    snapshotManager = new SnapshotManager(db, eventStore, mockSummarizer);

    const mockCm = { snapshotManager };
    callCreateSnapshot = (sessionId: string) => createSnapshot.call(mockCm, sessionId);
  });

  afterEach(() => {
    db.close();
  });

  it('delegates to snapshotManager.createSnapshot()', async () => {
    for (let i = 0; i < 5; i++) {
      eventStore.append({
        sessionId: SESSION_ID,
        timestamp: 1000 + i * 100,
        type: 'user_message',
        content: `Message ${i}`
      });
    }

    await callCreateSnapshot(SESSION_ID);

    const snapshot = snapshotManager.getLatestSnapshot(SESSION_ID);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.sessionId).toBe(SESSION_ID);
    expect(snapshot!.summary).toContain('Message 0');
  });
});

// Test that recordAssistantMessage no longer auto-creates snapshots
const recordAssistantMessage = ConversationManager.prototype.recordAssistantMessage;

describe('ConversationManager.recordAssistantMessage — no auto-snapshot', () => {
  let db: Database;
  let eventStore: EventStore;
  let snapshotManager: SnapshotManager;
  const SESSION_ID = 'test-session-no-auto';

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.prepare(`INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(SESSION_ID, 'Test', 'deepseek-chat', Date.now(), Date.now());
    eventStore = new EventStore(db);
    // Use small interval so we can test that auto-snapshot does NOT fire
    snapshotManager = new SnapshotManager(db, eventStore, mockSummarizer, { snapshotInterval: 3 });
  });

  afterEach(() => {
    db.close();
  });

  it('should NOT auto-create snapshots after recording assistant messages', async () => {
    // Create a mock that has the fields recordAssistantMessage needs
    const mockCm = {
      eventStore,
      snapshotManager,
      onSessionsChanged: { fire: () => {} },
      updateSessionMetadata: () => {},
    };

    // Add more than snapshotInterval events (3) via recordAssistantMessage
    for (let i = 0; i < 10; i++) {
      await recordAssistantMessage.call(mockCm, SESSION_ID, `Response ${i}`, 'deepseek-chat', 'stop');
    }

    // No snapshot should have been auto-created
    const snapshot = snapshotManager.getLatestSnapshot(SESSION_ID);
    expect(snapshot).toBeNull();
  });
});

// Bind getLatestSnapshotSummary to a lightweight mock
const getLatestSnapshotSummary = ConversationManager.prototype.getLatestSnapshotSummary;

describe('ConversationManager.getLatestSnapshotSummary', () => {
  let db: Database;
  let eventStore: EventStore;
  let snapshotManager: SnapshotManager;
  let callGetSummary: (sessionId: string) => { summary: string; tokenCount: number; snapshotId: string } | undefined;
  const SESSION_ID = 'test-session-snap';

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    // FK constraints require parent sessions to exist
    db.prepare('INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(SESSION_ID, 'Test', 'test', 1000, 1000);
    db.prepare('INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('session-A', 'A', 'test', 1000, 1000);
    db.prepare('INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('session-B', 'B', 'test', 1000, 1000);
    eventStore = new EventStore(db);
    snapshotManager = new SnapshotManager(db, eventStore, mockSummarizer);

    const mockCm = { snapshotManager };
    callGetSummary = (sessionId: string) => getLatestSnapshotSummary.call(mockCm, sessionId);
  });

  afterEach(() => {
    db.close();
  });

  it('returns undefined when no snapshots exist', () => {
    const result = callGetSummary(SESSION_ID);
    expect(result).toBeUndefined();
  });

  it('returns snapshot summary after snapshot is created', async () => {
    // Append enough events to trigger a snapshot (default interval is 20)
    for (let i = 0; i < 25; i++) {
      eventStore.append({
        sessionId: SESSION_ID,
        timestamp: 1000 + i * 100,
        type: i % 2 === 0 ? 'user_message' : 'assistant_message',
        content: `Message ${i}`,
        ...(i % 2 === 1 ? { model: 'deepseek-chat', finishReason: 'stop' } : {})
      });
    }

    // Force create a snapshot
    await snapshotManager.createSnapshot(SESSION_ID);

    const result = callGetSummary(SESSION_ID);
    expect(result).toBeDefined();
    expect(result!.summary.length).toBeGreaterThan(0);
    expect(result!.tokenCount).toBeGreaterThan(0);
    expect(result!.snapshotId).toBeDefined();
    expect(result!.summary).toContain('Message 0');
  });

  it('returns undefined for session with no snapshots even if other sessions have them', async () => {
    // Create events and snapshot for session A
    for (let i = 0; i < 5; i++) {
      eventStore.append({
        sessionId: 'session-A',
        timestamp: 1000 + i * 100,
        type: 'user_message',
        content: `Message ${i}`
      });
    }
    await snapshotManager.createSnapshot('session-A');

    // Session B has no snapshots
    const result = callGetSummary('session-B');
    expect(result).toBeUndefined();

    // Session A should have a summary
    const resultA = callGetSummary('session-A');
    expect(resultA).toBeDefined();
  });
});

// ==========================================================================
// Fork Session
// ==========================================================================

const callForkSession = ConversationManager.prototype.forkSession;
const callGetSessionForks = ConversationManager.prototype.getSessionForks;
const rowToSession = (ConversationManager.prototype as any).rowToSession;

/**
 * Create a mock ConversationManager with real DB + EventStore for fork testing.
 * Uses the same lightweight-mock pattern as other tests but includes the
 * prepared statements and helper methods that forkSession() needs.
 */
function createForkMockCm(db: Database, eventStore: EventStore) {
  const stmtInsertSession = db.prepare(`
    INSERT INTO sessions (id, title, model, created_at, updated_at, event_count, tags, parent_session_id, fork_sequence)
    VALUES (?, ?, ?, ?, ?, 0, '[]', ?, ?)
  `);
  const stmtGetSession = db.prepare('SELECT * FROM sessions WHERE id = ?');
  const stmtUpdateSession = db.prepare(`
    UPDATE sessions
    SET title = ?, updated_at = ?, event_count = ?,
        first_user_message = ?, last_activity_preview = ?
    WHERE id = ?
  `);

  return {
    db,
    eventStore,
    stmtInsertSession,
    stmtGetSession,
    stmtUpdateSession,
    onSessionsChanged: { fire: () => {} },
    getSessionSync(id: string) {
      const row = stmtGetSession.get(id) as any;
      return row ? rowToSession.call(this, row) : null;
    },
    async getSession(id: string) {
      const row = stmtGetSession.get(id) as any;
      return row ? rowToSession.call(this, row) : null;
    },
    rowToSession,
  };
}

describe('ConversationManager.forkSession', () => {
  let db: Database;
  let eventStore: EventStore;
  let mockCm: ReturnType<typeof createForkMockCm>;
  const PARENT_ID = 'parent-session-fork';

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    eventStore = new EventStore(db);
    mockCm = createForkMockCm(db, eventStore);

    // Create the parent session
    mockCm.stmtInsertSession.run(PARENT_ID, 'Parent Chat', 'deepseek-chat', 1000, 1000, null, null);
  });

  afterEach(() => {
    db.close();
  });

  /** Seed parent with a basic user → assistant turn (sequences 1, 2). */
  function seedTurn() {
    eventStore.append({
      sessionId: PARENT_ID, timestamp: 1000,
      type: 'user_message', content: 'Hello'
    });
    eventStore.append({
      sessionId: PARENT_ID, timestamp: 2000,
      type: 'assistant_message', content: 'Hi there!',
      model: 'deepseek-chat', finishReason: 'stop'
    });
  }

  it('creates a fork session with correct parent reference', async () => {
    seedTurn();
    const { session: fork, forkEventType } = await callForkSession.call(mockCm, PARENT_ID, 2);

    expect(fork).toBeDefined();
    expect(fork.parentSessionId).toBe(PARENT_ID);
    expect(fork.forkSequence).toBe(2);
    expect(fork.title).toBe('Parent Chat (fork)');
    expect(fork.model).toBe('deepseek-chat');
    expect(forkEventType).toBe('assistant_message');
  });

  it('links parent events to fork via join table (zero-copy)', async () => {
    seedTurn();
    const { session: fork } = await callForkSession.call(mockCm, PARENT_ID, 2);

    const parentEvents = eventStore.getEvents(PARENT_ID);
    const forkEvents = eventStore.getEvents(fork.id);

    // Parent has 2 events; fork has 2 linked + 1 fork_created = 3
    expect(parentEvents).toHaveLength(2);
    expect(forkEvents).toHaveLength(3);

    // Shared events have the SAME event IDs (zero-copy)
    expect(forkEvents[0].id).toBe(parentEvents[0].id);
    expect(forkEvents[1].id).toBe(parentEvents[1].id);

    // Sequences preserved from parent
    expect(forkEvents[0].sequence).toBe(1);
    expect(forkEvents[1].sequence).toBe(2);

    // fork_created is sequence 3
    expect(forkEvents[2].type).toBe('fork_created');
    expect(forkEvents[2].sequence).toBe(3);
  });

  it('records fork_created event with correct metadata', async () => {
    seedTurn();
    const { session: fork } = await callForkSession.call(mockCm, PARENT_ID, 2);

    const forkEvents = eventStore.getEvents(fork.id);
    const forkCreated = forkEvents.find(e => e.type === 'fork_created')!;

    expect(forkCreated).toBeDefined();
    expect((forkCreated as any).parentSessionId).toBe(PARENT_ID);
    expect((forkCreated as any).forkPointSequence).toBe(2);
  });

  it('forks at user_message boundary (sequence 1)', async () => {
    seedTurn();
    const { session: fork, forkEventType, lastUserMessage } = await callForkSession.call(mockCm, PARENT_ID, 1);

    expect(fork).toBeDefined();
    expect(forkEventType).toBe('user_message');
    expect(lastUserMessage).toBe('Hello');
    const forkEvents = eventStore.getEvents(fork.id);
    // 1 linked + 1 fork_created = 2
    expect(forkEvents).toHaveLength(2);
    expect(forkEvents[0].type).toBe('user_message');
    expect(forkEvents[1].type).toBe('fork_created');
  });

  it('rejects fork at non-turn-boundary (tool_call)', async () => {
    eventStore.append({ sessionId: PARENT_ID, timestamp: 1000, type: 'user_message', content: 'Do something' });
    eventStore.append({ sessionId: PARENT_ID, timestamp: 2000, type: 'tool_call', toolCallId: 'tc-1', toolName: 'shell', arguments: { command: 'ls' } });
    eventStore.append({ sessionId: PARENT_ID, timestamp: 3000, type: 'tool_result', toolCallId: 'tc-1', result: 'files', success: true });
    eventStore.append({ sessionId: PARENT_ID, timestamp: 4000, type: 'assistant_message', content: 'Done.', model: 'deepseek-chat', finishReason: 'stop' });

    await expect(
      callForkSession.call(mockCm, PARENT_ID, 2)
    ).rejects.toThrow(/must be 'user_message' or 'assistant_message'/);
  });

  it('rejects fork at non-turn-boundary (assistant_reasoning)', async () => {
    eventStore.append({ sessionId: PARENT_ID, timestamp: 1000, type: 'user_message', content: 'Think' });
    eventStore.append({ sessionId: PARENT_ID, timestamp: 2000, type: 'assistant_reasoning', content: 'Thinking...', iteration: 0 });
    eventStore.append({ sessionId: PARENT_ID, timestamp: 3000, type: 'assistant_message', content: 'Done.', model: 'deepseek-reasoner', finishReason: 'stop' });

    await expect(
      callForkSession.call(mockCm, PARENT_ID, 2)
    ).rejects.toThrow(/must be 'user_message' or 'assistant_message'/);
  });

  it('rejects fork at non-turn-boundary (tool_result)', async () => {
    eventStore.append({ sessionId: PARENT_ID, timestamp: 1000, type: 'user_message', content: 'Run it' });
    eventStore.append({ sessionId: PARENT_ID, timestamp: 2000, type: 'tool_call', toolCallId: 'tc-1', toolName: 'shell', arguments: { command: 'ls' } });
    eventStore.append({ sessionId: PARENT_ID, timestamp: 3000, type: 'tool_result', toolCallId: 'tc-1', result: 'output', success: true });
    eventStore.append({ sessionId: PARENT_ID, timestamp: 4000, type: 'assistant_message', content: 'Done.', model: 'deepseek-chat', finishReason: 'stop' });

    await expect(
      callForkSession.call(mockCm, PARENT_ID, 3)
    ).rejects.toThrow(/must be 'user_message' or 'assistant_message'/);
  });

  it('rejects fork at non-existent sequence', async () => {
    seedTurn();

    await expect(
      callForkSession.call(mockCm, PARENT_ID, 99)
    ).rejects.toThrow(/no event at sequence 99/);
  });

  it('rejects fork of non-existent session', async () => {
    await expect(
      callForkSession.call(mockCm, 'nonexistent', 1)
    ).rejects.toThrow(/parent session nonexistent not found/);
  });

  it('updates fork session metadata (event_count, first_user_message, preview)', async () => {
    seedTurn();
    const { session: fork } = await callForkSession.call(mockCm, PARENT_ID, 2);

    expect(fork.eventCount).toBe(3); // 2 linked + fork_created
    expect(fork.firstUserMessage).toBe('Hello');
    expect(fork.lastActivityPreview).toBe('Forked from session');
  });

  it('fork-of-fork works (nested forking)', async () => {
    seedTurn();

    // First fork at assistant_message
    const { session: fork1 } = await callForkSession.call(mockCm, PARENT_ID, 2);

    // Add new conversation in the fork
    eventStore.append({ sessionId: fork1.id, timestamp: 5000, type: 'user_message', content: 'Follow-up in fork' });
    eventStore.append({ sessionId: fork1.id, timestamp: 6000, type: 'assistant_message', content: 'Fork reply', model: 'deepseek-chat', finishReason: 'stop' });

    // Get the latest sequence in fork1
    const fork1Events = eventStore.getEvents(fork1.id);
    const lastSeq = fork1Events[fork1Events.length - 1].sequence;

    // Fork the fork
    const { session: fork2 } = await callForkSession.call(mockCm, fork1.id, lastSeq);

    expect(fork2).toBeDefined();
    expect(fork2.parentSessionId).toBe(fork1.id);
    expect(fork2.title).toBe('Parent Chat (fork) (fork)');
  });

  it('parent deletion does not affect fork (shared events survive)', async () => {
    seedTurn();
    const { session: fork } = await callForkSession.call(mockCm, PARENT_ID, 2);
    const forkId = fork.id;

    // Delete parent (CASCADE removes parent's event_sessions + snapshots)
    const deleteParent = db.transaction(() => {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(PARENT_ID);
      db.prepare('DELETE FROM events WHERE id NOT IN (SELECT event_id FROM event_sessions)').run();
    });
    deleteParent();

    // Parent is gone
    expect(mockCm.getSessionSync(PARENT_ID)).toBeNull();

    // Fork still exists
    const forkAfter = mockCm.getSessionSync(forkId);
    expect(forkAfter).not.toBeNull();
    expect(forkAfter!.id).toBe(forkId);

    // Fork events still accessible (shared events preserved since fork references them)
    const forkEvents = eventStore.getEvents(forkId);
    expect(forkEvents.length).toBeGreaterThanOrEqual(3);
    expect(forkEvents[0].type).toBe('user_message');
    expect(forkEvents[1].type).toBe('assistant_message');
  });

  it('forks with single user_message (minimal case)', async () => {
    eventStore.append({ sessionId: PARENT_ID, timestamp: 1000, type: 'user_message', content: 'Just one message' });

    const { session: fork, forkEventType, lastUserMessage } = await callForkSession.call(mockCm, PARENT_ID, 1);

    expect(forkEventType).toBe('user_message');
    expect(lastUserMessage).toBe('Just one message');
    const forkEvents = eventStore.getEvents(fork.id);
    expect(forkEvents).toHaveLength(2); // 1 linked + fork_created
    expect(forkEvents[0].type).toBe('user_message');
    expect((forkEvents[0] as any).content).toBe('Just one message');
  });

  it('parent events remain unchanged after fork', async () => {
    seedTurn();
    const parentEventsBefore = eventStore.getEvents(PARENT_ID);

    await callForkSession.call(mockCm, PARENT_ID, 2);

    const parentEventsAfter = eventStore.getEvents(PARENT_ID);
    expect(parentEventsAfter).toHaveLength(parentEventsBefore.length);
    expect(parentEventsAfter.map(e => e.id)).toEqual(parentEventsBefore.map(e => e.id));
  });

  it('multiple forks from same parent are independent', async () => {
    seedTurn();

    const { session: fork1 } = await callForkSession.call(mockCm, PARENT_ID, 2);
    const { session: fork2 } = await callForkSession.call(mockCm, PARENT_ID, 2);

    expect(fork1.id).not.toBe(fork2.id);

    // Add events to fork1 only
    eventStore.append({ sessionId: fork1.id, timestamp: 7000, type: 'user_message', content: 'Only in fork1' });

    const fork1Events = eventStore.getEvents(fork1.id);
    const fork2Events = eventStore.getEvents(fork2.id);

    // fork1 has extra event, fork2 does not
    expect(fork1Events.length).toBe(fork2Events.length + 1);
  });
});

describe('ConversationManager.getSessionForks', () => {
  let db: Database;
  let eventStore: EventStore;
  let mockCm: ReturnType<typeof createForkMockCm>;
  const PARENT_ID = 'parent-session-get-forks';

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    eventStore = new EventStore(db);
    mockCm = createForkMockCm(db, eventStore);

    mockCm.stmtInsertSession.run(PARENT_ID, 'Parent Chat', 'deepseek-chat', 1000, 1000, null, null);
  });

  afterEach(() => {
    db.close();
  });

  it('returns empty array for session with no forks', async () => {
    const forks = await callGetSessionForks.call(mockCm, PARENT_ID);
    expect(forks).toEqual([]);
  });

  it('returns all fork children of a parent', async () => {
    eventStore.append({ sessionId: PARENT_ID, timestamp: 1000, type: 'user_message', content: 'Hello' });
    eventStore.append({ sessionId: PARENT_ID, timestamp: 2000, type: 'assistant_message', content: 'Hi!', model: 'deepseek-chat', finishReason: 'stop' });

    const { session: fork1 } = await callForkSession.call(mockCm, PARENT_ID, 2);
    const { session: fork2 } = await callForkSession.call(mockCm, PARENT_ID, 2);

    const forks = await callGetSessionForks.call(mockCm, PARENT_ID);
    expect(forks).toHaveLength(2);
    const forkIds = forks.map(f => f.id);
    expect(forkIds).toContain(fork1.id);
    expect(forkIds).toContain(fork2.id);
  });

  it('does not return forks of other sessions', async () => {
    // Create another session
    const otherId = 'other-session-1';
    mockCm.stmtInsertSession.run(otherId, 'Other Chat', 'deepseek-chat', 1000, 1000, null, null);
    eventStore.append({ sessionId: otherId, timestamp: 1000, type: 'user_message', content: 'Other' });
    eventStore.append({ sessionId: otherId, timestamp: 2000, type: 'assistant_message', content: 'Reply', model: 'deepseek-chat', finishReason: 'stop' });

    // Fork the other session, not the parent
    await callForkSession.call(mockCm, otherId, 2);

    const forks = await callGetSessionForks.call(mockCm, PARENT_ID);
    expect(forks).toEqual([]);
  });
});

// ====================================================
// getRecentTurnSequences
// ====================================================

const getRecentTurnSequences = ConversationManager.prototype.getRecentTurnSequences;

describe('ConversationManager.getRecentTurnSequences', () => {
  let db: Database;
  let eventStore: EventStore;
  const SESSION_ID = 'recent-seq-session';

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    eventStore = new EventStore(db);
    db.prepare('INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(SESSION_ID, 'Test', 'deepseek-chat', 1000, 1000);
  });

  afterEach(() => {
    db.close();
  });

  it('returns undefined for both when session has no events', () => {
    const mockCm = { eventStore } as any;
    const result = getRecentTurnSequences.call(mockCm, SESSION_ID);
    expect(result.userSequence).toBeUndefined();
    expect(result.assistantSequence).toBeUndefined();
  });

  it('returns user sequence when only user message exists', () => {
    eventStore.append({ sessionId: SESSION_ID, timestamp: 1000, type: 'user_message', content: 'Hello' });

    const mockCm = { eventStore } as any;
    const result = getRecentTurnSequences.call(mockCm, SESSION_ID);
    expect(result.userSequence).toBe(1);
    expect(result.assistantSequence).toBeUndefined();
  });

  it('returns both sequences for a complete turn', () => {
    eventStore.append({ sessionId: SESSION_ID, timestamp: 1000, type: 'user_message', content: 'Hello' });
    eventStore.append({ sessionId: SESSION_ID, timestamp: 2000, type: 'assistant_message', content: 'Hi', model: 'deepseek-chat', finishReason: 'stop' });

    const mockCm = { eventStore } as any;
    const result = getRecentTurnSequences.call(mockCm, SESSION_ID);
    expect(result.userSequence).toBe(1);
    expect(result.assistantSequence).toBe(2);
  });

  it('returns most recent sequences when multiple turns exist', () => {
    eventStore.append({ sessionId: SESSION_ID, timestamp: 1000, type: 'user_message', content: 'First' });
    eventStore.append({ sessionId: SESSION_ID, timestamp: 2000, type: 'assistant_message', content: 'Reply 1', model: 'deepseek-chat', finishReason: 'stop' });
    eventStore.append({ sessionId: SESSION_ID, timestamp: 3000, type: 'user_message', content: 'Second' });
    eventStore.append({ sessionId: SESSION_ID, timestamp: 4000, type: 'assistant_message', content: 'Reply 2', model: 'deepseek-chat', finishReason: 'stop' });

    const mockCm = { eventStore } as any;
    const result = getRecentTurnSequences.call(mockCm, SESSION_ID);
    expect(result.userSequence).toBe(3);
    expect(result.assistantSequence).toBe(4);
  });
});
