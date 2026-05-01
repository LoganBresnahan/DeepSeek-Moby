/**
 * Per-language LSP availability service.
 *
 * Replaces the global `LspProbe` (Phase 3a) which lied in mixed-language
 * workspaces — JS/TS workspaces always have LSP via VS Code's built-in
 * TypeScript server, so any workspace containing JS reported "true"
 * regardless of whether other languages had servers installed. Models
 * then wasted tool calls on languages without LSP.
 *
 * This service maps each languageId present in the workspace to an
 * availability state. The orchestrator reads `getDeclaredAvailability()`
 * to inject a per-language declaration into the system prompt and to
 * decide whether to advertise LSP tools at all.
 *
 * Cadence:
 *   - Activation + ~3s warmup: `discoverWorkspace()` runs in background.
 *   - `vscode.extensions.onDidChange`: invalidate + re-discover.
 *   - `vscode.workspace.onDidChangeWorkspaceFolders`: invalidate + re-discover.
 *   - LSP tool returns empty/non-empty for languageId X: `reportToolResult`
 *     adaptively corrects the map.
 *   - No periodic timer.
 *
 * See [docs/plans/partial/lsp-integration.md] Phase 4 for the design.
 */

import * as vscode from 'vscode';

import { logger } from '../utils/logger';
import { withLspTimeout, LspTimeoutError } from '../utils/lspTimeout';

interface DocumentSymbolLike {
  name: string;
  kind: number;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  children?: DocumentSymbolLike[];
}

export type AvailabilitySource = 'probe' | 'tool-failure' | 'tool-success' | 'extension-event';

export interface AvailabilityState {
  /** Whether LSP responds with symbols for this language. */
  available: boolean;
  /** Path of the file we last probed/observed. For debugging. */
  sampledFile: string;
  /** Unix-ms timestamp of last update. */
  observedAt: number;
  /** What set this entry's current value. */
  source: AvailabilitySource;
  /** Count of consecutive empty results. Used to delay `true → false`
   *  flips so a single stub file with no symbols doesn't poison the
   *  whole language. Reset on success. */
  consecutiveEmpties: number;
}

export interface DeclaredAvailability {
  /** Languages confirmed available (LSP returned symbols for them). */
  available: string[];
  /** Languages confirmed unavailable. */
  unavailable: string[];
  /** Languages observed in the workspace but not yet probed. */
  untested: string[];
}

const PROBE_TIMEOUT_MS = 5000;
const PROBE_PRE_DELAY_MS = 250;
const WARMUP_DELAY_MS = 3000;
const DISCOVERY_CONCURRENCY = 3;
/** Max files findFiles enumerates during workspace discovery. Caps cost
 *  on huge monorepos while still capturing common languages. */
const DISCOVERY_FILE_LIMIT = 100;
/** Empties before a confirmed-available language flips to unavailable.
 *  Prevents single empty/stub files from poisoning the whole language. */
const EMPTY_FLIP_THRESHOLD = 2;
/** Delay before re-probing a language that came back unavailable from
 *  the initial discovery. Catches cold-LSP startup (rust-analyzer,
 *  gopls, etc.) that exceeds the per-probe timeout on first launch. */
const POST_DISCOVERY_RETRY_MS = 30_000;
/** Delay before re-probing on a `onDidOpenTextDocument` event for an
 *  unavailable language. Short — the LSP has the doc registered as part
 *  of opening it. */
const FILE_OPEN_RETRY_MS = 1_000;

const PROBE_FILE_GLOB =
  '**/*.{' + [
    'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs',
    'py', 'pyi',
    'rs', 'go', 'zig', 'nim', 'cr', 'd',
    'java', 'kt', 'kts', 'scala', 'sc', 'groovy', 'gradle',
    'cs', 'fs', 'fsx', 'fsi', 'vb',
    'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'm', 'mm',
    'swift', 'dart',
    'vue', 'svelte', 'astro',
    'rb', 'erb', 'php', 'pl', 'pm',
    'erl', 'hrl', 'ex', 'exs',
    'hs', 'lhs', 'ml', 'mli', 'clj', 'cljs', 'cljc', 'edn',
    'rkt', 'scm', 'ss', 'lisp', 'cl', 'el',
    'lua', 'r', 'jl', 'tcl', 'elm', 'hx',
    'f', 'f90', 'f95', 'f03', 'f08', 'ada', 'adb', 'ads',
    'sol', 'cairo',
    'sh', 'bash', 'zsh', 'ps1', 'psm1',
    'proto', 'thrift', 'graphql', 'gql', 'prisma',
    'sql', 'toml', 'yaml', 'yml',
  ].join(',') + '}';

