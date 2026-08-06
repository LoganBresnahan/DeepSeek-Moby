/**
 * Translate an MCP `tools/call` result into the tool-result string the
 * request loop expects.
 *
 * Pure module — treats the SDK result as `unknown` and checks structurally,
 * so a misbehaving server (or an SDK type change) degrades to a named error
 * instead of a crash.
 *
 * Conventions this must uphold (docs/plans/mcp.md § Dispatch):
 *  - `isError: true` → a string starting with `Error:` — the orchestrator's
 *    `result.startsWith('Error:')` checks are the only failure signal.
 *  - Non-text content becomes a NAMED placeholder, never silence.
 *  - Zero content is also named, never an empty string.
 */

interface ContentBlockLike {
  type?: unknown;
  text?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param displayName the namespaced tool name, for the no-content marker
 * @param result      the raw value resolved from `client.callTool()`
 */
export function translateCallResult(displayName: string, result: unknown): string {
  if (!isPlainObject(result)) {
    return `Error: MCP tool ${displayName} returned a malformed result`;
  }

  const blocks: unknown[] = Array.isArray(result.content) ? result.content : [];
  const parts: string[] = [];
  for (const raw of blocks) {
    const block = (isPlainObject(raw) ? raw : {}) as ContentBlockLike;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else {
      const kind = typeof block.type === 'string' && block.type ? block.type : 'unknown';
      parts.push(`[MCP tool returned ${kind} content — not supported yet]`);
    }
  }
  let text = parts.join('\n\n');

  if (result.isError === true) {
    return `Error: ${text || `MCP tool ${displayName} reported an error with no message`}`;
  }

  // Tools with an outputSchema may return only structuredContent; the spec
  // says they SHOULD also serialize it into a text block, but don't rely on it.
  if (!text && isPlainObject(result.structuredContent)) {
    try {
      text = JSON.stringify(result.structuredContent, null, 2);
    } catch {
      return `Error: MCP tool ${displayName} returned unserializable structured content`;
    }
  }

  return text || `(MCP tool ${displayName} returned no content)`;
}
