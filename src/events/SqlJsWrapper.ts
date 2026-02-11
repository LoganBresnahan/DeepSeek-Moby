/**
 * SqlJsWrapper - Wrapper around @signalapp/sqlcipher for encrypted SQLite
 *
 * Provides a compatible API so EventStore, SnapshotManager, and
 * ConversationManager need no call-site changes. The StatementWrapper
 * adapts @signalapp/sqlcipher's array-param API to the spread-args
 * convention used throughout the codebase.
 *
 * Previously used sql.js (WASM). Now uses native SQLCipher via N-API.
 * Key differences from the old wrapper:
 * - No WASM initialization (synchronous construction)
 * - No manual save/scheduleSave (native SQLite writes to disk)
 * - Built-in encryption via PRAGMA key
 */

import SqlCipherDatabase, { type Statement as SqlCipherStatement } from '@signalapp/sqlcipher';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Statement wrapper that adapts @signalapp/sqlcipher's array-param API
 * to the spread-args API that EventStore and other callers use.
 *
 * Callers do: stmt.run(a, b, c)
 * SqlCipher expects: stmt.run([a, b, c])
 */
class StatementWrapper {
  private stmt: SqlCipherStatement;

  constructor(stmt: SqlCipherStatement) {
    this.stmt = stmt;
  }

  run(...params: unknown[]): void {
    this.stmt.run(params as any);
  }

  get(...params: unknown[]): Record<string, unknown> | undefined {
    return this.stmt.get(params as any) as Record<string, unknown> | undefined;
  }

  all(...params: unknown[]): Record<string, unknown>[] {
    return this.stmt.all(params as any) as Record<string, unknown>[];
  }
}

/**
 * Database wrapper around @signalapp/sqlcipher.
 * API-compatible with the old sql.js wrapper.
 */
export class Database {
  private db: SqlCipherDatabase;

  constructor(filePath?: string, encryptionKey?: string) {
    // Ensure directory exists for file-based databases
    if (filePath && filePath !== ':memory:') {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new SqlCipherDatabase(
      filePath && filePath !== ':memory:' ? filePath : undefined
    );

    if (encryptionKey) {
      this.db.pragma(`key='${encryptionKey}'`);
    }
  }

  /**
   * Execute SQL without returning results.
   * Handles multiple statements separated by semicolons.
   */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  /**
   * Prepare a statement for repeated execution.
   */
  prepare(sql: string): StatementWrapper {
    return new StatementWrapper(this.db.prepare(sql));
  }

  /**
   * Set a pragma value.
   */
  pragma(pragma: string): void {
    this.db.exec(`PRAGMA ${pragma}`);
  }

  /**
   * Create a transaction wrapper.
   */
  transaction<T>(fn: () => T): () => T {
    return this.db.transaction(fn);
  }

  /**
   * Close the database.
   */
  close(): void {
    this.db.close();
  }
}
