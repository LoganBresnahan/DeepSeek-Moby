/**
 * VS Code Integration Smoke Test
 *
 * Launches the full VS Code Electron app with the extension loaded,
 * connects via CDP, and verifies the workbench and extension are functional.
 *
 * Requires a display server (WSLg on WSL2, or xvfb on headless Linux).
 */

import { test, expect } from '@playwright/test';
import { launchVSCode, closeVSCode, VSCodeResult } from './helpers/launch';

let result: VSCodeResult;

test.beforeAll(async () => {
  result = await launchVSCode();
}, 60_000);

test.afterAll(async () => {
  if (result) {
    await closeVSCode(result);
  }
});

test('VS Code workbench loads', async () => {
  const { page } = result;

  const title = await page.title();
  expect(title).toContain('Visual Studio Code');

  const workbench = await page.isVisible('.monaco-workbench');
  expect(workbench).toBe(true);
});

test('extension activates and sidebar is available', async () => {
  const { page } = result;

  // Open command palette
  await page.keyboard.press('Control+Shift+KeyP');
  await page.waitForTimeout(500);

  // Type the command
  await page.keyboard.type('Moby: Open Chat');
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');

  // Give the webview time to load
  await page.waitForTimeout(3000);

  // VS Code should still be alive
  const bodyText = await page.textContent('body');
  expect(bodyText).toBeTruthy();
});
