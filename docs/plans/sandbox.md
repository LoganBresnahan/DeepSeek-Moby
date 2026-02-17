# Command Execution Sandboxing

**Status:** Research Complete — Ready for Implementation

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

## Implementation Research (UX-Level Sandbox)

### Current Execution Paths — Where the Gate Goes

#### R1 Path (Reasoner Shell Execution)

The command lifecycle is:

1. R1 streams response containing `<shell>` tags
2. `parseShellCommands()` in [reasonerShellExecutor.ts:52](src/tools/reasonerShellExecutor.ts#L52) extracts commands via `/<shell>([\s\S]*?)<\/shell>/gi`
3. `validateCommand()` at [line 164](src/tools/reasonerShellExecutor.ts#L164) checks against `BLOCKED_PATTERNS` (lines 31-47: `rm -rf /`, `sudo`, `shutdown`, `dd`, `mkfs`)
4. `executeShellCommand()` at [line 186](src/tools/reasonerShellExecutor.ts#L186) runs via `cp.spawnSync(command, { shell: true, cwd, timeout: 10000, maxBuffer: 100KB })`
5. RequestOrchestrator at [line 742](src/providers/requestOrchestrator.ts#L742) reads `allowAllShellCommands` setting before calling `executeShellCommands()`

**Approval gate location:** Between step 2 (parsing) and step 4 (execution). Specifically in RequestOrchestrator at line ~748, right before `executeShellCommands()` is called.

#### V3 Path (Tool Calling)

1. DeepSeek API returns `tool_calls` in the response
2. `executeToolCall()` at [workspaceTools.ts:178](src/tools/workspaceTools.ts#L178) dispatches to tool handlers
3. V3 tools are **read-only** (`read_file`, `search_files`, `grep_content`, `list_directory`, `get_file_info`) plus `apply_code_edit` and `web_search`
4. There is **no `execute_command` tool** for V3 — arbitrary shell commands are R1-only

**Approval gate location:** Currently only needed for R1 path. If `execute_command` is added to V3 tools later, the gate goes in `runToolLoop()` at [line 1143](src/providers/requestOrchestrator.ts#L1143) before `executeToolCall()`.

#### Safety Today

The current `allowAllShellCommands` setting (package.json, default `false`) is a binary kill switch:
- `false` → commands checked against `BLOCKED_PATTERNS` only (a small blocklist of catastrophic operations)
- `true` → "Walk on the Wild Side" — skip all validation

This is insufficient because commands **not in the blocklist still run without asking** (e.g., `curl`, `pip install`, `npm publish`).

### How Other Tools Handle This

| Tool | Approval Model | Persistence | Granularity |
|------|---------------|-------------|-------------|
| **Claude Code** | Per-command prefix rules (`Bash(npm test:*)`) in layered JSON files | Persistent (file-based) | Prefix match with `*` |
| **GitHub Copilot** | VS Code's native `LanguageModelToolConfirmationMessages` API | Session only | Per-execution, binary |
| **Cursor** | "YOLO mode" toggle (all or nothing) | Persistent (setting) | None — all or nothing |
| **Continue.dev** | N/A (doesn't execute commands) | N/A | N/A |

**Claude Code's system is the gold standard** — it uses `Bash(prefix:*)` pattern rules stored in layered JSON files (`~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`). When a command doesn't match any rule, it prompts with Allow / Always Allow / Deny options.

### Pattern Matching Design

#### Rule Format

Follow Claude Code's approach — **prefix matching with wildcard**:

```
npm test        → matches "npm test", "npm test --watch", "npm test src/utils"
git             → matches all git commands
ls              → matches "ls", "ls -la", "ls src/"
rm -rf          → matches "rm -rf /" (block rule)
```

The rule is an exact prefix of the command string. If the command starts with the rule text, it matches.

#### Compound Command Handling

Shell commands can be chained: `ls && rm -rf /`. Each sub-command must be checked independently:

```typescript
function splitCompoundCommand(command: string): string[] {
  // Split on pipe/chain operators
  return command.split(/\s*(?:\|\||&&|;|\|)\s*/).map(s => s.trim()).filter(Boolean);
}

function isCommandAllowed(fullCommand: string, rules: CommandRules): CommandDecision {
  const subCommands = splitCompoundCommand(fullCommand);

  for (const sub of subCommands) {
    // Check blocklist first (any blocked sub-command blocks the whole thing)
    if (rules.blocked.some(rule => sub.startsWith(rule))) {
      return 'blocked';
    }
  }

  // All sub-commands must be in the allowlist
  const allAllowed = subCommands.every(sub =>
    rules.allowed.some(rule => sub.startsWith(rule))
  );

  return allAllowed ? 'allowed' : 'ask';
}
```

**Special cases to always block:**
- Command substitution: `$(...)`, backtick substitution
- Nested shell: `bash -c "..."`, `sh -c "..."`, `eval "..."`

#### Default Rules

```typescript
const DEFAULT_ALLOWED: string[] = [
  // Safe read-only commands
  'ls', 'cat', 'grep', 'echo', 'pwd', 'find', 'wc', 'head', 'tail', 'tree',
  'which', 'whereis', 'file', 'stat', 'du', 'df', 'env', 'printenv',
  'uname', 'whoami', 'hostname', 'date',

  // Dev tools (read-only or standard dev operations)
  'node ', 'npm test', 'npm run', 'npm ls', 'npm list', 'npm info',
  'npx vitest', 'npx tsc', 'npx jest', 'npx eslint', 'npx prettier',
  'git status', 'git log', 'git diff', 'git branch', 'git show', 'git remote',
  'tsc', 'python -c', 'python3 -c',
  'cargo check', 'cargo test', 'cargo clippy',
  'go test', 'go vet', 'go build',
  'rg ', 'fd ',
];

const DEFAULT_BLOCKED: string[] = [
  // Catastrophic file operations
  'rm -rf /', 'rm -rf ~', 'rm -rf *',
  // Privilege escalation
  'sudo ', 'su ',
  // System control
  'shutdown', 'reboot', 'poweroff', 'halt',
  // Disk destruction
  'dd if=', 'mkfs',
  // Nested shells (escape hatch)
  'bash -c', 'sh -c', 'eval ',
  // Publishing / deployment (accidental release)
  'npm publish', 'cargo publish',
  // Network exfiltration
  'curl -X POST', 'wget --post',
];
```

### Storage

#### Where to Store Rules

**Decision: SQLCipher encrypted database (`moby.db`)**

Rules are stored in the existing encrypted database at `~/.vscode-server/data/User/globalStorage/deepseek.deepseek-moby/moby.db`. The encryption key lives in VS Code's SecretStorage (OS keyring).

**Schema:**

```sql
CREATE TABLE command_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prefix TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('allowed', 'blocked')),
  source TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('default', 'user')),
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_command_rules_prefix_type ON command_rules(prefix, type);
```

- `prefix` — the command prefix string (e.g., `npm test`, `rm -rf`)
- `type` — `'allowed'` or `'blocked'`
- `source` — `'default'` (shipped with extension, can be restored via Reset) or `'user'` (added by the user at runtime)
- `created_at` — Unix timestamp

On first run, default rules are seeded with `source = 'default'`. User-added rules get `source = 'user'`. "Reset to Defaults" deletes all `source = 'user'` rows.

**Why SQLCipher?**

| Option | Security | Why not |
|--------|----------|---------|
| JSON file in globalStorage | Plain text, any same-user process can read/modify | **Not secure enough** — user explicitly requested tamper resistance |
| VS Code Settings | Plain text JSON, readable by other extensions, synced across machines | Not secure, wrong scope |
| SecretStorage (OS keyring) | Encrypted, per-extension | Key-value strings only — would need to serialize entire ruleset as one blob, no querying |
| `context.globalState` (Memento) | Per-extension internal SQLite, not directly editable | Not encrypted, limited API |
| **SQLCipher database** | **AES-256 encrypted, key in OS keyring, per-user** | **Best fit** — already have the infrastructure |

The database infrastructure is already in place: `Database` wrapper at [SqlJsWrapper.ts](src/events/SqlJsWrapper.ts), encryption key in SecretStorage at [extension.ts:172](src/extension.ts#L172), migrations system at [migrations.ts](src/events/migrations.ts). Adding a `command_rules` table is a new migration.

### Approval UI

#### Webview Inline Approval (Command Execution)

When the LLM wants to run a command that's not in the allowlist, show an inline approval widget in the chat:

```
┌─────────────────────────────────────────────────┐
│  Command approval required                       │
│                                                  │
│  $ npm install express body-parser               │
│                                                  │
│  [Allow Once]  [Always Allow "npm install"]      │
│  [Block Once]  [Always Block "npm install"]      │
│                                                  │
└─────────────────────────────────────────────────┘
```

This is consistent with the existing blocking approval pattern used for ask-mode diffs (Promise-based pending approvals). The flow is:

1. Extension detects shell command
2. Extension checks allowlist/blocklist via database → not found → needs approval
3. Extension sends `commandApprovalRequired` message to webview
4. Webview renders inline approval widget in the chat
5. User clicks a button → webview sends `commandApprovalResponse` back
6. Extension resolves the pending Promise → command executes or is blocked
7. If "Always Allow/Block" → rule inserted into `command_rules` table

The chat panel is always open during LLM execution (that's where the conversation is), so there's no scenario where the webview is hidden when approval is needed. No fallback UI is necessary.

#### Top-Bar Button → Rules Manager Modal

A toolbar icon (shield icon `$(shield)`) opens a webview-rendered modal within the chat panel for managing the full ruleset:

```
┌─────────────────────────────────────────────────┐
│ Command Rules                              [x]  │
│─────────────────────────────────────────────────│
│                                                  │
│ Allowed                               [+ Add]   │
│   npm test                                  [x] │
│   npm run                                   [x] │
│   git status                                [x] │
│   git log                                   [x] │
│   git diff                                  [x] │
│   ls                                        [x] │
│                                                  │
│ Blocked                               [+ Add]   │
│   rm -rf                                    [x] │
│   sudo                                      [x] │
│                                                  │
│         [Reset to Defaults]                      │
└─────────────────────────────────────────────────┘
```

Implemented as a **webview modal overlay** in the existing chat webview (same approach as settings panels). The extension sends the full rules list to the webview on open; add/remove/reset actions send messages back to the extension which updates the database and re-sends the updated list.

### CommandApprovalManager Design

```typescript
// src/providers/commandApprovalManager.ts

import { Database } from '../events/SqlJsWrapper';

export interface CommandRule {
  id: number;
  prefix: string;
  type: 'allowed' | 'blocked';
  source: 'default' | 'user';
  createdAt: number;
}

export type CommandDecision = 'allowed' | 'blocked' | 'ask';

export interface CommandApprovalResult {
  command: string;
  decision: 'allowed' | 'blocked';
  persistent: boolean;  // "Always" vs "Once"
  prefix?: string;      // The prefix that was added (for "Always" rules)
}

export class CommandApprovalManager {
  // In-memory cache of rules (loaded from DB on init, refreshed on write)
  private allowed: string[] = [];
  private blocked: string[] = [];

  // Events
  private readonly _onApprovalRequired = new vscode.EventEmitter<{
    command: string;
    resolve: (result: CommandApprovalResult) => void;
  }>();
  readonly onApprovalRequired = this._onApprovalRequired.event;

  private readonly _onRulesChanged = new vscode.EventEmitter<CommandRule[]>();
  readonly onRulesChanged = this._onRulesChanged.event;

  constructor(private readonly db: Database) {
    this.seedDefaultsIfEmpty();
    this.refreshCache();
  }

  /** Check a command against the rules. Returns 'allowed', 'blocked', or 'ask'. */
  checkCommand(command: string): CommandDecision {
    const subCommands = this.splitCompoundCommand(command);

    // Any blocked sub-command → blocked
    for (const sub of subCommands) {
      if (this.blocked.some(rule => sub.startsWith(rule))) {
        return 'blocked';
      }
    }

    // All sub-commands must be allowed
    const allAllowed = subCommands.every(sub =>
      this.allowed.some(rule => sub.startsWith(rule))
    );

    return allAllowed ? 'allowed' : 'ask';
  }

  /** Block execution and wait for user approval. Returns the result. */
  async requestApproval(command: string): Promise<CommandApprovalResult> {
    return new Promise(resolve => {
      this._onApprovalRequired.fire({ command, resolve });
    });
  }

  /** Add a rule, persist to DB, refresh cache, fire event. */
  addRule(prefix: string, type: 'allowed' | 'blocked'): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO command_rules (prefix, type, source, created_at) VALUES (?, ?, ?, ?)'
    ).run(prefix, type, 'user', Date.now());
    this.refreshCache();
    this._onRulesChanged.fire(this.getAllRules());
  }

  /** Remove a rule by id, refresh cache, fire event. */
  removeRule(id: number): void {
    this.db.prepare('DELETE FROM command_rules WHERE id = ?').run(id);
    this.refreshCache();
    this._onRulesChanged.fire(this.getAllRules());
  }

  /** Get all rules (for UI display). */
  getAllRules(): CommandRule[] {
    return this.db.prepare('SELECT * FROM command_rules ORDER BY type, prefix').all() as CommandRule[];
  }

  /** Reset to defaults — delete user rules, re-seed defaults. */
  resetToDefaults(): void {
    this.db.prepare('DELETE FROM command_rules').run();
    this.seedDefaultsIfEmpty();
    this.refreshCache();
    this._onRulesChanged.fire(this.getAllRules());
  }

  /** Extract the likely prefix for an "Always Allow/Block" rule from a command. */
  extractPrefix(command: string): string {
    // Split on spaces, take first 1-2 tokens as the prefix
    // "npm install express" → "npm install"
    // "git status" → "git status"
    // "ls -la" → "ls"
    const parts = command.trim().split(/\s+/);
    if (parts.length <= 1) return parts[0];
    // Common pattern: binary + subcommand
    return `${parts[0]} ${parts[1]}`;
  }

  private refreshCache(): void {
    this.allowed = this.db.prepare("SELECT prefix FROM command_rules WHERE type = 'allowed'")
      .all().map((r: any) => r.prefix);
    this.blocked = this.db.prepare("SELECT prefix FROM command_rules WHERE type = 'blocked'")
      .all().map((r: any) => r.prefix);
  }

  private seedDefaultsIfEmpty(): void {
    const count = (this.db.prepare('SELECT COUNT(*) as c FROM command_rules').get() as any).c;
    if (count > 0) return;

    const defaults = getDefaultRules();
    const stmt = this.db.prepare(
      'INSERT INTO command_rules (prefix, type, source, created_at) VALUES (?, ?, ?, ?)'
    );
    const now = Date.now();
    for (const prefix of defaults.allowed) stmt.run(prefix, 'allowed', 'default', now);
    for (const prefix of defaults.blocked) stmt.run(prefix, 'blocked', 'default', now);
  }

  private splitCompoundCommand(command: string): string[] {
    return command.split(/\s*(?:\|\||&&|;|\|)\s*/).map(s => s.trim()).filter(Boolean);
  }
}
```

### Integration Points

| File | Change |
|------|--------|
| `src/providers/commandApprovalManager.ts` | **New file.** Allowlist/blocklist, prefix matching, DB persistence, approval events, in-memory cache |
| `src/events/migrations.ts` | **New migration.** `CREATE TABLE command_rules` with unique index |
| `src/providers/requestOrchestrator.ts` | Add approval gate at [line ~748](src/providers/requestOrchestrator.ts#L748) before `executeShellCommands()`. Check each command via `commandApprovalManager.checkCommand()`. If `'ask'` → call `requestApproval()` and `await` the Promise. |
| `src/providers/chatProvider.ts` | Wire CommandApprovalManager (pass `Database` instance). Subscribe to `onApprovalRequired` → forward to webview. Handle `commandApprovalResponse` messages from webview. Wire top-bar button for rules manager. |
| `src/providers/types.ts` | Add `CommandApprovalRequiredEvent` and `CommandApprovalResponseEvent` types |
| `src/tools/reasonerShellExecutor.ts` | Remove or simplify `BLOCKED_PATTERNS` and `validateCommand()` — the CommandApprovalManager now handles this. Keep `validateCommand()` as a last-resort safety net (double-gating). |
| `package.json` | Add `deepseek.openCommandRules` command. Keep `deepseek.allowAllShellCommands` as bypass mode. |
| `media/actors/` | Add `CommandApprovalActor` for inline approval widget. Add `CommandRulesModalActor` for the rules manager (triggered from top-bar button). |

### Cross-Platform Considerations

- Platform detection via `process.platform` already exists at [reasonerShellExecutor.ts:327](src/tools/reasonerShellExecutor.ts#L327)
- Shell execution uses `shell: true` which selects the system default shell automatically
- Default allowed commands should be platform-aware:
  - Linux/macOS: `ls`, `grep`, `find`, etc.
  - Windows: `dir`, `findstr`, `type`, etc. (or PowerShell equivalents)
- The database path uses `context.globalStorageUri` which is platform-abstracted by VS Code

```typescript
function getDefaultRules(): CommandRules {
  const isWindows = process.platform === 'win32';
  return {
    version: 1,
    allowed: isWindows ? DEFAULT_ALLOWED_WINDOWS : DEFAULT_ALLOWED_UNIX,
    blocked: isWindows ? DEFAULT_BLOCKED_WINDOWS : DEFAULT_BLOCKED_UNIX,
    lastModified: new Date().toISOString(),
  };
}
```

### Blocking Flow (How It Fits the Existing Architecture)

The command approval uses the same Promise-based blocking pattern as ask-mode diff approvals (implemented in DiffManager):

```
R1 iteration → parse <shell> commands → for each command:
  1. commandApprovalManager.checkCommand(cmd)
  2. If 'allowed' → execute immediately
  3. If 'blocked' → skip, inject "Command blocked" feedback to LLM
  4. If 'ask' → commandApprovalManager.requestApproval(cmd)
      → fires onApprovalRequired event
      → ChatProvider forwards to webview
      → webview shows inline approval widget
      → user clicks Allow/Block
      → webview sends response to extension
      → ChatProvider resolves the Promise
      → command executes or is blocked
  5. Inject result feedback to LLM for next iteration
```

This works in **all three edit modes** because command approval is independent of edit mode:
- **Manual mode**: Commands need approval (even though code edits are shown inline)
- **Ask mode**: Commands need approval (in addition to diff approval)
- **Auto mode**: Code edits auto-apply, but commands still need approval unless allowlisted

### Interaction with Existing `allowAllShellCommands`

The current "Walk on the Wild Side" setting becomes a **bypass mode** — equivalent to Claude Code's `bypassPermissions`:
- If `allowAllShellCommands = true` → skip all approval checks, run everything
- If `allowAllShellCommands = false` → use the command rules system

This maintains backward compatibility while the new system is the default.

## Decisions

| Question | Decision |
|----------|----------|
| **Granularity** | Prefix-based. `npm install` matches `npm install express`. |
| **Session vs persistent** | Persistent (encrypted DB). "Allow Once" is session-only, "Always Allow" persists to `command_rules` table. |
| **Batch approval** | Individual per command. Each `<shell>` tag command is checked separately. |
| **Auto mode interaction** | Yes, command approval still pauses in auto mode. Auto mode trusts code edits, not arbitrary shell execution. |
| **Storage** | SQLCipher encrypted database (`moby.db`). Encryption key in SecretStorage. |
| **UI** | Webview inline approval widget (primary). Webview modal for rules manager (top-bar button). No QuickPick fallback. |
| **Docker detection** | Deferred. Docker sandbox is a future "enhanced mode", not part of this implementation. |

---

## Implementation Phases

### Phase 1: Core Engine (no UI, extension-side only)

**Goal:** `CommandApprovalManager` exists, has tests, can check commands against rules in the database. No wiring to the actual execution path yet — just the pure logic.

**Files:**
- `src/events/migrations.ts` — add migration for `command_rules` table
- `src/providers/commandApprovalManager.ts` — new file: class with `checkCommand()`, `addRule()`, `removeRule()`, `getAllRules()`, `resetToDefaults()`, `extractPrefix()`, `splitCompoundCommand()`, `seedDefaultsIfEmpty()`
- `src/providers/types.ts` — add `CommandApprovalRequiredEvent`, `CommandApprovalResponseEvent`

**Tests:**
- `tests/unit/providers/commandApprovalManager.test.ts` — new file:
  - `checkCommand()` returns `'allowed'` / `'blocked'` / `'ask'` correctly
  - Prefix matching works (exact, longer command, no match)
  - Compound command splitting (`&&`, `||`, `;`, `|`) — each sub-command checked independently
  - Blocked sub-command in a compound → entire command blocked
  - `addRule()` persists to DB and updates cache
  - `removeRule()` removes from DB and updates cache
  - `resetToDefaults()` clears user rules, re-seeds defaults
  - Default rules are seeded on first init
  - Default rules NOT re-seeded if rules already exist
  - `extractPrefix()` extracts sensible prefixes from commands
  - Platform-aware defaults (mock `process.platform`)

**Deliverable:** A pure logic class with 100% test coverage, no side effects, no UI, no wiring.

### Phase 2: Wire to Execution Path (blocking gate)

**Goal:** Commands are actually checked before execution. Unknown commands block and await a Promise (but the Promise is never resolved yet — this phase just proves the gate works by auto-rejecting unknown commands with a log message).

**Files:**
- `src/providers/requestOrchestrator.ts` — add approval gate at line ~748 before `executeShellCommands()`. For each parsed command: `checkCommand()` → if `'blocked'`, skip with feedback. If `'ask'`, log and skip (temporary — Phase 3 adds the UI to resolve these).
- `src/providers/chatProvider.ts` — instantiate `CommandApprovalManager` with `Database`, pass to `RequestOrchestrator`

**Tests:**
- `tests/unit/providers/requestOrchestrator.test.ts` — add test: shell command in allowlist executes normally. Shell command in blocklist is skipped with feedback message. Shell command not in either list is skipped with "approval required" feedback.

**Deliverable:** The extension now gates commands. Allowlisted commands run, blocklisted commands are blocked, unknown commands are temporarily blocked (pending UI in Phase 3). No behavioral regression for users with `allowAllShellCommands = true` (bypass mode).

### Phase 3: Inline Approval Widget (webview UI)

**Goal:** When a command needs approval, the chat shows an inline widget with Allow Once / Always Allow / Block Once / Always Block buttons. The LLM waits for the user's decision.

**Files:**
- `media/actors/command-approval/CommandApprovalActor.ts` — new Shadow DOM actor: renders the inline approval widget, handles button clicks, sends `commandApprovalResponse` message
- `media/actors/command-approval/styles.ts` — styling for the approval widget
- `src/providers/chatProvider.ts` — subscribe to `onApprovalRequired`, forward `commandApprovalRequired` to webview. Handle `commandApprovalResponse` from webview, resolve the pending Promise.
- `src/providers/requestOrchestrator.ts` — change Phase 2's temporary "skip unknown" to actually call `requestApproval()` and await the Promise.

**Tests:**
- `tests/actors/command-approval/CommandApprovalActor.test.ts` — renders widget with command text, buttons fire correct messages, "Always" buttons include the extracted prefix
- `tests/unit/providers/chatProvider.test.ts` — approval event forwarding, response handling

**Deliverable:** Full end-to-end approval flow. User sees the command, makes a decision, LLM gets feedback and continues. "Always Allow" persists the rule to the encrypted database.

### Phase 4: Rules Manager Modal (top-bar button)

**Goal:** A shield icon in the chat top bar opens a modal overlay listing all rules. Users can add, remove, and reset rules.

**Files:**
- `media/actors/command-rules/CommandRulesModalActor.ts` — new Shadow DOM actor: renders the two-column rules list (allowed/blocked), add/remove buttons, reset to defaults
- `media/actors/command-rules/styles.ts` — modal styling
- `src/providers/chatProvider.ts` — handle `openCommandRules` / `addCommandRule` / `removeCommandRule` / `resetCommandRules` messages. Send `commandRulesList` message with full rules on open and after mutations.
- `package.json` — add `deepseek.openCommandRules` command (registered in `src/extension.ts`)
- `media/actors/commands/CommandsShadowActor.ts` — add shield button to DEFAULT_COMMANDS

**Tests:**
- `tests/actors/command-rules/CommandRulesModalActor.test.ts` — renders rules list, add/remove fire correct messages, reset clears user rules

**Deliverable:** Users can manage their command rules outside of the approval flow. Full CRUD on the rules list via a dedicated UI.

### Phase 5: Polish & Edge Cases

**Goal:** Handle remaining edge cases and clean up.

**Tasks:**
- Handle `allowAllShellCommands = true` as bypass (skip all approval checks)
- Handle generation stop while waiting for approval (`cancelPendingApprovals()` pattern from DiffManager)
- Handle new conversation clearing pending command approvals
- Log all approval decisions (command, decision, persistent, timestamp)
- Add platform-aware Windows default rules (separate `DEFAULT_ALLOWED_WINDOWS` / `DEFAULT_BLOCKED_WINDOWS`)
- Update `docs/plans/make-modes-better.md` to mark "Auto Mode — Command Approval" as IMPLEMENTED
- Update `REMINDER.md` if needed

**Tests:**
- Bypass mode with `allowAllShellCommands = true`
- Cancel pending approvals on stop generation
- Cancel pending approvals on new conversation
