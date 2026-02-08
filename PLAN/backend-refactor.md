# Backend Refactor: Event Sourcing + Snapshots

## Overview

This document outlines the plan to refactor the backend state management from the current message-based storage to an Event Sourcing architecture with Snapshot optimization. This will enable:

1. **Complete conversation replay** - Reconstruct any point in conversation history
2. **LLM context management** - Intelligent summarization for long conversations
3. **Rich metadata preservation** - Tool calls, file reads, diffs, reasoning traces
4. **Efficient storage** - SQLite with periodic snapshots

---

## 1. Architecture Design

### Current Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    ChatHistoryManager                        │
│                                                              │
│  sessions: ChatSession[] ──► globalState (JSON blob)        │
│                                                              │
│  Each session stores:                                        │
│  - id, title, model, language, filePath, tags               │
│  - messages: { role, content, timestamp }[]                 │
│                                                              │
│  Problems:                                                   │
│  - Full serialization on every save                         │
│  - Loses tool calls, file reads, diffs                      │
│  - No way to summarize or compress                          │
│  - Context window fills up on long conversations            │
└─────────────────────────────────────────────────────────────┘
```

### Proposed Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         ConversationManager                              │
│                      (Replaces ChatHistoryManager)                       │
│                                                                          │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────┐  │
│  │   EventStore    │    │ SnapshotManager │    │  ContextBuilder     │  │
│  │                 │    │                 │    │                     │  │
│  │ append(event)   │    │ create(sessId)  │    │ buildForLLM(sessId) │  │
│  │ getEvents(sess) │    │ getLatest(sess) │    │ • Recent events     │  │
│  │ replay(from,to) │    │ pruneOld(sess)  │    │ • Snapshot summary  │  │
│  └────────┬────────┘    └────────┬────────┘    │ • Token budget      │  │
│           │                      │              └─────────────────────┘  │
│           └──────────┬───────────┘                                       │
│                      ▼                                                   │
│           ┌─────────────────────┐                                        │
│           │   SQLite Database   │                                        │
│           │                     │                                        │
│           │  events             │                                        │
│           │  snapshots          │                                        │
│           │  sessions           │                                        │
│           └─────────────────────┘                                        │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Event Types

Events are immutable facts about what happened. Each event captures a single atomic action.

```typescript
// src/events/EventTypes.ts

export type ConversationEvent =
  | UserMessageEvent
  | AssistantMessageEvent
  | AssistantReasoningEvent
  | ToolCallEvent
  | ToolResultEvent
  | FileReadEvent
  | FileWriteEvent
  | DiffCreatedEvent
  | DiffAcceptedEvent
  | DiffRejectedEvent
  | WebSearchEvent
  | SessionCreatedEvent
  | SessionRenamedEvent
  | ModelChangedEvent
  | ContextImportedEvent      // New: snapshot import
  | ContextImportedEventEvent // New: cherry-picked events
  | ErrorEvent;

// Base interface for all events
interface BaseEvent {
  id: string;           // UUID
  sessionId: string;    // Which conversation
  timestamp: number;    // Unix ms
  sequence: number;     // Order within session (auto-increment)
}

// User sends a message
interface UserMessageEvent extends BaseEvent {
  type: 'user_message';
  content: string;
  attachments?: Attachment[];
}

// Assistant streams a response
interface AssistantMessageEvent extends BaseEvent {
  type: 'assistant_message';
  content: string;
  model: string;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
  usage?: { promptTokens: number; completionTokens: number };
}

// Reasoning trace (R1 model)
interface AssistantReasoningEvent extends BaseEvent {
  type: 'assistant_reasoning';
  content: string;
  iteration: number;
}

