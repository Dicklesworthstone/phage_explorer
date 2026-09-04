/**
 * sql.js Repository for Phage Explorer Web
 *
 * Browser-compatible SQLite adapter using sql.js (SQLite compiled to WebAssembly).
 * Implements the same PhageRepository interface as BunSqliteRepository.
 */

import type { Database, Statement } from 'sql.js';
import { decodeFloat32VectorLE, type PhageSummary, type PhageFull, type GeneInfo, type CodonUsageData, type FoldEmbedding, type LatentSpacePoint } from '@phage-explorer/core';
import type { TropismPrediction } from '@phage-explorer/db-runtime';
import type {
  PhageRepository,
  CacheEntry,
  ProteinDomain,
  AmgAnnotation,
  DefenseSystem,
  HostTrnaPool,
  CodonAdaptation,
} from './types';
import { CHUNK_SIZE, CACHE_TTL } from './types';
import { LRUCache } from './lru-cache';

/**
 * Safely parse JSON with fallback default value
 * Prevents crashes from corrupted database JSON fields
 */
function safeJsonParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    if (import.meta.env.DEV) {
      console.warn('Failed to parse JSON from database:', json.substring(0, 100));
    }
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
  getFullGenomeLength: Statement;
  getTropismPredictions?: Statement;
  // Optional statements - may not exist if tables are missing
  getProteinDomains?: Statement;
  getAmgAnnotations?: Statement;
  getDefenseSystems?: Statement;
  getHostTrnaPoolsByName?: Statement;
  getHostTrnaPoolsAll?: Statement;
  getCodonAdaptationByHost?: Statement;
  getCodonAdaptationAll?: Statement;
  getFoldEmbeddings?: Statement;
  getLatentSpaceAtlas?: Statement;
  getLatentSpaceAtlasByPhage?: Statement;
}

/**
 * sql.js based PhageRepository implementation
 */
