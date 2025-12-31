/**
 * Dev-Only Performance Instrumentation for Worker Compute
 *
 * Provides timing, cancellation tracking, and latency metrics
 * for worker operations. All logging is dev-only and tree-shaken
 * in production builds.
 *
 * @see phage_explorer-dy7l.1
 */

// ============================================================================
// Configuration
// ============================================================================

const isDev = typeof import.meta !== 'undefined' && import.meta.env?.DEV === true;

/** Maximum number of timing samples to keep per operation type */
const MAX_SAMPLES = 100;

/** Enable detailed console logging */
let VERBOSE_LOGGING = false;

// ============================================================================
// Types
// ============================================================================

export type WorkerOperationType =
  | 'analysis'
  | 'simulation'
  | 'dotplot'
  | 'comparison'
  | 'structure'
  | 'crispr'
  | 'hilbert';

export interface TimingEntry {
  /** Operation type */
  type: WorkerOperationType;
  /** Analysis subtype (e.g., 'gc-skew', 'kmer-spectrum') */
  subtype?: string;
  /** Total duration in ms */
  duration: number;
  /** Timestamp when operation started */
  startedAt: number;
  /** Whether the operation was cancelled */
  cancelled: boolean;
  /** Stage breakdown (if available) */
  stages?: Record<string, number>;
}

export interface OperationStats {
  /** Number of samples */
  count: number;
  /** Mean duration in ms */
  mean: number;
  /** Median duration in ms */
  median: number;
  /** 95th percentile duration in ms */
  p95: number;
  /** Number of cancelled operations */
  cancellations: number;
  /** Cancellation rate (0-1) */
  cancellationRate: number;
}

export interface AggregateStats {
  /** Stats by operation type */
  byType: Record<WorkerOperationType, OperationStats>;
  /** Stats by analysis subtype */
  bySubtype: Record<string, OperationStats>;
  /** Total operations tracked */
  totalOperations: number;
  /** Total cancellations */
  totalCancellations: number;
  /** Overall cancellation rate */
  overallCancellationRate: number;
}

// ============================================================================
// State
// ============================================================================

/** Ring buffer of timing entries by type */
const timings = new Map<WorkerOperationType, TimingEntry[]>();

/** Active operations (for cancellation tracking) */
const activeOperations = new Map<string, { type: WorkerOperationType; subtype?: string; startedAt: number }>();

/** Subscribers for real-time updates */
const subscribers = new Set<(entry: TimingEntry) => void>();

// ============================================================================
// Core API
// ============================================================================

/**
 * Generate a unique operation ID.
 */
