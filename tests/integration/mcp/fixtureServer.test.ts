import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as vscode from 'vscode';

import { McpServerManager } from '../../../src/mcp/McpServerManager';

/**
 * The manager against a REAL spawned stdio child.
 *
 * The in-memory tier (tests/unit/mcp/McpServerManagerTransport.test.ts)
 * covers protocol behaviour far faster. What only a child process can show
 * is what this file is for: spawn failure, process death, the graceful-close
 * window, and whether env/cwd actually reach the command.
 *
 * Backoff is injected in milliseconds — at the real [2s, 10s] the restart
 * specs would add ~14s of sleeping to CI.
 */

const FIXTURE = path.resolve(__dirname, '../../fixtures/mcp/fixture-server.js');
const REPO_MODULES = path.resolve(__dirname, '../../../node_modules');

function serverConfig(env: Record<string, string> = {}, args: string[] = []) {
  return {
    fixture: {
      command: 'node',
      args: [FIXTURE, ...args],
      // The fixture requires the SDK; the SDK's default env deliberately
      // omits NODE_PATH, so pass it explicitly.
      env: { NODE_PATH: REPO_MODULES, ...env }
    }
  };
}

function setConfig(raw: unknown): void {
  (vscode.workspace.getConfiguration as any).mockReturnValue({
    inspect: vi.fn(() => ({ globalValue: raw }))
  });
}

function makeManager(overrides: Record<string, unknown> = {}): McpServerManager {
  const manager = McpServerManager.createForTest({
    callTimeoutMs: 4_000,
    handshakeTimeoutMs: 10_000,
    restartBackoffMs: [20, 40],
    stableUptimeMs: 50,
    ...overrides
  });
  managers.push(manager);
  return manager;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Poll until `predicate` holds — beats a fixed sleep for process events. */
async function until(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(15);
  }
  throw new Error('condition not met within timeout');
}

let managers: McpServerManager[] = [];
beforeEach(() => setConfig(serverConfig()));
afterEach(async () => {
  for (const m of managers) m.dispose();
  managers = [];
  // Let the graceful closes drain so children don't outlive the run.
  await sleep(50);
});

describe('spawning a real MCP child process', () => {
  it('handshakes, lists tools, and round-trips a call', async () => {
    const manager = makeManager();

    await manager.startAll();

    const status = manager.getStatus();
    expect(status[0]).toEqual(
      expect.objectContaining({
        name: 'fixture',
        status: 'ready',
        serverInfo: { name: 'fixture', version: '1.2.3' }
      })
    );
    expect(manager.getToolsForRequest().map(t => t.function.name)).toContain('mcp__fixture__echo');

    const result = await manager.executeTool(
      'mcp__fixture__echo',
      JSON.stringify({ message: 'over a pipe' }),
      new AbortController().signal
    );
    expect(result).toBe('over a pipe');
  }, 30_000);

  it('carries $defs through a real wire round-trip', async () => {
    const manager = makeManager();
    await manager.startAll();

    const nested = manager.getToolsForRequest().find(t => t.function.name === 'mcp__fixture__nested');
    const params = nested!.function.parameters as Record<string, unknown>;
    expect(params.$defs).toEqual({ Opts: { type: 'object', properties: { depth: { type: 'number' } } } });
    expect(params.additionalProperties).toBe(false);
  }, 30_000);

  it('skips an over-long tool name and keeps the rest of the server usable', async () => {
    setConfig(serverConfig({ FIXTURE_MODE: 'bad-name' }));
    const manager = makeManager();

    await manager.startAll();

    const names = manager.getToolsForRequest().map(t => t.function.name);
    expect(names).toContain('mcp__fixture__echo');
    expect(names.every(n => n.length <= 64)).toBe(true);
    expect(manager.getStatus()[0].status).toBe('ready');
  }, 30_000);

  it('passes env through to the child', async () => {
    setConfig(serverConfig({ FIXTURE_INSTRUCTIONS: 'Injected via env.' }));
    const manager = makeManager();

    await manager.startAll();

    expect(manager.getInstructions('fixture')).toBe('Injected via env.');
  }, 30_000);

  it('reports a failed result and a timeout as Error:, and keeps serving after', async () => {
    const manager = makeManager({ callTimeoutMs: 300 });
    await manager.startAll();
    const signal = new AbortController().signal;

    expect(await manager.executeTool('mcp__fixture__fail', '{}', signal)).toBe('Error: the tool refused');

    const timedOut = await manager.executeTool(
      'mcp__fixture__slow', JSON.stringify({ ms: 5_000 }), signal
    );
    expect(timedOut.startsWith('Error: MCP server "fixture" —')).toBe(true);

    // A timeout must not poison the connection.
    expect(manager.getStatus()[0].status).toBe('ready');
    expect(await manager.executeTool('mcp__fixture__echo', '{"message":"still here"}', signal))
      .toBe('still here');
  }, 30_000);

  it('truncates an oversized real result with a named marker', async () => {
    const manager = makeManager();
    await manager.startAll();

    const result = await manager.executeTool(
      'mcp__fixture__huge', JSON.stringify({ chars: 120_000 }), new AbortController().signal
    );
    expect(result).toContain('[MCP result truncated at 100,000 chars');
  }, 30_000);
});

