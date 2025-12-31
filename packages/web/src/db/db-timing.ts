/**
 * Database Load Timing Instrumentation
 *
 * Dev-only timing breakdown for DB load performance analysis.
 * Enables comparison of cold vs warm loads and .db vs .db.gz strategies.
 *
 * @see phage_explorer-rrqx.1
 */

const isDev = import.meta.env?.DEV ?? false;

// ============================================================================
// Types
// ============================================================================

export interface TimingStage {
  /** Stage name */
  name: string;
  /** Start time (performance.now()) */
  startMs: number;
  /** End time (performance.now()) */
  endMs: number;
  /** Duration in milliseconds */
  durationMs: number;
}

export interface DbLoadTiming {
  /** Unique load ID for correlation */
  loadId: string;
  /** Whether this was a cached (warm) load */
  cached: boolean;
  /** Source strategy: 'db' | 'db.gz' | 'cache' */
  source: 'db' | 'db.gz' | 'cache';
  /** Browser/platform info */
  userAgent: string;
  /** Timestamp when load started */
  startedAt: number;
  /** Total load time in ms */
  totalMs: number;
  /** Bytes transferred (0 for cached loads) */
  bytesTransferred: number;
  /** Bytes after decompression (if applicable) */
  bytesDecompressed: number;
  /** Peak memory usage in bytes (best-effort, may be 0 if unavailable) */
  peakMemoryBytes: number;
  /** Decompression method used: 'native' | 'pako' | 'none' */
  decompressionMethod: 'native' | 'pako' | 'none';

  /** Individual timing stages */
  stages: {
    /** Manifest fetch + cache check */
    cacheCheck?: TimingStage;
    /** Network fetch (cold loads only) */
    fetch?: TimingStage;
    /** Decompression (if .db.gz used) */
    decompress?: TimingStage;
    /** sql.js WASM initialization */
    sqlJsInit?: TimingStage;
    /** Database open + first query */
    dbOpen?: TimingStage;
    /** Cache read (warm loads only) */
    cacheRead?: TimingStage;
    /** Cache write (cold loads only) */
    cacheWrite?: TimingStage;
  };
}

// ============================================================================
// Timing Recorder
// ============================================================================

/**
 * Records timing data for a single database load operation.
 * Use startStage/endStage to record individual phases.
 */
export class DbTimingRecorder {
  private loadId: string;
  private startTime: number;
  private stages: Map<string, { startMs: number; endMs?: number }> = new Map();
  private cached = false;
  private source: DbLoadTiming['source'] = 'db';
  private bytesTransferred = 0;
  private bytesDecompressed = 0;
  private decompressionMethod: DbLoadTiming['decompressionMethod'] = 'none';

