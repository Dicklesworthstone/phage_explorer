import initSqlJsModule from 'sql.js/dist/sql-wasm.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

const initSqlJs =
  initSqlJsModule?.default?.default ??
  initSqlJsModule?.default ??
  initSqlJsModule;

export default function initSqlJsFromBundledWasm(config = {}) {
  if (typeof initSqlJs !== 'function') {
    throw new TypeError('sql.js browser initializer is unavailable');
  }

  const upstreamLocateFile =
    typeof config.locateFile === 'function' ? config.locateFile : null;

  return initSqlJs({
    ...config,
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
