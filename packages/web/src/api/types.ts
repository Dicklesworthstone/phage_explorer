/**
 * API Types for External Data Sources
 * Used by EnvironmentalProvenanceOverlay and PhylodynamicsOverlay
 */

// ============================================================================
// Serratus API Types (for Environmental Provenance)
// ============================================================================

/** Serratus sequence match result */
export interface SerratusSequenceMatch {
  run_id: string;           // SRA run accession (e.g., "SRR1234567")
  score: number;            // Match score (0-100)
  percent_identity: number; // Sequence identity percentage
  family: string;           // Viral family assignment
  coverage: number;         // Genome coverage percentage
}

/** Serratus API response for sequence searches */
export interface SerratusSearchResponse {
  matches: SerratusSequenceMatch[];
  total: number;
  query_sequence: string;
}

// ============================================================================
// SRA Metadata Types (for Geographic Data)
// ============================================================================

/** SRA run metadata with geographic information */
export interface SRARunMetadata {
  run_id: string;
  biosample: string;
  bioproject: string;
  organism: string;
  collection_date?: string;
  geo_loc_name?: string;      // Geographic location string
  latitude?: number;
  longitude?: number;
  isolation_source?: string;  // Environment type (e.g., "soil", "wastewater")
  host?: string;
  library_strategy?: string;
  platform?: string;
}

/** Processed environmental provenance data for overlay */
export interface EnvironmentalProvenanceData {
  locations: Array<{
    name: string;
    latitude: number;
    longitude: number;
    sampleCount: number;
    isolationSources: string[];
    /**
     * The real SRA run accessions behind this location (SRR/ERR/DRR).
     *
     * Carried through so the overlay can identify a hit by something a user can
     * actually look up. It previously minted `SRA-1`, `SRA-2` and so on, which
     * read like accessions and resolve to nothing.
     */
    runIds: string[];
    dateRange?: { earliest: string; latest: string };
  }>;
  isolationSourceBreakdown: Record<string, number>;
  totalSamples: number;
  dateRange?: { earliest: string; latest: string };
}

// ============================================================================
// NCBI Entrez API Types (for Phylodynamics)
// ============================================================================

/** NCBI nucleotide sequence record */
export interface NCBISequenceRecord {
  accession: string;
  title: string;
  organism: string;
  collection_date?: string;
  country?: string;
  host?: string;
  isolation_source?: string;
  sequence_length: number;
  create_date: string;
  update_date: string;
}

/** NCBI ESearch response */
export interface NCBIESearchResult {
  count: number;
  retmax: number;
  retstart: number;
  ids: string[];
  query_translation?: string;
}

/** NCBI ESummary document */
export interface NCBIESummaryDoc {
  uid: string;
  caption: string;
  title: string;
  extra: string;
  gi: number;
  createdate: string;
  updatedate: string;
  flags: number;
  taxid: number;
  slen: number;
  biomol: string;
  moltype: string;
  topology: string;
  sourcedb: string;
  segsetsize: string;
  projectid: string;
  genome: string;
  subtype: string;
  subname: string;
  assemblygi: string;
  assemblyacc: string;
  tech: string;
  completeness: string;
  geneticcode: string;
  strand: string;
  organism: string;
  strain: string;
}

/** Processed phylodynamics data for overlay */
export interface PhylodynamicsData {
  sequences: Array<{
    accession: string;
    organism: string;
    collectionDate: Date;
    country?: string;
    host?: string;
    sequenceLength: number;
  }>;
  timeRange: { earliest: Date; latest: Date };
  countryBreakdown: Record<string, number>;
  hostBreakdown: Record<string, number>;
  temporalCoverage: Array<{ date: Date; count: number }>;
}

// ============================================================================
// API Error Types
// ============================================================================

export interface APIError {
  code: string;
  message: string;
  details?: unknown;
}

export type APIResult<T> =
  | { success: true; data: T }
  | { success: false; error: APIError };

// ============================================================================
// Cache Types
// ============================================================================

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number; // Time-to-live in milliseconds
}

export interface CacheConfig {
  defaultTTL: number;
  maxEntries: number;
  storage: 'localStorage' | 'sessionStorage' | 'memory';
}