// Tool invocation request
interface ToolCallEvent extends BaseEvent {
  type: 'tool_call';
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

// Tool execution result
interface ToolResultEvent extends BaseEvent {
  type: 'tool_result';
  toolCallId: string;
  result: string;
  success: boolean;
  duration?: number;
}

// File read operation
interface FileReadEvent extends BaseEvent {
  type: 'file_read';
  filePath: string;
  contentHash: string;  // SHA-256, not full content
  lineCount: number;
}

// File write/modification
interface FileWriteEvent extends BaseEvent {
  type: 'file_write';
  filePath: string;
  diffId: string;
  changeType: 'create' | 'modify' | 'delete';
  linesAdded: number;
  linesRemoved: number;
}

// Diff lifecycle
interface DiffCreatedEvent extends BaseEvent {
  type: 'diff_created';
  diffId: string;
  filePath: string;
  originalContent: string;
  newContent: string;
}

interface DiffAcceptedEvent extends BaseEvent {
  type: 'diff_accepted';
  diffId: string;
}

interface DiffRejectedEvent extends BaseEvent {
  type: 'diff_rejected';
  diffId: string;
}

// Web search
interface WebSearchEvent extends BaseEvent {
  type: 'web_search';
  query: string;
  resultCount: number;
  resultsPreview: string[];  // First 3 titles
}

// Session metadata
interface SessionCreatedEvent extends BaseEvent {
  type: 'session_created';
  title: string;
  model: string;
}

interface SessionRenamedEvent extends BaseEvent {
  type: 'session_renamed';
  oldTitle: string;
  newTitle: string;
}

interface ModelChangedEvent extends BaseEvent {
  type: 'model_changed';
  oldModel: string;
  newModel: string;
}

// Error tracking
interface ErrorEvent extends BaseEvent {
  type: 'error';
  errorType: 'api' | 'tool' | 'parse' | 'network';
  message: string;
  recoverable: boolean;
}
```

---

## 3. SQLite Schema

Using `better-sqlite3` for synchronous operations in Node.js.

```sql
-- src/storage/schema.sql

-- Main events table (append-only)
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,  -- JSON blob

  UNIQUE(session_id, sequence)
);

CREATE INDEX idx_events_session ON events(session_id, sequence);
CREATE INDEX idx_events_type ON events(session_id, type);

-- Snapshots for efficient replay
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  up_to_sequence INTEGER NOT NULL,  -- Events included up to this sequence
  timestamp INTEGER NOT NULL,
  summary TEXT NOT NULL,             -- LLM-generated summary
  key_facts TEXT NOT NULL,           -- JSON array of extracted facts
  files_modified TEXT NOT NULL,      -- JSON array of file paths
  token_count INTEGER NOT NULL,      -- Tokens in summary

  UNIQUE(session_id, up_to_sequence)
);

CREATE INDEX idx_snapshots_session ON snapshots(session_id, up_to_sequence DESC);

-- Session metadata (denormalized for quick listing)
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  event_count INTEGER DEFAULT 0,
  last_snapshot_sequence INTEGER DEFAULT 0,
  tags TEXT DEFAULT '[]',  -- JSON array

  -- Cached for quick display
  first_user_message TEXT,
  last_activity_preview TEXT
);

CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);

-- Migrations tracking
CREATE TABLE migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
```

---

## 4. Core Classes

### 4.1 EventStore

```typescript
// src/events/EventStore.ts

import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { ConversationEvent } from './EventTypes';

export class EventStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');  // Better concurrent access
    this.initSchema();
  }

  private initSchema(): void {
    // Run migrations...
  }

  /**
   * Append a new event. Returns the assigned sequence number.
   */
  append(event: Omit<ConversationEvent, 'id' | 'sequence'>): ConversationEvent {
    const id = uuidv4();

    // Get next sequence for this session
    const seqResult = this.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 as next_seq
      FROM events WHERE session_id = ?
    `).get(event.sessionId) as { next_seq: number };

    const sequence = seqResult.next_seq;

    const fullEvent = { ...event, id, sequence } as ConversationEvent;

    this.db.prepare(`
      INSERT INTO events (id, session_id, sequence, timestamp, type, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      event.sessionId,
      sequence,
      event.timestamp,
      event.type,
      JSON.stringify(fullEvent)
    );

    // Update session metadata
    this.db.prepare(`
      UPDATE sessions
      SET updated_at = ?, event_count = event_count + 1,
          last_activity_preview = ?
      WHERE id = ?
    `).run(
      event.timestamp,
      this.getActivityPreview(fullEvent),
      event.sessionId
    );

    return fullEvent;
  }

  /**
   * Get events for a session, optionally from a sequence number.
   */
  getEvents(sessionId: string, fromSequence: number = 0): ConversationEvent[] {
    const rows = this.db.prepare(`
      SELECT data FROM events
      WHERE session_id = ? AND sequence > ?
      ORDER BY sequence ASC
    `).all(sessionId, fromSequence) as { data: string }[];

    return rows.map(row => JSON.parse(row.data));
  }

  /**
   * Get events of specific types (for targeted replay).
   */
  getEventsByType(
    sessionId: string,
    types: ConversationEvent['type'][],
    fromSequence: number = 0
  ): ConversationEvent[] {
    const placeholders = types.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT data FROM events
      WHERE session_id = ? AND sequence > ? AND type IN (${placeholders})
      ORDER BY sequence ASC
    `).all(sessionId, fromSequence, ...types) as { data: string }[];

    return rows.map(row => JSON.parse(row.data));
  }

  /**
   * Get the latest sequence number for a session.
   */
  getLatestSequence(sessionId: string): number {
    const result = this.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) as seq FROM events WHERE session_id = ?
    `).get(sessionId) as { seq: number };
    return result.seq;
  }

  private getActivityPreview(event: ConversationEvent): string {
    switch (event.type) {
      case 'user_message':
        return event.content.substring(0, 100);
      case 'assistant_message':
        return event.content.substring(0, 100);
      case 'tool_call':
        return `Tool: ${event.toolName}`;
      default:
        return event.type;
    }
  }
}
```

### 4.2 SnapshotManager

```typescript
// src/events/SnapshotManager.ts

