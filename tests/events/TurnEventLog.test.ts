import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TurnEventLog, TurnEvent } from '../../media/events/TurnEventLog';

describe('TurnEventLog', () => {
  let log: TurnEventLog;

  beforeEach(() => {
    log = new TurnEventLog();
  });

  // ── Basic Operations ──

  describe('append', () => {
    it('appends events in order', () => {
      log.append({ type: 'text-append', content: 'Hello', iteration: 0, ts: 1 });
      log.append({ type: 'text-append', content: ' World', iteration: 0, ts: 2 });

      const events = log.getAll();
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('text-append');
      expect(events[1].type).toBe('text-append');
      expect((events[0] as any).content).toBe('Hello');
      expect((events[1] as any).content).toBe(' World');
    });

    it('returns the index of the appended event', () => {
      const i0 = log.append({ type: 'text-append', content: 'a', iteration: 0, ts: 1 });
      const i1 = log.append({ type: 'text-append', content: 'b', iteration: 0, ts: 2 });
      const i2 = log.append({ type: 'text-finalize', iteration: 0, ts: 3 });

      expect(i0).toBe(0);
      expect(i1).toBe(1);
      expect(i2).toBe(2);
    });

    it('tracks length correctly', () => {
      expect(log.length).toBe(0);
      log.append({ type: 'text-append', content: 'x', iteration: 0, ts: 1 });
      expect(log.length).toBe(1);
      log.append({ type: 'text-finalize', iteration: 0, ts: 2 });
      expect(log.length).toBe(2);
    });
  });

  describe('get', () => {
    it('returns the event at a given index', () => {
      log.append({ type: 'text-append', content: 'Hello', iteration: 0, ts: 1 });
      log.append({ type: 'shell-start', id: 'sh-1', commands: [{ command: 'ls' }], iteration: 0, ts: 2 });

      expect(log.get(0)?.type).toBe('text-append');
      expect(log.get(1)?.type).toBe('shell-start');
    });

    it('returns undefined for out-of-range index', () => {
      expect(log.get(0)).toBeUndefined();
      expect(log.get(-1)).toBeUndefined();
      expect(log.get(100)).toBeUndefined();
    });
  });

  // ── Causal Insertion ──

  describe('insertCausal', () => {
    it('inserts file-modified after its causing shell-complete', () => {
      log.append({ type: 'shell-start', id: 'sh-1', commands: [{ command: 'cat >> file.txt' }], iteration: 0, ts: 1 });
      log.append({ type: 'shell-complete', id: 'sh-1', results: [{ output: '', success: true }], ts: 2 });
      log.append({ type: 'text-append', content: 'Done!', iteration: 0, ts: 3 });
      log.append({ type: 'text-append', content: ' More text.', iteration: 0, ts: 4 });

      // File notification arrives late
      const insertIndex = log.insertCausal({
        type: 'file-modified', path: 'file.txt', status: 'applied', causedBy: 'sh-1', ts: 5
      });

      expect(insertIndex).toBe(2); // After shell-complete, before text
      const events = log.getAll();
      expect(events).toHaveLength(5);
      expect(events[0].type).toBe('shell-start');
      expect(events[1].type).toBe('shell-complete');
      expect(events[2].type).toBe('file-modified');
      expect(events[3].type).toBe('text-append');
      expect(events[4].type).toBe('text-append');
    });

    it('groups multiple causal events together after the same cause', () => {
      log.append({ type: 'shell-start', id: 'sh-1', commands: [{ command: 'cat >> a.txt' }], iteration: 0, ts: 1 });
      log.append({ type: 'shell-complete', id: 'sh-1', results: [{ output: '', success: true }], ts: 2 });
      log.append({ type: 'text-append', content: 'Done', iteration: 0, ts: 3 });

      // Two files modified by the same shell command
      log.insertCausal({
        type: 'file-modified', path: 'a.txt', status: 'applied', causedBy: 'sh-1', ts: 4
      });
      log.insertCausal({
        type: 'file-modified', path: 'b.txt', status: 'applied', causedBy: 'sh-1', ts: 5
      });

      const events = log.getAll();
      expect(events).toHaveLength(5);
      expect(events[0].type).toBe('shell-start');
      expect(events[1].type).toBe('shell-complete');
      expect(events[2].type).toBe('file-modified');
      expect((events[2] as any).path).toBe('a.txt');
      expect(events[3].type).toBe('file-modified');
      expect((events[3] as any).path).toBe('b.txt');
      expect(events[4].type).toBe('text-append');
    });

    it('falls back to shell-start if shell-complete not yet arrived', () => {
      log.append({ type: 'shell-start', id: 'sh-1', commands: [{ command: 'cat >> file.txt' }], iteration: 0, ts: 1 });
      log.append({ type: 'text-append', content: 'Waiting...', iteration: 0, ts: 2 });

      // File notification arrives before shell-complete (unlikely but possible)
      const insertIndex = log.insertCausal({
        type: 'file-modified', path: 'file.txt', status: 'applied', causedBy: 'sh-1', ts: 3
      });

      expect(insertIndex).toBe(1); // After shell-start, before text
      expect(log.getAll()[1].type).toBe('file-modified');
    });

    it('appends to end if cause not found', () => {
      log.append({ type: 'text-append', content: 'Hello', iteration: 0, ts: 1 });
      log.append({ type: 'text-append', content: 'World', iteration: 0, ts: 2 });

      const insertIndex = log.insertCausal({
        type: 'file-modified', path: 'file.txt', status: 'applied', causedBy: 'unknown-id', ts: 3
      });

      expect(insertIndex).toBe(2); // Appended to end
      expect(log.getAll()).toHaveLength(3);
      expect(log.getAll()[2].type).toBe('file-modified');
    });

    it('handles insertion between two different shells correctly', () => {
      log.append({ type: 'shell-start', id: 'sh-1', commands: [{ command: 'echo a > a.txt' }], iteration: 0, ts: 1 });
      log.append({ type: 'shell-complete', id: 'sh-1', results: [{ output: '', success: true }], ts: 2 });
      log.append({ type: 'shell-start', id: 'sh-2', commands: [{ command: 'echo b > b.txt' }], iteration: 0, ts: 3 });
      log.append({ type: 'shell-complete', id: 'sh-2', results: [{ output: '', success: true }], ts: 4 });
      log.append({ type: 'text-append', content: 'Done', iteration: 0, ts: 5 });

      // File from sh-1 arrives late (after sh-2 already completed)
      log.insertCausal({
        type: 'file-modified', path: 'a.txt', status: 'applied', causedBy: 'sh-1', ts: 6
      });
      // File from sh-2 arrives late
      log.insertCausal({
        type: 'file-modified', path: 'b.txt', status: 'applied', causedBy: 'sh-2', ts: 7
      });

      const events = log.getAll();
      expect(events).toHaveLength(7);
      // sh-1 start, sh-1 complete, a.txt modified, sh-2 start, sh-2 complete, b.txt modified, text
      expect(events[0].type).toBe('shell-start');
      expect((events[0] as any).id).toBe('sh-1');
      expect(events[1].type).toBe('shell-complete');
      expect(events[2].type).toBe('file-modified');
      expect((events[2] as any).path).toBe('a.txt');
      expect(events[3].type).toBe('shell-start');
      expect((events[3] as any).id).toBe('sh-2');
      expect(events[4].type).toBe('shell-complete');
      expect(events[5].type).toBe('file-modified');
      expect((events[5] as any).path).toBe('b.txt');
      expect(events[6].type).toBe('text-append');
    });
  });

  // ── Bulk Load ──

  describe('load', () => {
    it('replaces all events without notifying listeners', () => {
      const listener = vi.fn();
      log.subscribe(listener);

      log.load([
        { type: 'text-append', content: 'Hello', iteration: 0, ts: 1 },
        { type: 'text-finalize', iteration: 0, ts: 2 },
      ]);

      expect(log.getAll()).toHaveLength(2);
      expect(listener).not.toHaveBeenCalled();
    });

    it('replaces existing events', () => {
      log.append({ type: 'text-append', content: 'old', iteration: 0, ts: 1 });
      expect(log.getAll()).toHaveLength(1);

      log.load([
        { type: 'thinking-start', iteration: 0, ts: 1 },
        { type: 'thinking-content', content: 'new', iteration: 0, ts: 2 },
      ]);

      expect(log.getAll()).toHaveLength(2);
      expect(log.getAll()[0].type).toBe('thinking-start');
    });
  });

  // ── Subscriptions ──

  describe('subscribe', () => {
    it('notifies listeners on append', () => {
      const listener = vi.fn();
      log.subscribe(listener);

      const event: TurnEvent = { type: 'text-append', content: 'Hello', iteration: 0, ts: 1 };
      log.append(event);

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(event, 0);
    });

    it('notifies listeners on insertCausal', () => {
      const listener = vi.fn();

      log.append({ type: 'shell-start', id: 'sh-1', commands: [{ command: 'ls' }], iteration: 0, ts: 1 });
      log.append({ type: 'shell-complete', id: 'sh-1', results: [{ output: '', success: true }], ts: 2 });
      log.append({ type: 'text-append', content: 'text', iteration: 0, ts: 3 });

      log.subscribe(listener);

      const event: TurnEvent & { causedBy: string } = {
        type: 'file-modified', path: 'file.txt', status: 'applied', causedBy: 'sh-1', ts: 4
      };
      log.insertCausal(event);

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(event, 2); // Inserted at index 2
    });

    it('supports multiple listeners', () => {
      const l1 = vi.fn();
      const l2 = vi.fn();
      log.subscribe(l1);
      log.subscribe(l2);

      log.append({ type: 'text-append', content: 'x', iteration: 0, ts: 1 });

      expect(l1).toHaveBeenCalledOnce();
      expect(l2).toHaveBeenCalledOnce();
    });

    it('unsubscribe stops notifications', () => {
      const listener = vi.fn();
      const unsub = log.subscribe(listener);

      log.append({ type: 'text-append', content: 'a', iteration: 0, ts: 1 });
      expect(listener).toHaveBeenCalledOnce();

      unsub();

      log.append({ type: 'text-append', content: 'b', iteration: 0, ts: 2 });
      expect(listener).toHaveBeenCalledOnce(); // Still 1, not 2
    });

    it('handles listener errors gracefully', () => {
      const badListener = vi.fn(() => { throw new Error('listener error'); });
      const goodListener = vi.fn();

      log.subscribe(badListener);
      log.subscribe(goodListener);

      // Should not throw
      log.append({ type: 'text-append', content: 'x', iteration: 0, ts: 1 });

      expect(badListener).toHaveBeenCalledOnce();
      expect(goodListener).toHaveBeenCalledOnce(); // Still called despite previous error
    });
  });

  // ── Query Methods ──

  describe('getByIteration', () => {
    it('filters events by iteration', () => {
      log.append({ type: 'text-append', content: 'iter 0', iteration: 0, ts: 1 });
      log.append({ type: 'shell-start', id: 'sh-1', commands: [{ command: 'ls' }], iteration: 0, ts: 2 });
      log.append({ type: 'text-append', content: 'iter 1', iteration: 1, ts: 3 });
      log.append({ type: 'shell-start', id: 'sh-2', commands: [{ command: 'pwd' }], iteration: 1, ts: 4 });
      // shell-complete has no iteration field
      log.append({ type: 'shell-complete', id: 'sh-1', results: [{ output: '', success: true }], ts: 5 });

      const iter0 = log.getByIteration(0);
      expect(iter0).toHaveLength(2);
      expect((iter0[0] as any).content).toBe('iter 0');
      expect((iter0[1] as any).id).toBe('sh-1');

      const iter1 = log.getByIteration(1);
      expect(iter1).toHaveLength(2);
    });

    it('returns empty array for nonexistent iteration', () => {
      log.append({ type: 'text-append', content: 'x', iteration: 0, ts: 1 });
      expect(log.getByIteration(99)).toHaveLength(0);
    });
  });

  describe('getByType', () => {
    it('filters events by type', () => {
      log.append({ type: 'text-append', content: 'a', iteration: 0, ts: 1 });
      log.append({ type: 'text-append', content: 'b', iteration: 0, ts: 2 });
      log.append({ type: 'text-finalize', iteration: 0, ts: 3 });
      log.append({ type: 'shell-start', id: 'sh-1', commands: [{ command: 'ls' }], iteration: 0, ts: 4 });

      const textEvents = log.getByType('text-append');
      expect(textEvents).toHaveLength(2);
      expect(textEvents[0].content).toBe('a');
      expect(textEvents[1].content).toBe('b');

      const shellEvents = log.getByType('shell-start');
      expect(shellEvents).toHaveLength(1);
      expect(shellEvents[0].id).toBe('sh-1');
    });
  });

  describe('findIndexById', () => {
    it('finds shell-start by id', () => {
      log.append({ type: 'text-append', content: 'x', iteration: 0, ts: 1 });
      log.append({ type: 'shell-start', id: 'sh-42', commands: [{ command: 'ls' }], iteration: 0, ts: 2 });

      expect(log.findIndexById('sh-42')).toBe(1);
    });

    it('finds approval-created by id', () => {
      log.append({ type: 'approval-created', id: 'ap-1', command: 'rm -rf', prefix: 'rm', shellId: 'sh-1', ts: 1 });
      expect(log.findIndexById('ap-1')).toBe(0);
    });

    it('returns -1 for unknown id', () => {
      log.append({ type: 'text-append', content: 'x', iteration: 0, ts: 1 });
      expect(log.findIndexById('nonexistent')).toBe(-1);
    });
  });

  // ── Clear ──

  describe('clear', () => {
    it('removes all events and listeners', () => {
      const listener = vi.fn();
      log.subscribe(listener);
      log.append({ type: 'text-append', content: 'x', iteration: 0, ts: 1 });
      expect(log.length).toBe(1);

      log.clear();
      expect(log.length).toBe(0);
      expect(log.getAll()).toHaveLength(0);

      // Listener was cleared too
      log.append({ type: 'text-append', content: 'y', iteration: 0, ts: 2 });
      expect(listener).toHaveBeenCalledOnce(); // Only the first call, not the second
    });
  });

  // ── Complex Scenarios ──

  describe('realistic streaming scenario', () => {
    it('handles a full R1 iteration with thinking, text, shell, approval, and file modification', () => {
      // Iteration 0: thinking → text → shell (needs approval) → approval → shell results → file modified
      log.append({ type: 'thinking-start', iteration: 0, ts: 1 });
      log.append({ type: 'thinking-content', content: 'Let me check...', iteration: 0, ts: 2 });
      log.append({ type: 'thinking-complete', iteration: 0, ts: 3 });
      log.append({ type: 'text-append', content: 'I\'ll add an animal.', iteration: 0, ts: 4 });
      log.append({ type: 'text-finalize', iteration: 0, ts: 5 });
      log.append({ type: 'shell-start', id: 'sh-1', commands: [{ command: 'cat >> animals.txt' }], iteration: 0, ts: 6 });
      log.append({ type: 'approval-created', id: 'ap-1', command: 'cat >> animals.txt', prefix: 'cat >>', shellId: 'sh-1', ts: 7 });
      log.append({ type: 'approval-resolved', id: 'ap-1', decision: 'allowed', persistent: true, ts: 8 });
      log.append({ type: 'shell-complete', id: 'sh-1', results: [{ output: '', success: true }], ts: 9 });

      // File notification arrives late
      log.insertCausal({
        type: 'file-modified', path: 'animals.txt', status: 'applied', causedBy: 'sh-1', ts: 10
      });

      // Iteration 1: thinking → text (conclusion)
      log.append({ type: 'thinking-start', iteration: 1, ts: 11 });
      log.append({ type: 'thinking-content', content: 'Task complete.', iteration: 1, ts: 12 });
      log.append({ type: 'thinking-complete', iteration: 1, ts: 13 });
      log.append({ type: 'text-append', content: 'Done! Porcupine added.', iteration: 1, ts: 14 });

      const events = log.getAll();
      expect(events).toHaveLength(14);

      // Verify causal ordering: file-modified is after shell-complete, before thinking-start of iter 1
      const fileModifiedIndex = events.findIndex(e => e.type === 'file-modified');
      const shellCompleteIndex = events.findIndex(e => e.type === 'shell-complete');
      const thinkingIter1Index = events.findIndex(e => e.type === 'thinking-start' && e.iteration === 1);

      expect(fileModifiedIndex).toBeGreaterThan(shellCompleteIndex);
      expect(fileModifiedIndex).toBeLessThan(thinkingIter1Index);

      // Verify iteration filtering
      const iter0 = log.getByIteration(0);
      expect(iter0.length).toBeGreaterThanOrEqual(5); // thinking, text, shell events

      const iter1 = log.getByIteration(1);
      expect(iter1.length).toBeGreaterThanOrEqual(3); // thinking + text events
    });

    it('handles Chat model flow with tool calls', () => {
      log.append({ type: 'tool-batch-start', tools: [{ name: 'read_file', detail: 'Reading...' }], ts: 1 });
      log.append({ type: 'tool-update', index: 0, status: 'done', ts: 2 });
      log.append({ type: 'tool-batch-complete', ts: 3 });
      log.append({ type: 'text-append', content: 'Here are the results.', iteration: 0, ts: 4 });

      expect(log.getAll()).toHaveLength(4);
      expect(log.getByType('tool-batch-start')).toHaveLength(1);
      expect(log.getByType('tool-update')).toHaveLength(1);
    });
  });
});
