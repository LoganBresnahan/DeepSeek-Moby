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

Commands pass through three security layers before execution:

### Layer 1: Regex Blocklist (reasonerShellExecutor.ts)

Hard-coded patterns that block catastrophic operations regardless of settings:

```
rm -rf /    rm -rf ~    sudo    su -    shutdown    reboot
dd if=...of=/dev/    mkfs    poweroff    halt
```

Cannot be bypassed except by `allowAllShellCommands` setting.

### Layer 2: Command Approval Rules (commandApprovalManager.ts)

Prefix-based allowed/blocked lists stored in the encrypted database:

- **Default rules** are platform-specific (Unix vs Windows equivalents)
- **User rules** can be added via the Command Rules modal
- Commands not matching any rule trigger an approval prompt
- Compound commands (`&&`, `||`, `;`, `|`) are split and each sub-command checked independently

### Layer 3: User Approval Prompt

For unknown commands, the user sees an inline approval widget with Accept/Reject buttons. Decisions can be persisted as new rules.

### Bypass Mode

Setting `moby.allowAllShellCommands = true` skips all three layers. Used for trusted environments where the user wants unrestricted AI access.

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

Sets `state.shellCreatedFiles` / `state.shellDeletedFiles`. Used to prevent false auto-continuation nudges.

### Layer 2: File System Watcher

VS Code's `FileSystemWatcher` monitors the workspace during shell execution:

- `onDidCreate` + `onDidChange` → `registerShellModifiedFiles()` → "Modified Files" dropdown
- `onDidDelete` → `registerShellDeletedFiles()` → "Modified Files" dropdown with deleted status
- 100ms settling window after command completes
- Known limitation: WSL2 may miss events due to inotify bridging latency (B25)

Both layers feed into the same flags, providing redundancy if either misses an event.

## Auto-Continuation

When DeepSeek's response contains shell commands but no code edits, the orchestrator may auto-continue to nudge DeepSeek to produce the actual changes. This is suppressed when:

- `state.shellCreatedFiles` is true (files were created — task likely complete)
- `state.shellDeletedFiles` is true (files were deleted — task likely complete)
- `hasCodeEdits` is true (SEARCH/REPLACE blocks detected)
- `autoContinuationCount >= 2` (budget exhausted)

## Default Command Rules

All platforms use the same bash/Unix rules since Windows uses Git Bash for execution.

**Allowed**: `ls`, `cat`, `grep`, `echo`, `pwd`, `find`, `wc`, `head`, `tail`, `tree`, `which`, `file`, `stat`, `du`, `df`, `env`, `uname`, `whoami`, `date`, `node`, `npm test/run/ls`, `npx vitest/tsc/jest`, `git status/log/diff/branch/show`, `tsc`, `python -c`, `cargo check/test`, `go test/vet/build`, `rg`, `fd`

**Blocked**: `rm -rf /`, `rm -rf ~`, `rm -rf *`, `sudo`, `su`, `shutdown`, `reboot`, `dd if=`, `mkfs`, `bash -c`, `sh -c`, `eval`, `npm publish`, `cargo publish`, `curl -X POST`, `wget --post`

## Key Files

| File | Purpose |
|---|---|
| `src/tools/reasonerShellExecutor.ts` | Shell resolution, command execution, validation, pattern matching |
| `src/providers/commandApprovalManager.ts` | Approval rules, default lists, prefix matching |
| `src/providers/requestOrchestrator.ts` | Execution loop, file watchers, auto-continuation |
| `src/utils/ContentTransformBuffer.ts` | Inline shell tag detection during streaming |
