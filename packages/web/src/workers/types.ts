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
  | 'kmer-spectrum'
  | 'transcription-flow';

/**
 * Search task types (SearchOverlay)
 */
export type SearchMode = 'sequence' | 'motif' | 'gene' | 'feature' | 'position';

export type StrandOption = 'both' | '+' | '-';

export interface SearchFeature {
  start: number;
  end: number;
  strand?: StrandOption | string | null;
  name?: string | null;
  product?: string | null;
  type?: string | null;
}

export interface SearchOptions {
  strand?: StrandOption;
  caseSensitive?: boolean;
  mismatches?: number;
  maxResults?: number;
}

export interface SearchRequest {
  mode: SearchMode;
  query: string;
  sequence: string;
  features: SearchFeature[];
  options?: SearchOptions;
}

export interface SearchHit {
  position: number;
  end?: number;
  strand: StrandOption;
  label: string;
  context?: string;
  score?: number;
  matchType?: string;
  feature?: SearchFeature;
}

export interface SearchResponse {
  mode: SearchMode;
  query: string;
  hits: SearchHit[];
}

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
 * Transcription flow result
 */
export interface TranscriptionFlowResult {
  type: 'transcription-flow';
  values: number[];
  peaks: Array<{ start: number; end: number; flux: number }>;
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
  | KmerSpectrumResult
  | TranscriptionFlowResult;

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
 * Search Worker API
 */
export interface SearchWorkerAPI {
  runSearch(request: SearchRequest): Promise<SearchResponse>;
  /** Verify worker is initialized and responsive */
  ping(): Promise<boolean>;
}

/**
 * Worker pool configuration
 */
export interface WorkerPoolConfig {
  maxWorkers?: number;
  idleTimeout?: number;
}

// ============================================================
// SharedArrayBuffer Support Types
// ============================================================

/**
 * Reference to a shared sequence buffer for zero-copy worker communication.
 * When SharedArrayBuffer is available, the buffer can be accessed directly
 * in workers without copying.
 */
export interface SharedSequenceRef {
  /** Phage ID this sequence belongs to */
  phageId: number;
  /** SharedArrayBuffer (or ArrayBuffer fallback) containing ASCII-encoded sequence */
  buffer: SharedArrayBuffer | ArrayBuffer;
  /** Length of the sequence in characters */
  length: number;
  /** Whether this is a true SharedArrayBuffer (enables zero-copy) */
  isShared: boolean;
}

/**
 * Analysis request using shared buffer reference instead of string.
 * Use this for large sequences to avoid copying data to workers.
 */
export interface SharedAnalysisRequest {
  type: AnalysisType;
  /** Reference to shared sequence buffer (instead of string) */
  sequenceRef: SharedSequenceRef;
  options?: AnalysisOptions;
}

/**
 * Search request using shared buffer reference.
 */
export interface SharedSearchRequest {
  mode: SearchMode;
  query: string;
  /** Reference to shared sequence buffer */
  sequenceRef: SharedSequenceRef;
  features: SearchFeature[];
  options?: SearchOptions;
}

/**
 * Extended Analysis Worker API with shared buffer support
 */
export interface SharedAnalysisWorkerAPI extends AnalysisWorkerAPI {
  /** Run analysis using shared buffer reference */
  runAnalysisShared(request: SharedAnalysisRequest): Promise<AnalysisResult>;
  runAnalysisSharedWithProgress(
    request: SharedAnalysisRequest,
    onProgress: (progress: ProgressInfo) => void
  ): Promise<AnalysisResult>;
}

/**
 * Extended Search Worker API with shared buffer support
 */
export interface SharedSearchWorkerAPI extends SearchWorkerAPI {
  /** Run search using shared buffer reference */
  runSearchShared(request: SharedSearchRequest): Promise<SearchResponse>;
}
