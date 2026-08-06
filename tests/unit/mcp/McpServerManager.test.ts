import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServerManager } from '../../../src/mcp/McpServerManager';
import { Tool } from '../../../src/deepseekClient';

// The spawn/handshake path needs a live transport and belongs to the Phase 4
// harness (InMemoryTransport + fixture server). These tests pin the request-
// path surface: the sync cache read, the dispatch guards, and the conventions
// executeTool must uphold (Error: prefix, signal + timeout forwarding).

const tool = (name: string): Tool => ({
  type: 'function',
  function: { name, description: '', parameters: { type: 'object', properties: {} } }
});

const entry = (over: Partial<Record<string, unknown>> = {}) => ({
  config: { name: 'pharos', command: 'pharos', args: [], env: {}, enabled: true },
  status: 'ready',
  client: null,
  transport: null,
  tools: [],
  generation: 0,
  ...over
});

function makeManager(): McpServerManager {
  return new (McpServerManager as any)();
}

function inject(manager: McpServerManager, name: string, e: Record<string, unknown>): void {
  (manager as any).servers.set(name, e);
}

describe('getToolsForRequest', () => {
  it('concatenates ready servers in registration order and skips the rest', () => {
    const manager = makeManager();
    inject(manager, 'alpha', entry({ status: 'ready', tools: [tool('mcp__alpha__a')] }));
    inject(manager, 'down', entry({ status: 'failed', tools: [tool('mcp__down__x')] }));
    inject(manager, 'slow', entry({ status: 'starting', tools: [tool('mcp__slow__y')] }));
    inject(manager, 'beta', entry({ status: 'ready', tools: [tool('mcp__beta__b')] }));

    expect(manager.getToolsForRequest().map(t => t.function.name)).toEqual([
      'mcp__alpha__a',
      'mcp__beta__b'
    ]);
  });

  it('returns empty with no servers', () => {
    expect(makeManager().getToolsForRequest()).toEqual([]);
  });
});

describe('executeTool guards', () => {
  const signal = new AbortController().signal;

  it('rejects a name that is not a namespaced MCP tool', async () => {
    const result = await makeManager().executeTool('read_file', '{}', signal);
    expect(result.startsWith('Error:')).toBe(true);
  });

  it('rejects an unknown server', async () => {
    const result = await makeManager().executeTool('mcp__ghost__hover', '{}', signal);
    expect(result).toBe('Error: MCP server "ghost" is not connected');
  });

  it('rejects a server that is not ready', async () => {
    const manager = makeManager();
    for (const status of ['starting', 'failed', 'stopped']) {
      inject(manager, 'pharos', entry({ status, client: { callTool: vi.fn() } }));
      const result = await manager.executeTool('mcp__pharos__hover', '{}', signal);
      expect(result).toBe('Error: MCP server "pharos" is not connected');
    }
  });

  it('rejects malformed and non-object argument JSON without calling the server', async () => {
    const manager = makeManager();
    const callTool = vi.fn();
    inject(manager, 'pharos', entry({ client: { callTool } }));

    expect(await manager.executeTool('mcp__pharos__hover', '{not json', signal)).toBe(
      'Error: invalid JSON arguments for mcp__pharos__hover'
    );
    expect(await manager.executeTool('mcp__pharos__hover', '[1,2]', signal)).toContain(
      'must be a JSON object'
    );
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe('executeTool dispatch conventions', () => {
  let manager: McpServerManager;
  let callTool: ReturnType<typeof vi.fn>;
  const signal = new AbortController().signal;

  beforeEach(() => {
    manager = makeManager();
    callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'hover text' }] }));
    inject(manager, 'pharos', entry({ client: { callTool } }));
  });

  it('un-namespaces the tool name and forwards signal + timeout to the SDK call', async () => {
    // A signal accepted but not forwarded is the ADR-0008 silent failure:
    // Stop returns while the MCP request keeps running server-side.
    const result = await manager.executeTool(
      'mcp__pharos__hover',
      JSON.stringify({ uri: 'file:///a.ts', line: 3 }),
      signal
    );
    expect(result).toBe('hover text');
    expect(callTool).toHaveBeenCalledWith(
      { name: 'hover', arguments: { uri: 'file:///a.ts', line: 3 } },
      undefined,
      { signal, timeout: 30_000 }
    );
  });

  it('keeps a tool-name-embedded separator intact when un-namespacing', async () => {
    await manager.executeTool('mcp__pharos__runtime__deep__probe', '{}', signal);
    expect(callTool.mock.calls[0][0].name).toBe('runtime__deep__probe');
  });

  it('treats empty argument JSON as an empty object', async () => {
    await manager.executeTool('mcp__pharos__hover', '', signal);
    expect(callTool.mock.calls[0][0].arguments).toEqual({});
  });

  it('translates an isError result into the Error: prefix', async () => {
    callTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'no symbol at position' }],
      isError: true
    });
    const result = await manager.executeTool('mcp__pharos__hover', '{}', signal);
    expect(result).toBe('Error: no symbol at position');
  });

  it('names the server in transport/protocol failures', async () => {
    callTool.mockRejectedValueOnce(new Error('Request timed out'));
    const result = await manager.executeTool('mcp__pharos__hover', '{}', signal);
    expect(result).toBe('Error: MCP server "pharos" — Request timed out');
  });

  it('truncates a runaway result with a named marker', async () => {
    callTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'x'.repeat(150_000) }]
    });
    const result = await manager.executeTool('mcp__pharos__hover', '{}', signal);
    expect(result.length).toBeLessThan(150_000);
    expect(result).toContain('[MCP result truncated at 100,000 chars — full length 150,000]');
  });

  it('reports an aborted call as aborted, not as the SDK internals', async () => {
    const controller = new AbortController();
    callTool.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error('MCP error -32001: some internal cancellation shape');
    });
    const result = await manager.executeTool('mcp__pharos__hover', '{}', controller.signal);
    expect(result).toBe('Error: MCP server "pharos" — call aborted');
  });
});

