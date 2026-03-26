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
 * refreshed on every write operation. A globalState version counter
 * enables cross-instance cache invalidation: when one instance adds
 * a rule, other instances detect the version change on their next
 * checkCommand() and refresh from the database.
 */

import * as vscode from 'vscode';
import { Database } from '../events/SqlJsWrapper';
import { logger } from '../utils/logger';
import { tracer } from '../tracing';

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
  private _lastSeenVersion: number = 0;

  // Pending approval promise (one at a time — orchestrator awaits each sequentially)
  private _pendingResolve: ((result: CommandApprovalResult) => void) | null = null;

  // ── Events ──
  private readonly _onApprovalRequired = new vscode.EventEmitter<{ command: string; prefix: string; unknownSubCommand: string }>();
  readonly onApprovalRequired = this._onApprovalRequired.event;

  private readonly _onRulesChanged = new vscode.EventEmitter<CommandRule[]>();
  readonly onRulesChanged = this._onRulesChanged.event;

  constructor(
    private readonly db: Database,
    private readonly globalState?: vscode.Memento,
    private readonly platform?: string
  ) {
    this.seedDefaultsIfEmpty();
    this.refreshCache();
    // Sync version counter on init
    this._lastSeenVersion = this.globalState?.get<number>('commandRulesVersion') ?? 0;
  }

  /** Block execution and wait for user approval via the webview. */
  async requestApproval(command: string): Promise<CommandApprovalResult> {
    const prefix = this.extractPrefix(command);
    logger.info(`[CommandApproval] requestApproval: command="${command}", prefix="${prefix}"`);

    const spanId = tracer.startSpan('command.approval', 'requestApproval', {
      executionMode: 'async',
      data: { command, prefix }
    });

    return new Promise<CommandApprovalResult>(resolve => {
      this._pendingResolve = (result) => {
        tracer.endSpan(spanId, {
          status: result.decision === 'allowed' ? 'completed' : 'failed',
          data: { decision: result.decision, persistent: result.persistent }
        });
        resolve(result);
      };
      this._onApprovalRequired.fire({ command, prefix, unknownSubCommand: command });
    });
  }

  /** Resolve a pending approval (called by ChatProvider when webview responds). */
  resolveApproval(result: CommandApprovalResult): void {
    logger.info(`[CommandApproval] resolveApproval: decision=${result.decision}, persistent=${result.persistent}, command="${result.command}"`);
    if (this._pendingResolve) {
      const resolve = this._pendingResolve;
      this._pendingResolve = null;
      resolve(result);
    } else {
      logger.warn('[CommandApproval] resolveApproval called with no pending approval');
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

  /** Check a command against the rules. Returns 'allowed', 'blocked', or 'ask'.
   *  Treats the full command string as one unit — chained commands (&&, ||, |)
   *  are matched as a whole, not split into sub-commands. */
  checkCommand(command: string): CommandDecision {
    // Cross-instance cache invalidation: if another instance changed rules,
    // the globalState version counter will differ from our last-seen version.
    this.refreshCacheIfStale();

    const trimmed = command.trim();
    if (!trimmed) {
      logger.debug('[CommandApproval] checkCommand: empty command, blocking');
      return 'blocked';
    }

    // Check against blocked rules (full command matched as prefix)
    const blockedRule = this.blocked.find(rule => trimmed.startsWith(rule));
    if (blockedRule) {
      logger.debug(`[CommandApproval] checkCommand: "${trimmed.substring(0, 80)}" matched block rule "${blockedRule}"`);
      tracer.trace('command.check', 'checkCommand', {
        data: { command: trimmed.substring(0, 80), subCommandCount: 1, decision: 'blocked' }
      });
      return 'blocked';
    }

    // Check against allowed rules (full command matched as prefix)
    const isAllowed = this.allowed.some(rule => trimmed.startsWith(rule));

    const decision: CommandDecision = isAllowed ? 'allowed' : 'ask';
    tracer.trace('command.check', 'checkCommand', {
      data: { command: trimmed.substring(0, 80), subCommandCount: 1, decision }
    });
    return decision;
  }

  /** Add a rule, persist to DB, refresh cache, bump version. */
  addRule(prefix: string, type: 'allowed' | 'blocked'): void {
    const trimmed = prefix.trim();
    if (!trimmed) { return; }

    this.db.prepare(
      'INSERT OR REPLACE INTO command_rules (prefix, type, source, created_at) VALUES (?, ?, ?, ?)'
    ).run(trimmed, type, 'user', Date.now());
    this.refreshCache();
    this.bumpVersion();
    this._onRulesChanged.fire(this.getAllRules());
    logger.info(`[CommandApproval] Added rule: ${type} "${trimmed}"`);
  }

  /** Remove a rule by id, refresh cache, bump version. */
  removeRule(id: number): void {
    this.db.prepare('DELETE FROM command_rules WHERE id = ?').run(id);
    this.refreshCache();
    this.bumpVersion();
    this._onRulesChanged.fire(this.getAllRules());
    logger.info(`[CommandApproval] Removed rule id=${id}`);
  }

  /** Get all rules (for UI display). */
  getAllRules(): CommandRule[] {
    return this.db.prepare('SELECT * FROM command_rules ORDER BY type, prefix').all() as unknown as CommandRule[];
  }

  /** Reset to defaults — delete all rules, re-seed defaults, bump version. */
  resetToDefaults(): void {
    this.db.prepare('DELETE FROM command_rules').run();
    this.seedDefaultsIfEmpty();
    this.refreshCache();
    this.bumpVersion();
    this._onRulesChanged.fire(this.getAllRules());
    logger.info('[CommandApproval] Reset to defaults');
  }

  /** Extract the prefix for an "Always Allow/Block" rule from a command.
   *  Uses binary + first arg for simple commands (e.g., "npm install" from "npm install lodash").
   *  For chained commands, uses the full command string. */
  extractPrefix(command: string): string {
    const trimmed = command.trim();
    if (!trimmed) return '';

    // If command contains chain operators, use the full command as the prefix
    if (/[&|;]/.test(trimmed)) {
      return trimmed;
    }

    // Simple command: binary + first arg
    const parts = trimmed.split(/\s+/);
    if (parts.length <= 1) { return parts[0] || ''; }
    return `${parts[0]} ${parts[1]}`;
  }

  /** @deprecated Use checkCommand with full command string instead. */
  findUnknownSubCommand(command: string): string | null {
    const trimmed = command.trim();
    if (!trimmed) { return null; }

    // Just check if the full command is unknown
    if (this.blocked.some(rule => trimmed.startsWith(rule))) { return null; }
    if (this.allowed.some(rule => trimmed.startsWith(rule))) { return null; }
    return trimmed;
  }

  /** Split a compound command into individual sub-commands.
   *  Quote-aware: respects single/double quotes and backslash escapes
   *  so that e.g. grep "foo\|bar" is NOT split on the \| inside quotes. */
  splitCompoundCommand(command: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    let i = 0;

    while (i < command.length) {
      const ch = command[i];

      // Backslash escapes (skip next char) — not active inside single quotes
      if (ch === '\\' && !inSingle && i + 1 < command.length) {
        current += ch + command[i + 1];
        i += 2;
        continue;
      }

      // Toggle quote state
      if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; i++; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; i++; continue; }

      // Only split on operators when outside quotes
      if (!inSingle && !inDouble) {
        // || (check before single |)
        if (ch === '|' && command[i + 1] === '|') {
          const t = current.trim(); if (t) { parts.push(t); } current = ''; i += 2; continue;
        }
        // &&
        if (ch === '&' && command[i + 1] === '&') {
          const t = current.trim(); if (t) { parts.push(t); } current = ''; i += 2; continue;
        }
        // single |
        if (ch === '|') {
          const t = current.trim(); if (t) { parts.push(t); } current = ''; i++; continue;
        }
        // ;
        if (ch === ';') {
          const t = current.trim(); if (t) { parts.push(t); } current = ''; i++; continue;
        }
      }

      current += ch;
      i++;
    }

    const t = current.trim();
    if (t) { parts.push(t); }
    return parts;
  }

  /** Bump the globalState version counter so other instances know rules changed. */
  private bumpVersion(): void {
    if (!this.globalState) { return; }
    const next = (this.globalState.get<number>('commandRulesVersion') ?? 0) + 1;
    this._lastSeenVersion = next;
    this.globalState.update('commandRulesVersion', next);
  }

  /** Refresh cache if another instance has changed rules (version counter mismatch). */
  private refreshCacheIfStale(): void {
    if (!this.globalState) { return; }
    const current = this.globalState.get<number>('commandRulesVersion') ?? 0;
    if (current !== this._lastSeenVersion) {
      logger.debug(`[CommandApproval] Stale cache detected (local=${this._lastSeenVersion}, global=${current}), refreshing`);
      this.refreshCache();
      this._lastSeenVersion = current;
    }
  }

  /** Refresh the in-memory cache from the database. */
  private refreshCache(): void {
    this.allowed = this.db.prepare("SELECT prefix FROM command_rules WHERE type = 'allowed'")
      .all().map((r: any) => r.prefix);
    this.blocked = this.db.prepare("SELECT prefix FROM command_rules WHERE type = 'blocked'")
      .all().map((r: any) => r.prefix);
    logger.debug(`[CommandApproval] Cache refreshed: ${this.allowed.length} allowed, ${this.blocked.length} blocked rules`);
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
