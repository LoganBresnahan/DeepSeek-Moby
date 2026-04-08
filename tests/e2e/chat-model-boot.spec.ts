/**
 * Test: Chat model — Manual mode should not be available
 *
 * Tests that when the model is Chat (V3), the edit mode button
 * only cycles between Q (Ask) and A (Auto), never M (Manual).
 * This tests the fix within a single VS Code session.
 */

import { test, expect, Frame } from '@playwright/test';
import { launchVSCode, closeVSCode, VSCodeResult } from './helpers/launch';
import {
  runCommand,
  openChatPanel,
  getWebviewFrame,
  sendMessageAndWait,
} from './helpers/workflow';

const API_KEY = process.env.DEEPSEEK_API_KEY;

test.describe('Chat Model: Manual mode restricted', () => {
  test.skip(!API_KEY, 'DEEPSEEK_API_KEY not set');

  let result: VSCodeResult;

  test.beforeAll(async () => {
    result = await launchVSCode();
  }, 60_000);

  test.afterAll(async () => {
    if (result) await closeVSCode(result);
  });

  test('switch to Chat model then verify Manual not available', async () => {
    const { page } = result;
    const webview = await openChatPanel(page);
    const frame = await getWebviewFrame(page);

    // Wait for settings to arrive
    await page.waitForTimeout(3000);

    // Switch to Chat model
    const headerModelBtn = webview.locator('#modelBtn');
    await headerModelBtn.click();
    await page.waitForTimeout(500);
    const chatOption = webview.locator('.model-option-name', { hasText: 'Chat' });
    await chatOption.click({ timeout: 5000 });
    await page.waitForTimeout(2000);

    // Now cycle edit mode button 4 times and collect modes
    const modes: string[] = [];
    for (let i = 0; i < 4; i++) {
      const text = await frame.evaluate(() => {
        const toolbar = document.getElementById('toolbarContainer');
        const btn = toolbar?.shadowRoot?.querySelector('.edit-mode-btn');
        return btn?.textContent?.trim() || '';
      });
      modes.push(text);
      await frame.evaluate(() => {
        const toolbar = document.getElementById('toolbarContainer');
        const btn = toolbar?.shadowRoot?.querySelector('.edit-mode-btn') as HTMLElement;
        btn?.click();
      });
      await page.waitForTimeout(300);
    }

    // Manual (M) should never appear
    expect(modes.some(m => m.includes('M'))).toBe(false);
    // Should have Q and A
    expect(modes.some(m => m.includes('Q'))).toBe(true);
    expect(modes.some(m => m.includes('A'))).toBe(true);
  });

  test('switch back to Reasoner then Manual is available again', async () => {
    const { page } = result;
    const webview = await openChatPanel(page);
    const frame = await getWebviewFrame(page);

    // Switch to Reasoner
    const headerModelBtn = webview.locator('#modelBtn');
    await headerModelBtn.click();
    await page.waitForTimeout(500);
    const reasonerOption = webview.locator('.model-option-name', { hasText: 'Reasoner' });
    await reasonerOption.click({ timeout: 5000 });
    await page.waitForTimeout(2000);

    // Cycle 4 times — should include M
    const modes: string[] = [];
    for (let i = 0; i < 4; i++) {
      const text = await frame.evaluate(() => {
        const toolbar = document.getElementById('toolbarContainer');
        const btn = toolbar?.shadowRoot?.querySelector('.edit-mode-btn');
        return btn?.textContent?.trim() || '';
      });
      modes.push(text);
      await frame.evaluate(() => {
        const toolbar = document.getElementById('toolbarContainer');
        const btn = toolbar?.shadowRoot?.querySelector('.edit-mode-btn') as HTMLElement;
        btn?.click();
      });
      await page.waitForTimeout(300);
    }

    expect(modes.some(m => m.includes('M'))).toBe(true);
  });
});
