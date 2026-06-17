# Tool Execution

This document covers how the extension executes tools, handles shell commands, and manages file modifications.

## Tool System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      Tool Execution System                       │
└─────────────────────────────────────────────────────────────────┘

    DeepSeek API Response
           │
           │ tool_calls OR <shell> tags
           ▼
    ┌──────────────────┐
    │  Tool Detection  │
    └────────┬─────────┘
             │
    ┌────────┴────────┐
    │                 │
    ▼                 ▼
┌─────────┐    ┌──────────────┐
│ Native  │    │ Shell (R1    │
│ Tools   │    │ Reasoner)    │
│ (API)   │    │              │
└────┬────┘    └──────┬───────┘
     │                │
     ▼                ▼
┌─────────────────────────────┐
│     Tool Executors          │
│ ┌─────────┬─────────┬─────┐ │
│ │read_file│write    │find │ │
│ │         │_file    │_files│ │
│ └─────────┴─────────┴─────┘ │
└─────────────────────────────┘
             │
             ▼
    ┌──────────────────┐
    │ Result Handling  │
    │ • Display output │
    │ • Create diffs   │
    │ • Continue loop  │
    └──────────────────┘
```

## Native Tool Types

Native tools are sent to the DeepSeek API in OpenAI tools format — every
definition is wrapped as `{ type: 'function', function: { name, description,
parameters } }`. The core read-only tools live in `workspaceTools` (in
`src/tools/workspaceTools.ts`); write/edit/delete/shell/web-search tools are
separate exports added conditionally by the orchestrator depending on model
capabilities and settings.

The full tool set:

- **Core (always present):** `read_file`, `find_files`, `grep`,
  `list_directory`, `file_metadata`
- **Conditional:** `write_file`, `edit_file`, `delete_file`,
  `delete_directory`, `run_shell` (only when the model's `shellProtocol` is
  `native-tool`), `web_search` (only when web search is configured + in auto
  mode), plus LSP tools when available.

> Argument values arrive as JSON strings parsed from `toolCall.function.arguments`,
> so numeric-looking params (e.g. `maxResults`, `startLine`) are declared as
> `type: 'string'`.

### read_file

Reads a file from the workspace, optionally a line range.

```typescript
{
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read the contents of a file in the workspace. Use this to examine source code, configuration files, or any text file.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The relative path to the file from the workspace root'
        },
        startLine: { type: 'string' },  // optional, 1-indexed
        endLine: { type: 'string' }     // optional, 1-indexed
      },
      required: ['path']
    }
  }
}
```

### write_file

Creates or overwrites a file (exported as `createFileTool`). The executor only
returns an acknowledgment string — the orchestrator runs the approval flow and
calls the `createFile` capability to perform the write.

```typescript
{
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Write a file with the given content. Creates the file if it does not exist; overwrites it entirely if it does.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        language: { type: 'string' },     // optional, diff-preview hint
        description: { type: 'string' }    // optional
      },
      required: ['path', 'content']
    }
  }
}
```

### find_files

Searches for files by name pattern (not contents — use `grep` for contents).

```typescript
{
  type: 'function',
  function: {
    name: 'find_files',
    description: 'Find files in the workspace by name pattern.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        maxResults: { type: 'string' }  // default: 20
      },
      required: ['pattern']
    }
  }
}
```

### list_directory

Lists files and directories in a path.

```typescript
{
  type: 'function',
  function: {
    name: 'list_directory',
    description: 'List files and directories in a given path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },        // default: workspace root
        recursive: { type: 'string' }    // "true" lists up to 3 levels deep
      },
      required: []
    }
  }
}
```

## Tool Loop Execution

### Flow Diagram

```
                    ┌───────────────────┐
                    │   API Request     │
                    │   (messages +     │
                    │    tools)         │
                    └─────────┬─────────┘
                              │
                              ▼
                    ┌───────────────────┐
                    │   API Response    │
                    └─────────┬─────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
              ▼                               ▼
    ┌───────────────────┐          ┌───────────────────┐
    │ Has tool_calls?   │          │ Content only      │
    │ (finish_reason:   │          │ (finish_reason:   │
    │  tool_calls)      │          │  stop)            │
    └─────────┬─────────┘          └─────────┬─────────┘
              │                               │
              ▼                               ▼
    ┌───────────────────┐          ┌───────────────────┐
    │ Execute each tool │          │ Display content   │
    │ sequentially      │          │ END               │
    │ (for-loop, await) │          └───────────────────┘
    └─────────┬─────────┘
              │
              ▼
    ┌───────────────────┐
    │ Append tool       │
    │ results to        │
    │ messages          │
    └─────────┬─────────┘
              │
              ▼
    ┌───────────────────┐
    │ Check iteration   │
    │ limit             │
    └─────────┬─────────┘
              │
     ┌────────┴────────┐
     │ < limit         │ >= limit
     ▼                 ▼
   Loop back      Force stop
   to API         with warning
