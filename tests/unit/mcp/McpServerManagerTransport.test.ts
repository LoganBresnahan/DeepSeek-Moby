import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListRootsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

import { McpServerManager } from '../../../src/mcp/McpServerManager';

/**
 * The manager driven against a REAL MCP server over the SDK's linked
 * in-memory transports — a genuine handshake, genuine JSON-RPC, no child
 * process. This is the tier that proves the wiring end to end in
 * milliseconds; the fixture-server tier (tests/integration/mcp) covers what
 * only a real child can show.
 */

interface ServerOptions {
  tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  instructions?: string;
  listChanged?: boolean;
  declareTools?: boolean;
  onCall?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/** A server plus the handle the test needs to drive it mid-flight. */
interface Harness {
  server: Server;
  clientTransport: InMemoryTransport;
  setTools(tools: ServerOptions['tools']): void;
  notifyListChanged(): Promise<void>;
  rootsSeen: Array<unknown>;
  askForRoots(): Promise<unknown>;
}

async function makeServer(opts: ServerOptions = {}): Promise<Harness> {
  const {
    instructions = 'Fixture instructions.',
    listChanged = true,
    declareTools = true,
    onCall
  } = opts;
  let tools = opts.tools ?? [
    { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } }
  ];

  const server = new Server(
    { name: 'inmem', version: '9.9.9' },
    {
      capabilities: declareTools ? { tools: { listChanged } } : {},
      instructions
    }
  );

  // The SDK refuses to register these on a server that declared no tools
  // capability — which is exactly the state the no-tools case is testing.
  if (declareTools) {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools as never }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      if (onCall) {
        return (await onCall(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>)) as never;
      }
      return { content: [{ type: 'text', text: `called ${req.params.name}` }] } as never;
    });
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const rootsSeen: unknown[] = [];
  return {
    server,
    clientTransport,
    setTools: (next) => { tools = next ?? []; },
    notifyListChanged: () => server.sendToolListChanged(),
    rootsSeen,
    askForRoots: async () => {
      const result = await server.listRoots();
      rootsSeen.push(result);
      return result;
    }
  };
}

function managerFor(harness: Harness, overrides: Record<string, unknown> = {}): McpServerManager {
  return McpServerManager.createForTest({
    createTransport: () => harness.clientTransport as never,
    callTimeoutMs: 2_000,
    handshakeTimeoutMs: 2_000,
    restartBackoffMs: [5, 10],
    stableUptimeMs: 50,
    ...overrides
  });
}

function setConfig(raw: unknown): void {
  (vscode.workspace.getConfiguration as any).mockReturnValue({
    inspect: vi.fn(() => ({ globalValue: raw }))
  });
}

const ONE_SERVER = { inmem: { command: 'unused-in-memory' } };

let managers: McpServerManager[] = [];
function track(m: McpServerManager): McpServerManager {
  managers.push(m);
  return m;
}

beforeEach(() => setConfig(ONE_SERVER));
afterEach(() => {
  for (const m of managers) m.dispose();
  managers = [];
});

