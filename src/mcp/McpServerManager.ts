/**
 * MCP server lifecycle + tool cache.
 *
 * Mirrors `LspAvailability`: every request-path read
 * (`getToolsForRequest()`) is synchronous against an in-memory cache; all
 * I/O happens at warmup, on a `tools/list_changed` notification, or at
 * dispatch time. A server that hasn't finished its handshake simply
 * contributes no tools to that request — the next request picks it up.
 *
 * Trust model (docs/plans/mcp.md): servers come from user-scope settings
 * only, so calls run without per-call approval. Sampling and elicitation
 * are declined by declaring no such capabilities.
 *
 * Disposal rides `context.subscriptions` in extension.ts — NOT
 * chatProvider teardown, which `deactivate()` never runs.
 */

import * as vscode from 'vscode';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment
} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  ListRootsRequestSchema,
  ToolListChangedNotificationSchema
} from '@modelcontextprotocol/sdk/types.js';

import { Tool } from '../deepseekClient';
import { logger } from '../utils/logger';
import { loadMcpServers, McpServerConfig, serverConfigChanged } from './config';
import { translateCallResult } from './callResult';
import { parseToolName, namespaceTools, McpToolShape } from './toolNaming';

export type McpServerStatus = 'starting' | 'ready' | 'failed' | 'stopped';

export interface McpServerStatusEntry {
  name: string;
  status: McpServerStatus;
  toolCount: number;
  serverInfo?: { name: string; version: string };
  lastError?: string;
}

interface ManagedServer {
  config: McpServerConfig;
  status: McpServerStatus;
  client: Client | null;
  /** Held from spawn so dispose() can kill a child whose handshake hasn't
   *  finished — `client` is only published post-handshake. */
  transport: StdioClientTransport | null;
  /** Already namespaced + validated — concat-ready for the request array. */
  tools: Tool[];
  instructions?: string;
  serverInfo?: { name: string; version: string };
  lastError?: string;
  /** Bumped on every (re)start and on stop/dispose. Async work captures the
   *  value at launch and discards its result if the entry has moved on —
   *  the guard against a handshake or re-list landing on a dead server. */
  generation: number;
  /** True once a handshake has ever succeeded. Separates "this command is
   *  wrong" (never true — retrying can't fix it) from "a working server
   *  died" (worth restarting). */
  everReady: boolean;
  /** Consecutive restarts since the last *stable* ready. Reset only after
   *  STABLE_MS uptime, so a server that handshakes then immediately exits
   *  cannot reset its own budget and restart forever. */
  restartAttempts: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  /** Unix-ms of the last transition to `ready`. */
  readyAt: number;
}

/** Same idea as LspAvailability's warmup: don't compete with activation. */
const WARMUP_DELAY_MS = 3000;
/** Per tools/call request. MCP tools are LSP-or-network-shaped, not
 *  shell-shaped; a hung server must not hold a turn for the SDK's 60s. */
const CALL_TIMEOUT_MS = 30_000;
/** Initialize + tools/list at startup get the same bound. */
const HANDSHAKE_TIMEOUT_MS = 30_000;
/** tools/list pagination backstop — no sane server has 16 pages. */
const MAX_TOOL_PAGES = 16;
/** A runaway result would blow the context long before the budget soft stop
 *  sees it next iteration. Truncation is named, mirroring ADR 0014's cap. */
const MAX_RESULT_CHARS = 100_000;
/** Restarts after a post-handshake crash, then stay `failed` until a config
 *  change or `moby.refreshMcpServers`. */
const MAX_RESTART_ATTEMPTS = 2;
/** Backoff per attempt, indexed by attempt-1. */
const RESTART_BACKOFF_MS = [2_000, 10_000];
/** Uptime a server must clear before its restart budget resets. Without
 *  this, a handshake-then-exit crash loop resets the counter every cycle
 *  and restarts forever. */
