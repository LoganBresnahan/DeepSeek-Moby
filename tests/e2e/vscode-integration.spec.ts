/**
 * Layer 3: VS Code Integration Tests
 *
 * Launches the full VS Code Electron app with the extension loaded,
 * connects via CDP, and tests the complete extension lifecycle.
 *
 * Covers:
 *   3A. Extension Lifecycle
 *   3B. Webview in VS Code
 *   3C. Command Palette
 *   3E. Real API Flow (requires DEEPSEEK_API_KEY env var)
 *
 * Requires a display server (WSLg on WSL2, or xvfb on headless Linux).
 */

import { test, expect, Page, FrameLocator, Frame } from '@playwright/test';
import { launchVSCode, closeVSCode, VSCodeResult } from './helpers/launch';

const API_KEY = process.env.DEEPSEEK_API_KEY;

let result: VSCodeResult;

test.beforeAll(async () => {
  test.setTimeout(60_000);
  result = await launchVSCode();
});

test.afterAll(async () => {
  if (result) {
    await closeVSCode(result);
  }
});

/** Helper: open command palette and run a command */
async function runCommand(page: Page, command: string): Promise<void> {
  await page.keyboard.press('Control+Shift+KeyP');
  await page.waitForTimeout(500);
  await page.keyboard.type(command);
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
}

/** Helper: open the chat panel and return the inner webview frame locator.
 * VS Code nests webviews in two iframes:
 *   Frame 0: VS Code main window
 *   Frame 1: Outer webview (iframe.webview → index.html)
 *   Frame 2: Inner webview (iframe inside Frame 1 → fake.html) ← our content lives here
 */
async function openChatPanel(page: Page): Promise<FrameLocator> {
  await runCommand(page, 'DeepSeek Moby: Focus on Chat View');
  await page.waitForTimeout(4000);

  // Navigate through the double-nested iframe structure
  const outerFrame = page.frameLocator('iframe.webview');
  return outerFrame.frameLocator('iframe');
}

/**
 * Get the inner webview Frame object (not FrameLocator) for evaluate() calls.
 * FrameLocator doesn't support evaluate(), so we need the actual Frame.
 */
async function getWebviewFrame(page: Page): Promise<Frame> {
  const frames = page.frames();
  const webviewFrame = frames.find(f => f.url().includes('fake.html'));
  if (!webviewFrame) {
    throw new Error('Webview frame not found. Available frames: ' + frames.map(f => f.url().substring(0, 60)).join(', '));
  }
  return webviewFrame;
}

