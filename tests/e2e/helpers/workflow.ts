/**
 * Workflow Test Helpers
 *
 * Common utilities for Layer 3 workflow tests that interact with
 * the real VS Code extension and DeepSeek API.
 */

import { Page, FrameLocator, Frame } from 'playwright';

/** Open command palette and run a command */
export async function runCommand(page: Page, command: string): Promise<void> {
  await page.keyboard.press('Control+Shift+KeyP');
  await page.waitForTimeout(500);
  await page.keyboard.type(command);
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
}

/** Open the chat panel and return the inner webview frame locator */
export async function openChatPanel(page: Page): Promise<FrameLocator> {
  await runCommand(page, 'DeepSeek Moby: Focus on Chat View');
  await page.waitForTimeout(4000);
  const outerFrame = page.frameLocator('iframe.webview');
  return outerFrame.frameLocator('iframe');
}

/** Get the inner webview Frame object for evaluate() calls.
 * Searches for the frame containing our webview content.
 * Retries for up to 10 seconds since the frame may not be immediately available.
 */
export async function getWebviewFrame(page: Page): Promise<Frame> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const frames = page.frames();
    // Try fake.html first (VS Code 1.92 pattern)
    const fakeFrame = frames.find(f => f.url().includes('fake.html'));
    if (fakeFrame) return fakeFrame;

    // Try any vscode-webview frame that has our content
    for (const f of frames) {
      if (!f.url().includes('vscode-webview')) continue;
      try {
        const hasContent = await f.evaluate(() =>
          !!document.getElementById('chatMessages') ||
          !!document.getElementById('toolbarContainer')
        );
        if (hasContent) return f;
      } catch { /* frame not ready */ }
    }

    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Webview frame not found after 10s. Frames: ' +
    page.frames().map(f => f.url().substring(0, 80)).join(', '));
}

/**
 * Id of the last rendered assistant turn, or null if there is none.
 *
 * Identity, not count: VirtualListActor recycles off-screen turns
 * (`actor.element.remove()`), so in a long conversation the number of
 * rendered turns stops growing — a "wait until count increases" check
 * then never fires. Every wait below keys off this id instead.
 */
export async function getLastAssistantTurnId(frame: Frame): Promise<string | null> {
  return frame.evaluate(() => {
    const turns = document.querySelectorAll('[data-role="assistant"]');
    const last = turns[turns.length - 1];
    return last ? last.getAttribute('data-turn-id') : null;
  });
}

/**
 * Wait until the composer can accept a new message.
 *
 * The toolbar hides the send button while a turn streams, so clicking it
 * mid-stream fails with "element is not visible". Tests that send without
 * waiting inherit whatever the previous test left running.
 */
export async function waitForComposerReady(
  webview: FrameLocator,
  timeoutMs = 240_000
): Promise<void> {
  await webview.locator('.send-btn').waitFor({ state: 'visible', timeout: timeoutMs });
}

/**
 * Start a fresh chat.
 *
 * The workflow suite shares one VS Code instance across every test, so the
 * conversation grows all run. Blocks that don't depend on earlier turns
 * should reset first: a long transcript makes each request slower and gives
 * the model more room to answer in an unexpected shape.
 */
export async function startNewChat(page: Page, frame: Frame): Promise<void> {
  const newChatBtn = page.locator('a[title="New Chat"], .action-item a', { hasText: 'New Chat' });
  try {
    await newChatBtn.first().click({ timeout: 5000 });
  } catch {
    await frame.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'clearChat' } }));
    });
  }
  await frame
    .waitForFunction(() => document.querySelectorAll('[data-role="assistant"]').length === 0, {
      timeout: 10_000,
    })
    .catch(() => { /* best effort — some views keep a placeholder turn */ });
}

/**
 * Wait for a file's contents to differ from `baseline`. Returns false if it
 * never changed — i.e. the model declined to edit, which is a model choice,
 * not a product failure. Callers decide whether that is skip-worthy.
 */
export async function waitForFileChange(
  filePath: string,
  baseline: string,
  timeoutMs = 60_000,
  pollMs = 500
): Promise<boolean> {
  const fs = require('fs');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.readFileSync(filePath, 'utf-8') !== baseline) return true;
    } catch { /* file may be mid-write */ }
    await new Promise(r => setTimeout(r, pollMs));
  }
  return false;
}