describe('tools/list_changed from a real child', () => {
  it('picks up a tool the server adds at runtime', async () => {
    // pharos declares listChanged:false, so this path has no other coverage.
    const manager = makeManager();
    await manager.startAll();
    expect(manager.getToolsForRequest().map(t => t.function.name)).not.toContain('mcp__fixture__added_1');

    await manager.executeTool('mcp__fixture__add_tool', '{}', new AbortController().signal);
    await until(() =>
      manager.getToolsForRequest().some(t => t.function.name === 'mcp__fixture__added_1')
    );

    expect(manager.getToolsForRequest().map(t => t.function.name)).toContain('mcp__fixture__added_1');
  }, 30_000);
});

describe('restart policy against real process death', () => {
  it('does not restart a server whose command does not exist', async () => {
    setConfig({ fixture: { command: 'moby-definitely-not-a-real-binary' } });
    const manager = makeManager();

    await manager.startAll();

    const entry = (manager as any).servers.get('fixture');
    expect(manager.getStatus()[0].status).toBe('failed');
    expect(manager.getStatus()[0].lastError).toContain('ENOENT');
    // A wrong command cannot become right by retrying.
    expect(entry.everReady).toBe(false);
    expect(entry.restartAttempts).toBe(0);
    expect(entry.restartTimer).toBeNull();
  }, 30_000);

  it('exhausts the budget on a handshake-then-exit crash loop and stays down', async () => {
    // The trap this proves closed: resetting the budget on each 'ready'
    // would let this server restart forever.
    setConfig(serverConfig({ FIXTURE_MODE: 'crash-after-handshake', FIXTURE_CRASH_DELAY_MS: '80' }));
    const manager = makeManager({ restartBackoffMs: [20, 40], stableUptimeMs: 60_000 });

    await manager.startAll();
    const entry = (manager as any).servers.get('fixture');

    await until(() => entry.restartAttempts === 2 && entry.restartTimer === null && entry.status === 'failed');

    expect(entry.everReady).toBe(true);
    expect(entry.restartAttempts).toBe(2);
    expect(entry.status).toBe('failed');
    expect(manager.getToolsForRequest()).toEqual([]);

    // Confirm it stays down rather than quietly retrying.
    await sleep(300);
    expect(entry.restartAttempts).toBe(2);
    expect(entry.restartTimer).toBeNull();
  }, 30_000);

  it('the refresh command revives a server that exhausted its budget', async () => {
    setConfig(serverConfig({ FIXTURE_MODE: 'crash-after-handshake', FIXTURE_CRASH_DELAY_MS: '80' }));
    const manager = makeManager({ restartBackoffMs: [20, 40], stableUptimeMs: 60_000 });
    await manager.startAll();
    const dead = (manager as any).servers.get('fixture');
    await until(() => dead.restartAttempts === 2 && dead.restartTimer === null);

    // The user fixes whatever was wrong, then refreshes.
    setConfig(serverConfig());
    await manager.restartAll();

    expect(manager.getStatus()[0].status).toBe('ready');
    expect((manager as any).servers.get('fixture').restartAttempts).toBe(0);
  }, 30_000);

  it('treats a crash during the startup tools/list as a crash, not a bad command', async () => {
    setConfig(serverConfig({ FIXTURE_MODE: 'crash-during-list' }));
    const manager = makeManager({ restartBackoffMs: [20, 40], stableUptimeMs: 60_000 });

    await manager.startAll();
    const entry = (manager as any).servers.get('fixture');

    // everReady must be true — the handshake DID succeed — so the policy
    // retries rather than logging "died before completing a handshake".
    expect(entry.everReady).toBe(true);
    await until(() => entry.restartAttempts >= 1);
    expect(entry.restartAttempts).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('a server dying mid-call resolves that call to a named Error and follows the crash policy', async () => {
    // The Phase 5 lifecycle edge: the model called a tool and the child died
    // before answering. The turn must get a conforming Error: string (never
    // a hang, never a rejection), and the crash policy must then treat this
    // as a post-ready death — evict the tools and schedule a restart.
    const manager = makeManager({ restartBackoffMs: [5_000], stableUptimeMs: 60_000 });
    await manager.startAll();
    expect(manager.getStatus()[0].status).toBe('ready');

    const result = await manager.executeTool(
      'mcp__fixture__die', '{}', new AbortController().signal
    );
    expect(result.startsWith('Error: MCP server "fixture" —')).toBe(true);

    await until(() => manager.getStatus()[0].status === 'failed');
    expect(manager.getToolsForRequest()).toEqual([]);

    const entry = (manager as any).servers.get('fixture');
    expect(entry.everReady).toBe(true);
    // Died after being ready → a restart is pending, not written off.
    expect(entry.restartTimer).not.toBeNull();
  }, 30_000);

  it('evicts a dead server tools from the request array', async () => {
    setConfig(serverConfig({ FIXTURE_MODE: 'crash-after-handshake', FIXTURE_CRASH_DELAY_MS: '150' }));
    const manager = makeManager({ restartBackoffMs: [5_000], stableUptimeMs: 60_000 });
    await manager.startAll();
    expect(manager.getToolsForRequest().length).toBeGreaterThan(0);

    await until(() => manager.getStatus()[0].status === 'failed');

    expect(manager.getToolsForRequest()).toEqual([]);
    // A call against the dead server is a named error, not a hang.
    const result = await manager.executeTool(
      'mcp__fixture__echo', '{"message":"x"}', new AbortController().signal
    );
    expect(result).toBe('Error: MCP server "fixture" is not connected');
  }, 30_000);
});

describe('reconciliation against real children', () => {
  it('restarts a server whose args changed, without running two copies', async () => {
    const manager = makeManager();
    await manager.startAll();
    const first = (manager as any).servers.get('fixture');

    setConfig(serverConfig({ FIXTURE_INSTRUCTIONS: 'Second generation.' }));
    await manager.reconcile();

    const second = (manager as any).servers.get('fixture');
    expect(second).not.toBe(first);
    expect(first.status).toBe('stopped');
    expect(manager.getStatus()[0].status).toBe('ready');
    expect(manager.getInstructions('fixture')).toBe('Second generation.');
  }, 30_000);

  it('stops a server removed from settings and drops its tools', async () => {
    const manager = makeManager();
    await manager.startAll();
    expect(manager.getToolsForRequest().length).toBeGreaterThan(0);

    setConfig({});
    await manager.reconcile();

    expect(manager.getStatus()).toEqual([]);
    expect(manager.getToolsForRequest()).toEqual([]);
  }, 30_000);
});

describe('disposal', () => {
  it('kills the child so it does not outlive the extension host', async () => {
    const manager = makeManager();
    await manager.startAll();
    const entry = (manager as any).servers.get('fixture');
    const pid = (entry.transport as any).pid as number;
    expect(typeof pid).toBe('number');

    manager.dispose();
    await until(() => {
      try {
        process.kill(pid, 0);
        return false; // still alive
      } catch {
        return true; // gone
      }
    });
  }, 30_000);
});
