/**
 * ComputeOrchestrator - Worker Management System
 *
 * Manages a pool of Web Workers for heavy computation:
 * - Analysis worker: GC skew, complexity, bendability, etc.
 * - Simulation worker: All phage simulations
 *
 * Features:
 * - Type-safe worker communication via Comlink
 * - Worker pooling and lifecycle management
 * - Progress reporting for long operations
 * - Graceful cancellation
 * - SharedArrayBuffer support for zero-copy sequence sharing
 */

import * as Comlink from 'comlink';
import type {
  SimulationWorkerAPI,
  AnalysisRequest,
  AnalysisResult,
  SimInitParams,
  SimState,
  SimulationId,
  SimParameter,
  ProgressInfo,
  WorkerPoolConfig,
  SharedSequenceRef,
  SharedAnalysisRequest,
  SharedAnalysisWorkerAPI,
  AnalysisType,
  AnalysisOptions,
} from './types';
import { SharedSequencePool, decodeSequence } from './SharedSequencePool';
import { startOperation, getAggregateStats, printReport } from './perf-instrumentation';

type WorkerType = 'analysis' | 'simulation';

interface WorkerInstance {
  id: string;
  worker: Worker;
  api: SharedAnalysisWorkerAPI | SimulationWorkerAPI;
  type: WorkerType;
  busy: boolean;
  lastUsed: number;
  healthy: boolean;
}

/**
 * Simple mutex for synchronizing worker pool access
 */
class Mutex {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }
}

/**
 * ComputeOrchestrator - Singleton worker manager
 */
export class ComputeOrchestrator {
  private static instance: ComputeOrchestrator | null = null;

  private workers = new Map<string, WorkerInstance>();
  private config: Required<WorkerPoolConfig>;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private poolMutex = new Mutex();
  private sequencePool: SharedSequencePool;

  private constructor(config: WorkerPoolConfig = {}) {
    this.config = {
      maxWorkers: config.maxWorkers ?? 4,
      idleTimeout: config.idleTimeout ?? 60000, // 1 minute
    };

    // Initialize shared sequence pool
    this.sequencePool = SharedSequencePool.getInstance();

    // Start cleanup interval
    this.cleanupInterval = setInterval(() => this.cleanupIdleWorkers(), 30000);
  }

  /**
   * Get or create the singleton instance
   */
  static getInstance(config?: WorkerPoolConfig): ComputeOrchestrator {
    if (!ComputeOrchestrator.instance) {
      ComputeOrchestrator.instance = new ComputeOrchestrator(config);
    }
    return ComputeOrchestrator.instance;
  }

  /**
   * Create a worker of the specified type
   */
  private createWorker(type: WorkerType): WorkerInstance {
    const workerId = `${type}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    let worker: Worker;
    let api: SharedAnalysisWorkerAPI | SimulationWorkerAPI;

    try {
      if (type === 'analysis') {
        worker = new Worker(
          new URL('./analysis.worker.ts', import.meta.url),
          { type: 'module' }
        );
        api = Comlink.wrap<SharedAnalysisWorkerAPI>(worker);
      } else {
        worker = new Worker(
          new URL('./simulation.worker.ts', import.meta.url),
          { type: 'module' }
        );
        api = Comlink.wrap<SimulationWorkerAPI>(worker);
      }
    } catch (error) {
      console.error(`Failed to create ${type} worker:`, error);
      throw new Error(`Failed to create ${type} worker: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    const instance: WorkerInstance = {
      id: workerId,
      worker,
      api,
      type,
      busy: false,
      lastUsed: Date.now(),
      healthy: true,
    };

    // Listen for worker errors to mark as unhealthy
    worker.onerror = (event) => {
      console.error(`Worker ${workerId} error:`, event.message);
      instance.healthy = false;
    };

    this.workers.set(workerId, instance);
    return instance;
  }

