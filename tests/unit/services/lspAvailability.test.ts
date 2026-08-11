/**
 * Tests for LspAvailability — per-language LSP availability service.
 *
 * Mocks `vscode.workspace.findFiles`, `vscode.workspace.openTextDocument`,
 * and `vscode.commands.executeCommand` to simulate workspaces with various
 * language combinations and probe outcomes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';

import { LspAvailability } from '../../../src/services/lspAvailability';

function makeUri(fsPath: string) {
  return { fsPath, scheme: 'file', path: fsPath } as vscode.Uri;
}

function mockOpenDocument(byPath: Record<string, string>, lines: Record<string, number> = {}) {
  (vscode.workspace.openTextDocument as any).mockImplementation(async (uri: any) => {
    const path = uri.fsPath ?? uri;
    const lang = byPath[path];
    if (lang === undefined) throw new Error(`unknown ${uri.fsPath}`);
    // lineCount drives candidate ordering — richest file probed first.
    return { languageId: lang, uri, getText: () => '', lineCount: lines[path] ?? 50 };
  });
}

/**
 * Map a file path to what the symbol provider returns:
 *   - a number → that many symbols (0 means an EMPTY ARRAY: a provider
 *     answered and the file genuinely has none)
 *   - `null`   → `undefined`: nothing handled the request, i.e. no provider
 *
 * The distinction is the whole point of the tri-state verdict — the old
 * helper could only produce arrays, which is why it pinned the conflation.
 */
function mockSymbols(byPath: Record<string, number | null>) {
  (vscode.commands.executeCommand as any).mockImplementation(async (cmd: string, uri: any) => {
    if (cmd !== 'vscode.executeDocumentSymbolProvider') return undefined;
    const path = uri.fsPath ?? uri;
    // `??` would fold an explicit null into 0 — check presence instead.
    const count = path in byPath ? byPath[path] : 0;
    if (count === null) return undefined;
    return Array.from({ length: count }, (_, i) => ({
      name: `sym${i}`,
      kind: 11,
      range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }
    }));
  });
}