  constructor() {
    this.loadId = `load-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.startTime = performance.now();
  }

  /** Start timing a stage */
  startStage(name: string): void {
    this.stages.set(name, { startMs: performance.now() });
  }

  /** End timing a stage */
  endStage(name: string): void {
    const stage = this.stages.get(name);
    if (stage) {
      stage.endMs = performance.now();
    }
  }

  /** Mark load as cached (warm) */
  setCached(cached: boolean): void {
    this.cached = cached;
  }

  /** Set the source strategy */
  setSource(source: DbLoadTiming['source']): void {
    this.source = source;
  }

  /** Record bytes transferred */
  setBytesTransferred(bytes: number): void {
    this.bytesTransferred = bytes;
  }

  /** Record bytes after decompression */
  setBytesDecompressed(bytes: number): void {
    this.bytesDecompressed = bytes;
  }

  /** Record decompression method */
  setDecompressionMethod(method: DbLoadTiming['decompressionMethod']): void {
    this.decompressionMethod = method;
  }

  /** Get current peak memory (best-effort) */
  private getPeakMemory(): number {
    // Check for Memory API (Chrome only)
    const perf = performance as Performance & {
      memory?: { usedJSHeapSize?: number };
    };
    return perf.memory?.usedJSHeapSize ?? 0;
  }

  /** Finalize and return timing data */
  finalize(): DbLoadTiming {
    const endTime = performance.now();
    const totalMs = endTime - this.startTime;

    const stageResults: DbLoadTiming['stages'] = {};

    for (const [name, timing] of this.stages) {
      if (timing.endMs !== undefined) {
        const stage: TimingStage = {
          name,
          startMs: timing.startMs,
          endMs: timing.endMs,
          durationMs: timing.endMs - timing.startMs,
        };
        (stageResults as Record<string, TimingStage>)[name] = stage;
      }
    }

    return {
      loadId: this.loadId,
      cached: this.cached,
      source: this.source,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
      startedAt: Date.now() - totalMs,
      totalMs,
      bytesTransferred: this.bytesTransferred,
      bytesDecompressed: this.bytesDecompressed,
      peakMemoryBytes: this.getPeakMemory(),
      decompressionMethod: this.decompressionMethod,
      stages: stageResults,
    };
  }
}

// ============================================================================
// Timing Storage (for benchmark overlay)
// ============================================================================

const TIMING_STORAGE_KEY = 'phage-db-load-timings';
const MAX_STORED_TIMINGS = 20;

/**
 * Store timing data in localStorage for later analysis.
 * Dev-only, no-op in production.
 */
export function storeDbTiming(timing: DbLoadTiming): void {
  if (!isDev) return;

  try {
    const stored = localStorage.getItem(TIMING_STORAGE_KEY);
    const timings: DbLoadTiming[] = stored ? JSON.parse(stored) : [];

    // Keep most recent timings
    timings.unshift(timing);
    if (timings.length > MAX_STORED_TIMINGS) {
      timings.length = MAX_STORED_TIMINGS;
    }

    localStorage.setItem(TIMING_STORAGE_KEY, JSON.stringify(timings));
  } catch {
    // Ignore storage errors
  }
}

/**
 * Retrieve stored timing data.
 */
export function getStoredTimings(): DbLoadTiming[] {
  if (!isDev) return [];

  try {
    const stored = localStorage.getItem(TIMING_STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

/**
 * Clear stored timing data.
 */
export function clearStoredTimings(): void {
  if (!isDev) return;

  try {
    localStorage.removeItem(TIMING_STORAGE_KEY);
  } catch {
    // Ignore
  }
}

// ============================================================================
// Console Logging
// ============================================================================

/**
 * Log timing data to console in a readable format.
 * Dev-only, no-op in production.
 */
export function logDbTiming(timing: DbLoadTiming): void {
  if (!isDev) return;

  const formatMs = (ms: number) => `${ms.toFixed(1)}ms`;
  const formatBytes = (bytes: number) =>
    bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(2)}MB`
      : bytes >= 1024
        ? `${(bytes / 1024).toFixed(1)}KB`
        : `${bytes}B`;

  const stageLines = Object.entries(timing.stages)
    .filter(([, stage]) => stage !== undefined)
    .map(([name, stage]) => `  ${name}: ${formatMs(stage!.durationMs)}`)
    .join('\n');

  console.log(
    `%c[DB Load Timing] ${timing.cached ? '🔄 WARM' : '❄️ COLD'} (${timing.source})`,
    'font-weight: bold; color: #4CAF50',
    `
────────────────────────────────
Total: ${formatMs(timing.totalMs)}
Source: ${timing.source}
Cached: ${timing.cached}
Decompression: ${timing.decompressionMethod}
${timing.bytesTransferred > 0 ? `Transferred: ${formatBytes(timing.bytesTransferred)}` : ''}
${timing.bytesDecompressed > 0 ? `Decompressed: ${formatBytes(timing.bytesDecompressed)}` : ''}
${timing.peakMemoryBytes > 0 ? `Peak Memory: ${formatBytes(timing.peakMemoryBytes)}` : ''}

Stages:
${stageLines}
────────────────────────────────
Load ID: ${timing.loadId}
    `
  );
}

// ============================================================================
// Timing Comparison Utilities
// ============================================================================

/**
 * Compare two timing results and return a summary.
 */
export function compareTimings(
  a: DbLoadTiming,
  b: DbLoadTiming
): { summary: string; speedup: number } {
  const speedup = a.totalMs / b.totalMs;
  const faster = speedup > 1 ? 'B' : 'A';
  const ratio = speedup > 1 ? speedup : 1 / speedup;

  const summary = `${faster} is ${ratio.toFixed(2)}x faster (${a.source} ${a.cached ? 'warm' : 'cold'} vs ${b.source} ${b.cached ? 'warm' : 'cold'})`;

  return { summary, speedup };
}

/**
 * Get timing summary for all stored timings, grouped by strategy.
 */
export function getTimingSummary(): {
  db: { cold: number[]; warm: number[] };
  'db.gz': { cold: number[]; warm: number[] };
  cache: { cold: number[]; warm: number[] };
} {
  const timings = getStoredTimings();

  const summary = {
    db: { cold: [] as number[], warm: [] as number[] },
    'db.gz': { cold: [] as number[], warm: [] as number[] },
    cache: { cold: [] as number[], warm: [] as number[] },
  };

  for (const t of timings) {
    const bucket = t.cached ? 'warm' : 'cold';
    summary[t.source][bucket].push(t.totalMs);
  }

  return summary;
}

/**
 * Print timing comparison report to console.
 */
export function printTimingReport(): void {
  if (!isDev) return;

  const summary = getTimingSummary();
  const formatAvg = (arr: number[]) =>
    arr.length > 0 ? `${(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1)}ms (n=${arr.length})` : 'no data';

  console.log(
    `%c[DB Load Timing Report]`,
    'font-weight: bold; color: #2196F3',
    `
════════════════════════════════
Strategy Comparison
════════════════════════════════
.db (raw):
  Cold: ${formatAvg(summary.db.cold)}
  Warm: ${formatAvg(summary.db.warm)}

.db.gz (compressed):
  Cold: ${formatAvg(summary['db.gz'].cold)}
  Warm: ${formatAvg(summary['db.gz'].warm)}

Cache (IndexedDB):
  Cold: ${formatAvg(summary.cache.cold)}
  Warm: ${formatAvg(summary.cache.warm)}
════════════════════════════════
    `
  );
}

// ============================================================================
// Dev Tools Exposure
// ============================================================================

// Expose utilities on window for easy dev console access
if (isDev && typeof window !== 'undefined') {
  (window as any).__dbTiming = {
    getStoredTimings,
    clearStoredTimings,
    getTimingSummary,
    printTimingReport,
    compareTimings,
  };
}