describe('handshake against a real server', () => {
  it('reaches ready, captures instructions + serverInfo, and caches namespaced tools', async () => {
    const harness = await makeServer({
      instructions: 'Prefer the echo tool.',
      tools: [
        { name: 'echo', description: 'Echo it', inputSchema: { type: 'object', properties: { m: { type: 'string' } } } },
        { name: 'other', inputSchema: { type: 'object', properties: {} } }
      ]
    });
    const manager = track(managerFor(harness));

    await manager.startAll();

    expect(manager.getStatus()).toEqual([
      expect.objectContaining({
        name: 'inmem',
        status: 'ready',
        toolCount: 2,
        serverInfo: { name: 'inmem', version: '9.9.9' }
      })
    ]);
    expect(manager.getToolsForRequest().map(t => t.function.name)).toEqual([
      'mcp__inmem__echo',
      'mcp__inmem__other'
    ]);
    expect(manager.getInstructions('inmem')).toBe('Prefer the echo tool.');
    expect(manager.getInstructionsBlock()).toContain('Prefer the echo tool.');
  });

  it('carries the full inputSchema — including $defs — through to the tools array', async () => {
    // The Phase 2 defect: rebuilding parameters from properties/required
    // alone left FastMCP-style $refs dangling.
    const harness = await makeServer({
      tools: [{
        name: 'nested',
        inputSchema: {
          type: 'object',
          properties: { opts: { $ref: '#/$defs/Opts' } },
          required: ['opts'],
          $defs: { Opts: { type: 'object', properties: { depth: { type: 'number' } } } },
          additionalProperties: false
        }
      }]
    });
    const manager = track(managerFor(harness));

    await manager.startAll();

    const params = manager.getToolsForRequest()[0].function.parameters as Record<string, unknown>;
    expect(params.$defs).toEqual({ Opts: { type: 'object', properties: { depth: { type: 'number' } } } });
    expect(params.additionalProperties).toBe(false);
    expect(params.required).toEqual(['opts']);
  });

  it('skips a tool whose namespaced name exceeds the API cap, keeping the rest', async () => {
    const harness = await makeServer({
      tools: [
        { name: 'ok', inputSchema: { type: 'object', properties: {} } },
        { name: 'z'.repeat(60), inputSchema: { type: 'object', properties: {} } }
      ]
    });
    const manager = track(managerFor(harness));

    await manager.startAll();

    expect(manager.getToolsForRequest().map(t => t.function.name)).toEqual(['mcp__inmem__ok']);
  });

  it('reaches ready with zero tools when the server declares no tools capability', async () => {
    const harness = await makeServer({ declareTools: false });
    const manager = track(managerFor(harness));

    await manager.startAll();

    expect(manager.getStatus()[0].status).toBe('ready');
    expect(manager.getToolsForRequest()).toEqual([]);
  });
});

