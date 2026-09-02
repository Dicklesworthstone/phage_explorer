/**
 * API Module Index
 *
 * Provides access to external data sources for real data visualization:
 * - Serratus: Metagenome containment for environmental provenance
 * - SRA Metadata: Geographic and isolation source data
 * - NCBI Entrez: Dated viral sequences for phylodynamics
 */

// Types
export type {
  SerratusSequenceMatch,
  SerratusSearchResponse,
  SRARunMetadata,
  EnvironmentalProvenanceData,
  NCBISequenceRecord,
  NCBIESearchResult,
  PhylodynamicsData,
  APIResult,
  APIError,
  CacheEntry,
  CacheConfig,
} from './types';

// Serratus API
export {
  searchByFamily,
  getRunDetails,
  searchPhageRelated,
  getSRARunsForFamily,
} from './serratus';

// SRA Metadata
export {
  fetchSRARunMetadata,
  fetchSRARunMetadataBatch,
  searchSRARuns,
  processProvenanceData,
} from './sra-metadata';

// NCBI Entrez
export {
  searchNucleotide,
  fetchSequenceSummaries,
  fetchGenBankRecord,
  fetchDatedPhageSequences,
  fetchSequencesFasta,
  getPhageSearchTerms,
} from './ncbi-entrez';

// Cache utilities
export {
  generateCacheKey,
  getCached,
  setCache,
  removeCache,
  clearCache,
  getCacheStats,
  withCache,
} from './cache';
