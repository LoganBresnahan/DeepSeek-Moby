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

  it('groups reasoning iterations into assistant turn', async () => {
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 1000,
      type: 'user_message',
      content: 'Think about this'
    });
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 2000,
      type: 'assistant_reasoning',
      content: 'First I need to consider...',
      iteration: 0
    });
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 2100,
      type: 'assistant_reasoning',
      content: 'Then I should analyze...',
      iteration: 1
    });
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 3000,
      type: 'assistant_message',
      content: 'Here is my answer.',
      model: 'deepseek-reasoner',
      finishReason: 'stop'
    });

    const turns = await callRichHistory(SESSION_ID);
    expect(turns).toHaveLength(2);

    const assistantTurn = turns[1];
    expect(assistantTurn.role).toBe('assistant');
    expect(assistantTurn.content).toBe('Here is my answer.');
    expect(assistantTurn.model).toBe('deepseek-reasoner');
    expect(assistantTurn.reasoning_iterations).toEqual([
      'First I need to consider...',
      'Then I should analyze...'
    ]);
  });

  it('groups tool calls with results into assistant turn', async () => {
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 1000,
      type: 'user_message',
      content: 'Search for something'
    });
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 2000,
      type: 'tool_call',
      toolCallId: 'tc-1',
      toolName: 'web_search',
      arguments: { detail: 'searching the web' }
    });
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 2500,
      type: 'tool_result',
      toolCallId: 'tc-1',
      result: '5 results found',
      success: true
    });
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 3000,
      type: 'assistant_message',
      content: 'I found results.',
      model: 'deepseek-chat',
      finishReason: 'stop'
    });

    const turns = await callRichHistory(SESSION_ID);
    expect(turns).toHaveLength(2);

    const assistantTurn = turns[1];
    expect(assistantTurn.toolCalls).toHaveLength(1);
    expect(assistantTurn.toolCalls![0].name).toBe('web_search');
    expect(assistantTurn.toolCalls![0].status).toBe('done');
    // No shell results
    expect(assistantTurn.shellResults).toBeUndefined();
  });

  it('groups shell tool calls into shellResults', async () => {
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 1000,
      type: 'user_message',
      content: 'Run a command'
    });
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 2000,
      type: 'tool_call',
      toolCallId: 'sh-1',
      toolName: 'shell',
      arguments: { command: 'ls -la' }
    });
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 2500,
      type: 'tool_result',
      toolCallId: 'sh-1',
      result: 'file1.txt\nfile2.txt',
      success: true,
      duration: 150
    });
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 3000,
      type: 'assistant_message',
      content: 'Here are the files.',
      model: 'deepseek-chat',
      finishReason: 'stop'
    });

    const turns = await callRichHistory(SESSION_ID);
    expect(turns).toHaveLength(2);

    const assistantTurn = turns[1];
    expect(assistantTurn.shellResults).toHaveLength(1);
    expect(assistantTurn.shellResults![0].command).toBe('ls -la');
    expect(assistantTurn.shellResults![0].output).toBe('file1.txt\nfile2.txt');
    expect(assistantTurn.shellResults![0].success).toBe(true);
    // No non-shell tool calls
    expect(assistantTurn.toolCalls).toBeUndefined();
  });

  it('handles failed tool results', async () => {
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 1000,
      type: 'user_message',
      content: 'Do something'
    });
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 2000,
      type: 'tool_call',
      toolCallId: 'tc-1',
      toolName: 'file_read',
      arguments: { detail: 'reading file' }
    });
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 2500,
      type: 'tool_result',
      toolCallId: 'tc-1',
      result: 'File not found',
      success: false
    });
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 3000,
      type: 'assistant_message',
      content: 'File not found.',
      model: 'deepseek-chat',
      finishReason: 'stop'
    });

    const turns = await callRichHistory(SESSION_ID);
    const assistantTurn = turns[1];
    expect(assistantTurn.toolCalls![0].status).toBe('error');
  });

  it('handles multi-turn conversation with all segment types', async () => {
    // Turn 1: user
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 1000,
      type: 'user_message',
      content: 'Analyze this code'
    });
    // Turn 2: reasoning + shell + tool + response
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 2000,
      type: 'assistant_reasoning',
      content: 'Let me think...',
      iteration: 0
    });
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 2100,
      type: 'tool_call',
      toolCallId: 'sh-1',
      toolName: 'shell',
      arguments: { command: 'cat file.ts' }
    });
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 2200,
      type: 'tool_result',
      toolCallId: 'sh-1',
      result: 'const x = 1;',
      success: true
    });
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 2300,
      type: 'tool_call',
      toolCallId: 'tc-1',
      toolName: 'code_edit',
      arguments: { detail: 'editing file' }
    });
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 2400,
      type: 'tool_result',
      toolCallId: 'tc-1',
      result: 'Applied',
      success: true
    });
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 3000,
      type: 'assistant_message',
      content: 'I fixed the code.',
      model: 'deepseek-reasoner',
      finishReason: 'stop'
    });
    // Turn 3: user follow-up
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 4000,
      type: 'user_message',
      content: 'Thanks!'
    });
    // Turn 4: simple response
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 5000,
      type: 'assistant_message',
      content: 'You are welcome.',
      model: 'deepseek-chat',
      finishReason: 'stop'
    });

    const turns = await callRichHistory(SESSION_ID);
    expect(turns).toHaveLength(4);

    // Turn 1: user
    expect(turns[0].role).toBe('user');
    expect(turns[0].content).toBe('Analyze this code');

    // Turn 2: assistant with reasoning + shell + tool
    expect(turns[1].role).toBe('assistant');
    expect(turns[1].content).toBe('I fixed the code.');
    expect(turns[1].model).toBe('deepseek-reasoner');
    expect(turns[1].reasoning_iterations).toEqual(['Let me think...']);
    expect(turns[1].shellResults).toHaveLength(1);
    expect(turns[1].shellResults![0].command).toBe('cat file.ts');
    expect(turns[1].toolCalls).toHaveLength(1);
    expect(turns[1].toolCalls![0].name).toBe('code_edit');

    // Turn 3: user follow-up
    expect(turns[2].role).toBe('user');
    expect(turns[2].content).toBe('Thanks!');

    // Turn 4: simple assistant
    expect(turns[3].role).toBe('assistant');
    expect(turns[3].content).toBe('You are welcome.');
    expect(turns[3].model).toBe('deepseek-chat');
    expect(turns[3].reasoning_iterations).toBeUndefined();
    expect(turns[3].toolCalls).toBeUndefined();
    expect(turns[3].shellResults).toBeUndefined();
  });

  it('handles partial/interrupted assistant turn (no assistant_message event)', async () => {
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 1000,
      type: 'user_message',
      content: 'Hello'
    });
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 2000,
      type: 'assistant_reasoning',
      content: 'Thinking about this...',
      iteration: 0
    });
    // No assistant_message — generation was interrupted

    const turns = await callRichHistory(SESSION_ID);
    expect(turns).toHaveLength(2);

    // The trailing assistant turn should still be included
    expect(turns[1].role).toBe('assistant');
    expect(turns[1].content).toBe('');
    expect(turns[1].reasoning_iterations).toEqual(['Thinking about this...']);
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

  it('extracts _file_modified tool calls into filesModified', async () => {
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 1000,
      type: 'user_message',
      content: 'Edit the file'
    });
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 2000,
      type: 'tool_call',
      toolCallId: 'tc-1',
      toolName: 'apply_code_edit',
      arguments: { detail: 'editing' }
    });
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 2100,
      type: 'tool_result',
      toolCallId: 'tc-1',
      result: 'Applied',
      success: true
    });
    // _file_modified marker — should go into filesModified, NOT toolCalls
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 2200,
      type: 'tool_call',
      toolCallId: 'fm-1',
      toolName: '_file_modified',
      arguments: { filePath: 'src/index.ts' }
    });
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 2300,
      type: 'tool_result',
      toolCallId: 'fm-1',
      result: 'src/index.ts',
      success: true
    });
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 3000,
      type: 'assistant_message',
      content: 'Done.',
      model: 'deepseek-chat',
      finishReason: 'stop'
    });

    const turns = await callRichHistory(SESSION_ID);
    const assistantTurn = turns[1];
    expect(assistantTurn.toolCalls).toHaveLength(1);
    expect(assistantTurn.toolCalls![0].name).toBe('apply_code_edit');
    expect(assistantTurn.filesModified).toEqual(['src/index.ts']);
  });

  it('extracts multiple _file_modified markers', async () => {
    eventStore.append({ sessionId: SESSION_ID, timestamp: 1000, type: 'user_message', content: 'Edit files' });
    eventStore.append({ sessionId: SESSION_ID, timestamp: 2000, type: 'tool_call', toolCallId: 'fm-1', toolName: '_file_modified', arguments: { filePath: 'a.ts' } });
    eventStore.append({ sessionId: SESSION_ID, timestamp: 2100, type: 'tool_result', toolCallId: 'fm-1', result: 'a.ts', success: true });
    eventStore.append({ sessionId: SESSION_ID, timestamp: 2200, type: 'tool_call', toolCallId: 'fm-2', toolName: '_file_modified', arguments: { filePath: 'b.ts' } });
    eventStore.append({ sessionId: SESSION_ID, timestamp: 2300, type: 'tool_result', toolCallId: 'fm-2', result: 'b.ts', success: true });
    eventStore.append({ sessionId: SESSION_ID, timestamp: 3000, type: 'assistant_message', content: 'Done.', model: 'deepseek-chat', finishReason: 'stop' });

    const turns = await callRichHistory(SESSION_ID);
    const assistantTurn = turns[1];
    expect(assistantTurn.filesModified).toEqual(['a.ts', 'b.ts']);
    expect(assistantTurn.toolCalls).toBeUndefined(); // No non-file tool calls
  });

  it('preserves contentIterations from assistant_message event', async () => {
    eventStore.append({ sessionId: SESSION_ID, timestamp: 1000, type: 'user_message', content: 'Add animals' });
    eventStore.append({ sessionId: SESSION_ID, timestamp: 2000, type: 'assistant_reasoning', content: 'Thinking iteration 1...', iteration: 0 });
    eventStore.append({ sessionId: SESSION_ID, timestamp: 2100, type: 'tool_call', toolCallId: 'sh-1', toolName: 'shell', arguments: { command: 'cat test.txt' } });
    eventStore.append({ sessionId: SESSION_ID, timestamp: 2200, type: 'tool_result', toolCallId: 'sh-1', result: 'file contents', success: true });
    eventStore.append({ sessionId: SESSION_ID, timestamp: 2300, type: 'assistant_reasoning', content: 'Thinking iteration 2...', iteration: 1 });
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 3000,
      type: 'assistant_message',
      content: 'Full accumulated text',
      model: 'deepseek-reasoner',
      finishReason: 'stop',
      contentIterations: ['Check the file first', 'Here are the results with changes']
    });

    const turns = await callRichHistory(SESSION_ID);
    const assistantTurn = turns[1];
    expect(assistantTurn.contentIterations).toEqual([
      'Check the file first',
      'Here are the results with changes'
    ]);
    expect(assistantTurn.reasoning_iterations).toHaveLength(2);
    expect(assistantTurn.shellResults).toHaveLength(1);
    expect(assistantTurn.content).toBe('Full accumulated text');
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

  it('handles full Reasoner conversation: reasoning + shell + files + contentIterations', async () => {
    // User
    eventStore.append({ sessionId: SESSION_ID, timestamp: 1000, type: 'user_message', content: 'Edit animals list' });

    // Iteration 1: reasoning → shell
    eventStore.append({ sessionId: SESSION_ID, timestamp: 2000, type: 'assistant_reasoning', content: 'Let me read the file first', iteration: 0 });
    eventStore.append({ sessionId: SESSION_ID, timestamp: 2100, type: 'tool_call', toolCallId: 'sh-1', toolName: 'shell', arguments: { command: 'cat test.txt' } });
    eventStore.append({ sessionId: SESSION_ID, timestamp: 2200, type: 'tool_result', toolCallId: 'sh-1', result: 'lion\ntiger\nelephant', success: true });

    // Iteration 2: reasoning → file modification → content with code
    eventStore.append({ sessionId: SESSION_ID, timestamp: 3000, type: 'assistant_reasoning', content: 'Now I will add animals', iteration: 1 });
    eventStore.append({ sessionId: SESSION_ID, timestamp: 3100, type: 'tool_call', toolCallId: 'fm-1', toolName: '_file_modified', arguments: { filePath: 'test.txt' } });
    eventStore.append({ sessionId: SESSION_ID, timestamp: 3200, type: 'tool_result', toolCallId: 'fm-1', result: 'test.txt', success: true });

    // Final assistant message
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 4000,
      type: 'assistant_message',
      content: 'I added 10 new animals to the list.',
      model: 'deepseek-reasoner',
      finishReason: 'stop',
      contentIterations: ['Let me check the file', 'I added 10 new animals to the list.']
    });

    const turns = await callRichHistory(SESSION_ID);
    expect(turns).toHaveLength(2);

    const user = turns[0];
    expect(user.role).toBe('user');
    expect(user.content).toBe('Edit animals list');

    const assistant = turns[1];
    expect(assistant.role).toBe('assistant');
    expect(assistant.model).toBe('deepseek-reasoner');
    expect(assistant.reasoning_iterations).toEqual([
      'Let me read the file first',
      'Now I will add animals'
    ]);
    expect(assistant.shellResults).toEqual([
      { command: 'cat test.txt', output: 'lion\ntiger\nelephant', success: true }
    ]);
    expect(assistant.filesModified).toEqual(['test.txt']);
    expect(assistant.contentIterations).toEqual([
      'Let me check the file',
      'I added 10 new animals to the list.'
    ]);
    expect(assistant.content).toBe('I added 10 new animals to the list.');
    expect(assistant.toolCalls).toBeUndefined(); // Only shell and _file_modified, no regular tools
  });

  it('handles full Chat conversation: tools + files + content (no reasoning)', async () => {
    eventStore.append({ sessionId: SESSION_ID, timestamp: 1000, type: 'user_message', content: 'Fix the code' });

    // Tool calls
    eventStore.append({ sessionId: SESSION_ID, timestamp: 2000, type: 'tool_call', toolCallId: 'tc-1', toolName: 'read_file', arguments: { detail: 'src/app.ts' } });
    eventStore.append({ sessionId: SESSION_ID, timestamp: 2100, type: 'tool_result', toolCallId: 'tc-1', result: 'const x = 1;', success: true });
    eventStore.append({ sessionId: SESSION_ID, timestamp: 2200, type: 'tool_call', toolCallId: 'tc-2', toolName: 'apply_code_edit', arguments: { detail: 'fixing bug' } });
    eventStore.append({ sessionId: SESSION_ID, timestamp: 2300, type: 'tool_result', toolCallId: 'tc-2', result: 'Applied', success: true });

    // File modification marker
    eventStore.append({ sessionId: SESSION_ID, timestamp: 2400, type: 'tool_call', toolCallId: 'fm-1', toolName: '_file_modified', arguments: { filePath: 'src/app.ts' } });
    eventStore.append({ sessionId: SESSION_ID, timestamp: 2500, type: 'tool_result', toolCallId: 'fm-1', result: 'src/app.ts', success: true });

    // Assistant message
    eventStore.append({
      sessionId: SESSION_ID,
      timestamp: 3000,
      type: 'assistant_message',
      content: 'Fixed the bug in app.ts.',
      model: 'deepseek-chat',
      finishReason: 'stop'
    });

    const turns = await callRichHistory(SESSION_ID);
    expect(turns).toHaveLength(2);

    const assistant = turns[1];
    expect(assistant.model).toBe('deepseek-chat');
    expect(assistant.toolCalls).toEqual([
      { name: 'read_file', detail: 'src/app.ts', status: 'done' },
      { name: 'apply_code_edit', detail: 'fixing bug', status: 'done' }
    ]);
    expect(assistant.filesModified).toEqual(['src/app.ts']);
    expect(assistant.content).toBe('Fixed the bug in app.ts.');
    expect(assistant.reasoning_iterations).toBeUndefined();
    expect(assistant.shellResults).toBeUndefined();
    expect(assistant.contentIterations).toBeUndefined();
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
      currentSessionId: SESSION_ID,
      eventStore,
      snapshotManager,
      onSessionsChanged: { fire: () => {} },
      ensureCurrentSession: () => ({
        id: SESSION_ID, title: 'Test', model: 'deepseek-chat',
        createdAt: new Date(), updatedAt: new Date(), eventCount: 0, tags: []
      }),
      updateSessionMetadata: () => {},
    };

    // Add more than snapshotInterval events (3) via recordAssistantMessage
    for (let i = 0; i < 10; i++) {
      await recordAssistantMessage.call(mockCm, `Response ${i}`, 'deepseek-chat', 'stop');
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
// Instance-scoped session key (hybrid approach)
// ==========================================================================

const loadCurrentSession = (ConversationManager.prototype as any).loadCurrentSession;
const saveCurrentSession = (ConversationManager.prototype as any).saveCurrentSession;

describe('ConversationManager instance-scoped session key', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.prepare('INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('session-1', 'Test', 'test', 1000, 1000);
    db.prepare('INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('session-2', 'Test 2', 'test', 2000, 2000);
  });

  afterEach(() => {
    db.close();
  });

  function createMockCm(globalStateStore: Record<string, any>) {
    const stmtGetSession = db.prepare('SELECT * FROM sessions WHERE id = ?');
    return {
      instanceId: 'test-instance-abc',
      currentSessionId: null as string | null,
      context: {
        globalState: {
          get: (key: string) => globalStateStore[key],
          update: async (key: string, value: any) => { globalStateStore[key] = value; },
        },
      },
      getSessionSync: (id: string) => stmtGetSession.get(id),
    };
  }

  it('loadCurrentSession falls back to shared key on cold start', () => {
    const store: Record<string, any> = { currentSessionId: 'session-1' };
    const mockCm = createMockCm(store);

    loadCurrentSession.call(mockCm);

    expect(mockCm.currentSessionId).toBe('session-1');
  });

  it('loadCurrentSession prefers instance-scoped key over shared key', () => {
    const store: Record<string, any> = {
      'currentSessionId': 'session-1',
      'currentSessionId-test-instance-abc': 'session-2',
    };
    const mockCm = createMockCm(store);

    loadCurrentSession.call(mockCm);

    expect(mockCm.currentSessionId).toBe('session-2');
  });

  it('loadCurrentSession ignores instance-scoped key if session does not exist', () => {
    const store: Record<string, any> = {
      'currentSessionId': 'session-1',
      'currentSessionId-test-instance-abc': 'nonexistent-session',
    };
    const mockCm = createMockCm(store);

    loadCurrentSession.call(mockCm);

    // Falls back to shared key since instance-scoped session doesn't exist
    expect(mockCm.currentSessionId).toBe('session-1');
  });

  it('saveCurrentSession writes to both instance-scoped and shared keys', async () => {
    const store: Record<string, any> = {};
    const mockCm = createMockCm(store);
    mockCm.currentSessionId = 'session-2';

    await saveCurrentSession.call(mockCm);

    expect(store['currentSessionId-test-instance-abc']).toBe('session-2');
    expect(store['currentSessionId']).toBe('session-2');
  });

  it('two instances do not overwrite each other during runtime', async () => {
    const store: Record<string, any> = { currentSessionId: 'session-1' };

    // Instance A loads
    const instanceA = createMockCm(store);
    instanceA.instanceId = 'instance-A';
    loadCurrentSession.call(instanceA);
    expect(instanceA.currentSessionId).toBe('session-1');

    // Instance A switches to session-2
    instanceA.currentSessionId = 'session-2';
    await saveCurrentSession.call(instanceA);

    // Instance B starts, loads from shared key (last written by A)
    const instanceB = createMockCm(store);
    instanceB.instanceId = 'instance-B';
    loadCurrentSession.call(instanceB);
    expect(instanceB.currentSessionId).toBe('session-2');

    // Instance B switches to session-1
    instanceB.currentSessionId = 'session-1';
    await saveCurrentSession.call(instanceB);

    // Instance A's scoped key is untouched
    expect(store['currentSessionId-instance-A']).toBe('session-2');
    // Instance B's scoped key has its own value
    expect(store['currentSessionId-instance-B']).toBe('session-1');
    // Shared key reflects last writer (B)
    expect(store['currentSessionId']).toBe('session-1');
  });
});