/**
 * Which route a model took to perform an edit.
 *
 * `approval-ui`  — it emitted a SEARCH/REPLACE block, so Ask mode rendered a
 *                  pending container with accept/reject buttons.
 * `direct-write` — it ran a shell command instead, so the file changed on
 *                  disk and no approval UI ever appeared.
 */
export type EditMechanism = 'approval-ui' | 'direct-write';

/**
 * Wait for an edit request to surface either way, and report which happened.
 *
 * Models without native tool calling (R1, including users running R1 locally
 * via Ollama, and any future text-only model) answer an edit request with a
 * SEARCH/REPLACE block — but the same model may decide to shell out to `sed`
 * instead, even when told not to. Both are legitimate product behaviour, so a
 * test that waits only for the approval UI hangs whenever the model picks the
 * other route. Callers branch on the result rather than failing.
 */
export async function waitForEditMechanism(
  frame: Frame,
  opts: {
    prevTurnId: string | null;
    button: '.accept-btn' | '.reject-btn';
    filePath: string;
    /** File contents before the request was sent. */
    baseline: string;
    timeoutMs?: number;
    pollMs?: number;
  }
): Promise<EditMechanism> {
  const fs = require('fs');
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const pollMs = opts.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const uiReady = await frame.evaluate(({ prevId, button }) => {
      const turns = document.querySelectorAll('[data-role="assistant"]');
      const newTurn = turns[turns.length - 1];
      if (!newTurn || newTurn.getAttribute('data-turn-id') === prevId) return false;
      for (const pc of newTurn.querySelectorAll('.pending-container')) {
        const sr = (pc as HTMLElement).shadowRoot;
        if (sr?.querySelector(button)) return true;
      }
      return false;
    }, { prevId: opts.prevTurnId, button: opts.button });

    if (uiReady) return 'approval-ui';

    let current = opts.baseline;
    try {
      current = fs.readFileSync(opts.filePath, 'utf-8');
    } catch { /* file may not exist yet */ }
    if (current !== opts.baseline) return 'direct-write';

    await new Promise(r => setTimeout(r, pollMs));
  }

  throw new Error(
    `waitForEditMechanism: neither ${opts.button} nor a change to ` +
    `${opts.filePath} appeared within ${timeoutMs}ms`
  );
}

/** Send a message in the chat and wait for the response to complete */
export async function sendMessageAndWait(
  page: Page,
  webview: FrameLocator,
  frame: Frame,
  message: string,
  options?: { timeout?: number }
): Promise<void> {
  const timeout = options?.timeout ?? 240_000;

  const previousTurnId = await getLastAssistantTurnId(frame);

  // Type and send
  const textarea = webview.locator('#inputAreaContainer textarea');
  await textarea.click();
  await textarea.fill(message);
  await page.waitForTimeout(300);

  const sendBtn = webview.locator('.send-btn');
  await sendBtn.click({ timeout: 10_000 });

  // Wait for a new assistant turn with content to appear
  await frame.waitForFunction((prevId) => {
    const turns = document.querySelectorAll('[data-role="assistant"]');
    const newTurn = turns[turns.length - 1];
    if (!newTurn || newTurn.getAttribute('data-turn-id') === prevId) return false;
    return newTurn.querySelectorAll('[data-container-id]').length > 0;
  }, previousTurnId, { timeout: 30_000 });

  // Wait for the response to settle.
  //
  // Waiting only for the stop button to disappear races the START of
  // streaming: the button is display:none until the first token, so the
  // check passes instantly and the caller asserts against an empty turn
  // (the W18 failure). Settling on rendered content is independent of that
  // race and of model speed — a reasoning model's thinking text keeps
  // changing while it streams, so stability implies the turn is done.
  const deadline = Date.now() + timeout;
  let previous: string | null = null;
  let stablePolls = 0;

  while (Date.now() < deadline) {
    const state = await frame.evaluate(() => {
      const toolbar = document.getElementById('toolbarContainer');
      const stopBtn = toolbar?.shadowRoot?.querySelector('.stop-btn') as HTMLElement | null;
      const streaming = !!stopBtn && stopBtn.style.display !== 'none' && stopBtn.offsetParent !== null;

      const turns = document.querySelectorAll('[data-role="assistant"]');
      const last = turns[turns.length - 1] as HTMLElement | undefined;
      // Include shadow content — the visible text lives inside each
      // container's shadow root, not the turn's light DOM.
      const parts: string[] = [];
      last?.querySelectorAll('[data-container-id]').forEach(c => {
        const sr = (c as HTMLElement).shadowRoot;
        parts.push(sr ? sr.textContent ?? '' : c.textContent ?? '');
      });
      return { streaming, content: parts.join('') };
    });

    const settled = !state.streaming && state.content.trim().length > 0;
    stablePolls = settled && state.content === previous ? stablePolls + 1 : 0;
    previous = state.content;

    if (stablePolls >= 3) return;
    await page.waitForTimeout(500);
  }

  throw new Error(
    `sendMessageAndWait: response did not settle within ${timeout}ms ` +
    `(last content: ${JSON.stringify((previous ?? '').slice(0, 120))})`
  );
}

