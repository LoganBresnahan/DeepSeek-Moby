/**
 * Unit tests for schema migrations.
 *
 * Tests the clean single-version schema with:
 * - sessions table (with fork metadata)
 * - events table (session-agnostic)
 * - event_sessions join table (M:N with per-session sequence)
 * - snapshots table
 * - command_rules table
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../../src/events/SqlJsWrapper';
import { runMigrations } from '../../../src/events/migrations';

describe('runMigrations', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  // ==========================================================================
  // Table creation
  // ==========================================================================

  it('creates all five tables on fresh database', () => {
    runMigrations(db);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const tableNames = tables.map(t => t.name);

    expect(tableNames).toContain('sessions');
    expect(tableNames).toContain('events');
    expect(tableNames).toContain('event_sessions');
    expect(tableNames).toContain('snapshots');
    expect(tableNames).toContain('command_rules');
  });

  it('creates indexes for all tables', () => {
    runMigrations(db);

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
    ).all() as { name: string }[];
    const indexNames = indexes.map(i => i.name);

    expect(indexNames).toContain('idx_sessions_updated');
    expect(indexNames).toContain('idx_event_sessions_session');
    expect(indexNames).toContain('idx_snapshots_session');
    expect(indexNames).toContain('idx_command_rules_prefix_type');
  });

  it('stamps user_version to latest (1)', () => {
    runMigrations(db);

    const version = db.pragmaGet('user_version');
    expect(version).toBe(1);
  });

  it('starts from version 0 on fresh database', () => {
    const version = db.pragmaGet('user_version');
    expect(version).toBe(0);
  });

  it('is idempotent — running twice does not error', () => {
    runMigrations(db);
    runMigrations(db);

    const version = db.pragmaGet('user_version');
    expect(version).toBe(1);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'"
    ).get();
    expect(tables).toBeDefined();
  });

  // ==========================================================================
  // Sessions table (with fork metadata)
  // ==========================================================================

  it('sessions table has parent_session_id and fork_sequence columns', () => {
    runMigrations(db);

    db.prepare(
      'INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('s1', 'Test', 'deepseek-chat', 1000, 1000);

    // parent_session_id and fork_sequence should be NULL by default
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('s1') as any;
    expect(session.parent_session_id).toBeNull();
    expect(session.fork_sequence).toBeNull();

    // Can set fork metadata
    db.prepare(
      'INSERT INTO sessions (id, title, model, created_at, updated_at, parent_session_id, fork_sequence) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('s2', 'Fork', 'deepseek-chat', 2000, 2000, 's1', 5);

    const fork = db.prepare('SELECT * FROM sessions WHERE id = ?').get('s2') as any;
    expect(fork.parent_session_id).toBe('s1');
    expect(fork.fork_sequence).toBe(5);
  });

  // ==========================================================================
  // Events table (session-agnostic)
  // ==========================================================================

  it('events table has no session_id or sequence columns', () => {
    runMigrations(db);

    const columns = db.prepare("PRAGMA table_info('events')").all() as { name: string }[];
    const colNames = columns.map(c => c.name);

    expect(colNames).toContain('id');
    expect(colNames).toContain('timestamp');
    expect(colNames).toContain('type');
    expect(colNames).toContain('data');
    expect(colNames).not.toContain('session_id');
    expect(colNames).not.toContain('sequence');
  });

  // ==========================================================================
  // event_sessions join table
  // ==========================================================================

  it('event_sessions join table links events to sessions with sequence', () => {
    runMigrations(db);

    // Create session and event
    db.prepare(
      'INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('s1', 'Test', 'deepseek-chat', 1000, 1000);
    db.prepare(
      'INSERT INTO events (id, timestamp, type, data) VALUES (?, ?, ?, ?)'
    ).run('e1', 1000, 'user_message', '{"content":"hello"}');
    db.prepare(
      'INSERT INTO event_sessions (event_id, session_id, sequence) VALUES (?, ?, ?)'
    ).run('e1', 's1', 1);

    const link = db.prepare(
      'SELECT * FROM event_sessions WHERE event_id = ? AND session_id = ?'
    ).get('e1', 's1') as any;
    expect(link).toBeDefined();
    expect(link.sequence).toBe(1);
  });

  it('event_sessions enforces unique (session_id, sequence)', () => {
    runMigrations(db);

    db.prepare(
      'INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('s1', 'Test', 'deepseek-chat', 1000, 1000);
    db.prepare(
      'INSERT INTO events (id, timestamp, type, data) VALUES (?, ?, ?, ?)'
    ).run('e1', 1000, 'user_message', '{}');
    db.prepare(
      'INSERT INTO events (id, timestamp, type, data) VALUES (?, ?, ?, ?)'
    ).run('e2', 2000, 'user_message', '{}');

    db.prepare(
      'INSERT INTO event_sessions (event_id, session_id, sequence) VALUES (?, ?, ?)'
    ).run('e1', 's1', 1);

    // Same session + sequence should fail
    expect(() => {
      db.prepare(
        'INSERT INTO event_sessions (event_id, session_id, sequence) VALUES (?, ?, ?)'
      ).run('e2', 's1', 1);
    }).toThrow();
  });

  it('event_sessions enforces unique (event_id, session_id)', () => {
    runMigrations(db);

    db.prepare(
      'INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('s1', 'Test', 'deepseek-chat', 1000, 1000);
    db.prepare(
      'INSERT INTO events (id, timestamp, type, data) VALUES (?, ?, ?, ?)'
    ).run('e1', 1000, 'user_message', '{}');

    db.prepare(
      'INSERT INTO event_sessions (event_id, session_id, sequence) VALUES (?, ?, ?)'
    ).run('e1', 's1', 1);

    // Same event + session should fail
    expect(() => {
      db.prepare(
        'INSERT INTO event_sessions (event_id, session_id, sequence) VALUES (?, ?, ?)'
      ).run('e1', 's1', 2);
    }).toThrow();
  });

  it('same event can belong to multiple sessions (M:N)', () => {
    runMigrations(db);

    db.prepare(
      'INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('s1', 'Session 1', 'deepseek-chat', 1000, 1000);
    db.prepare(
      'INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('s2', 'Session 2', 'deepseek-chat', 1000, 1000);
    db.prepare(
      'INSERT INTO events (id, timestamp, type, data) VALUES (?, ?, ?, ?)'
    ).run('e1', 1000, 'user_message', '{"content":"shared"}');

    // Link same event to both sessions
    db.prepare(
      'INSERT INTO event_sessions (event_id, session_id, sequence) VALUES (?, ?, ?)'
    ).run('e1', 's1', 1);
    db.prepare(
      'INSERT INTO event_sessions (event_id, session_id, sequence) VALUES (?, ?, ?)'
    ).run('e1', 's2', 1);

    const links = db.prepare(
      'SELECT * FROM event_sessions WHERE event_id = ?'
    ).all('e1');
    expect(links).toHaveLength(2);
  });

  // ==========================================================================
  // FK constraints and cascades
  // ==========================================================================

  it('PRAGMA foreign_keys is ON after Database construction', () => {
    const result = db.prepare('PRAGMA foreign_keys').get() as any;
    expect(result.foreign_keys).toBe(1);
  });

  it('PRAGMA journal_mode is set after Database construction', () => {
    const result = db.prepare('PRAGMA journal_mode').get() as any;
    // In-memory databases can't use WAL, so SQLite keeps 'memory'
    expect(result.journal_mode).toBe('memory');
  });

  it('PRAGMA busy_timeout is 5000 after Database construction', () => {
    const result = db.prepare('PRAGMA busy_timeout').get() as any;
    expect(result.timeout).toBe(5000);
  });

  it('event_sessions FK rejects invalid event_id', () => {
    runMigrations(db);

    db.prepare(
      'INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('s1', 'Test', 'deepseek-chat', 1000, 1000);

    expect(() => {
      db.prepare(
        'INSERT INTO event_sessions (event_id, session_id, sequence) VALUES (?, ?, ?)'
      ).run('nonexistent-event', 's1', 1);
    }).toThrow();
  });

  it('event_sessions FK rejects invalid session_id', () => {
    runMigrations(db);

    db.prepare(
      'INSERT INTO events (id, timestamp, type, data) VALUES (?, ?, ?, ?)'
    ).run('e1', 1000, 'user_message', '{}');

    expect(() => {
      db.prepare(
        'INSERT INTO event_sessions (event_id, session_id, sequence) VALUES (?, ?, ?)'
      ).run('e1', 'nonexistent-session', 1);
    }).toThrow();
  });

  it('ON DELETE CASCADE on event_sessions removes links when session is deleted', () => {
    runMigrations(db);

    db.prepare(
      'INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('s1', 'Test', 'deepseek-chat', 1000, 1000);
    db.prepare(
      'INSERT INTO events (id, timestamp, type, data) VALUES (?, ?, ?, ?)'
    ).run('e1', 1000, 'user_message', '{}');
    db.prepare(
      'INSERT INTO event_sessions (event_id, session_id, sequence) VALUES (?, ?, ?)'
    ).run('e1', 's1', 1);

    // Delete session — join rows should cascade
    db.prepare('DELETE FROM sessions WHERE id = ?').run('s1');

    const links = db.prepare('SELECT * FROM event_sessions WHERE session_id = ?').all('s1');
    expect(links).toHaveLength(0);

    // Event itself still exists (orphan cleanup is application-level)
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get('e1');
    expect(event).toBeDefined();
  });

  it('ON DELETE CASCADE on event_sessions removes links when event is deleted', () => {
    runMigrations(db);

    db.prepare(
      'INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('s1', 'Test', 'deepseek-chat', 1000, 1000);
    db.prepare(
      'INSERT INTO events (id, timestamp, type, data) VALUES (?, ?, ?, ?)'
    ).run('e1', 1000, 'user_message', '{}');
    db.prepare(
      'INSERT INTO event_sessions (event_id, session_id, sequence) VALUES (?, ?, ?)'
    ).run('e1', 's1', 1);

    // Delete event — join rows should cascade
    db.prepare('DELETE FROM events WHERE id = ?').run('e1');

    const links = db.prepare('SELECT * FROM event_sessions WHERE event_id = ?').all('e1');
    expect(links).toHaveLength(0);
  });

  it('snapshots FK ON DELETE CASCADE removes snapshots when session is deleted', () => {
    runMigrations(db);

    db.prepare(
      'INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('s1', 'Test', 'deepseek-chat', 1000, 1000);
    db.prepare(
      'INSERT INTO snapshots (id, session_id, up_to_sequence, timestamp, summary, key_facts, files_modified, token_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('snap1', 's1', 2, 2000, 'summary', '[]', '[]', 10);

    db.prepare('DELETE FROM sessions WHERE id = ?').run('s1');

    const snapshots = db.prepare('SELECT * FROM snapshots WHERE session_id = ?').all('s1');
    expect(snapshots).toHaveLength(0);
  });

  // ==========================================================================
  // Command rules
  // ==========================================================================

  it('command_rules table exists with CHECK constraints', () => {
    runMigrations(db);

    // Valid insert
    db.prepare(
      'INSERT INTO command_rules (prefix, type, source, created_at) VALUES (?, ?, ?, ?)'
    ).run('ls', 'allowed', 'default', Date.now());

    // Invalid type
    expect(() => {
      db.prepare(
        'INSERT INTO command_rules (prefix, type, source, created_at) VALUES (?, ?, ?, ?)'
      ).run('rm', 'invalid_type', 'user', Date.now());
    }).toThrow();

    // Invalid source
    expect(() => {
      db.prepare(
        'INSERT INTO command_rules (prefix, type, source, created_at) VALUES (?, ?, ?, ?)'
      ).run('rm', 'allowed', 'invalid_source', Date.now());
    }).toThrow();
  });

  it('command_rules unique index prevents duplicate prefix+type', () => {
    runMigrations(db);

    db.prepare(
      'INSERT INTO command_rules (prefix, type, source, created_at) VALUES (?, ?, ?, ?)'
    ).run('ls', 'allowed', 'default', Date.now());

    expect(() => {
      db.prepare(
        'INSERT INTO command_rules (prefix, type, source, created_at) VALUES (?, ?, ?, ?)'
      ).run('ls', 'allowed', 'user', Date.now());
    }).toThrow();
  });

  // ==========================================================================
  // Integration: tables can be used after migration
  // ==========================================================================

  it('tables can be used after migration (prepared statements work)', () => {
    runMigrations(db);

    // Insert session
    db.prepare(
      'INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('s1', 'Test', 'deepseek-chat', 1000, 1000);

    // Insert event (session-agnostic)
    db.prepare(
      'INSERT INTO events (id, timestamp, type, data) VALUES (?, ?, ?, ?)'
    ).run('e1', 1000, 'user_message', '{"content":"hello"}');

    // Link via join table
    db.prepare(
      'INSERT INTO event_sessions (event_id, session_id, sequence) VALUES (?, ?, ?)'
    ).run('e1', 's1', 1);

    // Insert snapshot
    db.prepare(
      'INSERT INTO snapshots (id, session_id, up_to_sequence, timestamp, summary, key_facts, files_modified, token_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('snap1', 's1', 1, 1000, 'summary', '[]', '[]', 10);

    // Query via JOIN
    const result = db.prepare(`
      SELECT e.data, es.sequence
      FROM events e
      JOIN event_sessions es ON e.id = es.event_id
      WHERE es.session_id = ?
      ORDER BY es.sequence
    `).all('s1') as any[];

    expect(result).toHaveLength(1);
    expect(result[0].sequence).toBe(1);
    expect(JSON.parse(result[0].data).content).toBe('hello');
  });

  it('transaction wrapper works for atomic operations', () => {
    runMigrations(db);

    db.prepare(
      'INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('s1', 'Test', 'deepseek-chat', 1000, 1000);
    db.prepare(
      'INSERT INTO events (id, timestamp, type, data) VALUES (?, ?, ?, ?)'
    ).run('e1', 1000, 'user_message', '{}');
    db.prepare(
      'INSERT INTO event_sessions (event_id, session_id, sequence) VALUES (?, ?, ?)'
    ).run('e1', 's1', 1);

    // Transaction: delete session + orphan cleanup
    const deleteAll = db.transaction(() => {
      db.prepare('DELETE FROM sessions WHERE id = ?').run('s1');
      db.prepare(
        'DELETE FROM events WHERE id NOT IN (SELECT event_id FROM event_sessions)'
      ).run();
    });
    deleteAll();

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('s1');
    expect(session).toBeUndefined();

    const events = db.prepare('SELECT * FROM events').all();
    expect(events).toHaveLength(0);

    const links = db.prepare('SELECT * FROM event_sessions').all();
    expect(links).toHaveLength(0);
  });
});
