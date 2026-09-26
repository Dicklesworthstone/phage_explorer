/**
 * ComputeOrchestrator - bounded analysis/simulation worker management.
 *
 * All jobs share a hard worker budget, queue FIFO, and accept an optional
 * AbortSignal. Aborting an active calculation terminates its worker; aborting
 * queued work never interrupts somebody else's calculation.
 */
import * as Comlink from 'comlink';
import type { KmerFrequencyOptions, KmerVector, PCAOptions, PCAResult, PhasePortraitResult } from '@phage-explorer/core';
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
  KmerVectorRequest,
  GenomicSignaturePcaRequest,
  BiasDecompositionRequest,
  BiasDecompositionWorkerResult,
  PhasePortraitRequest,
} from './types';
import { SharedSequencePool, decodeSequence } from './SharedSequencePool';
import { startOperation, getAggregateStats, printReport } from './perf-instrumentation';
import { WorkerTaskPool } from './WorkerTaskPool';

type WorkerType = 'analysis' | 'simulation';
interface WorkerInstance {
  id: string;
  worker: Worker;
  api: SharedAnalysisWorkerAPI | SimulationWorkerAPI;
}

export class ComputeOrchestrator {
  private static instance: ComputeOrchestrator | null = null;
  private readonly pool: WorkerTaskPool<WorkerType, WorkerInstance>;
  private readonly sequencePool: SharedSequencePool;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private nextWorkerId = 0;

  private constructor(config: WorkerPoolConfig = {}) {
    const idleTimeout = config.idleTimeout ?? 60000;
    if (!Number.isFinite(idleTimeout) || idleTimeout < 0) {
      throw new Error('Worker idle timeout must be a non-negative finite number.');
    }
    this.pool = new WorkerTaskPool(config.maxWorkers ?? 4, type => this.createWorker(type), instance => {
      instance.worker.onerror = null;
      instance.worker.onmessageerror = null;
      instance.worker.terminate();
    });
    this.sequencePool = SharedSequencePool.getInstance();
    this.cleanupInterval = setInterval(() => this.pool.pruneIdle(idleTimeout), 30000);
  }

  static getInstance(config?: WorkerPoolConfig): ComputeOrchestrator {
    if (!ComputeOrchestrator.instance) {
      ComputeOrchestrator.instance = new ComputeOrchestrator(config);
    }
    return ComputeOrchestrator.instance;
  }