  /**
   * Get an available worker of the specified type (thread-safe)
   */
  private async getAvailableWorker(type: WorkerType): Promise<WorkerInstance> {
    await this.poolMutex.acquire();
    try {
      // Clean up any unhealthy workers first
      for (const [id, instance] of this.workers.entries()) {
        if (!instance.healthy && !instance.busy) {
          instance.worker.terminate();
          this.workers.delete(id);
        }
      }

      // Find an idle, healthy worker of the right type
      for (const instance of this.workers.values()) {
        if (instance.type === type && !instance.busy && instance.healthy) {
          instance.busy = true;
          instance.lastUsed = Date.now();
          return instance;
        }
      }

      // No idle workers, check if we can create a new one
      const typeCount = Array.from(this.workers.values()).filter(w => w.type === type).length;
      if (typeCount < Math.ceil(this.config.maxWorkers / 2)) {
        const instance = this.createWorker(type);
        instance.busy = true;
        return instance;
      }

      // At capacity - create one anyway (overflow for burst handling)
      // but log a warning for monitoring
      if (typeCount >= Math.ceil(this.config.maxWorkers / 2)) {
        console.warn(`Worker pool at capacity for ${type}, creating overflow worker`);
      }
      const instance = this.createWorker(type);
      instance.busy = true;
      return instance;
    } finally {
      this.poolMutex.release();
    }
  }

  /**
   * Release a worker back to the pool with health validation
   */
  private releaseWorker(instance: WorkerInstance, error?: Error): void {
    instance.lastUsed = Date.now();

    // If an error occurred during execution, mark as unhealthy
    if (error) {
      instance.healthy = false;
      console.warn(`Worker ${instance.id} marked unhealthy after error:`, error.message);
    }

    // Only release healthy workers back to pool
    if (instance.healthy) {
      instance.busy = false;
    } else {
      // Schedule unhealthy worker for cleanup
      instance.busy = false;
      // Terminate immediately if not in use
      instance.worker.terminate();
      this.workers.delete(instance.id);
    }
  }

  /**
   * Clean up idle workers
   */
  private cleanupIdleWorkers(): void {
    const now = Date.now();
    
    // Group workers by type
    const byType: Record<WorkerType, WorkerInstance[]> = {
      analysis: [],
      simulation: []
    };

    for (const instance of this.workers.values()) {
      byType[instance.type].push(instance);
    }

    // Process each type
    for (const type of ['analysis', 'simulation'] as WorkerType[]) {
      const instances = byType[type];
      
      // Sort by last used (oldest first) to prioritize removing stale ones
      instances.sort((a, b) => a.lastUsed - b.lastUsed);

      // Keep at least one
      if (instances.length <= 1) continue;

      for (const instance of instances) {
        // Don't remove if it's the last one (re-check count)
        if (this.workers.size <= 1) break; // Global safety
        
        // Check if idle and timed out
        if (!instance.busy && now - instance.lastUsed > this.config.idleTimeout) {
          // Ensure we keep at least one of this type
          const remainingOfType = Array.from(this.workers.values())
            .filter(w => w.type === type && w.id !== instance.id).length;
            
          if (remainingOfType >= 1) {
            instance.worker.terminate();
            this.workers.delete(instance.id);
          }
        }
      }
    }
  }

  // ============================================================
  // Analysis API
  // ============================================================

  /**
   * Run an analysis task
   */
  async runAnalysis(request: AnalysisRequest): Promise<AnalysisResult> {
    const { finish } = startOperation('analysis', request.type);
    const instance = await this.getAvailableWorker('analysis');
    let error: Error | undefined;
    try {
      const api = instance.api as SharedAnalysisWorkerAPI;
      const result = await api.runAnalysis(request);
      finish(false);
      return result;
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
      finish(true);
      throw error;
    } finally {
      this.releaseWorker(instance, error);
    }
  }

