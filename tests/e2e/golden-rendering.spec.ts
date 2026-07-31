/**
 * Golden rendering fixtures (Layer 2, Chromium harness).
 *
 * Replays representative turn-event streams through the real webview bundle
 * and pins the rendered segment structure against checked-in goldens in
 * tests/e2e/goldens/. Each scenario also writes a screenshot next to its
 * golden so a human (or agent) can eyeball what the pinned structure looks
 * like before accepting a regeneration.
 *
 * Regenerate deliberately after reviewing the screenshots:
 *   MOBY_GOLDEN_UPDATE=1 npx playwright test golden-rendering
 *
 * The goldens pin *structure* (segment kinds, order, text), not pixels —
 * pixel-diffing is too brittle across font stacks. Screenshots are review
 * artifacts, committed so golden diffs come with a visual.
 */

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { launchWebview, closeWebview, WebviewResult } from './helpers/launch';
import { loadHarness, replayHistory, getTurnSegments, HistoryTurn } from './helpers/replay';

const GOLDEN_DIR = resolve(__dirname, 'goldens');
const UPDATE = process.env.MOBY_GOLDEN_UPDATE === '1';

let result: WebviewResult;

test.beforeAll(async () => {
  result = await launchWebview();
  mkdirSync(GOLDEN_DIR, { recursive: true });
});

test.afterAll(async () => {
  if (result) await closeWebview(result);
});

interface Scenario {
  name: string;
  turns: HistoryTurn[];
  /** turn ids whose segment structure gets pinned */
  pinTurns: string[];
}

// Representative streams: the surfaces where a rendering regression would be
// silent (markdown transforms, code-block extraction, multi-iteration R1
// turns with thinking/shell/approval interleaving).
const SCENARIOS: Scenario[] = [
  {
    name: 'markdown-rich-text',
    pinTurns: ['turn-2'],
    turns: [
      { role: 'user', content: 'Show me markdown' },
      {
        role: 'assistant', content: '', model: 'deepseek-chat', turnEvents: [
          {
            type: 'text-append', iteration: 0, ts: 1, content: [
              '# Heading',
              '',
              'A paragraph with **bold**, `inline code`, and a [link](https://example.com).',
              '',
              '| col A | col B |',
              '|-------|-------|',
              '| 1     | 2     |',
              '',
              '> a blockquote',
              '',
              '- item one',
              '- item two',
            ].join('\n'),
          },
          { type: 'text-finalize', iteration: 0, ts: 2 },
        ],
      },
    ],
  },
  {
    // STALE FIXTURE (triaged 2026-07-31): standalone code-block events are
    // deliberately a no-op on restore (557ffa3) because real persisted data
    // always carries the fence inside a text event — this synthetic stream
    // cannot occur in reality. Re-author this scenario with the fence in
    // text-append content (see tracker Active Bugs / G10).
    name: 'code-block-with-file-header',
    pinTurns: ['turn-2'],
    turns: [
      { role: 'user', content: 'Write a hello module' },
      {
        role: 'assistant', content: '', model: 'deepseek-chat', turnEvents: [
          { type: 'text-append', iteration: 0, ts: 1, content: 'Here is the module:\n' },
          {
            type: 'code-block', iteration: 0, ts: 2,
            language: 'typescript', file: 'src/hello.ts',
            content: '# File: src/hello.ts\nexport function hello(name: string): string {\n  return `Hello ${name}`;\n}\n',
          },
          { type: 'text-append', iteration: 0, ts: 3, content: 'Done.' },
          { type: 'text-finalize', iteration: 0, ts: 4 },
        ],
      },
    ],
  },
  {
    name: 'r1-multi-iteration-shell-turn',
    pinTurns: ['turn-2'],
    turns: [
      { role: 'user', content: 'List the files then summarize' },
      {
        role: 'assistant', content: '', model: 'deepseek-reasoner', turnEvents: [
          { type: 'thinking-start', iteration: 0, ts: 1 },
          { type: 'thinking-content', content: 'I should list the directory first.', iteration: 0, ts: 2 },
          { type: 'thinking-complete', iteration: 0, ts: 3 },
          { type: 'shell-start', id: 'sh-1', commands: [{ command: 'ls src/' }], iteration: 0, ts: 4 },
          { type: 'shell-complete', id: 'sh-1', results: [{ output: 'extension.ts\nproviders/', success: true }], ts: 5 },
          { type: 'thinking-start', iteration: 1, ts: 6 },
          { type: 'thinking-content', content: 'Two entries. Summarizing.', iteration: 1, ts: 7 },
          { type: 'thinking-complete', iteration: 1, ts: 8 },
          { type: 'text-append', content: 'The src directory holds the entry point and providers.', iteration: 1, ts: 9 },
          { type: 'text-finalize', iteration: 1, ts: 10 },
        ],
      },
    ],
  },
];

// Strip volatile attributes so goldens don't churn on irrelevant details.
function normalize(segments: Awaited<ReturnType<typeof getTurnSegments>>) {
  return segments.map(s => ({
    classes: s.classes,
    hasShadow: s.hasShadow,
    shadowText: s.shadowText,
  }));
}

for (const scenario of SCENARIOS) {
  test(`golden: ${scenario.name}`, async () => {
    const { page } = result;
    await loadHarness(page);
    await replayHistory(page, scenario.turns);

    const pinned: Record<string, unknown> = {};
    for (const turnId of scenario.pinTurns) {
      pinned[turnId] = normalize(await getTurnSegments(page, turnId));
    }

    await page.screenshot({
      path: resolve(GOLDEN_DIR, `${scenario.name}.png`),
      fullPage: true,
    });

    const goldenPath = resolve(GOLDEN_DIR, `${scenario.name}.json`);
    if (UPDATE) {
      writeFileSync(goldenPath, JSON.stringify(pinned, null, 2) + '\n');
    }
    const golden = JSON.parse(readFileSync(goldenPath, 'utf-8'));
    expect(pinned, `rendering changed for ${scenario.name} — review ${scenario.name}.png, then regenerate with MOBY_GOLDEN_UPDATE=1`).toEqual(golden);
  });
}