import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { EventStore } from './EventStore';
import { ConversationEvent } from './EventTypes';

interface Snapshot {
  id: string;
  sessionId: string;
  upToSequence: number;
  timestamp: number;
  summary: string;
  keyFacts: string[];
  filesModified: string[];
  tokenCount: number;
}

export class SnapshotManager {
  private db: Database.Database;
  private eventStore: EventStore;
  private summarizer: (events: ConversationEvent[]) => Promise<SnapshotContent>;

  // Configuration
  private readonly SNAPSHOT_INTERVAL = 20;      // Create snapshot every N events
  private readonly MAX_SNAPSHOTS_PER_SESSION = 5;

  constructor(
    db: Database.Database,
    eventStore: EventStore,
    summarizer: (events: ConversationEvent[]) => Promise<SnapshotContent>
  ) {
    this.db = db;
    this.eventStore = eventStore;
    this.summarizer = summarizer;
  }

  /**
   * Check if a snapshot should be created and create it if needed.
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
   * Force create a snapshot at current point.
   */
  async createSnapshot(sessionId: string): Promise<Snapshot> {
    const lastSnapshot = this.getLatestSnapshot(sessionId);
    const fromSeq = lastSnapshot?.upToSequence ?? 0;
    const latestSeq = this.eventStore.getLatestSequence(sessionId);

    // Get events since last snapshot
    const events = this.eventStore.getEvents(sessionId, fromSeq);

    // Generate summary using LLM
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

    this.db.prepare(`
      INSERT INTO snapshots (id, session_id, up_to_sequence, timestamp,
                            summary, key_facts, files_modified, token_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.id,
      snapshot.sessionId,
      snapshot.upToSequence,
      snapshot.timestamp,
      snapshot.summary,
      JSON.stringify(snapshot.keyFacts),
      JSON.stringify(snapshot.filesModified),
      snapshot.tokenCount
    );

    // Update session metadata
    this.db.prepare(`
      UPDATE sessions SET last_snapshot_sequence = ? WHERE id = ?
    `).run(latestSeq, sessionId);

    // Prune old snapshots
    this.pruneSnapshots(sessionId);

    return snapshot;
  }

  /**
   * Get the most recent snapshot for a session.
   */
  getLatestSnapshot(sessionId: string): Snapshot | null {
    const row = this.db.prepare(`
      SELECT * FROM snapshots
      WHERE session_id = ?
      ORDER BY up_to_sequence DESC
      LIMIT 1
    `).get(sessionId) as any;

    if (!row) return null;

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

  /**
   * Keep only the most recent snapshots per session.
   */
  private pruneSnapshots(sessionId: string): void {
    this.db.prepare(`
      DELETE FROM snapshots
      WHERE session_id = ?
      AND id NOT IN (
        SELECT id FROM snapshots
        WHERE session_id = ?
        ORDER BY up_to_sequence DESC
        LIMIT ?
      )
    `).run(sessionId, sessionId, this.MAX_SNAPSHOTS_PER_SESSION);
  }
}

interface SnapshotContent {
  summary: string;
  keyFacts: string[];
  filesModified: string[];
  tokenCount: number;
}
```

### 4.3 ContextBuilder

```typescript
// src/events/ContextBuilder.ts

import { EventStore } from './EventStore';
import { SnapshotManager } from './SnapshotManager';
import { ConversationEvent } from './EventTypes';

interface LLMContext {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }>;
  tokenEstimate: number;
}

export class ContextBuilder {
  private eventStore: EventStore;
  private snapshotManager: SnapshotManager;

  // Configuration
  private readonly MAX_CONTEXT_TOKENS = 16000;  // Leave room for response
  private readonly RECENT_EVENTS_PRIORITY = 10; // Always include last N events

  constructor(eventStore: EventStore, snapshotManager: SnapshotManager) {
    this.eventStore = eventStore;
    this.snapshotManager = snapshotManager;
  }

  /**
   * Build optimal context for LLM given token budget.
   */
  buildForLLM(sessionId: string, tokenBudget?: number): LLMContext {
    const budget = tokenBudget ?? this.MAX_CONTEXT_TOKENS;
    const snapshot = this.snapshotManager.getLatestSnapshot(sessionId);

    let usedTokens = 0;
    const messages: LLMContext['messages'] = [];

    // 1. Start with snapshot summary if available
    if (snapshot) {
      const summaryMessage = this.formatSnapshotAsContext(snapshot);
      usedTokens += snapshot.tokenCount;
      messages.push({
        role: 'user',
        content: `[Previous conversation summary]\n${summaryMessage}`
      });
      messages.push({
        role: 'assistant',
        content: 'I understand the context. Let me continue helping you.'
      });
    }

    // 2. Get events after snapshot
    const fromSeq = snapshot?.upToSequence ?? 0;
    const recentEvents = this.eventStore.getEvents(sessionId, fromSeq);

    // 3. Convert events to messages, respecting token budget
    const eventMessages = this.eventsToMessages(recentEvents, budget - usedTokens);
    messages.push(...eventMessages.messages);
    usedTokens += eventMessages.tokenCount;

    return {
      systemPrompt: this.buildSystemPrompt(snapshot),
      messages,
      tokenEstimate: usedTokens
    };
  }

  private formatSnapshotAsContext(snapshot: any): string {
    let context = snapshot.summary + '\n\n';

    if (snapshot.keyFacts.length > 0) {
      context += 'Key facts established:\n';
      context += snapshot.keyFacts.map((f: string) => `- ${f}`).join('\n');
      context += '\n\n';
    }

    if (snapshot.filesModified.length > 0) {
      context += 'Files modified in this session:\n';
      context += snapshot.filesModified.map((f: string) => `- ${f}`).join('\n');
    }

    return context;
  }

  private eventsToMessages(
    events: ConversationEvent[],
    tokenBudget: number
  ): { messages: LLMContext['messages']; tokenCount: number } {
    const messages: LLMContext['messages'] = [];
    let tokenCount = 0;

    // Process events in order, but prioritize recent ones
    for (const event of events) {
      const msg = this.eventToMessage(event);
      if (!msg) continue;

      const msgTokens = this.estimateTokens(msg.content);

      // Stop if we'd exceed budget (but always include user messages)
      if (tokenCount + msgTokens > tokenBudget && event.type !== 'user_message') {
        continue;
      }

      messages.push(msg);
      tokenCount += msgTokens;
    }

    return { messages, tokenCount };
  }

  private eventToMessage(event: ConversationEvent): LLMContext['messages'][0] | null {
    switch (event.type) {
      case 'user_message':
        return { role: 'user', content: event.content };

      case 'assistant_message':
        return { role: 'assistant', content: event.content };

      case 'tool_result':
        return {
          role: 'tool',
          content: `[Tool ${event.toolCallId}]: ${event.result.substring(0, 1000)}`
        };

      // Skip events that don't need to be in LLM context
      case 'assistant_reasoning':
      case 'file_read':
      case 'diff_created':
      case 'diff_accepted':
      case 'diff_rejected':
      case 'session_created':
      case 'session_renamed':
        return null;

      default:
        return null;
    }
  }

  private buildSystemPrompt(snapshot: any | null): string {
    let prompt = `You are DeepSeek Moby, an AI coding assistant in VS Code.\n\n`;

    if (snapshot && snapshot.filesModified.length > 0) {
      prompt += `Files you've modified in this conversation:\n`;
      prompt += snapshot.filesModified.map((f: string) => `- ${f}`).join('\n');
      prompt += '\n\n';
    }

    return prompt;
  }

