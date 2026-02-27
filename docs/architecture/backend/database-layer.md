# Database Layer

The persistence layer uses **SQLite** via **@signalapp/sqlcipher** (a native N-API addon wrapping SQLCipher) to store conversation events, sessions, and snapshots with encryption at rest.

## Why @signalapp/sqlcipher?

- **Encryption at rest** — AES-256-CBC encryption via SQLCipher
- **Native performance** — Direct disk I/O, no WASM memory overhead
- **Crash safety** — WAL journal mode for crash recovery and concurrent reads
- **Synchronous API** — No async initialization needed
- **Battle-tested** — Used by Signal Desktop (also an Electron app)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Database Technology Stack                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │                    ConversationManager                           │        │
│  │              (Pure Data Service — no session state)              │        │
│  └────────────────────────────────┬────────────────────────────────┘        │
│                                   │                                          │
│                                   ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │                       SqlJsWrapper                               │        │
│  │                  (Compatibility Layer)                           │        │
│  │                                                                  │        │
│  │   Adapts spread-args → array for statement params:              │        │
│  │   • db.exec(sql)                                                 │        │
│  │   • db.prepare(sql).run/get/all()                               │        │
│  │   • db.transaction(fn)                                           │        │
│  └────────────────────────────────┬────────────────────────────────┘        │
│                                   │                                          │
│                                   ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │                    @signalapp/sqlcipher                          │        │
│  │                  (Native N-API SQLCipher)                        │        │
│  │                                                                  │        │
│  │   • Prebuilt binaries for 6 platforms                           │        │
│  │   • Direct disk I/O (no in-memory copy)                         │        │
│  │   • AES-256-CBC encryption                                      │        │
│  └────────────────────────────────┬────────────────────────────────┘        │
│                                   │                                          │
│                                   ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │                    File System                                   │        │
│  │              ~/.vscode/.../moby.db                      │        │
│  └─────────────────────────────────────────────────────────────────┘        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Encryption

The database is encrypted using a key stored in VS Code's SecretStorage (OS keychain-backed):

```typescript
// extension.ts — key management
const DB_KEY_SECRET = 'deepseek-moby.db-encryption-key';

async function getOrCreateEncryptionKey(context: vscode.ExtensionContext): Promise<string> {
  let key = await context.secrets.get(DB_KEY_SECRET);
  if (!key) {
    key = crypto.randomBytes(32).toString('hex');
    await context.secrets.store(DB_KEY_SECRET, key);
  }
  return key;
}

// Key is passed to ConversationManager constructor
conversationManager = new ConversationManager(context, dbKey);
```

## Schema Migrations

All schema is managed by `src/events/migrations.ts` — the **single source of truth**. Schema versioning uses SQLite's `PRAGMA user_version` (a single integer in the DB file header, readable in < 1 ms).

```
ConversationManager constructor:
  1. new Database(dbPath, encryptionKey)    → PRAGMA foreign_keys = ON
                                             → PRAGMA journal_mode = WAL
                                             → PRAGMA busy_timeout = 5000
  2. runMigrations(this.db)                 → v1: clean schema (all tables + indexes)
  3. new EventStore(this.db)               → prepareStatements() only
  4. new SnapshotManager(this.db, ...)     → prepareStatements() only
  5. prepare session statements (no session state — ChatProvider owns lifecycle)
```

The schema uses a **fresh single-version approach** — no migration history, no version-gated upgrades. Version 1 creates all tables from scratch with the final schema (including M:N join table and FK constraints).

- **Adding schema changes:** add a new `if (version < N)` block in `migrations.ts`, bump `LATEST_VERSION`

### Schema Ownership

| Concern | Owner |
|---------|-------|
| Table creation, indexes, schema changes | `migrations.ts` (versioned) |
| Prepared statements | Constructors (`EventStore`, `SnapshotManager`, `ConversationManager`) |

## Database Schema

### Sessions Table

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,              -- UUID
  title TEXT NOT NULL,              -- Display title
  model TEXT NOT NULL,              -- LLM model used
  created_at INTEGER NOT NULL,      -- Unix timestamp
  updated_at INTEGER NOT NULL,      -- Last activity
  event_count INTEGER DEFAULT 0,    -- Cached count
  last_snapshot_sequence INTEGER DEFAULT 0,
  tags TEXT DEFAULT '[]',           -- JSON array
  first_user_message TEXT,          -- For display
  last_activity_preview TEXT,       -- For display
  parent_session_id TEXT,           -- Fork parent (NULL = original)
  fork_sequence INTEGER             -- Sequence in parent where forked
);

