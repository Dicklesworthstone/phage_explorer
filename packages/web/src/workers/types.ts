/**
 * Worker Types - Type definitions for worker communication
 */

import type {
  SimulationId,
  SimState,
  SimParameter,
  LysogenyCircuitState,
  RibosomeTrafficState,
  PlaqueAutomataState,
  EvolutionReplayState,
  PackagingMotorState,
  InfectionKineticsState,
} from '@phage-explorer/core';

// Re-export simulation types
export type {
  SimulationId,
  SimState,
  SimParameter,
  LysogenyCircuitState,
  RibosomeTrafficState,
  PlaqueAutomataState,
  EvolutionReplayState,
  PackagingMotorState,
  InfectionKineticsState,
};

/**
 * Analysis task types
 */
export type AnalysisType =
  | 'gc-skew'
  | 'complexity'
  | 'bendability'
  | 'promoters'
  | 'repeats'
  | 'codon-usage'
  | 'kmer-spectrum';

/**
 * Analysis request
 */
export interface AnalysisRequest {
  type: AnalysisType;
  sequence: string;
  options?: AnalysisOptions;
}

/**
 * Analysis options
 */
export interface AnalysisOptions {
  windowSize?: number;
  minLength?: number;
  maxGap?: number;
  kmerSize?: number;
}

/**
 * GC Skew result
 */
export interface GCSkewResult {
  type: 'gc-skew';
  skew: number[];
  cumulative: number[];
  originPosition?: number;
  terminusPosition?: number;
}

/**
 * Complexity result
 */
export interface ComplexityResult {
  type: 'complexity';
  entropy: number[];
  linguistic: number[];
  lowComplexityRegions: Array<{ start: number; end: number }>;
}

/**
 * Bendability result
 */
export interface BendabilityResult {
  type: 'bendability';
  values: number[];
  flexibleRegions: Array<{ start: number; end: number; avgBendability: number }>;
}

/**
 * Promoter prediction result
 */
export interface PromoterResult {
  type: 'promoters';
  sites: Array<{
    type: 'promoter' | 'rbs';
    position: number;
    sequence: string;
    score: number;
    motif: string;
  }>;
}

/**
 * Repeat finder result
 */
export interface RepeatResult {
  type: 'repeats';
  repeats: Array<{
    type: 'direct' | 'inverted' | 'palindrome';
    position1: number;
    position2?: number;
    sequence: string;
    length: number;
  }>;
}

/**
 * Codon usage result
 */
export interface CodonUsageResult {
  type: 'codon-usage';
  usage: Record<string, number>;
  rscu: Record<string, number>; // Relative Synonymous Codon Usage
  cai?: number; // Codon Adaptation Index
}

/**
 * K-mer spectrum result
 */
export interface KmerSpectrumResult {
  type: 'kmer-spectrum';
  kmerSize: number;
  spectrum: Array<{ kmer: string; count: number; frequency: number }>;
  uniqueKmers: number;
  totalKmers: number;
}

/**
 * Union of all analysis results
 */
export type AnalysisResult =
  | GCSkewResult
  | ComplexityResult
  | BendabilityResult
  | PromoterResult
  | RepeatResult
  | CodonUsageResult
  | KmerSpectrumResult;

/**
 * Progress callback for long-running operations
 */
export interface ProgressInfo {
  current: number;
  total: number;
  message?: string;
}

/**
 * Simulation initialization params
 */
export interface SimInitParams {
  simId: SimulationId;
  params?: Record<string, number | boolean | string>;
  seed?: number;
}

/**
 * Simulation step request
 */
export interface SimStepRequest {
  state: SimState;
  dt: number;
  steps?: number; // Number of steps to run in batch
}

/**
 * Worker API interface (for Comlink)
 */
export interface AnalysisWorkerAPI {
  runAnalysis(request: AnalysisRequest): Promise<AnalysisResult>;
  runAnalysisWithProgress(
    request: AnalysisRequest,
    onProgress: (progress: ProgressInfo) => void
  ): Promise<AnalysisResult>;
}

/**
 * Simulation Worker API interface
 */
export interface SimulationWorkerAPI {
  init(params: SimInitParams): Promise<SimState>;
  step(request: SimStepRequest): Promise<SimState>;
  stepBatch(state: SimState, dt: number, steps: number): Promise<SimState[]>;
  getMetadata(simId: SimulationId): Promise<{
    name: string;
    description: string;
    parameters: SimParameter[];
  }>;
}

/**
 * Worker pool configuration
 */
export interface WorkerPoolConfig {
  maxWorkers?: number;
  idleTimeout?: number;
}
