/**
 * Layer 2: Composer Autocomplete (ADR 0015)
 *
 * Drives the BUILT webview bundle in headless Chromium with real keyboard
 * events. This tier exists for the claims happy-dom cannot make:
 *
 *   - real shadow-DOM event retargeting and `composedPath()`
 *   - real capture-vs-bubble keydown ordering against the composer's own
 *     Enter-to-send handler
 *   - real layout: the overlay is a full-width bar ABOVE the composer
 *   - real `beforeinput`/`inputType` values from actual typing and pasting
 *
 * No VS Code, no model calls. Extension replies are simulated by posting the
 * same window messages the real extension posts.
 */

import { test, expect, Page } from '@playwright/test';
import { launchWebview, closeWebview, WebviewResult } from './helpers/launch';
import { loadHarness } from './helpers/replay';

let result: WebviewResult;

test.beforeAll(async () => {
  result = await launchWebview();
});

test.afterAll(async () => {
  if (result) await closeWebview(result);
});

const COMPOSER = '#inputAreaContainer textarea';
const OVERLAY_ITEM = '#composerAutocompleteHost .popup-item';
const OVERLAY_BOX = '#composerAutocompleteHost [data-popup-container]';

async function freshPage(): Promise<Page> {
  const { page } = result;
  await loadHarness(page);
  await page.locator(COMPOSER).click();
  return page;
}

/** Type with real key events so inputType is genuine. */
async function typeInComposer(page: Page, text: string): Promise<void> {
  await page.locator(COMPOSER).pressSequentially(text, { delay: 8 });
}

async function composerValue(page: Page): Promise<string> {
  return page.locator(COMPOSER).inputValue();
}

async function overlayVisible(page: Page): Promise<boolean> {
  return page.locator(OVERLAY_BOX).evaluate(
    (el) => el.classList.contains('visible')
  ).catch(() => false);
}

async function itemLabels(page: Page): Promise<string[]> {
  return page.locator(`${OVERLAY_ITEM} .popup-item-label`).allTextContents();
}

/**
 * Wait out the overlay's entry transition before measuring geometry — it
 * animates `translateY(-8px) → 0`, so an immediate boundingBox read catches
 * it mid-flight and reports a position ~8px off.
 */
async function waitForOverlaySettled(page: Page): Promise<void> {
  await page.locator(OVERLAY_BOX).evaluate((el) => new Promise<void>((resolve) => {
    const settled = () => {
      const t = getComputedStyle(el).transform;
      return t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)';
    };
    if (settled()) return resolve();
    const started = Date.now();
    const tick = () => {
      if (settled() || Date.now() - started > 1000) return resolve();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
}

/** Messages the webview posted to the (absent) extension. */
async function sentMessages(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => (window as any).__vscodeMessages ?? []);
}

/** Simulate the extension answering a file search. */
async function replyWithSearchResults(page: Page, results: string[]): Promise<void> {
  await page.evaluate((r) => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'searchResults', results: r } }));
  }, results);
  await page.waitForTimeout(120);
}

/** Simulate the extension answering a getFileContent request. */
async function replyWithFileContent(page: Page, filePath: string, content: string): Promise<void> {
  await page.evaluate(({ filePath, content }) => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'fileContent', filePath, content } }));
  }, { filePath, content });
  await page.waitForTimeout(120);
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1. Emoji — the fully local provider
// ─────────────────────────────────────────────────────────────────────────────

