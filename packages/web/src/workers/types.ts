/**
 * Worker Types - Type definitions for worker communication
 */

import type {
  SimulationId,
  SimState,
  SimParameter,
  Simulation,
  LysogenyCircuitState,
  RibosomeTrafficState,
  PlaqueAutomataState,
  EvolutionReplayState,
  PackagingMotorState,
  InfectionKineticsState,
  ResistanceCocktailState,
  DotPlotConfig,
  DotPlotResult,
  BiasDecomposition,
  KmerFrequencyOptions,
  KmerVector,
  PCAOptions,
  PCAResult,
  PhasePortraitResult,
  PhageFull,
} from '@phage-explorer/core';
import type { GenomeComparisonResult } from '@phage-explorer/comparison';

// Re-export simulation types
export type {
  SimulationId,
  SimState,
  SimParameter,
  Simulation,
  LysogenyCircuitState,
  RibosomeTrafficState,
  PlaqueAutomataState,
  EvolutionReplayState,
  PackagingMotorState,
  InfectionKineticsState,
  ResistanceCocktailState,
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
 * Fuzzy search index types (used by CommandPalette + PhagePickerSheet).
 *
 * Kept in the SearchWorker so fuzzy search can run off the main thread.
 */
export interface FuzzySearchEntry<TMeta = unknown> {
  /** Stable ID understood by the caller (e.g. `phage:12`, `gene:34`) */
  id: string;
  /** Text used for matching (caller can display something else if desired) */
  text: string;
  /** Optional metadata blob returned alongside results */
  meta?: TMeta;
}

export interface FuzzyIndexRequest<TMeta = unknown> {
  /** Logical index name (e.g. `phage-picker`, `command-palette`) */
  index: string;
  /** Replace the entire index contents */
  entries: Array<FuzzySearchEntry<TMeta>>;
}

export interface FuzzySearchRequest {
  index: string;
  query: string;
  limit?: number;
}

export interface FuzzySearchResult<TMeta = unknown> extends FuzzySearchEntry<TMeta> {
  score: number;
  /** Matched character indices in `text` (for highlight) */
  indices: number[];
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

// ============================================================
// PCA-family worker jobs (PCA overlays / bias decomposition / phase portrait)
// ============================================================

export interface GenomicSignaturePcaRequest {
  /** Per-phage metadata (frequencies are provided as a single flat buffer). */
  vectors: Array<Omit<KmerVector, 'frequencies'>>;
  /** Flat row-major matrix: length = vectors.length * dim. */
  frequencies: Float32Array;
  /** Number of features per row in `frequencies`. */
  dim: number;
  options?: PCAOptions;
}

export interface KmerVectorRequest {
  phageId: number;
  name: string;
  sequenceRef: SequenceBytesRef;
  options?: KmerFrequencyOptions;
}

export interface BiasDecompositionRequest {
  sequenceRef: SequenceBytesRef;
  windowSize: number;
  stepSize: number;
}

export interface BiasDecompositionWorkerResult {
  decomposition: BiasDecomposition;
  gcContents: number[];
  positions: number[];
}

export interface PhasePortraitRequest {
  sequenceRef: SequenceBytesRef;
  windowSize: number;
  stepSize: number;
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
    type: 'direct' | 'inverted' | 'palindrome' | 'tandem';
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
  /**
   * The phage currently open in the UI. Simulations that model a specific
   * genome (ribosome traffic, evolution replay, packaging motor) read their
   * genome length, gene set and codon usage from this; without it they fall
   * back to generic synthetic defaults.
   */
  phage?: PhageFull | null;
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

  // PCA-family compute off main thread
  computeKmerVector(request: KmerVectorRequest): Promise<KmerVector>;
  computeGenomicSignaturePca(request: GenomicSignaturePcaRequest): Promise<PCAResult | null>;
  computeBiasDecomposition(request: BiasDecompositionRequest): Promise<BiasDecompositionWorkerResult | null>;
  computePhasePortrait(request: PhasePortraitRequest): Promise<PhasePortraitResult | null>;
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
  /** Replace (or create) a named fuzzy-search index */
  setFuzzyIndex<TMeta = unknown>(request: FuzzyIndexRequest<TMeta>): Promise<void>;
  /** Search a named index and return ranked results */
  fuzzySearch<TMeta = unknown>(request: FuzzySearchRequest): Promise<Array<FuzzySearchResult<TMeta>>>;
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
 * Canonical sequence encodings for worker/WASM pipelines.
 *
 * - `ascii`: raw ASCII bytes of the original sequence (A/C/G/T/N, case-insensitive).
 * - `acgt05`: encoded bases where A=0, C=1, G=2, T=3, N/other=4.
 */
export type SequenceEncoding = 'ascii' | 'acgt05';

/**
 * Byte-backed sequence reference for worker communication.
 *
 * This is the preferred transport for large genomes because it avoids repeatedly
 * structured-cloning giant strings between threads.
 *
 * Notes:
 * - `SharedArrayBuffer` requires `crossOriginIsolated === true` (COOP/COEP).
 * - When SAB is unavailable, use a transferable `ArrayBuffer` instead.
 */
export interface SequenceBytesRef {
  buffer: SharedArrayBuffer | ArrayBuffer;
  /** Byte offset into `buffer` where the sequence starts (usually 0). */
  byteOffset: number;
  /** Byte length of the sequence payload (usually equals `length` for `ascii`). */
  byteLength: number;
  /** Sequence length in characters/bases (for `ascii`, equals `byteLength`). */
  length: number;
  encoding: SequenceEncoding;
  /** Whether this is a true SharedArrayBuffer (zero-copy) vs transferred ArrayBuffer. */
  isShared: boolean;
}

/**
 * Reference to a shared sequence buffer for zero-copy worker communication.
 * When SharedArrayBuffer is available, the buffer can be accessed directly
 * in workers without copying.
 */
export interface SharedSequenceRef extends SequenceBytesRef {
  /** Phage ID this sequence belongs to (used for caching/debugging). */
  phageId: number;
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

// ============================================================
// Non-Comlink Worker Message Types (postMessage + Transferables)
// ============================================================

export type DotPlotJob =
  | { sequence: string; config?: DotPlotConfig }
  | { sequenceRef: SequenceBytesRef; config?: DotPlotConfig };

export interface DotPlotWorkerResponse {
  ok: boolean;
  result?: DotPlotResult;
  // Pre-flattened for HeatmapCanvas
  directValues?: Float32Array;
  invertedValues?: Float32Array;
  bins?: number;
  window?: number;
  error?: string;
}

export type ComparisonJob =
  | {
      jobId?: string;
      phageA: { id: number; name: string; accession: string };
      phageB: { id: number; name: string; accession: string };
      sequenceA: string;
      sequenceB: string;
      genesA: any[];
      genesB: any[];
      codonUsageA?: any | null;
      codonUsageB?: any | null;
    }
  | {
      jobId?: string;
      phageA: { id: number; name: string; accession: string };
      phageB: { id: number; name: string; accession: string };
      sequenceARef: SequenceBytesRef;
      sequenceBRef: SequenceBytesRef;
      genesA: any[];
      genesB: any[];
      codonUsageA?: any | null;
      codonUsageB?: any | null;
    };

export interface ComparisonWorkerMessage {
  jobId?: string;
  ok: boolean;
  result?: GenomeComparisonResult;
  diffMask?: Uint8Array;
  diffPositions?: number[];
  diffStats?: ComparisonDiffStats;
  error?: string;
}

export interface ComparisonDiffStats {
  insertions: number;
  deletions: number;
  substitutions: number;
  matches: number;
  lengthA: number;
  lengthB: number;
  identity: number;
}