  /**
   * Run an analysis task with progress reporting
   */
  async runAnalysisWithProgress(
    request: AnalysisRequest,
    onProgress: (progress: ProgressInfo) => void
  ): Promise<AnalysisResult> {
    const { finish } = startOperation('analysis', request.type);
    const instance = await this.getAvailableWorker('analysis');
    let error: Error | undefined;
    try {
      const api = instance.api as SharedAnalysisWorkerAPI;
      const result = await api.runAnalysisWithProgress(request, Comlink.proxy(onProgress));
      finish(false);
      return result;
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
      finish(true);
      throw error;
    } finally {
      this.releaseWorker(instance, error);
    }
  }

  // ============================================================
  // SharedArrayBuffer Analysis API (Zero-Copy)
  // ============================================================

  /**
   * Check if SharedArrayBuffer is available for zero-copy operations.
   */
  isSharedMemoryAvailable(): boolean {
    return this.sequencePool.isUsingSharedMemory();
  }

  /**
   * Preload a sequence into the shared buffer pool.
   * Call this when loading a phage to prepare for analysis operations.
   *
   * @param phageId - Unique identifier for the phage
   * @param sequence - DNA sequence string
   * @returns SharedSequenceRef for use with analysis methods
   */
  preloadSequence(phageId: number, sequence: string): SharedSequenceRef {
    return this.sequencePool.getOrCreateRef(phageId, sequence).ref;
  }

  /**
   * Get a sequence reference if already preloaded.
   * Returns undefined if the sequence isn't in the pool.
   */
  getSequenceRef(phageId: number): SharedSequenceRef | undefined {
    return this.sequencePool.getRef(phageId)?.ref;
  }

  /**
   * Release a sequence from the shared buffer pool.
   * Call this when navigating away from a phage to free memory.
   */
  releaseSequence(phageId: number): void {
    this.sequencePool.release(phageId);
  }

  /**
   * Run an analysis task using a shared buffer reference.
   * This avoids copying the sequence data to the worker.
   *
   * If the sequence isn't preloaded, it will be preloaded automatically.
   */
  async runAnalysisWithSharedBuffer(
    phageId: number,
    sequence: string,
    type: AnalysisType,
    options?: AnalysisOptions
  ): Promise<AnalysisResult> {
    const { finish } = startOperation('analysis', type);
    const instance = await this.getAvailableWorker('analysis');
    let error: Error | undefined;

    try {
      const api = instance.api as SharedAnalysisWorkerAPI;
      const { ref: sequenceRef, transfer } = this.sequencePool.getOrCreateRef(phageId, sequence);
      const request: SharedAnalysisRequest = { type, sequenceRef, options };

      let result: AnalysisResult;
      if (transfer.length > 0) {
        result = await api.runAnalysisShared(Comlink.transfer(request, transfer));
      } else {
        result = await api.runAnalysisShared(request);
      }
      finish(false);
      return result;
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
      finish(true);
      throw error;
    } finally {
      this.releaseWorker(instance, error);
    }
  }

  /**
   * Run analysis with shared buffer and progress reporting.
   */
  async runAnalysisWithSharedBufferProgress(
    phageId: number,
    sequence: string,
    type: AnalysisType,
    onProgress: (progress: ProgressInfo) => void,
    options?: AnalysisOptions
  ): Promise<AnalysisResult> {
    const { finish } = startOperation('analysis', type);
    const instance = await this.getAvailableWorker('analysis');
    let error: Error | undefined;

    try {
      const api = instance.api as SharedAnalysisWorkerAPI;
      const { ref: sequenceRef, transfer } = this.sequencePool.getOrCreateRef(phageId, sequence);
      const request: SharedAnalysisRequest = { type, sequenceRef, options };

      let result: AnalysisResult;
      if (transfer.length > 0) {
        result = await api.runAnalysisSharedWithProgress(
          Comlink.transfer(request, transfer),
          Comlink.proxy(onProgress)
        );
      } else {
        result = await api.runAnalysisSharedWithProgress(request, Comlink.proxy(onProgress));
      }
      finish(false);
      return result;
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
      finish(true);
      throw error;
    } finally {
      this.releaseWorker(instance, error);
    }
  }

