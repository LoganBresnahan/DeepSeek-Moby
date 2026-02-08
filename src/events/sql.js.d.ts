/**
 * Type declarations for sql.js
 */

declare module 'sql.js' {
  export interface SqlJsStatic {
    Database: typeof Database;
  }

  export interface SqlValue {
    [key: string]: unknown;
  }

  export interface QueryExecResult {
    columns: string[];
    values: (string | number | null | Uint8Array)[][];
  }

  export interface Statement {
    bind(params?: unknown[]): boolean;
    step(): boolean;
    get(params?: unknown[]): (string | number | null | Uint8Array)[];
    getColumnNames(): string[];
    free(): void;
    reset(): void;
  }

  export interface Database {
    run(sql: string, params?: unknown[]): void;
    exec(sql: string): QueryExecResult[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  }

  export interface DatabaseConstructor {
    new(data?: ArrayLike<number> | Buffer | null): Database;
  }

  export interface InitSqlJsOptions {
    locateFile?: (file: string) => string;
    wasmBinary?: ArrayBufferLike;
  }

  export default function initSqlJs(options?: InitSqlJsOptions): Promise<SqlJsStatic>;
}
