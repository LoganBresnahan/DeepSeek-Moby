# Migration: sql.js → @signalapp/sqlcipher

> **Status: RESEARCH** — Detailed feasibility report. No code changes yet.

## Context

The extension currently uses [sql.js](https://github.com/sql-js/sql.js) (WASM-based SQLite) for conversation history storage. It works but has two limitations:

1. **No encryption** — conversation history is stored as plaintext SQLite on disk
2. **Memory overhead** — the entire database lives in WASM memory (2.5-3x DB size steady-state, 4-5x during saves due to triple-copy in `saveToFile()`)

[@signalapp/sqlcipher](https://github.com/signalapp/node-sqlcipher) is a native N-API addon that wraps SQLCipher (encrypted SQLite). It's used by Signal Desktop (also an Electron app), ships prebuilt binaries for all 6 VS Code platforms, and has an API nearly identical to what our `SqlJsWrapper` already mimics.

**License**: AGPL-3.0 — compatible with this extension's license.

## Package Details

```
@signalapp/sqlcipher@3.1.0  (12.1 MB unpacked, 6.4 MB tarball)
Published: January 2026 (actively maintained)
Runtime deps: node-addon-api, node-gyp-build

Prebuilt binaries:
  prebuilds/darwin-arm64/   1.9 MB   (macOS Apple Silicon)
  prebuilds/darwin-x64/     2.0 MB   (macOS Intel)
  prebuilds/linux-arm64/    2.0 MB   (Linux ARM)
  prebuilds/linux-x64/      2.2 MB   (Linux x86_64)
  prebuilds/win32-arm64/    1.8 MB   (Windows ARM)
  prebuilds/win32-x64/      2.0 MB   (Windows x86_64)

JavaScript entry:
  dist/index.mjs            10.9 KB  (ESM)
  dist/index.cjs            12.6 KB  (CJS)
  dist/lib/index.d.ts       7.7 KB   (TypeScript types)
```

Covers **every VS Code desktop platform**. The `node-gyp-build` runtime dependency auto-selects the correct `.node` binary.

## API Comparison

Our `SqlJsWrapper` was explicitly designed to mimic better-sqlite3. `@signalapp/sqlcipher` follows the same pattern:

| Operation | Current SqlJsWrapper | @signalapp/sqlcipher |
|---|---|---|
| Open DB | `new Database(path)` | `new Database(path)` |
| Execute DDL | `db.exec(sql)` | `db.exec(sql)` |
| Prepare | `db.prepare(sql)` → `StatementWrapper` | `db.prepare(sql)` → `Statement` |
| Run (INSERT/UPDATE) | `stmt.run(...params)` → `void` | `stmt.run(params)` → `RunResult` |
| Get one row | `stmt.get(...params)` → `Record \| undefined` | `stmt.get(params)` → `Row \| undefined` |
| Get all rows | `stmt.all(...params)` → `Record[]` | `stmt.all(params)` → `Row[]` |
| Pragma | `db.pragma(str)` → `void` | `db.pragma(str, opts?)` → results |
| Transaction | `db.transaction(fn)` → `() => T` | `db.transaction(fn)` → `(...) => T` |
| Close | `db.close()` | `db.close()` |

### Key Differences

- **Parameter binding**: @signalapp uses named `$params` via object or positional via array. Current wrapper uses positional spread args. All ~15 call sites in EventStore change from `stmt.run(a, b, c)` → `stmt.run([a, b, c])`.
- **Return values**: `stmt.run()` returns `{ changes, lastInsertRowid }` instead of void.
- **No manual save**: Native SQLite writes directly to disk. No `saveToFile()`, no `scheduleSave()`, no triple-copy memory spike. This alone eliminates the memory concern.
- **No WASM init**: No `initializeSqlJs()` needed, no WASM file path hunting.
- **Encryption**: `db.pragma("key='...'")` after opening to unlock the database.

### TypeScript API Surface

```typescript
// Types
type RunResult = { changes: number; lastInsertRowid: number };
type SqliteValue<Opts> = string | Uint8Array | number | null | (bigint if Opts.bigint);
type RowType<Opts> = Opts.pluck ? SqliteValue : Record<string, SqliteValue>;

// Statement<Options>
class Statement<Opts> {
  run(params?: Array | Record): RunResult;
  get<Row>(params?): Row | undefined;
  all<Row>(params?): Array<Row>;
  scanStats(): Array<ScanStats>;
  close(): void;
}

// Database
class Database {
  constructor(path?: string, options?: { cacheStatements?: boolean });
  exec(sql: string): void;
  prepare<Opts>(query: string, options?: Opts): Statement<Opts>;
  pragma<Opts>(source: string, options?: Opts): PragmaResult<Opts>;
  transaction<Params, Result>(fn: (...params: Params) => Result): typeof fn;
  createFunction(name: string, fn: Function, options?: { bigint?: boolean }): void;
  close(): void;
}

function setLogger(fn: (code: string, message: string) => void): void;
```

## Electron / VS Code Compatibility

### The Problem

VS Code runs inside Electron, which has a different ABI than standard Node.js. Native modules compiled for Node.js can fail with `NODE_MODULE_VERSION` mismatch errors in Electron.

### Why @signalapp/sqlcipher Works

1. **N-API is ABI-stable**: N-API is designed to work across Node versions AND Electron versions. The `node-gyp-build` loader checks N-API compatibility at runtime.
2. **Signal Desktop validates this daily**: Signal Desktop is itself an Electron app that uses this exact package. The prebuilds are proven to work in Electron.
3. **No @electron/rebuild needed**: Since prebuilds use N-API (not NAN), they don't need per-Electron-version recompilation.

### Risk

Low. Signal Desktop validates this path continuously. We should test against our target VS Code version's Electron (~32.x as of VS Code 1.97) but issues are unlikely.

### Alternative Considered: @vscode/sqlite3

Microsoft maintains `@vscode/sqlite3` specifically for VS Code extensions. However:
- It's async (callback-based), not sync — would require rewriting all DB access
- No encryption (plain sqlite3, not sqlcipher)
- Less actively maintained than @signalapp/sqlcipher

## Plan

### Step 1: Replace sql.js with @signalapp/sqlcipher

```bash
npm uninstall sql.js
npm install @signalapp/sqlcipher
```

### Step 2: Rewrite SqlJsWrapper.ts

The file gets dramatically simpler — no WASM loading, no manual save, no StatementWrapper polyfill.

**File**: [SqlJsWrapper.ts](../../src/events/SqlJsWrapper.ts)

```typescript
import SqlCipher from '@signalapp/sqlcipher';

export class Database {
  private db: SqlCipher.Database;

  constructor(filePath?: string, encryptionKey?: string) {
    this.db = new SqlCipher.Database(filePath || ':memory:');
    if (encryptionKey) {
      this.db.pragma(`key='${encryptionKey}'`);
    }
  }

  exec(sql: string): void { this.db.exec(sql); }

  prepare(sql: string): SqlCipher.Statement {
    return this.db.prepare(sql);
  }

  pragma(pragma: string): unknown {
    return this.db.pragma(pragma, { simple: true });
  }

  transaction<T>(fn: () => T): () => T {
    return this.db.transaction(fn);
  }

  close(): void { this.db.close(); }
}

// Backward compat stub — no async init needed for native SQLite
export async function initializeSqlJs(): Promise<void> {}
```

**Removed**: `StatementWrapper` class, `scheduleSave()`, `saveToFile()`, WASM path resolution, `SqlJsStatic` import.

### Step 3: Update EventStore.ts parameter binding

All ~15 call sites change from spread args to array:

```typescript
// Before (SqlJsWrapper spread args)
this.stmtInsertEvent.run(id, sessionId, next_seq, timestamp, type, data);
this.stmtGetEvents.all(sessionId, fromSequence);
this.stmtGetEventById.get(eventId);

// After (@signalapp/sqlcipher array params)
this.stmtInsertEvent.run([id, sessionId, next_seq, timestamp, type, data]);
this.stmtGetEvents.all([sessionId, fromSequence]);
this.stmtGetEventById.get([eventId]);
```

**File**: [EventStore.ts](../../src/events/EventStore.ts) — mechanical find/replace across all prepared statement calls.

### Step 4: Update webpack.config.js

**File**: [webpack.config.js](../../webpack.config.js)

```javascript
externals: {
  vscode: 'commonjs vscode',
  // Remove: 'sql.js': 'commonjs sql.js'
  '@signalapp/sqlcipher': 'commonjs @signalapp/sqlcipher'
},
plugins: [
  // Remove: CopyPlugin for sql-wasm.wasm
  // Native .node binaries loaded by node-gyp-build at runtime
]
```

The `copy-webpack-plugin` dependency can also be removed if it's only used for the WASM file.

### Step 5: Encryption key management

Use VS Code's built-in SecretStorage (backed by OS keychain: macOS Keychain, Windows Credential Locker, Linux libsecret).

**File**: [extension.ts](../../src/extension.ts) — in `activate()`:

```typescript
import * as crypto from 'crypto';

// Generate or retrieve encryption key
let dbKey = await context.secrets.get('deepseek.dbKey');
if (!dbKey) {
  dbKey = crypto.randomBytes(32).toString('hex');
  await context.secrets.store('deepseek.dbKey', dbKey);
}

// Pass to database initialization
const db = new Database(dbPath, dbKey);
```

#### Key management options considered

| Strategy | Pros | Cons |
|---|---|---|
| **VS Code SecretStorage** (chosen) | Built-in, OS keychain-backed, no extra deps | Async API, per-machine (not portable) |
| Derive from machine ID | Zero user interaction | Not truly secret, more obfuscation |
| User-provided passphrase | Strongest security | UX friction |
| Hardcoded key | Simplest | Pointless security-wise |

### Step 6: Data migration (existing unencrypted → encrypted)

Existing users have unencrypted sql.js databases. One-time migration on upgrade:

1. Check if old `.db` file exists at the known path
2. Open it with @signalapp/sqlcipher **without** a key (reads as unencrypted SQLite)
3. Use `ATTACH DATABASE 'new.db' AS encrypted KEY 'the-key'` + `SELECT sqlcipher_export('encrypted')`
4. Close, rename new over old
5. Store a version marker so migration doesn't re-run

Alternative (simpler): open old DB unencrypted, dump all rows, create new encrypted DB, reinsert. The event count is small enough that this is fine.

### Step 7: Platform-specific VSIX packaging

Two options:

#### Option A: Universal VSIX (recommended to start)

Ship all ~12 MB of prebuilds in a single VSIX. `node-gyp-build` picks the right one at runtime.

- **Pro**: Simple. No CI changes. Single VSIX for all platforms.
- **Con**: ~12 MB overhead (vs ~1 MB for sql-wasm.wasm). Acceptable for a desktop extension.

#### Option B: Platform-specific VSIXs (future optimization)

Create per-platform VSIXs with only the relevant prebuild:

```json
{
  "scripts": {
    "package:linux-x64": "vsce package --target linux-x64",
    "package:darwin-x64": "vsce package --target darwin-x64",
    "package:darwin-arm64": "vsce package --target darwin-arm64",
    "package:win32-x64": "vsce package --target win32-x64",
    "package:win32-arm64": "vsce package --target win32-arm64",
    "package:linux-arm64": "vsce package --target linux-arm64"
  }
}
```

Each VSIX would be ~2 MB lighter. Requires a CI matrix build and a pre-package script to prune other platforms' binaries.

### Step 8: Tests

| Area | Change |
|---|---|
| SqlJsWrapper tests | Rewrite (the class is completely different) |
| EventStore tests | Parameter binding: spread → array |
| ConversationManager tests | Should pass unchanged (use wrapper API) |
| Mock changes | Remove `initializeSqlJs()` mock, update Database mock |
| CI | Tests run on Node.js which loads correct prebuild — no special config |

## What You Gain

| Before (sql.js) | After (@signalapp/sqlcipher) |
|---|---|
| No encryption | AES-256-CBC encryption at rest |
| 2.5-3x DB size in RAM | Near-zero RAM (disk-based) |
| 4-5x memory spike on save | No spike (native page writes) |
| Data loss on crash (unsaved WASM) | WAL journal crash safety |
| WASM path resolution headaches | `node-gyp-build` auto-selects binary |
| ~1 MB WASM file | ~2 MB native binary (per platform) |

## Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Electron ABI mismatch | Low | Signal Desktop validates daily in Electron. Test against VS Code's Electron. |
| VSIX size increase | Low | ~12 MB universal vs ~1 MB WASM. Acceptable. |
| Build pipeline complexity | Medium | Start with universal VSIX. Platform-specific later. |
| Key management bugs | Medium | Lose key = lose history. SecretStorage is OS-backed. Test backup/restore. |
| glibc on old Linux | Low | @signalapp builds on reasonable baseline. Test Ubuntu 20.04+. |
| `node-gyp-build` not finding binary | Low | Well-tested loader used by many N-API packages. Fallback: compile from source. |

## Effort Estimate

| Area | Size |
|---|---|
| SqlJsWrapper rewrite | Small — file gets simpler |
| EventStore parameter changes | Small — mechanical find/replace |
| Webpack config update | Trivial |
| Encryption key management | Medium — new code in extension.ts |
| Data migration logic | Medium — one-time migration path |
| Platform-specific VSIX CI (if Option B) | Medium-Large — new CI pipeline |
| Testing updates | Medium — mock and param changes |

## Files to Modify

| File | Change |
|---|---|
| `package.json` | Remove `sql.js`, add `@signalapp/sqlcipher`. Optionally remove `copy-webpack-plugin`. |
| [SqlJsWrapper.ts](../../src/events/SqlJsWrapper.ts) | Complete rewrite — native DB, encryption, no WASM |
| [EventStore.ts](../../src/events/EventStore.ts) | Statement param binding: spread → array (~15 sites) |
| [webpack.config.js](../../webpack.config.js) | Change externals, remove WASM copy plugin |
| [extension.ts](../../src/extension.ts) | Add encryption key generation/retrieval, pass to DB |
| [ConversationManager.ts](../../src/events/ConversationManager.ts) | Accept and pass encryption key to Database constructor |
| Tests | Update mocks, parameter binding, SqlJsWrapper tests |

## References

- [@signalapp/node-sqlcipher (GitHub)](https://github.com/signalapp/node-sqlcipher)
- [Signal's better-sqlite3 fork — API docs](https://github.com/signalapp/better-sqlite3/blob/better-sqlcipher/docs/api.md)
- [Electron: Using Native Node Modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)
- [VS Code: Platform-specific extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [VS Code Discussions: Native modules in extensions](https://github.com/microsoft/vscode-discussions/discussions/768)
- [VS Code Discussions: SQLite in extensions](https://github.com/microsoft/vscode-discussions/discussions/16)
- [better-sqlite3 + Electron compatibility](https://github.com/WiseLibs/better-sqlite3/issues/1321)
