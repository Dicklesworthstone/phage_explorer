import initSqlJsModule from 'sql.js/dist/sql-wasm.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

const initSqlJs =
  initSqlJsModule?.default?.default ??
  initSqlJsModule?.default ??
  initSqlJsModule;

export default async function initSqlJsFromBundledWasm(config = {}) {
  if (typeof initSqlJs !== 'function') {
    throw new TypeError('sql.js browser initializer is unavailable');
  }

  const upstreamLocateFile =
    typeof config.locateFile === 'function' ? config.locateFile : null;

  // sql.js permanently memoizes its initializer, including rejection. Fetch
  // first so a transient network failure can be retried in this document.
  let wasmBinary = config.wasmBinary;
  if (!wasmBinary) {
    const response = await fetch(sqlWasmUrl, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`SQLite WASM download failed (${response.status}). Retry the load.`);
    wasmBinary = await response.arrayBuffer();
  }

  return initSqlJs({
    ...config,
    wasmBinary,
    locateFile(file, prefix) {
      if (file.endsWith('.wasm')) {
        return sqlWasmUrl;
      }

      return upstreamLocateFile
        ? upstreamLocateFile(file, prefix)
        : `${prefix ?? ''}${file}`;
    },
  });
}
