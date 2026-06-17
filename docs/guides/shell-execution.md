# Shell Command Execution

How Moby executes AI-generated shell commands across platforms.

## Overview

DeepSeek R1 (Reasoner) outputs shell commands in `<shell>` tags. Moby parses, validates, and executes these commands within the workspace directory. The system is designed around bash-compatible syntax since that's what DeepSeek emits.

## Shell Selection

| Platform | Shell Used | How |
|---|---|---|
| **Linux** | `/bin/sh` | `shell: true` in Node.js `spawn()` |
| **macOS** | `/bin/sh` | `shell: true` in Node.js `spawn()` |
| **Windows** | Git Bash | Detected at `C:\Program Files\Git\bin\bash.exe` or via `where git` |
| **Windows (fallback)** | `cmd.exe` | If Git Bash not found — commands may fail |

### Why Git Bash on Windows?

DeepSeek always emits Unix/bash syntax: `cat`, `grep`, heredocs (`<< 'EOF'`), pipes (`|`), logical operators (`&&`, `||`). These don't work in `cmd.exe` or PowerShell. Git Bash (included with Git for Windows) provides a full POSIX-compatible shell.

### Why not force bash on all platforms?

On Linux/macOS, Node.js `shell: true` uses `/bin/sh`, which is POSIX-compatible and handles DeepSeek's commands correctly. Fish/zsh users are unaffected because Node ignores `$SHELL` — it always uses `/bin/sh`.

### Shell Resolution (`resolveShell()`)

Located in `src/tools/reasonerShellExecutor.ts`. Called once and cached.

1. **Non-Windows**: Returns `true` (Node.js default: `/bin/sh`)
2. **Windows**: Probes for Git Bash:
   - Runs `where git` to find Git install path
   - Checks `C:\Program Files\Git\bin\bash.exe`
   - Checks `C:\Program Files (x86)\Git\bin\bash.exe`
   - Falls back to `true` (`cmd.exe`) with a warning

## Security Layers

A separate **long-running-command guard** runs before any of these layers — see [Long-Running Command Guard](#long-running-command-guard) below.

Commands then pass through three security layers before execution:

### Layer 1: Regex Blocklist (reasonerShellExecutor.ts)

Hard-coded patterns that block catastrophic operations regardless of settings:

```
rm -rf /    rm -rf ~    sudo    su -    shutdown    reboot
dd if=...of=/dev/    mkfs    poweroff
```

This regex blocklist is a last-resort safety net. `validateCommand()` skips it for any command already approved upstream — `allowAllShellCommands`, user-approved commands (`approvalStatus` `'user-allowed'`), and rule/auto-approved commands (`approvalStatus` `'auto'`). Since the orchestrator tags rule-matched commands `'auto'` and user-approved ones `'user-allowed'` before they reach the executor, in practice the blocklist only fires for commands that were *not* approved by the layers above.

### Layer 2: Command Approval Rules (commandApprovalManager.ts)

Prefix-based allowed/blocked lists stored in the SQLCipher-encrypted database (`SqlJsWrapper`):

- **Default rules** are the same Unix/bash set on all platforms (Windows runs via Git Bash)
- **User rules** can be added via the Command Rules modal
- Commands not matching any rule trigger an approval prompt
- The full command string is prefix-matched as a single unit by `checkCommand()`. Compound commands (`&&`, `||`, `;`, `|`) are **not** split into sub-commands — a `splitCompoundCommand()` helper exists but is unused in the current pipeline

### Layer 3: User Approval Prompt

For unknown commands, the user sees an inline approval widget with Accept/Reject buttons. Decisions can be persisted as new rules.

### Bypass Mode

Setting `moby.allowAllShellCommands = true` skips all three layers. Used for trusted environments where the user wants unrestricted AI access.

### Long-Running Command Guard

`isLongRunningCommand()` (in `reasonerShellExecutor.ts`, backed by `LONG_RUNNING_PATTERNS`) matches dev servers, watch modes, and REPLs across many languages — e.g. `npm run dev`, `npx vite`, `python -m http.server`, `rails server`, `cargo watch`, `dotnet watch`, `flask run`, `redis-server`. Heredoc bodies are stripped before matching so a file's contents (e.g. a `nodemon` dependency in a `package.json` written via `cat > … << 'EOF'`) don't trigger false positives.

This guard runs **before** the approval gate in `streamAndIterate()`. Matching commands are **not** executed; instead a `Skipped: … long-running command` result is returned to the model so it can move on. Because the check precedes the `allowAllShellCommands` read, it is **not** bypassed by Bypass Mode.

## Execution Paths

### Inline Execution (during streaming)

Commands detected by `ContentTransformBuffer` during token streaming are executed immediately via `executeInlineShellCommands()`. Results are injected into the next API call context so DeepSeek sees the output.

### Batched Execution (between iterations)

Commands that weren't executed inline (because they required approval or were part of the response's final output) go through the batch path in `streamAndIterate()`. These pass through the command approval gate.

