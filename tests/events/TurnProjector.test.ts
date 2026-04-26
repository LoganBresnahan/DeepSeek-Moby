import { describe, it, expect, beforeEach } from 'vitest';
import { TurnEventLog, TurnEvent } from '../../media/events/TurnEventLog';
import { TurnProjector, ViewSegment, ViewMutation, TextSegment, ThinkingSegment, ShellSegment, ApprovalSegment, FileModifiedSegment, ToolBatchSegment } from '../../media/events/TurnProjector';

describe('TurnProjector', () => {
  let log: TurnEventLog;
  let projector: TurnProjector;

  beforeEach(() => {
    log = new TurnEventLog();
    projector = new TurnProjector();
  });

  // ── projectFull ──

  describe('projectFull', () => {

    describe('text segments', () => {
      it('creates a single text segment from consecutive text-append events', () => {
        log.load([
          { type: 'text-append', content: 'Hello ', iteration: 0, ts: 1 },
          { type: 'text-append', content: 'World', iteration: 0, ts: 2 },
        ]);

        const segments = projector.projectFull(log);
        expect(segments).toHaveLength(1);
        expect(segments[0].type).toBe('text');
        expect((segments[0] as TextSegment).content).toBe('Hello World');
        expect((segments[0] as TextSegment).complete).toBe(false);
        expect((segments[0] as TextSegment).continuation).toBe(false);
      });

      it('marks text as complete on text-finalize', () => {
        log.load([
          { type: 'text-append', content: 'Hello', iteration: 0, ts: 1 },
          { type: 'text-finalize', iteration: 0, ts: 2 },
        ]);

        const segments = projector.projectFull(log);
        expect(segments).toHaveLength(1);
        expect((segments[0] as TextSegment).complete).toBe(true);
      });

      it('creates continuation segment after finalized text', () => {
        log.load([
          { type: 'text-append', content: 'First', iteration: 0, ts: 1 },
          { type: 'text-finalize', iteration: 0, ts: 2 },
          { type: 'text-append', content: 'Second', iteration: 0, ts: 3 },
        ]);

        const segments = projector.projectFull(log);
        expect(segments).toHaveLength(2);
        expect((segments[0] as TextSegment).content).toBe('First');
        expect((segments[0] as TextSegment).continuation).toBe(false);
        expect((segments[1] as TextSegment).content).toBe('Second');
        expect((segments[1] as TextSegment).continuation).toBe(true);
      });
    });

    describe('thinking segments', () => {
      it('creates thinking segment from thinking events', () => {
        log.load([
          { type: 'thinking-start', iteration: 0, ts: 1 },
          { type: 'thinking-content', content: 'Let me think...', iteration: 0, ts: 2 },
          { type: 'thinking-content', content: ' about this.', iteration: 0, ts: 3 },
          { type: 'thinking-complete', iteration: 0, ts: 4 },
        ]);

        const segments = projector.projectFull(log);
        expect(segments).toHaveLength(1);
        const thinking = segments[0] as ThinkingSegment;
        expect(thinking.type).toBe('thinking');
        expect(thinking.content).toBe('Let me think... about this.');
        expect(thinking.iteration).toBe(0);
        expect(thinking.complete).toBe(true);
      });

      it('breaks text flow when thinking starts', () => {
        log.load([
          { type: 'text-append', content: 'Before thinking', iteration: 0, ts: 1 },
          { type: 'thinking-start', iteration: 1, ts: 2 },
          { type: 'thinking-content', content: 'Thinking...', iteration: 1, ts: 3 },
          { type: 'thinking-complete', iteration: 1, ts: 4 },
          { type: 'text-append', content: 'After thinking', iteration: 1, ts: 5 },
        ]);

        const segments = projector.projectFull(log);
        expect(segments).toHaveLength(3);
        expect(segments[0].type).toBe('text');
        expect((segments[0] as TextSegment).complete).toBe(true); // Auto-finalized by thinking-start
        expect(segments[1].type).toBe('thinking');
        expect(segments[2].type).toBe('text');
        expect((segments[2] as TextSegment).continuation).toBe(true);
      });
    });

    describe('shell segments', () => {
      it('creates shell segment with results', () => {
        log.load([
          { type: 'shell-start', id: 'sh-1', commands: [{ command: 'ls' }], iteration: 0, ts: 1 },
          { type: 'shell-complete', id: 'sh-1', results: [{ output: 'file.txt', success: true }], ts: 2 },
        ]);

        const segments = projector.projectFull(log);
        expect(segments).toHaveLength(1);
        const shell = segments[0] as ShellSegment;
        expect(shell.type).toBe('shell');
        expect(shell.id).toBe('sh-1');
        expect(shell.commands).toEqual([{ command: 'ls' }]);
        expect(shell.results).toEqual([{ output: 'file.txt', success: true }]);
        expect(shell.complete).toBe(true);
      });

      it('breaks text flow when shell starts', () => {
        log.load([
          { type: 'text-append', content: 'Before shell', iteration: 0, ts: 1 },
          { type: 'shell-start', id: 'sh-1', commands: [{ command: 'ls' }], iteration: 0, ts: 2 },
          { type: 'shell-complete', id: 'sh-1', results: [{ output: '', success: true }], ts: 3 },
          { type: 'text-append', content: 'After shell', iteration: 0, ts: 4 },
        ]);

        const segments = projector.projectFull(log);
        expect(segments).toHaveLength(3);
        expect(segments[0].type).toBe('text');
        expect((segments[0] as TextSegment).complete).toBe(true);
        expect(segments[1].type).toBe('shell');
        expect(segments[2].type).toBe('text');
        expect((segments[2] as TextSegment).continuation).toBe(true);
      });
    });

    describe('approval segments', () => {
      it('creates and resolves approval segments', () => {
        log.load([
          { type: 'shell-start', id: 'sh-1', commands: [{ command: 'cat >> file.txt' }], iteration: 0, ts: 1 },
          { type: 'approval-created', id: 'ap-1', command: 'cat >> file.txt', prefix: 'cat >>', shellId: 'sh-1', ts: 2 },
          { type: 'approval-resolved', id: 'ap-1', decision: 'allowed', persistent: true, ts: 3 },
          { type: 'shell-complete', id: 'sh-1', results: [{ output: '', success: true }], ts: 4 },
        ]);

        const segments = projector.projectFull(log);
        expect(segments).toHaveLength(2);
        expect(segments[0].type).toBe('shell');

        const approval = segments[1] as ApprovalSegment;
        expect(approval.type).toBe('approval');
        expect(approval.status).toBe('allowed');
        expect(approval.persistent).toBe(true);
        expect(approval.shellId).toBe('sh-1');
      });
    });

    describe('file-modified segments', () => {
      it('places file-modified at correct causal position', () => {
        log.append({ type: 'shell-start', id: 'sh-1', commands: [{ command: 'cat >> file.txt' }], iteration: 0, ts: 1 });
        log.append({ type: 'shell-complete', id: 'sh-1', results: [{ output: '', success: true }], ts: 2 });
        log.append({ type: 'text-append', content: 'Done!', iteration: 0, ts: 3 });
        // Late arrival — insertCausal places it after shell-complete
        log.insertCausal({ type: 'file-modified', path: 'file.txt', status: 'applied', causedBy: 'sh-1', ts: 4 });

        const segments = projector.projectFull(log);
        expect(segments).toHaveLength(3);
        expect(segments[0].type).toBe('shell');
        expect(segments[1].type).toBe('file-modified');
        expect((segments[1] as FileModifiedSegment).path).toBe('file.txt');
        expect(segments[2].type).toBe('text');
      });
    });

    describe('tool batch segments', () => {
      it('creates tool batch with updates', () => {
        log.load([
          { type: 'tool-batch-start', tools: [{ name: 'read_file', detail: 'Reading...' }, { name: 'grep', detail: 'Searching...' }], ts: 1 },
          { type: 'tool-update', index: 0, status: 'done', ts: 2 },
          { type: 'tool-update', index: 1, status: 'error', ts: 3 },
          { type: 'tool-batch-complete', ts: 4 },
        ]);

        const segments = projector.projectFull(log);
        expect(segments).toHaveLength(1);
        const batch = segments[0] as ToolBatchSegment;
        expect(batch.type).toBe('tool-batch');
        expect(batch.tools).toHaveLength(2);
        expect(batch.tools[0].status).toBe('done');
        expect(batch.tools[1].status).toBe('error');
        expect(batch.complete).toBe(true);
      });
    });

    describe('code block segments', () => {
      it('creates code block and breaks text flow', () => {
        log.load([
          { type: 'text-append', content: 'Here is the code:', iteration: 0, ts: 1 },
          { type: 'code-block', language: 'typescript', content: 'const x = 1;', iteration: 0, ts: 2 },
          { type: 'text-append', content: 'That is the code.', iteration: 0, ts: 3 },
        ]);

        const segments = projector.projectFull(log);
        expect(segments).toHaveLength(3);
        expect(segments[0].type).toBe('text');
        expect((segments[0] as TextSegment).complete).toBe(true);
        expect(segments[1].type).toBe('code-block');
        expect(segments[2].type).toBe('text');
      });
    });

    describe('drawing segments', () => {
      it('creates drawing segment', () => {
        log.load([
          { type: 'drawing', imageDataUrl: 'data:image/png;base64,...', ts: 1 },
        ]);

        const segments = projector.projectFull(log);
        expect(segments).toHaveLength(1);
        expect(segments[0].type).toBe('drawing');
      });
    });

    describe('complex scenarios', () => {
      it('handles full R1 iteration: thinking → text → shell → approval → file → text', () => {
        // Build log with causal insertion
        log.append({ type: 'thinking-start', iteration: 0, ts: 1 });
        log.append({ type: 'thinking-content', content: 'Checking file...', iteration: 0, ts: 2 });
        log.append({ type: 'thinking-complete', iteration: 0, ts: 3 });
        log.append({ type: 'text-append', content: 'I\'ll add an animal.', iteration: 0, ts: 4 });
        log.append({ type: 'text-finalize', iteration: 0, ts: 5 });
        log.append({ type: 'shell-start', id: 'sh-1', commands: [{ command: 'cat >> animals.txt' }], iteration: 0, ts: 6 });
        log.append({ type: 'approval-created', id: 'ap-1', command: 'cat >> animals.txt', prefix: 'cat >>', shellId: 'sh-1', ts: 7 });
        log.append({ type: 'approval-resolved', id: 'ap-1', decision: 'allowed', persistent: true, ts: 8 });
        log.append({ type: 'shell-complete', id: 'sh-1', results: [{ output: '', success: true }], ts: 9 });
        log.insertCausal({ type: 'file-modified', path: 'animals.txt', status: 'applied', causedBy: 'sh-1', ts: 10 });
        log.append({ type: 'thinking-start', iteration: 1, ts: 11 });
        log.append({ type: 'thinking-content', content: 'Done.', iteration: 1, ts: 12 });
        log.append({ type: 'thinking-complete', iteration: 1, ts: 13 });
        log.append({ type: 'text-append', content: 'Porcupine added!', iteration: 1, ts: 14 });

        const segments = projector.projectFull(log);

        // Expected order:
        // 0: thinking (iter 0)
        // 1: text "I'll add an animal." (complete)
        // 2: shell sh-1
        // 3: approval ap-1 (allowed)
        // 4: file-modified animals.txt
        // 5: thinking (iter 1)
        // 6: text "Porcupine added!" (continuation)

        expect(segments).toHaveLength(7);
        expect(segments[0].type).toBe('thinking');
        expect(segments[1].type).toBe('text');
        expect((segments[1] as TextSegment).content).toBe('I\'ll add an animal.');
        expect(segments[2].type).toBe('shell');
        expect(segments[3].type).toBe('approval');
        expect((segments[3] as ApprovalSegment).status).toBe('allowed');
        expect(segments[4].type).toBe('file-modified');
        expect(segments[5].type).toBe('thinking');
        expect(segments[6].type).toBe('text');
        expect((segments[6] as TextSegment).content).toBe('Porcupine added!');
        expect((segments[6] as TextSegment).continuation).toBe(true);
      });

      it('handles Chat model flow: tools → files → text', () => {
        log.load([
          { type: 'tool-batch-start', tools: [{ name: 'read_file', detail: 'Reading...' }, { name: 'edit_file', detail: 'Editing...' }], ts: 1 },
          { type: 'tool-update', index: 0, status: 'done', ts: 2 },
          { type: 'tool-update', index: 1, status: 'done', ts: 3 },
          { type: 'tool-batch-complete', ts: 4 },
          { type: 'file-modified', path: 'app.ts', status: 'applied', ts: 5 },
          { type: 'text-append', content: 'I\'ve updated the file.', iteration: 0, ts: 6 },
        ]);

        const segments = projector.projectFull(log);
        expect(segments).toHaveLength(3);
        expect(segments[0].type).toBe('tool-batch');
        expect(segments[1].type).toBe('file-modified');
        expect(segments[2].type).toBe('text');
      });

      it('handles multiple iterations with multiple shells each', () => {
        // Iteration 0: text → shell → shell → text
        log.load([
          { type: 'thinking-start', iteration: 0, ts: 1 },
          { type: 'thinking-complete', iteration: 0, ts: 2 },
          { type: 'text-append', content: 'Checking...', iteration: 0, ts: 3 },
          { type: 'text-finalize', iteration: 0, ts: 4 },
          { type: 'shell-start', id: 'sh-1', commands: [{ command: 'cat file.txt' }], iteration: 0, ts: 5 },
          { type: 'shell-complete', id: 'sh-1', results: [{ output: 'contents', success: true }], ts: 6 },
          { type: 'shell-start', id: 'sh-2', commands: [{ command: 'cat >> file.txt' }], iteration: 0, ts: 7 },
          { type: 'shell-complete', id: 'sh-2', results: [{ output: '', success: true }], ts: 8 },
          { type: 'text-append', content: 'Edited.', iteration: 0, ts: 9 },
          // Iteration 1
          { type: 'thinking-start', iteration: 1, ts: 10 },
          { type: 'thinking-complete', iteration: 1, ts: 11 },
          { type: 'text-append', content: 'All done.', iteration: 1, ts: 12 },
        ]);

        const segments = projector.projectFull(log);
        expect(segments).toHaveLength(7);
        expect(segments[0].type).toBe('thinking');  // iter 0
        expect(segments[1].type).toBe('text');       // "Checking..."
        expect(segments[2].type).toBe('shell');      // sh-1
        expect(segments[3].type).toBe('shell');      // sh-2
        expect(segments[4].type).toBe('text');       // "Edited."
        expect(segments[5].type).toBe('thinking');   // iter 1
        expect(segments[6].type).toBe('text');       // "All done."
      });

      it('produces identical output for same events regardless of load vs append', () => {
        const events: TurnEvent[] = [
          { type: 'thinking-start', iteration: 0, ts: 1 },
          { type: 'thinking-content', content: 'Thinking', iteration: 0, ts: 2 },
          { type: 'thinking-complete', iteration: 0, ts: 3 },
          { type: 'text-append', content: 'Hello', iteration: 0, ts: 4 },
          { type: 'text-finalize', iteration: 0, ts: 5 },
          { type: 'shell-start', id: 'sh-1', commands: [{ command: 'ls' }], iteration: 0, ts: 6 },
          { type: 'shell-complete', id: 'sh-1', results: [{ output: 'file.txt', success: true }], ts: 7 },
        ];

        // Load all at once
        const log1 = new TurnEventLog();
        log1.load(events);
        const segments1 = projector.projectFull(log1);

        // Append one at a time
        const log2 = new TurnEventLog();
        for (const e of events) {
          log2.append(e);
        }
        const segments2 = projector.projectFull(log2);

        expect(segments1).toEqual(segments2);
      });
    });

    it('handles empty log', () => {
      const segments = projector.projectFull(log);
      expect(segments).toHaveLength(0);
    });
  });

  // ── projectIncremental ──

  describe('projectIncremental', () => {
    it('appends new text segment when no open text exists', () => {
      const segments: ViewSegment[] = [];
      const event: TurnEvent = { type: 'text-append', content: 'Hello', iteration: 0, ts: 1 };

      const mutations = projector.projectIncremental(segments, event, 0);

      expect(mutations).toHaveLength(1);
      expect(mutations[0].op).toBe('append');
      expect((mutations[0] as any).segment.type).toBe('text');
      expect(segments).toHaveLength(1);
    });

    it('updates existing open text segment', () => {
      const segments: ViewSegment[] = [
        { type: 'text', content: 'Hello', complete: false, continuation: false, iteration: 0 },
      ];
      const event: TurnEvent = { type: 'text-append', content: ' World', iteration: 0, ts: 2 };

      const mutations = projector.projectIncremental(segments, event, 1);

      expect(mutations).toHaveLength(1);
      expect(mutations[0].op).toBe('update');
      expect((mutations[0] as any).segmentIndex).toBe(0);
      expect((segments[0] as TextSegment).content).toBe('Hello World');
    });

    it('creates continuation text after finalized text', () => {
      const segments: ViewSegment[] = [
        { type: 'text', content: 'First', complete: true, continuation: false, iteration: 0 },
      ];
      const event: TurnEvent = { type: 'text-append', content: 'Second', iteration: 0, ts: 2 };

      const mutations = projector.projectIncremental(segments, event, 1);

      expect(mutations).toHaveLength(1);
      expect(mutations[0].op).toBe('append');
      expect(segments).toHaveLength(2);
      expect((segments[1] as TextSegment).continuation).toBe(true);
    });

    it('finalizes text on text-finalize', () => {
      const segments: ViewSegment[] = [
        { type: 'text', content: 'Hello', complete: false, continuation: false, iteration: 0 },
      ];

      const mutations = projector.projectIncremental(segments, { type: 'text-finalize', iteration: 0, ts: 2 }, 1);

      expect(mutations).toHaveLength(1);
      expect(mutations[0].op).toBe('update');
      expect((segments[0] as TextSegment).complete).toBe(true);
    });

    it('thinking-start finalizes open text and appends thinking', () => {
      const segments: ViewSegment[] = [
        { type: 'text', content: 'Hello', complete: false, continuation: false, iteration: 0 },
      ];

      const mutations = projector.projectIncremental(segments, { type: 'thinking-start', iteration: 1, ts: 2 }, 1);

      expect(mutations).toHaveLength(2);
      expect(mutations[0].op).toBe('update'); // finalize text
      expect(mutations[1].op).toBe('append'); // new thinking
      expect((segments[0] as TextSegment).complete).toBe(true);
      expect(segments[1].type).toBe('thinking');
    });

    it('shell-start finalizes open text and appends shell', () => {
      const segments: ViewSegment[] = [
        { type: 'text', content: 'Before', complete: false, continuation: false, iteration: 0 },
      ];

      const mutations = projector.projectIncremental(segments, {
        type: 'shell-start', id: 'sh-1', commands: [{ command: 'ls' }], iteration: 0, ts: 2
      }, 1);

      expect(mutations).toHaveLength(2);
      expect(mutations[0].op).toBe('update'); // finalize text
      expect(mutations[1].op).toBe('append'); // new shell
      expect((segments[0] as TextSegment).complete).toBe(true);
      expect(segments[1].type).toBe('shell');
    });

    it('shell-complete updates existing shell segment', () => {
      const segments: ViewSegment[] = [
        { type: 'shell', id: 'sh-1', commands: [{ command: 'ls' }], complete: false },
      ];

      const mutations = projector.projectIncremental(segments, {
        type: 'shell-complete', id: 'sh-1', results: [{ output: 'file.txt', success: true }], ts: 2
      }, 1);

      expect(mutations).toHaveLength(1);
      expect(mutations[0].op).toBe('update');
      expect((segments[0] as ShellSegment).complete).toBe(true);
      expect((segments[0] as ShellSegment).results![0].output).toBe('file.txt');
    });

    it('approval-created appends new approval', () => {
      const segments: ViewSegment[] = [];

      const mutations = projector.projectIncremental(segments, {
        type: 'approval-created', id: 'ap-1', command: 'rm -rf', prefix: 'rm', shellId: 'sh-1', ts: 1
      }, 0);

      expect(mutations).toHaveLength(1);
      expect(mutations[0].op).toBe('append');
      expect(segments[0].type).toBe('approval');
      expect((segments[0] as ApprovalSegment).status).toBe('pending');
    });

    it('approval-resolved updates existing approval', () => {
      const segments: ViewSegment[] = [
        { type: 'approval', id: 'ap-1', command: 'rm', prefix: 'rm', shellId: 'sh-1', status: 'pending' },
      ];

      const mutations = projector.projectIncremental(segments, {
        type: 'approval-resolved', id: 'ap-1', decision: 'blocked', persistent: false, ts: 2
      }, 1);

      expect(mutations).toHaveLength(1);
      expect(mutations[0].op).toBe('update');
      expect((segments[0] as ApprovalSegment).status).toBe('blocked');
    });

    it('returns empty mutations for causal insertion (isInsert=true)', () => {
      const segments: ViewSegment[] = [];

      const mutations = projector.projectIncremental(segments, {
        type: 'file-modified', path: 'file.txt', status: 'applied', causedBy: 'sh-1', ts: 1
      }, 0, true);

      expect(mutations).toHaveLength(0);
    });

    it('incremental projection matches full projection for a streaming sequence', () => {
      const events: TurnEvent[] = [
        { type: 'thinking-start', iteration: 0, ts: 1 },
        { type: 'thinking-content', content: 'Hmm...', iteration: 0, ts: 2 },
        { type: 'thinking-complete', iteration: 0, ts: 3 },
        { type: 'text-append', content: 'I will ', iteration: 0, ts: 4 },
        { type: 'text-append', content: 'check.', iteration: 0, ts: 5 },
        { type: 'text-finalize', iteration: 0, ts: 6 },
        { type: 'shell-start', id: 'sh-1', commands: [{ command: 'ls' }], iteration: 0, ts: 7 },
        { type: 'shell-complete', id: 'sh-1', results: [{ output: 'a.txt', success: true }], ts: 8 },
        { type: 'text-append', content: 'Done.', iteration: 0, ts: 9 },
      ];

      // Full projection
      const logFull = new TurnEventLog();
      logFull.load(events);
      const segmentsFull = projector.projectFull(logFull);

      // Incremental projection
      const segmentsIncremental: ViewSegment[] = [];
      for (let i = 0; i < events.length; i++) {
        projector.projectIncremental(segmentsIncremental, events[i], i);
      }

      // Both should produce the same view model
      expect(segmentsIncremental).toEqual(segmentsFull);
    });
  });
});
