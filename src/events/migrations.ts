/**
 * Schema — single clean version for the event-sourcing database.
 *
 * Fresh start: no migration history, no version-gated upgrades.
 * All tables are created from scratch with the final schema.
 *
 * Key design:
 * - Events are session-agnostic (no session_id/sequence on the events table)
 * - event_sessions join table provides M:N mapping with per-session sequencing
 * - This enables zero-copy forking: link existing events to a new session
 * - Orphan cleanup is application-level (EventStore.deleteSessionEvents)
 */

import { Database } from './SqlJsWrapper';
import { logger } from '../utils/logger';

const LATEST_VERSION = 1;

export function runMigrations(db: Database): void {
  const version = db.pragmaGet('user_version');

  if (version < 1) {
    logger.info('[Migrations] Applying version 1: clean schema with event_sessions join table');
    db.exec(`
      -- Sessions (with fork metadata)
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
        last_activity_preview TEXT,
        parent_session_id TEXT,
        fork_sequence INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_updated
        ON sessions(updated_at DESC);

      -- Events (session-agnostic — no session_id or sequence)
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL
      );

      -- Join table (M:N — each session curates its events with per-session sequence)
      CREATE TABLE IF NOT EXISTS event_sessions (
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        UNIQUE(session_id, sequence),
        UNIQUE(event_id, session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_event_sessions_session
        ON event_sessions(session_id, sequence);

      -- Snapshots (session-specific)
      CREATE TABLE IF NOT EXISTS snapshots (
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
      CREATE INDEX IF NOT EXISTS idx_snapshots_session
        ON snapshots(session_id, up_to_sequence DESC);

      -- Command rules (allowed/blocked command prefixes)
      CREATE TABLE IF NOT EXISTS command_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prefix TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('allowed', 'blocked')),
        source TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('default', 'user')),
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_command_rules_prefix_type
        ON command_rules(prefix, type);

      -- Saved system prompts
      CREATE TABLE IF NOT EXISTS saved_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        model TEXT,
        is_active INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- ADR 0003: functional index on turnId (JSON-embedded in events.data) so
      -- Phase 3 hydration can group structural_turn_event and assistant_message
      -- rows by turn without a full table scan. Partial index keeps it small.
      CREATE INDEX IF NOT EXISTS idx_events_turn_id
        ON events (json_extract(data, '$.turnId'))
        WHERE type IN ('assistant_message', 'structural_turn_event');
    `);
  }

  db.pragma(`user_version = ${LATEST_VERSION}`);
  logger.info(`[Migrations] Database at version ${LATEST_VERSION} (was ${version})`);
}
