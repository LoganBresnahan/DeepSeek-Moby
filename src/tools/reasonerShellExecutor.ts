import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { logger } from '../utils/logger';

/**
 * Reasoner Shell Executor
 *
 * Allows the DeepSeek Reasoner (R1) model to execute shell commands
 * for exploring the codebase. Since R1 doesn't support native tool calling,
 * it outputs commands in <shell> tags which we parse and execute.
 *
 * Security: Commands are executed read-only within the workspace directory.
 * Dangerous operations (rm, mv, write redirects) are blocked.
 */

export interface ShellCommand {
  command: string;
  index: number;  // Position in the response for tracking
}

export interface ShellResult {
  command: string;
  output: string;
  success: boolean;
  executionTimeMs: number;
  /** How the command was approved: 'auto' (rule matched), 'user-allowed', 'user-blocked', 'rule-blocked' */
  approvalStatus?: 'auto' | 'user-allowed' | 'user-blocked' | 'rule-blocked';
  /** Which reasoning iteration (0-based) produced this shell command */
  iterationIndex?: number;
}

// Minimal blocklist - only truly catastrophic operations
// Everything else is allowed - the LLM is trying to help, not destroy
const BLOCKED_PATTERNS: RegExp[] = [
  // Catastrophic file deletion
  /\brm\s+(-[rf]+\s+)*[\/~]/i,  // rm -rf / or rm -rf ~ (root or home deletion)

  // Privilege escalation
  /\bsudo\s/i,
  /\bsu\s+-/i,  // su with login shell

  // System control
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,

  // Disk destruction
  /\bdd\s+.*of=\/dev\//i,  // dd writing to devices
  /\bmkfs\b/i,             // formatting filesystems
];

/**
 * Parse <shell> tags from R1's response content
 */
export function parseShellCommands(content: string): ShellCommand[] {
  const commands: ShellCommand[] = [];

  // Match <shell>command</shell> tags
  const shellRegex = /<shell>([\s\S]*?)<\/shell>/gi;

  let match;
  while ((match = shellRegex.exec(content)) !== null) {
    const command = match[1].trim();
    if (command) {
      commands.push({
        command,
        index: match.index
      });
    }
  }

  return commands;
}

/**
 * Check if content contains any shell commands
 */
export function containsShellCommands(content: string): boolean {
  return /<shell>[\s\S]*?<\/shell>/i.test(content);
}

/**
 * Strip shell tags from content (for display purposes)
 */
export function stripShellTags(content: string): string {
  return content.replace(/<shell>[\s\S]*?<\/shell>/gi, '').trim();
}

// ── Web Search Tag Parsing ──
// R1 can't use tool calling API, so it outputs <web_search> tags instead.

export interface WebSearchQuery {
  query: string;
  index: number;
}

/**
 * Parse <web_search> tags from R1's response content
 */
export function parseWebSearchCommands(content: string): WebSearchQuery[] {
  const queries: WebSearchQuery[] = [];
  const regex = /<web_search>([\s\S]*?)<\/web_search>/gi;

  let match;
  while ((match = regex.exec(content)) !== null) {
    const query = match[1].trim();
    if (query) {
      queries.push({ query, index: match.index });
    }
  }

  return queries;
}

/**
 * Check if content contains any web search tags
 */
export function containsWebSearchCommands(content: string): boolean {
  return /<web_search>[\s\S]*?<\/web_search>/i.test(content);
}

/**
 * Strip web search tags from content (for display purposes)
 */
export function stripWebSearchTags(content: string): string {
  return content.replace(/<web_search>[\s\S]*?<\/web_search>/gi, '').trim();
}

/**
 * Check if content contains code edit patterns (SEARCH/REPLACE blocks)
 * Used to detect if R1 has actually produced code changes vs just exploration
 */
export function containsCodeEdits(content: string): boolean {
  // Match SEARCH/REPLACE blocks (inside code fences or unfenced)
  const searchReplacePattern = /<<<<<<< SEARCH[\s\S]*?=======[\s\S]*?>>>>>>> REPLACE/i;
  // Match # File: headers (indicates code edit intent)
  const fileHeaderPattern = /^#\s*File:\s*.+$/m;

  return searchReplacePattern.test(content) || fileHeaderPattern.test(content);
}

/**
 * Check if any shell commands create or write files.
 * Detects heredocs, output redirects (cat/echo/printf > file), and tee.
 * Used to skip auto-continuation when R1 creates files via shell instead of code blocks.
 */
export function commandsCreateFiles(commands: ShellCommand[]): boolean {
  return commands.some(cmd => {
    const c = cmd.command;
    // Heredoc: cat > file << 'EOF' (most common R1 file creation pattern)
    if (/<<[-\s]*['"]?\w+/.test(c)) return true;
    // Write redirect from cat/echo/printf to a file
    if (/\b(?:cat|echo|printf)\b.*?>/.test(c)) return true;
    // tee writing to a file
    if (/\btee\s/.test(c)) return true;
    return false;
  });
}

/**
 * Validate a command against security rules
 * Minimal validation - only block truly catastrophic operations
 *
 * @param command - The shell command to validate
 * @param allowAll - If true, skip validation (allowAllShellCommands setting)
 */
export function validateCommand(command: string, allowAll: boolean = false): { valid: boolean; reason?: string } {
  // Allow all commands if setting is enabled
  if (allowAll) {
    return { valid: true };
  }

  // Check for blocked patterns (catastrophic operations only)
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return {
        valid: false,
        reason: `Blocked: Potentially dangerous operation`
      };
    }
  }

  return { valid: true };
}

