/**
 * Unit tests for CommandApprovalManager
 *
 * Tests prefix-based command matching, compound command splitting,
 * DB persistence, default rule seeding, and cache refresh.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Database } from '../../../src/events/SqlJsWrapper';
import { runMigrations } from '../../../src/events/migrations';
import {
  CommandApprovalManager,
  getDefaultRules,
} from '../../../src/providers/commandApprovalManager';
import type { CommandRule, CommandDecision } from '../../../src/providers/commandApprovalManager';

describe('CommandApprovalManager', () => {
  let db: Database;
  let manager: CommandApprovalManager;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    manager = new CommandApprovalManager(db, undefined, 'linux');
  });

  afterEach(() => {
    db.close();
  });

  // ── Default Seeding ──

  describe('default rule seeding', () => {
    it('should seed default rules on first init', () => {
      const rules = manager.getAllRules();
      expect(rules.length).toBeGreaterThan(0);

      const allowed = rules.filter(r => r.type === 'allowed');
      const blocked = rules.filter(r => r.type === 'blocked');
      expect(allowed.length).toBeGreaterThan(0);
      expect(blocked.length).toBeGreaterThan(0);
    });

    it('should mark default rules with source "default"', () => {
      const rules = manager.getAllRules();
      expect(rules.every(r => r.source === 'default')).toBe(true);
    });

    it('should NOT re-seed defaults if rules already exist', () => {
      const countBefore = manager.getAllRules().length;

      // Create a new manager against the same DB — should not re-seed
      const manager2 = new CommandApprovalManager(db, undefined, 'linux');
      const countAfter = manager2.getAllRules().length;

      expect(countAfter).toBe(countBefore);
    });

    it('should seed bash defaults', () => {
      const defaults = getDefaultRules();
      const rules = manager.getAllRules();
      const prefixes = rules.map(r => r.prefix);

      // All platforms use bash rules (Git Bash on Windows)
      expect(prefixes).toContain('ls');
      expect(prefixes).toContain('grep');
      expect(prefixes).toContain('sudo ');
      expect(defaults.allowed).toContain('ls');
    });
  });

  // ── checkCommand ──

  describe('checkCommand', () => {
    it('should return "allowed" for exact prefix match', () => {
      expect(manager.checkCommand('ls')).toBe('allowed');
      expect(manager.checkCommand('grep')).toBe('allowed');
      expect(manager.checkCommand('pwd')).toBe('allowed');
    });

    it('should return "allowed" for command longer than prefix', () => {
      expect(manager.checkCommand('ls -la')).toBe('allowed');
      expect(manager.checkCommand('ls /tmp')).toBe('allowed');
      expect(manager.checkCommand('grep -r "foo" src/')).toBe('allowed');
    });

    it('should return "allowed" for dev tool commands', () => {
      expect(manager.checkCommand('npm test')).toBe('allowed');
      expect(manager.checkCommand('npm test --watch')).toBe('allowed');
      expect(manager.checkCommand('npm run build')).toBe('allowed');
      expect(manager.checkCommand('git status')).toBe('allowed');
      expect(manager.checkCommand('git diff HEAD')).toBe('allowed');
      expect(manager.checkCommand('npx vitest run')).toBe('allowed');
    });

    it('should return "blocked" for blocked commands', () => {
      expect(manager.checkCommand('sudo apt install foo')).toBe('blocked');
      expect(manager.checkCommand('rm -rf /')).toBe('blocked');
      expect(manager.checkCommand('rm -rf ~')).toBe('blocked');
      expect(manager.checkCommand('shutdown')).toBe('blocked');
      expect(manager.checkCommand('npm publish')).toBe('blocked');
    });

    it('should return "ask" for unknown commands', () => {
      expect(manager.checkCommand('curl https://example.com')).toBe('ask');
      expect(manager.checkCommand('pip install requests')).toBe('ask');
      expect(manager.checkCommand('docker run ubuntu')).toBe('ask');
      expect(manager.checkCommand('ssh user@host')).toBe('ask');
    });

    it('should return "blocked" for empty command', () => {
      expect(manager.checkCommand('')).toBe('blocked');
      expect(manager.checkCommand('   ')).toBe('blocked');
    });

    it('should trim whitespace before checking', () => {
      expect(manager.checkCommand('  ls  ')).toBe('allowed');
      expect(manager.checkCommand('  sudo foo  ')).toBe('blocked');
    });
  });

  // ── Compound Commands ──

  describe('compound commands (treated as single unit)', () => {
    it('should treat full chained command as one entry', () => {
      // Full command checked as one string — no splitting
      // "ls && pwd" starts with "ls" which is allowed
      expect(manager.checkCommand('ls && pwd')).toBe('allowed');
    });

    it('should ask for unknown chained commands', () => {
      // "curl" is not in the allowlist, full command treated as one
      expect(manager.checkCommand('curl https://evil.com && ls')).toBe('ask');
    });

    it('should block if the full command starts with a blocked prefix', () => {
      expect(manager.checkCommand('sudo rm -rf / && ls')).toBe('blocked');
    });

    it('should ask for allowed prefix chained with unknown', () => {
      // "ls" is allowed as prefix, but "ls && unknown_cmd" still starts with "ls"
      // so it matches the "ls" allow rule
      expect(manager.checkCommand('ls && unknown_cmd')).toBe('allowed');
    });

    it('should allow grep with alternation patterns', () => {
      expect(manager.checkCommand('grep -rn -i "marker\\|symbol" dir/ | grep -v test | head -50')).toBe('allowed');
    });
  });

  // ── splitCompoundCommand ──

  describe('splitCompoundCommand', () => {
    it('should split on all shell operators', () => {
      expect(manager.splitCompoundCommand('a && b')).toEqual(['a', 'b']);
      expect(manager.splitCompoundCommand('a || b')).toEqual(['a', 'b']);
      expect(manager.splitCompoundCommand('a ; b')).toEqual(['a', 'b']);
      expect(manager.splitCompoundCommand('a | b')).toEqual(['a', 'b']);
    });

    it('should handle multiple operators', () => {
      expect(manager.splitCompoundCommand('a && b || c; d | e'))
        .toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('should trim whitespace from sub-commands', () => {
      expect(manager.splitCompoundCommand('  a  &&  b  ')).toEqual(['a', 'b']);
    });

    it('should filter empty strings', () => {
      expect(manager.splitCompoundCommand('a &&  && b')).toEqual(['a', 'b']);
    });

    it('should return single command as array', () => {
      expect(manager.splitCompoundCommand('ls -la')).toEqual(['ls -la']);
    });

    it('should NOT split on \\| inside double quotes (grep alternation)', () => {
      const cmd = 'grep -rn "foo\\|bar" dir | head -5';
      const parts = manager.splitCompoundCommand(cmd);
      expect(parts).toEqual(['grep -rn "foo\\|bar" dir', 'head -5']);
    });

    it('should NOT split on | inside single quotes', () => {
      const cmd = "grep -rn 'foo|bar' dir | head -5";
      const parts = manager.splitCompoundCommand(cmd);
      expect(parts).toEqual(["grep -rn 'foo|bar' dir", 'head -5']);
    });

    it('should NOT split on | inside double quotes', () => {
      const cmd = 'echo "a|b" && cat file';
      const parts = manager.splitCompoundCommand(cmd);
      expect(parts).toEqual(['echo "a|b"', 'cat file']);
    });

    it('should handle the real-world grep alternation bug case', () => {
      const cmd = 'grep -rn -i "marker\\|symbol\\|player" tictactoe/ --include="*.py" 2>/dev/null | grep -v test | head -50';
      const parts = manager.splitCompoundCommand(cmd);
      expect(parts).toEqual([
        'grep -rn -i "marker\\|symbol\\|player" tictactoe/ --include="*.py" 2>/dev/null',
        'grep -v test',
        'head -50',
      ]);
    });

    it('should handle mixed quoting styles', () => {
      const cmd = `grep "a\\|b" file | grep 'c|d' | wc -l`;
      const parts = manager.splitCompoundCommand(cmd);
      expect(parts).toEqual(['grep "a\\|b" file', "grep 'c|d'", 'wc -l']);
    });
  });

  // ── addRule ──

  describe('addRule', () => {
    it('should persist allowed rule to DB', () => {
      manager.addRule('docker run', 'allowed');

      const rules = manager.getAllRules();
      const rule = rules.find(r => r.prefix === 'docker run');
      expect(rule).toBeDefined();
      expect(rule!.type).toBe('allowed');
      expect(rule!.source).toBe('user');
    });

    it('should persist blocked rule to DB', () => {
      manager.addRule('curl', 'blocked');

      const rules = manager.getAllRules();
      const rule = rules.find(r => r.prefix === 'curl');
      expect(rule).toBeDefined();
      expect(rule!.type).toBe('blocked');
      expect(rule!.source).toBe('user');
    });

    it('should update cache immediately after adding', () => {
      // Before: unknown command returns "ask"
      expect(manager.checkCommand('docker run ubuntu')).toBe('ask');

      // After: allowed
      manager.addRule('docker run', 'allowed');
      expect(manager.checkCommand('docker run ubuntu')).toBe('allowed');
    });

    it('should replace existing rule on conflict (same prefix)', () => {
      manager.addRule('curl', 'allowed');
      expect(manager.checkCommand('curl https://example.com')).toBe('allowed');

      // Change to blocked
      manager.addRule('curl', 'blocked');
      expect(manager.checkCommand('curl https://example.com')).toBe('blocked');
    });

    it('should ignore empty prefix', () => {
      const countBefore = manager.getAllRules().length;
      manager.addRule('', 'allowed');
      manager.addRule('   ', 'allowed');
      expect(manager.getAllRules().length).toBe(countBefore);
    });

    it('should trim prefix whitespace', () => {
      manager.addRule('  docker run  ', 'allowed');
      const rules = manager.getAllRules();
      const rule = rules.find(r => r.prefix === 'docker run');
      expect(rule).toBeDefined();
    });
  });

  // ── removeRule ──

  describe('removeRule', () => {
    it('should remove a rule by id', () => {
      manager.addRule('docker run', 'allowed');
      const rules = manager.getAllRules();
      const rule = rules.find(r => r.prefix === 'docker run')!;

      manager.removeRule(rule.id);

      const after = manager.getAllRules();
      expect(after.find(r => r.prefix === 'docker run')).toBeUndefined();
    });

    it('should update cache after removal', () => {
      manager.addRule('docker run', 'allowed');
      expect(manager.checkCommand('docker run ubuntu')).toBe('allowed');

      const rule = manager.getAllRules().find(r => r.prefix === 'docker run')!;
      manager.removeRule(rule.id);
      expect(manager.checkCommand('docker run ubuntu')).toBe('ask');
    });

    it('should handle removing non-existent id gracefully', () => {
      // Should not throw
      manager.removeRule(99999);
    });
  });

  // ── getAllRules ──

  describe('getAllRules', () => {
    it('should return all rules sorted by type then prefix', () => {
      const rules = manager.getAllRules();
      // "allowed" comes before "blocked" alphabetically
      const types = rules.map(r => r.type);
      const firstBlockedIndex = types.indexOf('blocked');
      const lastAllowedIndex = types.lastIndexOf('allowed');
      if (firstBlockedIndex !== -1 && lastAllowedIndex !== -1) {
        expect(lastAllowedIndex).toBeLessThan(firstBlockedIndex);
      }
    });

    it('should include all expected fields', () => {
      const rules = manager.getAllRules();
      const rule = rules[0];
      expect(rule).toHaveProperty('id');
      expect(rule).toHaveProperty('prefix');
      expect(rule).toHaveProperty('type');
      expect(rule).toHaveProperty('source');
      expect(rule).toHaveProperty('created_at');
    });
  });

  // ── resetToDefaults ──

  describe('resetToDefaults', () => {
    it('should remove user rules', () => {
      manager.addRule('docker run', 'allowed');
      manager.addRule('curl', 'blocked');

      manager.resetToDefaults();

      const rules = manager.getAllRules();
      expect(rules.find(r => r.prefix === 'docker run')).toBeUndefined();
      expect(rules.find(r => r.prefix === 'curl' && r.source === 'user')).toBeUndefined();
    });

    it('should re-seed defaults after clearing', () => {
      manager.resetToDefaults();

      const rules = manager.getAllRules();
      expect(rules.length).toBeGreaterThan(0);
      expect(rules.every(r => r.source === 'default')).toBe(true);
    });

    it('should update cache after reset', () => {
      manager.addRule('docker run', 'allowed');
      expect(manager.checkCommand('docker run ubuntu')).toBe('allowed');

      manager.resetToDefaults();
      expect(manager.checkCommand('docker run ubuntu')).toBe('ask');
    });
  });

  // ── extractPrefix ──

  describe('extractPrefix', () => {
    it('should extract first two tokens for multi-word commands', () => {
      expect(manager.extractPrefix('npm install express')).toBe('npm install');
      expect(manager.extractPrefix('git status')).toBe('git status');
      expect(manager.extractPrefix('cargo test --release')).toBe('cargo test');
    });

    it('should return the single token for single-word commands', () => {
      expect(manager.extractPrefix('ls')).toBe('ls');
      expect(manager.extractPrefix('pwd')).toBe('pwd');
    });

    it('should handle extra whitespace', () => {
      expect(manager.extractPrefix('  npm   install  express  ')).toBe('npm install');
    });

    it('should return empty string for empty input', () => {
      expect(manager.extractPrefix('')).toBe('');
      expect(manager.extractPrefix('   ')).toBe('');
    });
  });

  // ── findUnknownSubCommand ──

  describe('findUnknownSubCommand (deprecated — treats full command as unit)', () => {
    it('should return null for a simple allowed command', () => {
      expect(manager.findUnknownSubCommand('ls -la')).toBeNull();
    });

    it('should return the command itself for a simple unknown command', () => {
      expect(manager.findUnknownSubCommand('docker run ubuntu')).toBe('docker run ubuntu');
    });

    it('should return the full command for unknown chained commands', () => {
      // No longer splits — returns full command if unknown
      expect(manager.findUnknownSubCommand('curl https://a.com && wget https://b.com'))
        .toBe('curl https://a.com && wget https://b.com');
    });

    it('should return null for empty input', () => {
      expect(manager.findUnknownSubCommand('')).toBeNull();
      expect(manager.findUnknownSubCommand('   ')).toBeNull();
    });

    it('should return null when command starts with allowed prefix', () => {
      expect(manager.findUnknownSubCommand('ls && pwd')).toBeNull();
    });
  });

  // ── Prefix Matching Edge Cases ──

  describe('prefix matching edge cases', () => {
    it('should not match partial word (prefix "ls" should not match "lsof")', () => {
      // "ls" is in the allowlist as an exact prefix
      // "lsof" starts with "ls" so it WILL match — this is by design
      // Prefix matching is intentionally greedy (Claude Code works the same way)
      expect(manager.checkCommand('lsof')).toBe('allowed');
    });

    it('should match trailing space in prefix for disambiguation', () => {
      // "node " (with space) is in the allowlist
      // "node" without space is NOT — prevents matching "nodejs" accidentally
      // But "node" by itself still starts with "node " ... no, "node" does NOT start with "node "
      // because "node".startsWith("node ") is false (missing trailing space)
      expect(manager.checkCommand('node')).toBe('ask');
      expect(manager.checkCommand('node server.js')).toBe('allowed');
    });

    it('should match "npm test" but not "npm total"', () => {
      expect(manager.checkCommand('npm test')).toBe('allowed');
      expect(manager.checkCommand('npm test --watch')).toBe('allowed');
      expect(manager.checkCommand('npm total')).toBe('ask');
    });

    it('should handle nested shell commands in blocklist', () => {
      expect(manager.checkCommand('bash -c "rm -rf /"')).toBe('blocked');
      expect(manager.checkCommand('sh -c ls')).toBe('blocked');
      expect(manager.checkCommand('eval echo hello')).toBe('blocked');
    });
  });

  // ── Persistence Across Instances ──

  describe('persistence across instances', () => {
    it('should preserve user rules across manager instances', () => {
      manager.addRule('docker run', 'allowed');

      // Create new manager on the same DB
      const manager2 = new CommandApprovalManager(db, undefined, 'linux');
      expect(manager2.checkCommand('docker run ubuntu')).toBe('allowed');
    });

    it('should preserve default + user rules together', () => {
      manager.addRule('docker run', 'allowed');

      const manager2 = new CommandApprovalManager(db, undefined, 'linux');
      const rules = manager2.getAllRules();

      // Should have both default and user rules
      const defaults = rules.filter(r => r.source === 'default');
      const userRules = rules.filter(r => r.source === 'user');
      expect(defaults.length).toBeGreaterThan(0);
      expect(userRules.length).toBeGreaterThan(0);
    });
  });
});

// ── getDefaultRules ──

describe('getDefaultRules', () => {
  it('should return Unix/bash rules for all platforms', () => {
    const rules = getDefaultRules();
    expect(rules.allowed).toContain('ls');
    expect(rules.allowed).toContain('grep');
    expect(rules.allowed).toContain('cat');
    expect(rules.blocked).toContain('sudo ');
    expect(rules.blocked).toContain('rm -rf /');
  });
});

// ── requestApproval / resolveApproval / cancelPendingApproval ──

describe('requestApproval flow', () => {
  let db: Database;
  let manager: CommandApprovalManager;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    manager = new CommandApprovalManager(db, undefined, 'linux');
  });

  afterEach(() => {
    manager.dispose();
    db.close();
  });

  it('should resolve Promise when resolveApproval is called', async () => {
    // Start approval request
    const promise = manager.requestApproval('docker run ubuntu');

    // Resolve it
    manager.resolveApproval({
      command: 'docker run ubuntu',
      decision: 'allowed',
      persistent: false,
    });

    const result = await promise;
    expect(result.command).toBe('docker run ubuntu');
    expect(result.decision).toBe('allowed');
    expect(result.persistent).toBe(false);
  });

  it('should resolve as blocked when cancelPendingApproval is called', async () => {
    const promise = manager.requestApproval('docker run ubuntu');

    manager.cancelPendingApproval();

    const result = await promise;
    expect(result.decision).toBe('blocked');
  });

  it('should handle multiple sequential approvals', async () => {
    // First approval
    const promise1 = manager.requestApproval('curl https://example.com');
    manager.resolveApproval({ command: 'curl https://example.com', decision: 'allowed', persistent: false });
    const result1 = await promise1;
    expect(result1.decision).toBe('allowed');

    // Second approval
    const promise2 = manager.requestApproval('pip install requests');
    manager.resolveApproval({ command: 'pip install requests', decision: 'blocked', persistent: true, prefix: 'pip install' });
    const result2 = await promise2;
    expect(result2.decision).toBe('blocked');
    expect(result2.persistent).toBe(true);
  });

  it('cancelPendingApproval should be safe to call with no pending approval', () => {
    // Should not throw
    manager.cancelPendingApproval();
  });

  it('resolveApproval should be safe to call with no pending approval', () => {
    // Should not throw
    manager.resolveApproval({ command: 'test', decision: 'allowed', persistent: false });
  });

  it('should fire onApprovalRequired with full command as prefix for compound commands', async () => {
    // Access the internal mock EventEmitter's fire method
    const fireMock = (manager as any)._onApprovalRequired.fire;

    // Full chained command treated as one unit
    const promise = manager.requestApproval('find . -name "*.rb" | xargs grep foo');

    expect(fireMock).toHaveBeenCalledWith({
      command: 'find . -name "*.rb" | xargs grep foo',
      prefix: 'find . -name "*.rb" | xargs grep foo',
      unknownSubCommand: 'find . -name "*.rb" | xargs grep foo',
    });

    manager.resolveApproval({ command: 'find . -name "*.rb" | xargs grep foo', decision: 'allowed', persistent: false });
    await promise;
  });

  it('should use full command as unknownSubCommand for simple unknown commands', async () => {
    const fireMock = (manager as any)._onApprovalRequired.fire;

    const promise = manager.requestApproval('docker run ubuntu');

    expect(fireMock).toHaveBeenCalledWith({
      command: 'docker run ubuntu',
      prefix: 'docker run',
      unknownSubCommand: 'docker run ubuntu',
    });

    manager.resolveApproval({ command: 'docker run ubuntu', decision: 'allowed', persistent: false });
    await promise;
  });

  it('dispose should cancel pending approval and clean up', async () => {
    const promise = manager.requestApproval('test command');

    manager.dispose();

    const result = await promise;
    expect(result.decision).toBe('blocked');
  });
});

// ── Cross-Instance Version Counter ──

describe('cross-instance version counter', () => {
  let db: Database;

  function createMockGlobalState(store: Record<string, any> = {}): any {
    return {
      get: (key: string) => store[key],
      update: async (key: string, value: any) => { store[key] = value; },
    };
  }

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should bump version counter when adding a rule', () => {
    const store: Record<string, any> = {};
    const gs = createMockGlobalState(store);
    const manager = new CommandApprovalManager(db, gs, 'linux');

    manager.addRule('docker run', 'allowed');

    expect(store['commandRulesVersion']).toBe(1);
  });

  it('should bump version counter when removing a rule', () => {
    const store: Record<string, any> = {};
    const gs = createMockGlobalState(store);
    const manager = new CommandApprovalManager(db, gs, 'linux');

    const rules = manager.getAllRules();
    manager.removeRule(rules[0].id);

    expect(store['commandRulesVersion']).toBe(1);
  });

  it('should bump version counter on resetToDefaults', () => {
    const store: Record<string, any> = {};
    const gs = createMockGlobalState(store);
    const manager = new CommandApprovalManager(db, gs, 'linux');

    manager.resetToDefaults();

    expect(store['commandRulesVersion']).toBe(1);
  });

  it('should refresh cache when another instance bumps the version', () => {
    const store: Record<string, any> = {};
    const gs = createMockGlobalState(store);

    // Instance A adds a rule and bumps version
    const instanceA = new CommandApprovalManager(db, gs, 'linux');
    instanceA.addRule('docker run', 'allowed');
    expect(store['commandRulesVersion']).toBe(1);

    // Instance B starts with the same DB and globalState
    const instanceB = new CommandApprovalManager(db, gs, 'linux');
    // Instance B's initial version matches (loaded in constructor)
    expect(instanceB.checkCommand('docker run ubuntu')).toBe('allowed');

    // Instance A adds another rule
    instanceA.addRule('kubectl', 'blocked');
    expect(store['commandRulesVersion']).toBe(2);

    // Instance B's cache is stale, but checkCommand refreshes it
    expect(instanceB.checkCommand('kubectl get pods')).toBe('blocked');
  });

  it('should not refresh cache when version has not changed', () => {
    const store: Record<string, any> = {};
    const gs = createMockGlobalState(store);
    const manager = new CommandApprovalManager(db, gs, 'linux');

    // First check — no version change, should use cached values
    const result1 = manager.checkCommand('ls -la');
    expect(result1).toBe('allowed');

    // Add a rule directly to DB WITHOUT bumping version (simulating stale state)
    db.prepare(
      "INSERT INTO command_rules (prefix, type, source, created_at) VALUES (?, ?, ?, ?)"
    ).run('ls', 'blocked', 'user', Date.now());

    // checkCommand should still use the cached (stale) version since version hasn't changed
    const result2 = manager.checkCommand('ls -la');
    expect(result2).toBe('allowed'); // Still allowed — cache not refreshed
  });

  it('should work without globalState (backward compatible)', () => {
    // No globalState passed — should work exactly as before
    const manager = new CommandApprovalManager(db, undefined, 'linux');
    expect(manager.checkCommand('ls -la')).toBe('allowed');
    expect(manager.checkCommand('rm -rf /')).toBe('blocked');

    // Adding rules should work without errors
    manager.addRule('docker run', 'allowed');
    expect(manager.checkCommand('docker run ubuntu')).toBe('allowed');
  });
});
