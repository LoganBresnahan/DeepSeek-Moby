import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { Tool, ToolCall } from '../deepseekClient';

/**
 * Workspace tools that allow the LLM to explore and read files in the codebase.
 */

/**
 * Resolve a model-supplied path against the workspace, allowing both
 * relative paths ("src/index.ts") and absolute paths inside the workspace
 * ("/home/user/proj/src/index.ts"). Returns null when the resolved path
 * escapes the workspace boundary.
 *
 * `path.join` was the previous approach but it doesn't reset on absolute
 * second args (`path.join('/a', '/a')` → `/a/a`), which broke V4's
 * absolute-path callers. `path.resolve` resets correctly; `path.relative`
 * then catches escapes via `..` prefix or unrelated drive root.
 */
function resolveWorkspacePath(workspacePath: string, userPath: string): string | null {
  const fullPath = path.resolve(workspacePath, userPath);
  const rel = path.relative(workspacePath, fullPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  return fullPath;
}

// Tool definitions for the DeepSeek API
export const workspaceTools: Tool[] = [
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
            description: 'The relative path to the file from the workspace root (e.g., "src/index.ts", "package.json")'
          },
          startLine: {
            type: 'string',
            description: 'Optional: Start reading from this line number (1-indexed). Useful for large files.'
          },
          endLine: {
            type: 'string',
            description: 'Optional: Stop reading at this line number (1-indexed). Useful for large files.'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description: 'Find files in the workspace by name pattern. Searches the file *names* (not contents) — use `grep` to search inside files. Returns a list of matching file paths.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern to match files (e.g., "*.ts", "src/**/*.js", "**/test*.py")'
          },
          maxResults: {
            type: 'string',
            description: 'Maximum number of results to return (default: 20)'
          }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search for text or patterns within file contents. Similar to grep/ripgrep. Returns matching lines with file paths and line numbers. To search file *names* (not contents), use `find_files`.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The text or regex pattern to search for'
          },
          filePattern: {
            type: 'string',
            description: 'Optional: Only search in files matching this glob pattern (e.g., "*.ts", "src/**/*.js")'
          },
          maxResults: {
            type: 'string',
            description: 'Maximum number of matching lines to return (default: 50)'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and directories in a given path. Shows the structure of the codebase.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The relative path to list (e.g., "src", ".", "src/components"). Default is workspace root.'
          },
          recursive: {
            type: 'string',
            description: 'If "true", list recursively up to 3 levels deep. Default is "false".'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'file_metadata',
      description: 'Get metadata for a file: size, type, and a short preview of contents. Use `read_file` if you need the full contents.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The relative path to the file from the workspace root'
          }
        },
        required: ['path']
      }
    }
  }
];

// Web search tool - conditionally included when web search is enabled
export const webSearchTool: Tool = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web for current information using Tavily. Use this when you need up-to-date information, recent documentation, news, or anything not in your training data.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query to look up on the web'
        }
      },
      required: ['query']
    }
  }
};

// Create a new file in the workspace.
// Only dispatched as acknowledgment here — the orchestrator handles
// approval flow + calls the `createFile` capability.
export const createFileTool: Tool = {
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Write a file with the given content. Creates the file if it does not exist; overwrites it entirely if it does. Use this for new files, full-file rewrites, and any case where you want to replace the whole file. For targeted patches that change only specific sections of an existing file, use `edit_file` instead — it preserves the rest of the file.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path from workspace root (e.g., "src/newFile.ts", "docs/guide.md")'
        },
        content: {
          type: 'string',
          description: 'Full contents of the new file'
        },
        language: {
          type: 'string',
          description: 'Language hint for the diff preview (e.g., "typescript", "markdown")'
        },
        description: {
          type: 'string',
          description: 'Brief reason for creating this file'
        }
      },
      required: ['path', 'content']
    }
  }
};

// Delete a file in the workspace (moves to trash).
// Only dispatched as acknowledgment here — the orchestrator handles
// approval flow + calls the `deleteFile` capability.
export const deleteFileTool: Tool = {
  type: 'function',
  function: {
    name: 'delete_file',
    description: 'Delete a file in the workspace. Moves to the OS trash for recoverability. Refuses to delete directories. Requires user confirmation in ask mode. Use this when the file should genuinely be removed. To "clear" or reset a file, prefer `write_file` with the desired contents (which overwrites) — `delete_file` followed by `write_file` round-trips through the trash unnecessarily.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path from workspace root of the file to delete'
        },
        description: {
          type: 'string',
          description: 'Brief reason for deleting this file'
        }
      },
      required: ['path']
    }
  }
};