describe('tools/list_changed', () => {
  it('replaces the cached slice when the server announces a change', async () => {
    const harness = await makeServer({
      tools: [{ name: 'before', inputSchema: { type: 'object', properties: {} } }]
    });
    const manager = track(managerFor(harness));
    await manager.startAll();
    expect(manager.getToolsForRequest().map(t => t.function.name)).toEqual(['mcp__inmem__before']);

    harness.setTools([
      { name: 'after_one', inputSchema: { type: 'object', properties: {} } },
      { name: 'after_two', inputSchema: { type: 'object', properties: {} } }
    ]);
    await harness.notifyListChanged();
    await (manager as any).refreshChains.get('inmem');

    expect(manager.getToolsForRequest().map(t => t.function.name)).toEqual([
      'mcp__inmem__after_one',
      'mcp__inmem__after_two'
    ]);
  });

  it('serializes back-to-back notifications so the last list wins', async () => {
    const harness = await makeServer({
      tools: [{ name: 'v0', inputSchema: { type: 'object', properties: {} } }]
    });
    const manager = track(managerFor(harness));
    await manager.startAll();

    harness.setTools([{ name: 'v1', inputSchema: { type: 'object', properties: {} } }]);
    await harness.notifyListChanged();
    harness.setTools([{ name: 'v2', inputSchema: { type: 'object', properties: {} } }]);
    await harness.notifyListChanged();
    await (manager as any).refreshChains.get('inmem');

    expect(manager.getToolsForRequest().map(t => t.function.name)).toEqual(['mcp__inmem__v2']);
  });

  it('ignores a notification that arrives after the server was stopped', async () => {
    const harness = await makeServer({
      tools: [{ name: 'v0', inputSchema: { type: 'object', properties: {} } }]
    });
    const manager = track(managerFor(harness));
    await manager.startAll();

    const entry = (manager as any).servers.get('inmem');
    (manager as any).stopServer(entry);
    harness.setTools([{ name: 'ghost', inputSchema: { type: 'object', properties: {} } }]);
    await harness.notifyListChanged().catch(() => {});
    await (manager as any).refreshChains.get('inmem');

    expect(entry.tools).toEqual([]);
    expect(manager.getToolsForRequest()).toEqual([]);
  });

  it('a replacement server keeps its own tool list after its predecessor is stopped', async () => {
    const outgoing = await makeServer({
      tools: [{ name: 'old', inputSchema: { type: 'object', properties: {} } }]
    });
    const incoming = await makeServer({
      tools: [{ name: 'new_one', inputSchema: { type: 'object', properties: {} } }]
    });

    const queue = [outgoing.clientTransport, incoming.clientTransport];
    const manager = track(McpServerManager.createForTest({
      createTransport: () => queue.shift() as never,
      callTimeoutMs: 2_000,
      handshakeTimeoutMs: 2_000,
      restartBackoffMs: [5, 10],
      stableUptimeMs: 50
    }));

    await manager.startAll();
    expect(manager.getToolsForRequest().map(t => t.function.name)).toEqual(['mcp__inmem__old']);

    setConfig({ inmem: { command: 'unused-in-memory', args: ['--v2'] } });
    await manager.reconcile();

    outgoing.setTools([{ name: 'ghost', inputSchema: { type: 'object', properties: {} } }]);
    await outgoing.notifyListChanged().catch(() => {});
    await (manager as any).refreshChains.get('inmem');

    expect(manager.getToolsForRequest().map(t => t.function.name)).toEqual(['mcp__inmem__new_one']);
  });

  it('the list_changed handler discards a notification from a superseded generation', async () => {
    // This one invokes the registered handler DIRECTLY, which needs
    // justifying. The window it models belongs to the stdio transport: on
    // close the SDK keeps the child's stdout listener attached until the
    // graceful shutdown finishes (up to 4s), and `Protocol._onclose()` does
    // NOT clear `_notificationHandlers` — so a late notification really is
    // dispatched to our closure. InMemoryTransport severs the link
    // instantly, so it cannot produce that window; driving the handler is
    // the only way to reach the guard. Without it, `queueToolRefresh`
    // resolves the entry by NAME and would refresh the live replacement.
    const harness = await makeServer({
      tools: [{ name: 'v0', inputSchema: { type: 'object', properties: {} } }]
    });
    const manager = track(managerFor(harness));
    await manager.startAll();

    const entry = (manager as any).servers.get('inmem');
    const client = entry.client;
    const handler = (client as any)._notificationHandlers.get('notifications/tools/list_changed');
    expect(handler).toBeTypeOf('function');

    const queueSpy = vi.spyOn(manager as any, 'queueToolRefresh');

    // Still current → the notification is acted on.
    await handler({ method: 'notifications/tools/list_changed', params: {} });
    expect(queueSpy).toHaveBeenCalledTimes(1);

    // Superseded (what stopServer does) → the notification is discarded,
    // even though an entry under this name is still live.
    entry.generation++;
    await handler({ method: 'notifications/tools/list_changed', params: {} });
    expect(queueSpy).toHaveBeenCalledTimes(1);
  });
});