describe('LspAvailability', () => {
  let service: LspAvailability;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset singleton via a fresh invalidate.
    service = LspAvailability.getInstance();
    service.invalidate();
  });

  describe('reportToolResult', () => {
    it('marks language available immediately on first success', () => {
      service.reportToolResult('typescript', true, '/x.ts');
      expect(service.getDeclaredAvailability().available).toContain('typescript');
    });

    it('does not flip to unavailable on the first empty result', () => {
      service.reportToolResult('typescript', true, '/x.ts');
      service.reportToolResult('typescript', false, '/empty.ts');
      // Threshold is 2 — single empty is tolerated.
      expect(service.getDeclaredAvailability().available).toContain('typescript');
    });

    it('flips to unavailable after threshold consecutive empty results', () => {
      service.reportToolResult('typescript', true, '/x.ts');
      service.reportToolResult('typescript', false, '/empty1.ts');
      service.reportToolResult('typescript', false, '/empty2.ts');
      const decl = service.getDeclaredAvailability();
      expect(decl.unavailable).toContain('typescript');
      expect(decl.available).not.toContain('typescript');
    });

    it('upgrades unavailable language to available immediately on success', () => {
      service.reportToolResult('ruby', false, '/foo.rb');
      service.reportToolResult('ruby', false, '/bar.rb');
      expect(service.getDeclaredAvailability().unavailable).toContain('ruby');
      service.reportToolResult('ruby', true, '/baz.rb');
      expect(service.getDeclaredAvailability().available).toContain('ruby');
    });

    it('resets consecutive-empty counter on success', () => {
      service.reportToolResult('typescript', true, '/x.ts');
      service.reportToolResult('typescript', false, '/empty.ts');
      service.reportToolResult('typescript', true, '/y.ts'); // resets counter
      service.reportToolResult('typescript', false, '/empty2.ts'); // 1st empty since reset
      expect(service.getDeclaredAvailability().available).toContain('typescript');
    });

    it('ignores empty languageId', () => {
      service.reportToolResult('', true, '/x');
      const decl = service.getDeclaredAvailability();
      expect(decl.available).toEqual([]);
    });
  });

  describe('getDeclaredAvailability', () => {
    it('returns sorted lists', () => {
      service.reportToolResult('python', true, '/a.py');
      service.reportToolResult('typescript', true, '/b.ts');
      service.reportToolResult('go', true, '/c.go');
      const decl = service.getDeclaredAvailability();
      expect(decl.available).toEqual(['go', 'python', 'typescript']);
    });

    it('returns empty arrays when no entries exist', () => {
      const decl = service.getDeclaredAvailability();
      expect(decl).toEqual({ available: [], unavailable: [], untested: [] });
    });
  });

  describe('discoverWorkspace', () => {
    it('probes one file per detected language', async () => {
      (vscode.workspace.findFiles as any).mockResolvedValue([
        makeUri('/proj/a.ts'),
        makeUri('/proj/b.ts'),
        makeUri('/proj/x.rb')
      ]);
      mockOpenDocument({
        '/proj/a.ts': 'typescript',
        '/proj/b.ts': 'typescript',
        '/proj/x.rb': 'ruby'
      });
      mockSymbols({
        '/proj/a.ts': 5,
        '/proj/b.ts': 5,
        '/proj/x.rb': null // no provider at all → genuinely unavailable
      });

      await service.discoverWorkspace();

      const decl = service.getDeclaredAvailability();
      expect(decl.available).toContain('typescript');
      expect(decl.unavailable).toContain('ruby');
      expect(decl.available).not.toContain('ruby');
    });

    it('skips languages that cannot be opened', async () => {
      (vscode.workspace.findFiles as any).mockResolvedValue([makeUri('/locked.ts')]);
      (vscode.workspace.openTextDocument as any).mockRejectedValue(new Error('EACCES'));
      await service.discoverWorkspace();
      expect(service.getDeclaredAvailability().available).toEqual([]);
      expect(service.getDeclaredAvailability().unavailable).toEqual([]);
    });

    it('handles empty workspace gracefully', async () => {
      (vscode.workspace.findFiles as any).mockResolvedValue([]);
      await service.discoverWorkspace();
      expect(service.getDeclaredAvailability()).toEqual({ available: [], unavailable: [], untested: [] });
    });

    it('coalesces concurrent calls into a single in-flight discovery', async () => {
      let resolveFinder: (uris: vscode.Uri[]) => void;
      (vscode.workspace.findFiles as any).mockImplementation(
        () => new Promise((res) => { resolveFinder = res as any; })
      );
      mockOpenDocument({ '/proj/a.ts': 'typescript' });
      mockSymbols({ '/proj/a.ts': 1 });

      const a = service.discoverWorkspace();
      const b = service.discoverWorkspace();
      // Both calls should resolve from the same promise — only one findFiles ran.
      expect(vscode.workspace.findFiles).toHaveBeenCalledTimes(1);
      resolveFinder!([makeUri('/proj/a.ts')]);
      await Promise.all([a, b]);
      expect(service.getDeclaredAvailability().available).toContain('typescript');
    });
  });

  describe('symbol-less samples do not condemn a language (the 2026-08-06 bug)', () => {
    it('reports untested, not unavailable, when every sample is legitimately symbol-less', async () => {
      // The reported shape: a workspace whose only .js file is a 4-line
      // comment-only stub. Zero symbols is the CORRECT LSP answer there,
      // and TS/JS ships with VS Code, so "No LSP for javascript" was a lie
      // the model then acted on for the whole session.
      (vscode.workspace.findFiles as any).mockResolvedValue([makeUri('/proj/site.js')]);
      mockOpenDocument({ '/proj/site.js': 'javascript' }, { '/proj/site.js': 4 });
      mockSymbols({ '/proj/site.js': 0 }); // provider answered: []

      await service.discoverWorkspace();

      const decl = service.getDeclaredAvailability();
      expect(decl.untested).toContain('javascript');
      expect(decl.unavailable).not.toContain('javascript');
      // And the tools must still be offered, or "try LSP first" is a lie.
      expect(service.hasUsableLsp()).toBe(true);
    });

    it('keeps sampling past a symbol-less file that size alone would have picked first', async () => {
      // Deliberately adversarial to the size heuristic: the symbol-LESS file
      // is the biggest one (a generated bundle), so ordering picks it first
      // and only walking to a second candidate can reach the truth. An
      // earlier version of this test made the rich file the largest, which
      // passed even with sampling reduced to one file — vacuous.
      (vscode.workspace.findFiles as any).mockResolvedValue([
        makeUri('/proj/bundle.js'),
        makeUri('/proj/real.js')
      ]);
      mockOpenDocument(
        { '/proj/bundle.js': 'javascript', '/proj/real.js': 'javascript' },
        { '/proj/bundle.js': 5000, '/proj/real.js': 80 }
      );
      mockSymbols({ '/proj/bundle.js': 0, '/proj/real.js': 7 });

      await service.discoverWorkspace();

      expect(service.getDeclaredAvailability().available).toContain('javascript');
    });

    it('still reports unavailable when no provider answers on any sample', async () => {
      // The verdict must stay reachable — otherwise the fix would just
      // replace one wrong answer with another.
      (vscode.workspace.findFiles as any).mockResolvedValue([
        makeUri('/proj/a.rb'),
        makeUri('/proj/b.rb')
      ]);
      mockOpenDocument({ '/proj/a.rb': 'ruby', '/proj/b.rb': 'ruby' });
      mockSymbols({ '/proj/a.rb': null, '/proj/b.rb': null });

      await service.discoverWorkspace();

      expect(service.getDeclaredAvailability().unavailable).toContain('ruby');
      expect(service.getDeclaredAvailability().untested).not.toContain('ruby');
    });

    it('retries against a file it has not already tried', async () => {
      // Re-probing state.sampledFile is what made the old retry incapable
      // of ever recovering.
      vi.useFakeTimers();
      try {
        (vscode.workspace.findFiles as any).mockResolvedValue([
          makeUri('/proj/big.rs'),
          makeUri('/proj/small.rs')
        ]);
        mockOpenDocument(
          { '/proj/big.rs': 'rust', '/proj/small.rs': 'rust' },
          { '/proj/big.rs': 400, '/proj/small.rs': 10 }
        );
        mockSymbols({ '/proj/big.rs': null, '/proj/small.rs': null });

        const discovery = service.discoverWorkspace();
        await vi.advanceTimersByTimeAsync(1000);
        await discovery;
        expect(service.getDeclaredAvailability().unavailable).toContain('rust');

        // Assert against the file the service ITSELF recorded, not a
        // hardcoded path: a hardcoded expectation passes trivially when
        // sampling is reduced to one candidate, because then the recorded
        // file and the retried file are the same by construction.
        const sampled = service.getRawMap().get('rust')!.sampledFile;
        expect(sampled).toBeTruthy();

        const probed: string[] = [];
        (vscode.commands.executeCommand as any).mockImplementation(async (cmd: string, uri: any) => {
          if (cmd !== 'vscode.executeDocumentSymbolProvider') return undefined;
          probed.push(uri.fsPath);
          return undefined;
        });

        await vi.advanceTimersByTimeAsync(30_000);
        await vi.advanceTimersByTimeAsync(1000);

        expect(probed.length).toBeGreaterThan(0);
        expect(probed).not.toContain(sampled);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('hasUsableLsp', () => {
    it('is false when nothing is known', () => {
      expect(service.hasUsableLsp()).toBe(false);
    });

    it('is true on a confirmed language', () => {
      service.reportToolResult('typescript', true, '/x.ts');
      expect(service.hasUsableLsp()).toBe(true);
    });

    it('is false when every language is confirmed unavailable', () => {
      service.reportToolResult('ruby', false, '/x.rb');
      expect(service.hasUsableLsp()).toBe(false);
    });
  });

  describe('invalidate', () => {
    it('clears the map', () => {
      service.reportToolResult('typescript', true, '/x.ts');
      service.invalidate();
      expect(service.getDeclaredAvailability().available).toEqual([]);
    });
  });

  describe('reactive recovery', () => {
    /** Inspect the private retryTimers map for scheduling assertions. */
    function pendingRetryFor(lang: string): boolean {
      return (service as any).retryTimers.has(lang);
    }

    it('schedules a retry after initial discovery for unavailable languages', async () => {
      (vscode.workspace.findFiles as any).mockResolvedValue([makeUri('/proj/main.rs')]);
      mockOpenDocument({ '/proj/main.rs': 'rust' });
      // Cold LSP: the server hasn't registered a provider yet, so nothing
      // handles the request — `undefined`, not an empty array.
      mockSymbols({ '/proj/main.rs': null });

      await service.discoverWorkspace();
      expect(service.getDeclaredAvailability().unavailable).toContain('rust');
      expect(pendingRetryFor('rust')).toBe(true);
      service.invalidate(); // clears the timer
    });

    it('does not schedule a retry for languages that came back available', async () => {
      (vscode.workspace.findFiles as any).mockResolvedValue([makeUri('/proj/a.ts')]);
      mockOpenDocument({ '/proj/a.ts': 'typescript' });
      mockSymbols({ '/proj/a.ts': 5 });

      await service.discoverWorkspace();
      expect(service.getDeclaredAvailability().available).toContain('typescript');
      expect(pendingRetryFor('typescript')).toBe(false);
    });

    it('clears pending retries on invalidate', async () => {
      (vscode.workspace.findFiles as any).mockResolvedValue([makeUri('/proj/x.go')]);
      mockOpenDocument({ '/proj/x.go': 'go' });
      mockSymbols({ '/proj/x.go': 0 });

      await service.discoverWorkspace();
      expect(pendingRetryFor('go')).toBe(true);
      service.invalidate();
      expect(pendingRetryFor('go')).toBe(false);
    });

    it('does not double-schedule for the same language', async () => {
      (vscode.workspace.findFiles as any).mockResolvedValue([makeUri('/proj/main.rs')]);
      mockOpenDocument({ '/proj/main.rs': 'rust' });
      mockSymbols({ '/proj/main.rs': 0 });

      await service.discoverWorkspace();
      const timersBefore = (service as any).retryTimers.size;
      // Calling scheduleRetry again should be a no-op.
      (service as any).scheduleRetry('rust', makeUri('/proj/main.rs'), 30_000);
      expect((service as any).retryTimers.size).toBe(timersBefore);
      service.invalidate();
    });
  });

  describe('probe timeout safety', () => {
    it('marks language unavailable when documentSymbolProvider hangs past PROBE_TIMEOUT_MS', async () => {
      vi.useFakeTimers();
      try {
        (vscode.workspace.findFiles as any).mockResolvedValue([makeUri('/proj/main.rs')]);
        mockOpenDocument({ '/proj/main.rs': 'rust' });
        // Hang forever — discovery should give up at PROBE_TIMEOUT_MS (5000ms).
        (vscode.commands.executeCommand as any).mockImplementation(
          () => new Promise(() => {})
        );

        const discovery = service.discoverWorkspace();
        // PROBE_PRE_DELAY_MS (250ms) + PROBE_TIMEOUT_MS (5000ms) — flush both.
        await vi.advanceTimersByTimeAsync(250);
        await vi.advanceTimersByTimeAsync(5_000);
        await discovery;

        const decl = service.getDeclaredAvailability();
        expect(decl.unavailable).toContain('rust');
        expect(decl.available).not.toContain('rust');
        service.invalidate();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not throw or hang on probe timeout — service stays usable for next probe', async () => {
      vi.useFakeTimers();
      try {
        (vscode.workspace.findFiles as any).mockResolvedValue([makeUri('/proj/x.rb')]);
        mockOpenDocument({ '/proj/x.rb': 'ruby' });
        (vscode.commands.executeCommand as any).mockImplementation(
          () => new Promise(() => {})
        );

        const discovery = service.discoverWorkspace();
        await vi.advanceTimersByTimeAsync(6_000);
        await discovery; // resolves cleanly even though probe timed out

        // Subsequent reportToolResult call should still operate.
        service.reportToolResult('ruby', true, '/proj/x.rb');
        expect(service.getDeclaredAvailability().available).toContain('ruby');
        service.invalidate();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('retry firing flips state on recovery', () => {
    it('flips ruby unavailable→available when retry probe sees symbols', async () => {
      vi.useFakeTimers();
      try {
        (vscode.workspace.findFiles as any).mockResolvedValue([makeUri('/proj/x.rb')]);
        mockOpenDocument({ '/proj/x.rb': 'ruby' });

        // First probe: no provider yet (cold) → unavailable, retry scheduled.
        let callCount = 0;
        (vscode.commands.executeCommand as any).mockImplementation(async (cmd: string) => {
          if (cmd !== 'vscode.executeDocumentSymbolProvider') return undefined;
          callCount++;
          return callCount === 1 ? undefined : [
            { name: 'foo', kind: 11, range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } } }
          ];
        });

        const discovery = service.discoverWorkspace();
        await vi.advanceTimersByTimeAsync(300); // PROBE_PRE_DELAY_MS
        await discovery;
        expect(service.getDeclaredAvailability().unavailable).toContain('ruby');

        // Fire the 30s retry — second probe returns symbols.
        await vi.advanceTimersByTimeAsync(30_000); // POST_DISCOVERY_RETRY_MS
        await vi.advanceTimersByTimeAsync(300);   // pre-delay inside probe

        expect(service.getDeclaredAvailability().available).toContain('ruby');
        expect(service.getDeclaredAvailability().unavailable).not.toContain('ruby');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('untested bucket', () => {
    it('lists languages reported by tool-result with observedAt!=0 in available/unavailable, not untested', () => {
      service.reportToolResult('typescript', true, '/x.ts');
      const decl = service.getDeclaredAvailability();
      expect(decl.available).toContain('typescript');
      expect(decl.untested).not.toContain('typescript');
    });

    // Untested only fires for entries with `source: 'probe'` AND `observedAt === 0`.
    // The current production code path doesn't synthesize such entries (probe always
    // sets observedAt to Date.now()), so this bucket is reserved for future use.
    // We at least verify the empty-state contract.
    it('returns empty untested when no entries match the predicate', () => {
      service.reportToolResult('python', false, '/x.py');
      service.reportToolResult('python', false, '/x.py');
      expect(service.getDeclaredAvailability().untested).toEqual([]);
    });
  });

  describe('editor focus listener', () => {
    function pendingRetryFor(lang: string): boolean {
      return (service as any).retryTimers.has(lang);
    }

    function captureFocusListener(): (editor: any) => void {
      let captured: any;
      (vscode.window.onDidChangeActiveTextEditor as any).mockImplementationOnce((cb: any) => {
        captured = cb;
        return { dispose: () => {} };
      });
      service.registerInvalidators();
      return captured;
    }

    function makeEditor(opts: {
      uri?: any;
      languageId?: string;
      isUntitled?: boolean;
    }) {
      return {
        document: {
          uri: opts.uri ?? makeUri('/proj/x.rb'),
          languageId: opts.languageId ?? 'ruby',
          isUntitled: opts.isUntitled ?? false
        }
      };
    }

    it('schedules retry when focusing a tab in an unavailable language', () => {
      service.reportToolResult('ruby', false, '/proj/x.rb');
      service.reportToolResult('ruby', false, '/proj/x.rb'); // hit threshold
      const fire = captureFocusListener();
      expect(pendingRetryFor('ruby')).toBe(false);
      fire(makeEditor({ languageId: 'ruby', uri: makeUri('/proj/x.rb') }));
      expect(pendingRetryFor('ruby')).toBe(true);
      service.invalidate();
    });

    it('skips when no editor (focus moved to non-editor panel)', () => {
      service.reportToolResult('ruby', false, '/x.rb');
      service.reportToolResult('ruby', false, '/x.rb');
      const fire = captureFocusListener();
      fire(undefined);
      expect(pendingRetryFor('ruby')).toBe(false);
    });

    it('skips untitled docs', () => {
      service.reportToolResult('ruby', false, '/x.rb');
      service.reportToolResult('ruby', false, '/x.rb');
      const fire = captureFocusListener();
      fire(makeEditor({ languageId: 'ruby', isUntitled: true }));
      expect(pendingRetryFor('ruby')).toBe(false);
    });

    it('skips non-file URI schemes', () => {
      service.reportToolResult('ruby', false, '/x.rb');
      service.reportToolResult('ruby', false, '/x.rb');
      const fire = captureFocusListener();
      const gitUri = { fsPath: '/x.rb', scheme: 'git', path: '/x.rb' };
      fire(makeEditor({ languageId: 'ruby', uri: gitUri }));
      expect(pendingRetryFor('ruby')).toBe(false);
    });

    it('skips plaintext languageId', () => {
      service.reportToolResult('plaintext', false, '/notes.txt');
      service.reportToolResult('plaintext', false, '/notes.txt');
      const fire = captureFocusListener();
      fire(makeEditor({ languageId: 'plaintext', uri: makeUri('/notes.txt') }));
      expect(pendingRetryFor('plaintext')).toBe(false);
    });

    it('skips languages not in our map', () => {
      const fire = captureFocusListener();
      fire(makeEditor({ languageId: 'cobol', uri: makeUri('/legacy.cob') }));
      expect(pendingRetryFor('cobol')).toBe(false);
    });

    it('skips when language is already available', () => {
      service.reportToolResult('typescript', true, '/x.ts');
      const fire = captureFocusListener();
      fire(makeEditor({ languageId: 'typescript', uri: makeUri('/x.ts') }));
      expect(pendingRetryFor('typescript')).toBe(false);
    });

    it('skips when retry already pending', () => {
      service.reportToolResult('ruby', false, '/x.rb');
      service.reportToolResult('ruby', false, '/x.rb');
      const fire = captureFocusListener();
      fire(makeEditor({ languageId: 'ruby', uri: makeUri('/x.rb') }));
      const sizeAfterFirst = (service as any).retryTimers.size;
      fire(makeEditor({ languageId: 'ruby', uri: makeUri('/y.rb') }));
      expect((service as any).retryTimers.size).toBe(sizeAfterFirst);
      service.invalidate();
    });
  });
});
