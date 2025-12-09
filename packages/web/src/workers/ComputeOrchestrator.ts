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
 */

import * as Comlink from 'comlink';
import type {
  AnalysisWorkerAPI,
  SimulationWorkerAPI,
  AnalysisRequest,
  AnalysisResult,
  SimInitParams,
  SimStepRequest,
  SimState,
  SimulationId,
  SimParameter,
  ProgressInfo,
  WorkerPoolConfig,
} from './types';

type WorkerType = 'analysis' | 'simulation';

interface WorkerInstance {
  id: string;
  worker: Worker;
  api: AnalysisWorkerAPI | SimulationWorkerAPI;
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

  private constructor(config: WorkerPoolConfig = {}) {
    this.config = {
      maxWorkers: config.maxWorkers ?? 4,
      idleTimeout: config.idleTimeout ?? 60000, // 1 minute
    };

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
    let api: AnalysisWorkerAPI | SimulationWorkerAPI;

    try {
      if (type === 'analysis') {
        worker = new Worker(
          new URL('./analysis.worker.ts', import.meta.url),
          { type: 'module' }
        );
        api = Comlink.wrap<AnalysisWorkerAPI>(worker);
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
    const instance = await this.getAvailableWorker('analysis');
    let error: Error | undefined;
    try {
      const api = instance.api as AnalysisWorkerAPI;
      return await api.runAnalysis(request);
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
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
    const instance = await this.getAvailableWorker('analysis');
    let error: Error | undefined;
    try {
      const api = instance.api as AnalysisWorkerAPI;
      return await api.runAnalysisWithProgress(request, Comlink.proxy(onProgress));
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
      throw error;
    } finally {
      this.releaseWorker(instance, error);
    }
  }

  // ============================================================
  // Simulation API
  // ============================================================

  /**
   * Initialize a simulation
   */
  async initSimulation(params: SimInitParams): Promise<SimState> {
    const instance = await this.getAvailableWorker('simulation');
    let error: Error | undefined;
    try {
      const api = instance.api as SimulationWorkerAPI;
      return await api.init(params);
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
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

    ComputeOrchestrator.instance = null;
  }
}

// Export singleton accessor
export function getOrchestrator(config?: WorkerPoolConfig): ComputeOrchestrator {
  return ComputeOrchestrator.getInstance(config);
}
