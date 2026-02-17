/**
 * Unit tests for schema migrations.
 *
 * Tests that runMigrations() correctly creates tables,
 * stamps the version, and is idempotent.
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

  it('creates all three tables on fresh database', () => {
    runMigrations(db);

    // Verify sessions table exists
    const sessions = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'"
    ).get();
    expect(sessions).toBeDefined();

    // Verify events table exists
    const events = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='events'"
    ).get();
    expect(events).toBeDefined();

    // Verify snapshots table exists
    const snapshots = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='snapshots'"
    ).get();
    expect(snapshots).toBeDefined();
  });

  it('creates indexes for all tables', () => {
    runMigrations(db);

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
    ).all() as { name: string }[];

    const indexNames = indexes.map(i => i.name);

    expect(indexNames).toContain('idx_sessions_updated');
    expect(indexNames).toContain('idx_events_session');
    expect(indexNames).toContain('idx_events_type');
    expect(indexNames).toContain('idx_events_timestamp');
    expect(indexNames).toContain('idx_snapshots_session');
  });

  it('stamps user_version to latest', () => {
    runMigrations(db);

    const version = db.pragmaGet('user_version');
    expect(version).toBe(3);
  });

  it('is idempotent — running twice does not error', () => {
    runMigrations(db);
    runMigrations(db);

    const version = db.pragmaGet('user_version');
    expect(version).toBe(3);

    // Tables still exist
    const sessions = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'"
    ).get();
    expect(sessions).toBeDefined();
  });

  it('stamps version on existing database that already has tables', () => {
    // Simulate old code that created tables without migrations
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        event_count INTEGER DEFAULT 0,
        last_snapshot_sequence INTEGER DEFAULT 0,
        tags TEXT DEFAULT '[]',
        first_user_message TEXT,
        last_activity_preview TEXT
      );
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      );
      CREATE TABLE snapshots (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        up_to_sequence INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        summary TEXT NOT NULL,
        key_facts TEXT NOT NULL,
        files_modified TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        UNIQUE(session_id, up_to_sequence)
      );
    `);

    // Version is 0 before migrations
    expect(db.pragmaGet('user_version')).toBe(0);

    // Run migrations — should not error (IF NOT EXISTS handles existing tables)
    runMigrations(db);

    expect(db.pragmaGet('user_version')).toBe(3);
  });

  it('preserves existing data when migrating', () => {
    // Simulate old code that created tables and inserted data
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        event_count INTEGER DEFAULT 0,
        last_snapshot_sequence INTEGER DEFAULT 0,
        tags TEXT DEFAULT '[]',
        first_user_message TEXT,
        last_activity_preview TEXT
      );
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      );
      CREATE TABLE snapshots (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        up_to_sequence INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        summary TEXT NOT NULL,
        key_facts TEXT NOT NULL,
        files_modified TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        UNIQUE(session_id, up_to_sequence)
      );
    `);

    // Insert test data
    db.prepare(
      'INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('sess-1', 'Test Session', 'deepseek-chat', 1000, 2000);

    db.prepare(
      'INSERT INTO events (id, session_id, sequence, timestamp, type, data) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('evt-1', 'sess-1', 1, 1000, 'user_message', '{"content":"hello"}');

    // Run migrations
    runMigrations(db);

    // Verify data is preserved
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('sess-1') as any;
    expect(session).toBeDefined();
    expect(session.title).toBe('Test Session');

    const event = db.prepare('SELECT * FROM events WHERE id = ?').get('evt-1') as any;
    expect(event).toBeDefined();
    expect(event.type).toBe('user_message');
  });

  it('starts from version 0 on fresh database', () => {
    // Before migrations, version should be 0
    const version = db.pragmaGet('user_version');
    expect(version).toBe(0);
  });

  it('tables can be used after migration (prepared statements work)', () => {
    runMigrations(db);

    // Insert into sessions
    db.prepare(
      'INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('s1', 'Test', 'deepseek-chat', 1000, 1000);

    // Insert into events
    db.prepare(
      'INSERT INTO events (id, session_id, sequence, timestamp, type, data) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('e1', 's1', 1, 1000, 'user_message', '{}');

    // Insert into snapshots
    db.prepare(
      'INSERT INTO snapshots (id, session_id, up_to_sequence, timestamp, summary, key_facts, files_modified, token_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('snap1', 's1', 1, 1000, 'summary', '[]', '[]', 10);

    // Query back
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('s1');
    expect(session).toBeDefined();

    const event = db.prepare('SELECT * FROM events WHERE session_id = ?').get('s1');
    expect(event).toBeDefined();

    const snapshot = db.prepare('SELECT * FROM snapshots WHERE session_id = ?').get('s1');
    expect(snapshot).toBeDefined();
  });

  // ==========================================================================
  // Phase 2: FK constraints, PRAGMA foreign_keys, cascade behavior
  // ==========================================================================

  it('PRAGMA foreign_keys is ON after Database construction', () => {
    // The Database constructor sets PRAGMA foreign_keys = ON
    const result = db.prepare('PRAGMA foreign_keys').get() as any;
    expect(result.foreign_keys).toBe(1);
  });

  it('v2 migration adds FK constraints to events table', () => {
    runMigrations(db);

    const fks = db.prepare(
      "SELECT * FROM pragma_foreign_key_list('events')"
    ).all() as any[];

    expect(fks.length).toBeGreaterThan(0);
    expect(fks[0].table).toBe('sessions');
    expect(fks[0].from).toBe('session_id');
    expect(fks[0].to).toBe('id');
  });

  it('v2 migration adds FK constraints to snapshots table', () => {
    runMigrations(db);

    const fks = db.prepare(
      "SELECT * FROM pragma_foreign_key_list('snapshots')"
    ).all() as any[];

    expect(fks.length).toBeGreaterThan(0);
    expect(fks[0].table).toBe('sessions');
    expect(fks[0].from).toBe('session_id');
    expect(fks[0].to).toBe('id');
  });

  it('FK ON DELETE CASCADE removes events and snapshots when session is deleted', () => {
    runMigrations(db);

    // Insert session + events + snapshot
    db.prepare(
      'INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('s1', 'Test', 'deepseek-chat', 1000, 1000);

    db.prepare(
      'INSERT INTO events (id, session_id, sequence, timestamp, type, data) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('e1', 's1', 1, 1000, 'user_message', '{}');

    db.prepare(
      'INSERT INTO events (id, session_id, sequence, timestamp, type, data) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('e2', 's1', 2, 2000, 'assistant_message', '{}');

    db.prepare(
      'INSERT INTO snapshots (id, session_id, up_to_sequence, timestamp, summary, key_facts, files_modified, token_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('snap1', 's1', 2, 2000, 'summary', '[]', '[]', 10);

    // Delete the session — cascade should clean up events and snapshots
    db.prepare('DELETE FROM sessions WHERE id = ?').run('s1');

    const events = db.prepare('SELECT * FROM events WHERE session_id = ?').all('s1');
    expect(events).toHaveLength(0);

    const snapshots = db.prepare('SELECT * FROM snapshots WHERE session_id = ?').all('s1');
    expect(snapshots).toHaveLength(0);
  });

  it('FK constraint rejects events with invalid session_id', () => {
    runMigrations(db);

    expect(() => {
      db.prepare(
        'INSERT INTO events (id, session_id, sequence, timestamp, type, data) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('e1', 'nonexistent-session', 1, 1000, 'user_message', '{}');
    }).toThrow();
  });

  it('v2 migration preserves data from v1 tables', () => {
    // Manually apply v1 only (set version to 1)
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        event_count INTEGER DEFAULT 0,
        last_snapshot_sequence INTEGER DEFAULT 0,
        tags TEXT DEFAULT '[]',
        first_user_message TEXT,
        last_activity_preview TEXT
      );
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      );
      CREATE TABLE snapshots (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        up_to_sequence INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        summary TEXT NOT NULL,
        key_facts TEXT NOT NULL,
        files_modified TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        UNIQUE(session_id, up_to_sequence)
      );
    `);
    db.pragma('user_version = 1');

    // Insert data before v2 migration
    db.prepare(
      'INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('s1', 'My Session', 'deepseek-chat', 1000, 2000);

    db.prepare(
      'INSERT INTO events (id, session_id, sequence, timestamp, type, data) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('e1', 's1', 1, 1000, 'user_message', '{"content":"hello"}');

    db.prepare(
      'INSERT INTO snapshots (id, session_id, up_to_sequence, timestamp, summary, key_facts, files_modified, token_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('snap1', 's1', 1, 1000, 'summary', '[]', '[]', 5);

    // Run migrations (only v2 should run)
    runMigrations(db);

    expect(db.pragmaGet('user_version')).toBe(3);

    // Verify data is preserved
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('s1') as any;
    expect(session.title).toBe('My Session');

    const event = db.prepare('SELECT * FROM events WHERE id = ?').get('e1') as any;
    expect(event.type).toBe('user_message');

    const snapshot = db.prepare('SELECT * FROM snapshots WHERE id = ?').get('snap1') as any;
    expect(snapshot.summary).toBe('summary');

    // Verify FK constraints now exist
    const eventFks = db.prepare("SELECT * FROM pragma_foreign_key_list('events')").all();
    expect(eventFks.length).toBeGreaterThan(0);
  });

  it('transaction wrapper works for atomic operations', () => {
    runMigrations(db);

    // Insert a session
    db.prepare(
      'INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('s1', 'Test', 'deepseek-chat', 1000, 1000);

    db.prepare(
      'INSERT INTO events (id, session_id, sequence, timestamp, type, data) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('e1', 's1', 1, 1000, 'user_message', '{}');

    // Transaction should succeed atomically
    const deleteAll = db.transaction(() => {
      db.prepare('DELETE FROM events WHERE session_id = ?').run('s1');
      db.prepare('DELETE FROM sessions WHERE id = ?').run('s1');
    });
    deleteAll();

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('s1');
    expect(session).toBeUndefined();

    const events = db.prepare('SELECT * FROM events WHERE session_id = ?').all('s1');
    expect(events).toHaveLength(0);
  });

  // ==========================================================================
  // Phase 3: command_rules table
  // ==========================================================================

  it('v3 migration creates command_rules table', () => {
    runMigrations(db);

    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='command_rules'"
    ).get();
    expect(table).toBeDefined();
  });

  it('v3 migration creates unique index on command_rules', () => {
    runMigrations(db);

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_command_rules_prefix_type'"
    ).all();
    expect(indexes.length).toBe(1);
  });

  it('command_rules table enforces CHECK constraints', () => {
    runMigrations(db);

    // Invalid type should fail
    expect(() => {
      db.prepare(
        'INSERT INTO command_rules (prefix, type, source, created_at) VALUES (?, ?, ?, ?)'
      ).run('ls', 'invalid_type', 'user', Date.now());
    }).toThrow();

    // Invalid source should fail
    expect(() => {
      db.prepare(
        'INSERT INTO command_rules (prefix, type, source, created_at) VALUES (?, ?, ?, ?)'
      ).run('ls', 'allowed', 'invalid_source', Date.now());
    }).toThrow();
  });

  it('command_rules unique index prevents duplicate prefix+type', () => {
    runMigrations(db);

    db.prepare(
      'INSERT INTO command_rules (prefix, type, source, created_at) VALUES (?, ?, ?, ?)'
    ).run('ls', 'allowed', 'default', Date.now());

    // Same prefix+type should fail (unique constraint)
    expect(() => {
      db.prepare(
        'INSERT INTO command_rules (prefix, type, source, created_at) VALUES (?, ?, ?, ?)'
      ).run('ls', 'allowed', 'user', Date.now());
    }).toThrow();
  });

  it('v3 migration runs on existing v2 database', () => {
    // Simulate a v2 database
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      );
      CREATE TABLE snapshots (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        up_to_sequence INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        summary TEXT NOT NULL,
        key_facts TEXT NOT NULL,
        files_modified TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        UNIQUE(session_id, up_to_sequence)
      );
    `);
    db.pragma('user_version = 2');

    runMigrations(db);

    expect(db.pragmaGet('user_version')).toBe(3);

    // command_rules table should exist
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='command_rules'"
    ).get();
    expect(table).toBeDefined();
  });
});
