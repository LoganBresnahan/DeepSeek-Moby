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

function mockOpenDocument(byPath: Record<string, string>) {
  (vscode.workspace.openTextDocument as any).mockImplementation(async (uri: any) => {
    const lang = byPath[uri.fsPath ?? uri];
    if (lang === undefined) throw new Error(`unknown ${uri.fsPath}`);
    return { languageId: lang, uri, getText: () => '' };
  });
}

function mockSymbols(byPath: Record<string, number>) {
  (vscode.commands.executeCommand as any).mockImplementation(async (cmd: string, uri: any) => {
    if (cmd !== 'vscode.executeDocumentSymbolProvider') return undefined;
    const count = byPath[uri.fsPath ?? uri] ?? 0;
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
        '/proj/x.rb': 0
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
      mockSymbols({ '/proj/main.rs': 0 }); // cold-LSP miss

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

        // First probe: 0 symbols → ruby marked unavailable, retry scheduled.
        let callCount = 0;
        (vscode.commands.executeCommand as any).mockImplementation(async (cmd: string) => {
          if (cmd !== 'vscode.executeDocumentSymbolProvider') return undefined;
          callCount++;
          return callCount === 1 ? [] : [
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