/** Get text content from the last assistant turn */
export async function getLastAssistantText(frame: Frame): Promise<string> {
  return frame.evaluate(() => {
    const turns = document.querySelectorAll('[data-role="assistant"]');
    const lastTurn = turns[turns.length - 1];
    if (!lastTurn) return '';
    const texts: string[] = [];
    lastTurn.querySelectorAll('.text-container').forEach(tc => {
      const content = (tc as HTMLElement).shadowRoot?.querySelector('.content');
      if (content?.textContent) texts.push(content.textContent.trim());
    });
    return texts.join('\n');
  });
}

/** Get info about pending files in a specific turn */
export async function getTurnPendingFiles(frame: Frame, turnIndex: number): Promise<{
  containerClasses: string[];
  shadowText: string;
  isAllApplied: boolean;
  hasRejected: boolean;
}[]> {
  return frame.evaluate((idx) => {
    const turns = document.querySelectorAll('[data-role="assistant"]');
    const turn = turns[idx];
    if (!turn) return [];
    const containers = turn.querySelectorAll('.pending-container');
    return Array.from(containers).map(c => {
      const classList = Array.from(c.classList);
      const sr = (c as HTMLElement).shadowRoot;
      return {
        containerClasses: classList,
        shadowText: sr?.textContent?.trim() || '',
        isAllApplied: classList.includes('all-applied'),
        hasRejected: classList.includes('has-rejected'),
      };
    });
  }, turnIndex);
}

/** Get code block applied status for a specific assistant turn */
export async function getTurnCodeBlockStatus(frame: Frame, turnIndex: number): Promise<boolean[]> {
  return frame.evaluate((idx) => {
    const turns = document.querySelectorAll('[data-role="assistant"]');
    const turn = turns[idx];
    if (!turn) return [];
    const blocks: boolean[] = [];
    turn.querySelectorAll('[data-container-id]').forEach(c => {
      const sr = (c as HTMLElement).shadowRoot;
      if (!sr) return;
      sr.querySelectorAll('.code-block').forEach(cb => {
        blocks.push(cb.classList.contains('applied'));
      });
    });
    return blocks;
  }, turnIndex);
}

/** Count assistant turns */
export async function countAssistantTurns(frame: Frame): Promise<number> {
  return frame.evaluate(() =>
    document.querySelectorAll('[data-role="assistant"]').length
  );
}

/** Check if thinking containers exist in the last assistant turn */
export async function hasThinkingInLastTurn(frame: Frame): Promise<boolean> {
  return frame.evaluate(() => {
    const turns = document.querySelectorAll('[data-role="assistant"]');
    const lastTurn = turns[turns.length - 1];
    if (!lastTurn) return false;
    return lastTurn.querySelectorAll('.thinking-container').length > 0;
  });
}

/** Check if shell containers exist in the last assistant turn */
export async function hasShellInLastTurn(frame: Frame): Promise<boolean> {
  return frame.evaluate(() => {
    const turns = document.querySelectorAll('[data-role="assistant"]');
    const lastTurn = turns[turns.length - 1];
    if (!lastTurn) return false;
    return lastTurn.querySelectorAll('.shell-container').length > 0;
  });
}
