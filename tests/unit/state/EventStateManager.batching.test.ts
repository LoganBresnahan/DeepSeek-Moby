/**
 * Regression tests for the rAF-batched broadcast path (batchBroadcasts: true,
 * the production default). The rest of the suite runs in synchronous mode, which
 * cannot exercise the merge-across-sources logic in flushPendingBroadcasts.
 *
 * Bug: flushPendingBroadcasts merged changedKeys from every pending entry but
 * broadcast them all under a single `lastSource`, so an actor that co-published
 * ANY key in the same frame was wrongly skipped for keys OTHER actors published.
 * Failure mode in the app: opening the History modal (actor publishes
 * `history.modal.visible`) in the same frame as an incoming `history.sessions`
 * push made the list actor miss the data — the list stayed stale until a reopen.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventStateManager } from '../../../media/state/EventStateManager';
import type { StateChangeEvent } from '../../../media/state/types';

function nextFrames(n = 2): Promise<void> {
  return new Promise(resolve => {
    let i = 0;
    const step = () => (++i >= n ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
}

describe('EventStateManager batched broadcasts', () => {
  let manager: EventStateManager;

  beforeEach(() => {
    manager = new EventStateManager({ batchBroadcasts: true });
  });

  it('delivers a key to a subscriber even when that subscriber co-publishes another key in the same frame', async () => {
    const el = document.createElement('div');
    const received: string[] = [];
    el.addEventListener('state-changed', ((e: CustomEvent<StateChangeEvent>) => {
      received.push(...e.detail.changedKeys);
    }) as EventListener);

    manager.register({
      actorId: 'history',
      element: el,
      publicationKeys: ['history.modal.visible'],
      subscriptionKeys: ['history.sessions'],
    }, {});

    // Same synchronous tick → both land in one rAF batch.
    // External pushes the data the actor subscribes to...
    manager.publishDirect('history.sessions', [1, 2, 3], 'external');
    // ...and the actor itself publishes an unrelated key (as open() does).
    manager.publishDirect('history.modal.visible', true, 'history');

    await nextFrames();

    // The actor must still be notified of the external key it subscribes to.
    expect(received).toContain('history.sessions');
  });

  it('still does not echo an actor its own publish', async () => {
    const el = document.createElement('div');
    const received: string[] = [];
    el.addEventListener('state-changed', ((e: CustomEvent<StateChangeEvent>) => {
      received.push(...e.detail.changedKeys);
    }) as EventListener);

    manager.register({
      actorId: 'self',
      element: el,
      publicationKeys: ['self.key'],
      subscriptionKeys: ['self.key', 'other.key'],
    }, {});

    manager.publishDirect('self.key', 1, 'self');       // own publish — must NOT echo back
    manager.publishDirect('other.key', 2, 'external');  // external — must be delivered

    await nextFrames();

    expect(received).toContain('other.key');
    expect(received).not.toContain('self.key');
  });
});
