/**
 * Unit tests for Reasoner Shell Executor
 *
 * Tests the pure parsing functions that don't depend on vscode or logger.
 * We test by re-implementing the regex patterns here to avoid import issues.
 */

import { describe, it, expect } from 'vitest';

// Re-implement the pure functions for testing (same logic as reasonerShellExecutor.ts)
// This avoids importing the module which has vscode dependencies

function parseShellCommands(content: string): Array<{ command: string; index: number }> {
  const commands: Array<{ command: string; index: number }> = [];
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

function containsShellCommands(content: string): boolean {
  return /<shell>[\s\S]*?<\/shell>/i.test(content);
}

function stripShellTags(content: string): string {
  return content.replace(/<shell>[\s\S]*?<\/shell>/gi, '').trim();
}

function containsCodeEdits(content: string): boolean {
  const searchReplacePattern = /<<<<<<< SEARCH[\s\S]*?=======[\s\S]*?>>>>>>> REPLACE/i;
  const fileHeaderPattern = /^#\s*File:\s*.+$/m;
  return searchReplacePattern.test(content) || fileHeaderPattern.test(content);
}

function commandsCreateFiles(commands: Array<{ command: string; index: number }>): boolean {
  return commands.some(cmd => {
    const c = cmd.command;
    if (/<<[-\s]*['"]?\w+/.test(c)) return true;
    if (/\b(?:cat|echo|printf)\b.*?>/.test(c)) return true;
    if (/\btee\s/.test(c)) return true;
    return false;
  });
}

const BLOCKED_PATTERNS: RegExp[] = [
  /\brm\s+(-[rf]+\s+)*[\/~]/i,
  /\bsudo\s/i,
  /\bsu\s+-/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\bdd\s+.*of=\/dev\//i,
  /\bmkfs\b/i,
];

function validateCommand(command: string, allowAll: boolean = false): { valid: boolean; reason?: string } {
  // "Walk on the Wild Side" - allow all commands if setting is enabled
  if (allowAll) {
    return { valid: true };
  }

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

describe('reasonerShellExecutor', () => {
  describe('parseShellCommands', () => {
    it('parses single shell command', () => {
      const content = 'Let me check the file:\n<shell>cat package.json</shell>';
      const commands = parseShellCommands(content);

      expect(commands).toHaveLength(1);
      expect(commands[0].command).toBe('cat package.json');
    });

    it('parses multiple shell commands', () => {
      const content = `
        First, let me list files:
        <shell>ls -la</shell>
        Then check the source:
        <shell>cat src/index.ts</shell>
      `;
      const commands = parseShellCommands(content);

      expect(commands).toHaveLength(2);
      expect(commands[0].command).toBe('ls -la');
      expect(commands[1].command).toBe('cat src/index.ts');
    });

    it('handles multiline commands', () => {
      const content = '<shell>grep -rn "function" src/\n  --include="*.ts"</shell>';
      const commands = parseShellCommands(content);

      expect(commands).toHaveLength(1);
      expect(commands[0].command).toContain('grep -rn');
    });

    it('handles empty content', () => {
      expect(parseShellCommands('')).toEqual([]);
    });

    it('handles content without shell tags', () => {
      expect(parseShellCommands('No shell commands here')).toEqual([]);
    });

    it('ignores empty shell tags', () => {
      const content = '<shell></shell><shell>   </shell><shell>actual command</shell>';
      const commands = parseShellCommands(content);

      expect(commands).toHaveLength(1);
      expect(commands[0].command).toBe('actual command');
    });
  });

  describe('containsShellCommands', () => {
    it('returns true for content with shell tags', () => {
      expect(containsShellCommands('<shell>ls</shell>')).toBe(true);
    });

    it('returns false for content without shell tags', () => {
      expect(containsShellCommands('No commands')).toBe(false);
    });

    it('is case insensitive', () => {
      expect(containsShellCommands('<SHELL>ls</SHELL>')).toBe(true);
      expect(containsShellCommands('<Shell>ls</Shell>')).toBe(true);
    });
  });

  describe('stripShellTags', () => {
    it('removes shell tags from content', () => {
      const content = 'Text before <shell>ls</shell> text after';
      expect(stripShellTags(content)).toBe('Text before  text after');
    });

    it('removes multiple shell tags', () => {
      const content = '<shell>cmd1</shell> middle <shell>cmd2</shell>';
      expect(stripShellTags(content)).toBe('middle');
    });

    it('handles content without shell tags', () => {
      expect(stripShellTags('No tags')).toBe('No tags');
    });
  });

  describe('containsCodeEdits', () => {
    it('returns true for SEARCH/REPLACE blocks', () => {
      const content = `
        Here's the fix:
        \`\`\`typescript
        # File: src/index.ts
        <<<<<<< SEARCH
        const old = 1;
        =======
        const newValue = 2;
        >>>>>>> REPLACE
        \`\`\`
      `;
      expect(containsCodeEdits(content)).toBe(true);
    });

    it('returns true for # File: headers at line start', () => {
      const content = `Here is the code:
# File: src/utils.ts
Some code here`;
      expect(containsCodeEdits(content)).toBe(true);
    });

    it('returns false for content without code edits', () => {
      const content = `
        Let me explore the codebase:
        <shell>ls src/</shell>
        The directory contains several files.
      `;
      expect(containsCodeEdits(content)).toBe(false);
    });

    it('returns false for plain text with search/replace words', () => {
      const content = 'You can search and replace text in your editor.';
      expect(containsCodeEdits(content)).toBe(false);
    });

    it('handles unfenced SEARCH/REPLACE blocks', () => {
      const content = `
        <<<<<<< SEARCH
        old code
        =======
        new code
        >>>>>>> REPLACE
      `;
      expect(containsCodeEdits(content)).toBe(true);
    });

    it('handles File: with different spacing', () => {
      expect(containsCodeEdits('#File: test.ts')).toBe(true);
      expect(containsCodeEdits('#  File: test.ts')).toBe(true);
      expect(containsCodeEdits('# File:test.ts')).toBe(true);
      // Line must start with # (potentially with leading whitespace in multiline string)
      expect(containsCodeEdits('Some text\n# File: test.ts\nmore text')).toBe(true);
    });
  });

  describe('commandsCreateFiles', () => {
    const cmd = (command: string) => [{ command, index: 0 }];

    it('detects heredoc file creation', () => {
      expect(commandsCreateFiles(cmd("cat > file.txt << 'EOF'\ncontent\nEOF"))).toBe(true);
      expect(commandsCreateFiles(cmd('cat > src/main.c << EOF\n#include\nEOF'))).toBe(true);
      expect(commandsCreateFiles(cmd("cat > Makefile <<- 'HEREDOC'\nall:\nHEREDOC"))).toBe(true);
    });

    it('detects cat/echo/printf redirects', () => {
      expect(commandsCreateFiles(cmd('cat > file.txt'))).toBe(true);
      expect(commandsCreateFiles(cmd('echo "hello" > output.txt'))).toBe(true);
      expect(commandsCreateFiles(cmd('printf "%s" "data" > result.json'))).toBe(true);
    });

    it('detects tee commands', () => {
      expect(commandsCreateFiles(cmd('tee file.txt'))).toBe(true);
      expect(commandsCreateFiles(cmd('echo "data" | tee output.log'))).toBe(true);
    });

    it('returns false for read-only commands', () => {
      expect(commandsCreateFiles(cmd('ls -la'))).toBe(false);
      expect(commandsCreateFiles(cmd('cat file.txt'))).toBe(false);
      expect(commandsCreateFiles(cmd('grep -rn "pattern" src/'))).toBe(false);
      expect(commandsCreateFiles(cmd('find . -name "*.ts"'))).toBe(false);
      expect(commandsCreateFiles(cmd('git status'))).toBe(false);
    });

    it('returns false for /dev/null redirects', () => {
      // These redirect stderr/stdout to /dev/null, not file creation
      expect(commandsCreateFiles(cmd('find . -name "*.ts" 2>/dev/null'))).toBe(false);
    });

    it('detects file creation in mixed command lists', () => {
      const commands = [
        { command: 'ls -la', index: 0 },
        { command: 'mkdir -p src', index: 1 },
        { command: "cat > src/index.ts << 'EOF'\nconsole.log('hi')\nEOF", index: 2 },
      ];
      expect(commandsCreateFiles(commands)).toBe(true);
    });

    it('returns false for empty command list', () => {
      expect(commandsCreateFiles([])).toBe(false);
    });
  });

  describe('validateCommand', () => {
    it('allows safe read operations', () => {
      expect(validateCommand('cat file.txt').valid).toBe(true);
      expect(validateCommand('ls -la').valid).toBe(true);
      expect(validateCommand('grep -rn "test" src/').valid).toBe(true);
      expect(validateCommand('find . -name "*.ts"').valid).toBe(true);
    });

    it('allows git commands', () => {
      expect(validateCommand('git status').valid).toBe(true);
      expect(validateCommand('git log --oneline').valid).toBe(true);
      expect(validateCommand('git diff HEAD~1').valid).toBe(true);
    });

    it('allows npm/node commands', () => {
      expect(validateCommand('npm test').valid).toBe(true);
      expect(validateCommand('npm install lodash').valid).toBe(true);
      expect(validateCommand('node script.js').valid).toBe(true);
    });

    it('blocks catastrophic rm commands', () => {
      expect(validateCommand('rm -rf /').valid).toBe(false);
      expect(validateCommand('rm -rf ~').valid).toBe(false);
      expect(validateCommand('rm -rf ~/').valid).toBe(false);
    });

    it('allows safe rm commands', () => {
      // Removing specific files/directories in workspace is allowed
      expect(validateCommand('rm file.txt').valid).toBe(true);
      expect(validateCommand('rm -rf node_modules').valid).toBe(true);
      expect(validateCommand('rm -rf ./build').valid).toBe(true);
    });

    it('blocks sudo commands', () => {
      expect(validateCommand('sudo rm file.txt').valid).toBe(false);
      expect(validateCommand('sudo apt install pkg').valid).toBe(false);
    });

    it('blocks su commands', () => {
      expect(validateCommand('su - root').valid).toBe(false);
    });

    it('blocks system control commands', () => {
      expect(validateCommand('shutdown now').valid).toBe(false);
      expect(validateCommand('reboot').valid).toBe(false);
      expect(validateCommand('poweroff').valid).toBe(false);
    });

    it('blocks disk destruction commands', () => {
      expect(validateCommand('dd if=/dev/zero of=/dev/sda').valid).toBe(false);
      expect(validateCommand('mkfs.ext4 /dev/sda1').valid).toBe(false);
    });

    describe('Walk on the Wild Side (allowAll)', () => {
      it('allows blocked commands when allowAll is true', () => {
        // These would normally be blocked
        expect(validateCommand('rm -rf /', true).valid).toBe(true);
        expect(validateCommand('sudo rm file.txt', true).valid).toBe(true);
        expect(validateCommand('shutdown now', true).valid).toBe(true);
        expect(validateCommand('dd if=/dev/zero of=/dev/sda', true).valid).toBe(true);
      });

      it('still validates normally when allowAll is false', () => {
        expect(validateCommand('rm -rf /', false).valid).toBe(false);
        expect(validateCommand('cat file.txt', false).valid).toBe(true);
      });

      it('defaults to false when allowAll not specified', () => {
        expect(validateCommand('rm -rf /').valid).toBe(false);
        expect(validateCommand('cat file.txt').valid).toBe(true);
      });
    });
  });
});
