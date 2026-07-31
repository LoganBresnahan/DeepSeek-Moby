/**
 * Protocol drift detector for the webview ↔ extension postMessage boundary.
 *
 * src/ and media/ define message shapes locally (bundle isolation), so this
 * is the only thing that notices when one side sends a message the other
 * side never handles. Two layers:
 *
 *   1. Subset tripwire: every type sent on one side must be handled on the
 *      other, except the documented knownOrphans below. A NEW orphan fails.
 *   2. Golden pin: the full scanned protocol is pinned in
 *      protocol.golden.json so any change to the message surface shows up
 *      in review. Regenerate deliberately with:
 *        MOBY_PROTOCOL_UPDATE=1 npx vitest run tests/integration/protocol-drift.test.ts
 *
 * knownOrphans are pre-existing dead messages found when this detector was
 * introduced (2026-07-31) — senders with no receiver. Fixing them means
 * removing the dead sender (or adding the missing handler), then deleting
 * the entry here. Do not add new entries to silence a failure you caused.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { scanProtocol } from './helpers/protocolExtract';

const REPO_ROOT = resolve(__dirname, '../..');
const GOLDEN_PATH = resolve(__dirname, 'protocol.golden.json');

// webview → extension sends with no extension handler (all in SessionActor /
// SettingsShadowActor — likely superseded by the history/session flows).
const KNOWN_ORPHAN_WEBVIEW_SENDS = [
  'clearSession',
  'createSession',
  'getDefaultSystemPrompt',
  'getHistoryList',
  'loadSession',
  'setLogColors',
  'setModel',
];

// extension → webview sends with no webview handler (all chatProvider
// relays — likely superseded diff/approval flows).
const KNOWN_ORPHAN_EXTENSION_SENDS = [
  'activeDiffChanged',
  'autoContinuation',
  'editRejected',
  'showEditConfirm',
  'waitingForApproval',
];

const scan = scanProtocol(REPO_ROOT);

if (process.env.MOBY_PROTOCOL_UPDATE === '1') {
  writeFileSync(GOLDEN_PATH, JSON.stringify(scan, null, 2) + '\n');
}

describe('postMessage protocol drift', () => {
  it('every webview-sent type has an extension handler (or is a known orphan)', () => {
    const handled = new Set([...scan.extensionHandles, ...KNOWN_ORPHAN_WEBVIEW_SENDS]);
    const orphans = scan.webviewSends.filter(t => !handled.has(t));
    expect(orphans, 'webview sends these but the extension never handles them').toEqual([]);
  });

  it('every extension-sent type has a webview handler (or is a known orphan)', () => {
    const handled = new Set([...scan.webviewHandles, ...KNOWN_ORPHAN_EXTENSION_SENDS]);
    const orphans = scan.extensionSends.filter(t => !handled.has(t));
    expect(orphans, 'extension sends these but the webview never handles them').toEqual([]);
  });

  it('known orphans are still orphans (delete fixed ones from the list)', () => {
    const stillOrphanWebview = KNOWN_ORPHAN_WEBVIEW_SENDS.filter(
      t => !scan.extensionHandles.includes(t)
    );
    const stillOrphanExtension = KNOWN_ORPHAN_EXTENSION_SENDS.filter(
      t => !scan.webviewHandles.includes(t)
    );
    expect(stillOrphanWebview).toEqual(KNOWN_ORPHAN_WEBVIEW_SENDS);
    expect(stillOrphanExtension).toEqual(KNOWN_ORPHAN_EXTENSION_SENDS);
  });

  it('matches the pinned golden protocol', () => {
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8'));
    expect(scan, 'protocol changed — review, then regenerate with MOBY_PROTOCOL_UPDATE=1').toEqual(golden);
  });
});
