/**
 * ConversationManager - Main interface for conversation state management
 *
 * This is the primary class that ChatProvider and other components interact with.
 * It orchestrates EventStore, SnapshotManager, and ContextBuilder to provide
 * a clean API for:
 * - Session management (create, switch, delete)
 * - Event recording (messages, tools, diffs)
 * - Context building for LLM calls
 * - Conversation forking/seeding
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

import { Database, initializeSqlJs } from './SqlJsWrapper';
import { EventStore } from './EventStore';
import { SnapshotManager, Snapshot, createExtractSummarizer } from './SnapshotManager';
import { ContextBuilder, LLMContext, LLMMessage } from './ContextBuilder';
import {
  ConversationEvent,
  Attachment,
  isUserMessageEvent,
  isAssistantMessageEvent
} from './EventTypes';

// Statement interface for our wrapper
interface Statement {
  run(...params: unknown[]): void;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

/**
 * Session metadata for display.
 */
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

/**
 * Options for creating a ConversationManager.
 */
export interface ConversationManagerOptions {
  /** Database file path (default: extension storage) */
  dbPath?: string;
  /** Event interval for auto-snapshot (default: 20) */
  snapshotInterval?: number;
  /** Max snapshots to keep per session (default: 5) */
  maxSnapshotsPerSession?: number;
  /** Max tokens for LLM context (default: 16000) */
  maxContextTokens?: number;
}

export class ConversationManager {
  private db!: Database;
  private eventStore!: EventStore;
  private snapshotManager!: SnapshotManager;
  private contextBuilder!: ContextBuilder;

  private currentSessionId: string | null = null;
  private context: vscode.ExtensionContext;
  private options?: ConversationManagerOptions;
  private initialized: boolean = false;
  private initPromise: Promise<void> | null = null;

  // Event emitter for UI updates
  private onSessionsChanged: vscode.EventEmitter<void>;
  public readonly onSessionsChangedEvent: vscode.Event<void>;

  // Prepared statements for sessions table
  private stmtInsertSession!: Statement;
  private stmtGetSession!: Statement;
  private stmtGetAllSessions!: Statement;
  private stmtUpdateSession!: Statement;
  private stmtDeleteSession!: Statement;

  constructor(context: vscode.ExtensionContext, options?: ConversationManagerOptions) {
    this.context = context;
    this.options = options;

    // Setup event emitter
    this.onSessionsChanged = new vscode.EventEmitter<void>();
    this.onSessionsChangedEvent = this.onSessionsChanged.event;

    // Initialize database asynchronously - store promise for awaiting
    this.initPromise = this.initialize();
  }

  /**
   * Initialize the database and components asynchronously.
   * Called from constructor, awaited internally before operations.
   */
  private async initialize(): Promise<void> {
    if (this.initialized) return;

    // Initialize sql.js WASM
    await initializeSqlJs();

    // Setup database path
    const dbPath = this.options?.dbPath ??
      path.join(this.context.globalStorageUri.fsPath, 'conversations.db');

    // Ensure directory exists
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    // Initialize database
    this.db = new Database(dbPath);

    // Initialize components
    this.eventStore = new EventStore(this.db);
    this.snapshotManager = new SnapshotManager(
      this.db,
      this.eventStore,
      createExtractSummarizer(),
      {
        snapshotInterval: this.options?.snapshotInterval,
        maxSnapshotsPerSession: this.options?.maxSnapshotsPerSession
      }
    );
    this.contextBuilder = new ContextBuilder(
      this.eventStore,
      this.snapshotManager,
      { maxContextTokens: this.options?.maxContextTokens }
    );

    // Initialize schema and statements
    this.initSessionsSchema();
    this.prepareStatements();

    // Load last active session
    this.loadCurrentSession();

    this.initialized = true;
  }