export class SqlJsRepository implements PhageRepository {
  private db: Database;
  private statements: PreparedStatements | null = null;
  // LRU cache with bounded size to prevent unbounded memory growth
  private cache = new LRUCache<string, CacheEntry<unknown>>(100);
  private phageList: PhageSummary[] | null = null;
  // Use LRU caches with bounded size to prevent unbounded memory growth
  private biasCache = new LRUCache<number, number[]>(50);
  private codonCache = new LRUCache<number, number[]>(50);

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
        WHERE name LIKE ? ESCAPE '\\' 
           OR host LIKE ? ESCAPE '\\' 
           OR family LIKE ? ESCAPE '\\' 
           OR accession LIKE ? ESCAPE '\\' 
           OR slug LIKE ? ESCAPE '\\'
        ORDER BY name ASC
        LIMIT 20
      `),

      getPreference: this.db.prepare(`
        SELECT value FROM preferences WHERE key = ? LIMIT 1
      `),

      getFullGenomeLength: this.db.prepare(`
        SELECT genome_length FROM phages WHERE id = ? LIMIT 1
      `),
    };

    // Prepare optional statements for tables that may not exist
    // These return undefined if the table doesn't exist
    this.statements.getProteinDomains = this.safelyPrepare(`
      SELECT id, phage_id as phageId, gene_id as geneId, locus_tag as locusTag,
             domain_id as domainId, domain_name as domainName, domain_type as domainType,
             start, end, score, e_value as eValue, description
      FROM protein_domains
      WHERE phage_id = ?
      ORDER BY start ASC
    `);

    this.statements.getAmgAnnotations = this.safelyPrepare(`
      SELECT id, phage_id as phageId, gene_id as geneId, locus_tag as locusTag,
             amg_type as amgType, kegg_ortholog as keggOrtholog, kegg_reaction as keggReaction,
             kegg_pathway as keggPathway, pathway_name as pathwayName, confidence, evidence
      FROM amg_annotations
      WHERE phage_id = ?
      ORDER BY id ASC
    `);

    this.statements.getDefenseSystems = this.safelyPrepare(`
      SELECT id, phage_id as phageId, gene_id as geneId, locus_tag as locusTag,
             system_type as systemType, system_family as systemFamily,
             target_system as targetSystem, mechanism, confidence, source
      FROM defense_systems
      WHERE phage_id = ?
      ORDER BY id ASC
    `);

    this.statements.getHostTrnaPoolsByName = this.safelyPrepare(`
      SELECT id, host_name as hostName, host_tax_id as hostTaxId, anticodon,
             amino_acid as aminoAcid, codon, copy_number as copyNumber,
             relative_abundance as relativeAbundance
      FROM host_trna_pools
      WHERE host_name = ?
      ORDER BY anticodon ASC
    `);

    this.statements.getHostTrnaPoolsAll = this.safelyPrepare(`
      SELECT id, host_name as hostName, host_tax_id as hostTaxId, anticodon,
             amino_acid as aminoAcid, codon, copy_number as copyNumber,
             relative_abundance as relativeAbundance
      FROM host_trna_pools
      ORDER BY host_name, anticodon ASC
    `);

    this.statements.getCodonAdaptationByHost = this.safelyPrepare(`
      SELECT id, phage_id as phageId, host_name as hostName, gene_id as geneId,
             locus_tag as locusTag, cai, tai, cpb, enc_prime as encPrime
      FROM codon_adaptation
      WHERE phage_id = ? AND host_name = ?
      ORDER BY gene_id ASC
    `);

    this.statements.getCodonAdaptationAll = this.safelyPrepare(`
      SELECT id, phage_id as phageId, host_name as hostName, gene_id as geneId,
             locus_tag as locusTag, cai, tai, cpb, enc_prime as encPrime
      FROM codon_adaptation
      WHERE phage_id = ?
      ORDER BY host_name, gene_id ASC
    `);

    this.statements.getFoldEmbeddings = this.safelyPrepare(`
      SELECT fe.gene_id as geneId, fe.dims as dims, fe.vector as vector,
             g.name as name, g.product as product, g.start_pos as startPos, g.end_pos as endPos
      FROM fold_embeddings fe
      JOIN genes g ON g.id = fe.gene_id
      WHERE fe.phage_id = ? AND fe.model = ?
      ORDER BY fe.gene_id ASC
    `);

    this.statements.getTropismPredictions = this.safelyPrepare(`
      SELECT phage_id as phageId, gene_id as geneId, locus_tag as locusTag,
             receptor, confidence, evidence, source
      FROM tropism_predictions
      WHERE phage_id = ?
      ORDER BY confidence DESC
    `);

    this.statements.getLatentSpaceAtlas = this.safelyPrepare(`
      SELECT c.id, c.phage_id as phageId, p.name as phageName, c.gene_id as geneId,
             g.name as geneName, g.locus_tag as locusTag, g.product as product,
             c.model, c.x, c.y, c.cluster_id as clusterId, c.outlier_score as outlierScore
      FROM fold_embedding_coords c
      JOIN phages p ON p.id = c.phage_id
      JOIN genes g ON g.id = c.gene_id
      WHERE c.model = ?
      ORDER BY c.cluster_id ASC, c.outlier_score DESC
    `);

    this.statements.getLatentSpaceAtlasByPhage = this.safelyPrepare(`
      SELECT c.id, c.phage_id as phageId, p.name as phageName, c.gene_id as geneId,
             g.name as geneName, g.locus_tag as locusTag, g.product as product,
             c.model, c.x, c.y, c.cluster_id as clusterId, c.outlier_score as outlierScore
      FROM fold_embedding_coords c
      JOIN phages p ON p.id = c.phage_id
      JOIN genes g ON g.id = c.gene_id
      WHERE c.phage_id = ? AND c.model = ?
      ORDER BY c.cluster_id ASC, c.outlier_score DESC
    `);
  }

  /**
   * Safely prepare a statement, returning undefined if the table doesn't exist
   */
  private safelyPrepare(sql: string): Statement | undefined {
    try {
      return this.db.prepare(sql);
    } catch {
      // Table likely doesn't exist
      return undefined;
    }
  }

  /**
   * Execute a prepared statement and return results.
   * Uses try-finally to ensure statement is always reset even on exceptions.
   */
  private execStatement<T>(stmt: Statement, params: unknown[] = []): T[] {
    try {
      stmt.bind(params);
      const results: T[] = [];
      while (stmt.step()) {
        const row = stmt.getAsObject();
        if (row) {
          results.push(row as T);
        }
      }
      return results;
    } finally {
      stmt.reset();
    }
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

  async getFoldEmbeddings(phageId: number, model = 'protein-k3-hash-v1'): Promise<FoldEmbedding[]> {
    const cacheKey = `foldEmbeddings:${phageId}:${model}`;
    const cached = this.cache.get(cacheKey) as CacheEntry<FoldEmbedding[]> | undefined;
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }

    if (!this.statements) {
      throw new Error('Database not initialized');
    }
    if (!this.statements.getFoldEmbeddings) {
      return [];
    }

    const rows = this.execStatement<{
      geneId: number;
      dims: number;
      vector: Uint8Array;
      name: string | null;
      product: string | null;
      startPos: number;
      endPos: number;
    }>(this.statements.getFoldEmbeddings, [phageId, model]);

    const parsed: FoldEmbedding[] = rows.map((row) => ({
      geneId: row.geneId,
      vector: decodeFloat32VectorLE(row.vector as Uint8Array, row.dims),
      length: Math.max(0, Math.floor((row.endPos - row.startPos) / 3)),
      name: row.name ?? null,
      product: row.product ?? null,
    }));

    this.cache.set(cacheKey, { data: parsed, timestamp: Date.now() });
    return parsed;
  }

  async getLatentSpaceAtlas(options?: { phageId?: number; model?: string }): Promise<LatentSpacePoint[]> {
    const model = options?.model ?? 'facebook/esm2_t6_8M_UR50D';
    const phageId = options?.phageId;
    const cacheKey = `latentSpaceAtlas:${phageId ?? 'all'}:${model}`;
    const cached = this.cache.get(cacheKey) as CacheEntry<LatentSpacePoint[]> | undefined;
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }

    if (!this.statements) {
      throw new Error('Database not initialized');
    }

    let rows: LatentSpacePoint[] = [];
    if (phageId !== undefined && phageId !== null) {
      if (!this.statements.getLatentSpaceAtlasByPhage) return [];
      rows = this.execStatement<LatentSpacePoint>(this.statements.getLatentSpaceAtlasByPhage, [phageId, model]);
    } else {
      if (!this.statements.getLatentSpaceAtlas) return [];
      rows = this.execStatement<LatentSpacePoint>(this.statements.getLatentSpaceAtlas, [model]);
    }

    this.cache.set(cacheKey, { data: rows, timestamp: Date.now() });
    return rows;
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
    const [geneList, usage, hasModelFlag, tropism] = await Promise.all([
      this.getGenes(id),
      this.getCodonUsage(id),
      this.hasModel(id),
      this.getTropismPredictions(id),
    ]);

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
      tropismPredictions: tropism,
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

    // Using join() for O(n) instead of O(n²) concatenation
    const fullSeq = results.map(chunk => chunk.sequence).join('');

    const windowStart = start - startChunk * CHUNK_SIZE;
    const windowEnd = windowStart + (end - start);

    return fullSeq.substring(windowStart, windowEnd);
  }

  async getFullGenomeLength(phageId: number): Promise<number> {
    if (!this.statements) {
      throw new Error('Database not initialized');
    }
    const results = this.execStatement<{ genome_length: number }>(
      this.statements.getFullGenomeLength,
      [phageId]
    );
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
    if (this.statements.getProteinDomains) {
      try {
        const domainRows = this.execStatement<{ geneId: number | null; domainId: string }>(
          this.statements.getProteinDomains,
          [phageId]
        );
        if (domainRows.length > 0) {
          const domainMap = new Map<number, string[]>();
          for (const d of domainRows) {
            if (d.geneId !== null && d.geneId !== undefined) {
              let list = domainMap.get(d.geneId);
              if (!list) {
                list = [];
                domainMap.set(d.geneId, list);
              }
              list.push(d.domainId);
            }
          }
          for (const g of results) {
            const doms = domainMap.get(g.id);
            if (doms && doms.length > 0) {
              g.domains = doms;
            }
          }
        }
      } catch {
        // protein_domains table might not exist in minimal fixtures
      }
    }
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
    if (list.length === 0) return;

    // Build priority rings: immediately adjacent first, then expanding outward
    // This ensures faster perceived navigation (adjacent phages ready first)
    const priorityRings: number[][] = [];

    for (let distance = 1; distance <= radius; distance++) {
      const ring: number[] = [];
      const prev = index - distance;
      const next = index + distance;

      // Add previous and next at this distance (if valid)
      if (prev >= 0) ring.push(prev);
      if (next < list.length) ring.push(next);

      if (ring.length > 0) {
        priorityRings.push(ring);
      }
    }

    // Process each ring in order - await each ring before starting the next
    // This ensures adjacent phages are loaded before more distant ones
    for (const ring of priorityRings) {
      await Promise.all(
        ring.map(i => this.getPhageById(list[i].id))
      );
    }
  }

  async searchPhages(query: string): Promise<PhageSummary[]> {
    if (!this.statements) {
      throw new Error('Database not initialized');
    }

    // Escape wildcard characters
    const escaped = query.replace(/[\\%_]/g, '\\$&');
    const searchTerm = `%${escaped.toLowerCase()}%`;
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
    if (import.meta.env.DEV) {
      console.warn('setPreference not supported in browser mode - use localStorage');
    }
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

  /**
   * Read one row of `annotation_meta` and parse its JSON value.
   *
   * Returns null when the table or key is absent, which is the case for a
   * database built before an annotation set existed. Callers must handle that
   * rather than falling back to a hardcoded tool name -- doing exactly that is
   * how the protein-domain overlay ended up crediting InterProScan for PyHMMER
   * scans against Pfam-A.
   */
  async getAnnotationMeta(key: string): Promise<Record<string, unknown> | null> {
    const cacheKey = `annmeta:${key}`;
    const cached = this.cache.get(cacheKey) as
      | CacheEntry<Record<string, unknown> | null>
      | undefined;
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }

    let parsed: Record<string, unknown> | null = null;
    try {
      const stmt = this.db.prepare(
        'SELECT value FROM annotation_meta WHERE key = ? LIMIT 1'
      );
      stmt.bind([key]);
      if (stmt.step()) {
        const row = stmt.getAsObject() as { value?: string };
        if (typeof row.value === 'string') {
          parsed = JSON.parse(row.value) as Record<string, unknown>;
        }
      }
      stmt.free();
    } catch {
      // Missing table on an older database, or a value that is not JSON.
      parsed = null;
    }

    this.cache.set(cacheKey, { data: parsed, timestamp: Date.now() });
    return parsed;
  }

  /**
   * Get protein domain annotations for a phage
   */
  async getProteinDomains(phageId: number): Promise<ProteinDomain[]> {
    const cacheKey = `domains:${phageId}`;
    const cached = this.cache.get(cacheKey) as CacheEntry<ProteinDomain[]> | undefined;
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }

    // Use pre-prepared statement if available (table exists)
    if (!this.statements?.getProteinDomains) {
      return [];
    }

    const results = this.execStatement<ProteinDomain>(
      this.statements.getProteinDomains,
      [phageId]
    );
    this.cache.set(cacheKey, { data: results, timestamp: Date.now() });
    return results;
  }

  /**
   * Get AMG annotations for a phage
   */
  async getAmgAnnotations(phageId: number): Promise<AmgAnnotation[]> {
    const cacheKey = `amgs:${phageId}`;
    const cached = this.cache.get(cacheKey) as CacheEntry<AmgAnnotation[]> | undefined;
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }

    // Use pre-prepared statement if available (table exists)
    if (!this.statements?.getAmgAnnotations) {
      return [];
    }

    const results = this.execStatement<AmgAnnotation>(
      this.statements.getAmgAnnotations,
      [phageId]
    );
    this.cache.set(cacheKey, { data: results, timestamp: Date.now() });
    return results;
  }

  /**
   * Get defense system annotations for a phage
   */
  async getDefenseSystems(phageId: number): Promise<DefenseSystem[]> {
    const cacheKey = `defense:${phageId}`;
    const cached = this.cache.get(cacheKey) as CacheEntry<DefenseSystem[]> | undefined;
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }

    // Use pre-prepared statement if available (table exists)
    if (!this.statements?.getDefenseSystems) {
      return [];
    }

    const results = this.execStatement<DefenseSystem>(
      this.statements.getDefenseSystems,
      [phageId]
    );
    this.cache.set(cacheKey, { data: results, timestamp: Date.now() });
    return results;
  }

  /**
   * Get host tRNA pools (optionally filtered by host name)
   */
  async getHostTrnaPools(hostName?: string): Promise<HostTrnaPool[]> {
    const cacheKey = `trna:${hostName ?? 'all'}`;
    const cached = this.cache.get(cacheKey) as CacheEntry<HostTrnaPool[]> | undefined;
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }

    // Use pre-prepared statements if available (table exists)
    let results: HostTrnaPool[];
    if (hostName) {
      if (!this.statements?.getHostTrnaPoolsByName) {
        return [];
      }
      results = this.execStatement<HostTrnaPool>(
        this.statements.getHostTrnaPoolsByName,
        [hostName]
      );
    } else {
      if (!this.statements?.getHostTrnaPoolsAll) {
        return [];
      }
      results = this.execStatement<HostTrnaPool>(
        this.statements.getHostTrnaPoolsAll,
        []
      );
    }

    this.cache.set(cacheKey, { data: results, timestamp: Date.now() });
    return results;
  }

  /**
   * Get codon adaptation scores for a phage (optionally filtered by host)
   */
  async getCodonAdaptation(phageId: number, hostName?: string): Promise<CodonAdaptation[]> {
    const cacheKey = `adaptation:${phageId}:${hostName ?? 'all'}`;
    const cached = this.cache.get(cacheKey) as CacheEntry<CodonAdaptation[]> | undefined;
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }

    // Use pre-prepared statements if available (table exists)
    let results: CodonAdaptation[];
    if (hostName) {
      if (!this.statements?.getCodonAdaptationByHost) {
        return [];
      }
      results = this.execStatement<CodonAdaptation>(
        this.statements.getCodonAdaptationByHost,
        [phageId, hostName]
      );
    } else {
      if (!this.statements?.getCodonAdaptationAll) {
        return [];
      }
      results = this.execStatement<CodonAdaptation>(
        this.statements.getCodonAdaptationAll,
        [phageId]
      );
    }

    this.cache.set(cacheKey, { data: results, timestamp: Date.now() });
    return results;
  }

  async getTropismPredictions(phageId: number): Promise<TropismPrediction[]> {
    const cacheKey = `tropism:${phageId}`;
    const cached = this.cache.get(cacheKey) as CacheEntry<TropismPrediction[]> | undefined;
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }

    if (!this.statements) {
      throw new Error('Database not initialized');
    }

    if (!this.statements.getTropismPredictions) {
      return [];
    }

    const rows = this.execStatement<{
      phageId: number;
      geneId: number | null;
      locusTag: string | null;
      receptor: string;
      confidence: number;
      evidence: string | null;
      source: string;
    }>(this.statements.getTropismPredictions, [phageId]);

    const parsed = rows.map(r => ({
      ...r,
      evidence: safeJsonParse<string[]>(r.evidence, []),
    }));

    this.cache.set(cacheKey, { data: parsed, timestamp: Date.now() });
    return parsed;
  }

  async close(): Promise<void> {
    // Free prepared statements (some may be undefined for missing tables)
    if (this.statements) {
      Object.values(this.statements).forEach((stmt) => stmt?.free());
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