/**
 * Execute a shell command safely within the workspace
 */
export async function executeShellCommand(
  command: string,
  workspacePath: string,
  options: {
    timeout?: number;
    maxOutputSize?: number;
    allowAllCommands?: boolean;
    signal?: AbortSignal;
  } = {}
): Promise<ShellResult> {
  const startTime = Date.now();
  const timeout = options.timeout ?? 10000;
  const maxOutputSize = options.maxOutputSize ?? 100 * 1024;
  const allowAllCommands = options.allowAllCommands ?? false;

  // Check abort before starting
  if (options.signal?.aborted) {
    return {
      command,
      output: 'Interrupted',
      success: false,
      executionTimeMs: 0
    };
  }

  // Validate command first
  const validation = validateCommand(command, allowAllCommands);
  if (!validation.valid) {
    logger.warn(`[ReasonerShell] Command blocked: ${command} - ${validation.reason}`);
    return {
      command,
      output: validation.reason || 'Command blocked',
      success: false,
      executionTimeMs: Date.now() - startTime
    };
  }

  logger.info(`[ReasonerShell] Executing: ${command}`);

  return new Promise<ShellResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let resolved = false;

    const child = cp.spawn(command, {
      cwd: workspacePath,
      shell: true,
      env: { ...process.env },
    });

    // Timeout handling
    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 1000);
        const executionTimeMs = Date.now() - startTime;
        logger.warn(`[ReasonerShell] Command timed out after ${timeout}ms`);
        resolve({
          command,
          output: stdout + stderr + `\n(timed out after ${timeout}ms)`,
          success: false,
          executionTimeMs
        });
      }
    }, timeout);

    // Abort signal handling — kill the process immediately
    const onAbort = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 500);
        const executionTimeMs = Date.now() - startTime;
        logger.info(`[ReasonerShell] Command interrupted by user: ${command}`);
        resolve({
          command,
          output: (stdout + stderr).trim() || 'Interrupted',
          success: false,
          executionTimeMs
        });
      }
    };

    if (options.signal) {
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
      if (stdout.length > maxOutputSize) {
        stdout = stdout.substring(0, maxOutputSize) + '\n... (output truncated)';
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        if (options.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }

        const executionTimeMs = Date.now() - startTime;
        let output = stdout;
        if (stderr) {
          if (output) output += '\n';
          output += stderr;
        }
        if (output.length > maxOutputSize) {
          output = output.substring(0, maxOutputSize) + '\n... (output truncated)';
        }

        const success = code === 0;
        logger.info(`[ReasonerShell] Completed in ${executionTimeMs}ms, success: ${success}, output: ${output.length} chars`);

        resolve({
          command,
          output: output || '(no output)',
          success,
          executionTimeMs
        });
      }
    });

    child.on('error', (error: Error) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        if (options.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }

        const executionTimeMs = Date.now() - startTime;
        logger.error(`[ReasonerShell] Error: ${error.message}`);
        resolve({
          command,
          output: `Error: ${error.message}`,
          success: false,
          executionTimeMs
        });
      }
    });
  });
}

/**
 * Execute multiple shell commands and return all results.
 * Checks abort signal between each command.
 */
export async function executeShellCommands(
  commands: ShellCommand[],
  workspacePath: string,
  options: {
    allowAllCommands?: boolean;
    signal?: AbortSignal;
  } = {}
): Promise<ShellResult[]> {
  const results: ShellResult[] = [];

  for (const cmd of commands) {
    // Check abort between commands
    if (options.signal?.aborted) {
      results.push({
        command: cmd.command,
        output: 'Interrupted',
        success: false,
        executionTimeMs: 0
      });
      break;
    }

    const result = await executeShellCommand(cmd.command, workspacePath, {
      allowAllCommands: options.allowAllCommands,
      signal: options.signal
    });
    results.push(result);
  }

  return results;
}

/**
 * Format shell results for injection back into the conversation
 */
export function formatShellResultsForContext(results: ShellResult[]): string {
  if (results.length === 0) {
    return '';
  }

  let context = '\n--- Shell Command Results ---\n';

  for (const result of results) {
    context += `\n$ ${result.command}\n`;
    context += result.output;
    if (!result.success) {
      context += '\n(command failed)';
    }
    context += '\n';
  }

  context += '--- End Shell Results ---\n';

  return context;
}

/**
 * Get system prompt additions for reasoner model
 * This tells R1 how to use shell commands
 */
export function getReasonerShellPrompt(options?: { webSearchAvailable?: boolean }): string {
  const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  const webSearchAvailable = options?.webSearchAvailable ?? false;

  const webSearchSection = webSearchAvailable ? `

**Web Search:**
You can search the web for current information using <web_search> tags:

<web_search>latest React 19 features</web_search>
<web_search>TypeScript 5.4 release notes</web_search>

Use web search when you need up-to-date information, recent documentation, news, or anything not in your training data. Search results will be provided back to you.
` : '';

  return `
You have shell access. Run commands with <shell> tags:
<shell>cat src/file.ts</shell>
<shell>grep -rn "function" src/</shell>

System: ${platform}. Commands run in the workspace directory.${webSearchSection}

**New files:** Use shell commands:
<shell>cat > path/to/file.ts << 'EOF'
// contents
EOF</shell>

**Editing existing files:** Use SEARCH/REPLACE (described in the edit format section below).

**Workflow:**
1. Explore with shell commands first
2. New files → shell (cat > file << 'EOF')
3. Existing files → read first, then SEARCH/REPLACE

If the user asks a question, answer it directly. Do NOT create or edit files for questions.
Complete tasks fully — don't stop after exploration.
`;
}
