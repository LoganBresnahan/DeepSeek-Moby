/**
 * ConversationManager - Pure data service for conversation persistence
 *
 * Stateless w.r.t. which session is "current" — callers (ChatProvider) own
 * session lifecycle and pass explicit sessionId to all write operations.
 *
 * Orchestrates EventStore, SnapshotManager to provide a clean API for:
 * - Session CRUD (create, delete, rename, fork)
 * - Event recording (messages, tools, diffs) — all take explicit sessionId
 * - History queries (rich history, messages, search)
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
  AssistantMessageEvent
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
  /** Edit mode active when this turn's file modifications were created */
  editMode?: 'manual' | 'ask' | 'auto';
  model?: string;
  /** CQRS turn events — when present, history restore uses these directly */
  turnEvents?: Array<Record<string, unknown>>;
  // User-only fields:
  files?: string[];
  timestamp: number;
  /** Event sequence number for this turn boundary (used by fork API) */
  sequence?: number;
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
  /** Fork parent session ID (null/undefined = original session) */
  parentSessionId?: string;
  /** Sequence in parent where forked (null/undefined = original session) */
  forkSequence?: number;
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

  /** Expose globalState for cross-instance coordination (e.g., command rules version counter). */
  getGlobalState(): vscode.Memento {
    return this.context.globalState;
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
      INSERT INTO sessions (id, title, model, created_at, updated_at, event_count, tags, parent_session_id, fork_sequence)
      VALUES (?, ?, ?, ?, ?, 0, '[]', ?, ?)
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

  // ==========================================================================
  // Session Management
  // ==========================================================================

  /**
   * Create a new conversation session.
   */
  async createSession(title?: string, model: string = 'deepseek-chat'): Promise<Session> {
    const id = uuidv4();
    const now = Date.now();

    this.stmtInsertSession.run(id, title || 'New Chat', model, now, now, null, null);

    // Record session created event
    this.eventStore.append({
      sessionId: id,
      timestamp: now,
      type: 'session_created',
      title: title || 'New Chat',
      model
    });

    this.onSessionsChanged.fire();
    logger.info(`[CM] createSession id=${id.substring(0, 8)} title="${title || 'New Chat'}" model=${model}`);

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
   * Check if a session has any events (messages, tool calls, etc.).
   */
  sessionHasEvents(sessionId: string): boolean {
    const events = this.eventStore.getEvents(sessionId);
    return events.length > 0;
  }

  /**
   * Get all sessions, sorted by most recently updated.
   */
  async getAllSessions(): Promise<Session[]> {
    const rows = this.stmtGetAllSessions.all() as any[];
    return rows.map(row => this.rowToSession(row));
  }

  /**
   * Delete a session and all its events.
   */
  async deleteSession(sessionId: string): Promise<void> {
    const deleteAll = this.db.transaction(() => {
      // Delete session — CASCADE removes event_sessions rows + snapshots
      this.stmtDeleteSession.run(sessionId);
      // Clean up orphaned events (no remaining session references)
      this.db.prepare(
        'DELETE FROM events WHERE id NOT IN (SELECT event_id FROM event_sessions)'
      ).run();
    });
    deleteAll();

    this.onSessionsChanged.fire();
    logger.info(`[CM] deleteSession id=${sessionId.substring(0, 8)}`);
  }

  /**
   * Fork a session at a given sequence number, creating an independent branch.
   *
   * Links existing events (up to atSequence) to a new session via the join
   * table — zero-copy, no event data duplication. Then records a fork_created
   * event. Does NOT switch to the fork — caller decides.
   *
   * @param parentSessionId - Session to fork from
   * @param atSequence - Sequence number to fork at (must be a turn boundary)
   * @returns The newly created fork session
   */
  async forkSession(parentSessionId: string, atSequence: number): Promise<{ session: Session; forkEventType: string; lastUserMessage?: string }> {
    const parentSession = this.getSessionSync(parentSessionId);
    if (!parentSession) {
      throw new Error(`Cannot fork: parent session ${parentSessionId} not found`);
    }

    // Validate fork point is a clean turn boundary
    const events = this.eventStore.getEvents(parentSessionId);
    const forkEvent = events.find(e => e.sequence === atSequence);
    if (!forkEvent) {
      throw new Error(`Cannot fork: no event at sequence ${atSequence}`);
    }
    if (forkEvent.type !== 'user_message' && forkEvent.type !== 'assistant_message') {
      throw new Error(
        `Cannot fork: event at sequence ${atSequence} is '${forkEvent.type}', ` +
        `must be 'user_message' or 'assistant_message' (turn boundary)`
      );
    }

    // Create the fork session
    const forkId = uuidv4();
    const now = Date.now();
    const forkTitle = `${parentSession.title} (fork)`;

    this.stmtInsertSession.run(
      forkId, forkTitle, parentSession.model, now, now,
      parentSessionId, atSequence
    );

    // Link events from parent to fork via join table (zero-copy)
    const linkedCount = this.eventStore.linkEventsToSession(
      parentSessionId, forkId, atSequence
    );

    // Record fork_created event in the new session
    this.eventStore.append({
      sessionId: forkId,
      timestamp: now,
      type: 'fork_created',
      parentSessionId,
      forkPointSequence: atSequence
    });

    // Update session metadata
    const forkSession = this.getSessionSync(forkId)!;
    const eventCount = this.eventStore.getEventCount(forkId);
    const firstUserMsg = events.find(e => e.type === 'user_message');

    this.stmtUpdateSession.run(
      forkTitle,
      now,
      eventCount,
      firstUserMsg ? (firstUserMsg as any).content.substring(0, 100) : null,
      'Forked from session',
      forkId
    );

    this.onSessionsChanged.fire();

    logger.info(
      `[Fork] Created fork session=${forkId.substring(0, 8)}` +
      ` from parent=${parentSessionId.substring(0, 8)}` +
      ` at sequence=${atSequence} (${linkedCount} events linked)`
    );
    logger.sessionFork(parentSessionId, forkId, atSequence);

    const session = (await this.getSession(forkId))!;
    return {
      session,
      forkEventType: forkEvent.type,
      lastUserMessage: forkEvent.type === 'user_message' ? (forkEvent as any).content : undefined
    };
  }

  /**
   * Get all fork children of a session.
   *
   * @param sessionId - Parent session to get forks for
   * @returns Array of fork sessions, ordered by creation date (newest first)
   */
  async getSessionForks(sessionId: string): Promise<Session[]> {
    const rows = this.db.prepare(
      'SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY created_at DESC'
    ).all(sessionId) as any[];
    return rows.map(row => this.rowToSession(row));
  }

  /**
   * Rename a session.
   */
  async renameSession(sessionId: string, newTitle: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) return;

    const oldTitle = session.title;

    this.db.prepare(`
      UPDATE sessions SET title = ? WHERE id = ?
    `).run(newTitle, sessionId);

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
   * Update the status of a file-modified event in the most recent assistant_message's turnEvents.
   * Called when the user accepts/rejects a pending file change in ask mode.
   */
  updateFileModifiedStatus(sessionId: string, filePath: string, newStatus: 'applied' | 'rejected', editMode?: string): void {
    logger.info(`[CM.updateFileModified] Called: session=${sessionId.substring(0, 8)}, file=${filePath}, status=${newStatus}, editMode=${editMode || 'default'}`);

    // Find the most recent assistant_message event for this session
    const events = this.eventStore.getEventsByType(sessionId, ['assistant_message']);
    if (events.length === 0) {
      logger.warn(`[CM.updateFileModified] No assistant_message events found for session ${sessionId.substring(0, 8)}`);
      return;
    }

    const lastAssistant = events[events.length - 1] as AssistantMessageEvent;
    if (!lastAssistant.id) {
      logger.warn(`[CM.updateFileModified] Last assistant_message has no ID`);
      return;
    }

    logger.info(`[CM.updateFileModified] Found assistant_message id=${lastAssistant.id}, turnEvents=${lastAssistant.turnEvents?.length ?? 0}`);

    // Ensure turnEvents array exists
    if (!lastAssistant.turnEvents) {
      lastAssistant.turnEvents = [];
      logger.info(`[CM.updateFileModified] Created empty turnEvents array`);
    }

    // Log existing file-modified events for debugging
    const existingFileEvents = lastAssistant.turnEvents.filter((te: any) => te.type === 'file-modified');
    if (existingFileEvents.length > 0) {
      logger.info(`[CM.updateFileModified] Existing file-modified events: ${existingFileEvents.map((e: any) => `${e.path}:${e.status}`).join(', ')}`);
    }

    // Find and update the file-modified event, or insert one if not found (manual mode)
    let found = false;
    for (const te of lastAssistant.turnEvents) {
      if ((te as any).type === 'file-modified' && (te as any).path === filePath) {
        const oldStatus = (te as any).status;
        (te as any).status = newStatus;
        found = true;
        logger.info(`[CM.updateFileModified] Updated existing event: ${filePath} ${oldStatus} → ${newStatus}`);
        break;
      }
    }

    if (!found) {
      lastAssistant.turnEvents.push({
        type: 'file-modified',
        path: filePath,
        status: newStatus,
        editMode: editMode || 'manual',
        ts: Date.now()
      } as any);
      logger.info(`[CM.updateFileModified] Inserted new event: ${filePath} → ${newStatus} (editMode=${editMode || 'manual'})`);
    }

    // Write back the updated data blob
    const { sessionId: _s, sequence: _seq, id, ...data } = lastAssistant as any;
    this.eventStore.updateEventData(id, data);
    logger.info(`[CM.updateFileModified] Saved to DB: event_id=${id}, total turnEvents=${lastAssistant.turnEvents.length}`);
  }

  /**
   * Clear all sessions.
   */
  async clearAllSessions(): Promise<void> {
    const clearAll = this.db.transaction(() => {
      this.db.exec('DELETE FROM event_sessions');
      this.db.exec('DELETE FROM events');
      this.db.exec('DELETE FROM snapshots');
      this.db.exec('DELETE FROM sessions');
    });
    clearAll();

    this.onSessionsChanged.fire();
    logger.info('[CM] clearAllSessions complete');
  }

  // ==========================================================================
  // Event Recording
  // ==========================================================================

  /**
   * Record a user message.
   */
  async recordUserMessage(sessionId: string, content: string, attachments?: Attachment[]): Promise<ConversationEvent> {
    const event = this.eventStore.append({
      sessionId,
      timestamp: Date.now(),
      type: 'user_message',
      content,
      attachments
    });

    // Update session metadata
    this.updateSessionMetadata(sessionId, event);

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
    sessionId: string,
    content: string,
    model: string,
    finishReason: 'stop' | 'tool_calls' | 'length' | 'error',
    usage?: { promptTokens: number; completionTokens: number },
    contentIterations?: string[],
    // ADR 0003 Phase 3: the turnEvents blob is retired. Positional slot kept
    // as `undefined` so existing callers don't need reshaping in one PR.
    // TODO follow-up: delete this parameter slot entirely.
    _unused?: undefined,
    extras?: { status?: 'in_progress' | 'complete' | 'interrupted'; turnId?: string }
  ): Promise<ConversationEvent> {
    const event = this.eventStore.append({
      sessionId,
      timestamp: Date.now(),
      type: 'assistant_message',
      content,
      model,
      finishReason,
      usage,
      contentIterations: contentIterations && contentIterations.length > 0 ? contentIterations : undefined,
      status: extras?.status,
      turnId: extras?.turnId
    });

    // ADR 0003 Phase 2: the in_progress placeholder is an internal crash anchor,
    // not a user-visible session update. Skip metadata updates and the sidebar
    // refresh so history doesn't flicker at turn start with empty preview text.
    if (extras?.status !== 'in_progress') {
      this.updateSessionMetadata(sessionId, event);
      this.onSessionsChanged.fire();
    }
    return event;
  }

  /**
   * ADR 0003 Phase 3: fetch all structural_turn_event rows for a turn, ordered
   * by indexInTurn. Used by Phase 3 hydration.
   */
  getStructuralEventsForTurn(sessionId: string, turnId: string): ConversationEvent[] {
    return this.eventStore.getStructuralEventsForTurn(sessionId, turnId);
  }

  /**
   * ADR 0003 Phase 3: fetch all assistant_message rows sharing a turnId.
   * Phase 3 hydration picks the authoritative row (complete > interrupted >
   * in_progress).
   */
  getAssistantMessagesForTurn(sessionId: string, turnId: string): ConversationEvent[] {
    return this.eventStore.getAssistantMessagesForTurn(sessionId, turnId);
  }

  /**
   * ADR 0003 Phase 2: write a single structural turn event to the events table.
   * Called as events fire during streaming so a crash mid-turn still leaves the
   * completed portion on disk. Grouped by `turnId` for hydration.
   */
  recordStructuralEvent(
    sessionId: string,
    turnId: string,
    indexInTurn: number,
    payload: Record<string, unknown>
  ): ConversationEvent {
    return this.eventStore.append({
      sessionId,
      timestamp: Date.now(),
      type: 'structural_turn_event',
      turnId,
      indexInTurn,
      payload
    });
  }

  /**
   * Record reasoning content from R1 model.
   */
  recordAssistantReasoning(sessionId: string, content: string, iteration: number): ConversationEvent {
    return this.eventStore.append({
      sessionId,
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
    sessionId: string,
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>
  ): ConversationEvent {
    return this.eventStore.append({
      sessionId,
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
    sessionId: string,
    toolCallId: string,
    result: string,
    success: boolean,
    duration?: number
  ): ConversationEvent {
    return this.eventStore.append({
      sessionId,
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
    sessionId: string,
    diffId: string,
    filePath: string,
    originalContent: string,
    newContent: string
  ): ConversationEvent {
    return this.eventStore.append({
      sessionId,
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
  recordDiffAccepted(sessionId: string, diffId: string): ConversationEvent {
    return this.eventStore.append({
      sessionId,
      timestamp: Date.now(),
      type: 'diff_accepted',
      diffId
    });
  }

  /**
   * Record a diff being rejected.
   */
  recordDiffRejected(sessionId: string, diffId: string): ConversationEvent {
    return this.eventStore.append({
      sessionId,
      timestamp: Date.now(),
      type: 'diff_rejected',
      diffId
    });
  }

  /**
   * Record a web search.
   */
  recordWebSearch(sessionId: string, query: string, resultCount: number, resultsPreview: string[]): ConversationEvent {
    return this.eventStore.append({
      sessionId,
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
    sessionId: string,
    errorType: 'api' | 'tool' | 'parse' | 'network',
    message: string,
    recoverable: boolean
  ): ConversationEvent {
    return this.eventStore.append({
      sessionId,
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

    // ADR 0003 Phase 2: filter out in_progress placeholder rows. They're
    // written at turn start to anchor structural events for crash recovery,
    // but they carry empty content and must never leak into API context —
    // DeepSeek rejects consecutive assistant messages and empty assistant turns.
    return events
      .filter(e => e.type !== 'assistant_message' || (e as any).status !== 'in_progress')
      .map(e => ({
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
    // ADR 0003 Phase 3: hydration reads turn boundaries from user_message +
    // assistant_message rows, and loads per-turn structural events from the
    // structural_turn_event rows (keyed by turnId). The webview consumes the
    // ordered TurnEvent[] directly — no fragment reconstruction needed.
    //
    // Invariants for assistant turns written in Phase 2+:
    //   - A turn writes one placeholder assistant_message (status='in_progress')
    //     followed by N structural_turn_event rows, then one final
    //     assistant_message (status='complete' | 'interrupted') with the same turnId.
    //   - A crashed turn leaves only the placeholder + partial structural rows;
    //     we synthesize a shutdown-interrupted TurnEvent at hydration time so
    //     the renderer can show a distinct marker.
    const events = this.eventStore.getEventsByType(
      sessionId,
      ['user_message', 'assistant_message']
    );

    // Group assistant_message rows by turnId so we can resolve the authoritative
    // row per turn. Rows without turnId (shouldn't exist post-wipe, but defensive)
    // are keyed by their own event id so they form singleton groups.
    const groupsByTurn = new Map<string, AssistantMessageEvent[]>();
    for (const event of events) {
      if (event.type !== 'assistant_message') continue;
      const msg = event as AssistantMessageEvent;
      const key = msg.turnId ?? msg.id;
      const bucket = groupsByTurn.get(key) ?? [];
      bucket.push(msg);
      groupsByTurn.set(key, bucket);
    }

    const pickAuthoritative = (group: AssistantMessageEvent[]): AssistantMessageEvent => {
      // Prefer 'complete' (shipping the real content), fall back to 'interrupted'
      // (ADR 0001 abort markers), then 'in_progress' (crash recovery — only the
      // placeholder exists). If the group has none of those (legacy rows), take
      // the last by sequence as a best-effort default.
      const byStatus = (s?: string) => [...group].reverse().find(m => m.status === s);
      return (
        byStatus('complete') ||
        byStatus('interrupted') ||
        byStatus('in_progress') ||
        group[group.length - 1]
      );
    };

    const turns: RichHistoryTurn[] = [];
    const emittedTurnIds = new Set<string>();

    for (const event of events) {
      if (event.type === 'user_message') {
        const userEvent = event as UserMessageEvent;
        turns.push({
          role: 'user',
          content: userEvent.content,
          files: userEvent.attachments?.map(a => a.name),
          timestamp: userEvent.timestamp,
          sequence: event.sequence
        });
        continue;
      }

      if (event.type !== 'assistant_message') continue;
      const msg = event as AssistantMessageEvent;
      const key = msg.turnId ?? msg.id;
      // Emit each turn exactly once, at the position of its first row so
      // sequence ordering against user_messages is preserved.
      if (emittedTurnIds.has(key)) continue;
      emittedTurnIds.add(key);

      const group = groupsByTurn.get(key) ?? [msg];
      const authoritative = pickAuthoritative(group);

      let turnEvents: Array<Record<string, unknown>> = [];
      if (msg.turnId) {
        const structural = this.eventStore.getStructuralEventsForTurn(sessionId, msg.turnId);
        turnEvents = structural.map(r => (r as any).payload as Record<string, unknown>);

        // If the turn never finalized (crash recovery: only in_progress rows),
        // synthesize a shutdown-interrupted TurnEvent so the renderer can show
        // a distinct marker. Idempotent — not persisted, always derived from state.
        const onlyInProgress = group.every(m => m.status === 'in_progress');
        if (onlyInProgress && turnEvents.length > 0) {
          const last = turnEvents[turnEvents.length - 1] as any;
          turnEvents.push({
            type: 'shutdown-interrupted',
            iteration: typeof last.iteration === 'number' ? last.iteration : 0,
            ts: Date.now(),
          });
        }
      }

      const turn: RichHistoryTurn = {
        role: 'assistant',
        content: authoritative.content,
        model: authoritative.model,
        timestamp: event.timestamp,
        sequence: event.sequence,
      };
      if (authoritative.contentIterations && authoritative.contentIterations.length > 0) {
        turn.contentIterations = authoritative.contentIterations;
      }
      if (turnEvents.length > 0) {
        turn.turnEvents = turnEvents;
      }
      turns.push(turn);
    }

    logger.debug(
      `[RichHistory] Session ${sessionId}: ${turns.length} turns (${events.length} boundary rows, ${groupsByTurn.size} assistant turns)`
    );
    return turns;
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
          this.recordUserMessage(session.id, msg.content);
        } else {
          this.recordAssistantMessage(session.id, msg.content, session.model, 'stop');
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
  /**
   * Get the most recent user_message and assistant_message sequence numbers.
   * Used to send sequence updates to the webview after saveToHistory().
   */
  getRecentTurnSequences(sessionId: string): { userSequence?: number; assistantSequence?: number } {
    const events = this.eventStore.getEventsByType(sessionId, ['user_message', 'assistant_message']);
    const user = events.filter(e => e.type === 'user_message');
    const asst = events.filter(e => e.type === 'assistant_message');
    return {
      userSequence: user.length > 0 ? user[user.length - 1].sequence : undefined,
      assistantSequence: asst.length > 0 ? asst[asst.length - 1].sequence : undefined,
    };
  }

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

  /**
   * Notify all subscribers that sessions have changed.
   * Called by ChatProvider after session switches or other lifecycle events.
   */
  public notifySessionsChanged(): void {
    this.onSessionsChanged.fire();
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
      lastActivityPreview: row.last_activity_preview,
      parentSessionId: row.parent_session_id ?? undefined,
      forkSequence: row.fork_sequence ?? undefined
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