const STABLE_UPTIME_MS = 60_000;
/** Per-server cap on the instructions text injected into the system prompt —
 *  server-authored text, so a verbose server must not flood the prompt. */
const MAX_INSTRUCTIONS_CHARS = 2_000;

/**
 * Neutralize section delimiters in server-authored instructions.
 *
 * The trust decision is "the user chose to install this binary" — that is
 * NOT the same as "this binary's runtime output is trusted prompt material".
 * A server whose instructions contain `--- END MCP SERVERS ---` could close
 * our block early and have everything after it read as a first-class Moby
 * prompt section (a forged **Code Edit Format**, a forged tool rule). The
 * prompt uses `--- X ---` lines throughout, so any such line is defanged.
 */
function sanitizeInstructions(text: string | undefined): string {
  if (!text) return '';
  return text
    .split('\n')
    .map(line => (/^\s*-{3,}.*-{3,}\s*$/.test(line) ? line.replace(/-/g, '‑') : line))
    .join('\n')
    .trim();
}

export class McpServerManager {
  private static instance: McpServerManager | undefined;

  private servers = new Map<string, ManagedServer>();
  private warmupTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private disposed = false;
  private clientVersion = '0.0.0';
  /** Injectable so the slow-tool spec doesn't inherit a 30s sleep. */
  private callTimeoutMs = CALL_TIMEOUT_MS;
  /** Per-server chains serializing EVERY tools/list — the startup list and
   *  list_changed re-lists share one lane, so a notification arriving
   *  mid-startup can't have its fresh result overwritten by the slower
   *  startup response (same generation, so the gen guard can't catch it). */
  private refreshChains = new Map<string, Promise<void>>();

  private constructor() {}

  static getInstance(): McpServerManager {
    if (!McpServerManager.instance) McpServerManager.instance = new McpServerManager();
    return McpServerManager.instance;
  }

  /**
   * Schedule spawning all configured servers after a short delay.
   * Idempotent. Config is read at fire time, not schedule time.
   */
  warmUp(clientVersion?: string): void {
    if (clientVersion) this.clientVersion = clientVersion;
    if (this.warmupTimer || this.started || this.disposed) return;
    this.warmupTimer = setTimeout(() => {
      this.warmupTimer = null;
      void this.startAll();
    }, WARMUP_DELAY_MS);
  }

  /** Spawn every enabled configured server. Idempotent per manager lifetime. */
  async startAll(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    const { servers } = loadMcpServers();
    const enabled = servers.filter(s => s.enabled);
    if (enabled.length === 0) return;
    logger.info(`[MCP] Starting ${enabled.length} server(s): ${enabled.map(s => s.name).join(', ')}`);
    await Promise.all(enabled.map(config => this.startServer(this.createEntry(config))));
  }

  /**
   * Apply a `moby.mcpServers` edit to the running set: stop removed and
   * newly-disabled servers, start added and newly-enabled ones, restart
   * those whose spawn inputs changed. A changed entry gets a fresh restart
   * budget — the edit is the user saying "try again".
   */
  async reconcile(): Promise<void> {
    if (this.disposed) return;
    // A reconcile before warmup fired IS the start — otherwise the warmup
    // timer would later run startAll() against servers already running.
    this.started = true;

    const { servers } = loadMcpServers();
    const desired = new Map(servers.filter(s => s.enabled).map(s => [s.name, s]));
    const work: Array<Promise<void>> = [];

    for (const [name, entry] of [...this.servers.entries()]) {
      const next = desired.get(name);
      if (!next) {
        logger.info(`[MCP] ${name}: removed from settings — stopping`);
        work.push(this.stopServer(entry));
        this.servers.delete(name);
        this.refreshChains.delete(name);
        continue;
      }
      if (serverConfigChanged(entry.config, next)) {
        logger.info(`[MCP] ${name}: settings changed — restarting`);
        const stopped = this.stopServer(entry);
        this.refreshChains.delete(name);
        // The replacement is registered synchronously so the map stays
        // authoritative for any reconcile that lands while the old child is
        // still shutting down — but it doesn't SPAWN until that child is
        // actually gone (see stopServer).
        const replacement = this.createEntry(next);
        work.push(
          stopped.then(() => {
            if (this.disposed) return;
            if (this.servers.get(name) !== replacement) return;
            return this.startServer(replacement);
          })
        );
      }
      desired.delete(name);
    }

    for (const config of desired.values()) {
      logger.info(`[MCP] ${config.name}: added in settings — starting`);
      work.push(this.startServer(this.createEntry(config)));
    }

    await Promise.all(work);
  }

