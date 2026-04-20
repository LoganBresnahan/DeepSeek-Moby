/**
 * ADR 0003 Phase 3 step 11 — perf smoke test for hydration.
 *
 * Builds a synthetic session with 50 turns × ~200 structural events each
 * (~10,000 rows) and measures getSessionRichHistory() wall-clock. Flags
 * regressions if hydration goes from "fast enough to eager-load" territory
 * into "need per-turn lazy loading" territory.
 *
 * Threshold is deliberately loose — this isn't a benchmark, it's a smoke
 * test. If the number inflates by an order of magnitude we'll know to act.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../../../src/events/SqlJsWrapper';
import { runMigrations } from '../../../src/events/migrations';
import { EventStore } from '../../../src/events/EventStore';
import { ConversationManager } from '../../../src/events/ConversationManager';

describe('Phase 3 hydration perf smoke', () => {
  const SESSION_ID = 'perf-test';
  let db: Database;
  let eventStore: EventStore;
  let callRichHistory: (sid: string) => Promise<any[]>;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.prepare('INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(SESSION_ID, 'Perf', 'deepseek-chat', 1000, 1000);
    eventStore = new EventStore(db);
    const getShr = ConversationManager.prototype.getSessionRichHistory;
    callRichHistory = (sid) => getShr.call({ eventStore } as any, sid);
  });

  it('hydrates 50 turns × 200 events under 2s', async () => {
    const TURNS = 50;
    const EVENTS_PER_TURN = 200;

    for (let t = 0; t < TURNS; t++) {
      const turnId = `turn-${t}`;
      eventStore.append({
        sessionId: SESSION_ID, timestamp: t * 10000,
        type: 'user_message', content: `question ${t}`,
      } as any);
      // Placeholder
      eventStore.append({
        sessionId: SESSION_ID, timestamp: t * 10000 + 1,
        type: 'assistant_message', content: '', model: 'deepseek-chat', finishReason: 'stop',
        status: 'in_progress', turnId,
      } as any);
      for (let i = 0; i < EVENTS_PER_TURN; i++) {
        eventStore.append({
          sessionId: SESSION_ID, timestamp: t * 10000 + 2 + i,
          type: 'structural_turn_event', turnId, indexInTurn: i,
          payload: { type: 'text-append', content: `tok${i} `, iteration: 0, ts: t * 10000 + 2 + i },
        } as any);
      }
      // Final
      eventStore.append({
        sessionId: SESSION_ID, timestamp: t * 10000 + 9999,
        type: 'assistant_message', content: 'final', model: 'deepseek-chat', finishReason: 'stop',
        status: 'complete', turnId,
      } as any);
    }

    const start = Date.now();
    const turns = await callRichHistory(SESSION_ID);
    const elapsedMs = Date.now() - start;

    // eslint-disable-next-line no-console
    console.log(`[Phase3Perf] ${TURNS} turns × ${EVENTS_PER_TURN} events = ${TURNS * EVENTS_PER_TURN} rows hydrated in ${elapsedMs}ms`);

    expect(turns).toHaveLength(TURNS * 2); // user + assistant per turn
    expect(turns.filter((t: any) => t.role === 'assistant')[0].turnEvents.length).toBe(EVENTS_PER_TURN);
    // Loose threshold — real bar is "doesn't feel bad in UI". 2s is a regression signal.
    expect(elapsedMs).toBeLessThan(2000);
  });
});