```

### Code Implementation

The tool loop lives on `RequestOrchestrator` (in `src/providers/requestOrchestrator.ts`),
not `ChatProvider`. Streaming-tool-calls models (V4) use
`runStreamingToolCallsLoop`; the older non-streaming probe path is `runToolLoop`.
The iteration cap is read from the `moby.maxToolCalls` setting (default `25`;
`>= 100` means unlimited).

```typescript
// RequestOrchestrator.runStreamingToolCallsLoop() (simplified)
const configuredLimit = config.get<number>('maxToolCalls') ?? 25;
const maxIterations = configuredLimit >= 100 ? Infinity : configuredLimit;
let iterations = 0;

while (iterations < maxIterations) {
  iterations++;

  // Stream the API call with the composed tools array.
  const response = await this.deepSeekClient.streamChat(
    currentMessages, onToken, systemPrompt, onReasoning, { tools, signal }
  );

  const toolCalls = response.tool_calls ?? [];

  // Terminal turn — final answer. finish_reason is 'stop' (or no tool calls).
  if (response.finish_reason !== 'tool_calls' || toolCalls.length === 0) {
    break;
  }

  // Append the assistant turn carrying the tool calls.
  currentMessages.push({
    role: 'assistant',
    content: response.content || '',
    tool_calls: toolCalls,
  });

  // Dispatch each tool sequentially — one tool message per call,
  // keyed by tool_call_id.
  for (const toolCall of toolCalls) {
    const dispatch = await this.dispatchToolCall(toolCall, signal);
    currentMessages.push({
      role: 'tool',
      content: dispatch.result,
      tool_call_id: toolCall.id,
    });
  }
}
```

## Shell Command Execution

The R1 Reasoner model (`deepseek-reasoner`, `shellProtocol: 'xml-shell'`) can't
use native tool calling, so it emits `<shell>` tags that the extension parses
and executes. Native-tool models (the V4 family, `shellProtocol: 'native-tool'`)
reach the **same** execution pipeline (`executeShellCommands` in
`reasonerShellExecutor.ts`) through the `run_shell` tool. The default model is
`deepseek-v4-pro-thinking`, so the native-tool path is the common one; the
`<shell>` syntax below is R1-specific.

### Detection Pattern

```xml
<shell>
git status
npm run test
</shell>
```

### Parsing

`parseShellCommands` is a module-level export in `reasonerShellExecutor.ts`. It
matches **all** `<shell>` blocks via a global regex and keeps each block's whole
trimmed body as one command — it does not split on newlines into separate
commands. Each result is `{ command, index }` (the index is the match position
in the response); there is no `cwd` field on `ShellCommand`.

```typescript
export function parseShellCommands(content: string): ShellCommand[] {
  const commands: ShellCommand[] = [];
  const shellRegex = /<shell>([\s\S]*?)<\/shell>/gi;

  let match;
  while ((match = shellRegex.exec(content)) !== null) {
    const command = match[1].trim();
    if (command) {
      commands.push({ command, index: match.index });
    }
  }

  return commands;
}
```

### Command Safety

```
┌─────────────────────────────────────────────────────────────────┐
│                    Command Safety Check                          │
└─────────────────────────────────────────────────────────────────┘

    Command received
           │
           ▼
    ┌──────────────────┐
    │ allowAllShell-   │  yes
    │ Commands set?    ├────────────┐
    └────────┬─────────┘            │
             │ no                   │
             ▼                      │
    ┌──────────────────┐            │
    │ CommandApproval- │            │
    │ Manager rule:    │            │
    │ allowed/blocked/ │            │
    │ ask              │            │
    └────────┬─────────┘            │
     ┌───────┼────────┐             │
  blocked   ask     allowed         │
     │       │         │            │
     ▼       ▼         │            │
