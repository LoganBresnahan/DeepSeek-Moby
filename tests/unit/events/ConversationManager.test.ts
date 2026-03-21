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