// Delete a directory (optionally recursively) in the workspace.
// Mirrors delete_file but targets directories. The orchestrator handles
// approval flow + calls the `deleteDirectory` capability.
export const deleteDirectoryTool: Tool = {
  type: 'function',
  function: {
    name: 'delete_directory',
    description: 'Delete a directory in the workspace. Moves to the OS trash for recoverability. By default only deletes empty directories; pass recursive="true" to delete a populated directory AND all its contents (everything inside is also moved to trash). Requires user confirmation in ask mode. This is a TERMINAL action for the given path — once it succeeds, the directory is gone. Do NOT call delete_file/delete_directory on the same path again. (write_file is fine — it just creates a fresh file.)',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path from workspace root of the directory to delete'
        },
        recursive: {
          type: 'string',
          description: 'Pass "true" to delete a populated directory and all contents. Default "false" only deletes empty directories.',
          enum: ['true', 'false']
        },
        description: {
          type: 'string',
          description: 'Brief reason for deleting this directory'
        }
      },
      required: ['path']
    }
  }
};

// Run-shell tool — exposes the existing R1 shell-execution pipeline to
// native-tool-calling models. The model sends a `command` string; the
// orchestrator routes it through `parseShellCommands` + the existing
// CommandApprovalManager + executeShellCommands. Long-running command
// detection (`isLongRunningCommand`) and the catastrophic-operation
// blocklist apply here exactly as they do for R1's `<shell>` path.
//
// Only included in the tools array when the active model has
// `shellProtocol: 'native-tool'` (see registry). R1 stays on `<shell>`.
export const runShellTool: Tool = {
  type: 'function',
  function: {
    name: 'run_shell',
    description: 'Run a shell command in the workspace and return its output. Use this for actions with no dedicated tool: running tests, compiling, installing dependencies, git operations, etc. Long-running commands (servers, watch modes, REPLs) are refused — the result will tell you to ask the user to run them manually. In ask mode, each command requires user approval before executing.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute. A single command line; chain with `&&` if you need multiple sequential steps.'
        },
        description: {
          type: 'string',
          description: 'Brief description of what this command does, shown to the user during approval.'
        }
      },
      required: ['command']
    }
  }
};

// Edit-file tool — patch an existing file with one or more search/replace
// pairs. Each pair locates a snippet in the current file and replaces it.
// The schema enforces this shape so the model can't send free-form code
// that the diff engine then has to guess about.
//
// For full-file rewrites (or for creating brand-new files), use
// `write_file` — it overwrites on existing paths.
export const applyCodeEditTool: Tool = {
  type: 'function',
  function: {
    name: 'edit_file',
    description: 'Patch an existing file by replacing specific snippets. Each edit names exactly the original code to find (`search`) and the new code to put in its place (`replace`). The `search` text must appear verbatim in the current file — quote it exactly, including indentation and surrounding lines for uniqueness. For full-file rewrites or new files, use `write_file` instead (it overwrites).',
    parameters: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Relative path to the file to edit (e.g., "src/index.ts").'
        },
        edits: {
          type: 'array',
          description: 'One or more search/replace pairs applied in order. To delete a section, use empty `replace`. To insert at the top, use empty `search`.',
          items: {
            type: 'object',
            properties: {
              search: {
                type: 'string',
                description: 'Exact text to find in the file. Include enough surrounding context to uniquely identify the location — at least 2-3 lines is usually enough. Indentation and whitespace must match the file.'
              },
              replace: {
                type: 'string',
                description: 'New text to put in place of the search. Use empty string to delete the matched section.'
              }
            },
            required: ['search', 'replace']
          },
          minItems: 1
        },
        language: {
          type: 'string',
          description: 'Language hint for the diff preview (e.g., "typescript").'
        },
        description: {
          type: 'string',
          description: 'Brief description of what this edit does.'
        }
      },
      required: ['file', 'edits']
    }
  }
};

/**
 * Execute a tool call and return the result
 */