┌─────────┐ Prompt     │            │
│ REJECT  │ user ──────┤            │
│ command │ (deny→     │            │
└─────────┘  reject)   │            │
                       ▼            │
            ┌──────────────────┐    │
            │ validateCommand: │    │
            │ user-approved    │    │
            │ bypasses         │    │
            │ BLOCKED_PATTERNS │    │
            └────────┬─────────┘    │
                     ▼              │
              ┌──────────────┐      │
              │ EXECUTE      │◄─────┘
              │ command      │
              └──────────────┘
```

Approval is governed by `CommandApprovalManager` rules — each command matches a
`CommandRule` (`type: 'allowed' | 'blocked'`, `source: 'default' | 'user'`)
yielding a decision of `allowed`, `blocked`, or `ask`. The executor's
`BLOCKED_PATTERNS` are a separate last-resort safety net for catastrophic
operations; commands the user already approved (`approvalStatus` of
`'user-allowed'` or `'auto'`) bypass them. The `moby.allowAllShellCommands`
setting skips validation entirely.

### Blocklist

`validateCommand` checks the command against `BLOCKED_PATTERNS` — an array of
**regexes** (not lowercased substring matches) covering only catastrophic
operations. User-approved commands and `allowAllShellCommands` skip the check.

```typescript
const BLOCKED_PATTERNS: RegExp[] = [
  /\brm\s+(-[rf]+\s+)+[\/~](?:\s|$|\/?\*?\s*$)/i,  // rm -rf of bare / or ~
  /\bsudo\s/i,
  /\bsu\s+-/i,             // su with login shell
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\bdd\s+.*of=\/dev\//i,  // dd writing to devices
  /\bmkfs\b/i,             // formatting filesystems
];