const PROBE_EXCLUDE = '**/{node_modules,.git,dist,build,out,target,vendor,.next,.nuxt,.cache,.tox,.venv,venv,__pycache__,.idea,.vscode}/**';

export class LspAvailability {
  private static instance: LspAvailability | undefined;

  private map = new Map<string, AvailabilityState>();
  private discoveryInFlight: Promise<void> | null = null;
  private warmupTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per-language retry timers so we don't double-schedule. Cleared on
   *  invalidate. Entries removed when the timer fires. */
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private constructor() {}

  static getInstance(): LspAvailability {
    if (!LspAvailability.instance) LspAvailability.instance = new LspAvailability();
    return LspAvailability.instance;
  }

  /**
   * Wire workspace + extension change listeners that invalidate the map
   * and trigger a re-discover. Call once during extension activation;
   * push the returned disposables into `context.subscriptions`.
   */
  registerInvalidators(): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];

    disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        logger.debug('[LspAvailability] Workspace folders changed — re-discovering');
        this.invalidate();
        void this.discoverWorkspace();
      })
    );

    disposables.push(
      vscode.extensions.onDidChange(() => {
        logger.debug('[LspAvailability] Extensions changed — re-discovering');
        this.invalidate();
        void this.discoverWorkspace();
      })
    );

    // Reactive recovery: re-probe when the user focuses a tab in a
    // language we've marked unavailable. `onDidChangeActiveTextEditor`
    // fires for all user-driven cases (tab click, opening a new file,
    // Quick Open) regardless of whether the document was previously
    // loaded — `onDidOpenTextDocument` would miss focuses on docs
    // discovery already opened to read their languageId. One listener
    // covers it.
    disposables.push(
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (!editor) return;
        const doc = editor.document;
        if (doc.isUntitled || doc.uri.scheme !== 'file') return;
        const lang = doc.languageId;
        if (!lang || lang === 'plaintext') return;
        const state = this.map.get(lang);
        if (!state || state.available) return;
        if (this.retryTimers.has(lang)) return;
        logger.debug(`[LspAvailability] ${lang} marked unavailable; editor focus triggers retry probe`);
        this.scheduleRetry(lang, doc.uri, FILE_OPEN_RETRY_MS);
      })
    );

    return disposables;
  }

  /** Drop all entries + cancel pending retries. Next read returns empty
   *  until discovery repopulates. */
  invalidate(): void {
    this.map.clear();
    this.discoveryInFlight = null;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }

  /**
   * Schedule a background discovery after `WARMUP_DELAY_MS`. Lets LSP
   * extensions (TypeScript server, Pylance, rust-analyzer) finish
   * registering providers before we probe. Idempotent — multiple calls
   * collapse to one timer.
   */
  warmUp(): void {
    if (this.warmupTimer || this.discoveryInFlight) return;
    this.warmupTimer = setTimeout(() => {
      this.warmupTimer = null;
      void this.discoverWorkspace();
    }, WARMUP_DELAY_MS);
  }

  /**
   * Enumerate languages present in the workspace and probe one file per
   * language. Idempotent — concurrent calls share the in-flight promise.
   */
  async discoverWorkspace(): Promise<void> {
    if (this.discoveryInFlight) return this.discoveryInFlight;
    this.discoveryInFlight = this.runDiscovery().finally(() => {
      this.discoveryInFlight = null;
    });
    return this.discoveryInFlight;
  }

  /** Synchronous read for the orchestrator hot path. */
  getDeclaredAvailability(): DeclaredAvailability {
    const available: string[] = [];
    const unavailable: string[] = [];
    const untested: string[] = [];
    for (const [lang, state] of this.map.entries()) {
      if (state.source === 'probe' && state.observedAt === 0) {
        untested.push(lang);
      } else if (state.available) {
        available.push(lang);
      } else {
        unavailable.push(lang);
      }
    }
    available.sort();
    unavailable.sort();
    untested.sort();
    return { available, unavailable, untested };
  }

  /**
   * Adaptive correction from a real LSP tool call. Called by tool
   * implementations when they observe whether a given languageId returned
   * symbols. `false → true` flips immediately. `true → false` flips only
   * after `EMPTY_FLIP_THRESHOLD` consecutive empties — a single stub file
   * with no symbols shouldn't poison the whole language.
   */
  reportToolResult(languageId: string, hadSymbols: boolean, sampledFile = ''): void {
    if (!languageId) return;
    const existing = this.map.get(languageId);
    const now = Date.now();
    if (hadSymbols) {
      this.map.set(languageId, {
        available: true,
        sampledFile: sampledFile || existing?.sampledFile || '',
        observedAt: now,
        source: 'tool-success',
        consecutiveEmpties: 0
      });
      if (existing && !existing.available) {
        logger.info(`[LspAvailability] ${languageId} upgraded to available via tool-success`);
      }
      return;
    }
    // Empty result. Track consecutive empties before flipping a previously-
    // available language to unavailable.
    const prevEmpties = existing?.consecutiveEmpties ?? 0;
    const newEmpties = prevEmpties + 1;
    if (existing?.available && newEmpties < EMPTY_FLIP_THRESHOLD) {
      // Don't flip yet — record the count and keep showing available.
      this.map.set(languageId, { ...existing, observedAt: now, consecutiveEmpties: newEmpties });
      return;
    }
    this.map.set(languageId, {
      available: false,
      sampledFile: sampledFile || existing?.sampledFile || '',
      observedAt: now,
      source: 'tool-failure',
      consecutiveEmpties: newEmpties
    });
    if (!existing || existing.available) {
      logger.info(`[LspAvailability] ${languageId} marked unavailable after ${newEmpties} empty result(s)`);
    }
  }

  /** For tests + debugging. */
  getRawMap(): ReadonlyMap<string, AvailabilityState> {
    return this.map;
  }

  // ── private ─────────────────────────────────────────────────────────

  private async runDiscovery(): Promise<void> {
    const start = Date.now();
    let files: vscode.Uri[];
    try {
      files = await vscode.workspace.findFiles(PROBE_FILE_GLOB, PROBE_EXCLUDE, DISCOVERY_FILE_LIMIT);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[LspAvailability] findFiles failed: ${msg} — skipping discovery`);
      return;
    }
    if (files.length === 0) {
      logger.info('[LspAvailability] No source files in workspace — skipping discovery');
      return;
    }

    // Group by languageId — open each file once to read its languageId
    // (cheap because openTextDocument is cached). Take the first file per
    // language as the probe sample.
    const byLanguage = new Map<string, vscode.Uri>();
    for (const uri of files) {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const lang = doc.languageId;
        if (!lang || lang === 'plaintext') continue;
        if (!byLanguage.has(lang)) byLanguage.set(lang, uri);
      } catch {
        // Skip files we can't open. Probably permissions or weird
        // encoding — they don't help us probe anyway.
      }
    }

    if (byLanguage.size === 0) {
      logger.info(`[LspAvailability] Found ${files.length} files but no resolvable languageIds`);
      return;
    }

    logger.debug(
      `[LspAvailability] Discovering ${byLanguage.size} languages: ${[...byLanguage.keys()].join(', ')}`
    );

    // Probe in parallel batches with a concurrency cap.
    const entries = [...byLanguage.entries()];
    for (let i = 0; i < entries.length; i += DISCOVERY_CONCURRENCY) {
      const batch = entries.slice(i, i + DISCOVERY_CONCURRENCY);
      await Promise.all(batch.map(([lang, uri]) => this.probeLanguage(lang, uri)));
    }

    const elapsed = Date.now() - start;
    const decl = this.getDeclaredAvailability();
    logger.info(
      `[LspAvailability] Discovery complete in ${elapsed}ms — ` +
      `available=[${decl.available.join(', ')}] ` +
      `unavailable=[${decl.unavailable.join(', ')}] ` +
      `untested=[${decl.untested.join(', ')}]`
    );

    // Schedule a delayed retry for any language that came back unavailable
    // from this initial discovery. Cold language servers (rust-analyzer,
    // gopls, kotlin-lsp) routinely take 10-30s to load — well past the
    // per-probe timeout. Single retry catches the slow-cold case without
    // a periodic timer.
    const retried: string[] = [];
    for (const [lang, state] of this.map.entries()) {
      if (state.source === 'probe' && !state.available && state.sampledFile) {
        this.scheduleRetry(lang, vscode.Uri.file(state.sampledFile), POST_DISCOVERY_RETRY_MS);
        retried.push(lang);
      }
    }
    if (retried.length > 0) {
      logger.info(
        `[LspAvailability] Scheduled retry in ${Math.round(POST_DISCOVERY_RETRY_MS / 1000)}s for: ${retried.join(', ')}`
      );
    }
  }

  /**
   * Schedule a single re-probe for one language after `delayMs`. Uses
   * `uri` as the sample file. No-op if a retry is already pending for
   * this language. Cleared on `invalidate()`.
   */
  private scheduleRetry(languageId: string, uri: vscode.Uri, delayMs: number): void {
    if (this.retryTimers.has(languageId)) return;
    const timer = setTimeout(async () => {
      this.retryTimers.delete(languageId);
      // Bail if the language has been marked available since the timer
      // was set (e.g. via tool-success).
      const current = this.map.get(languageId);
      if (current?.available) return;
      logger.debug(`[LspAvailability] Retrying probe for ${languageId} (${uri.fsPath})`);
      const before = current?.available ?? false;
      await this.probeLanguage(languageId, uri);
      const after = this.map.get(languageId)?.available ?? false;
      if (after && !before) {
        // State transition — the recovery actually worked. Worth INFO.
        logger.info(`[LspAvailability] ${languageId} now available after retry`);
      } else {
        // No change — expected when LSP genuinely isn't installed. Quiet
        // by default; users at debug level still see the attempt.
        logger.debug(`[LspAvailability] ${languageId} still unavailable after retry`);
      }
    }, delayMs);
    this.retryTimers.set(languageId, timer);
  }

  private async probeLanguage(languageId: string, uri: vscode.Uri): Promise<void> {
    const start = Date.now();
    try {
      // openTextDocument is idempotent + cheap — already loaded during
      // language enumeration above. This call is mostly a no-op but
      // ensures the LSP has the doc registered.
      await vscode.workspace.openTextDocument(uri);
    } catch {
      // Treat open failure as "unavailable for now" without poisoning the map.
      // Skip recording an entry; the language will just stay untested until a
      // tool call observes a real result.
      return;
    }

    await new Promise(resolve => setTimeout(resolve, PROBE_PRE_DELAY_MS));

    let symbols: DocumentSymbolLike[] | undefined;
    try {
      symbols = await withLspTimeout(
        vscode.commands.executeCommand<DocumentSymbolLike[] | undefined>(
          'vscode.executeDocumentSymbolProvider',
          uri
        ),
        PROBE_TIMEOUT_MS
      );
    } catch (e) {
      // Timeout and other errors both treated as "no symbols" — probe is
      // non-critical and post-discovery retry covers cold-start cases.
      if (e instanceof LspTimeoutError) {
        logger.debug(`[LspAvailability] probe timeout for ${languageId} after ${PROBE_TIMEOUT_MS}ms`);
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        logger.debug(`[LspAvailability] probe error for ${languageId}: ${msg}`);
      }
      symbols = undefined;
    }

    const elapsed = Date.now() - start;
    const symbolCount = Array.isArray(symbols) ? symbols.length : 0;
    const available = symbolCount > 0;
    this.map.set(languageId, {
      available,
      sampledFile: uri.fsPath,
      observedAt: Date.now(),
      source: 'probe',
      consecutiveEmpties: available ? 0 : 1
    });
    logger.debug(
      `[LspAvailability] ${languageId}: ${available ? 'available' : 'unavailable'} ` +
      `(${symbolCount} symbols in ${elapsed}ms, ${uri.fsPath})`
    );
  }
}