export async function executeToolCall(toolCall: ToolCall): Promise<string> {
  const functionName = toolCall.function.name;
  let args: Record<string, string>;

  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch (e) {
    return `Error: Invalid arguments - ${e}`;
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return 'Error: No workspace folder is open';
  }

  const workspacePath = workspaceFolder.uri.fsPath;

  try {
    switch (functionName) {
      case 'read_file':
        return await readFile(workspacePath, args.path, args.startLine, args.endLine);

      case 'find_files':
        return await searchFiles(workspacePath, args.pattern, args.maxResults);

      case 'grep':
        return await grepContent(workspacePath, args.query, args.filePattern, args.maxResults);

      case 'list_directory':
        return await listDirectory(workspacePath, args.path || '.', args.recursive === 'true');

      case 'file_metadata':
        return await getFileInfo(workspacePath, args.path);

      case 'edit_file':
        // This tool doesn't execute anything - it's for signaling edit intent with structured file path
        // The orchestrator's edit dispatch path applies the search/replace blocks.
        return `Acknowledged: Code edit for file "${args.file}" will be applied. ${args.description || ''}`;

      case 'write_file':
        // Orchestrator handles the actual write + approval flow.
        return `Acknowledged: Write to "${args.path}" will be processed. ${args.description || ''}`;

      case 'delete_file':
        // Orchestrator handles the actual deletion + confirmation flow.
        return `Acknowledged: Deletion of "${args.path}" will be processed. ${args.description || ''}`;

      case 'delete_directory':
        // Orchestrator handles the actual deletion + confirmation flow.
        return `Acknowledged: Directory deletion of "${args.path}"${args.recursive === 'true' ? ' (recursive)' : ' (empty-only)'} will be processed. ${args.description || ''}`;

      case 'run_shell':
        // Orchestrator handles the actual approval + execution flow,
        // mirroring the existing R1 <shell> pipeline (CommandApprovalManager
        // + executeShellCommands). Same blocklist and long-running guards.
        return `Acknowledged: Shell command "${(args.command ?? '').substring(0, 80)}" will be processed. ${args.description || ''}`;

      default:
        return `Error: Unknown function "${functionName}"`;
    }
  } catch (error: any) {
    return `Error executing ${functionName}: ${error.message}`;
  }
}

async function readFile(
  workspacePath: string,
  filePath: string,
  startLine?: string,
  endLine?: string
): Promise<string> {
  const fullPath = resolveWorkspacePath(workspacePath, filePath);
  if (!fullPath) {
    return 'Error: Cannot read files outside the workspace';
  }

  if (!fs.existsSync(fullPath)) {
    return `Error: File not found: ${filePath}`;
  }

  const stats = fs.statSync(fullPath);
  if (stats.isDirectory()) {
    return `Error: "${filePath}" is a directory, not a file. Use list_directory instead.`;
  }

  // Check file size (limit to 500KB)
  if (stats.size > 500 * 1024) {
    return `Error: File is too large (${Math.round(stats.size / 1024)}KB). Use startLine/endLine to read a portion.`;
  }

  const content = fs.readFileSync(fullPath, 'utf-8');
  const lines = content.split('\n');

  // Handle line range
  const start = startLine ? Math.max(1, parseInt(startLine, 10)) : 1;
  const end = endLine ? Math.min(lines.length, parseInt(endLine, 10)) : lines.length;

  if (start > lines.length) {
    return `Error: startLine ${start} exceeds file length of ${lines.length} lines`;
  }

  const selectedLines = lines.slice(start - 1, end);

  // Add line numbers for context
  const numberedLines = selectedLines.map((line, i) => `${start + i}: ${line}`);

  let result = `File: ${filePath} (lines ${start}-${end} of ${lines.length})\n`;
  result += '─'.repeat(50) + '\n';
  result += numberedLines.join('\n');

  return result;
}

async function searchFiles(
  workspacePath: string,
  pattern: string,
  maxResults?: string
): Promise<string> {
  const limit = maxResults ? parseInt(maxResults, 10) : 20;

  // Use VS Code's findFiles API
  const files = await vscode.workspace.findFiles(
    pattern,
    '**/node_modules/**',
    limit
  );

  if (files.length === 0) {
    return `No files found matching pattern: ${pattern}`;
  }

  const relativePaths = files.map(f =>
    path.relative(workspacePath, f.fsPath)
  );

  let result = `Found ${files.length} file(s) matching "${pattern}":\n`;
  result += relativePaths.map(p => `  ${p}`).join('\n');

  return result;
}