  /**
   * Manual escape hatch (`moby.refreshMcpServers`): tear everything down and
   * start clean from current settings. This is what clears a server that
   * exhausted its restart budget or died on a bad command the user has since
   * fixed outside VS Code (installed the binary, fixed PATH).
   */
  async restartAll(): Promise<void> {
    if (this.disposed) return;
    // Wait for the children to actually exit before respawning — otherwise
    // the escape hatch re-breaks exactly the single-instance servers it
    // exists to rescue (see stopServer).
    const stops = [...this.servers.values()].map(entry => this.stopServer(entry));
    this.servers.clear();
    this.refreshChains.clear();
    await Promise.all(stops);
    if (this.disposed) return;
    this.started = false;
    await this.startAll();
  }

  /** Synchronous read for the request hot path — ready servers only. */
  getToolsForRequest(): Tool[] {
    const tools: Tool[] = [];
    for (const entry of this.servers.values()) {
      if (entry.status === 'ready') tools.push(...entry.tools);
    }
    return tools;
  }

  /**
   * Dispatch target for `mcp__<server>__<tool>` calls. Always resolves to a
   * string; failures conform to the `Error:` prefix convention the
   * orchestrator's three `startsWith` checks depend on.
   */
  async executeTool(namespacedName: string, argsJson: string, signal: AbortSignal): Promise<string> {
    const parsed = parseToolName(namespacedName);
    if (!parsed) {
      return `Error: "${namespacedName}" is not a valid MCP tool name`;
    }
    const entry = this.servers.get(parsed.serverName);
    if (!entry || entry.status !== 'ready' || !entry.client) {
      return `Error: MCP server "${parsed.serverName}" is not connected`;
    }

    let args: Record<string, unknown>;
    try {
      const rawArgs: unknown = argsJson.trim() ? JSON.parse(argsJson) : {};
      if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) {
        return `Error: arguments for ${namespacedName} must be a JSON object`;
      }
      args = rawArgs as Record<string, unknown>;
    } catch {
      return `Error: invalid JSON arguments for ${namespacedName}`;
    }