## File Change Detection

Two layers detect what commands did to the filesystem:

### Layer 1: Command Pattern Matching

Regex patterns detect file operations from the command string itself:

| Function | Detects | Examples |
|---|---|---|
| `commandsCreateFiles()` | Heredocs, redirects, tee | `cat > file << 'EOF'`, `echo "x" > file`, `tee file` |
| `commandsDeleteFiles()` | rm, unlink | `rm file`, `rm -f file`, `unlink file` |

Sets `state.shellCreatedFiles` / `state.shellDeletedFiles`. These flags are currently only tracked and logged — they are not yet read by the continuation logic (see Auto-Continuation below).

### Layer 2: File System Watcher

VS Code's `FileSystemWatcher` monitors the workspace during shell execution:

- `onDidCreate` + `onDidChange` → `registerShellModifiedFiles()` → "Modified Files" dropdown
- `onDidDelete` → `registerShellDeletedFiles()` → "Modified Files" dropdown with deleted status
- 100ms settling window after command completes
- Known limitation: WSL2 may miss events due to inotify bridging latency (B25)

Both layers feed into the same flags, providing redundancy if either misses an event.

## Auto-Continuation

When DeepSeek runs shell commands but produces no code edits, the orchestrator may auto-continue to nudge it toward the actual changes. The nudge fires only when **all** of these hold:

- `shellIteration > 0` (at least one iteration has run)
- `!hasCodeEdits` — this iteration produced no SEARCH/REPLACE blocks
- `nudgeContinuations < maxNudgeContinuations` (budget of 4)

When `hasCodeEdits` **is** true, the nudge is skipped and a separate post-edit continuation loop runs instead (`postEditContinuations`, bounded by the user-configurable File Edit Loops budget), giving the model a chance to run install/build/verify steps after writing files.

> Note: `state.shellCreatedFiles` / `state.shellDeletedFiles` are tracked and logged but are **not** read by this logic — they do not currently gate continuation.

## Default Command Rules

All platforms use the same bash/Unix rules since Windows uses Git Bash for execution.

**Allowed**: `ls`, `cat`, `grep`, `echo`, `pwd`, `find`, `wc`, `head`, `tail`, `tree`, `which`, `whereis`, `file`, `stat`, `du`, `df`, `env`, `printenv`, `uname`, `whoami`, `hostname`, `date`, `node`, `npm test/run/ls/list/info`, `npx vitest/tsc/jest/eslint/prettier`, `git status/log/diff/branch/show/remote`, `tsc`, `python -c`, `python3 -c`, `cargo check/test/clippy`, `go test/vet/build`, `rg`, `fd`

**Blocked**: `rm -rf /`, `rm -rf ~`, `rm -rf *`, `sudo`, `su`, `shutdown`, `reboot`, `poweroff`, `halt`, `dd if=`, `mkfs`, `bash -c`, `sh -c`, `eval`, `npm publish`, `cargo publish`, `curl -X POST`, `wget --post`

## Key Files

| File | Purpose |
|---|---|
| `src/tools/reasonerShellExecutor.ts` | Shell resolution, command execution, validation, pattern matching |
| `src/providers/commandApprovalManager.ts` | Approval rules, default lists, prefix matching |
| `src/providers/requestOrchestrator.ts` | Execution loop, file watchers, auto-continuation |
| `src/utils/ContentTransformBuffer.ts` | Inline shell tag detection during streaming |