  private estimateTokens(text: string): number {
    // Rough estimate: ~4 chars per token
    return Math.ceil(text.length / 4);
  }
}
```

### 4.4 ConversationManager (Main Interface)

```typescript
// src/events/ConversationManager.ts

import Database from 'better-sqlite3';
import * as path from 'path';
import * as vscode from 'vscode';
import { EventStore } from './EventStore';
import { SnapshotManager } from './SnapshotManager';
import { ContextBuilder } from './ContextBuilder';
import { ConversationEvent } from './EventTypes';
import { v4 as uuidv4 } from 'uuid';

export interface Session {
  id: string;
  title: string;
  model: string;
  createdAt: Date;
  updatedAt: Date;
  eventCount: number;
  tags: string[];
  firstUserMessage?: string;
  lastActivityPreview?: string;
}

export class ConversationManager {
  private db: Database.Database;
  private eventStore: EventStore;
  private snapshotManager: SnapshotManager;
  private contextBuilder: ContextBuilder;

  private currentSessionId: string | null = null;
  private onSessionsChanged: vscode.EventEmitter<void>;
  public readonly onSessionsChangedEvent: vscode.Event<void>;

  constructor(context: vscode.ExtensionContext) {
    // Database path in extension storage
    const dbPath = path.join(context.globalStorageUri.fsPath, 'conversations.db');

    // Ensure directory exists
    const fs = require('fs');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');

    this.eventStore = new EventStore(this.db);
    this.snapshotManager = new SnapshotManager(
      this.db,
      this.eventStore,
      this.generateSummary.bind(this)
    );
    this.contextBuilder = new ContextBuilder(this.eventStore, this.snapshotManager);

    this.onSessionsChanged = new vscode.EventEmitter<void>();
    this.onSessionsChangedEvent = this.onSessionsChanged.event;

    this.initSchema();
    this.loadCurrentSession(context);
  }

