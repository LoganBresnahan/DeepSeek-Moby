# Database Layer

The persistence layer uses **SQLite** via **sql.js** (a WebAssembly port of SQLite) to store conversation events, sessions, and snapshots.

## Why sql.js?

VS Code extensions run in a Node.js environment, but **native modules** (like `better-sqlite3`) can cause problems:
- Require compilation for each platform
- May not match VS Code's Electron version
- Cause "native binding not found" errors

**sql.js** solves this by compiling SQLite to WebAssembly:
- Pure JavaScript/WASM - no native bindings
- Works on any platform without compilation
- Same SQLite API and behavior

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
│  │   Provides better-sqlite3-like API:                             │        │
│  │   • db.exec(sql)                                                 │        │
│  │   • db.prepare(sql).run/get/all()                               │        │
│  │   • db.transaction(fn)                                           │        │
│  └────────────────────────────────┬────────────────────────────────┘        │
│                                   │                                          │
│                                   ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │                         sql.js                                   │        │
│  │                   (SQLite in WASM)                               │        │
│  │                                                                  │        │
│  │   • Loads sql-wasm.wasm binary                                  │        │
│  │   • In-memory or file-backed databases                          │        │
│  │   • Full SQL support                                             │        │
│  └────────────────────────────────┬────────────────────────────────┘        │
│                                   │                                          │
│                                   ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │                    File System                                   │        │
│  │              ~/.vscode/.../conversations.db                      │        │
│  └─────────────────────────────────────────────────────────────────┘        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## WASM Initialization

sql.js requires loading the WASM binary before creating databases:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        WASM Loading Sequence                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Extension Activates                                                         │
│         │                                                                    │
│         ▼                                                                    │
│  new ConversationManager(context)                                            │
│         │                                                                    │
│         ├──► initPromise = this.initialize()  (async, not awaited)          │
│         │                                                                    │
│         ▼                                                                    │
│  initialize()                                                                │
│         │                                                                    │
│         ├──► await initializeSqlJs()                                         │
│         │         │                                                          │
│         │         ├──► Search for sql-wasm.wasm file                        │
│         │         │    • dist/sql-wasm.wasm (runtime)                       │
│         │         │    • node_modules/sql.js/dist/ (development)            │
│         │         │                                                          │
│         │         ├──► fs.readFileSync(wasmPath)                            │
│         │         │                                                          │
│         │         ├──► Convert Buffer to ArrayBuffer                        │
│         │         │                                                          │
│         │         └──► SQL = await initSqlJs({ wasmBinary })                │
│         │                                                                    │
│         ├──► this.db = new Database(dbPath)                                 │
│         │                                                                    │
│         └──► this.initialized = true                                         │
│                                                                              │
│                                                                              │
│  Any public method                                                           │
│         │                                                                    │
│         └──► await this.ensureInitialized()                                 │
│                   │                                                          │
│                   └──► await this.initPromise  (waits for WASM)             │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Webpack Configuration

The WASM file must be copied to the dist directory, not bundled:

```javascript
// webpack.config.js
module.exports = {
  externals: {
    vscode: 'commonjs vscode',
    'sql.js': 'commonjs sql.js'  // Don't bundle - has WASM loading issues
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        {
          from: 'node_modules/sql.js/dist/sql-wasm.wasm',
          to: 'sql-wasm.wasm'
        }
      ]
    })
  ]
};
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

The wrapper provides a synchronous API similar to better-sqlite3:

```typescript
// Database class
class Database {
  constructor(filePath?: string);  // ':memory:' for in-memory

  exec(sql: string): void;         // Execute multiple statements
  prepare(sql: string): Statement; // Prepare for repeated use
  pragma(pragma: string): void;    // Set pragmas
  transaction<T>(fn: () => T): () => T;  // Transaction wrapper
  close(): void;                   // Save and close
}

