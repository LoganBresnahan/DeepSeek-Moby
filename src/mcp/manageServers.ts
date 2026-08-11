/**
 * `moby.manageMcpServers` — see what every configured MCP server is doing,
 * and turn servers on or off.
 *
 * Why this exists (ADR 0016 decision 14): MCP failure is silent. A dead
 * server's tools simply leave the request array, so Moby gets quieter and
 * worse at things it managed an hour ago, with nothing surfaced anywhere the
 * user looks. And the only status surface we shipped, `refreshMcpServers`,
 * *restarts every server* in order to report on them — a diagnostic that
 * perturbs what it measures.
 *
 * Toggling writes `enabled` to settings rather than flipping runtime state,
 * so the manager keeps exactly one source of truth and its existing
 * config-change reconciliation does the starting and stopping.
 */

import * as vscode from 'vscode';

import { logger } from '../utils/logger';
import { loadMcpServers, McpServerConfig, setMcpServersEnabled } from './config';
import { McpServerStatusEntry } from './McpServerManager';

/** The QuickPick row shape, minus VS Code's own fields, so it can be built
 *  and asserted without a window. */
export interface ServerPickItem {
  label: string;
  description: string;
  detail?: string;
  picked: boolean;
}

/**
 * One row per **configured** server, not per running one — a disabled server
 * must still appear or there is no way to switch it back on.
 */
export function buildServerPickItems(
  configured: McpServerConfig[],
  status: McpServerStatusEntry[]
): ServerPickItem[] {
  const byName = new Map(status.map(s => [s.name, s]));
  return configured.map(cfg => {
    const live = byName.get(cfg.name);
    const commandLine = [cfg.command, ...cfg.args].join(' ');
    return {
      label: cfg.name,
      description: describeStatus(cfg, live),
      detail: live?.status === 'failed' && live.lastError
        ? `${commandLine} — ${live.lastError}`
        : commandLine,
      picked: cfg.enabled
    };
  });
}

function describeStatus(cfg: McpServerConfig, live: McpServerStatusEntry | undefined): string {
  if (!cfg.enabled) return 'disabled';
  if (!live) return 'not started';
  switch (live.status) {
    case 'ready': {
      const version = live.serverInfo ? ` (${live.serverInfo.name} ${live.serverInfo.version})` : '';
      return `ready · ${live.toolCount} tool${live.toolCount === 1 ? '' : 's'}${version}`;
    }
    case 'starting':
      return 'starting…';
    case 'failed':
      return live.lastError ? `failed — ${live.lastError}` : 'failed';
    case 'stopped':
      return 'stopped';
  }
}

/**
 * Diff the user's checked set against what settings currently say. Returns
 * only genuine changes, so an unchanged confirmation writes nothing (and
 * therefore triggers no reconcile, and no needless respawn).
 */
export function diffEnabled(
  configured: McpServerConfig[],
  checkedNames: Set<string>
): Map<string, boolean> {
  const changes = new Map<string, boolean>();
  for (const cfg of configured) {
    const next = checkedNames.has(cfg.name);
    if (next !== cfg.enabled) changes.set(cfg.name, next);
  }
  return changes;
}

/** Command handler. Cancelling the picker writes nothing. */
export async function manageMcpServers(
  getStatus: () => McpServerStatusEntry[]
): Promise<void> {
  const { servers, errors } = loadMcpServers();

  if (servers.length === 0) {
    const hint = errors.length > 0
      ? `Moby: no usable MCP servers — ${errors.length} entr${errors.length === 1 ? 'y was' : 'ies were'} rejected. See the Moby log.`
      : 'Moby: no MCP servers configured. Add them under "moby.mcpServers" in your user settings.';
    vscode.window.showInformationMessage(hint);
    return;
  }

  const items = buildServerPickItems(servers, getStatus());
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'Moby: MCP Servers',
    placeHolder: 'Checked servers are enabled. Uncheck to stop one, check to start it.'
  });
  if (!picked) return; // cancelled — deliberately not "uncheck everything"

  const changes = diffEnabled(servers, new Set(picked.map(p => p.label)));
  if (changes.size === 0) return;

  // Writing settings is the whole action: the config-change listener
  // reconciles, which starts and stops the affected children.
  await setMcpServersEnabled(changes);

  const enabled = [...changes.entries()].filter(([, on]) => on).map(([n]) => n);
  const disabled = [...changes.entries()].filter(([, on]) => !on).map(([n]) => n);
  const parts: string[] = [];
  if (enabled.length) parts.push(`enabled ${enabled.join(', ')}`);
  if (disabled.length) parts.push(`disabled ${disabled.join(', ')}`);
  logger.info(`[MCP] manage: ${parts.join('; ')}`);
  vscode.window.showInformationMessage(`Moby MCP servers — ${parts.join('; ')}.`);
}
