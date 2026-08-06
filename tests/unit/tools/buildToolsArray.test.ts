import { describe, it, expect } from 'vitest';
import { buildToolsArray } from '../../../src/tools/buildToolsArray';
import { lspTools } from '../../../src/tools/lspTools';
import { Tool } from '../../../src/deepseekClient';

const NATIVE = { shellProtocol: 'native-tool', lspTools: true } as const;
const XML_SHELL = { shellProtocol: 'xml-shell', lspTools: false } as const;

const names = (tools: Tool[]) => tools.map(t => t.function.name);

describe('buildToolsArray', () => {
  it('always includes the workspace + file tools', () => {
    const got = names(buildToolsArray({ caps: XML_SHELL, webSearchAuto: false, lspAvailable: false }));
    for (const name of ['read_file', 'find_files', 'grep', 'list_directory', 'file_metadata', 'edit_file', 'write_file', 'delete_file', 'delete_directory']) {
      expect(got).toContain(name);
    }
  });

  it('includes run_shell only for native-tool shell protocol', () => {
    expect(names(buildToolsArray({ caps: NATIVE, webSearchAuto: false, lspAvailable: false }))).toContain('run_shell');
    // R1 stays on the <shell> XML transport — the schema must not appear.
    expect(names(buildToolsArray({ caps: XML_SHELL, webSearchAuto: false, lspAvailable: false }))).not.toContain('run_shell');
  });

  it('requires BOTH the capability and live availability for LSP tools', () => {
    const lspNames = lspTools.map(t => t.function.name);
    const withLsp = names(buildToolsArray({ caps: NATIVE, webSearchAuto: false, lspAvailable: true }));
    expect(lspNames.every(n => withLsp.includes(n))).toBe(true);

    // Capability on, nothing available.
    const noneAvailable = names(buildToolsArray({ caps: NATIVE, webSearchAuto: false, lspAvailable: false }));
    expect(lspNames.some(n => noneAvailable.includes(n))).toBe(false);

    // Available, but the model can't use them.
    const noCapability = names(
      buildToolsArray({ caps: { shellProtocol: 'native-tool', lspTools: false }, webSearchAuto: false, lspAvailable: true })
    );
    expect(lspNames.some(n => noCapability.includes(n))).toBe(false);
  });

  it('includes web_search only when auto mode is active and configured', () => {
    expect(names(buildToolsArray({ caps: NATIVE, webSearchAuto: true, lspAvailable: false }))).toContain('web_search');
    expect(names(buildToolsArray({ caps: NATIVE, webSearchAuto: false, lspAvailable: false }))).not.toContain('web_search');
  });

  it('appends extraTools last and omits them when absent', () => {
    const extra: Tool = {
      type: 'function',
      function: { name: 'mcp__srv__thing', description: '', parameters: { type: 'object', properties: {} } }
    };
    const got = buildToolsArray({ caps: NATIVE, webSearchAuto: true, lspAvailable: true, extraTools: [extra] });
    expect(got[got.length - 1].function.name).toBe('mcp__srv__thing');

    const without = buildToolsArray({ caps: NATIVE, webSearchAuto: true, lspAvailable: true });
    expect(names(without)).not.toContain('mcp__srv__thing');
    expect(without.length).toBe(got.length - 1);
  });

  it('produces identical arrays for identical inputs — the two orchestrator loops cannot drift', () => {
    // This is the point of the extraction: streaming and runToolLoop used to
    // hold byte-identical copies of this composition.
    const input = { caps: NATIVE, webSearchAuto: true, lspAvailable: true } as const;
    expect(JSON.stringify(buildToolsArray(input))).toBe(JSON.stringify(buildToolsArray(input)));
  });

  it('emits no duplicate tool names in any configuration', () => {
    for (const caps of [NATIVE, XML_SHELL]) {
      for (const webSearchAuto of [true, false]) {
        for (const lspAvailable of [true, false]) {
          const got = names(buildToolsArray({ caps, webSearchAuto, lspAvailable }));
          expect(new Set(got).size).toBe(got.length);
        }
      }
    }
  });
});
