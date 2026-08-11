import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';

import {
  buildServerPickItems,
  diffEnabled,
  manageMcpServers
} from '../../../src/mcp/manageServers';
import { setMcpServersEnabled } from '../../../src/mcp/config';
import { McpServerConfig } from '../../../src/mcp/config';
import { McpServerStatusEntry } from '../../../src/mcp/McpServerManager';

/**
 * `moby.manageMcpServers` — the status picker and its enable/disable write.
 *
 * The load-bearing behaviours (ADR 0016 decision 14): disabled servers still
 * appear (or they can never be switched back on), the write goes to GLOBAL
 * scope so it lands where the security-boundary read looks, unknown keys in
 * an entry survive a toggle, and an unchanged confirmation writes nothing.
 */

function cfg(name: string, over: Partial<McpServerConfig> = {}): McpServerConfig {
  return { name, command: 'srv', args: [], env: {}, enabled: true, ...over };
}

function setRawConfig(raw: unknown, update = vi.fn()) {
  (vscode.workspace.getConfiguration as any).mockReturnValue({
    inspect: vi.fn(() => ({ globalValue: raw })),
    update
  });
  return update;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildServerPickItems', () => {
  it('lists a disabled server so it can be switched back on', () => {
    const items = buildServerPickItems([cfg('off', { enabled: false })], []);

    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('off');
    expect(items[0].picked).toBe(false);
    expect(items[0].description).toBe('disabled');
  });

  it('shows tool count and server version for a ready server', () => {
    const status: McpServerStatusEntry[] = [
      { name: 'pharos', status: 'ready', toolCount: 37, serverInfo: { name: 'pharos', version: '0.1.2' } }
    ];

    const items = buildServerPickItems([cfg('pharos')], status);

    expect(items[0].picked).toBe(true);
    expect(items[0].description).toBe('ready · 37 tools (pharos 0.1.2)');
  });

  it('surfaces the failure reason, which is otherwise only in the log', () => {
    const status: McpServerStatusEntry[] = [
      { name: 'broken', status: 'failed', toolCount: 0, lastError: 'spawn ENOENT' }
    ];

    const items = buildServerPickItems([cfg('broken', { command: 'nope' })], status);

    expect(items[0].description).toBe('failed — spawn ENOENT');
    expect(items[0].detail).toContain('spawn ENOENT');
  });

  it('distinguishes an enabled server that has not started from a disabled one', () => {
    const items = buildServerPickItems([cfg('pending')], []);
    expect(items[0].description).toBe('not started');
  });

  it('singularises a one-tool server', () => {
    const status: McpServerStatusEntry[] = [{ name: 'tiny', status: 'ready', toolCount: 1 }];
    expect(buildServerPickItems([cfg('tiny')], status)[0].description).toBe('ready · 1 tool');
  });
});

describe('diffEnabled', () => {
  it('reports only genuine changes', () => {
    const servers = [cfg('a'), cfg('b', { enabled: false }), cfg('c')];

    const changes = diffEnabled(servers, new Set(['a', 'b']));

    expect([...changes.entries()]).toEqual([['b', true], ['c', false]]);
  });

  it('is empty when the checked set matches settings', () => {
    const servers = [cfg('a'), cfg('b', { enabled: false })];
    expect(diffEnabled(servers, new Set(['a'])).size).toBe(0);
  });
});

describe('setMcpServersEnabled', () => {
  it('writes to GLOBAL scope — the same scope the security boundary reads', async () => {
    const update = setRawConfig({ pharos: { command: 'pharos' } });

    await setMcpServersEnabled(new Map([['pharos', false]]));

    expect(update).toHaveBeenCalledWith(
      'mcpServers',
      { pharos: { command: 'pharos', enabled: false } },
      vscode.ConfigurationTarget.Global
    );
  });

  it('preserves keys it does not model, so a toggle cannot eat config', async () => {
    // Rebuilding from validated entries would silently drop anything the
    // validator ignores — including keys added by a future version.
    const update = setRawConfig({
      pharos: { command: 'pharos', args: ['--x'], env: { A: '1' }, cwd: '/w', futureKey: 42 }
    });

    await setMcpServersEnabled(new Map([['pharos', false]]));

    expect(update).toHaveBeenCalledWith(
      'mcpServers',
      { pharos: { command: 'pharos', args: ['--x'], env: { A: '1' }, cwd: '/w', futureKey: 42, enabled: false } },
      vscode.ConfigurationTarget.Global
    );
  });

  it('leaves untouched servers exactly as they were', async () => {
    const update = setRawConfig({ a: { command: 'a' }, b: { command: 'b', enabled: false } });

    await setMcpServersEnabled(new Map([['b', true]]));

    expect(update).toHaveBeenCalledWith(
      'mcpServers',
      { a: { command: 'a' }, b: { command: 'b', enabled: true } },
      vscode.ConfigurationTarget.Global
    );
  });

  it('does not invent an entry for a name that is not configured', async () => {
    const update = setRawConfig({ a: { command: 'a' } });

    await setMcpServersEnabled(new Map([['ghost', true]]));

    expect(update).toHaveBeenCalledWith(
      'mcpServers',
      { a: { command: 'a' } },
      vscode.ConfigurationTarget.Global
    );
  });

  it('writes nothing when there are no changes', async () => {
    const update = setRawConfig({ a: { command: 'a' } });
    await setMcpServersEnabled(new Map());
    expect(update).not.toHaveBeenCalled();
  });
});

describe('manageMcpServers', () => {
  it('writes nothing when the picker is cancelled', async () => {
    const update = setRawConfig({ a: { command: 'a' } });
    (vscode.window.showQuickPick as any).mockResolvedValue(undefined);

    await manageMcpServers(() => []);

    expect(update).not.toHaveBeenCalled();
  });

  it('treats cancellation differently from unchecking everything', async () => {
    // An empty ARRAY is the user deliberately unchecking all; `undefined` is
    // Escape. Conflating them would silently disable every server.
    const update = setRawConfig({ a: { command: 'a' } });
    (vscode.window.showQuickPick as any).mockResolvedValue([]);

    await manageMcpServers(() => []);

    expect(update).toHaveBeenCalledWith(
      'mcpServers',
      { a: { command: 'a', enabled: false } },
      vscode.ConfigurationTarget.Global
    );
  });

  it('persists the checked set and never starts servers itself', async () => {
    const update = setRawConfig({
      a: { command: 'a', enabled: false },
      b: { command: 'b' }
    });
    (vscode.window.showQuickPick as any).mockResolvedValue([{ label: 'a' }]);

    await manageMcpServers(() => []);

    // Reconciliation is the config listener's job — this handler only writes.
    expect(update).toHaveBeenCalledWith(
      'mcpServers',
      { a: { command: 'a', enabled: true }, b: { command: 'b', enabled: false } },
      vscode.ConfigurationTarget.Global
    );
  });

  it('tells a user with no servers where to add them, without opening a picker', async () => {
    setRawConfig({});

    await manageMcpServers(() => []);

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('no MCP servers configured')
    );
  });

  it('says entries were rejected rather than "none configured" when validation failed', async () => {
    setRawConfig({ 'bad name!': { command: 'x' } });

    await manageMcpServers(() => []);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('rejected')
    );
  });
});
