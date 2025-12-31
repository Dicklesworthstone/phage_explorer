/**
 * Database Module Exports
 */

export * from './types';
export { SqlJsRepository } from './SqlJsRepository';
export { DatabaseLoader, createDatabaseLoader } from './DatabaseLoader';

// Dev-only timing instrumentation
export {
  type DbLoadTiming,
  type TimingStage,
  DbTimingRecorder,
  getStoredTimings,
  clearStoredTimings,
  getTimingSummary,
  printTimingReport,
  compareTimings,
} from './db-timing';

// Cache utilities (quota handling, storage estimation)
export {
  type CacheWriteResult,
  type CacheStats,
  isQuotaError,
  getStorageEstimate,
  hasStorageSpace,
  logCacheStats,
} from './db-cache';
