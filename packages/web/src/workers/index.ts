/**
 * Workers Module Exports
 */

// Main orchestrator
export { ComputeOrchestrator, getOrchestrator } from './ComputeOrchestrator';

// Shared memory pool for zero-copy sequence data
export {
  SharedSequencePool,
  decodeSequence,
  createSequenceView,
  isSharedBuffer,
  type SequenceBuffer,
} from './SharedSequencePool';

// Worker preloader - warm optional search after the first genome is available.
export {
  preloadWorkers,
  getSearchWorker,
  isPreloaded,
  terminateWorkers,
} from './WorkerPreloader';

// Types
export type {
  AnalysisType,
  AnalysisRequest,
  AnalysisResult,
  AnalysisOptions,
  GCSkewResult,
  ComplexityResult,
  BendabilityResult,
  PromoterResult,
  RepeatResult,
  CodonUsageResult,
  KmerSpectrumResult,
  ProgressInfo,
  SimInitParams,
  SimStepRequest,
  AnalysisWorkerAPI,
  SimulationWorkerAPI,
  SearchWorkerAPI,
  SearchMode,
  SearchRequest,
  SearchResponse,
  SearchHit,
  SearchFeature,
  SearchOptions,
  FuzzySearchEntry,
  FuzzyIndexRequest,
  FuzzySearchRequest,
  FuzzySearchResult,
  WorkerPoolConfig,
  // SharedArrayBuffer types
  SequenceEncoding,
  SequenceBytesRef,
  SharedSequenceRef,
  SharedAnalysisRequest,
  SharedSearchRequest,
  SharedAnalysisWorkerAPI,
  SharedSearchWorkerAPI,
  // postMessage worker types
  DotPlotJob,
  DotPlotWorkerResponse,
  ComparisonJob,
  ComparisonWorkerMessage,
  ComparisonDiffStats,
} from './types';

// Re-export simulation types from core
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
} from './types';
