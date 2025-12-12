/**
 * sql.js Repository for Phage Explorer Web
 *
 * Browser-compatible SQLite adapter using sql.js (SQLite compiled to WebAssembly).
 * Implements the same PhageRepository interface as BunSqliteRepository.
 */

import type { Database, Statement } from 'sql.js';
import type { PhageSummary, PhageFull, GeneInfo, CodonUsageData } from '@phage-explorer/core';
import type { PhageRepository, CacheEntry } from './types';
import { CHUNK_SIZE, CACHE_TTL } from './types';

/**
 * Safely parse JSON with fallback default value
 * Prevents crashes from corrupted database JSON fields
 */
function safeJsonParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    console.warn('Failed to parse JSON from database:', json.substring(0, 100));
    return fallback;
  }
}

/**
 * Prepared statement pool for common queries
 */
interface PreparedStatements {
  listPhages: Statement;
  getPhageById: Statement;
  getPhageBySlug: Statement;
  getGenes: Statement;
  getCodonUsage: Statement;
  getSequenceChunks: Statement;
  hasModel: Statement;
  getModelFrames: Statement;
  searchPhages: Statement;
  getPreference: Statement;
}

/**
 * sql.js based PhageRepository implementation
 */
export class SqlJsRepository implements PhageRepository {
  private db: Database;
  private statements: PreparedStatements | null = null;
  private cache: Map<string, CacheEntry<unknown>> = new Map();
  private phageList: PhageSummary[] | null = null;
  private biasCache: Map<number, number[]> = new Map();
  private codonCache: Map<number, number[]> = new Map();

  constructor(db: Database) {
    this.db = db;
    this.initPreparedStatements();
  }

  /**
   * Initialize prepared statements for common queries
   */
  private initPreparedStatements(): void {
    this.statements = {
      listPhages: this.db.prepare(`
        SELECT id, slug, name, accession, family, host, genome_length as genomeLength,
               gc_content as gcContent, morphology, lifecycle
        FROM phages
        ORDER BY id ASC
      `),

      getPhageById: this.db.prepare(`
        SELECT id, slug, name, accession, family, host, genome_length as genomeLength,
               gc_content as gcContent, morphology, lifecycle, description,
               baltimore_group as baltimoreGroup, genome_type as genomeType, pdb_ids as pdbIds
        FROM phages
        WHERE id = ?
        LIMIT 1
      `),

      getPhageBySlug: this.db.prepare(`
        SELECT id FROM phages WHERE slug = ? LIMIT 1
      `),

      getGenes: this.db.prepare(`
        SELECT id, name, locus_tag as locusTag, start_pos as startPos, end_pos as endPos,
               strand, product, type
        FROM genes
        WHERE phage_id = ?
        ORDER BY start_pos ASC
      `),

      getCodonUsage: this.db.prepare(`
        SELECT aa_counts as aaCounts, codon_counts as codonCounts
        FROM codon_usage
        WHERE phage_id = ?
        LIMIT 1
      `),

      getSequenceChunks: this.db.prepare(`
        SELECT chunk_index as chunkIndex, sequence
        FROM sequences
        WHERE phage_id = ? AND chunk_index >= ? AND chunk_index <= ?
        ORDER BY chunk_index ASC
      `),

      hasModel: this.db.prepare(`
        SELECT id FROM models WHERE phage_id = ? LIMIT 1
      `),

      getModelFrames: this.db.prepare(`
        SELECT ascii_frames as asciiFrames FROM models WHERE phage_id = ? LIMIT 1
      `),

      searchPhages: this.db.prepare(`
        SELECT id, slug, name, accession, family, host, genome_length as genomeLength,
               gc_content as gcContent, morphology, lifecycle
        FROM phages
        WHERE name LIKE ? OR host LIKE ? OR family LIKE ? OR accession LIKE ? OR slug LIKE ?
        ORDER BY name ASC
        LIMIT 20
      `),

      getPreference: this.db.prepare(`
        SELECT value FROM preferences WHERE key = ? LIMIT 1
      `),
    };
  }