  private createWorker(type: WorkerType): WorkerInstance {
    const id = `${type}-${++this.nextWorkerId}`;
    let worker: Worker | undefined;
    try {
      if (type === 'analysis') {
        try {
          worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
        } catch {
          worker = new Worker(new URL('./analysis.worker.ts', import.meta.url));
        }
      } else {
        try {
          worker = new Worker(new URL('./simulation.worker.ts', import.meta.url), { type: 'module' });
        } catch {
          worker = new Worker(new URL('./simulation.worker.ts', import.meta.url));
        }
      }
      const api = type === 'analysis'
        ? Comlink.wrap<SharedAnalysisWorkerAPI>(worker)
        : Comlink.wrap<SimulationWorkerAPI>(worker);
      const instance: WorkerInstance = { id, worker, api };
      // Browser errors need not reject an outstanding Comlink RPC. Settle its
      // task explicitly so the worker budget and caller cannot remain stuck.
      worker.onerror = event => this.pool.invalidate(instance, new Error(`Worker ${id}: ${event.message}`));
      worker.onmessageerror = () => this.pool.invalidate(instance, new Error(`Worker ${id} could not deserialize a message.`));
      return instance;
    } catch (error) {
      worker?.terminate();
      throw new Error(`Failed to create ${type} worker: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async runTask<T>(
    type: WorkerType,
    operation: string | null,
    execute: (instance: WorkerInstance, isActive: () => boolean) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const metric = operation === null ? null : startOperation(type, operation);
    let active = true;
    let failed = false;
    try {
      return await this.pool.run(type, instance => execute(instance, () => active && !signal?.aborted), signal);
    } catch (error) {
      failed = true;
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      active = false;
      // Includes failures during worker acquisition and queued cancellation.
      metric?.finish(failed);
    }
  }

  async runAnalysis(request: AnalysisRequest, signal?: AbortSignal): Promise<AnalysisResult> {
    const snapshot = structuredClone(request);
    return this.runTask('analysis', snapshot.type, async instance => {
      return (instance.api as SharedAnalysisWorkerAPI).runAnalysis(snapshot);
    }, signal);
  }

  async runAnalysisWithProgress(
    request: AnalysisRequest,
    onProgress: (progress: ProgressInfo) => void,
    signal?: AbortSignal,
  ): Promise<AnalysisResult> {
    const snapshot = structuredClone(request);
    return this.runTask('analysis', snapshot.type, async (instance, isActive) => {
      return (instance.api as SharedAnalysisWorkerAPI).runAnalysisWithProgress(
        snapshot, Comlink.proxy((progress: ProgressInfo) => { if (isActive()) onProgress(progress); }),
      );
    }, signal);
  }

  isSharedMemoryAvailable(): boolean {
    return this.sequencePool.isUsingSharedMemory();
  }

  preloadSequence(phageId: number, sequence: string): SharedSequenceRef {
    return this.sequencePool.getOrCreateRef(phageId, sequence).ref;
  }

  getSequenceRef(phageId: number): SharedSequenceRef | undefined {
    return this.sequencePool.getRef(phageId)?.ref;
  }

  releaseSequence(phageId: number): void {
    this.sequencePool.release(phageId);
  }

  async runAnalysisWithSharedBuffer(
    phageId: number,
    sequence: string,
    type: AnalysisType,
    options?: AnalysisOptions,
    evidenceContext?: AnalysisRequest['evidenceContext'],
    signal?: AbortSignal,
  ): Promise<AnalysisResult> {
    const snapshot = structuredClone({ options, evidenceContext });
    return this.runTask('analysis', type, async instance => {
      const api = instance.api as SharedAnalysisWorkerAPI;
      // Allocate/transfer only after admission. Queued cancellation must not
      // detach a buffer or replace a sequence reference used by another task.
      const { ref: sequenceRef, transfer } = this.sequencePool.getOrCreateRef(phageId, sequence);
      const request: SharedAnalysisRequest = { type, sequenceRef, ...snapshot };
      return transfer.length > 0
        ? api.runAnalysisShared(Comlink.transfer(request, transfer))
        : api.runAnalysisShared(request);
    }, signal);
  }

  async runAnalysisWithSharedBufferProgress(
    phageId: number,
    sequence: string,
    type: AnalysisType,
    onProgress: (progress: ProgressInfo) => void,
    options?: AnalysisOptions,
    signal?: AbortSignal,
  ): Promise<AnalysisResult> {
    const snapshot = structuredClone(options);
    return this.runTask('analysis', type, async (instance, isActive) => {
      const api = instance.api as SharedAnalysisWorkerAPI;
      const { ref: sequenceRef, transfer } = this.sequencePool.getOrCreateRef(phageId, sequence);
      const request: SharedAnalysisRequest = { type, sequenceRef, options: snapshot };
      const report = Comlink.proxy((progress: ProgressInfo) => { if (isActive()) onProgress(progress); });
      return transfer.length > 0
        ? api.runAnalysisSharedWithProgress(Comlink.transfer(request, transfer), report)
        : api.runAnalysisSharedWithProgress(request, report);
    }, signal);
  }

  decodeSequenceFromRef(ref: SharedSequenceRef): string {
    return decodeSequence(new Uint8Array(ref.buffer, ref.byteOffset, ref.byteLength), ref.length);
  }

  getSequencePoolStats(): { size: number; maxSize: number; totalBytes: number; sharedMemory: boolean } {
    return this.sequencePool.getStats();
  }

  async computeKmerVectorWithSharedBuffer(
    phageId: number,
    name: string,
    sequence: string,
    options?: KmerFrequencyOptions,
    signal?: AbortSignal,
  ): Promise<KmerVector> {
    const snapshot = structuredClone(options);
    return this.runTask('analysis', 'kmer-vector', async instance => {
      const api = instance.api as SharedAnalysisWorkerAPI;
      const { ref: sequenceRef, transfer } = this.sequencePool.getOrCreateRef(phageId, sequence);
      const request: KmerVectorRequest = { phageId, name, sequenceRef, options: snapshot };
      return transfer.length > 0
        ? api.computeKmerVector(Comlink.transfer(request, transfer))
        : api.computeKmerVector(request);
    }, signal);
  }

  async computeGenomicSignaturePca(
    vectors: KmerVector[],
    options?: PCAOptions,
    signal?: AbortSignal,
  ): Promise<PCAResult | null> {
    // Capture the caller's exact vectors before queueing; later UI mutations
    // must not change an already submitted experiment.
    const snapshot = structuredClone(vectors);
    const optionSnapshot = structuredClone(options);
    return this.runTask('analysis', 'genomic-signature-pca', async instance => {
      if (snapshot.length < 3) return null;
      const dim = snapshot[0].frequencies.length;
      if (dim <= 0) return null;
      for (let i = 1; i < snapshot.length; i++) {
        if (snapshot[i].frequencies.length !== dim) {
          throw new Error('All PCA vectors must have the same dimensionality');
        }
      }
      const flat = new Float32Array(snapshot.length * dim);
      const metas: GenomicSignaturePcaRequest['vectors'] = snapshot.map((vector, index) => {
        flat.set(vector.frequencies, index * dim);
        return { phageId: vector.phageId, name: vector.name, gcContent: vector.gcContent, genomeLength: vector.genomeLength };
      });
      const request: GenomicSignaturePcaRequest = { vectors: metas, frequencies: flat, dim, options: optionSnapshot };
      return (instance.api as SharedAnalysisWorkerAPI).computeGenomicSignaturePca(Comlink.transfer(request, [flat.buffer]));
    }, signal);
  }

  async computeBiasDecompositionWithSharedBuffer(
    phageId: number,
    sequence: string,
    windowSize: number,
    stepSize: number,
    signal?: AbortSignal,
  ): Promise<BiasDecompositionWorkerResult | null> {
    return this.runTask('analysis', 'bias-decomposition', async instance => {
      const api = instance.api as SharedAnalysisWorkerAPI;
      const { ref: sequenceRef, transfer } = this.sequencePool.getOrCreateRef(phageId, sequence);
      const request: BiasDecompositionRequest = { sequenceRef, windowSize, stepSize };
      return transfer.length > 0
        ? api.computeBiasDecomposition(Comlink.transfer(request, transfer))
        : api.computeBiasDecomposition(request);
    }, signal);
  }

  async computePhasePortraitWithSharedBuffer(
    phageId: number,
    sequence: string,
    windowSize: number,
    stepSize: number,
    signal?: AbortSignal,
  ): Promise<PhasePortraitResult | null> {
    return this.runTask('analysis', 'phase-portrait', async instance => {
      const api = instance.api as SharedAnalysisWorkerAPI;
      const { ref: sequenceRef, transfer } = this.sequencePool.getOrCreateRef(phageId, sequence);
      const request: PhasePortraitRequest = { sequenceRef, windowSize, stepSize };
      return transfer.length > 0
        ? api.computePhasePortrait(Comlink.transfer(request, transfer))
        : api.computePhasePortrait(request);
    }, signal);
  }

  async initSimulation(params: SimInitParams, signal?: AbortSignal): Promise<SimState> {
    const snapshot = structuredClone(params);
    return this.runTask('simulation', snapshot.simId, async instance => {
      return (instance.api as SimulationWorkerAPI).init(snapshot);
    }, signal);
  }

  async stepSimulation(state: SimState, dt: number, signal?: AbortSignal): Promise<SimState> {
    const snapshot = structuredClone(state);
    return this.runTask('simulation', null, async instance => {
      return (instance.api as SimulationWorkerAPI).step({ state: snapshot, dt });
    }, signal);
  }

  async stepSimulationBatch(state: SimState, dt: number, steps: number, signal?: AbortSignal): Promise<SimState[]> {
    const snapshot = structuredClone(state);
    return this.runTask('simulation', null, async instance => {
      return (instance.api as SimulationWorkerAPI).stepBatch(snapshot, dt, steps);
    }, signal);
  }

  async getSimulationMetadata(simId: SimulationId, signal?: AbortSignal): Promise<{
    name: string; description: string; parameters: SimParameter[];
  }> {
    return this.runTask('simulation', null, async instance => {
      return (instance.api as SimulationWorkerAPI).getMetadata(simId);
    }, signal);
  }

  getStats(): {
    total: number;
    busy: number;
    queued: number;
    byType: Record<WorkerType, { total: number; busy: number }>;
  } {
    const stats = this.pool.getStats();
    return {
      total: stats.total, busy: stats.busy, queued: stats.queued,
      byType: {
        analysis: stats.byType.get('analysis') ?? { total: 0, busy: 0 },
        simulation: stats.byType.get('simulation') ?? { total: 0, busy: 0 },
      },
    };
  }

  getPerfStats() {
    return getAggregateStats();
  }

  printPerfReport() {
    printReport();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    this.cleanupInterval = null;
    this.pool.dispose();
    this.sequencePool.clear();
    if (ComputeOrchestrator.instance === this) ComputeOrchestrator.instance = null;
  }
}

export function getOrchestrator(config?: WorkerPoolConfig): ComputeOrchestrator {
  return ComputeOrchestrator.getInstance(config);
}
