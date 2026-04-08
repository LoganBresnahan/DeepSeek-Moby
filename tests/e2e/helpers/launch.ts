/**
 * VS Code Webview Test Helper
 *
 * Two launch modes:
 *
 * 1. launchWebview() — Opens the built webview HTML directly in Playwright's
 *    Chromium. Fast, headless, no VS Code dependency. Tests rendering,
 *    shadow DOM, dropdowns, styles, and event replay.
 *
 * 2. launchVSCode() — Launches the full VS Code Electron app with the
 *    extension loaded. Slower, requires display server. Tests the complete
 *    integration including command palette, sidebar, and VS Code APIs.
 *    Uses @vscode/test-electron to manage the VS Code binary.
 */

import { chromium, Browser, Page } from 'playwright';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { spawn, ChildProcess } from 'child_process';
import { resolve } from 'path';

// ── Webview-only mode (fast, headless) ──

export interface WebviewResult {
  browser: Browser;
  page: Page;
}

/**
 * Launch the webview HTML directly in Chromium for fast UI testing.
 * No VS Code shell — tests the rendering layer in isolation.
 */
export async function launchWebview(): Promise<WebviewResult> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Mock the VS Code API that the webview expects
  await page.addInitScript(() => {
    (window as any).acquireVsCodeApi = () => ({
      postMessage: (msg: any) => {
        // Store messages for test assertions
        (window as any).__vscodeMessages = (window as any).__vscodeMessages || [];
        (window as any).__vscodeMessages.push(msg);
      },
      getState: () => ({}),
      setState: () => {},
    });
  });

  return { browser, page };
}

/**
 * Close Chromium browser.
 */
export async function closeWebview(result: WebviewResult): Promise<void> {
  await result.browser.close();
}

// ── Full VS Code mode (slow, requires display) ──

export interface VSCodeResult {
  browser: Browser;
  page: Page;
  vscodeProcess: ChildProcess;
  workspacePath: string;
}

/**
 * Launch VS Code with the extension and connect via CDP.
 *
 * Requires a display server (WSLg, X11, or xvfb).
 * Downloads a cached VS Code binary on first run.
 */
export async function launchVSCode(workspacePath?: string, options?: { userDataDir?: string }): Promise<VSCodeResult> {
  const extensionPath = resolve(__dirname, '..', '..', '..');
  const vscodePath = process.env.VSCODE_PATH ?? await downloadAndUnzipVSCode('1.92.2');
  const debugPort = 9222 + Math.floor(Math.random() * 1000);
  const userDataDir = options?.userDataDir ?? `/tmp/vscode-e2e-${Date.now()}`;

  const args = [
    `--extensionDevelopmentPath=${extensionPath}`,
    '--skip-welcome',
    '--disable-workspace-trust',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-gpu-sandbox',
    '--password-store=basic',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
  ];

  // Open a workspace folder — extension activation may block without one
  let actualWorkspace: string;
  if (workspacePath) {
    actualWorkspace = workspacePath;
  } else {
    actualWorkspace = `/tmp/vscode-e2e-workspace-${Date.now()}`;
    require('fs').mkdirSync(actualWorkspace, { recursive: true });
  }
  args.push(actualWorkspace);

  // Clean the environment: when running inside VS Code's integrated terminal,
  // ELECTRON_RUN_AS_NODE=1 is inherited, which causes the code binary to act
  // as a plain Node.js runtime instead of launching the Electron GUI.
  const env = { ...process.env, DONT_PROMPT_WSL_INSTALL: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VSCODE_IPC_HOOK_CLI;
  delete env.VSCODE_NLS_CONFIG;
  delete env.VSCODE_HANDLES_SIGPIPE;
  delete env.VSCODE_HANDLES_UNCAUGHT_ERRORS;
  delete env.VSCODE_ESM_ENTRYPOINT;

  const vscodeProcess = spawn(vscodePath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });

  await waitForDebugPort(vscodeProcess, debugPort);

  const browser = await chromium.connectOverCDP(`http://localhost:${debugPort}`);
  const page = browser.contexts()[0]?.pages()[0] ?? await browser.contexts()[0]?.newPage();

  if (!page) {
    throw new Error('No VS Code window found after launch');
  }

  return { browser, page, vscodeProcess, workspacePath: actualWorkspace };
}

function waitForDebugPort(proc: ChildProcess, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`VS Code debugging port ${port} not ready within 30s`));
    }, 30_000);

    const onData = (data: Buffer) => {
      if (data.toString().includes('DevTools listening')) {
        clearTimeout(timeout);
        proc.stderr?.off('data', onData);
        setTimeout(resolve, 1000);
      }
    };
    proc.stderr?.on('data', onData);
    proc.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`VS Code exited with code ${code}`));
    });
  });
}

export async function closeVSCode(result: VSCodeResult): Promise<void> {
  await result.browser.close();
  result.vscodeProcess.kill();
}
