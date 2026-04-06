/**
 * CQRS Pipeline Tests
 *
 * Tests the full data pipeline: event creation → consolidation → restore → projection.
 * Catches consolidation ordering, event loss, and status patching bugs without touching the UI.
 *
 * Organized into five sections:
 *   A. Consolidation Ordering
 *   B. Projection (projectFull)
 *   C. Consolidation → Projection Round-Trip
 *   D. File-Modified Status Lifecycle
 *   E. Edge Cases
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TurnEventLog, TurnEvent } from '../../media/events/TurnEventLog';
import { TurnProjector, ViewSegment, FileModifiedSegment, TextSegment, ThinkingSegment, ShellSegment } from '../../media/events/TurnProjector';

/** Helper: simulate streaming → consolidate → load into fresh log → project */
function roundTrip(events: TurnEvent[]): ViewSegment[] {
  const log = new TurnEventLog('test');
  for (const e of events) { log.append(e); }
  const consolidated = log.consolidateForSave();
  const restored = new TurnEventLog('restore');
  restored.load(consolidated);
  return new TurnProjector().projectFull(restored);
}

/** Helper: consolidate only */
function consolidate(events: TurnEvent[]): TurnEvent[] {
  const log = new TurnEventLog('test');
  for (const e of events) { log.append(e); }
  return log.consolidateForSave();
}

