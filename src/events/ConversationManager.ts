/**
 * ConversationManager - Main interface for conversation state management
 *
 * This is the primary class that ChatProvider and other components interact with.
 * It orchestrates EventStore, SnapshotManager, and ContextBuilder to provide
 * a clean API for:
 * - Session management (create, switch, delete)
 * - Event recording (messages, tools, diffs)
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

import { Database } from './SqlJsWrapper';
import { runMigrations } from './migrations';
import { EventStore } from './EventStore';
import { SnapshotManager, SummarizerFn } from './SnapshotManager';
import { logger } from '../utils/logger';
import {
  ConversationEvent,
  Attachment,
  UserMessageEvent,
  AssistantMessageEvent,
  AssistantReasoningEvent,
  ToolCallEvent,
  ToolResultEvent,
  isUserMessageEvent,
  isAssistantMessageEvent
} from './EventTypes';

/**
 * A rich history turn for restoring conversations with full fidelity.
 * Contains all segment types (reasoning, tools, shell) not just text.
 */
export interface RichHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
  // Assistant-only fields:
  reasoning_iterations?: string[];
  contentIterations?: string[];
  toolCalls?: Array<{ name: string; detail: string; status: string }>;
  shellResults?: Array<{ command: string; output: string; success: boolean }>;
  filesModified?: string[];
  model?: string;
  // User-only fields:
  files?: string[];
  timestamp: number;
}

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
  /** Encryption key for SQLCipher (from VS Code SecretStorage) */
  encryptionKey?: string;
  /** Event interval for auto-snapshot (default: 20) */
  snapshotInterval?: number;
  /** Summarizer function for context compression. Use createLLMSummarizer() from events module. */
  summarizer: SummarizerFn;
}

export class ConversationManager {
  private db: Database;
  private eventStore: EventStore;
  private snapshotManager: SnapshotManager;

  private currentSessionId: string | null = null;
  private context: vscode.ExtensionContext;
  private options: ConversationManagerOptions;

  // Event emitter for UI updates
  private onSessionsChanged: vscode.EventEmitter<void>;
  public readonly onSessionsChangedEvent: vscode.Event<void>;

  // Prepared statements for sessions table
  private stmtInsertSession: Statement;
  private stmtGetSession: Statement;
  private stmtGetAllSessions: Statement;
  private stmtUpdateSession: Statement;
  private stmtDeleteSession: Statement;

  /** Expose the underlying Database for shared tables (e.g., command_rules). */
  getDatabase(): Database {
    return this.db;
  }

  constructor(context: vscode.ExtensionContext, options: ConversationManagerOptions) {
    this.context = context;
    this.options = options;

    // Setup event emitter
    this.onSessionsChanged = new vscode.EventEmitter<void>();
    this.onSessionsChangedEvent = this.onSessionsChanged.event;

    // Setup database path
    const dbPath = this.options?.dbPath ??
      path.join(this.context.globalStorageUri.fsPath, 'moby.db');

    // Initialize database (synchronous — native SQLCipher, no WASM)
    this.db = new Database(dbPath, this.options?.encryptionKey);

    // Run migrations — single source of truth for all schema
    runMigrations(this.db);

    // Initialize components (prepareStatements only — migrations own the schema)
    this.eventStore = new EventStore(this.db);
    this.snapshotManager = new SnapshotManager(
      this.db,
      this.eventStore,
      this.options.summarizer,
      {
        snapshotInterval: this.options?.snapshotInterval
      }
    );
    // Prepare session statements
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

    // Load last active session
    this.loadCurrentSession();
  }

