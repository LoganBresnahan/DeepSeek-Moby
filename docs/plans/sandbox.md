# Command Execution Sandboxing

**Status:** Research

**Depends on:** Shell execution pipeline (requestOrchestrator + reasonerShellExecutor)

---

## Context

The extension executes shell commands on behalf of the LLM — both via V3's tool calling (`execute_command` tool) and R1's `<shell>` tag iteration loop. Currently the only gate is the `allowAllCommands` setting. When enabled, commands run with the full permissions of the VS Code process. There is no isolation, no rollback, and no per-command approval.

## Goal

Add a sandboxing layer between the LLM's command requests and actual execution, so users have confidence that the LLM can't accidentally (or intentionally via prompt injection) run destructive commands.

## Research Summary

### What is a Sandbox?

An isolated environment where code runs with restricted access to the rest of the system. The "walls" can be enforced at different levels, trading isolation strength for convenience:

| Level | Mechanism | Strength | Overhead |
|-------|-----------|----------|----------|
| Hardware | Separate machine | Strongest | Highest |
| OS kernel | Namespaces, cgroups, seccomp | Strong | Medium |
| Container | Docker, Podman | Strong | Medium (requires daemon) |
| Process | Restricted spawn, uid/gid | Moderate | Low |
| Language runtime | Node `vm` module | Weak | Lowest |
| UX | User confirmation before execution | N/A (human gate) | None |

### Approaches Evaluated

#### 1. Docker Containers

**How:** Spin up a container per session or per command. Mount the workspace as a volume. Commands execute inside the container with restricted filesystem/network access.

**Pros:**
- Strong isolation (filesystem, network, PIDs)
- Can snapshot state via `docker commit` before execution — enables rollback
- Pairs naturally with event sourcing architecture (snapshot + replay)
- Could surface "undo last command" in the UI

**Cons:**
- Requires Docker daemon on the host — heavy dependency
- Many users won't have Docker, especially on Windows without WSL
- Container startup latency (even with warm containers)
- Workspace volume mounting adds complexity (permissions, symlinks, path translation)

**Verdict:** Best as an optional "power user" mode. Detect Docker availability, offer it, fall back gracefully.

#### 2. Node `vm` Module

**How:** Run code in an isolated V8 context with a controlled global scope. Only whitelisted APIs are available.

```typescript
const sandbox = { console: { log: (...args) => buffer.push(args) } };
const context = vm.createContext(sandbox);
new vm.Script(code).runInContext(context, { timeout: 5000 });
```

**Pros:**
- No external dependencies
- Timeout support (prevents infinite loops)
- Fine-grained control over available APIs

**Cons:**
- Only runs JavaScript, not shell commands (our primary use case)
- Known sandbox escape via `this.constructor.constructor('return process')()`
- Same process, same thread — no filesystem or network isolation
- Not applicable to `child_process.spawn()` which is what we actually use

**Verdict:** Not useful for our use case. We execute shell commands, not JS evaluation.

#### 3. OS-Level Restrictions

**How:** Spawn commands with restricted permissions using OS-native controls.

- **Linux:** `spawn` with `uid`/`gid`, seccomp profiles, AppArmor/SELinux
- **macOS:** Sandbox profiles (`sandbox-exec`)
- **Windows:** Job objects, restricted tokens

**Pros:**
- No extra dependencies (OS-native)
- Low overhead

**Cons:**
- Platform-specific implementation (3x maintenance)
- Complex to configure correctly
- `uid`/`gid` restriction only works on Linux/Mac
- Limited control granularity

**Verdict:** Could complement other approaches but too platform-specific to be the primary strategy.

#### 4. UX-Level Sandbox (Claude Code Approach)

**How:** Show the user what's about to run, let them approve/reject. No technical isolation — the gate is human judgment.

**Pros:**
- Zero dependencies, works everywhere
- Users see exactly what will execute
- Fits event-driven architecture (approval is just another event)
- Already partially implemented via `allowAllCommands` setting
- Most practical for a VS Code extension