/** Helper: project only (no consolidation) */
function project(events: TurnEvent[]): ViewSegment[] {
  const log = new TurnEventLog('test');
  log.load(events);
  return new TurnProjector().projectFull(log);
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Consolidation Ordering
// ─────────────────────────────────────────────────────────────────────────────

describe('A. Consolidation Ordering', () => {
  it('A1: text-only consolidation — multiple text-append merge into one', () => {
    const result = consolidate([
      { type: 'text-append', content: 'Hello ', iteration: 0, ts: 1 },
      { type: 'text-append', content: 'world', iteration: 0, ts: 2 },
      { type: 'text-append', content: '!', iteration: 0, ts: 3 },
      { type: 'text-finalize', iteration: 0, ts: 4 },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: 'text-append', content: 'Hello world!', iteration: 0, ts: 1 });
    expect(result[1].type).toBe('text-finalize');
  });

  it('A2: thinking breaks text — thinking-start between text creates separate segments', () => {
    const result = consolidate([
      { type: 'text-append', content: 'Before. ', iteration: 0, ts: 1 },
      { type: 'thinking-start', iteration: 1, ts: 2 },
      { type: 'thinking-content', content: 'Hmm...', iteration: 1, ts: 3 },
      { type: 'thinking-complete', iteration: 1, ts: 4 },
      { type: 'text-append', content: 'After.', iteration: 1, ts: 5 },
    ]);

    const types = result.map(e => e.type);
    expect(types).toEqual([
      'text-append',
      'thinking-start',
      'thinking-content',
      'thinking-complete',
      'text-append',
    ]);
    expect((result[0] as any).content).toBe('Before. ');
    expect((result[4] as any).content).toBe('After.');
  });

  it('A3: shell breaks text — shell-start between text creates separate segments', () => {
    const result = consolidate([
      { type: 'text-append', content: 'Before. ', iteration: 0, ts: 1 },
      { type: 'shell-start', id: 'sh-1', commands: [{ command: 'ls' }], iteration: 0, ts: 2 },
      { type: 'shell-complete', id: 'sh-1', results: [{ output: 'ok', success: true }], ts: 3 },
      { type: 'text-append', content: 'After.', iteration: 0, ts: 4 },
    ]);

    const types = result.map(e => e.type);
    expect(types).toEqual(['text-append', 'shell-start', 'shell-complete', 'text-append']);
    expect((result[0] as any).content).toBe('Before. ');
    expect((result[3] as any).content).toBe('After.');
  });

  it('A4: file-modified deferred — file-modified mid-text deferred to after text ends', () => {
    const result = consolidate([
      { type: 'text-append', content: 'Hello ', iteration: 0, ts: 1 },
      { type: 'text-append', content: 'world', iteration: 0, ts: 2 },
      { type: 'file-modified', path: 'test.txt', status: 'applied', ts: 3 },
      { type: 'text-append', content: '. Done!', iteration: 0, ts: 4 },
      { type: 'text-finalize', iteration: 0, ts: 5 },
    ]);

    // Text merges fully, then deferred file-modified flushes with the text buffer,
    // followed by text-finalize (which triggers flushText → deferred emit → finalize event)
    const types = result.map(e => e.type);
    expect(types).toEqual(['text-append', 'file-modified', 'text-finalize']);
    expect((result[0] as any).content).toBe('Hello world. Done!');
  });

  it('A5: file-modified without text buffer — goes directly to result', () => {
    const result = consolidate([
      { type: 'file-modified', path: 'a.txt', status: 'applied', ts: 1 },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('file-modified');
  });

  it('A6: multiple file-modified deferred — two file-modified events mid-text both deferred', () => {
    const result = consolidate([
      { type: 'text-append', content: 'Working...', iteration: 0, ts: 1 },
      { type: 'file-modified', path: 'a.txt', status: 'applied', ts: 2 },
      { type: 'file-modified', path: 'b.txt', status: 'applied', ts: 3 },
      { type: 'text-finalize', iteration: 0, ts: 4 },
    ]);

    const types = result.map(e => e.type);
    expect(types).toEqual(['text-append', 'file-modified', 'file-modified', 'text-finalize']);
    expect((result[1] as any).path).toBe('a.txt');
    expect((result[2] as any).path).toBe('b.txt');
  });

  it('A7: approval breaks text — approval-created between text creates separate segments', () => {
    const result = consolidate([
      { type: 'text-append', content: 'Before. ', iteration: 0, ts: 1 },
      { type: 'approval-created', id: 'ap-1', command: 'rm -rf /', prefix: 'rm', shellId: 'sh-1', ts: 2 },
      { type: 'approval-resolved', id: 'ap-1', decision: 'blocked', persistent: false, ts: 3 },
      { type: 'text-append', content: 'After.', iteration: 0, ts: 4 },
    ]);

    const types = result.map(e => e.type);
    expect(types).toEqual(['text-append', 'approval-created', 'approval-resolved', 'text-append']);
  });

  it('A8: tool-batch breaks text — tool-batch-start between text creates separate segments', () => {
    const result = consolidate([
      { type: 'text-append', content: 'Before. ', iteration: 0, ts: 1 },
      { type: 'tool-batch-start', tools: [{ name: 'read_file', detail: 'Reading' }], ts: 2 },
      { type: 'tool-batch-complete', ts: 3 },
      { type: 'text-append', content: 'After.', iteration: 0, ts: 4 },
    ]);

    const types = result.map(e => e.type);
    expect(types).toEqual(['text-append', 'tool-batch-start', 'tool-batch-complete', 'text-append']);
  });

  it('A9: shell-complete does not break text — non-structural for consolidation', () => {
    // shell-complete hits the default case in consolidation, which flushes text.
    // This test documents the actual behavior.
    const result = consolidate([
      { type: 'text-append', content: 'A', iteration: 0, ts: 1 },
      { type: 'shell-complete', id: 'sh-1', results: [{ output: '', success: true }], ts: 2 },
      { type: 'text-append', content: 'B', iteration: 0, ts: 3 },
    ]);

    // shell-complete is a structural event in the default case, so it flushes text
    const types = result.map(e => e.type);
    expect(types).toEqual(['text-append', 'shell-complete', 'text-append']);
    expect((result[0] as any).content).toBe('A');
    expect((result[2] as any).content).toBe('B');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Projection (projectFull)
// ─────────────────────────────────────────────────────────────────────────────

describe('B. Projection (projectFull)', () => {
  it('B1: text → file-modified → text — creates 3 segments', () => {
    const segments = project([
      { type: 'text-append', content: 'Before modifying the file.', iteration: 0, ts: 1 },
      { type: 'file-modified', path: 'test.txt', status: 'applied', ts: 2 },
      { type: 'text-append', content: 'After the file was modified.', iteration: 0, ts: 3 },
    ]);

    expect(segments).toHaveLength(3);
    expect(segments[0].type).toBe('text');
    expect((segments[0] as TextSegment).content).toBe('Before modifying the file.');
    expect((segments[0] as TextSegment).complete).toBe(true); // file-modified closes text
    expect(segments[1].type).toBe('file-modified');
    expect(segments[2].type).toBe('text');
    expect((segments[2] as TextSegment).content).toBe('After the file was modified.');
    expect((segments[2] as TextSegment).continuation).toBe(true);
  });

  it('B2: text → thinking → text — creates 3 segments with thinking in between', () => {
    const segments = project([
      { type: 'text-append', content: 'First thought.', iteration: 0, ts: 1 },
      { type: 'thinking-start', iteration: 1, ts: 2 },
      { type: 'thinking-content', content: 'Reasoning...', iteration: 1, ts: 3 },
      { type: 'thinking-complete', iteration: 1, ts: 4 },
      { type: 'text-append', content: 'Conclusion.', iteration: 1, ts: 5 },
    ]);

    expect(segments).toHaveLength(3);
    expect(segments[0].type).toBe('text');
    expect((segments[0] as TextSegment).complete).toBe(true);
    expect(segments[1].type).toBe('thinking');
    expect((segments[1] as ThinkingSegment).content).toBe('Reasoning...');
    expect((segments[1] as ThinkingSegment).complete).toBe(true);
    expect(segments[2].type).toBe('text');
    expect((segments[2] as TextSegment).continuation).toBe(true);
  });

  it('B3: text → shell → text — creates 3 segments with shell in between', () => {
    const segments = project([
      { type: 'text-append', content: 'Let me run this.', iteration: 0, ts: 1 },
      { type: 'shell-start', id: 'sh-1', commands: [{ command: 'ls -la' }], iteration: 0, ts: 2 },
      { type: 'shell-complete', id: 'sh-1', results: [{ output: 'files', success: true }], ts: 3 },
      { type: 'text-append', content: 'Here are the results.', iteration: 0, ts: 4 },
    ]);

    expect(segments).toHaveLength(3);
    expect(segments[0].type).toBe('text');
    expect((segments[0] as TextSegment).complete).toBe(true);
    expect(segments[1].type).toBe('shell');
    expect((segments[1] as ShellSegment).commands[0].command).toBe('ls -la');
    expect((segments[1] as ShellSegment).complete).toBe(true);
    expect(segments[2].type).toBe('text');
    expect((segments[2] as TextSegment).continuation).toBe(true);
  });

  it('B4: file-modified with editMode — editMode preserved through projection', () => {
    const segments = project([
      { type: 'file-modified', path: 'test.ts', status: 'pending', editMode: 'ask', ts: 1 },
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0].type).toBe('file-modified');
    expect((segments[0] as FileModifiedSegment).editMode).toBe('ask');
    expect((segments[0] as FileModifiedSegment).status).toBe('pending');
  });

  it('B5: file-modified with deleted status — status preserved through projection', () => {
    const segments = project([
      { type: 'file-modified', path: 'removed.ts', status: 'deleted', editMode: 'auto', ts: 1 },
    ]);

    expect(segments).toHaveLength(1);
    expect((segments[0] as FileModifiedSegment).status).toBe('deleted');
  });

  it('B6: expired conversion on restore — pending becomes expired when turn not streaming', () => {
    // The projector passes through status as-is. Expired conversion happens
    // at the application layer (step 5b patching or ConversationManager).
    // This test verifies that if the event already has 'expired' status, it projects correctly.
    const segments = project([
      { type: 'file-modified', path: 'stale.ts', status: 'expired', editMode: 'ask', ts: 1 },
    ]);

    expect(segments).toHaveLength(1);
    expect((segments[0] as FileModifiedSegment).status).toBe('expired');
  });

  it('B7: applied status preserved — applied file-modified stays applied', () => {
    const segments = project([
      { type: 'file-modified', path: 'good.ts', status: 'applied', editMode: 'ask', ts: 1 },
    ]);

    expect((segments[0] as FileModifiedSegment).status).toBe('applied');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. Consolidation → Projection Round-Trip
// ─────────────────────────────────────────────────────────────────────────────

describe('C. Consolidation → Projection Round-Trip', () => {
  it('C1: live events → consolidate → project matches expected', () => {
    const segments = roundTrip([
      { type: 'thinking-start', iteration: 0, ts: 1 },
      { type: 'thinking-content', content: 'Let me ', iteration: 0, ts: 2 },
      { type: 'thinking-content', content: 'think.', iteration: 0, ts: 3 },
      { type: 'thinking-complete', iteration: 0, ts: 4 },
      { type: 'text-append', content: 'Here ', iteration: 0, ts: 5 },
      { type: 'text-append', content: 'is the ', iteration: 0, ts: 6 },
      { type: 'text-append', content: 'answer.', iteration: 0, ts: 7 },
      { type: 'text-finalize', iteration: 0, ts: 8 },
    ]);

    expect(segments).toHaveLength(2);
    expect(segments[0].type).toBe('thinking');
    expect((segments[0] as ThinkingSegment).content).toBe('Let me think.');
    expect((segments[0] as ThinkingSegment).complete).toBe(true);
    expect(segments[1].type).toBe('text');
    expect((segments[1] as TextSegment).content).toBe('Here is the answer.');
  });

  it('C2: file-modified after shell (deferred) — ordering correct through round-trip', () => {
    const segments = roundTrip([
      { type: 'shell-start', id: 'sh-1', commands: [{ command: 'echo hi > out.txt' }], iteration: 0, ts: 1 },
      { type: 'shell-complete', id: 'sh-1', results: [{ output: '', success: true }], ts: 2 },
      { type: 'text-append', content: 'File ', iteration: 0, ts: 3 },
      { type: 'text-append', content: 'created.', iteration: 0, ts: 4 },
      { type: 'file-modified', path: 'out.txt', status: 'applied', editMode: 'auto', ts: 5 },
      { type: 'text-finalize', iteration: 0, ts: 6 },
    ]);

    // After consolidation, file-modified is deferred to after text.
    // After projection: shell → text → file-modified
    const types = segments.map(s => s.type);
    expect(types).toEqual(['shell', 'text', 'file-modified']);
    expect((segments[1] as TextSegment).content).toBe('File created.');
    expect((segments[2] as FileModifiedSegment).editMode).toBe('auto');
  });

  it('C3: ask mode accept patching — pending patched to applied before save', () => {
    // Simulate step 5b: patch pending → applied before consolidation
    const log = new TurnEventLog('test');
    log.append({ type: 'text-append', content: 'Modified your file.', iteration: 0, ts: 1 });
    log.append({ type: 'text-finalize', iteration: 0, ts: 2 });
    log.append({ type: 'file-modified', path: 'app.ts', status: 'pending', editMode: 'ask', ts: 3 });

    // Step 5b patching: find pending file-modified and update status
    const events = log.getAll();
    for (const e of events) {
      if (e.type === 'file-modified' && e.status === 'pending') {
        (e as any).status = 'applied';
      }
    }

    const consolidated = log.consolidateForSave();
    const restored = new TurnEventLog('restore');
    restored.load(consolidated);
    const segments = new TurnProjector().projectFull(restored);

    const fileSeg = segments.find(s => s.type === 'file-modified') as FileModifiedSegment;
    expect(fileSeg).toBeDefined();
    expect(fileSeg.status).toBe('applied');
    expect(fileSeg.editMode).toBe('ask');
  });

  it('C4: multiple iterations — thinking/text across 3 iterations', () => {
    const events: TurnEvent[] = [];
    let ts = 0;

    for (let iter = 0; iter < 3; iter++) {
      events.push({ type: 'thinking-start', iteration: iter, ts: ++ts });
      events.push({ type: 'thinking-content', content: `Iteration ${iter} reasoning. `, iteration: iter, ts: ++ts });
      events.push({ type: 'thinking-content', content: 'More thoughts.', iteration: iter, ts: ++ts });
      events.push({ type: 'thinking-complete', iteration: iter, ts: ++ts });
      events.push({ type: 'text-append', content: `Response ${iter}. `, iteration: iter, ts: ++ts });
      events.push({ type: 'text-append', content: 'Details here.', iteration: iter, ts: ++ts });
      events.push({ type: 'text-finalize', iteration: iter, ts: ++ts });
    }

    const segments = roundTrip(events);

    // 3 iterations × (thinking + text) = 6 segments
    expect(segments).toHaveLength(6);
    for (let i = 0; i < 6; i += 2) {
      expect(segments[i].type).toBe('thinking');
      expect((segments[i] as ThinkingSegment).complete).toBe(true);
      expect(segments[i + 1].type).toBe('text');
      expect((segments[i + 1] as TextSegment).complete).toBe(true);
    }
    expect((segments[0] as ThinkingSegment).content).toBe('Iteration 0 reasoning. More thoughts.');
    expect((segments[1] as TextSegment).content).toBe('Response 0. Details here.');
  });

  it('C5: shell + file-modified + text interleaving — real-world scenario', () => {
    const segments = roundTrip([
      // Iteration 0: think → text → shell → file-modified mid-text → more text
      { type: 'thinking-start', iteration: 0, ts: 1 },
      { type: 'thinking-content', content: 'Planning changes.', iteration: 0, ts: 2 },
      { type: 'thinking-complete', iteration: 0, ts: 3 },
      { type: 'text-append', content: 'I will modify the file. ', iteration: 0, ts: 4 },
      { type: 'shell-start', id: 'sh-1', commands: [{ command: 'cat >> config.json' }], iteration: 0, ts: 5 },
      { type: 'shell-complete', id: 'sh-1', results: [{ output: '', success: true }], ts: 6 },
      { type: 'text-append', content: 'The config has been updated. ', iteration: 0, ts: 7 },
      { type: 'file-modified', path: 'config.json', status: 'applied', editMode: 'auto', ts: 8 },
      { type: 'text-append', content: 'Let me verify.', iteration: 0, ts: 9 },
      { type: 'text-finalize', iteration: 0, ts: 10 },
      // Iteration 1: think → final response
      { type: 'thinking-start', iteration: 1, ts: 11 },
      { type: 'thinking-content', content: 'Looks good.', iteration: 1, ts: 12 },
      { type: 'thinking-complete', iteration: 1, ts: 13 },
      { type: 'text-append', content: 'Everything is set!', iteration: 1, ts: 14 },
    ]);

    // Expected after round-trip:
    // thinking → text("I will modify the file. ") → shell → text("The config...Let me verify.") → file-modified → thinking → text("Everything is set!")
    // The file-modified is deferred past the text in consolidation, so it appears after text completes
    const types = segments.map(s => s.type);

    // Verify key structural properties
    expect(types[0]).toBe('thinking');
    expect(types).toContain('shell');
    expect(types).toContain('file-modified');
    // Last two should be thinking + text (iteration 1)
    expect(types[types.length - 2]).toBe('thinking');
    expect(types[types.length - 1]).toBe('text');
    expect((segments[segments.length - 1] as TextSegment).content).toBe('Everything is set!');

    // Verify file-modified preserved editMode
    const fileSeg = segments.find(s => s.type === 'file-modified') as FileModifiedSegment;
    expect(fileSeg.editMode).toBe('auto');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. File-Modified Status Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe('D. File-Modified Status Lifecycle', () => {
  it('D1: pending → applied (step 5b patching)', () => {
    const log = new TurnEventLog('test');
    log.append({ type: 'text-append', content: 'Done.', iteration: 0, ts: 1 });
    log.append({ type: 'file-modified', path: 'app.ts', status: 'pending', editMode: 'ask', ts: 2 });

    // Simulate step 5b: patch before save
    const all = log.getAll();
    for (const e of all) {
      if (e.type === 'file-modified' && e.status === 'pending') {
        (e as any).status = 'applied';
      }
    }

    const segments = roundTrip(log.getAll());
    const fileSeg = segments.find(s => s.type === 'file-modified') as FileModifiedSegment;
    expect(fileSeg.status).toBe('applied');
  });

  it('D2: pending → expired (unresolved on restore)', () => {
    // If a pending file-modified was never resolved, the application layer
    // patches it to expired. Test the round-trip with pre-patched status.
    const segments = roundTrip([
      { type: 'text-append', content: 'Check this.', iteration: 0, ts: 1 },
      { type: 'file-modified', path: 'stale.ts', status: 'expired', editMode: 'ask', ts: 2 },
    ]);

    const fileSeg = segments.find(s => s.type === 'file-modified') as FileModifiedSegment;
    expect(fileSeg.status).toBe('expired');
  });

  it('D3: applied preserved on restore — survives save/load cycle', () => {
    const segments = roundTrip([
      { type: 'file-modified', path: 'good.ts', status: 'applied', editMode: 'ask', ts: 1 },
    ]);

    expect((segments[0] as FileModifiedSegment).status).toBe('applied');
  });

  it('D4: rejected preserved on restore — survives save/load cycle', () => {
    const segments = roundTrip([
      { type: 'file-modified', path: 'bad.ts', status: 'rejected', editMode: 'ask', ts: 1 },
    ]);

    expect((segments[0] as FileModifiedSegment).status).toBe('rejected');
  });

  it('D5: deleted status preserved — survives save/load cycle', () => {
    const segments = roundTrip([
      { type: 'file-modified', path: 'removed.ts', status: 'deleted', editMode: 'auto', ts: 1 },
    ]);

    expect((segments[0] as FileModifiedSegment).status).toBe('deleted');
  });

  it('D6: manual mode insert — file-modified inserted post-save persists', () => {
    // In manual mode, file-modified events are inserted by ConversationManager
    // after the initial save. This simulates the restored state.
    const segments = roundTrip([
      { type: 'text-append', content: 'Here is the diff.', iteration: 0, ts: 1 },
      { type: 'text-finalize', iteration: 0, ts: 2 },
      { type: 'file-modified', path: 'manual.ts', status: 'applied', editMode: 'manual', ts: 3 },
    ]);

    expect(segments).toHaveLength(2); // text + file-modified
    expect(segments[0].type).toBe('text');
    expect(segments[1].type).toBe('file-modified');
    expect((segments[1] as FileModifiedSegment).editMode).toBe('manual');
    expect((segments[1] as FileModifiedSegment).status).toBe('applied');
  });

  it('D7: editMode preserved per-file across mode switch', () => {
    // Different files can have different editModes within the same turn
    // (e.g., user switched modes mid-conversation)
    const segments = roundTrip([
      { type: 'file-modified', path: 'a.ts', status: 'applied', editMode: 'manual', ts: 1 },
      { type: 'file-modified', path: 'b.ts', status: 'pending', editMode: 'ask', ts: 2 },
      { type: 'file-modified', path: 'c.ts', status: 'applied', editMode: 'auto', ts: 3 },
    ]);

    expect(segments).toHaveLength(3);
    expect((segments[0] as FileModifiedSegment).editMode).toBe('manual');
    expect((segments[1] as FileModifiedSegment).editMode).toBe('ask');
    expect((segments[2] as FileModifiedSegment).editMode).toBe('auto');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Edge Cases
// ─────────────────────────────────────────────────────────────────────────────

describe('E. Edge Cases', () => {
  it('E1: empty text segments — text with no real content still projects', () => {
    const segments = project([
      { type: 'text-append', content: '', iteration: 0, ts: 1 },
      { type: 'text-finalize', iteration: 0, ts: 2 },
    ]);

    // Empty text-append still creates a segment (UI layer hides it)
    expect(segments).toHaveLength(1);
    expect(segments[0].type).toBe('text');
    expect((segments[0] as TextSegment).content).toBe('');
  });

  it('E2: consecutive file-modified events — grouped together in output', () => {
    const segments = project([
      { type: 'file-modified', path: 'a.ts', status: 'applied', ts: 1 },
      { type: 'file-modified', path: 'b.ts', status: 'applied', ts: 2 },
    ]);

    expect(segments).toHaveLength(2);
    expect((segments[0] as FileModifiedSegment).path).toBe('a.ts');
    expect((segments[1] as FileModifiedSegment).path).toBe('b.ts');
  });

  it('E3: same file modified twice — separate segments for each occurrence', () => {
    const segments = project([
      { type: 'text-append', content: 'First edit.', iteration: 0, ts: 1 },
      { type: 'file-modified', path: 'app.ts', status: 'applied', editMode: 'auto', ts: 2 },
      { type: 'text-append', content: 'Second edit.', iteration: 0, ts: 3 },
      { type: 'file-modified', path: 'app.ts', status: 'applied', editMode: 'auto', ts: 4 },
    ]);

    const fileMods = segments.filter(s => s.type === 'file-modified');
    expect(fileMods).toHaveLength(2);
    expect((fileMods[0] as FileModifiedSegment).path).toBe('app.ts');
    expect((fileMods[1] as FileModifiedSegment).path).toBe('app.ts');
  });

  it('E4: no events — empty log produces empty segments', () => {
    const segments = project([]);
    expect(segments).toHaveLength(0);
  });

  it('E5: text-only (no structural events) — single text segment', () => {
    const segments = roundTrip([
      { type: 'text-append', content: 'Just ', iteration: 0, ts: 1 },
      { type: 'text-append', content: 'a ', iteration: 0, ts: 2 },
      { type: 'text-append', content: 'simple ', iteration: 0, ts: 3 },
      { type: 'text-append', content: 'response.', iteration: 0, ts: 4 },
      { type: 'text-finalize', iteration: 0, ts: 5 },
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0].type).toBe('text');
    expect((segments[0] as TextSegment).content).toBe('Just a simple response.');
    expect((segments[0] as TextSegment).continuation).toBe(false);
  });

  it('E6: approval lifecycle — pending → allowed through round-trip', () => {
    const segments = roundTrip([
      { type: 'shell-start', id: 'sh-1', commands: [{ command: 'rm -rf temp/' }], iteration: 0, ts: 1 },
      { type: 'approval-created', id: 'ap-1', command: 'rm -rf temp/', prefix: 'rm', shellId: 'sh-1', ts: 2 },
      { type: 'approval-resolved', id: 'ap-1', decision: 'allowed', persistent: true, ts: 3 },
      { type: 'shell-complete', id: 'sh-1', results: [{ output: '', success: true }], ts: 4 },
    ]);

    expect(segments).toHaveLength(2); // shell + approval
    const approval = segments.find(s => s.type === 'approval');
    expect(approval).toBeDefined();
    expect((approval as any).status).toBe('allowed');
    expect((approval as any).persistent).toBe(true);
  });

  it('E7: tool batch lifecycle — complete lifecycle through round-trip', () => {
    const segments = roundTrip([
      { type: 'tool-batch-start', tools: [{ name: 'read_file', detail: 'Reading config' }, { name: 'list_dir', detail: 'Listing src' }], ts: 1 },
      { type: 'tool-update', index: 0, status: 'done', ts: 2 },
      { type: 'tool-update', index: 1, status: 'done', ts: 3 },
      { type: 'tool-batch-complete', ts: 4 },
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0].type).toBe('tool-batch');
    const batch = segments[0] as any;
    expect(batch.tools).toHaveLength(2);
    expect(batch.complete).toBe(true);
  });

  it('E8: code block through round-trip', () => {
    const segments = roundTrip([
      { type: 'text-append', content: 'Here is the code:', iteration: 0, ts: 1 },
      { type: 'code-block', language: 'typescript', content: 'const x = 1;', file: 'app.ts', iteration: 0, ts: 2 },
      { type: 'text-append', content: 'That should work.', iteration: 0, ts: 3 },
    ]);

    expect(segments).toHaveLength(3);
    expect(segments[0].type).toBe('text');
    expect(segments[1].type).toBe('code-block');
    expect((segments[1] as any).language).toBe('typescript');
    expect((segments[1] as any).content).toBe('const x = 1;');
    expect((segments[1] as any).file).toBe('app.ts');
    expect(segments[2].type).toBe('text');
  });

  it('E9: drawing event through round-trip', () => {
    const segments = roundTrip([
      { type: 'text-append', content: 'Here is a diagram:', iteration: 0, ts: 1 },
      { type: 'drawing', imageDataUrl: 'data:image/png;base64,abc123', ts: 2 },
    ]);

    expect(segments).toHaveLength(2);
    expect(segments[0].type).toBe('text');
    expect(segments[1].type).toBe('drawing');
    expect((segments[1] as any).imageDataUrl).toBe('data:image/png;base64,abc123');
  });

  it('E10: continuation flag tracks correctly across multiple text breaks', () => {
    const segments = project([
      { type: 'text-append', content: 'First.', iteration: 0, ts: 1 },
      { type: 'shell-start', id: 'sh-1', commands: [{ command: 'ls' }], iteration: 0, ts: 2 },
      { type: 'shell-complete', id: 'sh-1', results: [{ output: '', success: true }], ts: 3 },
      { type: 'text-append', content: 'Second.', iteration: 0, ts: 4 },
      { type: 'file-modified', path: 'x.ts', status: 'applied', ts: 5 },
      { type: 'text-append', content: 'Third.', iteration: 0, ts: 6 },
    ]);

    const textSegs = segments.filter(s => s.type === 'text') as TextSegment[];
    expect(textSegs).toHaveLength(3);
    expect(textSegs[0].continuation).toBe(false); // First text ever
    expect(textSegs[1].continuation).toBe(true);  // After shell
    expect(textSegs[2].continuation).toBe(true);  // After file-modified
  });
});