  // --- Session Management ---

  async createSession(title?: string, model: string = 'deepseek-chat'): Promise<Session> {
    const id = uuidv4();
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO sessions (id, title, model, created_at, updated_at, event_count, tags)
      VALUES (?, ?, ?, ?, ?, 0, '[]')
    `).run(id, title || 'New Chat', model, now, now);

    // Emit session created event
    this.eventStore.append({
      sessionId: id,
      timestamp: now,
      type: 'session_created',
      title: title || 'New Chat',
      model
    });

    this.currentSessionId = id;
    this.onSessionsChanged.fire();

    return this.getSession(id)!;
  }

  getSession(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
    if (!row) return null;

    return {
      id: row.id,
      title: row.title,
      model: row.model,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      eventCount: row.event_count,
      tags: JSON.parse(row.tags),
      firstUserMessage: row.first_user_message,
      lastActivityPreview: row.last_activity_preview
    };
  }

  getCurrentSession(): Session | null {
    if (!this.currentSessionId) return null;
    return this.getSession(this.currentSessionId);
  }

  getAllSessions(): Session[] {
    const rows = this.db.prepare(`
      SELECT * FROM sessions ORDER BY updated_at DESC
    `).all() as any[];

    return rows.map(row => ({
      id: row.id,
      title: row.title,
      model: row.model,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      eventCount: row.event_count,
      tags: JSON.parse(row.tags),
      firstUserMessage: row.first_user_message,
      lastActivityPreview: row.last_activity_preview
    }));
  }

  switchToSession(sessionId: string): void {
    if (this.getSession(sessionId)) {
      this.currentSessionId = sessionId;
      this.onSessionsChanged.fire();
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.db.prepare('DELETE FROM events WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM snapshots WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);

    if (this.currentSessionId === sessionId) {
      this.currentSessionId = null;
    }

    this.onSessionsChanged.fire();
  }

  // --- Event Recording ---

  recordUserMessage(content: string, attachments?: any[]): ConversationEvent {
    const session = this.ensureCurrentSession();

    const event = this.eventStore.append({
      sessionId: session.id,
      timestamp: Date.now(),
      type: 'user_message',
      content,
      attachments
    });

    // Update first user message if this is the first
    if (session.eventCount === 0) {
      this.db.prepare(`
        UPDATE sessions SET first_user_message = ?, title = ? WHERE id = ?
      `).run(
        content.substring(0, 100),
        content.substring(0, 50) + (content.length > 50 ? '...' : ''),
        session.id
      );
    }

    this.onSessionsChanged.fire();
    return event;
  }

  recordAssistantMessage(
    content: string,
    model: string,
    finishReason: 'stop' | 'tool_calls' | 'length' | 'error',
    usage?: { promptTokens: number; completionTokens: number }
  ): ConversationEvent {
    const session = this.ensureCurrentSession();

    const event = this.eventStore.append({
      sessionId: session.id,
      timestamp: Date.now(),
      type: 'assistant_message',
      content,
      model,
      finishReason,
      usage
    });

    // Check if we should create a snapshot
    this.snapshotManager.maybeCreateSnapshot(session.id);

    this.onSessionsChanged.fire();
    return event;
  }

  recordToolCall(toolCallId: string, toolName: string, args: Record<string, unknown>): ConversationEvent {
    const session = this.ensureCurrentSession();

    return this.eventStore.append({
      sessionId: session.id,
      timestamp: Date.now(),
      type: 'tool_call',
      toolCallId,
      toolName,
      arguments: args
    });
  }

  recordToolResult(toolCallId: string, result: string, success: boolean, duration?: number): ConversationEvent {
    const session = this.ensureCurrentSession();

    return this.eventStore.append({
      sessionId: session.id,
      timestamp: Date.now(),
      type: 'tool_result',
      toolCallId,
      result,
      success,
      duration
    });
  }

  recordFileRead(filePath: string, contentHash: string, lineCount: number): ConversationEvent {
    const session = this.ensureCurrentSession();

    return this.eventStore.append({
      sessionId: session.id,
      timestamp: Date.now(),
      type: 'file_read',
      filePath,
      contentHash,
      lineCount
    });
  }

  recordDiffCreated(diffId: string, filePath: string, originalContent: string, newContent: string): ConversationEvent {
    const session = this.ensureCurrentSession();

    return this.eventStore.append({
      sessionId: session.id,
      timestamp: Date.now(),
      type: 'diff_created',
      diffId,
      filePath,
      originalContent,
      newContent
    });
  }

  recordDiffAccepted(diffId: string): ConversationEvent {
    const session = this.ensureCurrentSession();

    return this.eventStore.append({
      sessionId: session.id,
      timestamp: Date.now(),
      type: 'diff_accepted',
      diffId
    });
  }

  recordDiffRejected(diffId: string): ConversationEvent {
    const session = this.ensureCurrentSession();

    return this.eventStore.append({
      sessionId: session.id,
      timestamp: Date.now(),
      type: 'diff_rejected',
      diffId
    });
  }

  // --- Context Building ---

  buildLLMContext(tokenBudget?: number) {
    const session = this.ensureCurrentSession();
    return this.contextBuilder.buildForLLM(session.id, tokenBudget);
  }

  // --- Compatibility Layer ---

  /**
   * Get messages in the old format for backward compatibility.
   */
  getMessagesCompat(): Array<{ role: 'user' | 'assistant'; content: string; timestamp: Date }> {
    const session = this.getCurrentSession();
    if (!session) return [];

    const events = this.eventStore.getEventsByType(
      session.id,
      ['user_message', 'assistant_message']
    );

    return events.map(e => ({
      role: e.type === 'user_message' ? 'user' : 'assistant',
      content: (e as any).content,
      timestamp: new Date(e.timestamp)
    }));
  }

  // --- Private Helpers ---

  private ensureCurrentSession(): Session {
    if (!this.currentSessionId) {
      // Auto-create a session
      const id = uuidv4();
      const now = Date.now();

      this.db.prepare(`
        INSERT INTO sessions (id, title, model, created_at, updated_at, event_count, tags)
        VALUES (?, ?, ?, ?, ?, 0, '[]')
      `).run(id, 'New Chat', 'deepseek-chat', now, now);

      this.currentSessionId = id;
    }

    return this.getSession(this.currentSessionId)!;
  }

  private async generateSummary(events: ConversationEvent[]): Promise<{
    summary: string;
    keyFacts: string[];
    filesModified: string[];
    tokenCount: number;
  }> {
    // TODO: Use LLM to generate summary
    // For now, create a simple extractive summary

    const userMessages = events.filter(e => e.type === 'user_message');
    const filesModified = [...new Set(
      events
        .filter(e => e.type === 'file_write' || e.type === 'diff_accepted')
        .map(e => (e as any).filePath || '')
        .filter(Boolean)
    )];

    const summary = userMessages
      .map(e => (e as any).content.substring(0, 100))
      .join('\n');

    const keyFacts = userMessages
      .slice(0, 3)
      .map(e => `User asked: ${(e as any).content.substring(0, 50)}...`);

    return {
      summary,
      keyFacts,
      filesModified,
      tokenCount: Math.ceil(summary.length / 4)
    };
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      );

      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(session_id, type);

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

      CREATE INDEX IF NOT EXISTS idx_snapshots_session ON snapshots(session_id, up_to_sequence DESC);

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

      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
    `);
  }

  private loadCurrentSession(context: vscode.ExtensionContext): void {
    const savedId = context.globalState.get<string>('currentSessionId');
    if (savedId && this.getSession(savedId)) {
      this.currentSessionId = savedId;
    }
  }
}
```

---

## 5. Conversation Forking / Context Seeding

Users can start new conversations with context from previous sessions. This leverages Event Sourcing to provide flexible context inheritance.

### Use Cases

1. **Continue where you left off** - Import snapshot summary from previous conversation
2. **Cherry-pick context** - Select specific events (decisions, code patterns) to bring forward
3. **Fresh start** - No context, standard behavior

### UI Flow (Future)

```
┌─────────────────────────────────────────────────────────────┐
│  Start New Conversation                                      │
│                                                              │
│  ○ Fresh start (no context)                                 │
│                                                              │
│  ○ Continue from previous conversation:                     │
│    ┌─────────────────────────────────────────────────────┐  │
│    │ > JWT Auth Implementation (2 hours ago)              │  │
│    │   "Implemented refresh tokens, modified auth.ts..."  │  │
│    │                                                       │  │
│    │   [Use Snapshot] [Pick Specific Events]              │  │
│    └─────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### New Event Types

