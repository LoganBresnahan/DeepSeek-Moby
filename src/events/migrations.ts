/**
 * Schema Migrations — single source of truth for all database schema.
 *
 * Uses SQLite's PRAGMA user_version to track which migrations have been applied.
 * Each migration is version-gated: `if (version < N) { ... }`.
 *
 * - Fresh installs: all migrations run in sequence from version 0
 * - Updates: only new migrations run (skips already-applied ones)
 * - Downgrades: old code ignores new columns (SQLite is lenient with SELECT *)
 *
 * Table creation uses CREATE TABLE IF NOT EXISTS so v1 is safe for both
 * fresh installs and existing databases that already have tables from the
 * old scattered constructors.
 */

import { Database } from './SqlJsWrapper';
import { logger } from '../utils/logger';

const LATEST_VERSION = 2;

export function runMigrations(db: Database): void {
  const version = db.pragmaGet('user_version');

  if (version < 1) {
    logger.info('[Migrations] Applying version 1: baseline schema');
    db.exec(`
      -- Sessions table (parent — must be created first for FK references)
      CREATE TABLE IF NOT EXISTS sessions (
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
      CREATE INDEX IF NOT EXISTS idx_sessions_updated
        ON sessions(updated_at DESC);

      -- Events table (child)
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_events_session
        ON events(session_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_events_type
        ON events(session_id, type);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp
        ON events(session_id, timestamp);

      -- Snapshots table (child)
      CREATE TABLE IF NOT EXISTS snapshots (
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
      CREATE INDEX IF NOT EXISTS idx_snapshots_session
        ON snapshots(session_id, up_to_sequence DESC);
    `);
  }

  if (version < 2) {
    logger.info('[Migrations] Applying version 2: FK constraints on events and snapshots');
    db.exec(`
      -- Recreate events with FK + ON DELETE CASCADE
      CREATE TABLE IF NOT EXISTS events_new (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      );
      INSERT OR IGNORE INTO events_new SELECT * FROM events;
      DROP TABLE IF EXISTS events;
      ALTER TABLE events_new RENAME TO events;

      -- Recreate indexes on events
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(session_id, type);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(session_id, timestamp);

      -- Recreate snapshots with FK + ON DELETE CASCADE
      CREATE TABLE IF NOT EXISTS snapshots_new (
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
      INSERT OR IGNORE INTO snapshots_new SELECT * FROM snapshots;
      DROP TABLE IF EXISTS snapshots;
      ALTER TABLE snapshots_new RENAME TO snapshots;

      -- Recreate index on snapshots
      CREATE INDEX IF NOT EXISTS idx_snapshots_session ON snapshots(session_id, up_to_sequence DESC);
    `);
  }

  db.pragma(`user_version = ${LATEST_VERSION}`);
  logger.info(`[Migrations] Database at version ${LATEST_VERSION} (was ${version})`);
}
