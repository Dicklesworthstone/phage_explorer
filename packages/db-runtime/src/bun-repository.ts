import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { eq, or, asc, desc, and, gte, lte, sql } from 'drizzle-orm';
import {
  phages,
  sequences,
  genes,
  codonUsage,
  models,
  preferences,
  tropismPredictions,
  foldEmbeddings,
  proteinDomains,
} from '@phage-explorer/db-schema';
import { decodeFloat32VectorLE, type PhageSummary, type PhageFull, type GeneInfo, type CodonUsageData, type FoldEmbedding } from '@phage-explorer/core';
import type { PhageRepository, CacheEntry, TropismPrediction } from './types';
import { CHUNK_SIZE } from './types';
import { LRUCache } from './lru-cache';
import { readFileSync, existsSync } from 'fs';

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const isNumberRecord = (value: unknown): value is Record<string, number> =>
  typeof value === 'object' && value !== null &&
  Object.values(value).every((item) => typeof item === 'number');

/**
 * Safely parse JSON with fallback default value
 * Prevents crashes from corrupted database JSON fields
 */
function safeJsonParse<T>(json: string | null | undefined, fallback: T, validate?: (value: unknown) => value is T): T {
  if (!json) return fallback;
  try {
    const parsed = JSON.parse(json);
    if (validate && !validate(parsed)) {
      console.warn('Unexpected JSON shape from database:', json.substring(0, 100));
      return fallback;
    }
    return parsed as T;
  } catch {
    console.warn('Failed to parse JSON from database:', json.substring(0, 100));
    return fallback;
  }
}