  /**
   * Ensure the database is initialized before operations.
   */
  async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
    }
  }

  // ==========================================================================
  // Schema & Initialization
  // ==========================================================================

  private initSessionsSchema(): void {
    this.db.exec(`
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

      CREATE INDEX IF NOT EXISTS idx_sessions_updated
        ON sessions(updated_at DESC);
    `);
  }

  private prepareStatements(): void {
    this.stmtInsertSession = this.db.prepare(`
      INSERT INTO sessions (id, title, model, created_at, updated_at, event_count, tags)
      VALUES (?, ?, ?, ?, ?, 0, '[]')
    `);

    this.stmtGetSession = this.db.prepare(`
      SELECT * FROM sessions WHERE id = ?
    `);

    this.stmtGetAllSessions = this.db.prepare(`
      SELECT * FROM sessions ORDER BY updated_at DESC
    `);

    this.stmtUpdateSession = this.db.prepare(`
      UPDATE sessions
      SET title = ?, updated_at = ?, event_count = ?,
          first_user_message = ?, last_activity_preview = ?
      WHERE id = ?
    `);

    this.stmtDeleteSession = this.db.prepare(`
      DELETE FROM sessions WHERE id = ?
    `);
  }

  private loadCurrentSession(): void {
    const savedId = this.context.globalState.get<string>('currentSessionId');
    if (savedId && this.getSessionSync(savedId)) {
      this.currentSessionId = savedId;
    }
  }

  private async saveCurrentSession(): Promise<void> {
    if (this.currentSessionId) {
      await this.context.globalState.update('currentSessionId', this.currentSessionId);
    }
  }

  // ==========================================================================
  // Session Management
  // ==========================================================================

  /**
   * Create a new conversation session.
   */
  async createSession(title?: string, model: string = 'deepseek-chat'): Promise<Session> {
    await this.ensureInitialized();

    const id = uuidv4();
    const now = Date.now();

    this.stmtInsertSession.run(id, title || 'New Chat', model, now, now);

    // Record session created event
    this.eventStore.append({
      sessionId: id,
      timestamp: now,
      type: 'session_created',
      title: title || 'New Chat',
      model
    });

    this.currentSessionId = id;
    await this.saveCurrentSession();
    this.onSessionsChanged.fire();

    return (await this.getSession(id))!;
  }

  /**
   * Get a session by ID.
   */
  async getSession(id: string): Promise<Session | null> {
    await this.ensureInitialized();
    const row = this.stmtGetSession.get(id) as any;
    return row ? this.rowToSession(row) : null;
  }

  /**
   * Get a session by ID (sync version - only use after initialization).
   */
  getSessionSync(id: string): Session | null {
    if (!this.initialized) return null;
    const row = this.stmtGetSession.get(id) as any;
    return row ? this.rowToSession(row) : null;
  }

  /**
   * Get the current active session.
   */
  async getCurrentSession(): Promise<Session | null> {
    await this.ensureInitialized();
    if (!this.currentSessionId) return null;
    return this.getSession(this.currentSessionId);
  }

  /**
   * Get all sessions, sorted by most recently updated.
   */
  async getAllSessions(): Promise<Session[]> {
    await this.ensureInitialized();
    const rows = this.stmtGetAllSessions.all() as any[];
    return rows.map(row => this.rowToSession(row));
  }

  /**
   * Switch to a different session.
   */
  async switchToSession(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (session) {
      this.currentSessionId = sessionId;
      await this.saveCurrentSession();
      this.onSessionsChanged.fire();
    }
  }

  /**
   * Delete a session and all its events.
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.ensureInitialized();
    this.eventStore.deleteSessionEvents(sessionId);
    this.snapshotManager.deleteSessionSnapshots(sessionId);
    this.stmtDeleteSession.run(sessionId);

    if (this.currentSessionId === sessionId) {
      this.currentSessionId = null;
      await this.saveCurrentSession();
    }

    this.onSessionsChanged.fire();
  }

  /**
   * Rename a session.
   */
  async renameSession(sessionId: string, newTitle: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) return;

    const oldTitle = session.title;

    this.db.prepare(`
      UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?
    `).run(newTitle, Date.now(), sessionId);

    // Record rename event
    this.eventStore.append({
      sessionId,
      timestamp: Date.now(),
      type: 'session_renamed',
      oldTitle,
      newTitle
    });

    this.onSessionsChanged.fire();
  }

  /**
   * Clear all sessions.
   */
  async clearAllSessions(): Promise<void> {
    await this.ensureInitialized();
    this.db.exec('DELETE FROM events');
    this.db.exec('DELETE FROM snapshots');
    this.db.exec('DELETE FROM sessions');

    this.currentSessionId = null;
    await this.saveCurrentSession();
    this.onSessionsChanged.fire();
  }

  // ==========================================================================
  // Event Recording
  // ==========================================================================

  /**
   * Record a user message.
   */
  async recordUserMessage(content: string, attachments?: Attachment[]): Promise<ConversationEvent> {
    await this.ensureInitialized();
    const session = this.ensureCurrentSession();

    const event = this.eventStore.append({
      sessionId: session.id,
      timestamp: Date.now(),
      type: 'user_message',
      content,
      attachments
    });

    // Update session metadata
    this.updateSessionMetadata(session.id, event);

    this.onSessionsChanged.fire();
    return event;
  }

  /**
   * Record an assistant message (after streaming completes).
   */
  async recordAssistantMessage(
    content: string,
    model: string,
    finishReason: 'stop' | 'tool_calls' | 'length' | 'error',
    usage?: { promptTokens: number; completionTokens: number }
  ): Promise<ConversationEvent> {
    await this.ensureInitialized();
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

    // Update session metadata
    this.updateSessionMetadata(session.id, event);

    // Check if we should create a snapshot
    this.snapshotManager.maybeCreateSnapshot(session.id);

    this.onSessionsChanged.fire();
    return event;
  }

  /**
   * Record reasoning content from R1 model.
   */
  recordAssistantReasoning(content: string, iteration: number): ConversationEvent {
    const session = this.ensureCurrentSession();

    return this.eventStore.append({
      sessionId: session.id,
      timestamp: Date.now(),
      type: 'assistant_reasoning',
      content,
      iteration
    });
  }

  /**
   * Record a tool call request.
   */
  recordToolCall(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>
  ): ConversationEvent {
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

  /**
   * Record a tool execution result.
   */
  recordToolResult(
    toolCallId: string,
    result: string,
    success: boolean,
    duration?: number
  ): ConversationEvent {
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

  /**
   * Record a file read operation.
   */
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

  /**
   * Record a diff being created (pending).
   */
  recordDiffCreated(
    diffId: string,
    filePath: string,
    originalContent: string,
    newContent: string
  ): ConversationEvent {
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

  /**
   * Record a diff being accepted.
   */
  recordDiffAccepted(diffId: string): ConversationEvent {
    const session = this.ensureCurrentSession();

    return this.eventStore.append({
      sessionId: session.id,
      timestamp: Date.now(),
      type: 'diff_accepted',
      diffId
    });
  }

  /**
   * Record a diff being rejected.
   */
  recordDiffRejected(diffId: string): ConversationEvent {
    const session = this.ensureCurrentSession();

    return this.eventStore.append({
      sessionId: session.id,
      timestamp: Date.now(),
      type: 'diff_rejected',
      diffId
    });
  }

  /**
   * Record a web search.
   */
  recordWebSearch(query: string, resultCount: number, resultsPreview: string[]): ConversationEvent {
    const session = this.ensureCurrentSession();

    return this.eventStore.append({
      sessionId: session.id,
      timestamp: Date.now(),
      type: 'web_search',
      query,
      resultCount,
      resultsPreview
    });
  }

  /**
   * Record an error.
   */
  recordError(
    errorType: 'api' | 'tool' | 'parse' | 'network',
    message: string,
    recoverable: boolean
  ): ConversationEvent {
    const session = this.ensureCurrentSession();

    return this.eventStore.append({
      sessionId: session.id,
      timestamp: Date.now(),
      type: 'error',
      errorType,
      message,
      recoverable
    });
  }

  // ==========================================================================
  // Context Building
  // ==========================================================================

  /**
   * Build LLM context for the current session.
   */
  async buildLLMContext(tokenBudget?: number): Promise<LLMContext> {
    await this.ensureInitialized();
    const session = this.ensureCurrentSession();
    return this.contextBuilder.buildForLLM(session.id, tokenBudget);
  }

  /**
   * Get messages only (for compatibility).
   */
  async getMessages(): Promise<LLMMessage[]> {
    const session = await this.getCurrentSession();
    if (!session) return [];
    return this.contextBuilder.getMessagesOnly(session.id);
  }

  // ==========================================================================
  // Conversation Forking / Seeding
  // ==========================================================================

  /**
   * Create a new session seeded with a snapshot from another session.
   */
  async seedFromSnapshot(snapshotId: string, title?: string): Promise<Session> {
    const snapshot = this.snapshotManager.getSnapshotById(snapshotId);
    if (!snapshot) {
      throw new Error('Snapshot not found');
    }

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

    this.onSessionsChanged.fire();
    return (await this.getSession(session.id))!;
  }

  /**
   * Create a new session seeded with specific events from another session.
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

    this.onSessionsChanged.fire();
    return (await this.getSession(session.id))!;
  }

  /**
   * Get all snapshots across all sessions (for UI picker).
   */
  getAllSnapshots(): Array<Snapshot & { sessionTitle: string }> {
    return this.snapshotManager.getAllSnapshots();
  }

  /**
   * Get browsable events from a session (for cherry-picking UI).
   */
  getBrowsableEvents(sessionId: string): ConversationEvent[] {
    return this.eventStore.getEventsByType(sessionId, [
      'user_message',
      'assistant_message',
      'diff_accepted',
      'diff_rejected'
    ]);
  }

  // ==========================================================================
  // Compatibility Layer (matches ChatHistoryManager API)
  // ==========================================================================

  /**
   * Get messages in the old format for backward compatibility.
   */
  async getMessagesCompat(): Promise<Array<{ role: 'user' | 'assistant'; content: string; timestamp: Date }>> {
    const session = await this.getCurrentSession();
    if (!session) return [];

    return this.getSessionMessagesCompat(session.id);
  }

  /**
   * Get messages for a specific session in the old format.
   */
  async getSessionMessagesCompat(sessionId: string): Promise<Array<{ role: 'user' | 'assistant'; content: string; timestamp: Date }>> {
    await this.ensureInitialized();
    const events = this.eventStore.getEventsByType(
      sessionId,
      ['user_message', 'assistant_message']
    );

    return events.map(e => ({
      role: e.type === 'user_message' ? 'user' as const : 'assistant' as const,
      content: (e as any).content,
      timestamp: new Date(e.timestamp)
    }));
  }

  /**
   * Add a message to the current session (compatibility method).
   */
  async addMessageToCurrentSession(message: { role: 'user' | 'assistant'; content: string }): Promise<void> {
    await this.ensureInitialized();
    if (message.role === 'user') {
      await this.recordUserMessage(message.content);
    } else {
      await this.recordAssistantMessage(message.content, 'deepseek-chat', 'stop');
    }
  }

  /**
   * Start a new session (compatibility method).
   */
  async startNewSession(
    initialMessage?: string,
    model?: string,
    language?: string,
    filePath?: string
  ): Promise<Session> {
    await this.ensureInitialized();
    return this.createSession(initialMessage, model);
  }

  /**
   * Get session statistics.
   */
  async getSessionStats(): Promise<{
    totalSessions: number;
    totalMessages: number;
    totalTokens: number;
    byModel: Record<string, number>;
    byLanguage: Record<string, number>;
  }> {
    await this.ensureInitialized();
    const sessions = await this.getAllSessions();
    let totalMessages = 0;
    let totalTokens = 0;
    const byModel: Record<string, number> = {};
    const byLanguage: Record<string, number> = {};

    for (const session of sessions) {
      const events = this.eventStore.getEventsByType(
        session.id,
        ['user_message', 'assistant_message']
      );

      totalMessages += events.length;

      // Estimate tokens from content length
      for (const event of events) {
        const content = (event as any).content || '';
        totalTokens += Math.ceil(content.length / 4);
      }

      byModel[session.model] = (byModel[session.model] || 0) + 1;
    }

    return {
      totalSessions: sessions.length,
      totalMessages,
      totalTokens,
      byModel,
      byLanguage
    };
  }

  /**
   * Export a session to JSON/Markdown/TXT format.
   */
  async exportSession(sessionId: string, format: 'json' | 'markdown' | 'txt' = 'json'): Promise<string> {
    const session = await this.getSession(sessionId);
    if (!session) return '';

    const events = this.eventStore.getEventsByType(
      sessionId,
      ['user_message', 'assistant_message']
    );

    const messages = events.map(e => ({
      role: e.type === 'user_message' ? 'user' : 'assistant',
      content: (e as any).content,
      timestamp: new Date(e.timestamp)
    }));

    switch (format) {
      case 'json':
        return JSON.stringify({ ...session, messages }, null, 2);

      case 'markdown':
        return `# ${session.title}\n` +
          `**Created:** ${session.createdAt.toLocaleString()}  \n` +
          `**Model:** ${session.model}  \n` +
          `\n## Conversation\n\n` +
          messages.map(msg =>
            `### ${msg.role === 'user' ? 'You' : 'DeepSeek Moby'}\n` +
            `*${msg.timestamp.toLocaleTimeString()}*\n\n` +
            msg.content + '\n'
          ).join('\n');

      case 'txt':
        return `=== ${session.title} ===\n` +
          `Created: ${session.createdAt.toLocaleString()}\n` +
          `Model: ${session.model}\n` +
          `\nConversation:\n\n` +
          messages.map(msg =>
            `[${msg.timestamp.toLocaleTimeString()}] ${msg.role === 'user' ? 'You' : 'DeepSeek Moby'}:\n` +
            msg.content + '\n'
          ).join('\n');

      default:
        return JSON.stringify({ ...session, messages }, null, 2);
    }
  }

  /**
   * Export all sessions.
   */
  async exportAllSessions(format: 'json' | 'markdown' | 'txt' = 'json'): Promise<string> {
    await this.ensureInitialized();
    const sessions = await this.getAllSessions();

    if (format === 'json') {
      const result = [];
      for (const session of sessions) {
        const events = this.eventStore.getEventsByType(
          session.id,
          ['user_message', 'assistant_message']
        );
        result.push({
          ...session,
          messages: events.map(e => ({
            role: e.type === 'user_message' ? 'user' : 'assistant',
            content: (e as any).content,
            timestamp: new Date(e.timestamp)
          }))
        });
      }
      return JSON.stringify(result, null, 2);
    }

    // For markdown/txt, concatenate individual exports
    const exports = await Promise.all(
      sessions.map(s => this.exportSession(s.id, format))
    );
    return exports.join('\n---\n\n');
  }

  /**
   * Import a session from JSON.
   */
  async importSession(data: string): Promise<Session | null> {
    try {
      const importData = JSON.parse(data);
      const session = await this.createSession(
        importData.title || 'Imported Chat',
        importData.model || 'deepseek-chat'
      );

      // Replay messages as events
      for (const msg of (importData.messages || [])) {
        if (msg.role === 'user') {
          this.recordUserMessage(msg.content);
        } else {
          this.recordAssistantMessage(msg.content, session.model, 'stop');
        }
      }

      return await this.getSession(session.id);
    } catch (error) {
      return null;
    }
  }

  /**
   * Search sessions by query.
   */
  async searchSessions(query: string): Promise<Session[]> {
    const lowerQuery = query.toLowerCase();
    const sessions = await this.getAllSessions();
    return sessions.filter(session => {
      // Search in title
      if (session.title.toLowerCase().includes(lowerQuery)) return true;

      // Search in first user message
      if (session.firstUserMessage?.toLowerCase().includes(lowerQuery)) return true;

      // Search in messages (more expensive)
      const events = this.eventStore.getEventsByType(
        session.id,
        ['user_message', 'assistant_message']
      );
      return events.some(e =>
        ((e as any).content || '').toLowerCase().includes(lowerQuery)
      );
    });
  }

  /**
   * Get conversation history (compatibility method).
   */
  async getConversationHistory(): Promise<Array<{ role: 'user' | 'assistant'; content: string; timestamp: Date }>> {
    return await this.getMessagesCompat();
  }

  /**
   * Clear conversation history (compatibility - starts new session).
   */
  async clearConversationHistory(): Promise<void> {
    await this.createSession();
  }

  /**
   * Alias for clearAllSessions.
   */
  async clearAllHistory(): Promise<void> {
    await this.clearAllSessions();
  }

  /**
   * Search history (alias for searchSessions).
   */
  async searchHistory(query: string): Promise<Session[]> {
    return await this.searchSessions(query);
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private ensureCurrentSession(): Session {
    if (!this.currentSessionId) {
      // Synchronously create a session
      const id = uuidv4();
      const now = Date.now();

      this.stmtInsertSession.run(id, 'New Chat', 'deepseek-chat', now, now);
      this.currentSessionId = id;

      // Don't await - just fire and forget
      this.saveCurrentSession();
    }

    return this.getSessionSync(this.currentSessionId)!;
  }

  private updateSessionMetadata(sessionId: string, event: ConversationEvent): void {
    const session = this.getSessionSync(sessionId);
    if (!session) return;

    const eventCount = this.eventStore.getEventCount(sessionId);
    const preview = this.eventStore.getActivityPreview(event);

    // Update first user message if this is the first
    let firstUserMessage = session.firstUserMessage;
    let title = session.title;

    if (!firstUserMessage && event.type === 'user_message') {
      firstUserMessage = event.content.substring(0, 100);
      // Auto-generate title from first message
      if (session.title === 'New Chat') {
        title = event.content.substring(0, 50) +
          (event.content.length > 50 ? '...' : '');
      }
    }

    this.stmtUpdateSession.run(
      title,
      Date.now(),
      eventCount,
      firstUserMessage,
      preview,
      sessionId
    );
  }

  private rowToSession(row: any): Session {
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

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  /**
   * Close the database connection.
   */
  dispose(): void {
    this.db.close();
    this.onSessionsChanged.dispose();
  }
}
