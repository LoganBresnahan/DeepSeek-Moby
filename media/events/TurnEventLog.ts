/**
 * TurnEventLog — In-memory append-only event log for a single turn.
 *
 * Every action within a turn (text tokens, shell commands, approvals, file changes,
 * thinking iterations, tool calls) is recorded as an event. The projector reads
 * this log to produce the UI view model.
 *
 * Key capabilities:
 * - append(): Normal ordered insertion (streaming events)
 * - insertCausal(): Insert at the correct position based on causedBy reference
 *   (for late-arriving async events like file watcher notifications)
 * - load(): Bulk import events (for history restore)
 * - subscribe(): Listen for new events (for live incremental projection)
 */

import { createLogger } from '../logging';

const log = createLogger('TurnEventLog');

// ── Shell Command Types ──

export interface ShellCommand {
  command: string;
  description?: string;
}

export interface ShellResultData {
  output: string;
  success: boolean;
  executionTimeMs?: number;
}

// ── Tool Call Types ──

export interface ToolCallData {
  name: string;
  detail: string;
}

// ── Turn Event Types ──

export type TurnEvent =
  // Text content
  | { type: 'text-append'; content: string; iteration: number; ts: number }
  | { type: 'text-finalize'; iteration: number; ts: number }

  // Thinking (R1 reasoning)
  | { type: 'thinking-start'; iteration: number; ts: number }
  | { type: 'thinking-content'; content: string; iteration: number; ts: number }
  | { type: 'thinking-complete'; iteration: number; ts: number }

  // Shell commands
  | { type: 'shell-start'; id: string; commands: ShellCommand[]; iteration: number; ts: number }
  | { type: 'shell-complete'; id: string; results: ShellResultData[]; ts: number }

  // Command approval
  | { type: 'approval-created'; id: string; command: string; prefix: string; shellId: string; ts: number }
  | { type: 'approval-resolved'; id: string; decision: 'allowed' | 'blocked'; persistent: boolean; ts: number }

  // File modifications (from shell or diff engine)
  | { type: 'file-modified'; path: string; status: string; editMode?: string; causedBy?: string; ts: number }

  // Tool calls (Chat model)
  | { type: 'tool-batch-start'; tools: ToolCallData[]; ts: number }
  | { type: 'tool-batch-update'; tools: Array<ToolCallData & { status?: string }>; ts: number }
  | { type: 'tool-update'; index: number; status: string; ts: number }
  | { type: 'tool-batch-complete'; ts: number }

  // Code blocks (rendered separately from text)
  | { type: 'code-block'; language: string; content: string; file?: string; iteration: number; ts: number }

  // Drawing
  | { type: 'drawing'; imageDataUrl: string; ts: number };

// ── Listener Type ──

export type TurnEventListener = (event: TurnEvent, index: number) => void;

// ── TurnEventLog ──

export class TurnEventLog {
  private _events: TurnEvent[] = [];
  private _listeners: TurnEventListener[] = [];
  private _turnId: string;

  constructor(turnId: string = 'unknown') {
    this._turnId = turnId;
  }

  /** Number of events in the log. */
  get length(): number {
    return this._events.length;
  }

  /** Summarize an event for logging (type + key fields, no large content). */
  private summarizeEvent(event: TurnEvent): string {
    switch (event.type) {
      case 'text-append':
        return `text-append(iter=${event.iteration}, len=${event.content.length})`;
      case 'text-finalize':
        return `text-finalize(iter=${event.iteration})`;
      case 'thinking-start':
        return `thinking-start(iter=${event.iteration})`;
      case 'thinking-content':
        return `thinking-content(iter=${event.iteration}, len=${event.content.length})`;
      case 'thinking-complete':
        return `thinking-complete(iter=${event.iteration})`;
      case 'shell-start':
        return `shell-start(id=${event.id}, cmd="${event.commands[0]?.command.substring(0, 40)}")`;
      case 'shell-complete':
        return `shell-complete(id=${event.id}, success=${event.results[0]?.success})`;
      case 'approval-created':
        return `approval-created(id=${event.id}, cmd="${event.command.substring(0, 40)}")`;
      case 'approval-resolved':
        return `approval-resolved(id=${event.id}, decision=${event.decision})`;
      case 'file-modified':
        return `file-modified(path=${event.path}, status=${event.status}, causedBy=${event.causedBy ?? 'none'})`;
      case 'tool-batch-start':
        return `tool-batch-start(${event.tools.length} tools)`;
      case 'tool-batch-update':
        return `tool-batch-update(${event.tools.length} tools)`;
      case 'tool-update':
        return `tool-update(idx=${event.index}, status=${event.status})`;
      case 'tool-batch-complete':
        return `tool-batch-complete`;
      case 'code-block':
        return `code-block(lang=${event.language})`;
      case 'drawing':
        return `drawing`;
      default:
        return (event as any).type;
    }
  }