CREATE INDEX idx_sessions_updated
  ON sessions(updated_at DESC);
```

### Events Table (session-agnostic)

Events are **session-agnostic** — they store immutable facts without `session_id` or `sequence`. The `event_sessions` join table maps events to sessions with per-session sequencing.

```sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,              -- UUID
  timestamp INTEGER NOT NULL,       -- Unix timestamp (ms)
  type TEXT NOT NULL,               -- Event type discriminator
  data TEXT NOT NULL                -- JSON payload (no sessionId/sequence inside)
);
```

### Event Sessions Join Table (M:N)

The join table provides the M:N relationship between events and sessions. Each session curates its events with per-session sequence numbering. This enables **zero-copy forking**: link existing events to a new session via `INSERT...SELECT` without duplicating event data.

```sql
CREATE TABLE event_sessions (
  event_id TEXT NOT NULL            -- FK to events
    REFERENCES events(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL          -- FK to sessions
    REFERENCES sessions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,        -- Per-session ordering
  UNIQUE(session_id, sequence),     -- One event per sequence per session
  UNIQUE(event_id, session_id)      -- An event appears at most once per session
);

CREATE INDEX idx_event_sessions_session
  ON event_sessions(session_id, sequence);
```

### Snapshots Table (FK → sessions)

```sql
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,              -- UUID
  session_id TEXT NOT NULL          -- FK to sessions
    REFERENCES sessions(id) ON DELETE CASCADE,
  up_to_sequence INTEGER NOT NULL,  -- Events summarized
  timestamp INTEGER NOT NULL,       -- Unix timestamp
  summary TEXT NOT NULL,            -- Natural language
  key_facts TEXT NOT NULL,          -- JSON array
  files_modified TEXT NOT NULL,     -- JSON array
  token_count INTEGER NOT NULL,     -- Estimated tokens

  UNIQUE(session_id, up_to_sequence)
);

CREATE INDEX idx_snapshots_session
  ON snapshots(session_id, up_to_sequence DESC);
```

### Command Rules Table

```sql
CREATE TABLE command_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prefix TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('allowed', 'blocked')),
  source TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('default', 'user')),
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_command_rules_prefix_type
  ON command_rules(prefix, type);
```

## Entity Relationship Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   Database Schema (M:N Join Table)                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────┐         ┌─────────────────────────┐            │
│  │       sessions          │         │        events           │            │
│  ├─────────────────────────┤         ├─────────────────────────┤            │
│  │ PK  id                  │         │ PK  id                  │            │
│  │     title               │         │     timestamp           │            │
│  │     model               │         │     type                │            │
│  │     created_at          │         │     data (JSON)         │            │
│  │     updated_at          │         └──────────┬──────────────┘            │
│  │     event_count         │                    │                            │
│  │     tags (JSON)         │                    │ M:N via join table         │
│  │     first_user_message  │                    │                            │
│  │     last_activity_preview│    ┌──────────────┴──────────────┐            │
│  │     parent_session_id   │    │      event_sessions          │            │
│  │     fork_sequence       │    ├─────────────────────────────┤            │
│  └──────────┬──────────────┘    │ FK  event_id CASCADE        │            │
│             │                    │ FK  session_id CASCADE      │            │
│             ├────────────────────│     sequence                │            │
│             │                    └─────────────────────────────┘            │
│             │ 1:N                                                            │
│             │                                                                │
│             ▼                                                                │
│  ┌─────────────────────────┐                                                │
│  │       snapshots         │                                                │
│  ├─────────────────────────┤                                                │
│  │ PK  id                  │                                                │
│  │ FK  session_id CASCADE  │                                                │
│  │     up_to_sequence      │                                                │
│  │     timestamp           │                                                │
│  │     summary             │                                                │
│  │     key_facts (JSON)    │                                                │
│  │     files_modified (JSON)│                                               │
│  │     token_count         │                                                │
│  └─────────────────────────┘                                                │
│                                                                              │
│  Per-connection pragmas (set in Database constructor):                      │
│  • PRAGMA foreign_keys = ON                                                 │
│  • PRAGMA journal_mode = WAL (concurrent reads, crash safety)              │
│  • PRAGMA busy_timeout = 5000 (retry 5s on lock instead of failing)        │
│                                                                              │
│  Deletion behavior:                                                         │
│  • ON DELETE CASCADE: session delete removes event_sessions + snapshots     │
│  • Orphan cleanup: application-level DELETE of unreferenced events          │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## SqlJsWrapper API

The wrapper provides a synchronous API that adapts @signalapp/sqlcipher's array-param style to spread-args:

```typescript
// Database class
class Database {
  constructor(filePath?: string, encryptionKey?: string);
  // Constructor enables: foreign_keys=ON, journal_mode=WAL, busy_timeout=5000

