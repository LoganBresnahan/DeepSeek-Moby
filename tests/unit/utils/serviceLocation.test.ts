/**
 * Tests for the URL-resolution half of `serviceLocation.ts`.
 *
 * `pickServiceLocation` is a thin VS Code QuickPick wrapper that's not worth
 * unit-testing — it'd be all mock orchestration with no behavior to verify.
 * `resolveServiceUrl` is the pure function downstream code actually depends
 * on, and `isWSL` is the env detector that gates whether the WSL→Windows
 * picker option appears.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
  window: { showQuickPick: vi.fn(), showInputBox: vi.fn() }
}));

import { resolveServiceUrl, isWSL, type ServiceLocation } from '../../../src/utils/serviceLocation';

describe('resolveServiceUrl', () => {
  it('builds same-host URLs against localhost', () => {
    expect(resolveServiceUrl({ kind: 'same-host', port: 11434 })).toBe(
      'http://localhost:11434'
    );
  });

  it('appends a path suffix to same-host URLs when provided', () => {
    expect(resolveServiceUrl({ kind: 'same-host', port: 11434, path: '/v1' })).toBe(
      'http://localhost:11434/v1'
    );
  });

  it('builds wsl-to-windows URLs against host.docker.internal', () => {
    expect(resolveServiceUrl({ kind: 'wsl-to-windows', port: 8080 })).toBe(
      'http://host.docker.internal:8080'
    );
  });

  it('appends a path suffix to wsl-to-windows URLs', () => {
    expect(resolveServiceUrl({ kind: 'wsl-to-windows', port: 8080, path: '/v1' })).toBe(
      'http://host.docker.internal:8080/v1'
    );
  });

  it('builds LAN URLs against the user-provided host', () => {
    expect(resolveServiceUrl({ kind: 'lan', host: 'ai-box.local', port: 11434 })).toBe(
      'http://ai-box.local:11434'
    );
  });

  it('strips a leading scheme from a LAN host so we never produce http://http://...', () => {
    expect(resolveServiceUrl({ kind: 'lan', host: 'http://192.168.1.42', port: 11434 })).toBe(
      'http://192.168.1.42:11434'
    );
    expect(resolveServiceUrl({ kind: 'lan', host: 'https://nas.lan', port: 11434 })).toBe(
      'http://nas.lan:11434'
    );
  });

  it('strips trailing path/garbage from a LAN host before re-assembling', () => {
    // If the user pasted a full URL into the host input, drop everything after
    // the bare hostname so we don't end up with `http://foo/path:11434`.
    expect(
      resolveServiceUrl({ kind: 'lan', host: 'foo.local/some/leftover', port: 8080 })
    ).toBe('http://foo.local:8080');
  });

  it('returns custom-kind URLs verbatim', () => {
    const loc: ServiceLocation = { kind: 'custom', url: 'https://api.example.com/v1' };
    expect(resolveServiceUrl(loc)).toBe('https://api.example.com/v1');
  });

  it('does not append path suffix to custom URLs (caller already typed it)', () => {
    // Even if a path looks missing, custom is the user-types-everything escape
    // hatch — we preserve their input exactly.
    expect(resolveServiceUrl({ kind: 'custom', url: 'http://localhost:9999' })).toBe(
      'http://localhost:9999'
    );
  });
});

describe('isWSL', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns true when /proc/version contains "microsoft"', async () => {
    vi.doMock('fs', () => ({
      readFileSync: vi.fn(() => 'Linux version 5.15.0-microsoft-standard-WSL2 (...)')
    }));
    const mod = await import('../../../src/utils/serviceLocation');
    expect(mod.isWSL()).toBe(true);
  });

  it('returns false on a plain Linux kernel', async () => {
    vi.doMock('fs', () => ({
      readFileSync: vi.fn(() => 'Linux version 6.5.0-1015-azure (buildd@...)')
    }));
    const mod = await import('../../../src/utils/serviceLocation');
    expect(mod.isWSL()).toBe(false);
  });

  it('returns false (defensive) when /proc/version cannot be read', async () => {
    vi.doMock('fs', () => ({
      readFileSync: vi.fn(() => { throw new Error('ENOENT'); })
    }));
    const mod = await import('../../../src/utils/serviceLocation');
    expect(mod.isWSL()).toBe(false);
  });
});
