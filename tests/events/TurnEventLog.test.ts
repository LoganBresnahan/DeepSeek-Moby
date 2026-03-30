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

  describe('consolidateForSave', () => {
    it('merges consecutive text-append events into single content block', () => {
      log.append({ type: 'text-append', content: 'Hello', iteration: 0, ts: 1 });
      log.append({ type: 'text-append', content: ' ', iteration: 0, ts: 2 });
      log.append({ type: 'text-append', content: 'world', iteration: 0, ts: 3 });
      log.append({ type: 'text-finalize', iteration: 0, ts: 4 });

      const consolidated = log.consolidateForSave();
      expect(consolidated).toHaveLength(2);
      expect(consolidated[0]).toEqual({ type: 'text-append', content: 'Hello world', iteration: 0, ts: 1 });
      expect(consolidated[1]).toEqual({ type: 'text-finalize', iteration: 0, ts: 4 });
    });

    it('merges consecutive thinking-content events into single block', () => {
      log.append({ type: 'thinking-start', iteration: 0, ts: 1 });
      log.append({ type: 'thinking-content', content: 'Let me ', iteration: 0, ts: 2 });
      log.append({ type: 'thinking-content', content: 'think about ', iteration: 0, ts: 3 });
      log.append({ type: 'thinking-content', content: 'this.', iteration: 0, ts: 4 });
      log.append({ type: 'thinking-complete', iteration: 0, ts: 5 });

      const consolidated = log.consolidateForSave();
      expect(consolidated).toHaveLength(3);
      expect(consolidated[0]).toEqual({ type: 'thinking-start', iteration: 0, ts: 1 });
      expect(consolidated[1]).toEqual({ type: 'thinking-content', content: 'Let me think about this.', iteration: 0, ts: 2 });
      expect(consolidated[2]).toEqual({ type: 'thinking-complete', iteration: 0, ts: 5 });
    });

    it('preserves structural events (shell, approval, file-modified)', () => {
      log.append({ type: 'text-append', content: 'Before', iteration: 0, ts: 1 });
      log.append({ type: 'text-finalize', iteration: 0, ts: 2 });
      log.append({ type: 'shell-start', id: 'sh-1', commands: [{ command: 'ls' }], iteration: 0, ts: 3 });
      log.append({ type: 'approval-created', id: 'ap-1', command: 'rm -rf', prefix: 'bash', shellId: 'sh-1', ts: 4 });
      log.append({ type: 'approval-resolved', id: 'ap-1', decision: 'allowed', persistent: false, ts: 5 });
      log.append({ type: 'shell-complete', id: 'sh-1', results: [{ output: 'ok', success: true }], ts: 6 });
      log.append({ type: 'file-modified', path: 'test.txt', status: 'applied', ts: 7 });
      log.append({ type: 'text-append', content: 'After', iteration: 0, ts: 8 });

      const consolidated = log.consolidateForSave();
      expect(consolidated).toHaveLength(8); // All events preserved, text not merged across structural boundaries
      expect(consolidated[0]).toEqual({ type: 'text-append', content: 'Before', iteration: 0, ts: 1 });
      expect(consolidated[2].type).toBe('shell-start');
      expect(consolidated[3].type).toBe('approval-created');
      expect(consolidated[4].type).toBe('approval-resolved');
      expect(consolidated[5].type).toBe('shell-complete');
      expect(consolidated[6].type).toBe('file-modified');
      expect(consolidated[7]).toEqual({ type: 'text-append', content: 'After', iteration: 0, ts: 8 });
    });

    it('handles R1 multi-iteration flow with many tokens', () => {
      // Simulate 100 thinking tokens + 50 text tokens per iteration, 2 iterations
      log.append({ type: 'thinking-start', iteration: 0, ts: 1 });
      for (let i = 0; i < 100; i++) {
        log.append({ type: 'thinking-content', content: `t${i} `, iteration: 0, ts: 2 + i });
      }
      log.append({ type: 'thinking-complete', iteration: 0, ts: 103 });
      for (let i = 0; i < 50; i++) {
        log.append({ type: 'text-append', content: `w${i} `, iteration: 0, ts: 104 + i });
      }
      log.append({ type: 'text-finalize', iteration: 0, ts: 155 });

      log.append({ type: 'shell-start', id: 'sh-1', commands: [{ command: 'echo hi' }], iteration: 0, ts: 156 });
      log.append({ type: 'shell-complete', id: 'sh-1', results: [{ output: 'hi', success: true }], ts: 157 });

      log.append({ type: 'thinking-start', iteration: 1, ts: 158 });
      for (let i = 0; i < 100; i++) {
        log.append({ type: 'thinking-content', content: `r${i} `, iteration: 1, ts: 159 + i });
      }
      log.append({ type: 'thinking-complete', iteration: 1, ts: 260 });
      for (let i = 0; i < 50; i++) {
        log.append({ type: 'text-append', content: `x${i} `, iteration: 1, ts: 261 + i });
      }

      expect(log.length).toBe(307); // Many per-token events
      const consolidated = log.consolidateForSave();
      // Should be: thinking-start, thinking-content(merged), thinking-complete, text-append(merged), text-finalize,
      //            shell-start, shell-complete,
      //            thinking-start, thinking-content(merged), thinking-complete, text-append(merged)
      expect(consolidated).toHaveLength(11);
      expect(consolidated[1].type).toBe('thinking-content');
      expect((consolidated[1] as any).content).toContain('t0');
      expect((consolidated[1] as any).content).toContain('t99');
      expect(consolidated[3].type).toBe('text-append');
      expect((consolidated[3] as any).content).toContain('w0');
      expect((consolidated[3] as any).content).toContain('w49');
    });

    it('flushes text across iteration boundaries', () => {
      log.append({ type: 'text-append', content: 'iter0 text', iteration: 0, ts: 1 });
      log.append({ type: 'text-append', content: 'iter1 text', iteration: 1, ts: 2 });

      const consolidated = log.consolidateForSave();
      expect(consolidated).toHaveLength(2);
      expect(consolidated[0]).toEqual({ type: 'text-append', content: 'iter0 text', iteration: 0, ts: 1 });
      expect(consolidated[1]).toEqual({ type: 'text-append', content: 'iter1 text', iteration: 1, ts: 2 });
    });

    it('flushes thinking before text when structural event interrupts both buffers', () => {
      // Simulates R1 flow: thinking tokens arrive first, then text tokens,
      // then a structural event (file-modified) forces both buffers to flush.
      // Thinking started earlier (ts=1) so it should be flushed before text (ts=100).
      log.append({ type: 'thinking-start', iteration: 0, ts: 0 });
      log.append({ type: 'thinking-content', content: 'reasoning...', iteration: 0, ts: 1 });
      log.append({ type: 'text-append', content: 'response text', iteration: 0, ts: 100 });
      log.append({ type: 'file-modified', path: 'test.txt', status: 'applied', ts: 101 });

      const consolidated = log.consolidateForSave();
      // thinking-start, thinking-content, text-append, file-modified (thinking before text)
      expect(consolidated).toHaveLength(4);
      expect(consolidated[0].type).toBe('thinking-start');
      expect(consolidated[1].type).toBe('thinking-content');
      expect(consolidated[2].type).toBe('text-append');
      expect(consolidated[3].type).toBe('file-modified');
    });

    it('returns empty array for empty log', () => {
      expect(log.consolidateForSave()).toEqual([]);
    });
  });
});