    try {
      const result = await entry.client.callTool(
        { name: parsed.toolName, arguments: args },
        undefined,
        { signal, timeout: this.callTimeoutMs }
      );
      const text = translateCallResult(namespacedName, result);
      if (text.length > MAX_RESULT_CHARS) {
        return (
          text.slice(0, MAX_RESULT_CHARS) +
          `\n\n[MCP result truncated at ${MAX_RESULT_CHARS.toLocaleString()} chars — full length ${text.length.toLocaleString()}]`
        );
      }
      return text;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const reason = signal.aborted ? 'call aborted' : msg;
      return `Error: MCP server "${parsed.serverName}" — ${reason}`;
    }
  }

  /** For the status/refresh command (Phase 3) and tests. */
  getStatus(): McpServerStatusEntry[] {
    return [...this.servers.values()].map(entry => ({
      name: entry.config.name,
      status: entry.status,
      toolCount: entry.tools.length,
      ...(entry.serverInfo ? { serverInfo: entry.serverInfo } : {}),
      ...(entry.lastError ? { lastError: entry.lastError } : {})
    }));
  }

  /** Captured at handshake. */
  getInstructions(serverName: string): string | undefined {
    return this.servers.get(serverName)?.instructions;
  }

  /**
   * The `--- MCP SERVERS ---` system-prompt block. Sync, and returns `''`
   * when no server is ready — zero servers must cost zero prompt bytes,
   * same rule as `renderLspDeclaration`.
   *
   * Instructions are server-authored text injected verbatim (acceptable
   * under the user-scope trust model) but capped per server.
   */
  getInstructionsBlock(): string {
    const ready = [...this.servers.values()].filter(e => e.status === 'ready');
    if (ready.length === 0) return '';

    const roster = ready
      .map(e => `${e.config.name} (${e.tools.length} tool${e.tools.length === 1 ? '' : 's'})`)
      .join(', ');
    let block = `\n--- MCP SERVERS ---\nConnected: ${roster}. Their tools are named mcp__<server>__<tool>.\n`;

    for (const entry of ready) {
      const text = sanitizeInstructions(entry.instructions);
      if (!text) continue;
      const capped =
        text.length > MAX_INSTRUCTIONS_CHARS
          ? text.slice(0, MAX_INSTRUCTIONS_CHARS) + '… [truncated]'
          : text;
      block += `\n${entry.config.name}: ${capped}\n`;
    }

    return block + '--- END MCP SERVERS ---\n';
  }

  /**
   * Tell every ready server the workspace-folder set changed. Wired to
   * `onDidChangeWorkspaceFolders` in extension.ts.
   */
  notifyRootsChanged(): void {
    for (const entry of this.servers.values()) {
      if (entry.status !== 'ready' || !entry.client) continue;
      entry.client.sendRootsListChanged().catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        logger.debug(`[MCP] ${entry.config.name}: roots/list_changed notify failed — ${msg}`);
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.warmupTimer) {
      clearTimeout(this.warmupTimer);
      this.warmupTimer = null;
    }
    // Fire-and-forget here on purpose: nothing respawns after disposal, and
    // blocking deactivate() on a 4s graceful close would stall window close.
    for (const entry of this.servers.values()) void this.stopServer(entry);
  }

  // ── private ─────────────────────────────────────────────────────────

  private createEntry(config: McpServerConfig): ManagedServer {
    const entry: ManagedServer = {
      config,
      status: 'starting',
      client: null,
      transport: null,
      tools: [],
      generation: 0,
      everReady: false,
      restartAttempts: 0,
      restartTimer: null,
      readyAt: 0
    };
    this.servers.set(config.name, entry);
    return entry;
  }

  /**
   * Tear one server down. Bumping the generation first is what makes every
   * in-flight await (handshake, tools/list) and any pending restart timer
   * discard itself instead of resurrecting a server the user removed.
   *
   * Returns the close promise, and **callers that respawn must await it**.
   * The SDK closes gracefully — `stdin.end()`, 2s, SIGTERM, 2s, SIGKILL — so
   * the child can still be alive for up to 4s. Respawning inside that window
   * runs two copies at once, and a server holding an exclusive resource (a
   * port, a lockfile) fails to start; because that failure happens before a
   * handshake, the restart policy correctly refuses to retry it and the
   * server stays dead until the next config edit.
   */
  private stopServer(entry: ManagedServer): Promise<void> {
    entry.generation++;
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = null;
    }
    const client = entry.client;
    const transport = entry.transport;
    entry.status = 'stopped';
    entry.tools = [];
    entry.client = null;
    entry.transport = null;
    // A server still mid-handshake has no client yet — close its transport.
    if (client) return client.close().catch(() => {});
    if (transport) return transport.close().catch(() => {});
    return Promise.resolve();
  }

  /**
   * Restart policy after a connection drops. Two rules earn their keep:
   *  - A server that never handshaked is not restarted at all. `spawn
   *    ENOENT` on a typo'd command would otherwise retry forever without
   *    ever being able to succeed.
   *  - The restart budget only resets after STABLE_UPTIME_MS of ready, so a
   *    server that handshakes then exits immediately still exhausts it.
   */
  private scheduleRestart(entry: ManagedServer): void {
    if (this.disposed) return;
    const name = entry.config.name;

    if (!entry.everReady) {
      logger.warn(`[MCP] ${name}: died before completing a handshake — not restarting`);
      return;
    }
    if (entry.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      logger.warn(
        `[MCP] ${name}: exhausted ${MAX_RESTART_ATTEMPTS} restart attempts — staying down ` +
        `until settings change or "Moby: Refresh MCP Servers"`
      );
      return;
    }

    const attempt = ++entry.restartAttempts;
    const delay = RESTART_BACKOFF_MS[attempt - 1] ?? RESTART_BACKOFF_MS[RESTART_BACKOFF_MS.length - 1];
    const gen = entry.generation;
    logger.info(`[MCP] ${name}: restart ${attempt}/${MAX_RESTART_ATTEMPTS} in ${delay}ms`);

    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = null;
      // Every guard here is a way the server could have legitimately gone
      // away while the timer was pending — disposal, a settings edit that
      // removed or replaced it, or a manual refresh.
      if (this.disposed) return;
      if (this.servers.get(name) !== entry) return;
      if (entry.generation !== gen) return;
      if (entry.status !== 'failed') return;
      entry.status = 'starting';
      void this.startServer(entry);
    }, delay);
  }

  private async startServer(entry: ManagedServer): Promise<void> {
    const gen = ++entry.generation;
    const cfg = entry.config;
    let client: Client | null = null;
    try {
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args,
        // Merge over the SDK's safe default set (HOME, PATH, …) — passing
        // `env` alone would REPLACE it and break most commands.
        env: { ...getDefaultEnvironment(), ...cfg.env },
        ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
        stderr: 'pipe'
      });
      transport.stderr?.on('data', (chunk: Buffer) => {
        const line = chunk.toString('utf8').trim();
        if (line) logger.debug(`[MCP] ${cfg.name} stderr: ${line.slice(0, 500)}`);
      });
      entry.transport = transport;

      client = new Client(
        { name: 'deepseek-moby', version: this.clientVersion },
        // Sampling + elicitation are declined by omission — a server must
        // not be able to drive the model. Roots is declared together with
        // its handler below; declaring it without one would answer
        // roots/list with a method-not-found.
        { capabilities: { roots: { listChanged: true } } }
      );
      client.setRequestHandler(ListRootsRequestSchema, () => ({
        roots: (vscode.workspace.workspaceFolders ?? []).map(f => ({
          uri: f.uri.toString(),
          name: f.name
        }))
      }));
      client.onerror = (err: Error) => {
        if (gen !== entry.generation) return;
        logger.warn(`[MCP] ${cfg.name}: transport error — ${err.message}`);
      };
      client.onclose = () => {
        if (gen !== entry.generation) return;
        if (entry.status === 'failed' || entry.status === 'stopped') return;
        const wasReady = entry.status === 'ready';
        // A server that stayed up long enough to be useful gets its restart
        // budget back; a handshake-then-exit loop does not.
        if (wasReady && entry.readyAt > 0 && Date.now() - entry.readyAt >= STABLE_UPTIME_MS) {
          entry.restartAttempts = 0;
        }
        entry.status = 'failed';
        entry.tools = [];
        entry.client = null;
        entry.transport = null;
        entry.lastError = 'connection closed';
        logger.warn(
          `[MCP] ${cfg.name}: connection closed` +
          (wasReady ? ' — its tools are removed from the request array' : '')
        );
        this.scheduleRestart(entry);
      };

      await client.connect(transport, { timeout: HANDSHAKE_TIMEOUT_MS });
      if (gen !== entry.generation) {
        void client.close().catch(() => {});
        return;
      }
      // Visible before 'ready' so a list_changed arriving mid-startup can
      // still queue a refresh instead of being dropped.
      entry.client = client;
      // The handshake HAS succeeded now — set this before the startup
      // tools/list, or a server that dies during that list is misfiled as
      // "never handshaked" and never retried, with a log line saying so.
      entry.everReady = true;
      entry.instructions = client.getInstructions();
      const info = client.getServerVersion();
      entry.serverInfo = info
        ? { name: String(info.name), version: String(info.version ?? '') }
        : undefined;

      const caps = client.getServerCapabilities();
      if (caps?.tools) {
        if (caps.tools.listChanged) {
          client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
            // Same generation guard as onerror/onclose. A closing child keeps
            // its stdout listener attached for the whole graceful-close
            // window, so without this a notification from a server we already
            // stopped would drive a refresh on its by-name replacement.
            if (gen !== entry.generation) return;
            this.queueToolRefresh(cfg.name);
          });
        }
        // The startup list heads this server's refresh chain, so a
        // list_changed arriving mid-startup queues BEHIND it instead of
        // racing it. Errors still bubble to the catch below → 'failed'.
        const startupList = this.refreshTools(entry, client, gen);
        this.refreshChains.set(cfg.name, startupList.then(() => undefined, () => undefined));
        await startupList;
        if (gen !== entry.generation) {
          void client.close().catch(() => {});
          return;
        }
      } else {
        logger.info(`[MCP] ${cfg.name}: server declares no tools capability`);
      }

      entry.status = 'ready';
      entry.readyAt = Date.now();
      logger.info(
        `[MCP] ${cfg.name}: ready — ` +
        `${entry.serverInfo ? `${entry.serverInfo.name} ${entry.serverInfo.version}` : 'unknown server'}, ` +
        `${entry.tools.length} tool(s)` +
        (entry.instructions ? ', instructions declared' : '')
      );
    } catch (e) {
      if (client) void client.close().catch(() => {});
      else if (entry.transport) void entry.transport.close().catch(() => {});
      if (gen !== entry.generation) return;
      const msg = e instanceof Error ? e.message : String(e);
      entry.status = 'failed';
      entry.tools = [];
      entry.client = null;
      entry.transport = null;
      entry.lastError = msg;
      logger.warn(`[MCP] ${cfg.name}: failed to start — ${msg}`);
    }
  }

  /** Full tools/list → namespace → replace this server's slice atomically. */
  private async refreshTools(entry: ManagedServer, client: Client, gen: number): Promise<void> {
    const collected: McpToolShape[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, {
        timeout: this.callTimeoutMs
      });
      if (gen !== entry.generation) return;
      collected.push(...(page.tools as unknown as McpToolShape[]));
      cursor = page.nextCursor;
    } while (cursor && ++pages < MAX_TOOL_PAGES);

    const { tools, skipped } = namespaceTools(entry.config.name, collected);
    for (const s of skipped) {
      logger.warn(`[MCP] ${entry.config.name}: skipped tool "${s.name}" — ${s.reason}`);
    }
    entry.tools = tools;
  }

  private queueToolRefresh(serverName: string): void {
    const prev = this.refreshChains.get(serverName) ?? Promise.resolve();
    const next = prev.then(async () => {
      const entry = this.servers.get(serverName);
      if (!entry || !entry.client) return;
      if (entry.status !== 'ready' && entry.status !== 'starting') return;
      const gen = entry.generation;
      try {
        await this.refreshTools(entry, entry.client, gen);
        if (gen === entry.generation) {
          logger.info(`[MCP] ${serverName}: tool list refreshed — ${entry.tools.length} tool(s)`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn(`[MCP] ${serverName}: tools/list refresh failed — ${msg}`);
      }
    });
    this.refreshChains.set(serverName, next);
  }
}
