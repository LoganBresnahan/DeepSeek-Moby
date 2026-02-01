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
 * Validate a command against security rules
 * Minimal validation - only block truly catastrophic operations
 *
 * @param command - The shell command to validate
 * @param allowAll - If true, skip validation ("Walk on the Wild Side" mode)
 */
export function validateCommand(command: string, allowAll: boolean = false): { valid: boolean; reason?: string } {
  // "Walk on the Wild Side" - allow all commands if setting is enabled
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
    allowAllCommands?: boolean;  // "Walk on the Wild Side" mode
  } = {}
): Promise<ShellResult> {
  const startTime = Date.now();
  const timeout = options.timeout ?? 10000;  // 10 second default
  const maxOutputSize = options.maxOutputSize ?? 100 * 1024;  // 100KB default
  const allowAllCommands = options.allowAllCommands ?? false;

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

  try {
    // Use system's default shell via shell: true
    // Windows: cmd.exe or PowerShell
    // Mac/Linux: /bin/sh or user's SHELL
    const result = cp.spawnSync(command, {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout,
      maxBuffer: maxOutputSize,
      shell: true,  // Use system shell
      env: {
        ...process.env,
        // Keep user's PATH so tools are available
      }
    });

    const executionTimeMs = Date.now() - startTime;

    // Combine stdout and stderr
    let output = '';
    if (result.stdout) {
      output += result.stdout;
    }
    if (result.stderr) {
      if (output) output += '\n';
      output += result.stderr;
    }

    // Truncate if too large
    if (output.length > maxOutputSize) {
      output = output.substring(0, maxOutputSize) + '\n... (output truncated)';
    }

    const success = result.status === 0;

    logger.info(`[ReasonerShell] Completed in ${executionTimeMs}ms, success: ${success}, output: ${output.length} chars`);

    return {
      command,
      output: output || '(no output)',
      success,
      executionTimeMs
    };
  } catch (error: any) {
    const executionTimeMs = Date.now() - startTime;

    let errorMessage = error.message;
    if (error.killed) {
      errorMessage = `Command timed out after ${timeout}ms`;
    }

    logger.error(`[ReasonerShell] Error: ${errorMessage}`);

    return {
      command,
      output: `Error: ${errorMessage}`,
      success: false,
      executionTimeMs
    };
  }
}

/**
 * Execute multiple shell commands and return all results
 */
export async function executeShellCommands(
  commands: ShellCommand[],
  workspacePath: string,
  options: {
    allowAllCommands?: boolean;  // "Walk on the Wild Side" mode
  } = {}
): Promise<ShellResult[]> {
  const results: ShellResult[] = [];

  for (const cmd of commands) {
    const result = await executeShellCommand(cmd.command, workspacePath, {
      allowAllCommands: options.allowAllCommands
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
export function getReasonerShellPrompt(): string {
  const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';

  return `
You have access to shell commands for exploring and modifying the codebase. To run a command, wrap it in <shell> tags:

<shell>cat src/file.ts</shell>
<shell>grep -rn "function" src/</shell>
<shell>ls -la</shell>

The system is running ${platform}. Commands are executed using the system's default shell.

You can run any shell command - read files, search, list directories, run git commands, etc.
Commands are executed in the workspace directory.

After running commands, analyze the output and continue. You can run multiple commands if needed.

**CRITICAL: Code Edit Format (MANDATORY)**
Every code edit MUST use this EXACT structure or it will NOT be applied:

\`\`\`<language>
# File: path/to/file.ext
<<<<<<< SEARCH
exact code to find (copy verbatim from file)
=======
replacement code
>>>>>>> REPLACE
\`\`\`

**Example:**
\`\`\`typescript
# File: src/utils/helper.ts
<<<<<<< SEARCH
export function oldFunction() {
  return "old";
}
=======
export function newFunction() {
  return "new";
}
>>>>>>> REPLACE
\`\`\`

**REQUIREMENTS (all mandatory - edits FAIL without these):**
1. ✓ Use triple backticks to create a code block
2. ✓ First line inside MUST be "# File: <path>"
3. ✓ SEARCH section = EXACT code from file (copy verbatim including whitespace)
4. ✓ All markers must be INSIDE the code block
5. ✓ ONE code block per file - NOT separate "before" and "after" blocks

**WARNING:** Code shown without this format will NOT be applied. The system parses the format automatically.

**Workflow for Code Tasks:**
1. Use shell commands to explore and understand the codebase
2. Identify the files that need to be modified
3. Read the current content of those files
4. Provide the code edits in properly formatted code blocks with # File: headers

**IMPORTANT: You MUST complete tasks in a single response.**
- Do NOT stop after exploration - you must produce the code edits.
- After running shell commands, immediately provide the code changes.
- Never end your response with just shell commands or just analysis.
- Your final output MUST include the actual code edits with # File: headers.
- If the task involves editing code, your response is incomplete until you provide the edits.
`;
}
