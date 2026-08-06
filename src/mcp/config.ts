/**
 * `moby.mcpServers` — read and validate user-declared MCP server entries.
 *
 * SECURITY (load-bearing, see docs/plans/mcp.md): entries are read from the
 * **global (user) scope only**, never the merged configuration view. The
 * trust model is "the user typed this command into their own settings, so no
 * per-call approval" — that only holds if a workspace can't contribute one.
 * A cloned repo's `.vscode/settings.json` would otherwise be arbitrary code
 * execution on folder-open.
 *
 * Validation mirrors `registerCustomModels`: collect descriptive errors and
 * skip bad entries, never throw.
 */

import * as vscode from 'vscode';

export interface McpServerConfig {
  /** Map key — embeds in tool names, hence the tight pattern. */
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  enabled: boolean;
}

export interface McpConfigLoadResult {
  servers: McpServerConfig[];
  errors: string[];
  /** True when a workspace/folder scope declared servers we deliberately ignored. */
  ignoredNonGlobalScope: boolean;
}

const SERVER_NAME_PATTERN = /^[a-zA-Z0-9-]{1,32}$/;

/**
 * Read the raw global-scope value. Split out so tests can drive validation
 * without a vscode configuration double.
 */
export function readMcpServersSetting(): { raw: unknown; ignoredNonGlobalScope: boolean } {
  const inspected = vscode.workspace.getConfiguration('moby').inspect<unknown>('mcpServers');
  const ignoredNonGlobalScope =
    hasEntries(inspected?.workspaceValue) || hasEntries(inspected?.workspaceFolderValue);
  return { raw: inspected?.globalValue, ignoredNonGlobalScope };
}

function hasEntries(value: unknown): boolean {
  return isPlainObject(value) && Object.keys(value).length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate a raw `moby.mcpServers` object into typed entries. */
export function validateMcpServers(raw: unknown): { servers: McpServerConfig[]; errors: string[] } {
  const servers: McpServerConfig[] = [];
  const errors: string[] = [];

  if (raw === undefined || raw === null) return { servers, errors };
  if (!isPlainObject(raw)) {
    return { servers, errors: ['moby.mcpServers must be an object mapping server names to entries'] };
  }

  for (const [name, value] of Object.entries(raw)) {
    if (!SERVER_NAME_PATTERN.test(name)) {
      errors.push(`"${name}": server name must match [a-zA-Z0-9-] and be 1-32 characters`);
      continue;
    }
    if (!isPlainObject(value)) {
      errors.push(`"${name}": entry must be an object`);
      continue;
    }

    const command = value.command;
    if (typeof command !== 'string' || command.trim() === '') {
      errors.push(`"${name}": "command" is required and must be a non-empty string`);
      continue;
    }

    const args = value.args;
    if (args !== undefined && !(Array.isArray(args) && args.every(a => typeof a === 'string'))) {
      errors.push(`"${name}": "args" must be an array of strings`);
      continue;
    }

    const env = value.env;
    if (
      env !== undefined &&
      !(isPlainObject(env) && Object.values(env).every(v => typeof v === 'string'))
    ) {
      errors.push(`"${name}": "env" must be an object of string values`);
      continue;
    }

    const cwd = value.cwd;
    if (cwd !== undefined && typeof cwd !== 'string') {
      errors.push(`"${name}": "cwd" must be a string`);
      continue;
    }

    const enabled = value.enabled;
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      errors.push(`"${name}": "enabled" must be a boolean`);
      continue;
    }

    servers.push({
      name,
      command,
      args: (args as string[] | undefined) ?? [],
      env: (env as Record<string, string> | undefined) ?? {},
      ...(cwd !== undefined ? { cwd: cwd as string } : {}),
      enabled: enabled !== false
    });
  }

  return { servers, errors };
}

/** Read + validate in one call. Global scope only — see the module note. */
export function loadMcpServers(): McpConfigLoadResult {
  const { raw, ignoredNonGlobalScope } = readMcpServersSetting();
  const { servers, errors } = validateMcpServers(raw);
  return { servers, errors, ignoredNonGlobalScope };
}

/**
 * True when two entries differ in any way that requires a server restart.
 * `enabled` is excluded — the caller starts or stops rather than restarts.
 */
export function serverConfigChanged(a: McpServerConfig, b: McpServerConfig): boolean {
  return (
    a.command !== b.command ||
    a.cwd !== b.cwd ||
    a.args.length !== b.args.length ||
    a.args.some((arg, i) => arg !== b.args[i]) ||
    !envEqual(a.env, b.env)
  );
}

function envEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(k => a[k] === b[k]);
}
