# Database Layer

The persistence layer uses **SQLite** via **@signalapp/sqlcipher** (a native N-API addon wrapping SQLCipher) to store conversation events, sessions, and snapshots with encryption at rest.

## Why @signalapp/sqlcipher?

- **Encryption at rest** — AES-256-CBC encryption via SQLCipher
- **Native performance** — Direct disk I/O, no WASM memory overhead
- **Crash safety** — WAL journal mode for crash recovery
- **Synchronous API** — No async initialization needed
- **Battle-tested** — Used by Signal Desktop (also an Electron app)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Database Technology Stack                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │                    ConversationManager                           │        │
│  │                    (Application Layer)                           │        │
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

## Database Schema

### Events Table

```sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,              -- UUID
  session_id TEXT NOT NULL,         -- FK to sessions
  sequence INTEGER NOT NULL,        -- Per-session auto-increment
  timestamp INTEGER NOT NULL,       -- Unix timestamp (ms)
  type TEXT NOT NULL,               -- Event type discriminator
  data TEXT NOT NULL,               -- JSON payload

  UNIQUE(session_id, sequence)
);

CREATE INDEX idx_events_session_sequence
  ON events(session_id, sequence);

CREATE INDEX idx_events_session_type
  ON events(session_id, type);
```

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
  last_activity_preview TEXT        -- For display
);

CREATE INDEX idx_sessions_updated
  ON sessions(updated_at DESC);
```

### Snapshots Table

```sql
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,              -- UUID
  session_id TEXT NOT NULL,         -- FK to sessions
  up_to_sequence INTEGER NOT NULL,  -- Events summarized
  created_at INTEGER NOT NULL,      -- Unix timestamp
  summary TEXT NOT NULL,            -- Natural language
  key_facts TEXT NOT NULL,          -- JSON array
  files_modified TEXT NOT NULL,     -- JSON array
  token_count INTEGER NOT NULL      -- Estimated tokens
);

CREATE INDEX idx_snapshots_session
  ON snapshots(session_id, up_to_sequence DESC);
```

## Entity Relationship Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Database Schema                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────┐         ┌─────────────────────────┐            │
│  │       sessions          │         │        events           │            │
│  ├─────────────────────────┤         ├─────────────────────────┤            │
│  │ PK  id                  │◄────────│ FK  session_id          │            │
│  │     title               │    1:N  │ PK  id                  │            │
│  │     model               │         │     sequence            │            │
│  │     created_at          │         │     timestamp           │            │
│  │     updated_at          │         │     type                │            │
│  │     event_count         │         │     data (JSON)         │            │
│  │     tags (JSON)         │         └─────────────────────────┘            │
│  │     first_user_message  │                                                │
│  │     last_activity_preview│                                               │
│  └──────────┬──────────────┘                                                │
│             │                                                                │
│             │ 1:N                                                            │
│             │                                                                │
│             ▼                                                                │
│  ┌─────────────────────────┐                                                │
│  │       snapshots         │                                                │
│  ├─────────────────────────┤                                                │
│  │ PK  id                  │                                                │
│  │ FK  session_id          │                                                │
│  │     up_to_sequence      │                                                │
│  │     created_at          │                                                │
│  │     summary             │                                                │
│  │     key_facts (JSON)    │                                                │
│  │     files_modified (JSON)│                                               │
│  │     token_count         │                                                │
│  └─────────────────────────┘                                                │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## SqlJsWrapper API

The wrapper provides a synchronous API that adapts @signalapp/sqlcipher's array-param style to spread-args:

```typescript
// Database class
class Database {
  constructor(filePath?: string, encryptionKey?: string);

  exec(sql: string): void;         // Execute multiple statements
  prepare(sql: string): Statement; // Prepare for repeated use
  pragma(pragma: string): void;    // Set pragmas
  transaction<T>(fn: () => T): () => T;  // Transaction wrapper
  close(): void;                   // Close connection
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
const db = new Database('/path/to/moby.db', encryptionKey);

// Execute schema
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    data TEXT NOT NULL
  )
`);

// Prepared statements for performance
const insertStmt = db.prepare(
  'INSERT INTO events (id, session_id, data) VALUES (?, ?, ?)'
);
insertStmt.run('uuid-1', 'session-1', '{"type":"user_message"}');

// Query
const selectStmt = db.prepare(
  'SELECT * FROM events WHERE session_id = ?'
);
const events = selectStmt.all('session-1');

// Transactions
const batchInsert = db.transaction(() => {
  for (const event of events) {
    insertStmt.run(event.id, event.sessionId, JSON.stringify(event));
  }
});
batchInsert();  // Atomic - all or nothing

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
// Prepared once
this.stmtInsertEvent = this.db.prepare(`
  INSERT INTO events (id, session_id, sequence, timestamp, type, data)
  VALUES (?, ?, ?, ?, ?, ?)
`);

// Reused many times
this.stmtInsertEvent.run(id, sessionId, sequence, timestamp, type, data);
```

### Indexes

Strategic indexes for common queries:

```sql
-- Fast session event retrieval
CREATE INDEX idx_events_session_sequence ON events(session_id, sequence);

-- Fast event type filtering
CREATE INDEX idx_events_session_type ON events(session_id, type);

-- Fast session listing
CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);
```

## File Locations

| Path | Description |
|------|-------------|
| `~/.vscode/extensions/.../globalStorage/moby.db` | Encrypted database |
| `src/events/SqlJsWrapper.ts` | Database abstraction layer |

## Testing

For tests, use in-memory databases:

```typescript
import { Database } from './SqlJsWrapper';

describe('EventStore', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');  // Fresh DB each test
  });

  afterEach(() => {
    db.close();
  });

  it('should store events', () => {
    // Tests run in-memory, no file I/O
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
| `sessions` | Session metadata (title, model, timestamps, event count) |
| `events` | Append-only event log (messages, tool calls, diffs, searches) |
| `snapshots` | Periodic conversation summaries for context compression |

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
| `currentSessionId` | Active session UUID pointer |

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