export function validateCommand(
  command: string,
  allowAll: boolean = false,
  approvalStatus?: ShellCommand['approvalStatus']
): { valid: boolean; reason?: string } {
  if (allowAll) return { valid: true };
  if (approvalStatus === 'user-allowed' || approvalStatus === 'auto') {
    return { valid: true };
  }
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return { valid: false, reason: 'Blocked: Potentially dangerous operation' };
    }
  }
  return { valid: true };
}
```

> A separate `LONG_RUNNING_PATTERNS` list (servers, watch modes, REPLs) is also
> checked — those commands are not executed; a result tells the model to ask the
> user to run them manually.

### Execution

`executeShellCommand` spawns the whole command string with `shell: true`
(`resolveShell()` returns `true` on Unix → `/bin/sh`, or a resolved Git Bash
path on Windows). `cwd` is the workspace root, not a per-command field. The
default timeout is **10 seconds**, enforced manually via `setTimeout` that sends
`SIGTERM` then `SIGKILL`.

```typescript
export async function executeShellCommand(
  command: string,
  workspacePath: string,
  options: { timeout?: number; signal?: AbortSignal; /* ... */ } = {}
): Promise<ShellResult> {
  const timeout = options.timeout ?? 10000;  // 10s default

  // (validateCommand runs first — see Blocklist above)

  return new Promise((resolve) => {
    const child = cp.spawn(command, {
      cwd: workspacePath,
      shell: resolveShell(),
      env: { ...process.env },
    });

    const timeoutId = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000);
      resolve({ command, output: '... (timed out)', success: false, executionTimeMs });
    }, timeout);

    let stdout = '', stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      clearTimeout(timeoutId);
      resolve({ command, output: stdout + stderr, success: code === 0, executionTimeMs });
    });
  });
}
```

## File Modification Flow

### Edit Modes

```
┌─────────────────────────────────────────────────────────────────┐
│                        Edit Modes                                │
├─────────────┬─────────────────────────────────────────────────────
│   Mode      │   Behavior                                        │
├─────────────┼─────────────────────────────────────────────────────
│   manual    │   Create diff, wait for user to Accept/Reject    │
│   ask       │   Create diff, show prompt asking user           │
│   auto      │   Apply changes immediately (dangerous!)          │
└─────────────┴─────────────────────────────────────────────────────
```

### Diff Lifecycle

The diff lifecycle lives in `DiffManager` (`src/providers/diffManager.ts`),
extracted out of `ChatProvider`. It keeps active diffs in an
`activeDiffs: Map<string, DiffMetadata>` and applies edits via
`vscode.workspace.applyEdit`. `DiffMetadata` tracks `vscode.Uri` references for
the proposed vs original content rather than raw content strings:

```typescript
interface DiffMetadata {
  proposedUri: vscode.Uri;
  originalUri: vscode.Uri;
  targetFilePath: string;
  code: string;
  language: string;
  timestamp: number;
  iteration: number;
  diffId: string;
  superseded?: boolean;
  action?: 'created' | 'modified' | 'deleted';
}
```

`DiffManager` emits events (`onDiffListChanged`, `onCodeApplied`, etc.) that
`ChatProvider` forwards to the webview. The serializable form sent to the
webview is `DiffInfo`, which carries a `status` of
`'pending' | 'applied' | 'rejected' | 'deleted' | 'expired'`.

Actual file writes for the `write_file` / `delete_file` / `delete_directory`
tools go through the **capabilities layer** (`src/capabilities/files.ts`), thin
wrappers over `vscode.workspace.fs` that resolve workspace-relative paths,
enforce the workspace boundary, and (for `createFile`) `createDirectory` the
parent before `writeFile`.

## Tool Result Display

### UI Components

```
┌─────────────────────────────────────────────────────────────────┐
│                    Tool Calls Display                            │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  🔧 Tool Calls                            [Collapse ▼]      ││
│  │  ┌─────────────────────────────────────────────────────────┐││
│  │  │  ✓  read_file                                           │││
│  │  │      src/utils/config.ts                                │││
│  │  │      ─────────────────────                              │││
│  │  │      const config = { ... }                             │││
│  │  ├─────────────────────────────────────────────────────────┤││
│  │  │  ✓  find_files                                        │││
│  │  │      pattern: "*.test.ts"                               │││
│  │  │      ─────────────────────                              │││
│  │  │      Found 12 files                                     │││
│  │  ├─────────────────────────────────────────────────────────┤││
│  │  │  ⟳  write_file                                          │││
│  │  │      src/newFile.ts                                     │││
│  │  └─────────────────────────────────────────────────────────┘││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    Pending Changes Display                       │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  📁 Pending Changes (2)                   [Collapse ▼]      ││
│  │  ┌─────────────────────────────────────────────────────────┐││
│  │  │  ○  src/newFile.ts                    [Accept] [Reject] │││
│  │  │      Status: pending                                    │││
│  │  ├─────────────────────────────────────────────────────────┤││
│  │  │  ✓  src/updated.ts                                      │││
│  │  │      Status: applied                                    │││
│  │  └─────────────────────────────────────────────────────────┘││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    Shell Commands Display                        │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  $ Shell Commands                         [Collapse ▼]      ││
│  │  ┌─────────────────────────────────────────────────────────┐││
│  │  │  $ git status                                ✓ Exit 0   │││
│  │  │  ─────────────────────────────────────────────────────  │││
│  │  │  On branch main                                         │││
│  │  │  Changes not staged for commit:                         │││
│  │  │    modified: src/index.ts                               │││
│  │  ├─────────────────────────────────────────────────────────┤││
│  │  │  $ npm run test                              ✗ Exit 1   │││
│  │  │  ─────────────────────────────────────────────────────  │││
│  │  │  FAIL src/test.ts                                       │││
│  │  │    ✗ should work (5ms)                                  │││
│  │  └─────────────────────────────────────────────────────────┘││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Error Handling

### Tool Execution Errors

Tool dispatch is the module-level `executeToolCall(toolCall)` in
`workspaceTools.ts`. It JSON-parses `toolCall.function.arguments`, switches on
`toolCall.function.name`, and returns a **plain string** (not a `{ success,
error }` object). Failures are returned as strings prefixed with `Error:` —
callers (e.g. the orchestrator) treat a leading `Error:` as a failed tool.