```typescript
// When user imports a snapshot from another session
interface ContextImportedEvent extends BaseEvent {
  type: 'context_imported';
  sourceSessionId: string;
  sourceSnapshotId: string;
  summary: string;
  keyFacts: string[];
  filesModified: string[];
}

// When user cherry-picks specific events from another session
interface ContextImportedEventEvent extends BaseEvent {
  type: 'context_imported_event';
  originalEventId: string;
  originalSessionId: string;
  eventData: ConversationEvent;  // Copy of the original event
}
```

### ConversationManager Methods

```typescript
// Add to ConversationManager class

/**
 * Create a new session seeded with a snapshot from another session.
 * The snapshot summary becomes the initial context.
 */
async seedFromSnapshot(snapshotId: string, title?: string): Promise<Session> {
  const snapshot = this.getSnapshotById(snapshotId);
  if (!snapshot) throw new Error('Snapshot not found');

  const session = await this.createSession(title);

  // Record the context import
  this.eventStore.append({
    sessionId: session.id,
    timestamp: Date.now(),
    type: 'context_imported',
    sourceSessionId: snapshot.sessionId,
    sourceSnapshotId: snapshot.id,
    summary: snapshot.summary,
    keyFacts: snapshot.keyFacts,
    filesModified: snapshot.filesModified
  });

  return session;
}

/**
 * Create a new session seeded with specific events from another session.
 * Selected events are copied and replayed as context.
 */
async seedFromEvents(eventIds: string[], title?: string): Promise<Session> {
  const session = await this.createSession(title);

  for (const eventId of eventIds) {
    const originalEvent = this.eventStore.getEventById(eventId);
    if (!originalEvent) continue;

    this.eventStore.append({
      sessionId: session.id,
      timestamp: Date.now(),
      type: 'context_imported_event',
      originalEventId: eventId,
      originalSessionId: originalEvent.sessionId,
      eventData: originalEvent
    });
  }

  return session;
}

/**
 * Get all snapshots across all sessions (for UI picker).
 */
getAllSnapshots(): Array<Snapshot & { sessionTitle: string }> {
  const rows = this.db.prepare(`
    SELECT s.*, sess.title as session_title
    FROM snapshots s
    JOIN sessions sess ON s.session_id = sess.id
    ORDER BY s.timestamp DESC
  `).all();

  return rows.map(row => ({
    id: row.id,
    sessionId: row.session_id,
    sessionTitle: row.session_title,
    upToSequence: row.up_to_sequence,
    timestamp: row.timestamp,
    summary: row.summary,
    keyFacts: JSON.parse(row.key_facts),
    filesModified: JSON.parse(row.files_modified),
    tokenCount: row.token_count
  }));
}

/**
 * Get browsable events from a session (for cherry-picking UI).
 */
getBrowsableEvents(sessionId: string): ConversationEvent[] {
  // Return only user-facing events, not internal ones
  return this.eventStore.getEventsByType(sessionId, [
    'user_message',
    'assistant_message',
    'diff_accepted',
    'diff_rejected'
  ]);
}
```

