import { describe, it, expect, beforeEach } from 'vitest';
import { StructuralEventRecorder } from '../../../src/events/StructuralEventRecorder';
import type { TurnEvent } from '../../../shared/events/TurnEvent';

describe('StructuralEventRecorder', () => {
  let r: StructuralEventRecorder;

  beforeEach(() => {
    r = new StructuralEventRecorder();
  });

  it('append() is a no-op when no turn is active', () => {
    r.append({ type: 'iteration-end', iteration: 0, ts: 1 });
    expect(r.size()).toBe(0);
    expect(r.peekCurrent()).toBeNull();
  });

  it('records appended events in order within a turn', () => {
    r.startTurn('turn-1', 'session-a');
    const events: TurnEvent[] = [
      { type: 'thinking-start', iteration: 0, ts: 1 },
      { type: 'thinking-content', content: 'reasoning', iteration: 0, ts: 2 },
      { type: 'thinking-complete', iteration: 0, ts: 3 },
      { type: 'text-append', content: 'hello', iteration: 0, ts: 4 },
      { type: 'iteration-end', iteration: 0, ts: 5 },
    ];
    for (const e of events) r.append(e);

    expect(r.size()).toBe(5);
    expect(r.peekCurrent()?.events).toEqual(events);
  });

  it('drainTurn() returns the finalized turn and clears current', () => {
    r.startTurn('turn-1', 'session-a');
    r.append({ type: 'text-append', content: 'x', iteration: 0, ts: 1 });

    const drained = r.drainTurn();

    expect(drained?.turnId).toBe('turn-1');
    expect(drained?.sessionId).toBe('session-a');
    expect(drained?.events).toHaveLength(1);
    expect(drained?.endedAt).toBeGreaterThan(0);
    expect(r.peekCurrent()).toBeNull();
  });

  it('drainTurn() stores the last completed turn for later inspection', () => {
    r.startTurn('turn-1', 'session-a');
    r.append({ type: 'iteration-end', iteration: 0, ts: 1 });
    r.drainTurn();

    const last = r.peekLastCompleted();
    expect(last?.turnId).toBe('turn-1');
    expect(last?.events).toHaveLength(1);
  });

  it('starting a new turn discards any in-progress events without draining', () => {
    r.startTurn('turn-1', 'session-a');
    r.append({ type: 'text-append', content: 'orphan', iteration: 0, ts: 1 });
    r.startTurn('turn-2', 'session-a');

    expect(r.size()).toBe(0);
    expect(r.peekLastCompleted()).toBeNull(); // turn-1 was never drained
  });

  it('peekCurrent() returns a defensive copy — mutating the result does not affect state', () => {
    r.startTurn('turn-1', 'session-a');
    r.append({ type: 'text-append', content: 'a', iteration: 0, ts: 1 });

    const snap = r.peekCurrent();
    snap?.events.push({ type: 'text-append', content: 'b', iteration: 0, ts: 2 });

    expect(r.size()).toBe(1);
  });

  it('drainTurn() returns null when no turn is active', () => {
    expect(r.drainTurn()).toBeNull();
  });

  it('reset() clears both current and lastCompleted', () => {
    r.startTurn('turn-1', 'session-a');
    r.append({ type: 'iteration-end', iteration: 0, ts: 1 });
    r.drainTurn();
    r.startTurn('turn-2', 'session-a');
    r.append({ type: 'iteration-end', iteration: 1, ts: 2 });

    r.reset();

    expect(r.peekCurrent()).toBeNull();
    expect(r.peekLastCompleted()).toBeNull();
  });
});