  /**
   * Append an event to the end of the log (normal streaming order).
   * Notifies all listeners.
   * @returns The index of the appended event.
   */
  append(event: TurnEvent): number {
    const index = this._events.length;
    this._events.push(event);

    // Log non-text-append events (text-append is too frequent)
    if (event.type !== 'text-append' && event.type !== 'thinking-content') {
      log.debug(`[${this._turnId}] append[${index}]: ${this.summarizeEvent(event)}`);
    }

    this.notify(event, index);
    return index;
  }

  /**
   * Insert an event at the correct causal position.
   *
   * For events with a `causedBy` field (e.g., file-modified caused by a shell command),
   * finds the corresponding shell-complete event and inserts immediately after it.
   * If the causing event is not found, appends to the end.
   *
   * This handles the async timing problem: file watcher notifications arrive after
   * the shell command completes, but may arrive after subsequent text/thinking events
   * have already been appended. Causal insertion places the file-modified event in
   * the correct semantic position.
   *
   * Notifies listeners with the insertion index.
   * @returns The index where the event was inserted.
   */
  insertCausal(event: TurnEvent & { causedBy: string }): number {
    const causeId = event.causedBy;

    // Find the shell-complete event that caused this
    let insertAfterIndex = -1;
    for (let i = this._events.length - 1; i >= 0; i--) {
      const e = this._events[i];
      if (e.type === 'shell-complete' && e.id === causeId) {
        insertAfterIndex = i;
        break;
      }
    }

    if (insertAfterIndex === -1) {
      // Cause not found — check for shell-start as fallback
      for (let i = this._events.length - 1; i >= 0; i--) {
        const e = this._events[i];
        if (e.type === 'shell-start' && e.id === causeId) {
          insertAfterIndex = i;
          break;
        }
      }
    }

    if (insertAfterIndex === -1) {
      // No cause found at all — append to end
      return this.append(event);
    }

    // Insert after the causing event (and any other causal events already there)
    // Walk forward past any file-modified events that share the same causedBy
    let insertIndex = insertAfterIndex + 1;
    while (insertIndex < this._events.length) {
      const existing = this._events[insertIndex];
      if (existing.type === 'file-modified' && 'causedBy' in existing && existing.causedBy === causeId) {
        insertIndex++;
      } else {
        break;
      }
    }

    this._events.splice(insertIndex, 0, event);
    log.debug(`[${this._turnId}] insertCausal[${insertIndex}]: ${this.summarizeEvent(event)} (after cause at ${insertAfterIndex})`);
    this.notify(event, insertIndex);
    return insertIndex;
  }

  /**
   * Bulk load events without notifying listeners.
   * Used for history restore — all events are loaded at once,
   * then the projector does a full projection.
   */
  load(events: TurnEvent[]): void {
    this._events = [...events];
    log.debug(`[${this._turnId}] load: ${events.length} events — [${events.map(e => this.summarizeEvent(e)).join(', ')}]`);
  }

  /**
   * Subscribe to new events.
   * The listener is called for every append() and insertCausal() call.
   * @returns An unsubscribe function.
   */
  subscribe(listener: TurnEventListener): () => void {
    this._listeners.push(listener);
    return () => {
      const index = this._listeners.indexOf(listener);
      if (index !== -1) {
        this._listeners.splice(index, 1);
      }
    };
  }

  /** Get all events in order. */
  getAll(): readonly TurnEvent[] {
    return this._events;
  }

  /** Get the event at a specific index. */
  get(index: number): TurnEvent | undefined {
    return this._events[index];
  }

  /** Get events filtered by iteration. */
  getByIteration(iteration: number): TurnEvent[] {
    return this._events.filter(e => 'iteration' in e && (e as any).iteration === iteration);
  }

