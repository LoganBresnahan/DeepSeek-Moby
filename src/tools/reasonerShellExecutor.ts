import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../utils/logger';

/**
 * Reasoner Shell Executor
 *
 * Allows the DeepSeek Reasoner (R1) model to execute shell commands
 * for exploring the codebase. Since R1 doesn't support native tool calling,
 * it outputs commands in <shell> tags which we parse and execute.
 *
 * Shell Selection:
 * - Linux/macOS: Uses system default shell (/bin/sh via shell: true).
 *   POSIX-compatible and handles DeepSeek's bash-style commands correctly.
 * - Windows: Detects and uses Git Bash (installed with Git for Windows).
 *   Required because cmd.exe/PowerShell can't run bash syntax (heredocs,
 *   pipes, grep, etc.). Falls back to cmd.exe if Git Bash not found.
 *
 * Security: Commands are validated against a blocklist before execution.
 * The CommandApprovalManager provides an additional layer of allowed/blocked rules.
 */

// ── Shell Resolution ──

let _resolvedShell: string | true | null = null;

/**
 * Resolve the shell to use for command execution.
 * On Windows, finds Git Bash. On Unix, returns true (OS default /bin/sh).
 * Cached after first call.
 */
export function resolveShell(): string | true {
  if (_resolvedShell !== null) return _resolvedShell;

  if (process.platform !== 'win32') {
    _resolvedShell = true;
    return _resolvedShell;
  }

  // Windows: find Git Bash
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];

  // Check PATH-based git to find its install directory
  try {
    const gitPath = cp.execSync('where git', { encoding: 'utf8', timeout: 3000 }).trim().split('\n')[0];
    if (gitPath) {
      // git.exe is typically at Git/cmd/git.exe — bash is at Git/bin/bash.exe
      const gitDir = path.dirname(path.dirname(gitPath));
      candidates.unshift(path.join(gitDir, 'bin', 'bash.exe'));
    }
  } catch {
    // git not in PATH
  }

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      _resolvedShell = candidate;
      logger.info(`[Shell] Using Git Bash: ${candidate}`);
      return _resolvedShell;
    } catch {
      continue;
    }
  }

  // Fallback: cmd.exe (commands may fail)
  logger.warn('[Shell] Git Bash not found on Windows. Shell commands may fail. Install Git for Windows for full compatibility.');
  _resolvedShell = true;
  return _resolvedShell;
}

/** Reset cached shell (for testing) */
export function resetResolvedShell(): void {
  _resolvedShell = null;
}

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
 * Long-running command patterns — commands that start servers, watch modes,
 * REPLs, or other processes that never exit on their own.
 *
 * These are NOT executed. Instead, a descriptive result is returned
 * telling the LLM the command was skipped and the user can run it manually.
 *
 * Users can also block commands via the Command Rules system for custom patterns.
 */
const LONG_RUNNING_PATTERNS: RegExp[] = [
  // ── JavaScript/TypeScript ──
  /\bnpm\s+run\s+(dev|start|serve|watch)\b/i,
  /\bnpm\s+start\b/i,
  /\bnpx\s+(vite|next|nuxt|live-server|serve|http-server|ts-node-dev|nodemon)\b/i,
  /\byarn\s+(dev|start|serve)\b/i,
  /\bpnpm\s+(dev|start|serve)\b/i,
  /\bbun\s+run\s+(dev|start|serve)\b/i,
  /\bnext\s+dev\b/i,
  /\bnodemon\b/i,
  /\blive-server\b/i,

  // ── Python ──
  /\bpython3?\s+-m\s+http\.server\b/i,
  /\bpython3?\s+manage\.py\s+runserver\b/i,
  /\bflask\s+run\b/i,
  /\buvicorn\b/i,
  /\bgunicorn\b/i,
  /\bfastapi\s+run\b/i,
  /\bjupyter\s+(lab|notebook)\b/i,
  /\bstreamlit\s+run\b/i,

  // ── Ruby ──
  /\brails\s+server\b/i,
  /\brails\s+s\b/i,
  /\bbundle\s+exec\s+(puma|unicorn|thin)\b/i,
  /\brackup\b/i,
  /\bguard\b/i,

  // ── Go ──
  /\bair\b/i,  // Go hot reload

  // ── Rust ──
  /\bcargo\s+watch\b/i,

  // ── Java ──
  /\bmvn\s+spring-boot:run\b/i,
  /\bgradlew?\s+bootRun\b/i,
  /\bmvn\s+jetty:run\b/i,

  // ── PHP ──
  /\bphp\s+-S\b/i,  // PHP built-in server
  /\bphp\s+artisan\s+serve\b/i,
  /\bphp\s+bin\/console\s+server:(start|run)\b/i,

  // ── C#/.NET ──
  /\bdotnet\s+watch\b/i,
  /\bdotnet\s+run\b/i,

  // ── Elixir ──
  /\bmix\s+phx\.server\b/i,
  /\biex\s+-S\s+mix\b/i,

  // ── Dart/Flutter ──
  /\bflutter\s+run\b/i,
  /\bdart_frog\s+dev\b/i,

  // ── General ──
  /\bredis-server\b/i,
  /\bmongod\b/i,
  /\bpostgres\b/i,
  /\bnginx\b/i,
];

