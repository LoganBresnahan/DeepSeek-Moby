/**
 * Single source of truth for the request-time tools array.
 *
 * Both agentic loops (`runStreamingToolCallsLoop` and `runToolLoop`) used to
 * build this list inline, byte-identically. Keeping one builder means a new
 * tool source — MCP servers next — is added in one place, and the token
 * budget can price the same array both loops send.
 */

import { Tool } from '../deepseekClient';
import { ModelCapabilities } from '../models/registry';
import {
  workspaceTools,
  applyCodeEditTool,
  createFileTool,
  deleteFileTool,
  deleteDirectoryTool,
  runShellTool,
  webSearchTool
} from './workspaceTools';
import { lspTools } from './lspTools';

export interface BuildToolsArrayInput {
  /** Capabilities of the model this request targets. */
  caps: Pick<ModelCapabilities, 'shellProtocol' | 'lspTools'>;
  /** True when web search mode is 'auto' AND a provider is configured. */
  webSearchAuto: boolean;
  /** True when at least one workspace language has a live symbol provider. */
  lspAvailable: boolean;
  /** Extra tools from external sources (MCP servers), already namespaced. */
  extraTools?: Tool[];
}

/**
 * Compose the tools array for one request.
 *
 * `run_shell` is included only for native-tool-calling models
 * (`shellProtocol: 'native-tool'` — V3 chat, V4 family, custom natives). R1
 * stays on the `<shell>` XML transport: its `shellProtocol: 'xml-shell'`
 * keeps the schema out of this array and the existing parser owns dispatch.
 */
export function buildToolsArray(input: BuildToolsArrayInput): Tool[] {
  const includeRunShell = input.caps.shellProtocol === 'native-tool';
  const includeLspTools = input.caps.lspTools === true && input.lspAvailable;

  return [
    ...workspaceTools,
    applyCodeEditTool,
    createFileTool,
    deleteFileTool,
    deleteDirectoryTool,
    ...(includeRunShell ? [runShellTool] : []),
    ...(includeLspTools ? lspTools : []),
    ...(input.webSearchAuto ? [webSearchTool] : []),
    ...(input.extraTools ?? [])
  ];
}
