/**
 * SqlJsWrapper - Wrapper around sql.js to provide a better-sqlite3 compatible API
 *
 * sql.js is a pure JavaScript SQLite implementation (WASM-based) that works
 * in VS Code extensions without native module compilation issues.
 */

import initSqlJs, { Database as SqlJsDatabase, SqlJsStatic } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';

let SQL: SqlJsStatic | null = null;

/**
 * Initialize sql.js. Must be called before creating databases.
 */
export async function initializeSqlJs(): Promise<void> {
  if (SQL) return;

  // Try multiple locations for the WASM file:
  // 1. dist directory (runtime - webpack copies it there)
  // 2. node_modules (tests/development)
  const possiblePaths = [
    path.join(__dirname, 'sql-wasm.wasm'),
    path.join(__dirname, '..', 'dist', 'sql-wasm.wasm'),
    path.join(__dirname, '..', '..', 'dist', 'sql-wasm.wasm'),
    path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
    path.join(__dirname, '..', '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
  ];

  let wasmBuffer: Buffer | null = null;
  for (const wasmPath of possiblePaths) {
    if (fs.existsSync(wasmPath)) {
      wasmBuffer = fs.readFileSync(wasmPath);
      break;
    }
  }

  if (!wasmBuffer) {
    throw new Error(`Could not find sql-wasm.wasm. Searched: ${possiblePaths.join(', ')}`);
  }

  // Convert Buffer to ArrayBuffer
  const wasmBinary = wasmBuffer.buffer.slice(
    wasmBuffer.byteOffset,
    wasmBuffer.byteOffset + wasmBuffer.byteLength
  );

  SQL = await initSqlJs({
    wasmBinary
  });
}

/**
 * Statement wrapper to mimic better-sqlite3's Statement API
 */
class StatementWrapper {
  private db: SqlJsDatabase;
  private sql: string;
  private onMutate: (() => void) | null;

  constructor(db: SqlJsDatabase, sql: string, onMutate?: () => void) {
    this.db = db;
    this.sql = sql;
    this.onMutate = onMutate || null;
  }

  run(...params: unknown[]): void {
    this.db.run(this.sql, params as any[]);
    if (this.onMutate) this.onMutate();
  }

  get(...params: unknown[]): Record<string, unknown> | undefined {
    const stmt = this.db.prepare(this.sql);
    stmt.bind(params as any[]);

    if (stmt.step()) {
      const columns = stmt.getColumnNames();
      const values = stmt.get();
      stmt.free();

      const result: Record<string, unknown> = {};
      columns.forEach((col: string, i: number) => {
        result[col] = values[i];
      });
      return result;
    }

    stmt.free();
    return undefined;
  }

  all(...params: unknown[]): Record<string, unknown>[] {
    const results: Record<string, unknown>[] = [];
    const stmt = this.db.prepare(this.sql);
    stmt.bind(params as any[]);

    while (stmt.step()) {
      const columns = stmt.getColumnNames();
      const values = stmt.get();

      const row: Record<string, unknown> = {};
      columns.forEach((col: string, i: number) => {
        row[col] = values[i];
      });
      results.push(row);
    }

    stmt.free();
    return results;
  }
}

/**
 * Database wrapper to mimic better-sqlite3's Database API
 */
export class Database {
  private db: SqlJsDatabase;
  private filePath: string | null;
  private saveScheduled: boolean = false;

  constructor(filePath?: string) {
    if (!SQL) {
      throw new Error('sql.js not initialized. Call initializeSqlJs() first.');
    }

    this.filePath = filePath || null;

    // Try to load existing database
    if (filePath && filePath !== ':memory:' && fs.existsSync(filePath)) {
      const buffer = fs.readFileSync(filePath);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
    }
  }

  /**
   * Execute SQL without returning results.
   * Handles multiple statements separated by semicolons.
   */
  exec(sql: string): void {
    this.db.exec(sql);
    this.scheduleSave();
  }

  /**
   * Prepare a statement for repeated execution.
   */
  prepare(sql: string): StatementWrapper {
    return new StatementWrapper(this.db, sql, () => this.scheduleSave());
  }

  /**
   * Set a pragma value.
   */
  pragma(pragma: string): void {
    this.db.exec(`PRAGMA ${pragma}`);
  }

  /**
   * Create a transaction wrapper.
   * sql.js doesn't have explicit transactions in the same way,
   * so we just execute the function.
   */
  transaction<T>(fn: () => T): () => T {
    return () => {
      this.db.exec('BEGIN TRANSACTION');
      try {
        const result = fn();
        this.db.exec('COMMIT');
        this.scheduleSave();
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    };
  }

  /**
   * Schedule a save to disk (debounced).
   */
  private scheduleSave(): void {
    if (!this.filePath || this.filePath === ':memory:' || this.saveScheduled) {
      return;
    }

    this.saveScheduled = true;
    setImmediate(() => {
      this.saveScheduled = false;
      this.saveToFile();
    });
  }

  /**
   * Save database to file.
   */
  private saveToFile(): void {
    if (!this.filePath || this.filePath === ':memory:') {
      return;
    }

    const data = this.db.export();
    const buffer = Buffer.from(data);

    // Ensure directory exists
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(this.filePath, buffer);
  }

  /**
   * Close the database and save to disk.
   */
  close(): void {
    this.saveToFile();
    this.db.close();
  }
}
