/**
 * CommandApprovalManager — command allowlist/blocklist with prefix matching.
 *
 * Checks shell commands against user-configured rules stored in the
 * encrypted SQLCipher database. Rules are prefix-based: a rule "npm test"
 * matches "npm test", "npm test --watch", etc.
 *
 * Compound commands (&&, ||, ;, |) are split and each sub-command is
 * checked independently. Any blocked sub-command blocks the whole thing.
 * All sub-commands must be allowed for the compound to be allowed.
 *
 * The manager maintains an in-memory cache of rules for fast lookups,
 * refreshed on every write operation.
 */

import * as vscode from 'vscode';
import { Database } from '../events/SqlJsWrapper';
import { logger } from '../utils/logger';

// ── Types ──

export interface CommandRule {
  id: number;
  prefix: string;
  type: 'allowed' | 'blocked';
  source: 'default' | 'user';
  created_at: number;
}

export type CommandDecision = 'allowed' | 'blocked' | 'ask';

export interface CommandApprovalResult {
  command: string;
  decision: 'allowed' | 'blocked';
  persistent: boolean;
  prefix?: string;
}

// ── Default Rules ──

const DEFAULT_ALLOWED_UNIX: string[] = [
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

const DEFAULT_BLOCKED_UNIX: string[] = [
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

const DEFAULT_ALLOWED_WINDOWS: string[] = [
  // Safe read-only commands
  'dir', 'type', 'findstr', 'echo', 'cd', 'where', 'hostname', 'date',
  'whoami', 'set', 'tree',

  // Dev tools
  'node ', 'npm test', 'npm run', 'npm ls', 'npm list', 'npm info',
  'npx vitest', 'npx tsc', 'npx jest', 'npx eslint', 'npx prettier',
  'git status', 'git log', 'git diff', 'git branch', 'git show', 'git remote',
  'tsc', 'python -c', 'python3 -c',
  'cargo check', 'cargo test', 'cargo clippy',
  'go test', 'go vet', 'go build',
];

const DEFAULT_BLOCKED_WINDOWS: string[] = [
  // Catastrophic file operations
  'del /f /s /q', 'rd /s /q', 'rmdir /s /q',
  // System control
  'shutdown', 'restart-computer',
  // Nested shells
  'cmd /c', 'powershell -c', 'pwsh -c',
  // Publishing / deployment
  'npm publish', 'cargo publish',
];

export interface DefaultRules {
  allowed: string[];
  blocked: string[];
}

export function getDefaultRules(platform?: string): DefaultRules {
  const isWindows = (platform ?? process.platform) === 'win32';
  return {
    allowed: isWindows ? DEFAULT_ALLOWED_WINDOWS : DEFAULT_ALLOWED_UNIX,
    blocked: isWindows ? DEFAULT_BLOCKED_WINDOWS : DEFAULT_BLOCKED_UNIX,
  };
}

// ── Manager ──

export class CommandApprovalManager {
  private allowed: string[] = [];
  private blocked: string[] = [];

  // Pending approval promise (one at a time — orchestrator awaits each sequentially)
  private _pendingResolve: ((result: CommandApprovalResult) => void) | null = null;

  // ── Events ──
  private readonly _onApprovalRequired = new vscode.EventEmitter<{ command: string; prefix: string }>();
  readonly onApprovalRequired = this._onApprovalRequired.event;

  private readonly _onRulesChanged = new vscode.EventEmitter<CommandRule[]>();
  readonly onRulesChanged = this._onRulesChanged.event;

  constructor(private readonly db: Database, private readonly platform?: string) {
    this.seedDefaultsIfEmpty();
    this.refreshCache();
  }

  /** Block execution and wait for user approval via the webview. */
  async requestApproval(command: string): Promise<CommandApprovalResult> {
    const prefix = this.extractPrefix(command);
    return new Promise<CommandApprovalResult>(resolve => {
      this._pendingResolve = resolve;
      this._onApprovalRequired.fire({ command, prefix });
    });
  }

  /** Resolve a pending approval (called by ChatProvider when webview responds). */
  resolveApproval(result: CommandApprovalResult): void {
    if (this._pendingResolve) {
      const resolve = this._pendingResolve;
      this._pendingResolve = null;
      resolve(result);
    }
  }

  /** Cancel any pending approval (e.g., on stop generation or clear chat). */
  cancelPendingApproval(): void {
    if (this._pendingResolve) {
      const resolve = this._pendingResolve;
      this._pendingResolve = null;
      resolve({ command: '', decision: 'blocked', persistent: false });
      logger.info('[CommandApproval] Cancelled pending approval');
    }
  }

  /** Check a command against the rules. Returns 'allowed', 'blocked', or 'ask'. */
  checkCommand(command: string): CommandDecision {
    const trimmed = command.trim();
    if (!trimmed) { return 'blocked'; }

    const subCommands = this.splitCompoundCommand(trimmed);

    // Any blocked sub-command blocks the whole thing
    for (const sub of subCommands) {
      if (this.blocked.some(rule => sub.startsWith(rule))) {
        return 'blocked';
      }
    }

    // All sub-commands must be in the allowlist
    const allAllowed = subCommands.every(sub =>
      this.allowed.some(rule => sub.startsWith(rule))
    );

    return allAllowed ? 'allowed' : 'ask';
  }

  /** Add a rule, persist to DB, refresh cache. */
  addRule(prefix: string, type: 'allowed' | 'blocked'): void {
    const trimmed = prefix.trim();
    if (!trimmed) { return; }

    this.db.prepare(
      'INSERT OR REPLACE INTO command_rules (prefix, type, source, created_at) VALUES (?, ?, ?, ?)'
    ).run(trimmed, type, 'user', Date.now());
    this.refreshCache();
    this._onRulesChanged.fire(this.getAllRules());
    logger.info(`[CommandApproval] Added rule: ${type} "${trimmed}"`);
  }

  /** Remove a rule by id, refresh cache. */
  removeRule(id: number): void {
    this.db.prepare('DELETE FROM command_rules WHERE id = ?').run(id);
    this.refreshCache();
    this._onRulesChanged.fire(this.getAllRules());
    logger.info(`[CommandApproval] Removed rule id=${id}`);
  }

  /** Get all rules (for UI display). */
  getAllRules(): CommandRule[] {
    return this.db.prepare('SELECT * FROM command_rules ORDER BY type, prefix').all() as unknown as CommandRule[];
  }

  /** Reset to defaults — delete all rules, re-seed defaults. */
  resetToDefaults(): void {
    this.db.prepare('DELETE FROM command_rules').run();
    this.seedDefaultsIfEmpty();
    this.refreshCache();
    this._onRulesChanged.fire(this.getAllRules());
    logger.info('[CommandApproval] Reset to defaults');
  }

  /** Extract the likely prefix for an "Always Allow/Block" rule from a command. */
  extractPrefix(command: string): string {
    const parts = command.trim().split(/\s+/);
    if (parts.length <= 1) { return parts[0] || ''; }
    // Common pattern: binary + subcommand (e.g., "npm install", "git status")
    return `${parts[0]} ${parts[1]}`;
  }

  /** Split a compound command into individual sub-commands. */
  splitCompoundCommand(command: string): string[] {
    return command.split(/\s*(?:\|\||&&|;|\|)\s*/).map(s => s.trim()).filter(Boolean);
  }

  /** Refresh the in-memory cache from the database. */
  private refreshCache(): void {
    this.allowed = this.db.prepare("SELECT prefix FROM command_rules WHERE type = 'allowed'")
      .all().map((r: any) => r.prefix);
    this.blocked = this.db.prepare("SELECT prefix FROM command_rules WHERE type = 'blocked'")
      .all().map((r: any) => r.prefix);
  }

  /** Seed default rules if the table is empty. */
  private seedDefaultsIfEmpty(): void {
    const count = (this.db.prepare('SELECT COUNT(*) as c FROM command_rules').get() as any).c;
    if (count > 0) { return; }

    const defaults = getDefaultRules(this.platform);
    const stmt = this.db.prepare(
      'INSERT INTO command_rules (prefix, type, source, created_at) VALUES (?, ?, ?, ?)'
    );
    const now = Date.now();
    for (const prefix of defaults.allowed) { stmt.run(prefix, 'allowed', 'default', now); }
    for (const prefix of defaults.blocked) { stmt.run(prefix, 'blocked', 'default', now); }
    logger.info(`[CommandApproval] Seeded ${defaults.allowed.length} allowed + ${defaults.blocked.length} blocked default rules`);
  }

  dispose(): void {
    this.cancelPendingApproval();
    this._onApprovalRequired.dispose();
    this._onRulesChanged.dispose();
  }
}
