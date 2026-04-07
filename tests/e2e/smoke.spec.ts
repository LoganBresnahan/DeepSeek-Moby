/**
 * Smoke Test — Verify Playwright + Chromium + Webview setup works.
 *
 * Launches the webview in headless Chromium via a test harness HTML.
 * Verifies basic rendering and the VS Code API mock bridge.
 */

import { test, expect } from '@playwright/test';
import { launchWebview, closeWebview, WebviewResult } from './helpers/launch';
import { resolve } from 'path';

const HARNESS_PATH = resolve(__dirname, 'helpers', 'harness.html');

let result: WebviewResult;

test.beforeAll(async () => {
  result = await launchWebview();
});

test.afterAll(async () => {
  if (result) {
    await closeWebview(result);
  }
});

test('Chromium launches and can render a page', async () => {
  const { page } = result;

  await page.setContent('<html><body><h1>Smoke Test</h1></body></html>');
  const heading = await page.textContent('h1');
  expect(heading).toBe('Smoke Test');
});

test('VS Code API mock is injected and captures messages', async () => {
  const { page } = result;

  // Navigate to harness (addInitScript runs before page scripts)
  await page.goto(`file://${HARNESS_PATH}`);
  await page.waitForTimeout(500);

  const hasApi = await page.evaluate(() => {
    return typeof (window as any).acquireVsCodeApi === 'function';
  });
  expect(hasApi).toBe(true);

  // chat.js sends init messages (webviewReady, getSettings) — verify they're captured
  const messages = await page.evaluate(() => (window as any).__vscodeMessages);
  expect(messages.length).toBeGreaterThanOrEqual(1);
  // The actor system sends webviewReady and getSettings on init
  const types = messages.map((m: any) => m.type);
  expect(types).toContain('getSettings');
});

test('webview harness loads chat.js without crashing', async () => {
  const { page } = result;

  // Collect page errors (uncaught exceptions)
  const pageErrors: string[] = [];
  page.on('pageerror', err => {
    pageErrors.push(err.message);
  });

  await page.goto(`file://${HARNESS_PATH}`);
  await page.waitForTimeout(2000);

  // The page body should exist and be visible
  const bodyExists = await page.isVisible('body');
  expect(bodyExists).toBe(true);

  // The chat container should be rendered
  const chatContainer = await page.isVisible('.chat-container');
  expect(chatContainer).toBe(true);

  // Log any errors for debugging (don't fail — some VS Code-specific errors are expected)
  if (pageErrors.length > 0) {
    console.log('Page errors (expected in harness mode):', pageErrors);
  }
});
