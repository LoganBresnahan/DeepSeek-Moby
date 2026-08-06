import { describe, it, expect } from 'vitest';
import {
  MCP_TOOL_PREFIX,
  MAX_TOOL_NAME_LENGTH,
  isMcpToolName,
  isValidServerName,
  buildToolName,
  parseToolName,
  namespaceTool,
  namespaceTools
} from '../../../src/mcp/toolNaming';

describe('server name validation', () => {
  it('accepts alphanumerics and hyphens up to 32 chars', () => {
    expect(isValidServerName('pharos')).toBe(true);
    expect(isValidServerName('my-server-2')).toBe(true);
    expect(isValidServerName('a'.repeat(32))).toBe(true);
  });

  it('rejects empty, over-long, and separator-bearing names', () => {
    expect(isValidServerName('')).toBe(false);
    expect(isValidServerName('a'.repeat(33))).toBe(false);
    // Underscores would make the mcp__server__tool split ambiguous.
    expect(isValidServerName('my_server')).toBe(false);
    expect(isValidServerName('has space')).toBe(false);
    expect(isValidServerName('dot.name')).toBe(false);
  });
});

describe('name construction and parsing', () => {
  it('round-trips a simple name', () => {
    const name = buildToolName('pharos', 'hover');
    expect(name).toBe('mcp__pharos__hover');
    expect(parseToolName(name)).toEqual({ serverName: 'pharos', toolName: 'hover' });
  });

  it('round-trips a tool whose own name contains the separator', () => {
    // Server names can't contain `__`, so splitting on the FIRST one after
    // the prefix is unambiguous even when the tool name has more.
    const name = buildToolName('pharos', 'runtime__deep__probe');
    expect(parseToolName(name)).toEqual({ serverName: 'pharos', toolName: 'runtime__deep__probe' });
  });

  it('identifies MCP names and rejects native ones', () => {
    expect(isMcpToolName('mcp__pharos__hover')).toBe(true);
    expect(isMcpToolName('read')).toBe(false);
    expect(isMcpToolName('web_search')).toBe(false);
    // No native tool starts with the prefix — collisions are impossible.
    expect(MCP_TOOL_PREFIX).toBe('mcp__');
  });

  it('returns null for names that are not ours or are malformed', () => {
    expect(parseToolName('read')).toBeNull();
    expect(parseToolName('mcp__')).toBeNull();
    expect(parseToolName('mcp__pharos')).toBeNull();
    expect(parseToolName('mcp____hover')).toBeNull();
    expect(parseToolName('mcp__pharos__')).toBeNull();
  });
});

describe('namespaceTool', () => {
  it('passes inputSchema through as parameters untouched', () => {
    const result = namespaceTool('pharos', {
      name: 'hover',
      description: 'Hover info',
      inputSchema: {
        type: 'object',
        properties: { uri: { type: 'string' }, line: { type: 'number' } },
        required: ['uri']
      }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tool.function.name).toBe('mcp__pharos__hover');
    expect(result.tool.function.description).toBe('Hover info');
    expect(result.tool.function.parameters.properties).toEqual({
      uri: { type: 'string' },
      line: { type: 'number' }
    });
    expect(result.tool.function.parameters.required).toEqual(['uri']);
    expect(result.tool.type).toBe('function');
  });

  it('tolerates a missing description and a missing/empty schema', () => {
    const result = namespaceTool('pharos', { name: 'ping' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tool.function.description).toBe('');
    expect(result.tool.function.parameters).toEqual({ type: 'object', properties: {} });
    expect('required' in result.tool.function.parameters).toBe(false);
  });

  it('skips — never truncates — an over-long name', () => {
    const longTool = 'x'.repeat(60);
    const result = namespaceTool('pharos', { name: longTool });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('max 64');
    // Truncation would risk two tools colliding, which mis-routes a call.
    expect(buildToolName('pharos', longTool).length).toBeGreaterThan(MAX_TOOL_NAME_LENGTH);
  });

  it('accepts a name exactly at the limit', () => {
    const server = 'srv';
    // mcp__ (5) + srv (3) + __ (2) = 10 chars of prefix.
    const toolName = 'y'.repeat(MAX_TOOL_NAME_LENGTH - 10);
    const result = namespaceTool(server, { name: toolName });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tool.function.name.length).toBe(MAX_TOOL_NAME_LENGTH);
  });

  it('rejects tool names with characters the API forbids', () => {
    for (const bad of ['has space', 'dot.name', 'slash/name', 'colon:name']) {
      const result = namespaceTool('pharos', { name: bad });
      expect(result.ok).toBe(false);
    }
  });

  it('rejects an invalid server name and an unnamed tool', () => {
    expect(namespaceTool('bad server', { name: 'hover' }).ok).toBe(false);
    expect(namespaceTool('pharos', { name: '' }).ok).toBe(false);
  });
});

describe('namespaceTools', () => {
  it('accepts the good and reports every skip by name', () => {
    const { tools, skipped } = namespaceTools('pharos', [
      { name: 'hover' },
      { name: 'z'.repeat(80) },
      { name: 'find_references' },
      { name: 'bad name' }
    ]);
    expect(tools.map(t => t.function.name)).toEqual([
      'mcp__pharos__hover',
      'mcp__pharos__find_references'
    ]);
    expect(skipped).toHaveLength(2);
    // A silently missing tool is the failure mode worth avoiding — each
    // skip must name itself so it can be logged.
    expect(skipped[0].name).toBe('z'.repeat(80));
    expect(skipped[1].name).toBe('bad name');
    expect(skipped.every(s => s.reason.length > 0)).toBe(true);
  });

  it('returns empty structures for an empty list', () => {
    expect(namespaceTools('pharos', [])).toEqual({ tools: [], skipped: [] });
  });

  it('produces distinct names across servers offering the same tool', () => {
    const a = namespaceTools('alpha', [{ name: 'hover' }]).tools[0].function.name;
    const b = namespaceTools('beta', [{ name: 'hover' }]).tools[0].function.name;
    expect(a).not.toBe(b);
  });
});