// Statement class
class Statement {
  run(...params: unknown[]): void;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
```

### Usage Examples

```typescript
// Initialize
await initializeSqlJs();

// Create database
const db = new Database('/path/to/conversations.db');

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

// Close (saves to file)
db.close();
```

## Auto-Save Mechanism

Changes are automatically saved to disk:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Auto-Save Strategy                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  db.exec('INSERT ...')                                                       │
│         │                                                                    │
│         ├──► Execute SQL in-memory                                          │
│         │                                                                    │
│         └──► scheduleSave()                                                 │
│                   │                                                          │
│                   ├──► if (saveScheduled) return;                           │
│                   │                                                          │
│                   ├──► saveScheduled = true;                                │
│                   │                                                          │
│                   └──► setImmediate(() => {                                 │
│                             saveScheduled = false;                          │
│                             saveToFile();                                   │
│                        });                                                  │
│                                                                              │
│  saveToFile()                                                                │
│         │                                                                    │
│         ├──► const data = db.export();  // Get full DB as Uint8Array       │
│         │                                                                    │
│         ├──► fs.mkdirSync(dir, { recursive: true });                        │
│         │                                                                    │
│         └──► fs.writeFileSync(filePath, Buffer.from(data));                 │
│                                                                              │
│                                                                              │
│  Benefits:                                                                   │
│  • Debounced - multiple writes → single save                                │
│  • Non-blocking - uses setImmediate                                         │
│  • Atomic - full DB written at once                                         │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## File Locations

| Path | Description |
|------|-------------|
| `~/.vscode/extensions/.../globalStorage/conversations.db` | Production database |
| `dist/sql-wasm.wasm` | WebAssembly binary (copied by webpack) |
| `src/events/SqlJsWrapper.ts` | Database abstraction layer |
| `src/events/sql.js.d.ts` | TypeScript declarations for sql.js |

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

### Batch Operations

Use transactions for bulk inserts:

```typescript
appendBatch(events: NewEvent[]): ConversationEvent[] {
  const insertAll = this.db.transaction(() => {
    return events.map(event => this.appendSingle(event));
  });
  return insertAll();  // Single transaction, single disk write
}
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

## Testing

For tests, use in-memory databases:

```typescript
import { Database, initializeSqlJs } from './SqlJsWrapper';

describe('EventStore', () => {
  let db: Database;

  beforeAll(async () => {
    await initializeSqlJs();  // Load WASM once
  });

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

## Migration from ChatHistoryManager

The old system used JSON files. The migration path:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Old vs New Storage                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  OLD: ChatHistoryManager                                                     │
│  ┌─────────────────────────────────────────────────────────────┐            │
│  │  ~/.vscode/.../sessions/                                     │            │
│  │    ├── session-abc.json  { messages: [...] }                │            │
│  │    ├── session-def.json  { messages: [...] }                │            │
│  │    └── ...                                                   │            │
│  │                                                              │            │
│  │  Problems:                                                   │            │
│  │  • Full messages stored (no compression)                    │            │
│  │  • No event history (mutations lost)                        │            │
│  │  • File per session (many small files)                      │            │
│  │  • No transactions (corruption risk)                        │            │
│  └─────────────────────────────────────────────────────────────┘            │
│                           │                                                  │
│                           ▼                                                  │
│  NEW: ConversationManager + SQLite                                          │
│  ┌─────────────────────────────────────────────────────────────┐            │
│  │  ~/.vscode/.../conversations.db                              │            │
│  │                                                              │            │
│  │  Benefits:                                                   │            │
│  │  • Event-based (full history)                               │            │
│  │  • Snapshots (context compression)                          │            │
│  │  • Single file (easier backup)                              │            │
│  │  • ACID transactions                                        │            │
│  │  • Efficient queries (indexes)                              │            │
│  └─────────────────────────────────────────────────────────────┘            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Troubleshooting

### "Could not find sql-wasm.wasm"

The WASM file isn't in the expected location. Check:
1. `npm run compile` was run
2. webpack CopyPlugin copied the file
3. File exists in `dist/sql-wasm.wasm`

### "sql.js not initialized"

`initializeSqlJs()` wasn't called or awaited:
```typescript
await conversationManager.ensureInitialized();
// or
await initializeSqlJs();
const db = new Database();
```

### Database corruption

SQLite is robust, but if issues occur:
1. Delete `conversations.db`
2. Data is regenerated (but history is lost)

## Related Documentation

- [Event Sourcing](event-sourcing.md) - How events are stored and queried
- [Backend Architecture](backend-architecture.md) - System overview