async function grepContent(
  workspacePath: string,
  query: string,
  filePattern?: string,
  maxResults?: string
): Promise<string> {
  const limit = maxResults ? parseInt(maxResults, 10) : 50;

  // Try ripgrep first, fall back to grep
  let result = '';

  try {
    const rgArgs = [
      '-n', // line numbers
      '--max-count', '3', // max matches per file
      '-C', '1', // 1 line of context
      query,
      '--type-not', 'binary',
      '-g', '!node_modules',
      '-g', '!.git',
      '-g', '!*.min.js',
      '-g', '!*.min.css',
      '-g', '!package-lock.json',
      '-g', '!yarn.lock'
    ];

    if (filePattern) {
      rgArgs.push('-g', filePattern);
    }

    const rgResult = cp.spawnSync('rg', rgArgs, {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout: 10000,
      maxBuffer: 1024 * 1024 // 1MB
    });

    if (rgResult.stdout) {
      result = rgResult.stdout;
    } else if (rgResult.stderr && !rgResult.stderr.includes('No files were searched')) {
      // Try grep as fallback
      throw new Error('ripgrep failed');
    }
  } catch (e) {
    // Fallback to grep
    try {
      const grepArgs = ['-rn', '--include', filePattern || '*', query, '.'];
      const grepResult = cp.spawnSync('grep', grepArgs, {
        cwd: workspacePath,
        encoding: 'utf-8',
        timeout: 10000
      });

      if (grepResult.stdout) {
        result = grepResult.stdout;
      }
    } catch (e2) {
      return `Error: Could not search files (neither ripgrep nor grep available)`;
    }
  }

  if (!result.trim()) {
    return `No matches found for: "${query}"${filePattern ? ` in ${filePattern}` : ''}`;
  }

  // Limit output
  const lines = result.split('\n').filter(l => l.trim());
  const limitedLines = lines.slice(0, limit);

  let output = `Search results for "${query}"${filePattern ? ` in ${filePattern}` : ''}:\n`;
  output += '─'.repeat(50) + '\n';
  output += limitedLines.join('\n');

  if (lines.length > limit) {
    output += `\n... and ${lines.length - limit} more matches`;
  }

  return output;
}

async function listDirectory(
  workspacePath: string,
  dirPath: string,
  recursive: boolean
): Promise<string> {
  const fullPath = resolveWorkspacePath(workspacePath, dirPath);
  if (!fullPath) {
    return 'Error: Cannot list directories outside the workspace';
  }

  if (!fs.existsSync(fullPath)) {
    return `Error: Directory not found: ${dirPath}`;
  }

  const stats = fs.statSync(fullPath);
  if (!stats.isDirectory()) {
    return `Error: "${dirPath}" is a file, not a directory. Use read_file instead.`;
  }

  const entries: string[] = [];

  function listDir(currentPath: string, prefix: string, depth: number) {
    if (depth > 3) return; // Max depth

    const items = fs.readdirSync(currentPath);

    // Sort: directories first, then files
    const sorted = items.sort((a, b) => {
      const aIsDir = fs.statSync(path.join(currentPath, a)).isDirectory();
      const bIsDir = fs.statSync(path.join(currentPath, b)).isDirectory();
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a.localeCompare(b);
    });

    for (const item of sorted) {
      // Skip common unneeded directories
      if (['node_modules', '.git', '__pycache__', '.vscode', 'dist', 'build', '.next'].includes(item)) {
        entries.push(`${prefix}${item}/ (skipped)`);
        continue;
      }

      const itemPath = path.join(currentPath, item);
      const itemStats = fs.statSync(itemPath);

      if (itemStats.isDirectory()) {
        entries.push(`${prefix}${item}/`);
        if (recursive) {
          listDir(itemPath, prefix + '  ', depth + 1);
        }
      } else {
        const size = itemStats.size;
        const sizeStr = size < 1024 ? `${size}B` :
                        size < 1024 * 1024 ? `${Math.round(size / 1024)}KB` :
                        `${Math.round(size / (1024 * 1024))}MB`;
        entries.push(`${prefix}${item} (${sizeStr})`);
      }
    }
  }

  listDir(fullPath, '', 0);

  let result = `Directory: ${dirPath}/\n`;
  result += '─'.repeat(50) + '\n';
  result += entries.join('\n');

  return result;
}

async function getFileInfo(
  workspacePath: string,
  filePath: string
): Promise<string> {
  const fullPath = resolveWorkspacePath(workspacePath, filePath);
  if (!fullPath) {
    return 'Error: Cannot access files outside the workspace';
  }

  if (!fs.existsSync(fullPath)) {
    return `Error: File not found: ${filePath}`;
  }

  const stats = fs.statSync(fullPath);
  const ext = path.extname(filePath);

  let result = `File: ${filePath}\n`;
  result += '─'.repeat(50) + '\n';
  result += `Type: ${stats.isDirectory() ? 'Directory' : 'File'}\n`;
  result += `Size: ${stats.size} bytes (${Math.round(stats.size / 1024)}KB)\n`;
  result += `Extension: ${ext || 'none'}\n`;
  result += `Modified: ${stats.mtime.toISOString()}\n`;

  if (!stats.isDirectory() && stats.size < 50 * 1024) {
    // Show preview for small files
    const content = fs.readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');
    const preview = lines.slice(0, 10).join('\n');

    result += `\nPreview (first 10 lines):\n`;
    result += '─'.repeat(50) + '\n';
    result += preview;

    if (lines.length > 10) {
      result += `\n... (${lines.length - 10} more lines)`;
    }
  }

  return result;
}
