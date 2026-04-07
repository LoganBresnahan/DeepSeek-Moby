/**
 * CQRS Event Replay Helper
 *
 * Provides utilities for loading history into the webview harness
 * and querying rendered DOM state. Used by Layer 2 (Chromium) tests
 * to verify rendering fidelity after CQRS event replay.
 */

import { Page } from 'playwright';
import { resolve } from 'path';

export const HARNESS_PATH = resolve(__dirname, 'harness.html');

/** A turn event matching TurnEvent from TurnEventLog.ts */
export interface TurnEvent {
  type: string;
  [key: string]: unknown;
}

/** A history turn for loadHistory message */
export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
  model?: string;
  timestamp?: number;
  turnEvents?: TurnEvent[];
  editMode?: string;
  files?: string[];
}

/**
 * Load the harness and wait for the actor system to initialize.
 */
export async function loadHarness(page: Page): Promise<void> {
  await page.goto(`file://${HARNESS_PATH}`);
  await page.waitForTimeout(1500);
}

/**
 * Dispatch a loadHistory message to the webview and wait for rendering.
 */
export async function replayHistory(page: Page, turns: HistoryTurn[]): Promise<void> {
  await page.evaluate((history) => {
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'loadHistory', history }
    }));
  }, turns);
  await page.waitForTimeout(500);
}

/**
 * Get info about all rendered segments in a turn.
 */
export async function getTurnSegments(page: Page, turnId: string): Promise<SegmentInfo[]> {
  return page.evaluate((tid) => {
    const turn = document.querySelector(`[data-turn-id="${tid}"]`);
    if (!turn) return [];
    return Array.from(turn.children).map(el => {
      const sr = (el as HTMLElement).shadowRoot;
      return {
        classes: el.className,
        hasShadow: !!sr,
        shadowText: sr?.textContent?.trim() || '',
        shadowHTML: sr?.innerHTML || '',
      };
    });
  }, turnId);
}

export interface SegmentInfo {
  classes: string;
  hasShadow: boolean;
  shadowText: string;
  shadowHTML: string;
}

/**
 * Get text content from all text containers in a turn.
 */
export async function getTextContents(page: Page, turnId: string): Promise<string[]> {
  return page.evaluate((tid) => {
    const containers = document.querySelectorAll(`[data-turn-id="${tid}"].text-container`);
    return Array.from(containers).map(c => {
      const content = (c as HTMLElement).shadowRoot?.querySelector('.content');
      return content?.textContent || '';
    });
  }, turnId);
}

/**
 * Get all thinking containers in a turn.
 */
export async function getThinkingContainers(page: Page, turnId: string): Promise<ThinkingInfo[]> {
  return page.evaluate((tid) => {
    const containers = document.querySelectorAll(`[data-turn-id="${tid}"].thinking-container`);
    return Array.from(containers).map(c => {
      const sr = (c as HTMLElement).shadowRoot;
      return {
        text: sr?.textContent?.trim() || '',
        hasContent: !!sr?.querySelector('.thinking-body, .thinking-content'),
      };
    });
  }, turnId);
}

export interface ThinkingInfo {
  text: string;
  hasContent: boolean;
}

/**
 * Get all pending file containers in a turn and their statuses.
 */
export async function getPendingFiles(page: Page, turnId: string): Promise<PendingFileInfo[]> {
  return page.evaluate((tid) => {
    const containers = document.querySelectorAll(`[data-turn-id="${tid}"].pending-container`);
    return Array.from(containers).map(c => {
      const sr = (c as HTMLElement).shadowRoot;
      const classList = Array.from(c.classList);
      // Find file entries within shadow root
      const fileEntries = sr?.querySelectorAll('.file-entry, .pending-file') || [];
      const files = Array.from(fileEntries).map(fe => ({
        name: fe.textContent?.trim() || '',
        html: fe.innerHTML,
      }));
      return {
        containerClasses: classList,
        isAllApplied: classList.includes('all-applied'),
        hasErrors: classList.includes('has-errors'),
        hasRejected: classList.includes('has-rejected'),
        title: sr?.querySelector('.pending-title, .dropdown-title')?.textContent?.trim() || '',
        fileCount: files.length,
        shadowText: sr?.textContent?.trim() || '',
      };
    });
  }, turnId);
}

export interface PendingFileInfo {
  containerClasses: string[];
  isAllApplied: boolean;
  hasErrors: boolean;
  hasRejected: boolean;
  title: string;
  fileCount: number;
  shadowText: string;
}

/**
 * Get all shell containers in a turn.
 */
export async function getShellContainers(page: Page, turnId: string): Promise<ShellInfo[]> {
  return page.evaluate((tid) => {
    const containers = document.querySelectorAll(`[data-turn-id="${tid}"].shell-container`);
    return Array.from(containers).map(c => {
      const sr = (c as HTMLElement).shadowRoot;
      return {
        text: sr?.textContent?.trim() || '',
        hasOutput: !!sr?.querySelector('.shell-output, .output'),
      };
    });
  }, turnId);
}

export interface ShellInfo {
  text: string;
  hasOutput: boolean;
}

/**
 * Count how many turns of each role are rendered.
 */
export async function countTurns(page: Page): Promise<{ user: number; assistant: number }> {
  return page.evaluate(() => {
    const all = document.querySelectorAll('[data-turn-id]');
    let user = 0, assistant = 0;
    all.forEach(el => {
      const role = el.getAttribute('data-role');
      if (role === 'user') user++;
      else if (role === 'assistant') assistant++;
    });
    return { user, assistant };
  });
}

/**
 * Get the full text content of a pending container's shadow DOM (for status assertions).
 */
export async function getPendingContainerText(page: Page, turnId: string): Promise<string> {
  return page.evaluate((tid) => {
    const container = document.querySelector(`[data-turn-id="${tid}"].pending-container`);
    return container?.shadowRoot?.textContent?.trim() || '';
  }, turnId) as Promise<string>;
}
