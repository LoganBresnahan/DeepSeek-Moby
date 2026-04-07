/**
 * Layer 2: Webview Rendering Tests
 *
 * Loads the webview in headless Chromium, replays CQRS event fixtures
 * via loadHistory messages, and asserts the rendered DOM state.
 *
 * Covers:
 *   2A. Message Turn Rendering
 *   2B. Pending Files Dropdown
 *   2C. Streaming Visual State
 *   2G. History Restore Fidelity (CQRS Replay)
 */

import { test, expect, Page } from '@playwright/test';
import { launchWebview, closeWebview, WebviewResult } from './helpers/launch';
import {
  loadHarness,
  replayHistory,
  getTurnSegments,
  getTextContents,
  getThinkingContainers,
  getPendingFiles,
  getShellContainers,
  countTurns,
  getPendingContainerText,
  HistoryTurn,
} from './helpers/replay';

let result: WebviewResult;

test.beforeAll(async () => {
  result = await launchWebview();
});

test.afterAll(async () => {
  if (result) await closeWebview(result);
});

// Helper: fresh harness for each test
async function freshPage(): Promise<Page> {
  const { page } = result;
  await loadHarness(page);
  return page;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2A. Message Turn Rendering
// ─────────────────────────────────────────────────────────────────────────────

test.describe('2A. Message Turn Rendering', () => {
  test('A1: simple text response renders', async () => {
    const page = await freshPage();
    await replayHistory(page, [
      { role: 'assistant', content: '', model: 'deepseek-chat', turnEvents: [
        { type: 'text-append', content: 'Hello world!', iteration: 0, ts: 1 },
        { type: 'text-finalize', iteration: 0, ts: 2 },
      ]},
    ]);

    const texts = await getTextContents(page, 'turn-1');
    expect(texts).toHaveLength(1);
    expect(texts[0]).toBe('Hello world!');
  });

  test('A2: user turn renders with "YOU" label', async () => {
    const page = await freshPage();
    await replayHistory(page, [
      { role: 'user', content: 'What is TypeScript?' },
    ]);

    const segments = await getTurnSegments(page, 'turn-1');
    const userText = segments.find(s => s.classes.includes('user'));
    expect(userText).toBeDefined();
    expect(userText!.shadowText).toContain('YOU');
    expect(userText!.shadowText).toContain('What is TypeScript?');
  });

  test('A3: thinking dropdown renders with content', async () => {
    const page = await freshPage();
    await replayHistory(page, [
      { role: 'assistant', content: '', model: 'deepseek-reasoner', turnEvents: [
        { type: 'thinking-start', iteration: 0, ts: 1 },
        { type: 'thinking-content', content: 'Let me think about this carefully.', iteration: 0, ts: 2 },
        { type: 'thinking-complete', iteration: 0, ts: 3 },
        { type: 'text-append', content: 'Here is my answer.', iteration: 0, ts: 4 },
        { type: 'text-finalize', iteration: 0, ts: 5 },
      ]},
    ]);

    const thinking = await getThinkingContainers(page, 'turn-1');
    expect(thinking).toHaveLength(1);
    expect(thinking[0].text).toContain('Thinking');
    expect(thinking[0].text).toContain('Let me think about this carefully.');
  });

  test('A4: shell dropdown renders with command and output', async () => {
    const page = await freshPage();
    await replayHistory(page, [
      { role: 'assistant', content: '', model: 'deepseek-reasoner', turnEvents: [
        { type: 'text-append', content: 'Running command.', iteration: 0, ts: 1 },
        { type: 'text-finalize', iteration: 0, ts: 2 },
        { type: 'shell-start', id: 'sh-1', commands: [{ command: 'ls -la' }], iteration: 0, ts: 3 },
        { type: 'shell-complete', id: 'sh-1', results: [{ output: 'file1.ts\nfile2.ts', success: true }], ts: 4 },
      ]},
    ]);

    const shells = await getShellContainers(page, 'turn-1');
    expect(shells).toHaveLength(1);
    expect(shells[0].text).toContain('ls -la');
  });

  test('A5: multiple segments interleaved — thinking + text + shell + text', async () => {
    const page = await freshPage();
    await replayHistory(page, [
      { role: 'assistant', content: '', model: 'deepseek-reasoner', turnEvents: [
        { type: 'thinking-start', iteration: 0, ts: 1 },
        { type: 'thinking-content', content: 'Planning.', iteration: 0, ts: 2 },
        { type: 'thinking-complete', iteration: 0, ts: 3 },
        { type: 'text-append', content: 'First part.', iteration: 0, ts: 4 },
        { type: 'text-finalize', iteration: 0, ts: 5 },
        { type: 'shell-start', id: 'sh-1', commands: [{ command: 'echo hi' }], iteration: 0, ts: 6 },
        { type: 'shell-complete', id: 'sh-1', results: [{ output: 'hi', success: true }], ts: 7 },
        { type: 'text-append', content: 'Second part.', iteration: 1, ts: 8 },
        { type: 'text-finalize', iteration: 1, ts: 9 },
      ]},
    ]);

    const segments = await getTurnSegments(page, 'turn-1');
    // Should have: header + thinking + text + shell + text = 5 containers
    const types = segments.map(s => {
      if (s.classes.includes('thinking-container')) return 'thinking';
      if (s.classes.includes('text-container')) return 'text';
      if (s.classes.includes('shell-container')) return 'shell';
      if (s.classes.includes('header-container')) return 'header';
      return 'unknown';
    });
    expect(types).toContain('thinking');
    expect(types).toContain('shell');
    expect(types.filter(t => t === 'text')).toHaveLength(2);
  });

  test('A6: user and assistant turns alternate correctly', async () => {
    const page = await freshPage();
    await replayHistory(page, [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: '', model: 'deepseek-chat', turnEvents: [
        { type: 'text-append', content: 'Hi!', iteration: 0, ts: 1 },
        { type: 'text-finalize', iteration: 0, ts: 2 },
      ]},
      { role: 'user', content: 'How are you?' },
      { role: 'assistant', content: '', model: 'deepseek-chat', turnEvents: [
        { type: 'text-append', content: 'I am well!', iteration: 0, ts: 1 },
        { type: 'text-finalize', iteration: 0, ts: 2 },
      ]},
    ]);

    const counts = await countTurns(page);
    expect(counts.user).toBe(2);
    expect(counts.assistant).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2B. Pending Files Dropdown
// ─────────────────────────────────────────────────────────────────────────────

test.describe('2B. Pending Files Dropdown', () => {
  test('B1: applied file shows "all-applied" styling', async () => {
    const page = await freshPage();
    await replayHistory(page, [
      { role: 'assistant', content: '', model: 'deepseek-chat', turnEvents: [
        { type: 'text-append', content: 'Updated.', iteration: 0, ts: 1 },
        { type: 'text-finalize', iteration: 0, ts: 2 },
        { type: 'file-modified', path: 'app.ts', status: 'applied', editMode: 'ask', ts: 3 },
      ]},
    ]);

    const pending = await getPendingFiles(page, 'turn-1');
    expect(pending).toHaveLength(1);
    expect(pending[0].isAllApplied).toBe(true);
    expect(pending[0].shadowText).toContain('app.ts');
  });

  test('B2: rejected file shows "has-rejected" styling', async () => {
    const page = await freshPage();
    await replayHistory(page, [
      { role: 'assistant', content: '', model: 'deepseek-chat', turnEvents: [
        { type: 'text-append', content: 'Updated.', iteration: 0, ts: 1 },
        { type: 'text-finalize', iteration: 0, ts: 2 },
        { type: 'file-modified', path: 'bad.ts', status: 'rejected', editMode: 'ask', ts: 3 },
      ]},
    ]);

    const pending = await getPendingFiles(page, 'turn-1');
    expect(pending).toHaveLength(1);
    expect(pending[0].hasRejected).toBe(true);
  });

  test('B3: expired file renders with status text', async () => {
    const page = await freshPage();
    await replayHistory(page, [
      { role: 'assistant', content: '', model: 'deepseek-chat', turnEvents: [
        { type: 'text-append', content: 'Modified.', iteration: 0, ts: 1 },
        { type: 'text-finalize', iteration: 0, ts: 2 },
        { type: 'file-modified', path: 'stale.ts', status: 'expired', editMode: 'ask', ts: 3 },
      ]},
    ]);

    const text = await getPendingContainerText(page, 'turn-1');
    expect(text).toContain('stale.ts');
  });

  test('B4: deleted file renders with status text', async () => {
    const page = await freshPage();
    await replayHistory(page, [
      { role: 'assistant', content: '', model: 'deepseek-chat', turnEvents: [
        { type: 'text-append', content: 'Removed.', iteration: 0, ts: 1 },
        { type: 'text-finalize', iteration: 0, ts: 2 },
        { type: 'file-modified', path: 'gone.ts', status: 'deleted', editMode: 'auto', ts: 3 },
      ]},
    ]);

    const text = await getPendingContainerText(page, 'turn-1');
    expect(text).toContain('gone.ts');
  });

  test('B5: multiple files in one dropdown', async () => {
    const page = await freshPage();
    await replayHistory(page, [
      { role: 'assistant', content: '', model: 'deepseek-chat', turnEvents: [
        { type: 'text-append', content: 'Updated 3 files.', iteration: 0, ts: 1 },
        { type: 'text-finalize', iteration: 0, ts: 2 },
        { type: 'file-modified', path: 'a.ts', status: 'applied', editMode: 'auto', ts: 3 },
        { type: 'file-modified', path: 'b.ts', status: 'applied', editMode: 'auto', ts: 4 },
        { type: 'file-modified', path: 'c.ts', status: 'applied', editMode: 'auto', ts: 5 },
      ]},
    ]);

    const text = await getPendingContainerText(page, 'turn-1');
    expect(text).toContain('a.ts');
    expect(text).toContain('b.ts');
    expect(text).toContain('c.ts');
  });

  test('B6: auto mode shows "Modified Files" title', async () => {
    const page = await freshPage();
    await replayHistory(page, [
      { role: 'assistant', content: '', model: 'deepseek-chat', turnEvents: [
        { type: 'text-append', content: 'Done.', iteration: 0, ts: 1 },
        { type: 'text-finalize', iteration: 0, ts: 2 },
        { type: 'file-modified', path: 'auto.ts', status: 'applied', editMode: 'auto', ts: 3 },
      ]},
    ]);

    const text = await getPendingContainerText(page, 'turn-1');
    expect(text).toContain('Modified Files');
  });

  test('B7: ask mode shows "Pending Changes" title', async () => {
    const page = await freshPage();
    await replayHistory(page, [
      { role: 'assistant', content: '', model: 'deepseek-chat', turnEvents: [
        { type: 'text-append', content: 'Done.', iteration: 0, ts: 1 },
        { type: 'text-finalize', iteration: 0, ts: 2 },
        { type: 'file-modified', path: 'ask.ts', status: 'applied', editMode: 'ask', ts: 3 },
      ]},
    ]);

    const text = await getPendingContainerText(page, 'turn-1');
    expect(text).toContain('Pending Changes');
  });

  test('B8: mixed statuses — applied + rejected', async () => {
    const page = await freshPage();
    await replayHistory(page, [
      { role: 'assistant', content: '', model: 'deepseek-chat', turnEvents: [
        { type: 'text-append', content: 'Done.', iteration: 0, ts: 1 },
        { type: 'text-finalize', iteration: 0, ts: 2 },
        { type: 'file-modified', path: 'good.ts', status: 'applied', editMode: 'ask', ts: 3 },
        { type: 'file-modified', path: 'bad.ts', status: 'rejected', editMode: 'ask', ts: 4 },
      ]},
    ]);

    const pending = await getPendingFiles(page, 'turn-1');
    expect(pending).toHaveLength(1);
    // Has rejected files, so should NOT be all-applied
    expect(pending[0].isAllApplied).toBe(false);
    expect(pending[0].hasRejected).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2G. History Restore Fidelity (CQRS Replay)
//
// The highest-value tests: replay consolidated events and verify the DOM
// matches what would have been seen during live streaming.
// ─────────────────────────────────────────────────────────────────────────────

test.describe('2G. History Restore Fidelity', () => {
  test('G1: simple text restore — single text segment', async () => {
    const page = await freshPage();
    await replayHistory(page, [
      { role: 'assistant', content: '', model: 'deepseek-chat', turnEvents: [
        { type: 'text-append', content: 'This is a restored response.', iteration: 0, ts: 1 },
        { type: 'text-finalize', iteration: 0, ts: 2 },
      ]},
    ]);

    const texts = await getTextContents(page, 'turn-1');
    expect(texts).toHaveLength(1);
    expect(texts[0]).toBe('This is a restored response.');
  });

  test('G2: text + thinking restore — both segments rendered', async () => {
    const page = await freshPage();
    await replayHistory(page, [
      { role: 'assistant', content: '', model: 'deepseek-reasoner', turnEvents: [
        { type: 'thinking-start', iteration: 0, ts: 1 },
        { type: 'thinking-content', content: 'Deep analysis of the problem.', iteration: 0, ts: 2 },
        { type: 'thinking-complete', iteration: 0, ts: 3 },
        { type: 'text-append', content: 'Here is the conclusion.', iteration: 0, ts: 4 },
        { type: 'text-finalize', iteration: 0, ts: 5 },
      ]},
    ]);

    const thinking = await getThinkingContainers(page, 'turn-1');
    expect(thinking).toHaveLength(1);
    expect(thinking[0].text).toContain('Deep analysis');

    const texts = await getTextContents(page, 'turn-1');
    expect(texts).toHaveLength(1);
    expect(texts[0]).toBe('Here is the conclusion.');
  });

  test('G3: full R1 turn — thinking + text + shell + file-modified', async () => {
    const page = await freshPage();
    await replayHistory(page, [
      { role: 'assistant', content: '', model: 'deepseek-reasoner', turnEvents: [
        { type: 'thinking-start', iteration: 0, ts: 1 },
        { type: 'thinking-content', content: 'I need to create a config file.', iteration: 0, ts: 2 },
        { type: 'thinking-complete', iteration: 0, ts: 3 },
        { type: 'text-append', content: 'Creating the configuration.', iteration: 0, ts: 4 },
        { type: 'text-finalize', iteration: 0, ts: 5 },
        { type: 'shell-start', id: 'sh-1', commands: [{ command: 'cat > config.json' }], iteration: 0, ts: 6 },
        { type: 'shell-complete', id: 'sh-1', results: [{ output: '', success: true }], ts: 7 },
        { type: 'file-modified', path: 'config.json', status: 'applied', editMode: 'auto', ts: 8 },
      ]},
    ]);

    const thinking = await getThinkingContainers(page, 'turn-1');
    expect(thinking).toHaveLength(1);

    const texts = await getTextContents(page, 'turn-1');
    expect(texts.length).toBeGreaterThanOrEqual(1);
    expect(texts.join(' ')).toContain('Creating the configuration');

    const shells = await getShellContainers(page, 'turn-1');
    expect(shells).toHaveLength(1);

    const pending = await getPendingFiles(page, 'turn-1');
    expect(pending).toHaveLength(1);
    expect(pending[0].shadowText).toContain('config.json');
  });

  test('G4: ask mode applied — green applied status on restore', async () => {
    const page = await freshPage();
    await replayHistory(page, [
      { role: 'assistant', content: '', model: 'deepseek-chat', turnEvents: [
        { type: 'text-append', content: 'Updated your component.', iteration: 0, ts: 1 },
        { type: 'text-finalize', iteration: 0, ts: 2 },
        { type: 'file-modified', path: 'Component.tsx', status: 'applied', editMode: 'ask', ts: 3 },
      ]},
    ]);

    const pending = await getPendingFiles(page, 'turn-1');
    expect(pending).toHaveLength(1);
    expect(pending[0].isAllApplied).toBe(true);
    expect(pending[0].shadowText).toContain('applied');
  });

  test('G5: ask mode rejected — red rejected status on restore', async () => {
    const page = await freshPage();
    await replayHistory(page, [
      { role: 'assistant', content: '', model: 'deepseek-chat', turnEvents: [
        { type: 'text-append', content: 'Proposed changes.', iteration: 0, ts: 1 },
        { type: 'text-finalize', iteration: 0, ts: 2 },
        { type: 'file-modified', path: 'Component.tsx', status: 'rejected', editMode: 'ask', ts: 3 },
      ]},
    ]);

    const pending = await getPendingFiles(page, 'turn-1');
    expect(pending).toHaveLength(1);
    expect(pending[0].hasRejected).toBe(true);
  });

  test('G6: ask mode expired — expired status on restore', async () => {
    const page = await freshPage();
    await replayHistory(page, [
      { role: 'assistant', content: '', model: 'deepseek-chat', turnEvents: [
        { type: 'text-append', content: 'Proposed changes.', iteration: 0, ts: 1 },
        { type: 'text-finalize', iteration: 0, ts: 2 },
        { type: 'file-modified', path: 'old.ts', status: 'expired', editMode: 'ask', ts: 3 },
      ]},
    ]);

    const text = await getPendingContainerText(page, 'turn-1');
    expect(text).toContain('old.ts');
    expect(text).toContain('expired');
  });

  test('G7: auto mode restore — "Modified Files" dropdown with applied', async () => {
    const page = await freshPage();
    await replayHistory(page, [
      { role: 'assistant', content: '', model: 'deepseek-reasoner', turnEvents: [
        { type: 'text-append', content: 'Auto-applied the changes.', iteration: 0, ts: 1 },
        { type: 'text-finalize', iteration: 0, ts: 2 },
        { type: 'file-modified', path: 'auto-file.ts', status: 'applied', editMode: 'auto', ts: 3 },
      ]},
    ]);

    const text = await getPendingContainerText(page, 'turn-1');
    expect(text).toContain('Modified Files');
    expect(text).toContain('auto-file.ts');
  });

  test('G8: multi-iteration restore — 3 thinking + 3 text segments', async () => {
    const page = await freshPage();
    const events: any[] = [];
    let ts = 0;

    for (let i = 0; i < 3; i++) {
      events.push({ type: 'thinking-start', iteration: i, ts: ++ts });
      events.push({ type: 'thinking-content', content: `Iteration ${i} reasoning.`, iteration: i, ts: ++ts });
      events.push({ type: 'thinking-complete', iteration: i, ts: ++ts });
      events.push({ type: 'text-append', content: `Response ${i}.`, iteration: i, ts: ++ts });
      events.push({ type: 'text-finalize', iteration: i, ts: ++ts });
    }

    await replayHistory(page, [
      { role: 'assistant', content: '', model: 'deepseek-reasoner', turnEvents: events },
    ]);

    const thinking = await getThinkingContainers(page, 'turn-1');
    expect(thinking).toHaveLength(3);

    const texts = await getTextContents(page, 'turn-1');
    expect(texts).toHaveLength(3);
    expect(texts[0]).toBe('Response 0.');
    expect(texts[1]).toBe('Response 1.');
    expect(texts[2]).toBe('Response 2.');
  });

  test('G9: mixed editModes in one turn — different rendering per file', async () => {
    const page = await freshPage();
    await replayHistory(page, [
      { role: 'assistant', content: '', model: 'deepseek-reasoner', turnEvents: [
        { type: 'text-append', content: 'Updated files.', iteration: 0, ts: 1 },
        { type: 'text-finalize', iteration: 0, ts: 2 },
        { type: 'file-modified', path: 'shell-file.ts', status: 'applied', editMode: 'auto', ts: 3 },
        { type: 'file-modified', path: 'diff-file.ts', status: 'applied', editMode: 'ask', ts: 4 },
      ]},
    ]);

    // Both files should render (may be in same or separate containers)
    const segments = await getTurnSegments(page, 'turn-1');
    const pendingContainers = segments.filter(s => s.classes.includes('pending-container'));
    expect(pendingContainers.length).toBeGreaterThanOrEqual(1);

    // Both file names should appear somewhere in the turn
    const allText = pendingContainers.map(p => p.shadowText).join(' ');
    expect(allText).toContain('shell-file.ts');
    expect(allText).toContain('diff-file.ts');
  });

  test('G10: regression — applying one file does not mark other turns code block (same filename)', async () => {
    // Regression test: two turns both edit animals.txt in manual mode.
    // Only the second turn's file-modified is "applied". The first turn's
    // code block should NOT be marked as applied.
    const page = await freshPage();
    await replayHistory(page, [
      { role: 'user', content: 'Add turtle' },
      { role: 'assistant', content: '', model: 'deepseek-reasoner', turnEvents: [
        { type: 'text-append', content: 'Adding turtle.', iteration: 0, ts: 1 },
        { type: 'text-finalize', iteration: 0, ts: 2 },
        { type: 'code-block', language: 'plaintext', content: '# File: animals.txt\n<<<<<<< SEARCH\nhippo\n=======\nhippo\nturtle\n>>>>>>> REPLACE', file: 'animals.txt', iteration: 0, ts: 3 },
        // NOT applied — no file-modified event
      ]},
      { role: 'user', content: 'Add alligator' },
      { role: 'assistant', content: '', model: 'deepseek-reasoner', turnEvents: [
        { type: 'text-append', content: 'Adding alligator.', iteration: 0, ts: 1 },
        { type: 'text-finalize', iteration: 0, ts: 2 },
        { type: 'code-block', language: 'plaintext', content: '# File: animals.txt\n<<<<<<< SEARCH\nturtle\n=======\nturtle\nalligator\n>>>>>>> REPLACE', file: 'animals.txt', iteration: 0, ts: 3 },
        // This one WAS applied
        { type: 'file-modified', path: 'animals.txt', status: 'applied', editMode: 'manual', ts: 4 },
      ]},
    ]);

    // Check code blocks in each turn
    const codeBlockStatus = await page.evaluate(() => {
      const result: Record<string, boolean[]> = {};
      for (const tid of ['turn-2', 'turn-4']) {
        const el = document.querySelector(`[data-turn-id="${tid}"]`);
        if (!el) continue;
        const blocks: boolean[] = [];
        el.querySelectorAll('[data-container-id]').forEach(c => {
          const sr = (c as HTMLElement).shadowRoot;
          if (!sr) return;
          sr.querySelectorAll('.code-block').forEach(cb => {
            blocks.push(cb.classList.contains('applied'));
          });
        });
        result[tid] = blocks;
      }
      return result;
    });

    // Turn-2 (turtle): code block should NOT be applied
    expect(codeBlockStatus['turn-2']).toEqual([false]);
    // Turn-4 (alligator): code block SHOULD be applied
    expect(codeBlockStatus['turn-4']).toEqual([true]);
  });

  test('G11: full conversation restore — user + assistant alternating', async () => {
    const page = await freshPage();
    await replayHistory(page, [
      { role: 'user', content: 'Create a hello world app' },
      { role: 'assistant', content: '', model: 'deepseek-reasoner', turnEvents: [
        { type: 'thinking-start', iteration: 0, ts: 1 },
        { type: 'thinking-content', content: 'Simple task.', iteration: 0, ts: 2 },
        { type: 'thinking-complete', iteration: 0, ts: 3 },
        { type: 'text-append', content: 'Here is your app:', iteration: 0, ts: 4 },
        { type: 'text-finalize', iteration: 0, ts: 5 },
        { type: 'shell-start', id: 'sh-1', commands: [{ command: 'echo "Hello World" > app.js' }], iteration: 0, ts: 6 },
        { type: 'shell-complete', id: 'sh-1', results: [{ output: '', success: true }], ts: 7 },
        { type: 'file-modified', path: 'app.js', status: 'applied', editMode: 'auto', ts: 8 },
        { type: 'thinking-start', iteration: 1, ts: 9 },
        { type: 'thinking-content', content: 'Done.', iteration: 1, ts: 10 },
        { type: 'thinking-complete', iteration: 1, ts: 11 },
        { type: 'text-append', content: 'Your hello world app is ready!', iteration: 1, ts: 12 },
        { type: 'text-finalize', iteration: 1, ts: 13 },
      ]},
      { role: 'user', content: 'Thanks!' },
      { role: 'assistant', content: '', model: 'deepseek-reasoner', turnEvents: [
        { type: 'text-append', content: 'You\'re welcome!', iteration: 0, ts: 1 },
        { type: 'text-finalize', iteration: 0, ts: 2 },
      ]},
    ]);

    const counts = await countTurns(page);
    expect(counts.user).toBe(2);
    expect(counts.assistant).toBe(2);

    // First assistant turn should have thinking, shell, file-modified
    const thinking = await getThinkingContainers(page, 'turn-2');
    expect(thinking.length).toBeGreaterThanOrEqual(1);

    const shells = await getShellContainers(page, 'turn-2');
    expect(shells).toHaveLength(1);

    const pending = await getPendingFiles(page, 'turn-2');
    expect(pending).toHaveLength(1);
    expect(pending[0].shadowText).toContain('app.js');

    // Second assistant turn should be simple text
    const texts4 = await getTextContents(page, 'turn-4');
    expect(texts4).toHaveLength(1);
    expect(texts4[0]).toContain("You're welcome!");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2D. Input Area (Layer 2 portion — textarea behavior only)
// ─────────────────────────────────────────────────────────────────────────────

test.describe('2D. Input Area', () => {
  // The textarea is inside InputAreaShadowActor's shadow root.
  // Use #inputAreaContainer to scope the locator.
  const textareaSelector = '#inputAreaContainer textarea';

  test('D1: textarea exists and is focusable', async () => {
    const page = await freshPage();

    const textarea = page.locator(textareaSelector);
    await expect(textarea).toBeVisible();
    await textarea.click();

    // Verify focus landed inside the input area
    const isFocused = await page.evaluate(() => {
      const container = document.getElementById('inputAreaContainer');
      return document.activeElement === container || container?.shadowRoot?.activeElement?.tagName === 'TEXTAREA';
    });
    expect(isFocused).toBe(true);
  });

  test('D2: textarea accepts typed input', async () => {
    const page = await freshPage();

    const textarea = page.locator(textareaSelector);
    await textarea.click();
    await textarea.fill('Hello world');

    const value = await textarea.inputValue();
    expect(value).toBe('Hello world');
  });

  test('D3: textarea auto-resizes with content', async () => {
    const page = await freshPage();

    const textarea = page.locator(textareaSelector);
    await textarea.click();

    // Get initial height
    const initialHeight = await textarea.evaluate(el => el.scrollHeight);

    // Type multiple lines
    await textarea.fill('Line 1\nLine 2\nLine 3\nLine 4\nLine 5');

    const newHeight = await textarea.evaluate(el => el.scrollHeight);
    expect(newHeight).toBeGreaterThan(initialHeight);
  });
});