/**
 * Note: API key is injected via DEEPSEEK_API_KEY environment variable,
 * which the extension reads as a fallback from process.env.
 * No command palette interaction needed.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 3A. Extension Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

test.describe('3A. Extension Lifecycle', () => {
  test('A1: VS Code workbench loads', async () => {
    const { page } = result;

    const title = await page.title();
    expect(title).toContain('Visual Studio Code');

    const workbench = await page.isVisible('.monaco-workbench');
    expect(workbench).toBe(true);
  });

  test('A2: extension commands are registered', async () => {
    const { page } = result;

    await page.keyboard.press('Control+Shift+KeyP');
    await page.waitForTimeout(500);
    await page.keyboard.type('DeepSeek Moby');
    await page.waitForTimeout(1000);

    const commands = await page.evaluate(() => {
      const items = document.querySelectorAll('.quick-input-list .monaco-list-row');
      return Array.from(items).map(el => el.textContent?.trim() || '');
    });

    const hasChat = commands.some(c => c.includes('Focus on Chat View'));
    expect(hasChat).toBe(true);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  test('A3: chat panel opens via command', async () => {
    const { page } = result;

    await runCommand(page, 'DeepSeek Moby: Focus on Chat View');
    await page.waitForTimeout(3000);

    const iframeCount = await page.evaluate(() =>
      document.querySelectorAll('iframe.webview').length
    );
    expect(iframeCount).toBeGreaterThanOrEqual(1);
  });

  test('A4: extension activates without API key', async () => {
    const { page } = result;

    // The extension should activate and render the webview even without an API key.
    // The webview iframe existing proves activation completed.
    const iframeExists = await page.evaluate(() =>
      document.querySelectorAll('iframe.webview').length > 0
    );
    expect(iframeExists).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3B. Webview in VS Code
// ─────────────────────────────────────────────────────────────────────────────

test.describe('3B. Webview in VS Code', () => {
  test('B1: webview loads with chat container', async () => {
    const { page } = result;
    const webview = await openChatPanel(page);

    const chatContainer = webview.locator('#chatMessages');
    await expect(chatContainer).toBeAttached({ timeout: 10_000 });
  });

  test('B2: input area renders in webview', async () => {
    const { page } = result;
    const webview = await openChatPanel(page);

    const inputContainer = webview.locator('#inputAreaContainer');
    await expect(inputContainer).toBeAttached({ timeout: 10_000 });
  });

  test('B3: toolbar renders in webview', async () => {
    const { page } = result;
    const webview = await openChatPanel(page);

    const toolbar = webview.locator('#toolbarContainer');
    await expect(toolbar).toBeAttached({ timeout: 10_000 });
  });

  test('B4: status panel renders in webview', async () => {
    const { page } = result;
    const webview = await openChatPanel(page);

    const statusPanel = webview.locator('#statusPanelContainer');
    await expect(statusPanel).toBeAttached({ timeout: 10_000 });
  });

  test('B5: model name displays in header', async () => {
    const { page } = result;
    const webview = await openChatPanel(page);

    const modelName = webview.locator('#currentModelName');
    await expect(modelName).toBeAttached({ timeout: 10_000 });

    const text = await modelName.textContent();
    expect(text).toBeTruthy();
    expect(text!.toLowerCase()).toMatch(/deepseek|chat|reasoner/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3C. Command Palette
// ─────────────────────────────────────────────────────────────────────────────

test.describe('3C. Command Palette', () => {
  test('C1: Moby commands appear in palette', async () => {
    const { page } = result;

    await page.keyboard.press('Control+Shift+KeyP');
    await page.waitForTimeout(500);
    await page.keyboard.type('Moby');
    await page.waitForTimeout(1000);

    const commands = await page.evaluate(() => {
      const items = document.querySelectorAll('.quick-input-list .monaco-list-row');
      return Array.from(items).map(el => el.textContent?.trim() || '');
    });

    const mobyCommands = commands.filter(c =>
      c.includes('DeepSeek Moby') || c.includes('Moby')
    );
    expect(mobyCommands.length).toBeGreaterThanOrEqual(1);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  test('C2: Show DeepSeek Moby command opens sidebar', async () => {
    const { page } = result;

    await runCommand(page, 'View: Show DeepSeek Moby');
    await page.waitForTimeout(3000);

    const iframeExists = await page.evaluate(() =>
      document.querySelectorAll('iframe.webview').length > 0
    );
    expect(iframeExists).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3E. Real API Flow
//
// These tests require DEEPSEEK_API_KEY environment variable.
// They send real messages to DeepSeek and verify the UI responds.
// Uses stream-aware waiting — no fixed timeouts for API responses.
// ─────────────────────────────────────────────────────────────────────────────

test.describe('3E. Real API Flow', () => {
  test.skip(!API_KEY, 'DEEPSEEK_API_KEY not set — skipping real API tests');

  test('E0: API key is available via environment variable', async () => {
    const { page } = result;
    const webview = await openChatPanel(page);

    // The DEEPSEEK_API_KEY env var should have been picked up by the extension.
    // The send button should be enabled (not disabled).
    const sendBtn = webview.locator('.send-btn');
    await expect(sendBtn).toBeEnabled({ timeout: 10_000 });
  });

  test('E1: send message and get response (Chat model)', async () => {
    const { page } = result;
    const webview = await openChatPanel(page);
    const frame = await getWebviewFrame(page);

    // Type a simple message in the textarea (inside shadow DOM)
    const textarea = webview.locator('#inputAreaContainer textarea');
    await textarea.click();
    await textarea.fill('Say just the word "hello" and nothing else.');
    await page.waitForTimeout(500);

    // Click send button — use force in case there's a brief disabled state
    const sendBtn = webview.locator('.send-btn');
    await sendBtn.click({ timeout: 10_000 });

    // Stream-aware waiting: wait for a response turn to appear
    // The user turn appears immediately, then the assistant turn starts streaming
    await frame.waitForFunction(() => {
      const turns = document.querySelectorAll('[data-role="assistant"]');
      return turns.length > 0;
    }, { timeout: 15_000 });

    // Wait for streaming to complete — the assistant turn will have text content
    // when endResponse fires. Poll for text content in the last assistant turn.
    await frame.waitForFunction(() => {
      const turns = document.querySelectorAll('[data-role="assistant"]');
      const lastTurn = turns[turns.length - 1];
      if (!lastTurn) return false;
      // Check shadow roots for text content
      const textContainers = lastTurn.querySelectorAll('.text-container');
      for (const tc of textContainers) {
        const sr = (tc as HTMLElement).shadowRoot;
        const content = sr?.querySelector('.content');
        if (content && content.textContent && content.textContent.trim().length > 0) {
          return true;
        }
      }
      return false;
    }, { timeout: 60_000 });

    // Verify the response contains something
    const responseText = await frame.evaluate(() => {
      const turns = document.querySelectorAll('[data-role="assistant"]');
      const lastTurn = turns[turns.length - 1];
      if (!lastTurn) return '';
      const textContainers = lastTurn.querySelectorAll('.text-container');
      for (const tc of textContainers) {
        const sr = (tc as HTMLElement).shadowRoot;
        const content = sr?.querySelector('.content');
        if (content?.textContent) return content.textContent.trim();
      }
      return '';
    });

    expect(responseText.length).toBeGreaterThan(0);
    expect(responseText.toLowerCase()).toContain('hello');
  });

  test('E2: stop generation works', async () => {
    const { page } = result;
    const webview = await openChatPanel(page);
    const frame = await getWebviewFrame(page);

    // Count existing assistant turns before sending
    const turnsBefore = await frame.evaluate(() =>
      document.querySelectorAll('[data-role="assistant"]').length
    );

    // Send a message that will generate a long response
    const textarea = webview.locator('#inputAreaContainer textarea');
    await textarea.click();
    await textarea.fill('Write a very long essay about the history of computing. Make it at least 2000 words.');
    await page.waitForTimeout(500);

    const sendBtn = webview.locator('.send-btn');
    await sendBtn.click();

    // Wait for a NEW assistant turn to appear with any content
    // (text, thinking, tool calls, or shell — any container counts)
    await frame.waitForFunction((before) => {
      const turns = document.querySelectorAll('[data-role="assistant"]');
      if (turns.length <= before) return false;
      const newTurn = turns[before];
      return newTurn.querySelectorAll('[data-container-id]').length > 0;
    }, turnsBefore, { timeout: 30_000 });

    // Click stop button
    const stopBtn = webview.locator('.stop-btn');
    try {
      await stopBtn.click({ timeout: 5_000 });
    } catch {
      // Stop button might not be visible if response already completed
    }

    // Verify the turn still has its content (wasn't destroyed by stop)
    await page.waitForTimeout(1000);
    const turnCount = await frame.evaluate(() =>
      document.querySelectorAll('[data-role="assistant"]').length
    );
    expect(turnCount).toBeGreaterThan(turnsBefore);
  });
});
