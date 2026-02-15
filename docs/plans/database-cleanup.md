# Database Cleanup Plan

Two phases of database infrastructure work: a migration framework and transactional integrity.

## Table of Contents

1. [Phase 1: PRAGMA Migration Framework](#phase-1-pragma-migration-framework)
2. [Phase 2: Transaction Wrapping & FK Constraints](#phase-2-transaction-wrapping--fk-constraints)

---

## Phase 1: PRAGMA Migration Framework

### Goal

Establish `PRAGMA user_version` migration infrastructure so future schema changes (e.g., adding columns, FK constraints) are handled safely and automatically on extension startup.

### Background

SQLite's `PRAGMA user_version` is a single integer stored in the database file header, readable in < 1 ms. It's the standard lightweight migration mechanism for embedded SQLite databases. Currently, the project has no schema versioning — tables are created via `CREATE TABLE IF NOT EXISTS`, which works for initial creation but can't handle schema evolution (adding columns, constraints, etc.).

### Design

A `runMigrations(db)` function runs sequentially through version-gated blocks:

```typescript
// src/events/migrations.ts
import { Database } from './SqlJsWrapper';
import { logger } from '../utils/logger';

export function runMigrations(db: Database): void {
  const version = db.pragmaGet('user_version');

  if (version < 1) {
    // Formalize existing schema as version 1
    // Tables already created by CREATE TABLE IF NOT EXISTS — this just
    // stamps the version so future migrations know the baseline.
    logger.info('[Migrations] Applying version 1: baseline schema');
  }

  // Future migrations go here:
  // if (version < 2) { ... ALTER TABLE or table recreation ... }

  db.pragma('user_version = 1');
  logger.info(`[Migrations] Database at version 1 (was ${version})`);
}
```

### Files to Change

| File | Change |
|------|--------|
| **New: `src/events/migrations.ts`** | `runMigrations(db)` function |
| `src/events/SqlJsWrapper.ts` | Add `pragmaGet(name): number` method (current `pragma()` is void-only) |
| `src/events/ConversationManager.ts` | Call `runMigrations(this.db)` after `new Database(...)` but before `initSessionsSchema()`. Remove stale `maxSnapshotsPerSession` from options interface and constructor. |
| **New: `tests/unit/events/migrations.test.ts`** | Tests: fresh DB gets version 1, idempotent re-run, future migrations run in sequence |
| `docs/architecture/backend/database-layer.md` | Add "Schema Migrations" section |
| `docs/plans/context-management.md` | Update Section 12 to reflect migration framework as "implemented" |

### SqlJsWrapper Addition

```typescript
/**
 * Get an integer pragma value (e.g., user_version, schema_version).
 */
pragmaGet(name: string): number {
  const result = this.db.pragma(name, { simple: true });
  return typeof result === 'number' ? result : 0;
}
```

### Initialization Order

```
ConversationManager constructor:
  1. new Database(dbPath, encryptionKey)
  2. runMigrations(this.db)          ← NEW
  3. initSessionsSchema()            ← CREATE TABLE IF NOT EXISTS
  4. new EventStore(this.db)
  5. new SnapshotManager(this.db, ...)
  6. prepareStatements()
```

Migrations run before table creation. This is safe because:
- Version 0→1 is a no-op (tables don't exist yet on fresh install)
- Future migrations (version 1→2, etc.) can ALTER existing tables
- `CREATE TABLE IF NOT EXISTS` is idempotent — runs after migrations

### Release Process

- Each schema change adds a new `if (version < N)` block
- Fresh installs: all migrations run in sequence from version 0
- Updates: only new migrations run (skips already-applied ones)
- Downgrades: old code ignores new columns (SQLite is lenient with SELECT *)
- Version is set to the latest at the end (single PRAGMA write)

### Dead Code Cleanup

While touching ConversationManager, clean up stale references:
- Remove `maxSnapshotsPerSession` from `ConversationManagerOptions` interface
- Remove `maxSnapshotsPerSession` from SnapshotManager constructor call

---

## Phase 2: Transaction Wrapping & FK Constraints

### Goal

Make `deleteSession()` and `clearAllSessions()` atomic. Enable foreign key constraints so the database itself enforces referential integrity, rather than relying on application-level cascading.

### Background: Current Problems

1. **No atomicity:** `deleteSession()` executes three independent DELETE statements. If the second fails after the first succeeds, orphaned snapshots remain with no parent events.

2. **No FK constraints:** The `session_id` columns in `events` and `snapshots` are plain `TEXT NOT NULL` with no `REFERENCES` clause. The database cannot detect or prevent orphaned records.

3. **No transactions used anywhere:** The `db.transaction()` API exists in SqlJsWrapper but is never called in production code.

### Design

#### Transaction Wrapping

```typescript
// ConversationManager.deleteSession()
async deleteSession(sessionId: string): Promise<void> {
  const deleteAll = this.db.transaction(() => {
    this.eventStore.deleteSessionEvents(sessionId);
    this.snapshotManager.deleteSessionSnapshots(sessionId);
    this.stmtDeleteSession.run(sessionId);
  });
  deleteAll();  // Atomic — all three succeed or all roll back

  if (this.currentSessionId === sessionId) {
    this.currentSessionId = null;
    await this.saveCurrentSession();
  }
  this.onSessionsChanged.fire();
  logger.info(`[ConversationManager] Session deleted (atomic): ${sessionId}`);
}

// ConversationManager.clearAllSessions()
async clearAllSessions(): Promise<void> {
  const clearAll = this.db.transaction(() => {
    this.db.exec('DELETE FROM events');
    this.db.exec('DELETE FROM snapshots');
    this.db.exec('DELETE FROM sessions');
  });
  clearAll();

  this.currentSessionId = null;
  await this.saveCurrentSession();
  this.onSessionsChanged.fire();
}
```

#### Foreign Key Constraints

Enable `PRAGMA foreign_keys = ON` in the Database constructor, after the encryption key:

```typescript
// SqlJsWrapper.ts — Database constructor
if (encryptionKey) {
  this.db.pragma(`key='${encryptionKey}'`);
}
this.db.exec('PRAGMA foreign_keys = ON');
```

Add FK references to CREATE TABLE statements:

```sql
-- events table
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ...
);

-- snapshots table
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ...
);
```

#### Migration for Existing Databases

SQLite doesn't support `ALTER TABLE ADD FOREIGN KEY`. The migration (version 2) must recreate the tables:

```typescript
if (version < 2) {
  logger.info('[Migrations] Applying version 2: FK constraints on events and snapshots');
  db.exec(`
    -- Recreate events with FK
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

    -- Recreate indexes
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(session_id, type);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(session_id, timestamp);

    -- Recreate snapshots with FK
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

    -- Recreate index
    CREATE INDEX IF NOT EXISTS idx_snapshots_session ON snapshots(session_id, up_to_sequence DESC);
  `);
}
```

**Note:** Since this is a pre-release project, we could alternatively just drop and recreate tables. The table recreation with data copy is the safer pattern for when we have real users.

### Files to Change

| File | Change |
|------|--------|
| `src/events/SqlJsWrapper.ts` | Add `PRAGMA foreign_keys = ON` in constructor |
| `src/events/ConversationManager.ts` | Wrap `deleteSession()` and `clearAllSessions()` in transactions |
| `src/events/EventStore.ts` | Add `REFERENCES sessions(id) ON DELETE CASCADE` to CREATE TABLE |
| `src/events/SnapshotManager.ts` | Add `REFERENCES sessions(id) ON DELETE CASCADE` to CREATE TABLE |
| `src/events/migrations.ts` | Add version 2 migration (table recreation with FKs) |
| `tests/unit/events/ConversationManager.test.ts` | Add tests: atomic deleteSession, atomic clearAllSessions, FK cascade |
| `docs/architecture/backend/database-layer.md` | Update schema diagrams with FK constraints, add "Transactions" section |
| `docs/architecture/backend/event-sourcing.md` | Update component diagram, remove `prune()` reference, note FK cascade |
| `docs/plans/context-management.md` | Update Section 12 to reflect transaction wrapping as "done" |

### Initialization Order (Updated)

With FK constraints enabled, table creation order matters:

```
1. new Database(dbPath, encryptionKey)  → PRAGMA foreign_keys = ON
2. runMigrations(this.db)               → version checks + table recreation
3. initSessionsSchema()                 → sessions table (parent)
4. new EventStore(this.db)              → events table (child, FK → sessions)
5. new SnapshotManager(this.db, ...)    → snapshots table (child, FK → sessions)
```

This order already exists — sessions is created first because SnapshotManager's LEFT JOIN references it.

### Testing Considerations

- FK cascade test: insert session + events + snapshots, delete session, verify all three tables are clean
- Transaction atomicity test: simulate failure mid-delete, verify rollback
- `PRAGMA foreign_keys` test: verify it's ON after Database construction

---

## Key Files

| File | Role |
|------|------|
| `src/events/SqlJsWrapper.ts` | Database wrapper, PRAGMA support, transactions |
| `src/events/migrations.ts` | Schema versioning and migrations (new) |
| `src/events/ConversationManager.ts` | Session CRUD, delete cascading |
| `src/events/EventStore.ts` | Event table schema and operations |
| `src/events/SnapshotManager.ts` | Snapshot table schema and operations |
| `docs/architecture/backend/database-layer.md` | Schema documentation |
| `docs/architecture/backend/event-sourcing.md` | Architecture documentation |
