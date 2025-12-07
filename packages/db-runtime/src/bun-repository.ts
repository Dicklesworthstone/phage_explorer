import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { eq, like, or, asc, and, gte, lte } from 'drizzle-orm';
import {
  phages,
  sequences,
  genes,
  codonUsage,
  models,
  preferences,
} from '@phage-explorer/db-schema';
import type { PhageSummary, PhageFull, GeneInfo, CodonUsageData } from '@phage-explorer/core';
import type { PhageRepository, CacheEntry } from './types';
import { CHUNK_SIZE } from './types';
import { readFileSync, writeFileSync, existsSync } from 'fs';

export class BunSqliteRepository implements PhageRepository {
  private sqlite: Database;
  private db: ReturnType<typeof drizzle>;
  private cache: Map<string, CacheEntry<unknown>> = new Map();
  private phageList: PhageSummary[] | null = null;
  private cachePath: string;
  private biasCache: Map<number, number[]> = new Map();
  private codonCache: Map<number, number[]> = new Map();

  constructor(dbPath: string) {
    this.sqlite = new Database(dbPath, { readonly: true });
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

  private saveVectorCache(): void {
    try {
      const bias: Record<string, number[]> = {};
      const codon: Record<string, number[]> = {};
      for (const [k, v] of this.biasCache.entries()) bias[k.toString()] = v;
      for (const [k, v] of this.codonCache.entries()) codon[k.toString()] = v;
      writeFileSync(this.cachePath, JSON.stringify({ bias, codon }));
    } catch {
      // best effort; ignore write failures (read-only FS)
    }
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
      .orderBy(asc(phages.name));

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
      pdbIds: phage.pdbIds ? JSON.parse(phage.pdbIds) : [],
      genes: geneList,
      codonUsage: usage,
      hasModel,
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

    // Concatenate chunks
    let fullSeq = '';
    for (const chunk of result) {
      fullSeq += chunk.sequence;
    }

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

    const result = await this.db
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
      aaCounts: JSON.parse(result[0].aaCounts),
      codonCounts: JSON.parse(result[0].codonCounts),
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

  async getModelFrames(phageId: number): Promise<string[] | null> {
    const result = await this.db
      .select({ asciiFrames: models.asciiFrames })
      .from(models)
      .where(eq(models.phageId, phageId))
      .limit(1);

    if (result.length === 0 || !result[0].asciiFrames) {
      return null;
    }

    return JSON.parse(result[0].asciiFrames);
  }

  async prefetchAround(index: number, radius: number): Promise<void> {
    const list = await this.listPhages();
    const start = Math.max(0, index - radius);
    const end = Math.min(list.length - 1, index + radius);

    // Prefetch phage data in background
    for (let i = start; i <= end; i++) {
      if (i !== index) {
        // Don't await - run in background
        void this.getPhageById(list[i].id);
      }
    }
  }

  async searchPhages(query: string): Promise<PhageSummary[]> {
    const searchTerm = `%${query.toLowerCase()}%`;

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
          like(phages.name, searchTerm),
          like(phages.host, searchTerm),
          like(phages.family, searchTerm),
          like(phages.accession, searchTerm),
          like(phages.slug, searchTerm)
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
    // Note: This requires writable DB - may fail in readonly mode
    await this.db
      .insert(preferences)
      .values({ key, value })
      .onConflictDoUpdate({
        target: preferences.key,
        set: { value },
      });
  }

  async close(): Promise<void> {
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
    this.saveVectorCache();
  }

  async getCodonVector(phageId: number): Promise<number[] | null> {
    return this.codonCache.get(phageId) ?? null;
  }

  async setCodonVector(phageId: number, vector: number[]): Promise<void> {
    this.codonCache.set(phageId, vector);
    this.saveVectorCache();
  }
}