```typescript
export async function executeToolCall(toolCall: ToolCall): Promise<string> {
  let args: Record<string, string>;
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch (e) {
    return `Error: Invalid arguments - ${e}`;
  }

  // ... resolve workspace, dispatch LSP tools ...

  try {
    switch (toolCall.function.name) {
      case 'read_file':
        return await readFile(workspacePath, args.path, args.startLine, args.endLine);
      case 'find_files':
        return await searchFiles(workspacePath, args.pattern, args.maxResults);
      // write_file/edit_file/delete_*/run_shell return an "Acknowledged: ..."
      // string here — the orchestrator performs the actual approval + write.
      default:
        return `Error: Unknown function "${toolCall.function.name}"`;
    }
  } catch (error: any) {
    return `Error executing ${toolCall.function.name}: ${error.message}`;
  }
}
```

### Shell Command Errors

The timeout is enforced manually (Node's `spawn` `timeout` option is not used);
on the `error` event the promise resolves with a failure `ShellResult` whose
`output` is `Error: <message>`.

```typescript
const child = cp.spawn(command, { cwd: workspacePath, shell: resolveShell(), env });

// Manual 10s timeout (default) — SIGTERM then SIGKILL.
const timeoutId = setTimeout(() => {
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 1000);
}, options.timeout ?? 10000);

child.on('error', (error) => {
  clearTimeout(timeoutId);
  resolve({
    command,
    output: `Error: ${error.message}`,
    success: false,
    executionTimeMs
  });
});
```

### File Creation

File writes go through the `createFile` capability (`src/capabilities/files.ts`),
which uses `vscode.workspace.fs` and `createDirectory`s the parent before
writing. There is no recursive `writeFile`/`ensureDirectory` with `EACCES` /
`ENOENT` branching — errors surface as a structured `CapabilityResult` with
`status: 'failure'`.

```typescript
export async function createFile(
  relativePath: string,
  content: string
): Promise<CapabilityResult> {
  // ... resolve + workspace-boundary check ...
  try {
    const parentDir = vscode.Uri.file(path.dirname(absolutePath));
    await vscode.workspace.fs.createDirectory(parentDir);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
    return { status: 'success', filesAffected: [/* ... */] };
  } catch (error: any) {
    return { status: 'failure', error: `Failed to write ${relativePath}: ${error.message}`, filesAffected: [] };
  }
}
```

## Performance Considerations

### Sequential Tool Execution

Tool calls within an iteration are dispatched **strictly sequentially** — a
`for` loop awaits each `dispatchToolCall` before starting the next. There is no
parallel `Promise.all` execution of tools.

```typescript
for (const toolCall of toolCalls) {
  const dispatch = await this.dispatchToolCall(toolCall, signal);
  currentMessages.push({ role: 'tool', content: dispatch.result, tool_call_id: toolCall.id });
}
```

### File Reads

`read_file` reads from disk on **every** call via Node's `fs.readFileSync` —
there is no content cache or TTL. The result is a formatted, line-numbered
string with a header (`File: <path> (lines X-Y of N)`).

### Large File Handling

`read_file` rejects files larger than 500KB with an error string that nudges the
model to read a portion via `startLine`/`endLine`, rather than returning a
placeholder.

```typescript
const stats = fs.statSync(fullPath);

// Limit to 500KB
if (stats.size > 500 * 1024) {
  return `Error: File is too large (${Math.round(stats.size / 1024)}KB). ` +
         `Use startLine/endLine to read a portion.`;
}
```

## Debugging

### Tool Execution Logging

```typescript
logger.toolCall(toolCall.function.name);        // single arg
const result = await executeToolCall(toolCall);
logger.toolResult(toolCall.function.name, !result.startsWith('Error:'));
```

### Shell Command Logging

```typescript
logger.shellExecuting(command);  // command only (no cwd)
// ... execute ...
// shellResult takes a boolean `success`, not an exit code.
logger.shellResult(command, success, output);
```

### Common Issues

| Problem | Cause | Solution |
|---------|-------|----------|
| Tool not found | Wrong tool name | Check tool definitions |
| Permission denied | File permissions | Run VS Code with rights |
| Timeout | Long-running command | Increase timeout |
| Encoding issues | Non-UTF8 file | Handle encoding |
| Path not found | Relative vs absolute | Use workspace root |