export class BunSqliteRepository implements PhageRepository {
  private sqlite: Database;
  private db: ReturnType<typeof drizzle>;
  private readonly: boolean;
  // LRU cache with bounded size to prevent unbounded memory growth
  private cache = new LRUCache<string, CacheEntry<unknown>>(100);
  private phageList: PhageSummary[] | null = null;
  private cachePath: string;
  private biasCache: Map<number, number[]> = new Map();
  private codonCache: Map<number, number[]> = new Map();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dbPath: string) {
    let opened: Database | null = null;
    let readonly = false;
    try {
      // Prefer read/write so preferences can persist when allowed
      opened = new Database(dbPath);
    } catch {
      // Fallback to readonly if filesystem is locked (e.g., packaged binary)
      opened = new Database(dbPath, { readonly: true });
      readonly = true;
    }
    this.sqlite = opened;
    this.readonly = readonly;
    this.db = drizzle(this.sqlite);
    this.cachePath = `${dbPath}.cache.json`;
    this.loadVectorCache();
  }

  private loadVectorCache(): void {
    if (!existsSync(this.cachePath)) return;
    try {
      const raw = readFileSync(this.cachePath, 'utf8');
      const parsed = JSON.parse(raw) as { bias?: Record<string, number[]>; codon?: Record<string, number[]> };
      if (parsed.bias) {
        for (const [k, v] of Object.entries(parsed.bias)) {
          this.biasCache.set(Number(k), v);
        }
      }
      if (parsed.codon) {
        for (const [k, v] of Object.entries(parsed.codon)) {
          this.codonCache.set(Number(k), v);
        }
      }
    } catch {
      // Ignore malformed cache
    }
  }

  private async saveVectorCache(): Promise<void> {
    try {
      const bias: Record<string, number[]> = {};
      const codon: Record<string, number[]> = {};
      for (const [k, v] of this.biasCache.entries()) bias[k.toString()] = v;
      for (const [k, v] of this.codonCache.entries()) codon[k.toString()] = v;
      
      const data = JSON.stringify({ bias, codon });
      
      // Use Bun.write for performance if available
      if (typeof Bun !== 'undefined') {
        await Bun.write(this.cachePath, data);
      } else {
        const { writeFile } = await import('fs/promises');
        await writeFile(this.cachePath, data);
      }
    } catch {
      // best effort; ignore write failures
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveVectorCache();
    }, 1000);
  }

  async listPhages(): Promise<PhageSummary[]> {
    if (this.phageList) {
      return this.phageList;
    }

    const result = await this.db
      .select({
        id: phages.id,
        slug: phages.slug,
        name: phages.name,
        accession: phages.accession,
        family: phages.family,
        host: phages.host,
        genomeLength: phages.genomeLength,
        gcContent: phages.gcContent,
        morphology: phages.morphology,
        lifecycle: phages.lifecycle,
      })
      .from(phages)
      .orderBy(asc(phages.id)); // Preserve catalog order (Lambda first)

    this.phageList = result;
    return result;
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
    if (cached && Date.now() - cached.timestamp < 60000) {
      return cached.data;
    }

    const result = await this.db
      .select()
      .from(phages)
      .where(eq(phages.id, id))
      .limit(1);

    if (result.length === 0) {
      return null;
    }

    const phage = result[0];
    const geneList = await this.getGenes(id);
    const usage = await this.getCodonUsage(id);
    const hasModel = await this.hasModel(id);
    const tropism = await this.getTropismPredictions(id);

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
      pdbIds: safeJsonParse<string[]>(phage.pdbIds, [], isStringArray),
      genes: geneList,
      codonUsage: usage,
      hasModel,
      tropismPredictions: tropism,
    };

    this.cache.set(cacheKey, { data: fullPhage, timestamp: Date.now() });
    return fullPhage;
  }

  async getPhageBySlug(slug: string): Promise<PhageFull | null> {
    const result = await this.db
      .select({ id: phages.id })
      .from(phages)
      .where(eq(phages.slug, slug))
      .limit(1);

    if (result.length === 0) {
      return null;
    }

    return this.getPhageById(result[0].id);
  }

  async getSequenceWindow(phageId: number, start: number, end: number): Promise<string> {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
      return '';
    }
    // Calculate which chunks we need
    const startChunk = Math.floor(start / CHUNK_SIZE);
    const endChunk = Math.floor(end / CHUNK_SIZE);

    const result = await this.db
      .select({
        chunkIndex: sequences.chunkIndex,
        sequence: sequences.sequence,
      })
      .from(sequences)
      .where(
        and(
          eq(sequences.phageId, phageId),
          gte(sequences.chunkIndex, startChunk),
          lte(sequences.chunkIndex, endChunk)
        )
      )
      .orderBy(asc(sequences.chunkIndex));

    if (result.length === 0) {
      return '';
    }

    // Concatenate chunks - using join() for O(n) instead of O(n²) concatenation
    const fullSeq = result.map(chunk => chunk.sequence).join('');

    // Extract the requested window
    const windowStart = start - startChunk * CHUNK_SIZE;
    const windowEnd = windowStart + (end - start);

    return fullSeq.substring(windowStart, windowEnd);
  }

  async getFullGenomeLength(phageId: number): Promise<number> {
    const result = await this.db
      .select({ genomeLength: phages.genomeLength })
      .from(phages)
      .where(eq(phages.id, phageId))
      .limit(1);

    return result[0]?.genomeLength ?? 0;
  }

  async getGenes(phageId: number): Promise<GeneInfo[]> {
    const cacheKey = `genes:${phageId}`;
    const cached = this.cache.get(cacheKey) as CacheEntry<GeneInfo[]> | undefined;
    if (cached && Date.now() - cached.timestamp < 60000) {
      return cached.data;
    }

    const result: GeneInfo[] = await this.db
      .select({
        id: genes.id,
        name: genes.name,
        locusTag: genes.locusTag,
        startPos: genes.startPos,
        endPos: genes.endPos,
        strand: genes.strand,
        product: genes.product,
        type: genes.type,
      })
      .from(genes)
      .where(eq(genes.phageId, phageId))
      .orderBy(asc(genes.startPos));

    try {
      const domainRows = await this.db
        .select({
          geneId: proteinDomains.geneId,
          domainId: proteinDomains.domainId,
        })
        .from(proteinDomains)
        .where(eq(proteinDomains.phageId, phageId));

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
        for (const g of result) {
          const doms = domainMap.get(g.id);
          if (doms && doms.length > 0) {
            g.domains = doms;
          }
        }
      }
    } catch {
      // protein_domains table may not exist in minimal test fixtures
    }

    this.cache.set(cacheKey, { data: result, timestamp: Date.now() });
    return result;
  }

  async getCodonUsage(phageId: number): Promise<CodonUsageData | null> {
    const result = await this.db
      .select()
      .from(codonUsage)
      .where(eq(codonUsage.phageId, phageId))
      .limit(1);

    if (result.length === 0) {
      return null;
    }

    return {
      aaCounts: safeJsonParse<Record<string, number>>(result[0].aaCounts, {}, isNumberRecord),
      codonCounts: safeJsonParse<Record<string, number>>(result[0].codonCounts, {}, isNumberRecord),
    };
  }

  async hasModel(phageId: number): Promise<boolean> {
    const result = await this.db
      .select({ id: models.id })
      .from(models)
      .where(eq(models.phageId, phageId))
      .limit(1);

    return result.length > 0;
  }

  async getTropismPredictions(phageId: number): Promise<TropismPrediction[]> {
    const cacheKey = `tropism:${phageId}`;
    const cached = this.cache.get(cacheKey) as CacheEntry<TropismPrediction[]> | undefined;
    if (cached && Date.now() - cached.timestamp < 60000) {
      return cached.data;
    }

    let rows: Array<{
      phageId: number;
      geneId: number | null;
      locusTag: string | null;
      receptor: string;
      confidence: number;
      evidence: string | null;
      source: string;
    }> = [];

    try {
      rows = await this.db
        .select({
          phageId: tropismPredictions.phageId,
          geneId: tropismPredictions.geneId,
          locusTag: tropismPredictions.locusTag,
          receptor: tropismPredictions.receptor,
          confidence: tropismPredictions.confidence,
          evidence: tropismPredictions.evidence,
          source: tropismPredictions.source,
        })
        .from(tropismPredictions)
        .where(eq(tropismPredictions.phageId, phageId))
        .orderBy(desc(tropismPredictions.confidence));
    } catch {
      // Optional table: older phage.db builds may not include tropism_predictions.
      const empty: TropismPrediction[] = [];
      this.cache.set(cacheKey, { data: empty, timestamp: Date.now() });
      return empty;
    }

    const parsed = rows.map(r => ({
      ...r,
      evidence: safeJsonParse<string[]>(r.evidence, [], isStringArray),
    }));

    this.cache.set(cacheKey, { data: parsed, timestamp: Date.now() });
    return parsed;
  }

  async getFoldEmbeddings(phageId: number, model = 'protein-k3-hash-v1'): Promise<FoldEmbedding[]> {
    const cacheKey = `foldEmbeddings:${phageId}:${model}`;
    const cached = this.cache.get(cacheKey) as CacheEntry<FoldEmbedding[]> | undefined;
    if (cached && Date.now() - cached.timestamp < 60000) {
      return cached.data;
    }

    let rows: Array<{
      geneId: number;
      dims: number;
      vector: unknown;
      name: string | null;
      product: string | null;
      startPos: number;
      endPos: number;
    }> = [];

    try {
      rows = await this.db
        .select({
          geneId: foldEmbeddings.geneId,
          dims: foldEmbeddings.dims,
          vector: foldEmbeddings.vector,
          name: genes.name,
          product: genes.product,
          startPos: genes.startPos,
          endPos: genes.endPos,
        })
        .from(foldEmbeddings)
        .innerJoin(genes, eq(foldEmbeddings.geneId, genes.id))
        .where(and(eq(foldEmbeddings.phageId, phageId), eq(foldEmbeddings.model, model)))
        .orderBy(asc(foldEmbeddings.geneId));
    } catch {
      // Optional table: older phage.db builds may not include fold_embeddings.
      const empty: FoldEmbedding[] = [];
      this.cache.set(cacheKey, { data: empty, timestamp: Date.now() });
      return empty;
    }

    const parsed: FoldEmbedding[] = rows.map((row) => ({
      geneId: row.geneId,
      vector: decodeFloat32VectorLE(row.vector as Uint8Array, row.dims),
      length: Math.max(0, Math.floor((row.endPos - row.startPos) / 3)),
      name: row.name,
      product: row.product,
    }));

    this.cache.set(cacheKey, { data: parsed, timestamp: Date.now() });
    return parsed;
  }

  async getModelFrames(phageId: number): Promise<string[] | null> {
    const result = await this.db
      .select({ asciiFrames: models.asciiFrames })
      .from(models)
      .where(eq(models.phageId, phageId))
      .limit(1);

    if (result.length === 0 || !result[0].asciiFrames) {
      return null;
    }

    return safeJsonParse<string[]>(result[0].asciiFrames, [], isStringArray);
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
    // Escape wildcard characters and backslashes (backslash is the ESCAPE character)
    const escaped = query.replace(/[\\%_]/g, '\\$&');
    const searchTerm = `%${escaped.toLowerCase()}%`;

    const result = await this.db
      .select({
        id: phages.id,
        slug: phages.slug,
        name: phages.name,
        accession: phages.accession,
        family: phages.family,
        host: phages.host,
        genomeLength: phages.genomeLength,
        gcContent: phages.gcContent,
        morphology: phages.morphology,
        lifecycle: phages.lifecycle,
      })
      .from(phages)
      .where(
        or(
          sql`${phages.name} LIKE ${searchTerm} ESCAPE '\\'`,
          sql`${phages.host} LIKE ${searchTerm} ESCAPE '\\'`,
          sql`${phages.family} LIKE ${searchTerm} ESCAPE '\\'`,
          sql`${phages.accession} LIKE ${searchTerm} ESCAPE '\\'`,
          sql`${phages.slug} LIKE ${searchTerm} ESCAPE '\\'`
        )
      )
      .orderBy(asc(phages.name))
      .limit(20);

    return result;
  }

  async getPreference(key: string): Promise<string | null> {
    const result = await this.db
      .select({ value: preferences.value })
      .from(preferences)
      .where(eq(preferences.key, key))
      .limit(1);

    return result[0]?.value ?? null;
  }

  async setPreference(key: string, value: string): Promise<void> {
    if (this.readonly) return;
    try {
      await this.db
        .insert(preferences)
        .values({ key, value })
        .onConflictDoUpdate({
          target: preferences.key,
          set: { value },
        });
    } catch {
      // If the DB is effectively readonly (e.g., permissions), ignore quietly
    }
  }

  async close(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.saveVectorCache();
    }
    this.sqlite.close();
    this.cache.clear();
    this.phageList = null;
  }

  // Optional bias/codon caches: stored in in-memory cache only (no schema support)
  async getBiasVector(phageId: number): Promise<number[] | null> {
    return this.biasCache.get(phageId) ?? null;
  }

  async setBiasVector(phageId: number, vector: number[]): Promise<void> {
    this.biasCache.set(phageId, vector);
    this.scheduleSave();
  }

  async getCodonVector(phageId: number): Promise<number[] | null> {
    return this.codonCache.get(phageId) ?? null;
  }

  async setCodonVector(phageId: number, vector: number[]): Promise<void> {
    this.codonCache.set(phageId, vector);
    this.scheduleSave();
  }
}