### ContextBuilder Updates

```typescript
// Update buildForLLM to handle imported context

buildForLLM(sessionId: string, tokenBudget?: number): LLMContext {
  const budget = tokenBudget ?? this.MAX_CONTEXT_TOKENS;
  const events = this.eventStore.getEvents(sessionId);

  let usedTokens = 0;
  const messages: LLMContext['messages'] = [];

  // 1. Check for imported context at start of session
  const importedContext = events.find(e => e.type === 'context_imported');
  if (importedContext) {
    const contextMsg = this.formatImportedContext(importedContext);
    usedTokens += this.estimateTokens(contextMsg);
    messages.push({ role: 'user', content: contextMsg });
    messages.push({
      role: 'assistant',
      content: 'I understand the context from our previous conversation. How can I help you continue?'
    });
  }

  // 2. Check for cherry-picked events
  const importedEvents = events.filter(e => e.type === 'context_imported_event');
  if (importedEvents.length > 0) {
    const eventsContext = this.formatImportedEvents(importedEvents);
    usedTokens += this.estimateTokens(eventsContext);
    messages.push({ role: 'user', content: eventsContext });
    messages.push({
      role: 'assistant',
      content: 'I see the relevant context you\'ve shared. Let me continue from there.'
    });
  }

  // 3. Then handle this session's own snapshot + recent events
  // ... rest of existing logic
}
```

---

## 6. Implementation Approach (Clean Slate)

Since backwards compatibility is not required, we take a direct replacement approach:

### Step 1: Delete Old System
- Remove `src/chatHistory/ChatHistoryManager.ts`
- Remove `src/chatHistory/ChatStorage.ts`
- Remove `src/chatHistory/ChatSession.ts`

### Step 2: Create New System
- Create `src/events/` directory
- Implement EventTypes, EventStore, SnapshotManager, ContextBuilder, ConversationManager

