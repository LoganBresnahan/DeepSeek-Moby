# Migration: sql.js → @signalapp/sqlcipher

> **Status: COMPLETE** — Migration implemented and verified.

## Context

The extension currently uses [sql.js](https://github.com/sql-js/sql.js) (WASM-based SQLite) for conversation history storage. It works but has two limitations:

1. **No encryption** — conversation history is stored as plaintext SQLite on disk
2. **Memory overhead** — the entire database lives in WASM memory (2.5-3x DB size steady-state, 4-5x during saves due to triple-copy in `saveToFile()`)

[@signalapp/sqlcipher](https://github.com/signalapp/node-sqlcipher) is a native N-API addon that wraps SQLCipher (encrypted SQLite). It's used by Signal Desktop (also an Electron app), ships prebuilt binaries for all 6 VS Code desktop platforms, and has an API nearly identical to what our `SqlJsWrapper` already mimics.

**License**: AGPL-3.0 — compatible with this extension's license.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Data migration | **Not needed** | Dev-only. Old DB can be wiped/deleted. |
| Encryption keys | **VS Code SecretStorage** | OS keychain-backed, no extra deps |
| VSIX packaging | **Platform-specific only** | Ship only the binary the user needs |
| CI | **GitHub Actions** | Matrix build for 6 desktop platforms |
| Web support | **No** | Extension requires Node.js APIs (fs, shell, etc.) — not web-compatible |
| Alpine/musl | **Not supported** | No prebuilds; not a target platform |
| Backend count | **Single** | sql.js removed entirely. One backend, no interface abstraction. |

## Package Details

```
@signalapp/sqlcipher@3.1.0  (12.1 MB unpacked, 6.4 MB tarball)
Published: January 2026 (actively maintained)
Runtime deps: node-addon-api, node-gyp-build

Prebuilt binaries (one per platform VSIX):
  prebuilds/darwin-arm64/   1.9 MB   (macOS Apple Silicon)
  prebuilds/darwin-x64/     2.0 MB   (macOS Intel)
  prebuilds/linux-arm64/    2.0 MB   (Linux ARM)
  prebuilds/linux-x64/      2.2 MB   (Linux x86_64)
  prebuilds/win32-arm64/    1.8 MB   (Windows ARM)
  prebuilds/win32-x64/      2.0 MB   (Windows x86_64)
```

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

- **Parameter binding**: @signalapp uses positional array or named `$param` object. Current wrapper uses positional spread args. The new `SqlJsWrapper` will adapt spread-args → array internally so EventStore needs zero changes.
- **Return values**: `stmt.run()` returns `{ changes, lastInsertRowid }` instead of void. Wrapped to preserve existing void return.
- **No manual save**: Native SQLite writes directly to disk. No `saveToFile()`, no `scheduleSave()`, no triple-copy memory spike.
- **No WASM init**: No `initializeSqlJs()` needed, no WASM file path hunting.
- **Encryption**: `db.pragma("key='...'")` after opening to unlock the database.

## Async Init Cleanup

The current async startup chain exists entirely because sql.js needs WASM loaded from disk:

```
Current chain (sql.js — REMOVE ALL OF THIS):
  ConversationManager constructor
    └→ this.initPromise = this.initialize()     ← stored, not awaited
        └→ await initializeSqlJs()              ← WASM loading (the slow async part)
            └→ Read wasm file from 5 fallback paths
            └→ await initSqlJs({ wasmBinary })
        └→ new Database(dbPath)                 ← throws if WASM not ready
        └→ new EventStore(db)
        └→ initSessionsSchema(), prepareStatements(), loadCurrentSession()
        └→ this.initialized = true

  Every public method:
    └→ await this.ensureInitialized()           ← waits for initPromise
```

With native SQLite, **there is no async step**. `new Database(path)` is synchronous. The entire `initPromise` / `ensureInitialized()` pattern can be removed:

```
New chain (@signalapp/sqlcipher):
  ConversationManager constructor
    └→ this.initialize()                        ← synchronous now (except key retrieval)
        └→ new Database(dbPath, encryptionKey)  ← synchronous, instant
        └→ new EventStore(db)
        └→ initSessionsSchema(), prepareStatements(), loadCurrentSession()
        └→ this.initialized = true
```

**One async step remains**: `context.secrets.get()` for the encryption key. This can be handled by keeping `initPromise` / `ensureInitialized()` with a much simpler body, OR by retrieving the key in `activate()` before constructing ConversationManager and passing it in.

**Recommended**: Retrieve the key in `activate()` and pass it to the constructor. This makes ConversationManager fully synchronous and eliminates the `ensureInitialized()` guard from ~20 public methods.

```typescript
// extension.ts activate()
const dbKey = await getOrCreateEncryptionKey(context);
conversationManager = new ConversationManager(context, dbKey);  // fully sync
```

### What Gets Removed

| Item | Location | Status |
|---|---|---|
| `initializeSqlJs()` function | `SqlJsWrapper.ts:17-52` | **Delete** |
| WASM path resolution (5 fallback paths) | `SqlJsWrapper.ts:20-37` | **Delete** |
| `scheduleSave()` / `saveToFile()` | `SqlJsWrapper.ts:184-213` | **Delete** |
| `StatementWrapper` class (old) | `SqlJsWrapper.ts:57-112` | **Replace** with new adapter |
| `SqlJsStatic` global variable | `SqlJsWrapper.ts:12` | **Delete** |
| `initPromise` field | `ConversationManager.ts` | **Delete** (if key passed in) |
| `ensureInitialized()` method | `ConversationManager.ts:174-178` | **Delete** |
| `await this.ensureInitialized()` calls | `ConversationManager.ts` (~20 methods) | **Delete** |
| WASM copy in webpack | `webpack.config.js:49-56` | **Delete** |
| `sql.js` external in webpack | `webpack.config.js:22` | **Replace** with `@signalapp/sqlcipher` |
| `sql.js` dependency | `package.json` | **Delete** |
| `copy-webpack-plugin` dev dependency | `package.json` | **Delete** (only used for WASM) |

## Plan

### Step 1: Swap dependencies

```bash
npm uninstall sql.js copy-webpack-plugin
npm install @signalapp/sqlcipher
```

### Step 2: Rewrite SqlJsWrapper.ts

Replace the entire file. The new version wraps @signalapp/sqlcipher with a `StatementWrapper` that adapts spread-args → array, so **EventStore needs zero call-site changes**.

**File**: [SqlJsWrapper.ts](../../src/events/SqlJsWrapper.ts)

```typescript
import SqlCipher from '@signalapp/sqlcipher';

/**
 * Statement wrapper that adapts @signalapp/sqlcipher's array-param API
 * to the spread-args API that EventStore uses.
 */
class StatementWrapper {
  private stmt: SqlCipher.Statement;

  constructor(stmt: SqlCipher.Statement) {
    this.stmt = stmt;
  }

  run(...params: unknown[]): void {
    this.stmt.run(params);
  }

  get(...params: unknown[]): Record<string, unknown> | undefined {
    return this.stmt.get(params) as Record<string, unknown> | undefined;
  }

  all(...params: unknown[]): Record<string, unknown>[] {
    return this.stmt.all(params) as Record<string, unknown>[];
  }
}

/**
 * Database wrapper around @signalapp/sqlcipher.
 * API-compatible with the old sql.js wrapper so EventStore/ConversationManager
 * need no changes.
 */
export class Database {
  private db: SqlCipher.Database;

  constructor(filePath?: string, encryptionKey?: string) {
    this.db = new SqlCipher.Database(
      filePath && filePath !== ':memory:' ? filePath : undefined
    );
    if (encryptionKey) {
      this.db.pragma(`key='${encryptionKey}'`);
    }
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): StatementWrapper {
    return new StatementWrapper(this.db.prepare(sql));
  }

  pragma(pragma: string): void {
    this.db.exec(`PRAGMA ${pragma}`);
  }

  transaction<T>(fn: () => T): () => T {
    return this.db.transaction(fn);
  }

  close(): void {
    this.db.close();
  }
}
```

**Gone**: `initializeSqlJs()`, `saveToFile()`, `scheduleSave()`, WASM loading, `SqlJsStatic` global, `fs` import.

### Step 3: Add encryption key management

**File**: [extension.ts](../../src/extension.ts) — in `activate()`, before ConversationManager construction:

```typescript
import * as crypto from 'crypto';

async function getOrCreateEncryptionKey(context: vscode.ExtensionContext): Promise<string> {
  let key = await context.secrets.get('deepseek.dbKey');
  if (!key) {
    key = crypto.randomBytes(32).toString('hex');
    await context.secrets.store('deepseek.dbKey', key);
  }
  return key;
}

export async function activate(context: vscode.ExtensionContext) {
  // ... existing setup ...
  const dbKey = await getOrCreateEncryptionKey(context);
  conversationManager = new ConversationManager(context, dbKey);
  // ... rest of activate ...
}
```

### Step 4: Simplify ConversationManager initialization

**File**: [ConversationManager.ts](../../src/events/ConversationManager.ts)

Pass encryption key to constructor. Remove async init pattern:

```typescript
export class ConversationManager {
  private db: Database;
  private eventStore: EventStore;
  // Remove: private initPromise: Promise<void>;
  // Remove: private initialized = false;

  constructor(context: vscode.ExtensionContext, encryptionKey?: string) {
    // Database path setup (existing logic)
    const dbPath = path.join(context.globalStorageUri.fsPath, 'conversations.db');

    // Synchronous construction — no WASM, no async
    this.db = new Database(dbPath, encryptionKey);
    this.eventStore = new EventStore(this.db);
    this.initSessionsSchema();
    this.prepareStatements();
    this.loadCurrentSession();
  }

  // Remove: private async initialize(): Promise<void> { ... }
  // Remove: async ensureInitialized(): Promise<void> { ... }

  // All public methods: remove `await this.ensureInitialized();` line
  // Methods can become synchronous where they don't do other async work
}
```

**Impact**: ~20 methods lose their `await this.ensureInitialized()` guard. Methods that were only async because of that guard can become synchronous.

### Step 5: Update webpack.config.js

**File**: [webpack.config.js](../../webpack.config.js)

```javascript
const path = require('path');
// Remove: const CopyPlugin = require('copy-webpack-plugin');

const config = {
  // ... unchanged ...
  externals: {
    vscode: 'commonjs vscode',
    '@signalapp/sqlcipher': 'commonjs @signalapp/sqlcipher'
    // Remove: 'sql.js': 'commonjs sql.js'
  },
  // Remove plugins array entirely (CopyPlugin was the only plugin)
};
```

### Step 6: Platform-specific VSIX packaging (GitHub Actions)

**New file**: `.github/workflows/package.yml`

```yaml
name: Package Extension
on:
  push:
    tags: ['v*']
  workflow_dispatch:

jobs:
  package:
    strategy:
      matrix:
        include:
          - target: linux-x64
            prebuild: linux-x64
          - target: linux-arm64
            prebuild: linux-arm64
          - target: darwin-x64
            prebuild: darwin-x64
          - target: darwin-arm64
            prebuild: darwin-arm64
          - target: win32-x64
            prebuild: win32-x64
          - target: win32-arm64
            prebuild: win32-arm64

    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci

      # Keep only the prebuild for this platform
      - name: Prune prebuilds
        run: |
          cd node_modules/@signalapp/sqlcipher/prebuilds
          for dir in */; do
            if [ "$dir" != "${{ matrix.prebuild }}/" ]; then
              rm -rf "$dir"
            fi
          done

      - run: npm run compile
      - run: npx vsce package --target ${{ matrix.target }}
      - uses: actions/upload-artifact@v4
        with:
          name: vsix-${{ matrix.target }}
          path: "*.vsix"
```

**Local build scripts** in `package.json`:

```json
{
  "scripts": {
    "package:local": "node scripts/prune-prebuilds.js && vsce package --target $(node -e \"console.log(process.platform + '-' + process.arch)\")"
  }
}
```

**New file**: `scripts/prune-prebuilds.js` — strips prebuilds for other platforms, keeping only the current one.

### Step 7: Delete old DB on startup

Since no migration is needed, just delete the old unencrypted database if it exists:

```typescript
// In activate() or ConversationManager constructor
const oldDbPath = path.join(storagePath, 'conversations.db');
if (fs.existsSync(oldDbPath)) {
  // Check if it's an unencrypted sql.js database (no SQLCipher header)
  const header = Buffer.alloc(16);
  const fd = fs.openSync(oldDbPath, 'r');
  fs.readSync(fd, header, 0, 16, 0);
  fs.closeSync(fd);
  if (header.toString('ascii', 0, 6) === 'SQLite') {
    // Old unencrypted DB — delete it
    fs.unlinkSync(oldDbPath);
  }
}
```

Or simpler: just use a different filename (`conversations.enc.db`) and ignore the old one.

### Step 8: Tests

| Area | Change |
|---|---|
| SqlJsWrapper tests | Rewrite for new native-backed wrapper |
| EventStore tests | **No changes** — StatementWrapper preserves API |
| ConversationManager tests | Remove async init mocking, constructor takes key param |
| Mock changes | Remove `initializeSqlJs()` mock. Mock `@signalapp/sqlcipher` instead. |

**Test runner**: Tests run on Node.js which loads the correct prebuild via `node-gyp-build`. No special config needed — CI runs on `ubuntu-latest` which matches `linux-x64`.

## What You Gain

| Before (sql.js) | After (@signalapp/sqlcipher) |
|---|---|
| No encryption | AES-256-CBC encryption at rest |
| 2.5-3x DB size in RAM | Near-zero RAM (disk-based) |
| 4-5x memory spike on save | No spike (native page writes) |
| Data loss on crash (unsaved WASM) | WAL journal crash safety |
| WASM path resolution (5 fallback paths) | `node-gyp-build` auto-selects binary |
| Async init + `ensureInitialized()` on ~20 methods | Synchronous constructor |
| ~1 MB WASM file in every VSIX | ~2 MB native binary per platform VSIX |

## Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Electron ABI mismatch | Low | Signal Desktop validates daily in Electron. Test against VS Code's Electron. |
| Key loss = history loss | Low | History is not mission-critical. SecretStorage is OS-backed. |
| glibc on old Linux | Low | @signalapp builds on reasonable baseline. Test Ubuntu 20.04+. |
| `node-gyp-build` not finding binary | Low | Well-tested loader. Prebuilds cover all 6 platforms. |

## Files to Create/Modify

| File | Change |
|---|---|
| `package.json` | Remove `sql.js` + `copy-webpack-plugin`, add `@signalapp/sqlcipher` |
| [SqlJsWrapper.ts](../../src/events/SqlJsWrapper.ts) | Complete rewrite — native DB, encryption, adapter Statement |
| [ConversationManager.ts](../../src/events/ConversationManager.ts) | Accept key in constructor, remove async init + ensureInitialized |
| [extension.ts](../../src/extension.ts) | Add `getOrCreateEncryptionKey()`, pass key to ConversationManager |
| [webpack.config.js](../../webpack.config.js) | Swap externals, remove CopyPlugin |
| [EventStore.ts](../../src/events/EventStore.ts) | **No changes** (adapter preserves API) |
| **New**: `.github/workflows/package.yml` | Matrix build for 6 platform VSIXs |
| **New**: `scripts/prune-prebuilds.js` | Strip other-platform binaries before packaging |
| Tests | Rewrite SqlJsWrapper tests, simplify ConversationManager test setup |

## References

- [@signalapp/node-sqlcipher (GitHub)](https://github.com/signalapp/node-sqlcipher)
- [Signal's better-sqlite3 fork — API docs](https://github.com/signalapp/better-sqlite3/blob/better-sqlcipher/docs/api.md)
- [Electron: Using Native Node Modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)
- [VS Code: Platform-specific extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