  /** Get events filtered by type. */
  getByType<T extends TurnEvent['type']>(type: T): Array<Extract<TurnEvent, { type: T }>> {
    return this._events.filter(e => e.type === type) as Array<Extract<TurnEvent, { type: T }>>;
  }

  /** Find the index of an event by its id field (for shell-start, shell-complete, approval-created, etc.) */
  findIndexById(id: string): number {
    return this._events.findIndex(e => 'id' in e && (e as any).id === id);
  }

  /** Clear all events and listeners. */
  clear(): void {
    this._events = [];
    this._listeners = [];
  }

  /**
   * Consolidate the event log for DB persistence.
   *
   * Merges per-token text-append events into single content blocks per segment,
   * merges per-token thinking-content events into single blocks per iteration,
   * and keeps all structural events (shell, approval, file-modified, tool, etc.) as-is.
   *
   * Reduces ~2000+ streaming events to ~20-50 structural events while preserving
   * all information needed by the projector to reconstruct the turn.
   */
  consolidateForSave(): TurnEvent[] {
    // Sort events by timestamp before consolidation. During R1 streaming,
    // events can arrive at the webview out of order (thinking-content after
    // text-append due to message queue timing). Sorting ensures consolidation
    // processes events in the correct semantic order.
    const sorted = [...this._events].sort((a, b) => a.ts - b.ts);

    const result: TurnEvent[] = [];
    let textBuf = '';
    let textIter = -1;
    let textTs = 0;
    let thinkBuf = '';
    let thinkIter = -1;
    let thinkTs = 0;
    // file-modified events that arrived mid-text are deferred until text ends.
    // During live streaming, these appear as dropdowns below the current text,
    // not splitting it. Deferring in consolidation preserves this ordering.
    let deferredFileModified: TurnEvent[] = [];

    const flushText = () => {
      if (textBuf) {
        result.push({ type: 'text-append', content: textBuf, iteration: textIter, ts: textTs });
        textBuf = '';
        textIter = -1;
      }
      // Emit any deferred file-modified events after text
      if (deferredFileModified.length > 0) {
        result.push(...deferredFileModified);
        deferredFileModified = [];
      }
    };

    const flushThinking = () => {
      if (thinkBuf) {
        result.push({ type: 'thinking-content', content: thinkBuf, iteration: thinkIter, ts: thinkTs });
        thinkBuf = '';
        thinkIter = -1;
      }
    };

    for (const event of sorted) {
      switch (event.type) {
        case 'text-append':
          if (event.iteration !== textIter && textBuf) {
            flushText();
          }
          if (!textBuf) {
            textTs = event.ts;
          }
          textBuf += event.content;
          textIter = event.iteration;
          break;

        case 'text-finalize':
          flushText();
          result.push(event);
          break;

        case 'thinking-content':
          if (event.iteration !== thinkIter && thinkBuf) {
            flushThinking();
          }
          if (!thinkBuf) {
            thinkTs = event.ts;
          }
          thinkBuf += event.content;
          thinkIter = event.iteration;
          break;

        case 'thinking-start':
        case 'thinking-complete':
          flushThinking();
          flushText();
          result.push(event);
          break;

        case 'file-modified':
          // Defer until text ends — during live streaming the dropdown appears
          // below the current text, not splitting it mid-sentence.
          if (textBuf) {
            deferredFileModified.push(event);
          } else {
            result.push(event);
          }
          break;

        default:
          // Structural event — flush any accumulated buffers first
          // Flush in timestamp order so thinking (which starts before text) is emitted first
          if (thinkBuf && textBuf) {
            if (thinkTs <= textTs) { flushThinking(); flushText(); }
            else { flushText(); flushThinking(); }
          } else {
            flushThinking();
            flushText();
          }
          result.push(event);
          break;
      }
    }

    // Flush remaining (timestamp order)
    if (thinkBuf && textBuf) {
      if (thinkTs <= textTs) { flushThinking(); flushText(); }
      else { flushText(); flushThinking(); }
    } else {
      flushThinking();
      flushText();
    }

    return result;
  }

  /** Notify all listeners of a new event. */
  private notify(event: TurnEvent, index: number): void {
    for (const listener of this._listeners) {
      try {
        listener(event, index);
      } catch (err) {
        console.error('[TurnEventLog] Listener error:', err);
      }
    }
  }
}