  /**
   * Decode a sequence from a SharedSequenceRef.
   * Useful when workers need to read the sequence.
   */
  decodeSequenceFromRef(ref: SharedSequenceRef): string {
    const view = new Uint8Array(ref.buffer, ref.byteOffset, ref.byteLength);
    return decodeSequence(view, ref.length);
  }

  /**
   * Get shared sequence pool statistics.
   */
  getSequencePoolStats(): {
    size: number;
    maxSize: number;
    totalBytes: number;
    sharedMemory: boolean;
  } {
    return this.sequencePool.getStats();
  }

  // ============================================================
  // Simulation API
  // ============================================================

  /**
   * Initialize a simulation
   */
  async initSimulation(params: SimInitParams): Promise<SimState> {
    const { finish } = startOperation('simulation', params.simulationId);
    const instance = await this.getAvailableWorker('simulation');
    let error: Error | undefined;
    try {
      const api = instance.api as SimulationWorkerAPI;
      const result = await api.init(params);
      finish(false);
      return result;
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
      finish(true);
      throw error;
    } finally {
      this.releaseWorker(instance, error);
    }
  }

  /**
   * Step a simulation forward
   */
  async stepSimulation(state: SimState, dt: number): Promise<SimState> {
    const instance = await this.getAvailableWorker('simulation');
    let error: Error | undefined;
    try {
      const api = instance.api as SimulationWorkerAPI;
      return await api.step({ state, dt });
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
      throw error;
    } finally {
      this.releaseWorker(instance, error);
    }
  }

  /**
   * Step a simulation multiple times in batch
   */
  async stepSimulationBatch(state: SimState, dt: number, steps: number): Promise<SimState[]> {
    const instance = await this.getAvailableWorker('simulation');
    let error: Error | undefined;
    try {
      const api = instance.api as SimulationWorkerAPI;
      return await api.stepBatch(state, dt, steps);
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
      throw error;
    } finally {
      this.releaseWorker(instance, error);
    }
  }

  /**
   * Get simulation metadata
   */
  async getSimulationMetadata(simId: SimulationId): Promise<{
    name: string;
    description: string;
    parameters: SimParameter[];
  }> {
    const instance = await this.getAvailableWorker('simulation');
    let error: Error | undefined;
    try {
      const api = instance.api as SimulationWorkerAPI;
      return await api.getMetadata(simId);
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
      throw error;
    } finally {
      this.releaseWorker(instance, error);
    }
  }

  // ============================================================
  // Lifecycle
  // ============================================================

  /**
   * Get worker pool stats
   */
  getStats(): {
    total: number;
    busy: number;
    byType: Record<WorkerType, { total: number; busy: number }>;
  } {
    const stats = {
      total: this.workers.size,
      busy: 0,
      byType: {
        analysis: { total: 0, busy: 0 },
        simulation: { total: 0, busy: 0 },
      } as Record<WorkerType, { total: number; busy: number }>,
    };

    for (const instance of this.workers.values()) {
      stats.byType[instance.type].total++;
      if (instance.busy) {
        stats.busy++;
        stats.byType[instance.type].busy++;
      }
    }

    return stats;
  }

  /**
   * Get performance instrumentation stats (dev-only).
   * Call this to see timing/cancellation metrics.
   */
  getPerfStats() {
    return getAggregateStats();
  }

  /**
   * Print a formatted performance report to the console (dev-only).
   */
  printPerfReport() {
    printReport();
  }

  /**
   * Terminate all workers and cleanup
   */
  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    for (const instance of this.workers.values()) {
      instance.worker.terminate();
    }
    this.workers.clear();

    // Clear the sequence pool
    this.sequencePool.clear();

    ComputeOrchestrator.instance = null;
  }
}

// Export singleton accessor
export function getOrchestrator(config?: WorkerPoolConfig): ComputeOrchestrator {
  return ComputeOrchestrator.getInstance(config);
}
