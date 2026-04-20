/**
 * StructuralEventRecorder — in-memory accumulator for structural turn events
 * emitted by the extension during a single turn.
 *
 * Per ADR 0003, the extension authors structural events (code-block boundaries,
 * iteration ends, approvals, shell lifecycle, drawings) rather than having the
 * webview parse them out of the rendered stream. This class is the extension-side
 * collection point. Phase 1 uses it to power the "Export Turn as JSON" debug
 * command and fidelity tests. Phase 2 will persist these events incrementally.
 * Phase 3 retires the webview's parallel CQRS blob entirely.
 *
 * Scope rules:
 *  - One recorder per turn. Call startTurn() on turn start, drainTurn() at end.
 *  - No dependencies on vscode or DOM — pure TypeScript.
 *  - Appends are synchronous and ordered by arrival.
 */

import type { TurnEvent } from '../../shared/events/TurnEvent';

export interface RecordedTurn {
  turnId: string;
  sessionId: string | null;
  startedAt: number;
  endedAt: number | null;
  events: TurnEvent[];
}

export class StructuralEventRecorder {
  private _current: RecordedTurn | null = null;
  private _lastCompleted: RecordedTurn | null = null;

  /** Begin a new turn. Any previous in-flight turn is discarded (should not happen in practice). */
  startTurn(turnId: string, sessionId: string | null): void {
    this._current = {
      turnId,
      sessionId,
      startedAt: Date.now(),
      endedAt: null,
      events: [],
    };
  }

  /** Append a structural event to the current turn. No-op if no turn is active. */
  append(event: TurnEvent): void {
    if (!this._current) return;
    this._current.events.push(event);
  }

  /** Number of events recorded in the current turn, or 0 if no turn active. */
  size(): number {
    return this._current?.events.length ?? 0;
  }

  /** Finalize the current turn, moving it to lastCompleted. Returns the drained turn. */
  drainTurn(): RecordedTurn | null {
    if (!this._current) return null;
    this._current.endedAt = Date.now();
    this._lastCompleted = this._current;
    this._current = null;
    return this._lastCompleted;
  }

  /** Read-only snapshot of the in-progress turn (for debug commands). */
  peekCurrent(): RecordedTurn | null {
    if (!this._current) return null;
    return { ...this._current, events: [...this._current.events] };
  }

  /** Read-only snapshot of the most recently completed turn. */
  peekLastCompleted(): RecordedTurn | null {
    if (!this._lastCompleted) return null;
    return { ...this._lastCompleted, events: [...this._lastCompleted.events] };
  }

  /** Reset all state — for tests only. */
  reset(): void {
    this._current = null;
    this._lastCompleted = null;
  }
}