  // ==========================================================================
  // Initialization
  // ==========================================================================

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
    const row = this.stmtGetSession.get(id) as any;
    return row ? this.rowToSession(row) : null;
  }

  /**
   * Get a session by ID (sync version).
   */
  getSessionSync(id: string): Session | null {
    const row = this.stmtGetSession.get(id) as any;
    return row ? this.rowToSession(row) : null;
  }

  /**
   * Get the current active session.
   */
  async getCurrentSession(): Promise<Session | null> {
    if (!this.currentSessionId) return null;
    return this.getSession(this.currentSessionId);
  }

  /**
   * Get all sessions, sorted by most recently updated.
   */
  async getAllSessions(): Promise<Session[]> {
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
    const deleteAll = this.db.transaction(() => {
      this.eventStore.deleteSessionEvents(sessionId);
      this.snapshotManager.deleteSessionSnapshots(sessionId);
      this.stmtDeleteSession.run(sessionId);
    });
    deleteAll();

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
    const clearAll = this.db.transaction(() => {
      this.db.exec('DELETE FROM events');
      this.db.exec('DELETE FROM snapshots');
      this.db.exec('DELETE FROM sessions');
    });
    clearAll();

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
   * Record an assistant message after streaming completes.
   *
   * This is the final event in an assistant turn's save pipeline. It should be called
   * AFTER all reasoning iterations, tool calls, tool results, and file modification
   * markers have been recorded (those events attach to the turn via sequence ordering).
   *
   * @param content - The cleaned response text (shell tags and DSML stripped)
   * @param model - The actual model used (e.g., 'deepseek-chat', 'deepseek-reasoner')
   * @param finishReason - Why streaming ended ('stop', 'length' for partial, 'error')
   * @param usage - Optional token usage stats
   * @param contentIterations - Per-iteration content text for Reasoner model. Each entry
   *   is the cleaned text output from one shell iteration, enabling correct interleaving
   *   during restore (thinking[i] → content[i] → shell[i]). Omit for Chat model.
   */
  async recordAssistantMessage(
    content: string,
    model: string,
    finishReason: 'stop' | 'tool_calls' | 'length' | 'error',
    usage?: { promptTokens: number; completionTokens: number },
    contentIterations?: string[]
  ): Promise<ConversationEvent> {
    const session = this.ensureCurrentSession();

    const event = this.eventStore.append({
      sessionId: session.id,
      timestamp: Date.now(),
      type: 'assistant_message',
      content,
      model,
      finishReason,
      usage,
      contentIterations: contentIterations && contentIterations.length > 0 ? contentIterations : undefined
    });

    // Update session metadata
    this.updateSessionMetadata(session.id, event);

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

  /**
   * Get messages for a specific session in the old format.
   */
  async getSessionMessagesCompat(sessionId: string): Promise<Array<{ role: 'user' | 'assistant'; content: string; timestamp: Date; eventId: string }>> {
    const events = this.eventStore.getEventsByType(
      sessionId,
      ['user_message', 'assistant_message']
    );

    return events.map(e => ({
      role: e.type === 'user_message' ? 'user' as const : 'assistant' as const,
      content: (e as any).content,
      timestamp: new Date(e.timestamp),
      eventId: e.id
    }));
  }

  /**
   * Get rich history for a session, reconstructing full-fidelity turns from events.
   *
   * Queries all event types (user_message, assistant_message, assistant_reasoning,
   * tool_call, tool_result) and groups them into {@link RichHistoryTurn} objects
   * suitable for UI restore via `handleLoadHistory()` in the webview.
   *
   * **Turn grouping algorithm:**
   * - `user_message` → creates a new user turn (finalizes any open assistant turn)
   * - `assistant_reasoning` → starts/continues an assistant turn, appends to reasoning_iterations
   * - `tool_call` → routes by toolName:
   *   - `'shell'` → appends to shellResults (with placeholder output)
   *   - `'_file_modified'` → appends filePath to filesModified
   *   - other → appends to toolCalls
   * - `tool_result` → matches by toolCallId to update output/status on the correct entry
   * - `assistant_message` → finalizes the assistant turn with content, model, and optional
   *   contentIterations (per-iteration text for correct restore interleaving)
   *
   * **Content iterations:** For the Reasoner model, each shell iteration produces
   * separate content text. `contentIterations` preserves per-iteration text so the
   * webview can interleave thinking[i] → content[i] → shell[i] during restore,
   * matching the live streaming order. Without this, all text would appear at the end.
   *
   * Empty arrays are cleaned up before returning (e.g., no reasoning_iterations
   * field if there were none) to keep the payload lean.
   */
  async getSessionRichHistory(sessionId: string): Promise<RichHistoryTurn[]> {
    const events = this.eventStore.getEventsByType(
      sessionId,
      ['user_message', 'assistant_message', 'assistant_reasoning', 'tool_call', 'tool_result']
    );

    // Diagnostic logging for history restore debugging
    const typeCounts: Record<string, number> = {};
    for (const e of events) {
      typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
    }
    console.log(`[RichHistory] Session ${sessionId}: ${events.length} events`, JSON.stringify(typeCounts));

    const turns: RichHistoryTurn[] = [];
    let currentAssistantTurn: RichHistoryTurn | null = null;
    // Map toolCallId → index in current turn's toolCalls/shellResults for pairing with results
    let toolCallMap = new Map<string, { name: string; index: number }>();

    for (const event of events) {
      switch (event.type) {
        case 'user_message': {
          // Finalize any pending assistant turn
          if (currentAssistantTurn) {
            turns.push(currentAssistantTurn);
            currentAssistantTurn = null;
            toolCallMap = new Map();
          }
          const userEvent = event as UserMessageEvent;
          turns.push({
            role: 'user',
            content: userEvent.content,
            files: userEvent.attachments?.map(a => a.name),
            timestamp: userEvent.timestamp
          });
          break;
        }

        case 'assistant_reasoning': {
          // Start assistant turn if not already started
          if (!currentAssistantTurn) {
            currentAssistantTurn = {
              role: 'assistant',
              content: '',
              reasoning_iterations: [],
              toolCalls: [],
              shellResults: [],
              timestamp: event.timestamp
            };
          }
          const reasoningEvent = event as AssistantReasoningEvent;
          currentAssistantTurn.reasoning_iterations!.push(reasoningEvent.content);
          break;
        }

        case 'tool_call': {
          // Start assistant turn if not already started
          if (!currentAssistantTurn) {
            currentAssistantTurn = {
              role: 'assistant',
              content: '',
              reasoning_iterations: [],
              toolCalls: [],
              shellResults: [],
              timestamp: event.timestamp
            };
          }
          const toolEvent = event as ToolCallEvent;
          if (toolEvent.toolName === 'shell') {
            const command = (toolEvent.arguments as any)?.command || '';
            const idx = currentAssistantTurn.shellResults!.length;
            currentAssistantTurn.shellResults!.push({
              command,
              output: '',
              success: true
            });
            toolCallMap.set(toolEvent.toolCallId, { name: 'shell', index: idx });
          } else if (toolEvent.toolName === '_file_modified') {
            // File modification marker — extract file path
            const filePath = (toolEvent.arguments as any)?.filePath || '';
            if (filePath) {
              if (!currentAssistantTurn.filesModified) {
                currentAssistantTurn.filesModified = [];
              }
              currentAssistantTurn.filesModified.push(filePath);
            }
            toolCallMap.set(toolEvent.toolCallId, { name: '_file_modified', index: -1 });
          } else {
            const detail = (toolEvent.arguments as any)?.detail || toolEvent.toolName;
            const idx = currentAssistantTurn.toolCalls!.length;
            currentAssistantTurn.toolCalls!.push({
              name: toolEvent.toolName,
              detail,
              status: 'done'
            });
            toolCallMap.set(toolEvent.toolCallId, { name: toolEvent.toolName, index: idx });
          }
          break;
        }

        case 'tool_result': {
          const resultEvent = event as ToolResultEvent;
          const mapping = toolCallMap.get(resultEvent.toolCallId);
          if (mapping && currentAssistantTurn) {
            if (mapping.name === 'shell') {
              const shell = currentAssistantTurn.shellResults![mapping.index];
              shell.output = resultEvent.result;
              shell.success = resultEvent.success;
            } else if (mapping.name !== '_file_modified') {
              const tool = currentAssistantTurn.toolCalls![mapping.index];
              tool.status = resultEvent.success ? 'done' : 'error';
            }
          }
          break;
        }

        case 'assistant_message': {
          // Start assistant turn if not already started
          if (!currentAssistantTurn) {
            currentAssistantTurn = {
              role: 'assistant',
              content: '',
              reasoning_iterations: [],
              toolCalls: [],
              shellResults: [],
              timestamp: event.timestamp
            };
          }
          const assistantEvent = event as AssistantMessageEvent;
          currentAssistantTurn.content = assistantEvent.content;
          currentAssistantTurn.model = assistantEvent.model;
          // Extract per-iteration content text (for correct interleaving during restore)
          if (assistantEvent.contentIterations && assistantEvent.contentIterations.length > 0) {
            currentAssistantTurn.contentIterations = assistantEvent.contentIterations;
          }
          // Finalize this assistant turn
          turns.push(currentAssistantTurn);
          currentAssistantTurn = null;
          toolCallMap = new Map();
          break;
        }
      }
    }

    // Finalize any trailing assistant turn (e.g., partial/interrupted)
    if (currentAssistantTurn) {
      turns.push(currentAssistantTurn);
    }

    // Clean up empty arrays for cleaner output
    for (const turn of turns) {
      if (turn.reasoning_iterations?.length === 0) delete turn.reasoning_iterations;
      if (turn.contentIterations?.length === 0) delete turn.contentIterations;
      if (turn.toolCalls?.length === 0) delete turn.toolCalls;
      if (turn.shellResults?.length === 0) delete turn.shellResults;
      if (turn.filesModified?.length === 0) delete turn.filesModified;
      if (turn.files?.length === 0) delete turn.files;
    }

    // Diagnostic logging for history restore
    const turnSummary = turns.map((t, i) => {
      if (t.role === 'user') return `turn[${i}]: user (${t.content.length} chars)`;
      return `turn[${i}]: assistant (${t.content.length} chars, reasoning=${t.reasoning_iterations?.length || 0}, tools=${t.toolCalls?.length || 0}, shells=${t.shellResults?.length || 0}, files=${t.filesModified?.length || 0}, model=${t.model})`;
    });
    console.log(`[RichHistory] Returning ${turns.length} turns:`, turnSummary);

    return turns;
  }

  /**
   * Add a message to the current session (compatibility method).
   */
  async addMessageToCurrentSession(message: { role: 'user' | 'assistant'; content: string }): Promise<void> {
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

  /**
   * Get the latest snapshot summary for a session.
   * Used by ContextBuilder to inject context when old messages are dropped.
   * Returns summary text, pre-computed token count, and snapshot ID for caching.
   */
  getLatestSnapshotSummary(sessionId: string): { summary: string; tokenCount: number; snapshotId: string } | undefined {
    const snapshot = this.snapshotManager.getLatestSnapshot(sessionId);
    if (!snapshot) return undefined;
    return { summary: snapshot.summary, tokenCount: snapshot.tokenCount, snapshotId: snapshot.id };
  }

  /**
   * Check if the session has a "fresh" snapshot — one that covers events
   * within `threshold` of the latest event sequence.
   *
   * Used by the proactive context-pressure trigger to avoid re-summarizing
   * on every request once context usage exceeds 80%.
   *
   * @param sessionId - Session to check
   * @param threshold - Max events since last snapshot to consider "fresh" (default: 5)
   */
  hasFreshSummary(sessionId: string, threshold: number = 5): boolean {
    const snapshot = this.snapshotManager.getLatestSnapshot(sessionId);
    if (!snapshot) {
      logger.debug(`[Snapshot] hasFreshSummary: no snapshot exists | session=${sessionId.substring(0, 8)}`);
      return false;
    }
    const latestSeq = this.eventStore.getLatestSequence(sessionId);
    const eventsSince = latestSeq - snapshot.upToSequence;
    const fresh = eventsSince < threshold;
    logger.debug(
      `[Snapshot] hasFreshSummary: ${fresh ? 'FRESH' : 'STALE'}` +
      ` | eventsSince=${eventsSince} threshold=${threshold}` +
      ` | session=${sessionId.substring(0, 8)}`
    );
    return fresh;
  }

  /**
   * Force-create a snapshot for the session.
   * Used by the proactive context-pressure trigger in RequestOrchestrator.
   */
  async createSnapshot(sessionId: string): Promise<void> {
    logger.info(`[Snapshot] ConversationManager.createSnapshot called | session=${sessionId.substring(0, 8)}`);
    await this.snapshotManager.createSnapshot(sessionId);
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