test.describe('AC1. Emoji provider', () => {
  test('AC1.1: typing a shortcode opens the overlay with ranked matches', async () => {
    const page = await freshPage();
    await typeInComposer(page, ':smi');

    await expect(page.locator(OVERLAY_BOX)).toHaveClass(/visible/);
    const labels = await itemLabels(page);
    expect(labels[0]).toBe(':smile:');
    expect(labels.length).toBeGreaterThan(1);
  });

  test('AC1.2: one character is not enough to open it', async () => {
    const page = await freshPage();
    await typeInComposer(page, ':s');
    expect(await overlayVisible(page)).toBe(false);
  });

  test('AC1.3: Enter accepts and inserts the emoji character', async () => {
    const page = await freshPage();
    await typeInComposer(page, ':smi');
    await page.keyboard.press('Enter');

    expect(await composerValue(page)).toBe('😄');
    expect(await overlayVisible(page)).toBe(false);
  });

  test('AC1.4: the emoji renders as its own icon in the list', async () => {
    const page = await freshPage();
    await typeInComposer(page, ':smi');
    const icon = await page.locator(`${OVERLAY_ITEM} .popup-item-icon`).first().textContent();
    expect(icon).toBe('😄');
  });

  test('AC1.5: ArrowDown then Enter takes the second suggestion', async () => {
    const page = await freshPage();
    await typeInComposer(page, ':smi');
    const labels = await itemLabels(page);

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    const value = await composerValue(page);
    expect(value).not.toBe('');
    expect(value).not.toBe('😄');       // not the first
    expect(labels[1]).toBeTruthy();      // there really was a second row
  });

  test('AC1.6: ArrowUp from the top wraps to the last suggestion', async () => {
    const page = await freshPage();
    await typeInComposer(page, ':smi');
    const count = (await itemLabels(page)).length;

    await page.keyboard.press('ArrowUp');
    const activeIndex = await page.locator(OVERLAY_ITEM).evaluateAll(
      (els) => els.findIndex(el => el.classList.contains('active'))
    );
    expect(activeIndex).toBe(count - 1);
  });

  test('AC1.7: a closed shortcode lands without any keypress', async () => {
    const page = await freshPage();
    await typeInComposer(page, ':smile:');

    expect(await composerValue(page)).toBe('😄');
    expect(await overlayVisible(page)).toBe(false);
  });

  test('AC1.8: mid-sentence completion leaves the rest of the text alone', async () => {
    const page = await freshPage();
    await typeInComposer(page, 'ship it :rocke');
    await page.keyboard.press('Enter');

    expect(await composerValue(page)).toBe('ship it 🚀');
  });

  test('AC1.8b: the shorter shortcode wins a shared prefix', async () => {
    const page = await freshPage();
    // `:roc` prefixes both `rock` and `rocket`; ranking prefers the shorter.
    await typeInComposer(page, ':roc');
    expect((await itemLabels(page))[0]).toBe(':rock:');
  });

  test('AC1.9: clicking a suggestion accepts it', async () => {
    const page = await freshPage();
    await typeInComposer(page, ':smi');
    await page.locator(OVERLAY_ITEM).first().click();

    expect(await composerValue(page)).toBe('😄');
    expect(await overlayVisible(page)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2. Trigger discipline — real inputType values
// ─────────────────────────────────────────────────────────────────────────────

test.describe('AC2. Trigger discipline', () => {
  test('AC2.1: a colon inside code does not open the overlay', async () => {
    const page = await freshPage();
    await typeInComposer(page, 'std::vec');
    expect(await overlayVisible(page)).toBe(false);
  });

  test('AC2.2: a colon inside a URL does not open the overlay', async () => {
    const page = await freshPage();
    await typeInComposer(page, 'https://exa');
    expect(await overlayVisible(page)).toBe(false);
  });

  test('AC2.3: a colon glued to prose does not open the overlay', async () => {
    const page = await freshPage();
    await typeInComposer(page, 'note:smi');
    expect(await overlayVisible(page)).toBe(false);
  });

  test('AC2.4: pasting a trigger does not open the overlay', async () => {
    const page = await freshPage();
    // A real paste carries inputType `insertFromPaste`, which must stay
    // silent. Dispatched directly because Chromium denies clipboard writes
    // to a file:// page.
    await page.evaluate(() => {
      const ta = document.querySelector('#inputAreaContainer')!
        .shadowRoot!.querySelector('textarea') as HTMLTextAreaElement;
      ta.value = ':smile';
      ta.setSelectionRange(6, 6);
      ta.dispatchEvent(new InputEvent('input', {
        bubbles: true, composed: true, inputType: 'insertFromPaste'
      }));
    });
    await page.waitForTimeout(80);

    expect(await overlayVisible(page)).toBe(false);
    expect(await composerValue(page)).toBe(':smile');
  });

  test('AC2.5: whitespace after the query closes the overlay', async () => {
    const page = await freshPage();
    await typeInComposer(page, ':smi');
    expect(await overlayVisible(page)).toBe(true);

    await typeInComposer(page, ' ');
    expect(await overlayVisible(page)).toBe(false);
  });

  test('AC2.6: moving the caret off the trigger closes the overlay', async () => {
    const page = await freshPage();
    await typeInComposer(page, ':smi');
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(80);

    // ArrowLeft is not an overlay key, so it reaches the textarea and the
    // caret leaves the span.
    expect(await overlayVisible(page)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3. Keyboard arbitration against the real composer
// ─────────────────────────────────────────────────────────────────────────────

test.describe('AC3. Keyboard arbitration', () => {
  test('AC3.1: with the overlay CLOSED, Enter still sends', async () => {
    const page = await freshPage();
    await typeInComposer(page, 'plain message');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);

    const messages = await sentMessages(page);
    expect(messages.some(m => m.type === 'sendMessage')).toBe(true);
    expect(await composerValue(page)).toBe('');
  });

  test('AC3.2: with the overlay OPEN, Enter accepts and does NOT send', async () => {
    const page = await freshPage();
    await typeInComposer(page, ':smi');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);

    const messages = await sentMessages(page);
    expect(messages.some(m => m.type === 'sendMessage')).toBe(false);
    expect(await composerValue(page)).toBe('😄');
  });

  test('AC3.3: Shift+Enter passes through to the composer', async () => {
    const page = await freshPage();
    await typeInComposer(page, ':smi');
    await page.keyboard.press('Shift+Enter');
    await page.waitForTimeout(80);

    const messages = await sentMessages(page);
    expect(messages.some(m => m.type === 'sendMessage')).toBe(false);
    expect(await composerValue(page)).toContain(':smi');
  });

  test('AC3.4: Tab accepts instead of moving focus', async () => {
    const page = await freshPage();
    await typeInComposer(page, ':smi');
    await page.keyboard.press('Tab');

    expect(await composerValue(page)).toBe('😄');
    const focused = await page.evaluate(() => {
      const host = document.querySelector('#inputAreaContainer') as HTMLElement;
      return host.shadowRoot!.activeElement?.tagName ?? document.activeElement?.tagName;
    });
    expect(focused).toBe('TEXTAREA');
  });

  test('AC3.5: Escape closes the overlay and leaves the draft intact', async () => {
    const page = await freshPage();
    await typeInComposer(page, ':smi');
    await page.keyboard.press('Escape');

    expect(await overlayVisible(page)).toBe(false);
    expect(await composerValue(page)).toBe(':smi');

    // And the next Enter sends that draft rather than accepting anything.
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    const messages = await sentMessages(page);
    expect(messages.some(m => m.type === 'sendMessage')).toBe(true);
  });

  test('AC3.6: after sending, a new draft-initial trigger still opens', async () => {
    const page = await freshPage();
    await typeInComposer(page, '/exp');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');   // sends '/exp'
    await page.waitForTimeout(150);

    await typeInComposer(page, ':smi');
    expect(await overlayVisible(page)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4. Layout — the claim only a real browser can settle
// ─────────────────────────────────────────────────────────────────────────────

test.describe('AC4. Overlay layout', () => {
  test('AC4.1: the overlay never overlaps the composer', async () => {
    const page = await freshPage();
    await typeInComposer(page, ':smi');
    await waitForOverlaySettled(page);

    const overlay = await page.locator(OVERLAY_BOX).boundingBox();
    const composer = await page.locator('#inputAreaContainer').boundingBox();

    expect(overlay).not.toBeNull();
    expect(composer).not.toBeNull();

    // Above is the intended side, but the overlay flips below when there is
    // no room above — which is the case in this harness, where the composer
    // sits near the top of the page rather than at the bottom of a sidebar.
    const isAbove = overlay!.y + overlay!.height <= composer!.y + 2;
    const isBelow = overlay!.y + 2 >= composer!.y + composer!.height;
    expect(
      isAbove || isBelow,
      `overlay=${JSON.stringify(overlay)} composer=${JSON.stringify(composer)}`
    ).toBe(true);
  });

  test('AC4.2: the overlay matches the composer width', async () => {
    const page = await freshPage();
    await typeInComposer(page, ':smi');
    await waitForOverlaySettled(page);

    const overlay = await page.locator(OVERLAY_BOX).boundingBox();
    const composer = await page.locator('#inputAreaContainer').boundingBox();

    expect(Math.abs(overlay!.width - composer!.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(overlay!.x - composer!.x)).toBeLessThanOrEqual(2);
  });

  test('AC4.3: a long list scrolls rather than growing without bound', async () => {
    const page = await freshPage();
    await typeInComposer(page, ':ar');   // many matches
    await waitForOverlaySettled(page);

    const box = await page.locator(OVERLAY_BOX).boundingBox();
    expect(box!.height).toBeLessThanOrEqual(280);
  });

  test('AC4.4: the overlay stays inside the viewport when room above is tight', async () => {
    const page = await freshPage();
    await typeInComposer(page, ':ar');   // enough matches to want full height
    await waitForOverlaySettled(page);

    const box = await page.locator(OVERLAY_BOX).boundingBox();
    // Found by this tier: the base class pins the container's BOTTOM to the
    // composer, so an overlay taller than the space above rendered off the
    // top of the viewport — invisible and unclickable.
    expect(box!.y).toBeGreaterThanOrEqual(0);
  });

  test('AC4.5: a suggestion is actually clickable where it renders', async () => {
    const page = await freshPage();
    await typeInComposer(page, ':ar');
    await waitForOverlaySettled(page);

    const first = page.locator(OVERLAY_ITEM).first();
    await expect(first).toBeInViewport();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5. Commands
// ─────────────────────────────────────────────────────────────────────────────

test.describe('AC5. Commands provider', () => {
  test('AC5.1: a bare slash lists the catalog', async () => {
    const page = await freshPage();
    await typeInComposer(page, '/');

    expect(await overlayVisible(page)).toBe(true);
    const labels = await itemLabels(page);
    expect(labels).toContain('Export Logs');
    expect(labels).toContain('System Prompt');
  });

  test('AC5.2: filtering narrows the list', async () => {
    const page = await freshPage();
    await typeInComposer(page, '/export');

    const labels = await itemLabels(page);
    expect(labels).toEqual(['Export History', 'Export Logs']);
  });

  test('AC5.3: accepting a plain command posts executeCommand and clears the trigger', async () => {
    const page = await freshPage();
    await typeInComposer(page, '/export');
    await page.keyboard.press('ArrowDown');   // Export History → Export Logs
    await page.keyboard.press('Enter');
    await page.waitForTimeout(120);

    const messages = await sentMessages(page);
    expect(messages).toContainEqual({ type: 'executeCommand', command: 'moby.exportLogs' });
    expect(await composerValue(page)).toBe('');
  });

  test('AC5.4: a modal-routed command opens its modal instead of posting executeCommand', async () => {
    const page = await freshPage();
    await typeInComposer(page, '/system');
    // Both "System …" commands match; the first is the one we want.
    expect(await itemLabels(page)).toEqual(['System Prompt', 'System Rules']);

    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    // One of the four that route to a webview-local modal rather than the
    // extension. Assert the modal actually opened — asserting only "no
    // executeCommand" would pass even if nothing happened at all.
    await expect(page.locator('#systemPromptHost .modal-backdrop')).toHaveClass(/visible/);
    const messages = await sentMessages(page);
    expect(messages.some(m => m.type === 'executeCommand' && m.command === 'moby.editSystemPrompt')).toBe(false);
    expect(await composerValue(page)).toBe('');
  });

  test('AC5.5: a space ends the trigger — queries are single-token by design', async () => {
    const page = await freshPage();
    await typeInComposer(page, '/export');
    expect(await overlayVisible(page)).toBe(true);

    // Whitespace is the span boundary (ADR 0015 decision 3), so a multi-word
    // filter is not expressible. Enter then sends the literal draft.
    await typeInComposer(page, ' l');
    expect(await overlayVisible(page)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6. Files — the async provider and its visible result
// ─────────────────────────────────────────────────────────────────────────────

test.describe('AC6. Files provider', () => {
  test('AC6.1: typing @ searches, and results open the overlay', async () => {
    const page = await freshPage();
    await typeInComposer(page, '@index');
    await page.waitForTimeout(250);   // debounce

    const messages = await sentMessages(page);
    expect(messages).toContainEqual({ type: 'searchFiles', query: 'index' });

    await replyWithSearchResults(page, ['src/actors/index.ts', 'media/index.ts']);
    expect(await overlayVisible(page)).toBe(true);
    expect(await itemLabels(page)).toEqual(['index.ts', 'index.ts']);
  });

  test('AC6.2: accepting requests the file and clears the trigger', async () => {
    const page = await freshPage();
    await typeInComposer(page, '@index');
    await page.waitForTimeout(250);
    await replyWithSearchResults(page, ['src/actors/index.ts']);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(120);

    const messages = await sentMessages(page);
    expect(messages).toContainEqual({ type: 'getFileContent', filePath: 'src/actors/index.ts' });
    expect(await composerValue(page)).toBe('');
  });

  test('AC6.3: the attached file appears as a context chip', async () => {
    const page = await freshPage();
    await typeInComposer(page, '@index');
    await page.waitForTimeout(250);
    await replyWithSearchResults(page, ['src/actors/index.ts']);
    await page.keyboard.press('Enter');
    await replyWithFileContent(page, 'src/actors/index.ts', 'export {};');

    // The visible half of the round trip — the dogfooding bug of 2026-08-05.
    const chips = page.locator('#inputAreaContainer .file-chip');
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toContainText('src/actors/index.ts');
  });

  test('AC6.4: removing the chip tells the extension the reduced set', async () => {
    const page = await freshPage();
    await typeInComposer(page, '@index');
    await page.waitForTimeout(250);
    await replyWithSearchResults(page, ['src/actors/index.ts']);
    await page.keyboard.press('Enter');
    await replyWithFileContent(page, 'src/actors/index.ts', 'export {};');

    await page.locator('#inputAreaContainer .file-chip-remove').first().click();
    await page.waitForTimeout(120);

    await expect(page.locator('#inputAreaContainer .file-chip')).toHaveCount(0);
    const messages = await sentMessages(page);
    const last = [...messages].reverse().find(m => m.type === 'setSelectedFiles');
    expect(last).toEqual({ type: 'setSelectedFiles', files: [] });
  });

  test('AC6.5: search results that nobody asked for do not open the overlay', async () => {
    const page = await freshPage();
    await typeInComposer(page, 'hello');
    // The files popup's own search replying on the shared channel.
    await replyWithSearchResults(page, ['src/unrelated.ts']);

    expect(await overlayVisible(page)).toBe(false);
  });
});
