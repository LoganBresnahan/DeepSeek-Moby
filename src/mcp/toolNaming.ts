/**
 * MCP tool-name namespacing and validation.
 *
 * Pure string module — no SDK, no I/O — so the manager consumes it rather
 * than inlining the rules in its cache build.
 *
 * Names are `mcp__<server>__<tool>`. The prefix is the dispatch
 * discriminator: `dispatchToolCall` routes on it before falling through to
 * the native `executeToolCall`, so no native tool can collide by
 * construction.
 */

import { Tool } from '../deepseekClient';

export const MCP_TOOL_PREFIX = 'mcp__';

/** OpenAI-compatible function names: `^[a-zA-Z0-9_-]+$`, max 64 chars. */
export const MAX_TOOL_NAME_LENGTH = 64;
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Server keys embed in tool names, so they carry the tighter rule. */
const SERVER_NAME_PATTERN = /^[a-zA-Z0-9-]{1,32}$/;

/** The subset of an MCP `Tool` we consume. Structural — avoids an SDK import. */
export interface McpToolShape {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export type NamespaceResult =
  | { ok: true; tool: Tool }
  | { ok: false; reason: string };

export function isValidServerName(serverName: string): boolean {
  return SERVER_NAME_PATTERN.test(serverName);
}

/** True for any tool name this module minted — the dispatch discriminator. */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

export function buildToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}__${toolName}`;
}

/**
 * Split a namespaced name back into its parts. Returns null when `name`
 * isn't ours. The tool half may itself contain `__`, so we split only on the
 * first separator after the prefix.
 */
export function parseToolName(name: string): { serverName: string; toolName: string } | null {
  if (!isMcpToolName(name)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const sep = rest.indexOf('__');
  if (sep <= 0) return null;
  const serverName = rest.slice(0, sep);
  const toolName = rest.slice(sep + 2);
  if (!serverName || !toolName) return null;
  return { serverName, toolName };
}

/**
 * Translate one MCP tool into a Moby `Tool`.
 *
 * MCP's `inputSchema` and our `parameters` are the same JSON-Schema object
 * shape, so it passes through untouched. An over-long or non-conforming name
 * is **skipped, never truncated** — truncation risks two tools colliding,
 * and a collision mis-routes a call.
 */
export function namespaceTool(serverName: string, tool: McpToolShape): NamespaceResult {
  if (!isValidServerName(serverName)) {
    return { ok: false, reason: `server name "${serverName}" is not [a-zA-Z0-9-]{1,32}` };
  }
  if (!tool.name) {
    return { ok: false, reason: 'tool has no name' };
  }

  const name = buildToolName(serverName, tool.name);
  if (name.length > MAX_TOOL_NAME_LENGTH) {
    return {
      ok: false,
      reason: `name "${name}" is ${name.length} chars (max ${MAX_TOOL_NAME_LENGTH})`
    };
  }
  if (!TOOL_NAME_PATTERN.test(name)) {
    return { ok: false, reason: `name "${name}" contains characters outside [a-zA-Z0-9_-]` };
  }

  // MCP `inputSchema` and our `parameters` are the same JSON-Schema object
  // shape. The WHOLE schema passes through — sibling keys like `$defs` are
  // load-bearing (FastMCP/pydantic servers emit `$ref`s into them; dropping
  // them would send the model unresolvable references and break every call
  // to the tool). We only pin `type`/`properties` and drop a malformed
  // `required`, since those three are the keys our own code relies on.
  const raw = tool.inputSchema;
  const schema: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? { ...raw } : {};
  schema.type = 'object';
  if (typeof schema.properties !== 'object' || schema.properties === null || Array.isArray(schema.properties)) {
    schema.properties = {};
  }
  if (schema.required !== undefined && !Array.isArray(schema.required)) {
    delete schema.required;
  }

  return {
    ok: true,
    tool: {
      type: 'function',
      function: {
        name,
        description: tool.description ?? '',
        parameters: schema as Tool['function']['parameters']
      }
    }
  };
}

/**
 * Namespace a server's whole tool list. Rejects are returned rather than
 * thrown so the caller logs each skipped tool by name — a silently missing
 * tool is the failure mode worth avoiding.
 */
export function namespaceTools(
  serverName: string,
  tools: McpToolShape[]
): { tools: Tool[]; skipped: Array<{ name: string; reason: string }> } {
  const accepted: Tool[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const tool of tools) {
    const result = namespaceTool(serverName, tool);
    if (result.ok) {
      accepted.push(result.tool);
    } else {
      skipped.push({ name: tool.name ?? '<unnamed>', reason: result.reason });
    }
  }

  return { tools: accepted, skipped };
}
