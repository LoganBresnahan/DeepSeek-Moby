# 0002. Strip heredocs before long-running command pattern matching

**Status:** Accepted
**Date:** 2026-04-17

## Context

`isLongRunningCommand()` in [reasonerShellExecutor.ts](../../../src/tools/reasonerShellExecutor.ts) checks shell commands against a list of regex patterns (~50 patterns covering `npm run dev`, `nodemon`, `vite`, `live-server`, `flask run`, etc.) to detect commands that would never exit. Detected commands are skipped — R1 is told the command was skipped and the user can run it manually.

Several patterns use `\b` word boundaries but match the keyword anywhere in the string (e.g., `/\bnodemon\b/i`, `/\blive-server\b/i`). When R1 generates a `package.json` via heredoc:

```bash
cat > package.json << 'EOF'
{
  "devDependencies": {
    "nodemon": "^3.0.0"
  }
}
EOF
```

…the entire heredoc string contains `nodemon`, so `isLongRunningCommand()` returns true and the file creation is silently skipped. The bug surfaced when R1 was building a TypeScript project: three consecutive `cat > package.json` attempts were skipped because the dependency list happened to contain a triggering word, until R1 simplified the deps and the fourth attempt slipped through.

This is a precision failure: the patterns are meant to detect *invocations* of long-running tools, not *mentions* of them in data.

## Decision

Strip heredoc bodies (`<< 'EOF' ... EOF`, `<< EOF ... EOF`, `<< "EOF" ... EOF`, `<<- EOF ... EOF`) from the command string before running pattern matching. The stripping is local to `isLongRunningCommand()` — the command itself is still executed in full.

```typescript
function stripHeredocs(command: string): string {
  return command.replace(/<<-?\s*['"]?(\w+)['"]?\s*\n[\s\S]*?^\s*\1\s*$/gm, '');
}

export function isLongRunningCommand(command: string): boolean {
  const trimmed = stripHeredocs(command.trim());
  return LONG_RUNNING_PATTERNS.some(pattern => pattern.test(trimmed));
}
```

## Alternatives considered

### A. Tighten the patterns to require command position
Rewrite each pattern to anchor at the start of the command (e.g., `/^\s*nodemon\b/`) so they only match when the keyword is the actual binary being invoked.

Rejected because: ~50 patterns to rewrite, easy to miss edge cases (commands chained with `&&`, prefixed with `env VAR=val`, wrapped in `nohup`, etc.), and doesn't handle the deeper issue of arbitrary text inside heredocs.

### B. Only check the first line of the command
Run the patterns against `command.split('\n')[0]` only.

Rejected because: legitimate long-running commands span multiple lines via line continuation (`npm run dev \`) or multi-command pipelines. First-line-only would miss them.

### C. Skip heredoc detection entirely; only flag at the pattern level
Add a guard pattern like "any heredoc command is safe" before the loop.

Rejected because: a command could legitimately combine a heredoc with a long-running tool (`echo 'config' | nodemon -c -`). Heredocs aren't inherently safe.

### D. Don't fix it, document the workaround
Accept the false positive and tell users to retry.

Rejected because: silent failures with no UI signal. The user sees R1 "succeed" without the file being created. Highest-pain bug class.

## Consequences

**Positive:**
- File creation via heredoc no longer falsely flagged regardless of file content.
- The fix is local: 5 lines of code, no impact on the patterns themselves.
- The patterns continue to correctly detect actual invocations like `nodemon server.js`.

**Negative / accepted costs:**
- The regex assumes well-formed heredoc syntax (matching opening and closing delimiter on its own line). Malformed heredocs won't be stripped, but they also won't execute correctly anyway, so this isn't a real failure mode.
- If R1 ever writes a script that *both* creates a file via heredoc *and* runs a long-running command in the same `<shell>` block (e.g., `cat > script.js << EOF ... EOF && node script.js`), only the part outside the heredoc is checked. The `node script.js` portion would still match patterns if it contained a keyword. This is correct behavior — the heredoc body shouldn't influence detection.

**Follow-ups:**
- If false negatives appear (a long-running command misses detection), add a test case rather than weakening the heredoc strip.
- Consider adding unit tests for `isLongRunningCommand()` covering the heredoc cases.
