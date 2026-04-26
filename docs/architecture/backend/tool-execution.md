# Tool Execution

This document covers how the extension executes tools, handles shell commands, and manages file modifications.

## Tool System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      Tool Execution System                       │
└─────────────────────────────────────────────────────────────────┘

    DeepSeek API Response
           │
           │ tool_use blocks OR <shell> tags
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
│ │read_file│write   │search│ │
│ │         │_file   │_files│ │
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

Tools defined for the DeepSeek API:

### read_file

Reads a file from the workspace.

```typescript
{
  name: 'read_file',
  description: 'Read the contents of a file',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative path to the file'
      }
    },
    required: ['path']
  }
}
```

### write_file

Creates or overwrites a file.

```typescript
{
  name: 'write_file',
  description: 'Write content to a file',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' }
    },
    required: ['path', 'content']
  }
}
```

### find_files

Searches for files by pattern.

```typescript
{
  name: 'find_files',
  description: 'Search for files matching a pattern',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      maxResults: { type: 'number' }
    },
    required: ['pattern']
  }
}
```

### list_directory

Lists files in a directory.

```typescript
{
  name: 'list_directory',
  description: 'List files in a directory',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' }
    },
    required: ['path']
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
    │ Has tool_use?     │          │ Content only      │
    │ (finish_reason:   │          │ (finish_reason:   │
    │  tool_use)        │          │  stop)            │
    └─────────┬─────────┘          └─────────┬─────────┘
              │                               │
              ▼                               ▼
    ┌───────────────────┐          ┌───────────────────┐
    │ Execute each tool │          │ Display content   │
    │ in parallel or    │          │ END               │
    │ sequence          │          └───────────────────┘
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

```typescript
// ChatProvider.runToolLoop()
async runToolLoop(
  messages: Message[],
  maxIterations: number
): Promise<void> {
  let iteration = 0;

  while (iteration < maxIterations) {
    // Call API with tools
    const response = await this.deepSeekClient.chat({
      messages,
      tools: this.getToolDefinitions(),
      stream: true
    });

    // Process streaming response
    const result = await this.processStreamResponse(response);

    // Check for tool calls
    if (result.finishReason === 'tool_use' && result.toolCalls) {
      // Execute tools
      const toolResults = await this.executeTools(result.toolCalls);

      // Append results to conversation
      messages.push({
        role: 'assistant',
        content: result.content,
        tool_calls: result.toolCalls
      });

      messages.push({
        role: 'tool',
        tool_results: toolResults
      });

      iteration++;
    } else {
      // No more tools, we're done
      break;
    }
  }
}
```

## Shell Command Execution (Reasoner)

The R1 Reasoner model uses `<shell>` tags instead of native tools.

### Detection Pattern

```xml
<shell>
git status
npm run test
</shell>
```

### Parsing

```typescript
// ChatProvider.parseShellCommands()
parseShellCommands(content: string): ShellCommand[] {
  const shellMatch = content.match(/<shell>([\s\S]*?)<\/shell>/);
  if (!shellMatch) return [];

  const commands = shellMatch[1]
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(cmd => ({
      command: cmd,
      cwd: this.getWorkspaceRoot()
    }));

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
    │ Check blocklist  │
    │ (rm -rf, sudo,   │
    │  format, etc.)   │
    └────────┬─────────┘
             │
    ┌────────┴────────┐
    │ Blocked?        │
    ▼                 ▼
   Yes               No
    │                 │
    ▼                 │
┌─────────┐          │
│ Check   │          │
│ "Wild   │          │
│ Side"   │          │
│ enabled │          │
└────┬────┘          │
     │               │
 ┌───┴───┐           │
 │       │           │
Yes      No          │
 │       │           │
 │       ▼           │
 │  ┌─────────┐      │
 │  │ REJECT  │      │
 │  │ command │      │
 │  └─────────┘      │
 │                   │
 └───────────────────┤
                     ▼
              ┌──────────────┐
              │ EXECUTE      │
              │ command      │
              └──────────────┘
```

### Blocklist

```typescript
const DANGEROUS_COMMANDS = [
  'rm -rf',
  'sudo',
  'mkfs',
  'dd if=',
  'format',
  ':(){:|:&};:',  // fork bomb
  'chmod -R 777',
  '> /dev/sda',
  'mv /* ',
];

function isCommandSafe(cmd: string): boolean {
  const lower = cmd.toLowerCase();
  return !DANGEROUS_COMMANDS.some(dangerous =>
    lower.includes(dangerous)
  );
}
```

### Execution

```typescript
// Execute shell command
async executeShellCommand(cmd: ShellCommand): Promise<ShellResult> {
  return new Promise((resolve) => {
    const process = spawn('sh', ['-c', cmd.command], {
      cwd: cmd.cwd,
      timeout: 30000
    });

    let output = '';
    let error = '';

    process.stdout.on('data', (data) => {
      output += data.toString();
    });

    process.stderr.on('data', (data) => {
      error += data.toString();
    });

    process.on('close', (code) => {
      resolve({
        success: code === 0,
        output: output || error,
        exitCode: code
      });
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

### Diff Creation

```typescript
// ChatProvider.createDiff()
async createDiff(
  filePath: string,
  newContent: string
): Promise<DiffMetadata> {
  const uri = vscode.Uri.file(filePath);
  const diffId = `diff-${Date.now()}`;

  // Get current content (if file exists)
  let originalContent = '';
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    originalContent = doc.getText();
  } catch {
    // New file
  }

  // Store diff metadata
  const metadata: DiffMetadata = {
    diffId,
    filePath,
    originalContent,
    newContent,
    status: 'pending',
    timestamp: Date.now()
  };

  this.activeDiffs.set(diffId, metadata);

  // Notify webview
  this.notifyDiffListChanged();

  return metadata;
}
```

### Diff Application

```typescript
// ChatProvider.applyDiff()
async applyDiff(diffId: string): Promise<void> {
  const diff = this.activeDiffs.get(diffId);
  if (!diff) return;

  const uri = vscode.Uri.file(diff.filePath);

  // Create or update file
  const edit = new vscode.WorkspaceEdit();

  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const fullRange = new vscode.Range(
      doc.positionAt(0),
      doc.positionAt(doc.getText().length)
    );
    edit.replace(uri, fullRange, diff.newContent);
  } catch {
    // New file
    edit.createFile(uri, { overwrite: true });
    edit.insert(uri, new vscode.Position(0, 0), diff.newContent);
  }

  await vscode.workspace.applyEdit(edit);

  // Update status
  diff.status = 'applied';
  this.notifyDiffListChanged();
}
```

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

```typescript
async executeTool(tool: ToolCall): Promise<ToolResult> {
  try {
    switch (tool.name) {
      case 'read_file':
        return await this.readFile(tool.arguments.path);
      case 'write_file':
        return await this.writeFile(
          tool.arguments.path,
          tool.arguments.content
        );
      // ...
    }
  } catch (error) {
    return {
      success: false,
      error: `Tool execution failed: ${error.message}`
    };
  }
}
```

### Shell Command Errors

```typescript
// Timeout handling
const process = spawn('sh', ['-c', cmd], {
  timeout: 30000  // 30 second timeout
});

process.on('error', (error) => {
  resolve({
    success: false,
    output: `Failed to execute: ${error.message}`,
    exitCode: -1
  });
});
```

### File Permission Errors

```typescript
async writeFile(path: string, content: string) {
  try {
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(path),
      Buffer.from(content)
    );
  } catch (error) {
    if (error.code === 'EACCES') {
      throw new Error(`Permission denied: ${path}`);
    }
    if (error.code === 'ENOENT') {
      // Create parent directories
      await this.ensureDirectory(dirname(path));
      await this.writeFile(path, content);
    }
    throw error;
  }
}
```

## Performance Considerations

### Parallel Tool Execution

```typescript
// Execute independent tools in parallel
const results = await Promise.all(
  toolCalls.map(tool => this.executeTool(tool))
);
```

### File Content Caching

```typescript
// Cache recently read files
private fileCache = new Map<string, { content: string; timestamp: number }>();

async readFile(path: string): Promise<string> {
  const cached = this.fileCache.get(path);
  const now = Date.now();

  // Cache valid for 5 seconds
  if (cached && (now - cached.timestamp) < 5000) {
    return cached.content;
  }

  const content = await vscode.workspace.fs.readFile(
    vscode.Uri.file(path)
  );
  const text = content.toString();

  this.fileCache.set(path, { content: text, timestamp: now });
  return text;
}
```

### Large File Handling

```typescript
const MAX_FILE_SIZE = 1024 * 1024; // 1MB

async readFile(path: string): Promise<string> {
  const stat = await vscode.workspace.fs.stat(
    vscode.Uri.file(path)
  );

  if (stat.size > MAX_FILE_SIZE) {
    return `[File too large: ${(stat.size / 1024).toFixed(1)}KB]`;
  }

  // Read file normally
}
```

## Debugging

### Tool Execution Logging

```typescript
logger.toolStart(tool.name, tool.arguments);
const result = await this.executeTool(tool);
logger.toolEnd(tool.name, result.success);
```

### Shell Command Logging

```typescript
logger.shellExecute(cmd.command, cmd.cwd);
// ... execute ...
logger.shellResult(cmd.command, exitCode, output.substring(0, 200));
```

### Common Issues

| Problem | Cause | Solution |
|---------|-------|----------|
| Tool not found | Wrong tool name | Check tool definitions |
| Permission denied | File permissions | Run VS Code with rights |
| Timeout | Long-running command | Increase timeout |
| Encoding issues | Non-UTF8 file | Handle encoding |
| Path not found | Relative vs absolute | Use workspace root |