describe('executeTool over a real transport', () => {
  const signal = new AbortController().signal;

  it('round-trips a call and returns the text content', async () => {
    const harness = await makeServer({
      onCall: async (name, args) => ({
        content: [{ type: 'text', text: `${name}:${JSON.stringify(args)}` }]
      })
    });
    const manager = track(managerFor(harness));
    await manager.startAll();

    const result = await manager.executeTool('mcp__inmem__echo', '{"m":"hi"}', signal);
    expect(result).toBe('echo:{"m":"hi"}');
  });

  it('maps an isError result to the Error: prefix', async () => {
    const harness = await makeServer({
      onCall: async () => ({ content: [{ type: 'text', text: 'nope' }], isError: true })
    });
    const manager = track(managerFor(harness));
    await manager.startAll();

    expect(await manager.executeTool('mcp__inmem__echo', '{}', signal)).toBe('Error: nope');
  });

  it('names a non-text content block instead of dropping it', async () => {
    const harness = await makeServer({
      onCall: async () => ({ content: [{ type: 'image', data: 'QUJD', mimeType: 'image/png' }] })
    });
    const manager = track(managerFor(harness));
    await manager.startAll();

    const result = await manager.executeTool('mcp__inmem__echo', '{}', signal);
    expect(result).toContain('[MCP tool returned image content — not supported yet]');
    expect(result).not.toContain('QUJD');
  });

  it('surfaces a thrown server error as Error: naming the server', async () => {
    const harness = await makeServer({
      onCall: async () => { throw new Error('handler exploded'); }
    });
    const manager = track(managerFor(harness));
    await manager.startAll();

    const result = await manager.executeTool('mcp__inmem__echo', '{}', signal);
    expect(result.startsWith('Error: MCP server "inmem" —')).toBe(true);
  });

  it('honours the injected call timeout on a hanging tool', async () => {
    // The reason the timeout is injectable at all: at the real 30s this
    // spec would be a 30-second sleep in CI.
    const harness = await makeServer({
      onCall: () => new Promise(() => {}) // never settles
    });
    const manager = track(managerFor(harness, { callTimeoutMs: 120 }));
    await manager.startAll();

    const started = Date.now();
    const result = await manager.executeTool('mcp__inmem__echo', '{}', signal);
    expect(result.startsWith('Error:')).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('aborts an in-flight call when the signal fires', async () => {
    const harness = await makeServer({
      onCall: () => new Promise(() => {})
    });
    const manager = track(managerFor(harness, { callTimeoutMs: 5_000 }));
    await manager.startAll();

    const controller = new AbortController();
    const pending = manager.executeTool('mcp__inmem__echo', '{}', controller.signal);
    controller.abort();

    expect(await pending).toBe('Error: MCP server "inmem" — call aborted');
  });

  it('truncates an oversized result with a named marker', async () => {
    const harness = await makeServer({
      onCall: async () => ({ content: [{ type: 'text', text: 'x'.repeat(120_000) }] })
    });
    const manager = track(managerFor(harness));
    await manager.startAll();

    const result = await manager.executeTool('mcp__inmem__echo', '{}', signal);
    expect(result).toContain('[MCP result truncated at 100,000 chars — full length 120,000]');
  });
});

describe('roots served over a real transport', () => {
  it('answers roots/list with the workspace folders', async () => {
    const harness = await makeServer();
    (vscode.workspace as any).workspaceFolders = [
      { uri: { toString: () => 'file:///work/one' }, name: 'one' },
      { uri: { toString: () => 'file:///work/two' }, name: 'two' }
    ];
    const manager = track(managerFor(harness));
    await manager.startAll();

    const result = await harness.askForRoots();

    expect(result).toEqual({
      roots: [
        { uri: 'file:///work/one', name: 'one' },
        { uri: 'file:///work/two', name: 'two' }
      ]
    });
    (vscode.workspace as any).workspaceFolders = [];
  });

  it('answers with an empty list rather than an error when no folder is open', async () => {
    const harness = await makeServer();
    (vscode.workspace as any).workspaceFolders = undefined;
    const manager = track(managerFor(harness));
    await manager.startAll();

    expect(await harness.askForRoots()).toEqual({ roots: [] });
    (vscode.workspace as any).workspaceFolders = [];
  });

  it('declares the roots capability so a server may ask at all', async () => {
    const harness = await makeServer();
    const manager = track(managerFor(harness));
    await manager.startAll();

    expect(harness.server.getClientCapabilities()).toEqual(
      expect.objectContaining({ roots: { listChanged: true } })
    );
    // Sampling and elicitation must NOT be offered — a server driving the
    // model would invert the trust model.
    const caps = harness.server.getClientCapabilities() as Record<string, unknown>;
    expect(caps.sampling).toBeUndefined();
    expect(caps.elicitation).toBeUndefined();
  });
});

describe('ListRootsRequestSchema import sanity', () => {
  it('is the schema the manager registers against', () => {
    // Guards against an SDK rename silently disabling the roots handler.
    expect(ListRootsRequestSchema).toBeDefined();
  });
});