function generateOpId(): string {
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Start tracking an operation.
 * Returns an operation ID and a finish function.
 */
export function startOperation(
  type: WorkerOperationType,
  subtype?: string
): { opId: string; finish: (cancelled?: boolean, stages?: Record<string, number>) => void } {
  if (!isDev) {
    // No-op in production
    return { opId: '', finish: () => {} };
  }

  const opId = generateOpId();
  const startedAt = performance.now();

  activeOperations.set(opId, { type, subtype, startedAt });

  if (VERBOSE_LOGGING) {
    console.log(`[perf] Started ${type}${subtype ? `:${subtype}` : ''} (${opId})`);
  }

  const finish = (cancelled = false, stages?: Record<string, number>) => {
    const op = activeOperations.get(opId);
    if (!op) return;

    activeOperations.delete(opId);
    const duration = performance.now() - op.startedAt;

    const entry: TimingEntry = {
      type: op.type,
      subtype: op.subtype,
      duration,
      startedAt: op.startedAt,
      cancelled,
      stages,
    };

    // Add to ring buffer (use op.type for consistency with entry)
    if (!timings.has(op.type)) {
      timings.set(op.type, []);
    }
    const buffer = timings.get(op.type)!;
    buffer.push(entry);
    if (buffer.length > MAX_SAMPLES) {
      buffer.shift();
    }

    // Notify subscribers
    for (const sub of subscribers) {
      try {
        sub(entry);
      } catch (e) {
        console.error('[perf] Subscriber error:', e);
      }
    }

    if (VERBOSE_LOGGING) {
      const status = cancelled ? 'CANCELLED' : 'completed';
      console.log(
        `[perf] ${type}${subtype ? `:${subtype}` : ''} ${status} in ${duration.toFixed(1)}ms`,
        stages ? { stages } : ''
      );
    }
  };

  return { opId, finish };
}

/**
 * Mark an operation as cancelled.
 * Useful when the operation is aborted before completion.
 */
export function cancelOperation(opId: string): void {
  if (!isDev || !opId) return;

  const op = activeOperations.get(opId);
  if (op) {
    activeOperations.delete(opId);
    const duration = performance.now() - op.startedAt;

    const entry: TimingEntry = {
      type: op.type,
      subtype: op.subtype,
      duration,
      startedAt: op.startedAt,
      cancelled: true,
    };

    if (!timings.has(op.type)) {
      timings.set(op.type, []);
    }
    const buffer = timings.get(op.type)!;
    buffer.push(entry);
    if (buffer.length > MAX_SAMPLES) {
      buffer.shift();
    }

    if (VERBOSE_LOGGING) {
      console.log(`[perf] ${op.type}${op.subtype ? `:${op.subtype}` : ''} CANCELLED after ${duration.toFixed(1)}ms`);
    }
  }
}

/**
 * Get the number of currently active operations.
 */
export function getActiveOperationCount(): number {
  return activeOperations.size;
}

// ============================================================================
// Statistics
// ============================================================================

function computeStats(entries: TimingEntry[]): OperationStats {
  if (entries.length === 0) {
    return { count: 0, mean: 0, median: 0, p95: 0, cancellations: 0, cancellationRate: 0 };
  }

  const durations = entries.filter(e => !e.cancelled).map(e => e.duration).sort((a, b) => a - b);
  const cancellations = entries.filter(e => e.cancelled).length;

  if (durations.length === 0) {
    return {
      count: entries.length,
      mean: 0,
      median: 0,
      p95: 0,
      cancellations,
      cancellationRate: 1,
    };
  }

  const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
  const median = durations[Math.floor(durations.length / 2)];
  const p95 = durations[Math.floor(durations.length * 0.95)] ?? durations[durations.length - 1];

  return {
    count: entries.length,
    mean,
    median,
    p95,
    cancellations,
    cancellationRate: cancellations / entries.length,
  };
}

/**
 * Get aggregate statistics for all tracked operations.
 */
export function getAggregateStats(): AggregateStats {
  const byType: Record<WorkerOperationType, OperationStats> = {} as Record<WorkerOperationType, OperationStats>;
  const bySubtype: Record<string, OperationStats> = {};
  let totalOperations = 0;
  let totalCancellations = 0;

  // Compute by-type stats
  for (const [type, entries] of timings) {
    byType[type] = computeStats(entries);
    totalOperations += entries.length;
    totalCancellations += entries.filter(e => e.cancelled).length;
  }

  // Compute by-subtype stats
  const subtypeEntries = new Map<string, TimingEntry[]>();
  for (const entries of timings.values()) {
    for (const entry of entries) {
      if (entry.subtype) {
        if (!subtypeEntries.has(entry.subtype)) {
          subtypeEntries.set(entry.subtype, []);
        }
        subtypeEntries.get(entry.subtype)!.push(entry);
      }
    }
  }
  for (const [subtype, entries] of subtypeEntries) {
    bySubtype[subtype] = computeStats(entries);
  }

  return {
    byType,
    bySubtype,
    totalOperations,
    totalCancellations,
    overallCancellationRate: totalOperations > 0 ? totalCancellations / totalOperations : 0,
  };
}

/**
 * Get stats for a specific operation type.
 */
export function getStatsForType(type: WorkerOperationType): OperationStats {
  const entries = timings.get(type) ?? [];
  return computeStats(entries);
}

/**
 * Get the last N timing entries (most recent first).
 */
export function getRecentTimings(n = 20): TimingEntry[] {
  const all: TimingEntry[] = [];
  for (const entries of timings.values()) {
    all.push(...entries);
  }
  return all.sort((a, b) => b.startedAt - a.startedAt).slice(0, n);
}

// ============================================================================
// Subscriptions
// ============================================================================

/**
 * Subscribe to timing events.
 * Returns an unsubscribe function.
 */
export function subscribe(callback: (entry: TimingEntry) => void): () => void {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Enable or disable verbose console logging.
 */
export function setVerboseLogging(enabled: boolean): void {
  VERBOSE_LOGGING = enabled;
}

/**
 * Clear all timing data.
 */
export function clearTimings(): void {
  timings.clear();
}

// ============================================================================
// Console Report
// ============================================================================

/**
 * Print a formatted performance report to the console.
 * Useful for debugging in dev tools.
 */
export function printReport(): void {
  if (!isDev) {
    console.log('[perf] Performance reporting is only available in dev mode');
    return;
  }

  const stats = getAggregateStats();

  console.group('🔬 Worker Performance Report');
  console.log(`Total operations: ${stats.totalOperations}`);
  console.log(`Total cancellations: ${stats.totalCancellations} (${(stats.overallCancellationRate * 100).toFixed(1)}%)`);
  console.log('');

  console.group('By Operation Type');
  for (const [type, s] of Object.entries(stats.byType)) {
    if (s.count > 0) {
      console.log(
        `${type}: count=${s.count}, median=${s.median.toFixed(1)}ms, p95=${s.p95.toFixed(1)}ms, cancelled=${s.cancellations}`
      );
    }
  }
  console.groupEnd();

  if (Object.keys(stats.bySubtype).length > 0) {
    console.group('By Analysis Subtype');
    for (const [subtype, s] of Object.entries(stats.bySubtype)) {
      console.log(
        `${subtype}: count=${s.count}, median=${s.median.toFixed(1)}ms, p95=${s.p95.toFixed(1)}ms`
      );
    }
    console.groupEnd();
  }

  console.groupEnd();
}

// ============================================================================
// Window Export (for dev tools access)
// ============================================================================

if (isDev && typeof window !== 'undefined') {
  // Expose on window for easy console access
  (window as unknown as Record<string, unknown>).__perfInstrumentation = {
    getStats: getAggregateStats,
    printReport,
    getRecent: getRecentTimings,
    setVerbose: setVerboseLogging,
    clear: clearTimings,
  };
}