  exec(sql: string): void;                // Execute multiple statements
  prepare(sql: string): Statement;        // Prepare for repeated use
  pragma(pragma: string): void;           // Set pragmas (write-only)
  pragmaGet(name: string): number;        // Read integer pragma (e.g., user_version)
  transaction<T>(fn: () => T): () => T;   // Transaction wrapper
  close(): void;                          // Close connection
}

// StatementWrapper class (adapts spread-args → array)
class StatementWrapper {
  run(...params: unknown[]): void;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
```

### Usage Examples

```typescript
// Create database (synchronous — no async init needed)
// Constructor automatically sets PRAGMA foreign_keys = ON
const db = new Database('/path/to/moby.db', encryptionKey);

// Run migrations (creates/updates all tables — single source of truth)
runMigrations(db);

// Prepared statements for performance
const insertStmt = db.prepare(
  'INSERT INTO events (id, timestamp, type, data) VALUES (?, ?, ?, ?)'
);
insertStmt.run('uuid-1', Date.now(), 'user_message', '{"content":"hello"}');

// Query events for a session via join table
const selectStmt = db.prepare(`
  SELECT e.data, es.sequence, es.session_id
  FROM events e
  JOIN event_sessions es ON e.id = es.event_id
  WHERE es.session_id = ? AND es.sequence > ?
  ORDER BY es.sequence ASC
`);
const events = selectStmt.all('session-1', 0);

// Transactions (atomic — all or nothing)
const deleteAll = db.transaction(() => {
  db.prepare('DELETE FROM sessions WHERE id = ?').run('session-1');
  // CASCADE removes event_sessions rows; clean up orphaned events
  db.prepare('DELETE FROM events WHERE id NOT IN (SELECT event_id FROM event_sessions)').run();
});
deleteAll();

// Read pragma values
const version = db.pragmaGet('user_version');  // Returns number

// Close
db.close();
```

## Webpack Configuration

The native module is externalized (not bundled):

```javascript
// webpack.config.js
module.exports = {
  externals: {
    vscode: 'commonjs vscode',
    '@signalapp/sqlcipher': 'commonjs @signalapp/sqlcipher'
  }
};
```

## Performance Considerations

### Prepared Statements

All frequently-used queries use prepared statements:

```typescript
// Prepared once — events table (session-agnostic)
this.stmtInsertEvent = this.db.prepare(`
  INSERT INTO events (id, timestamp, type, data) VALUES (?, ?, ?, ?)
`);

// Prepared once — join table (links event to session with sequence)
this.stmtInsertEventSession = this.db.prepare(`
  INSERT INTO event_sessions (event_id, session_id, sequence) VALUES (?, ?, ?)
`);

// Reused many times
this.stmtInsertEvent.run(id, timestamp, type, data);
this.stmtInsertEventSession.run(id, sessionId, nextSequence);
```

### Indexes

Strategic indexes for common queries:

```sql
-- Fast per-session event retrieval via join table
CREATE INDEX idx_event_sessions_session ON event_sessions(session_id, sequence);

-- Fast session listing
CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);
```

## File Locations

| Path | Description |
|------|-------------|
| `~/.vscode/extensions/.../globalStorage/moby.db` | Encrypted database |
| `src/events/migrations.ts` | Schema migrations (single source of truth for all DDL) |
| `src/events/SqlJsWrapper.ts` | Database abstraction layer |

## Testing

For tests, use in-memory databases with migrations:

```typescript
import { Database } from '../../../src/events/SqlJsWrapper';
import { runMigrations } from '../../../src/events/migrations';