### Step 3: Update ChatProvider
- Replace `ChatHistoryManager` references with `ConversationManager`
- Add event recording calls throughout request lifecycle
- Use `buildLLMContext()` for API requests

---

## 7. Integration with ChatProvider

### Changes to ChatProvider

```typescript
// In ChatProvider constructor
this.conversationManager = new ConversationManager(context);

// In handleUserMessage()
this.conversationManager.recordUserMessage(message, attachments);

// In stream processing
this.conversationManager.recordAssistantMessage(
  fullContent,
  this.currentModel,
  finishReason,
  usage
);

// In tool execution
this.conversationManager.recordToolCall(toolCallId, toolName, args);
this.conversationManager.recordToolResult(toolCallId, result, success);

// In file operations
this.conversationManager.recordFileRead(filePath, hash, lineCount);
this.conversationManager.recordDiffCreated(diffId, filePath, original, modified);

// When building API request
const context = this.conversationManager.buildLLMContext(16000);
const messages = context.messages;
```

---

## 8. Testing Strategy

### Unit Tests

```typescript
// tests/EventStore.test.ts
describe('EventStore', () => {
  it('should append events with auto-incrementing sequence');
  it('should retrieve events in order');
  it('should filter by event type');
});

// tests/SnapshotManager.test.ts
describe('SnapshotManager', () => {
  it('should create snapshot after N events');
  it('should prune old snapshots');
  it('should generate valid summaries');
});

// tests/ContextBuilder.test.ts
describe('ContextBuilder', () => {
  it('should respect token budget');
  it('should include snapshot summary');
  it('should prioritize recent messages');
});
```

### Integration Tests

```typescript
// tests/ConversationManager.integration.test.ts
describe('ConversationManager', () => {
  it('should handle full conversation lifecycle');
  it('should migrate from globalState');
  it('should maintain compatibility with ChatProvider');
});
```

---

## 9. Rollout Plan (Simplified)

No migration needed - direct replacement approach.

### Phase 1: Core Infrastructure
- [ ] Add `better-sqlite3` and `uuid` to dependencies
- [ ] Create `src/events/EventTypes.ts` with all event definitions
- [ ] Implement `src/events/EventStore.ts` with basic operations
- [ ] Write unit tests for EventStore

### Phase 2: Snapshots & Context
- [ ] Implement `src/events/SnapshotManager.ts`
- [ ] Create simple extractive summarizer (LLM version later)
- [ ] Implement `src/events/ContextBuilder.ts`
- [ ] Write unit tests

### Phase 3: ConversationManager & Integration
- [ ] Implement `src/events/ConversationManager.ts`
- [ ] Delete old `src/chatHistory/` directory
- [ ] Update ChatProvider to use ConversationManager
- [ ] Integration testing

### Phase 4: Context Seeding (Future - UI Dependent)
- [ ] Add `seedFromSnapshot()` method
- [ ] Add `seedFromEvents()` method
- [ ] Add snapshot/event browsing methods
- [ ] Frontend UI for session picker

### Phase 5: Optimization
- [ ] Implement LLM-powered summarization
- [ ] Performance profiling
- [ ] Context window analytics

---

## 10. Open Questions

1. **LLM for summaries**: Use DeepSeek or local model for generating summaries? Cost vs quality tradeoff.

2. **Snapshot trigger**: Fixed interval (every N events) vs token-based (when context exceeds threshold)?

3. **Diff content storage**: Store full diffs in events or just metadata? Storage vs replay fidelity.

4. **Reasoning traces**: Store full R1 reasoning in events or summarize? Can be very large.

5. **Multi-file sessions**: One session per conversation or per project/workspace?

6. **Export format**: Keep JSON export or switch to SQLite dump? User data portability.

---

## 11. Dependencies

```json
{
  "dependencies": {
    "better-sqlite3": "^9.4.3",
    "uuid": "^9.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.8",
    "@types/uuid": "^9.0.7"
  }
}
```

Note: `better-sqlite3` requires native module compilation. May need to consider:
- Pre-built binaries via `prebuild-install`
- Alternative: `sql.js` (pure JS, no native deps, but slower)
- Package in VSIX with platform-specific binaries

---

## 12. References

- [Event Sourcing Pattern (Microsoft)](https://docs.microsoft.com/en-us/azure/architecture/patterns/event-sourcing)
- [better-sqlite3 Documentation](https://github.com/WiseLibs/better-sqlite3)
- [VS Code Extension Storage](https://code.visualstudio.com/api/extension-capabilities/common-capabilities#data-storage)
- Current implementation: [ChatHistoryManager.ts](../src/chatHistory/ChatHistoryManager.ts)