**Cons:**
- No technical isolation — if user approves a bad command, it runs
- Approval fatigue — users start clicking "yes" without reading
- Interrupts flow during autonomous multi-step operations

**Verdict:** Best fit for the extension. Most practical, zero dependencies, and can be enhanced with smart defaults.

> **RECOMMENDATION:** This is probably the way to go. UX-level approval (ask the user before running) fits naturally into the existing async architecture. The LLM already stops at action boundaries (tool calls, shell tags), so adding an approval gate is just one more `await`. See `docs/plans/make-modes-better.md` for the blocking approval flow design that applies to both command execution and ask-mode diffs.

### Recommended Design: Tiered Command Approval

Combine the UX approach with smart defaults to reduce approval fatigue:

#### Command Categories

```
Safe (auto-approve):     ls, cat, grep, echo, pwd, find, wc, head, tail, tree
Dev tools (auto-approve): node, npm, npx, git status/log/diff, tsc, python, pip, cargo
File ops (ask):           cp, mv, mkdir, touch, chmod, chown
Network (ask):            curl, wget, ssh, scp
Dangerous (block):        rm -rf, dd, mkfs, shutdown, reboot, kill -9
Unknown (ask first):      everything else
```

#### Learn-As-You-Go

Instead of a giant checklist upfront:
1. Intercept each command before execution
2. Check against saved allowlist/blocklist
3. If unknown, show the command and ask the user
4. Offer "Always allow `<command>`" and "Always block `<command>`" options
5. Persist decisions to VS Code settings

#### Pattern-Based Rules

Instead of individual commands, support glob-like patterns:
- `npm *` — allow all npm commands
- `git *` — allow all git commands
- `rm -rf *` — always block
- `curl *` — always ask

### Snapshotting Idea (Future)

If Docker is available, leverage event sourcing architecture:
1. Before command execution, `docker commit` the container state
2. Execute the command
3. If it goes wrong, restore the snapshot
4. Surface "undo last command" in the UI

This is like conversation forking but applied to the execution environment.

## Architecture Considerations

### Where It Fits

The approval gate should sit in `requestOrchestrator.ts` between the tool call parsing and actual execution:

```
LLM output → parse tool call → [APPROVAL GATE] → execute → return result
```

For the reasoner path, it's in the shell iteration loop:

```
R1 output → detect <shell> tag → [APPROVAL GATE] → execute → feed back result
```

### New Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `CommandApprovalManager` | `src/providers/commandApprovalManager.ts` | Allowlist/blocklist, pattern matching, persistence |
| Approval UI | Webview modal or VS Code QuickPick | Show command, collect approve/deny/always |
| Settings | `package.json` + VS Code config | Persist command rules |

### Integration Points

| File | Change |
|------|--------|
| `src/providers/requestOrchestrator.ts` | Add approval gate before `executeToolCall()` for `execute_command` |
| `src/tools/reasonerShellExecutor.ts` | Add approval gate before shell command execution |
| `src/providers/chatProvider.ts` | Wire approval manager, handle approval messages from webview |
| `package.json` | Add `deepseek.commandRules` setting |

## Open Questions

1. **Granularity**: Approve the full command string, or just the base command? (`npm install express` vs `npm`)
2. **Session vs persistent**: Should approvals persist across VS Code sessions or reset?
3. **Batch approval**: When the LLM wants to run 3 commands, approve individually or as a batch?
4. **Auto mode interaction**: In edit mode "auto", should command approval still pause? Or should auto mode imply trust?
5. **Docker detection**: How to detect Docker availability cross-platform? `docker info` with timeout?

## Next Steps

1. Implement `CommandApprovalManager` with tiered defaults and pattern matching
2. Add approval gate to requestOrchestrator tool execution path
3. Add approval gate to reasonerShellExecutor
4. Build approval UI (start with VS Code QuickPick, upgrade to webview modal later)
5. Add tests
6. Optional: Docker sandbox as "enhanced mode"
