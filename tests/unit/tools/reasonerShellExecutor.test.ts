/**
 * Unit tests for Reasoner Shell Executor
 *
 * Tests the pure parsing functions that don't depend on vscode or logger.
 * We test by re-implementing the regex patterns here to avoid import issues.
 */

import { describe, it, expect } from 'vitest';
import { isLongRunningCommand, formatShellResultsForContext, validateCommand } from '../../../src/tools/reasonerShellExecutor';

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

// Web search tag parsing (mirrors reasonerShellExecutor.ts)

function parseWebSearchCommands(content: string): Array<{ query: string; index: number }> {
  const queries: Array<{ query: string; index: number }> = [];
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

function containsWebSearchCommands(content: string): boolean {
  return /<web_search>[\s\S]*?<\/web_search>/i.test(content);
}

function stripWebSearchTags(content: string): string {
  return content.replace(/<web_search>[\s\S]*?<\/web_search>/gi, '').trim();
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
      expect(validateCommand('rm -rf /*').valid).toBe(false);
      expect(validateCommand('rm -rf ~').valid).toBe(false);
      expect(validateCommand('rm -rf ~/').valid).toBe(false);
      expect(validateCommand('rm -f /').valid).toBe(false);
      expect(validateCommand('rm -rf / ').valid).toBe(false); // trailing space
    });

    it('allows safe rm commands', () => {
      // Removing specific files/directories in workspace is allowed
      expect(validateCommand('rm file.txt').valid).toBe(true);
      expect(validateCommand('rm -rf node_modules').valid).toBe(true);
      expect(validateCommand('rm -rf ./build').valid).toBe(true);
    });

    it('allows rm with absolute paths that target something specific', () => {
      // Regression: the old regex matched any `rm` with a `/`-starting path,
      // so `rm -f /home/user/foo.txt` was wrongly blocked. Only bare-root /
      // bare-home targets should trip the catastrophic guard.
      expect(validateCommand('rm /home/user/foo.txt').valid).toBe(true);
      expect(validateCommand('rm -f /home/user/foo.txt').valid).toBe(true);
      expect(validateCommand('rm -rf /home/user/build').valid).toBe(true);
      expect(validateCommand('rm -rf ~/Downloads/foo.zip').valid).toBe(true);
      expect(validateCommand('rm -rf /tmp/workdir').valid).toBe(true);
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

    describe('allowAll bypass', () => {
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

    describe('approval-status bypass', () => {
      it('bypasses the blocklist when user explicitly approved', () => {
        // The user already saw the command in the approval UI and clicked
        // "allow" — the executor has no business second-guessing them.
        expect(validateCommand('rm -rf /', false, 'user-allowed').valid).toBe(true);
        expect(validateCommand('sudo apt install pkg', false, 'user-allowed').valid).toBe(true);
      });

      it('bypasses the blocklist when a user-created rule auto-approved', () => {
        // `'auto'` means a persistent rule the user set previously matched.
        // Same trust level as a just-now approval.
        expect(validateCommand('rm -rf /', false, 'auto').valid).toBe(true);
        expect(validateCommand('shutdown now', false, 'auto').valid).toBe(true);
      });

      it('still runs the blocklist when approvalStatus is missing', () => {
        // Defensive: if a caller forgets to tag, fall back to safe default.
        expect(validateCommand('rm -rf /').valid).toBe(false);
        expect(validateCommand('rm -rf /', false, undefined).valid).toBe(false);
      });

      it('still runs the blocklist for user-blocked and rule-blocked', () => {
        // These statuses mean the command was rejected upstream and shouldn't
        // be executed anyway, but defensively the blocklist still applies.
        expect(validateCommand('rm -rf /', false, 'user-blocked').valid).toBe(false);
        expect(validateCommand('rm -rf /', false, 'rule-blocked').valid).toBe(false);
      });
    });
  });

  // ── Web Search Tag Parsing ──

  describe('parseWebSearchCommands', () => {
    it('parses single web search query', () => {
      const content = 'Let me look that up:\n<web_search>latest React 19 features</web_search>';
      const queries = parseWebSearchCommands(content);

      expect(queries).toHaveLength(1);
      expect(queries[0].query).toBe('latest React 19 features');
    });

    it('parses multiple web search queries', () => {
      const content = `
        <web_search>TypeScript 5.4 release notes</web_search>
        Some analysis here.
        <web_search>Vite 6 migration guide</web_search>
      `;
      const queries = parseWebSearchCommands(content);

      expect(queries).toHaveLength(2);
      expect(queries[0].query).toBe('TypeScript 5.4 release notes');
      expect(queries[1].query).toBe('Vite 6 migration guide');
    });

    it('handles empty content', () => {
      expect(parseWebSearchCommands('')).toEqual([]);
    });

    it('handles content without web search tags', () => {
      expect(parseWebSearchCommands('No web search here')).toEqual([]);
    });

    it('ignores empty web search tags', () => {
      const content = '<web_search></web_search><web_search>   </web_search><web_search>actual query</web_search>';
      const queries = parseWebSearchCommands(content);

      expect(queries).toHaveLength(1);
      expect(queries[0].query).toBe('actual query');
    });

    it('records correct index positions', () => {
      const content = 'prefix <web_search>query</web_search>';
      const queries = parseWebSearchCommands(content);

      expect(queries[0].index).toBe(7); // position of <web_search>
    });
  });

  describe('containsWebSearchCommands', () => {
    it('returns true for content with web_search tags', () => {
      expect(containsWebSearchCommands('<web_search>test</web_search>')).toBe(true);
    });

    it('returns false for content without web_search tags', () => {
      expect(containsWebSearchCommands('No web search')).toBe(false);
    });

    it('is case insensitive', () => {
      expect(containsWebSearchCommands('<WEB_SEARCH>test</WEB_SEARCH>')).toBe(true);
      expect(containsWebSearchCommands('<Web_Search>test</Web_Search>')).toBe(true);
    });

    it('does not match shell tags', () => {
      expect(containsWebSearchCommands('<shell>ls</shell>')).toBe(false);
    });
  });

  describe('stripWebSearchTags', () => {
    it('removes web_search tags from content', () => {
      const content = 'Text before <web_search>query</web_search> text after';
      expect(stripWebSearchTags(content)).toBe('Text before  text after');
    });

    it('removes multiple web_search tags', () => {
      const content = '<web_search>q1</web_search> middle <web_search>q2</web_search>';
      expect(stripWebSearchTags(content)).toBe('middle');
    });

    it('handles content without web_search tags', () => {
      expect(stripWebSearchTags('No tags')).toBe('No tags');
    });

    it('does not remove shell tags', () => {
      const content = '<shell>ls</shell> and <web_search>query</web_search>';
      expect(stripWebSearchTags(content)).toBe('<shell>ls</shell> and');
    });
  });

  describe('mixed shell and web_search tags', () => {
    it('both tag types can coexist in same content', () => {
      const content = `
        <shell>ls -la</shell>
        <web_search>TypeScript docs</web_search>
        <shell>cat package.json</shell>
      `;

      expect(containsShellCommands(content)).toBe(true);
      expect(containsWebSearchCommands(content)).toBe(true);

      const shellCmds = parseShellCommands(content);
      expect(shellCmds).toHaveLength(2);

      const webQueries = parseWebSearchCommands(content);
      expect(webQueries).toHaveLength(1);
    });

    it('stripping each tag type is independent', () => {
      const content = '<shell>cmd</shell> text <web_search>query</web_search>';

      const strippedShell = stripShellTags(content);
      expect(strippedShell).toContain('<web_search>');
      expect(strippedShell).not.toContain('<shell>');

      const strippedWeb = stripWebSearchTags(content);
      expect(strippedWeb).toContain('<shell>');
      expect(strippedWeb).not.toContain('<web_search>');
    });
  });

  // Regression tests for ADR 0002: heredoc bodies must be stripped before
  // long-running pattern matching so that file contents (e.g. package.json deps
  // containing "nodemon") don't trigger false positives and get silently skipped.
  describe('isLongRunningCommand (ADR 0002 heredoc stripping)', () => {
    it('does not flag cat > package.json heredoc that mentions nodemon in deps', () => {
      const command = [
        "cat > package.json << 'EOF'",
        '{',
        '  "name": "tictactoe",',
        '  "devDependencies": {',
        '    "nodemon": "^3.0.0"',
        '  }',
        '}',
        'EOF',
      ].join('\n');
      expect(isLongRunningCommand(command)).toBe(false);
    });

    it('does not flag heredoc mentioning live-server or vite in package body', () => {
      const command = [
        'cat > package.json <<EOF',
        '{ "devDependencies": { "live-server": "^1.0.0", "vite": "^5.0.0" } }',
        'EOF',
      ].join('\n');
      expect(isLongRunningCommand(command)).toBe(false);
    });

    it('handles quoted and indented heredoc delimiters', () => {
      const singleQuoted = "cat > f.json << 'EOF'\n{ \"nodemon\": \"x\" }\nEOF";
      const doubleQuoted = 'cat > f.json << "EOF"\n{ "nodemon": "x" }\nEOF';
      const dashHeredoc = "cat > f.json <<- EOF\n\t{ \"nodemon\": \"x\" }\nEOF";
      expect(isLongRunningCommand(singleQuoted)).toBe(false);
      expect(isLongRunningCommand(doubleQuoted)).toBe(false);
      expect(isLongRunningCommand(dashHeredoc)).toBe(false);
    });

    it('still flags genuine long-running invocations', () => {
      expect(isLongRunningCommand('nodemon server.js')).toBe(true);
      expect(isLongRunningCommand('npm run dev')).toBe(true);
      expect(isLongRunningCommand('npx live-server')).toBe(true);
    });

    it('still flags long-running command outside a heredoc in the same string', () => {
      // The heredoc body is stripped, but content outside it is still checked.
      const command = [
        "cat > config.json << 'EOF'",
        '{ "safe": "content" }',
        'EOF',
        '&& nodemon server.js',
      ].join('\n');
      expect(isLongRunningCommand(command)).toBe(true);
    });
  });

  // B: Ground-truth path feedback in shell results.
  // Regression test for R1 losing track of where files landed when it mixed
  // `cat > file << EOF` with `cd X` in separate <shell> blocks.
  describe('formatShellResultsForContext — absolute path feedback', () => {
    const fakeResult = (command: string, output: string, success = true) => ({
      command,
      output,
      success,
      executionTimeMs: 10,
    });

    it('returns empty string when there is nothing to report', () => {
      expect(formatShellResultsForContext([])).toBe('');
      expect(formatShellResultsForContext([], {})).toBe('');
      expect(
        formatShellResultsForContext([], { modifiedFiles: [], deletedFiles: [] })
      ).toBe('');
    });

    it('preserves legacy format when no fileChanges are provided', () => {
      const out = formatShellResultsForContext([
        fakeResult('ls', 'a.ts\nb.ts'),
      ]);
      expect(out).toContain('--- Shell Command Results ---');
      expect(out).toContain('$ ls');
      expect(out).toContain('a.ts\nb.ts');
      expect(out).toContain('--- End Shell Results ---');
      // No "Files touched" section without fileChanges.
      expect(out).not.toContain('Files touched');
    });

    it('appends absolute paths when modifiedFiles + workspacePath are provided', () => {
      const out = formatShellResultsForContext(
        [fakeResult("cat > package.json << 'EOF'\n...\nEOF", '(no output)')],
        {
          modifiedFiles: ['package.json', 'src/index.ts'],
          workspacePath: '/home/user/project',
        }
      );
      expect(out).toContain('--- Files touched by this command (absolute paths) ---');
      expect(out).toContain('modified: /home/user/project/package.json');
      expect(out).toContain('modified: /home/user/project/src/index.ts');
      expect(out).toContain('--- End Files Touched ---');
    });

    it('flags deleted files distinctly from modified', () => {
      const out = formatShellResultsForContext(
        [fakeResult('rm old.ts', '')],
        {
          modifiedFiles: [],
          deletedFiles: ['old.ts'],
          workspacePath: '/work',
        }
      );
      expect(out).toContain('deleted:  /work/old.ts');
      expect(out).not.toContain('modified: /work/old.ts');
    });

    it('leaves paths workspace-relative when workspacePath is omitted', () => {
      const out = formatShellResultsForContext(
        [fakeResult('ls', '')],
        { modifiedFiles: ['src/x.ts'] }
      );
      expect(out).toContain('modified: src/x.ts');
      expect(out).not.toMatch(/modified: \//); // no leading slash, not absolute
    });

    it('handles Windows-style workspacePath with backslashes', () => {
      const out = formatShellResultsForContext(
        [fakeResult('ls', '')],
        {
          modifiedFiles: ['src\\index.ts'],
          workspacePath: 'C:\\Users\\me\\project',
        }
      );
      expect(out).toContain('modified: C:\\Users\\me\\project\\src\\index.ts');
    });

    it('emits files-touched section even if results array is empty', () => {
      // Edge case: some call sites may format fileChanges alone.
      const out = formatShellResultsForContext([], {
        modifiedFiles: ['a.ts'],
        workspacePath: '/p',
      });
      expect(out).toContain('modified: /p/a.ts');
      expect(out).not.toContain('Shell Command Results');
    });

    it('includes a guidance line pointing R1 at absolute paths as ground truth', () => {
      const out = formatShellResultsForContext(
        [fakeResult("cd subdir && cat > file.ts << 'EOF'\n...\nEOF", '(no output)')],
        {
          modifiedFiles: ['subdir/file.ts'],
          workspacePath: '/work',
        }
      );
      // The guidance is the whole point — it teaches R1 to trust paths over
      // its mental model of cwd.
      expect(out).toMatch(/ground truth/i);
    });
  });
});
