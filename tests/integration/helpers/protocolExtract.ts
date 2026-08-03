/**
 * Static extraction of the webview ↔ extension postMessage protocol.
 *
 * The two bundles (src/ and media/) define message shapes locally and never
 * share types (bundle-isolation rule), so nothing at compile time detects
 * when one side adds/renames a message the other side doesn't know about.
 * These helpers scan the source text for:
 *   - HANDLED types: `case 'x':` labels inside `switch` statements whose
 *     scrutinee looks like a message discriminant (msg.type / message.type /
 *     data.type), brace-matched so unrelated switches are excluded.
 *   - SENT types: `postMessage({ type: 'x' ... })` call sites.
 *
 * Regex-based on purpose: it is a cheap drift detector, not a type checker.
 * The golden file (protocol.golden.json) pins the full picture; the subset
 * assertions in protocol-drift.test.ts are the actual tripwire.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

export function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) listTsFiles(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const SWITCH_RE = /switch\s*\(\s*(?:msg|message|data|event\.data)\s*\.type\s*\)\s*\{/g;

/** Extract case labels from every switch over a message discriminant in a file. */
export function extractHandledTypes(file: string): Set<string> {
  const text = readFileSync(file, 'utf-8');
  const handled = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = SWITCH_RE.exec(text)) !== null) {
    const body = braceMatchedBody(text, m.index + m[0].length - 1);
    for (const c of body.matchAll(/case\s+'([^']+)'\s*:/g)) handled.add(c[1]);
  }
  return handled;
}

/** From the char index of an opening `{`, return the text up to its matching `}`. */
function braceMatchedBody(text: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(openIdx + 1, i);
    }
  }
  return text.slice(openIdx + 1);
}

// `(?:\?\.)?` — injected postMessage callbacks are invoked optional-chained
// (`this._postMessage?.({...})`); without it those sends are invisible and
// land as undetectable orphans (poolWarning was one for weeks).
const SEND_RE = /postMessage(?:\?\.)?\(\s*\{\s*type:\s*'([^']+)'/g;

/** Extract message types from postMessage({ type: '...' }) call sites. */
export function extractSentTypes(file: string): Set<string> {
  const text = readFileSync(file, 'utf-8');
  const sent = new Set<string>();
  for (const m of text.matchAll(SEND_RE)) sent.add(m[1]);
  return sent;
}

export interface ProtocolScan {
  /** webview → extension: types the extension handles */
  extensionHandles: string[];
  /** webview → extension: types the webview sends */
  webviewSends: string[];
  /** extension → webview: types the webview handles */
  webviewHandles: string[];
  /** extension → webview: types the extension sends */
  extensionSends: string[];
}

export function scanProtocol(repoRoot: string): ProtocolScan {
  const srcFiles = listTsFiles(join(repoRoot, 'src'));
  const mediaFiles = listTsFiles(join(repoRoot, 'media'));

  const union = (files: string[], fn: (f: string) => Set<string>) => {
    const all = new Set<string>();
    for (const f of files) for (const t of fn(f)) all.add(t);
    return [...all].sort();
  };

  return {
    extensionHandles: union(srcFiles, extractHandledTypes),
    webviewSends: union(mediaFiles, extractSentTypes),
    webviewHandles: union(mediaFiles, extractHandledTypes),
    extensionSends: union(srcFiles, extractSentTypes),
  };
}