  /**
   * Execute a prepared statement and return results
   */
  private execStatement<T>(stmt: Statement, params: unknown[] = []): T[] {
    stmt.bind(params);
    const results: T[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as T);
    }
    stmt.reset();
    return results;
  }

  async listPhages(): Promise<PhageSummary[]> {
    if (this.phageList) {
      return this.phageList;
    }

    if (!this.statements) {
      throw new Error('Database not initialized');
    }

    this.phageList = this.execStatement<PhageSummary>(this.statements.listPhages);
    return this.phageList;
  }

  async getPhageByIndex(index: number): Promise<PhageFull | null> {
    const list = await this.listPhages();
    if (index < 0 || index >= list.length) {
      return null;
    }
    return this.getPhageById(list[index].id);
  }

  async getPhageById(id: number): Promise<PhageFull | null> {
    const cacheKey = `phage:${id}`;
    const cached = this.cache.get(cacheKey) as CacheEntry<PhageFull> | undefined;
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }

    if (!this.statements) {
      throw new Error('Database not initialized');
    }

    const results = this.execStatement<{
      id: number;
      slug: string;
      name: string;
      accession: string;
      family: string | null;
      host: string | null;
      genomeLength: number;
      gcContent: number | null;
      morphology: string | null;
      lifecycle: string | null;
      description: string | null;
      baltimoreGroup: string | null;
      genomeType: string | null;
      pdbIds: string | null;
    }>(this.statements.getPhageById, [id]);

    if (results.length === 0) {
      return null;
    }

    const phage = results[0];
    const geneList = await this.getGenes(id);
    const usage = await this.getCodonUsage(id);
    const hasModelFlag = await this.hasModel(id);

    const fullPhage: PhageFull = {
      id: phage.id,
      slug: phage.slug,
      name: phage.name,
      accession: phage.accession,
      family: phage.family,
      host: phage.host,
      genomeLength: phage.genomeLength,
      gcContent: phage.gcContent,
      morphology: phage.morphology,
      lifecycle: phage.lifecycle,
      description: phage.description,
      baltimoreGroup: phage.baltimoreGroup,
      genomeType: phage.genomeType,
      pdbIds: safeJsonParse<string[]>(phage.pdbIds, []),
      genes: geneList,
      codonUsage: usage,
      hasModel: hasModelFlag,
    };

    this.cache.set(cacheKey, { data: fullPhage, timestamp: Date.now() });
    return fullPhage;
  }

  async getPhageBySlug(slug: string): Promise<PhageFull | null> {
    if (!this.statements) {
      throw new Error('Database not initialized');
    }

    const results = this.execStatement<{ id: number }>(
      this.statements.getPhageBySlug,
      [slug]
    );

    if (results.length === 0) {
      return null;
    }

    return this.getPhageById(results[0].id);
  }

  async getSequenceWindow(phageId: number, start: number, end: number): Promise<string> {
    if (!this.statements) {
      throw new Error('Database not initialized');
    }

    const startChunk = Math.floor(start / CHUNK_SIZE);
    const endChunk = Math.floor(end / CHUNK_SIZE);

    const results = this.execStatement<{ chunkIndex: number; sequence: string }>(
      this.statements.getSequenceChunks,
      [phageId, startChunk, endChunk]
    );

    if (results.length === 0) {
      return '';
    }

    let fullSeq = '';
    for (const chunk of results) {
      fullSeq += chunk.sequence;
    }

    const windowStart = start - startChunk * CHUNK_SIZE;
    const windowEnd = windowStart + (end - start);

    return fullSeq.substring(windowStart, windowEnd);
  }

  async getFullGenomeLength(phageId: number): Promise<number> {
    const stmt = this.db.prepare('SELECT genome_length FROM phages WHERE id = ? LIMIT 1');
    const results = this.execStatement<{ genome_length: number }>(stmt, [phageId]);
    stmt.free();
    return results[0]?.genome_length ?? 0;
  }

  async getGenes(phageId: number): Promise<GeneInfo[]> {
    const cacheKey = `genes:${phageId}`;
    const cached = this.cache.get(cacheKey) as CacheEntry<GeneInfo[]> | undefined;
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }

    if (!this.statements) {
      throw new Error('Database not initialized');
    }

    const results = this.execStatement<GeneInfo>(this.statements.getGenes, [phageId]);
    this.cache.set(cacheKey, { data: results, timestamp: Date.now() });
    return results;
  }

  async getCodonUsage(phageId: number): Promise<CodonUsageData | null> {
    if (!this.statements) {
      throw new Error('Database not initialized');
    }

    const results = this.execStatement<{ aaCounts: string; codonCounts: string }>(
      this.statements.getCodonUsage,
      [phageId]
    );

    if (results.length === 0) {
      return null;
    }

    return {
      aaCounts: safeJsonParse<Record<string, number>>(results[0].aaCounts, {}),
      codonCounts: safeJsonParse<Record<string, number>>(results[0].codonCounts, {}),
    };
  }

  async hasModel(phageId: number): Promise<boolean> {
    if (!this.statements) {
      throw new Error('Database not initialized');
    }

    const results = this.execStatement<{ id: number }>(
      this.statements.hasModel,
      [phageId]
    );

    return results.length > 0;
  }

  async getModelFrames(phageId: number): Promise<string[] | null> {
    if (!this.statements) {
      throw new Error('Database not initialized');
    }

    const results = this.execStatement<{ asciiFrames: string | null }>(
      this.statements.getModelFrames,
      [phageId]
    );

    if (results.length === 0 || !results[0].asciiFrames) {
      return null;
    }

    return safeJsonParse<string[]>(results[0].asciiFrames, []);
  }

  async prefetchAround(index: number, radius: number): Promise<void> {
    const list = await this.listPhages();
    const start = Math.max(0, index - radius);
    const end = Math.min(list.length - 1, index + radius);

    for (let i = start; i <= end; i++) {
      if (i !== index) {
        void this.getPhageById(list[i].id);
      }
    }
  }

  async searchPhages(query: string): Promise<PhageSummary[]> {
    if (!this.statements) {
      throw new Error('Database not initialized');
    }

    const searchTerm = `%${query.toLowerCase()}%`;
    return this.execStatement<PhageSummary>(
      this.statements.searchPhages,
      [searchTerm, searchTerm, searchTerm, searchTerm, searchTerm]
    );
  }

  async getPreference(key: string): Promise<string | null> {
    if (!this.statements) {
      throw new Error('Database not initialized');
    }

    const results = this.execStatement<{ value: string }>(
      this.statements.getPreference,
      [key]
    );

    return results[0]?.value ?? null;
  }

  async setPreference(): Promise<void> {
    // Note: sql.js databases are typically read-only in browser
    // Preferences should be stored in localStorage instead
    console.warn('setPreference not supported in browser mode - use localStorage');
  }

  async getBiasVector(phageId: number): Promise<number[] | null> {
    return this.biasCache.get(phageId) ?? null;
  }

  async setBiasVector(phageId: number, vector: number[]): Promise<void> {
    this.biasCache.set(phageId, vector);
  }

  async getCodonVector(phageId: number): Promise<number[] | null> {
    return this.codonCache.get(phageId) ?? null;
  }

  async setCodonVector(phageId: number, vector: number[]): Promise<void> {
    this.codonCache.set(phageId, vector);
  }

  async close(): Promise<void> {
    // Free prepared statements
    if (this.statements) {
      Object.values(this.statements).forEach((stmt) => stmt.free());
      this.statements = null;
    }

    // Close database
    this.db.close();
    this.cache.clear();
    this.phageList = null;
    this.biasCache.clear();
    this.codonCache.clear();
  }

  /**
   * Get the underlying sql.js database (for advanced operations)
   */
  getDatabase(): Database {
    return this.db;
  }
}

export default SqlJsRepository;
