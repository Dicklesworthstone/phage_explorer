/**
 * Type declarations for sql.js
 *
 * sql.js is SQLite compiled to WebAssembly for browser use.
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
    values: unknown[][];
  }

  export interface ParamsObject {
    [key: string]: unknown;
  }

  export interface ParamsCallback {
    (obj: ParamsObject): void;
  }

  export interface Statement {
    bind(params?: unknown[]): boolean;
    step(): boolean;
    getAsObject(params?: ParamsObject): SqlValue;
    get(params?: unknown[]): unknown[];
    run(params?: unknown[]): void;
    reset(): void;
    free(): boolean;
    freemem(): void;
  }

  export interface Database {
    run(sql: string, params?: unknown[]): Database;
    exec(sql: string, params?: unknown[]): QueryExecResult[];
    each(sql: string, params: unknown[], callback: ParamsCallback, done?: () => void): Database;
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
    getRowsModified(): number;
    create_function(name: string, func: (...args: unknown[]) => unknown): Database;
  }

  export interface SqlJsConfig {
    locateFile?: (file: string) => string;
    /** WebAssembly bytes to instantiate instead of fetching sql-wasm.wasm (Emscripten module option). */
    wasmBinary?: ArrayBuffer | Uint8Array;
  }

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}
