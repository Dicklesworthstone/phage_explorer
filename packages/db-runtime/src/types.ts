import type { PhageSummary, PhageFull, GeneInfo, CodonUsageData, FoldEmbedding, LatentSpacePoint } from '@phage-explorer/core';

// Repository interface for database operations
export interface PhageRepository {
  // List all phages (summary only)
  listPhages(): Promise<PhageSummary[]>;

  // Get full phage data by index (position in list)
  getPhageByIndex(index: number): Promise<PhageFull | null>;

  // Get full phage data by ID
  getPhageById(id: number): Promise<PhageFull | null>;

  // Get full phage data by slug
  getPhageBySlug(slug: string): Promise<PhageFull | null>;

  // Get a window of sequence data
  getSequenceWindow(phageId: number, start: number, end: number): Promise<string>;

  // Get full genome length
  getFullGenomeLength(phageId: number): Promise<number>;

  // Get genes for a phage
  getGenes(phageId: number): Promise<GeneInfo[]>;

  // Get codon usage
  getCodonUsage(phageId: number): Promise<CodonUsageData | null>;

  // Check if phage has 3D model
  hasModel(phageId: number): Promise<boolean>;

  // Get 3D model ASCII frames (if pre-rendered)
  getModelFrames(phageId: number): Promise<string[] | null>;

  // Prefetch phages around current index
  prefetchAround(index: number, radius: number): Promise<void>;

  // Search phages by name, host, family, or accession
  searchPhages(query: string): Promise<PhageSummary[]>;

  // Get/set preferences
  getPreference(key: string): Promise<string | null>;
  setPreference(key: string, value: string): Promise<void>;

  // Bias/codon cache (optional)
  getBiasVector?(phageId: number): Promise<number[] | null>;
  setBiasVector?(phageId: number, vector: number[]): Promise<void>;
  getCodonVector?(phageId: number): Promise<number[] | null>;
  setCodonVector?(phageId: number, vector: number[]): Promise<void>;

  // Optional embeddings for FoldQuickview
  getFoldEmbeddings?(phageId: number, model?: string): Promise<FoldEmbedding[]>;

  // Pan-Phage Latent Space Atlas (UMAP + HDBSCAN on ESM-2 embeddings)
  getLatentSpaceAtlas?(options?: { phageId?: number; model?: string }): Promise<LatentSpacePoint[]>;

  // Close database connection
  close(): Promise<void>;
}

// Cache entry for prefetched data
export interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

// Sequence chunk size (10kb)
export const CHUNK_SIZE = 10000;

export interface TropismPrediction {
  phageId: number;
  geneId: number | null;
  locusTag: string | null;
  receptor: string;
  confidence: number;
  evidence: string[];
  source: string;
}

export interface TropismRepository {
  getTropismPredictions(phageId: number): Promise<TropismPrediction[]>;
}