describe('dispose', () => {
  it('evicts every tool slice, closes clients, and survives a rejecting close', () => {
    const manager = makeManager();
    const close = vi.fn(async () => {
      throw new Error('already closed');
    });
    inject(manager, 'pharos', entry({ client: { close }, tools: [tool('mcp__pharos__hover')] }));

    manager.dispose();

    expect(close).toHaveBeenCalled();
    expect(manager.getToolsForRequest()).toEqual([]);
    expect(manager.getStatus()).toEqual([
      expect.objectContaining({ name: 'pharos', status: 'stopped', toolCount: 0 })
    ]);
  });

  it('closes the transport of a server still mid-handshake (no client yet)', () => {
    // client is only published post-handshake; without the transport
    // reference a window close during the handshake window would orphan
    // the spawned child.
    const manager = makeManager();
    const close = vi.fn(async () => {});
    inject(manager, 'pharos', entry({ status: 'starting', client: null, transport: { close } }));

    manager.dispose();

    expect(close).toHaveBeenCalled();
  });

  it('bumps the generation so in-flight startup work is discarded', () => {
    const manager = makeManager();
    const injected = entry({ status: 'starting', generation: 4 });
    inject(manager, 'pharos', injected);
    manager.dispose();
    expect((injected as any).generation).toBe(5);
    expect((injected as any).status).toBe('stopped');
  });
});

describe('getStatus', () => {
  it('reports per-server status, tool count, and last error', () => {
    const manager = makeManager();
    inject(manager, 'up', entry({
      config: { name: 'up', command: 'x', args: [], env: {}, enabled: true },
      tools: [tool('mcp__up__a'), tool('mcp__up__b')],
      serverInfo: { name: 'up-server', version: '1.0.0' }
    }));
    inject(manager, 'down', entry({
      config: { name: 'down', command: 'y', args: [], env: {}, enabled: true },
      status: 'failed',
      lastError: 'spawn ENOENT'
    }));

    expect(manager.getStatus()).toEqual([
      { name: 'up', status: 'ready', toolCount: 2, serverInfo: { name: 'up-server', version: '1.0.0' } },
      { name: 'down', status: 'failed', toolCount: 0, lastError: 'spawn ENOENT' }
    ]);
  });
});