describe('EventStore', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');  // Fresh DB each test
    runMigrations(db);             // Creates all tables (sessions, events, event_sessions, etc.)
    // FK constraints require parent sessions before inserting events
    db.prepare('INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('session-1', 'Test', 'test', 1000, 1000);
  });

  afterEach(() => {
    db.close();
  });

  it('should store events via join table', () => {
    // EventStore.append() inserts into both events + event_sessions
    // Reads hydrate sessionId/sequence from the join table
  });
});
```

## Troubleshooting

### Database corruption

SQLite is robust, but if issues occur:
1. Delete `moby.db`
2. Data is regenerated (but history is lost)

### Encryption key lost

If the OS keychain is cleared, the encryption key is lost and the database cannot be opened. Delete `moby.db` to start fresh.

## Extension Storage Overview

The extension uses four distinct storage mechanisms, each chosen for its security and persistence characteristics:

### 1. SQLite Database (Encrypted)

**Location:** `~/.vscode/extensions/.../globalStorage/moby.db`
**Encryption:** AES-256-CBC via @signalapp/sqlcipher

All conversation data lives here:

| Table | Contents |
|-------|----------|
| `sessions` | Session metadata (title, model, timestamps, fork info) |
| `events` | Session-agnostic append-only event log (messages, tool calls, diffs) |
| `event_sessions` | M:N join table linking events to sessions with per-session sequence |
| `snapshots` | Periodic conversation summaries for context compression |
| `command_rules` | Allowed/blocked command prefixes for shell approval |

### 2. VS Code SecretStorage (`context.secrets`)

OS keychain-backed encrypted storage for sensitive credentials:

| Key | Purpose | Set By |
|-----|---------|--------|
| `deepseek-moby.db-encryption-key` | Database encryption key (64-char hex) | Auto-generated on first run |
| `deepseek.apiKey` | DeepSeek API key | User via `deepseek.setApiKey` command |
| `deepseek.tavilyApiKey` | Tavily web search API key | User via `deepseek.setTavilyApiKey` command |

### 3. VS Code Settings (`workspace.getConfiguration('deepseek')`)

User-facing configuration in `settings.json`. Non-sensitive values only:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `model` | string | `deepseek-chat` | LLM model selection |
| `temperature` | number | 0.7 | Creativity level |
| `maxTokens` | number | 8192 | Max output tokens |
| `maxToolCalls` | number | 100 | Tool loop iterations (Chat model) |
| `maxShellIterations` | number | 100 | Shell iterations (Reasoner model) |
| `editMode` | string | `manual` | Code edit mode (manual/ask/auto) |
| `systemPrompt` | string | `""` | Custom system prompt |
| `showStatusBar` | boolean | true | Status bar visibility |
| `enableCompletions` | boolean | true | Inline completions |
| `autoFormat` | boolean | true | Auto-format code |
| `useLanguageFormatter` | boolean | true | Use VS Code formatter |
| `autoSaveHistory` | boolean | true | Auto-save conversations |
| `maxHistorySessions` | number | 100 | Max session retention |
| `logLevel` | string | `WARN` | Extension output log level |
| `webviewLogLevel` | string | `WARN` | Webview console log level |
| `logColors` | boolean | true | Color-coded log output |
| `tracing.enabled` | boolean | true | Trace collection |
| `tavilySearchesPerPrompt` | number | 1 | Web searches per prompt |
| `tavilySearchDepth` | string | `basic` | Tavily search depth |

### 4. VS Code globalState (`context.globalState`)

Minimal key-value store for cross-restart state:

| Key | Purpose |
|-----|---------|
| `currentSessionId` | Shared session pointer (cold-start fallback — last active session). Owned by ChatProvider. |
| `currentSessionId-{instanceId}` | Instance-scoped session pointer (runtime isolation between parallel panels). Owned by ChatProvider. |

### Storage Decision Guide

| Data Type | Store | Reason |
|-----------|-------|--------|
| Credentials, API keys | `context.secrets` | OS keychain encryption |
| Conversation data | SQLite DB | Structured, queryable, encrypted at rest |
| User preferences | VS Code settings | Editable in settings UI, syncs across machines |
| Cross-restart pointers | `globalState` | Simple, lightweight |
| Transient UI state | In-memory | Too much churn for persistence |

## Related Documentation

- [Event Sourcing](event-sourcing.md) - How events are stored and queried
- [Backend Architecture](backend-architecture.md) - System overview