/**
 * Strip heredoc bodies from a command string. Used before pattern matching
 * so that data inside `cat > file << 'EOF' ... EOF` doesn't trigger false
 * positives (e.g., a package.json containing "nodemon" as a dep).
 *
 * Handles: << EOF, << 'EOF', << "EOF", <<- EOF (any delimiter word).
 */
function stripHeredocs(command: string): string {
  return command.replace(/<<-?\s*['"]?(\w+)['"]?\s*\n[\s\S]*?^\s*\1\s*$/gm, '');
}

/**
 * Check if a command is a known long-running process (server, watch mode, etc.)
 * that should not be executed because it would never exit.
 *
 * Strips heredoc bodies before matching to avoid false positives where a
 * file's contents contain pattern keywords (e.g., package.json deps).
 */
export function isLongRunningCommand(command: string): boolean {
  const trimmed = stripHeredocs(command.trim());
  return LONG_RUNNING_PATTERNS.some(pattern => pattern.test(trimmed));
}

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
 * Strip unfenced SEARCH/REPLACE blocks from content (for display purposes).
 * These appear when the model emits SEARCH/REPLACE markers without wrapping them
 * in triple backticks. The DiffManager processes them as edits, but they would
 * leak into the rendered chat (markers visible, HTML rendering live, etc.).
 *
 * Matches: optional `# File: path` header followed by SEARCH/REPLACE block.
 */
export function stripUnfencedSearchReplace(content: string): string {
  // Strip "# File: path\n<<<<<<< SEARCH ... >>>>>>> REPLACE" blocks
  const withFileHeader = /^#\s*File:\s*.+?(?:\n|\r\n)[\s\S]*?>>>{3,}\s*REPLACE\s*$/gm;
  let result = content.replace(withFileHeader, '');
  // Strip any standalone SEARCH/REPLACE blocks (no preceding # File: header)
  const standalone = /<<<{3,}\s*SEARCH[\s\S]*?>>>{3,}\s*REPLACE/gi;
  result = result.replace(standalone, '');
  return result.trim();
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
 * Check if any shell commands delete files.
 * Detects rm, rm -f, rm -rf, unlink patterns.
 * Used to skip auto-continuation when R1 deletes files via shell.
 */
export function commandsDeleteFiles(commands: ShellCommand[]): boolean {
  return commands.some(cmd => {
    const c = cmd.command;
    if (/\brm\s/.test(c)) return true;
    if (/\bunlink\s/.test(c)) return true;
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
      shell: resolveShell(),
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

**CRITICAL: Shell commands MUST be inside <shell> tags to execute.**
- ✓ <shell>cat file.ts</shell> — EXECUTES
- ✗ \`\`\`bash\\ncat file.ts\\n\`\`\` — NOT executed (just rendered as text)
- ✗ \`\`\`sh\\ncat file.ts\\n\`\`\` — NOT executed
- ✗ Any markdown code block — NOT executed

If you write commands in \`\`\`bash or \`\`\`sh blocks, they will NOT run. You MUST use <shell> tags for every command you want executed.

**New files:** Use shell commands inside <shell> tags:
<shell>cat > path/to/file.ts << 'EOF'
// contents
EOF</shell>

NEVER write \`\`\`bash\\ncat > file << EOF...\\n\`\`\` — this will NOT create the file. Always use <shell>...</shell>.

**Editing existing files:** Use SEARCH/REPLACE (described in the edit format section below).

**Workflow:**
1. Explore with shell commands first (inside <shell> tags)
2. New files → shell with heredoc (inside <shell> tags)
3. Existing files → read first (inside <shell> tags), then SEARCH/REPLACE

If the user asks a question, answer it directly. Do NOT create or edit files for questions.
Complete tasks fully — don't stop after exploration. Every command you intend to run MUST be in <shell> tags.
`;
}
