import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { Tool, ToolCall } from '../deepseekClient';

/**
 * Workspace tools that allow the LLM to explore and read files in the codebase.
 */

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
      name: 'search_files',
      description: 'Search for files in the workspace by name pattern. Returns a list of matching file paths.',
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
      name: 'grep_content',
      description: 'Search for text or patterns within file contents. Similar to grep/ripgrep. Returns matching lines with file paths and line numbers.',
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
      name: 'get_file_info',
      description: 'Get information about a file including its size, type, and a preview of its contents.',
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

// Apply code edit tool - for chat model only (reasoner can't use tools)
// Provides structured output with guaranteed file path
export const applyCodeEditTool: Tool = {
  type: 'function',
  function: {
    name: 'apply_code_edit',
    description: 'Apply code changes to a specific file. Use this when you want to edit or update code in a file. This ensures the file path is correctly specified.',
    parameters: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'The relative path to the file to edit (e.g., "src/index.ts", "CHANGELOG.md")'
        },
        code: {
          type: 'string',
          description: 'The code content to apply. Use SEARCH/REPLACE format for edits or full content for new code.'
        },
        language: {
          type: 'string',
          description: 'The programming language of the code (e.g., "typescript", "javascript", "markdown")'
        },
        description: {
          type: 'string',
          description: 'Brief description of what this edit does'
        }
      },
      required: ['file', 'code']
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

      case 'search_files':
        return await searchFiles(workspacePath, args.pattern, args.maxResults);

      case 'grep_content':
        return await grepContent(workspacePath, args.query, args.filePattern, args.maxResults);

      case 'list_directory':
        return await listDirectory(workspacePath, args.path || '.', args.recursive === 'true');

      case 'get_file_info':
        return await getFileInfo(workspacePath, args.path);

      case 'apply_code_edit':
        // This tool doesn't execute anything - it's for signaling edit intent with structured file path
        // The file path tracking happens in chatProvider.ts
        return `Acknowledged: Code edit for file "${args.file}" will be applied. ${args.description || ''}`;

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
  const fullPath = path.join(workspacePath, filePath);

  // Security check: ensure path is within workspace
  if (!fullPath.startsWith(workspacePath)) {
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
  const fullPath = path.join(workspacePath, dirPath);

  // Security check
  if (!fullPath.startsWith(workspacePath)) {
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
  const fullPath = path.join(workspacePath, filePath);

  if (!fullPath.startsWith(workspacePath)) {
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
