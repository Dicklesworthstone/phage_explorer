/** Catalog-first repository for the publisher's per-phage-sqlite-v1 layout. */
import type { PhageSummary, PhageFull, LatentSpacePoint } from '@phage-explorer/core';
import type { PhageRepository } from './types';
import {
  PROGRESSIVE_LIMITS, parseProgressiveManifest, verifyProgressiveManifest,
  type ProgressiveManifest, type GenomeArtifact,
} from './progressive-manifest';
import type { VerifiedArtifactStore } from './progressive-artifacts';

export interface ProgressiveRepositoryOptions {
  manifest: unknown;
  store: Pick<VerifiedArtifactStore, 'read' | 'pin' | 'close' | 'getTransferLedger'>;
  /** Synchronous SQL opening; the repository owns and closes every returned handle. */
  openRepository: (bytes: Uint8Array) => PhageRepository;
  /** Serialized SQLite bytes, including catalog and in-flight reservations; not total JS/WASM heap. */
  residentBytes?: number;
  /** Maximum serialized projection-page bytes in a single global atlas request. */
  atlasBytes?: number;
  signal?: AbortSignal;
}
interface Resident {
  descriptor: GenomeArtifact;
  repository: PhageRepository | null;
  ready: Promise<void>;
  users: number;
  reserved: boolean;
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Dataset operation cancelled.', 'AbortError');
}
/** Also settles when an injected provider ignores its cancellation signal. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new DOMException('Dataset operation cancelled.', 'AbortError'));
    signal.addEventListener('abort', cancel, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    if (signal.aborted) cancel();
  });
}
function sameSummary(a: PhageSummary, b: PhageSummary): boolean {
  return (['id', 'slug', 'name', 'accession', 'family', 'host', 'genomeLength', 'gcContent', 'morphology', 'lifecycle'] as const)
    .every(key => a[key] === b[key]);
}

/** No catalog placeholders escape as full phages; all phage-scoped reads use their exact shard. */
export class ProgressivePhageRepository implements PhageRepository {
  private readonly lifetime = new AbortController();
  private readonly genomes: Map<number, GenomeArtifact>;
  private readonly summaries: Map<number, PhageSummary>;
  private readonly residents = new Map<number, Resident>();
  private readonly waiters = new Set<() => void>();
  private residentBytes: number;
  private peakResidentBytes: number;
  private closed = false;
  private closing: Promise<void> | null = null;

  private constructor(
    private readonly manifest: ProgressiveManifest,
    private readonly options: ProgressiveRepositoryOptions,
    private readonly catalog: PhageRepository,
    private readonly phages: PhageSummary[],
    private readonly budget: number,
    private readonly atlasBudget: number,
  ) {
    this.genomes = new Map(manifest.genomes.map(item => [item.id, item]));
    this.summaries = new Map(phages.map(phage => [phage.id, phage]));
    this.residentBytes = manifest.catalog.bytes;
    this.peakResidentBytes = this.residentBytes;
  }

  static async open(options: ProgressiveRepositoryOptions): Promise<ProgressivePhageRepository> {
    let catalog: PhageRepository | null = null;
    try {
      assertActive(options.signal);
      const manifest = parseProgressiveManifest(options.manifest);
      await abortable(verifyProgressiveManifest(manifest), options.signal);
      const budget = options.residentBytes ?? PROGRESSIVE_LIMITS.residentBytes;
      const atlasBudget = options.atlasBytes ?? PROGRESSIVE_LIMITS.residentBytes;
      if (!Number.isSafeInteger(budget) || budget < manifest.catalog.bytes || !Number.isSafeInteger(atlasBudget) || atlasBudget < 2) {
        throw new Error('Invalid progressive repository byte budgets.');
      }
      if (manifest.genomes.some(item => item.artifact.bytes + manifest.catalog.bytes > budget)) {
        throw new Error('A genome and catalog exceed the resident SQLite budget; repartition the dataset or explicitly raise the budget.');
      }
      options.store.pin(manifest.catalog);
      const { data } = await abortable(options.store.read(manifest.catalog), options.signal);
      assertActive(options.signal);
      catalog = options.openRepository(data);
      const phages = await abortable(catalog.listPhages(), options.signal);
      if (phages.length !== manifest.genomes.length || phages.some((phage, index) =>
        phage.id !== manifest.genomes[index].id || phage.genomeLength !== manifest.genomes[index].genomeLength)) {
        throw new Error('Catalog genome ownership or lengths disagree with the manifest.');
      }
      assertActive(options.signal);
      return new ProgressivePhageRepository(manifest, options, catalog, structuredClone(phages), budget, atlasBudget);
    } catch (error) {
      await Promise.allSettled([options.store.close(), ...(catalog ? [catalog.close()] : [])]);
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Dataset repository is closed.');
  }
  private notify(): void {
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }
  private async dispose(entry: Resident): Promise<void> {
    const repository = entry.repository;
    entry.repository = null;
    // Keep the reservation until the SQL handle is actually released.
    try { if (repository) await repository.close(); }
    finally {
      if (entry.reserved) { entry.reserved = false; this.residentBytes -= entry.descriptor.artifact.bytes; }
      this.notify();
    }
  }
  private async reserve(entry: Resident): Promise<void> {
    const size = entry.descriptor.artifact.bytes;
    for (;;) {
      this.assertOpen();
      if (this.residentBytes + size <= this.budget) {
        this.residentBytes += size;
        this.peakResidentBytes = Math.max(this.peakResidentBytes, this.residentBytes);
        entry.reserved = true;
        return;
      }
      const victim = [...this.residents.entries()].find(([, value]) => value.repository && value.users === 0);
      if (victim) {
        this.residents.delete(victim[0]);
        await this.dispose(victim[1]);
      } else {
        await new Promise<void>(resolve => this.waiters.add(resolve));
      }
    }
  }
  private async loadShard(entry: Resident): Promise<void> {
    try {
      await this.reserve(entry);
      const { data } = await abortable(this.options.store.read(entry.descriptor.artifact), this.lifetime.signal);
      this.assertOpen();
      entry.repository = this.options.openRepository(data);
      const list = await entry.repository.listPhages();
      this.assertOpen();
      if (list.length !== 1 || !sameSummary(list[0], this.summaries.get(entry.descriptor.id)!)) {
        throw new Error(`Genome shard ${entry.descriptor.id} does not match its catalog owner.`);
      }
    } catch (error) {
      if (this.residents.get(entry.descriptor.id) === entry) this.residents.delete(entry.descriptor.id);
      await this.dispose(entry);
      throw error;
    }
  }
  private async withGenome<T>(id: number, absent: T, operation: (repository: PhageRepository) => Promise<T>): Promise<T> {
    this.assertOpen();
    const descriptor = this.genomes.get(id);
    if (!descriptor) return absent;
    let entry = this.residents.get(id);
    if (!entry) {
      entry = { descriptor, repository: null, ready: Promise.resolve(), users: 0, reserved: false };
      this.residents.set(id, entry);
      // Schedule after insertion and lease accounting; concurrent callers share one opening.
      const pending = entry;
      entry.ready = Promise.resolve().then(() => this.loadShard(pending));
    }
    entry.users++;
    this.residents.delete(id); this.residents.set(id, entry);
    try {
      await entry.ready;
      this.assertOpen();
      const result = await operation(entry.repository!);
      this.assertOpen();
      return result;
    } finally {
      entry.users--;
      if (this.closed && entry.users === 0) await this.dispose(entry);
      this.notify();
    }
  }
  private async withCatalog<T>(operation: (repository: PhageRepository) => Promise<T>): Promise<T> {
    this.assertOpen();
    const result = await operation(this.catalog);
    this.assertOpen();
    return result;
  }

  getResidency(): { bytes: number; peakBytes: number; budget: number; shards: number } {
    return { bytes: this.residentBytes, peakBytes: this.peakResidentBytes, budget: this.budget,
      shards: [...this.residents.values()].filter(entry => entry.repository !== null).length };
  }
  getTransferLedger(): ReturnType<VerifiedArtifactStore['getTransferLedger']> { return this.options.store.getTransferLedger(); }
  async listPhages(): Promise<PhageSummary[]> { this.assertOpen(); return structuredClone(this.phages); }
  async getPhageByIndex(index: number): Promise<PhageFull | null> {
    this.assertOpen();
    return Number.isSafeInteger(index) && this.phages[index] ? this.getPhageById(this.phages[index].id) : null;
  }
  getPhageById(id: number): Promise<PhageFull | null> {
    return this.withGenome(id, null, async repository => {
      const value = await repository.getPhageById(id);
      if (!value) throw new Error(`Genome ${id} is missing from its verified shard.`);
      return value;
    });
  }
  async getPhageBySlug(slug: string): Promise<PhageFull | null> {
    this.assertOpen();
    const phage = this.phages.find(item => item.slug === slug);
    return phage ? this.getPhageById(phage.id) : null;
  }
  async getFullGenomeLength(id: number): Promise<number> { this.assertOpen(); return this.genomes.get(id)?.genomeLength ?? 0; }
  async getSequenceWindow(id: number, start: number, end: number): Promise<string> {
    this.assertOpen();
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) throw new Error('Sequence windows require nonnegative half-open integer coordinates.');
    const length = this.genomes.get(id)?.genomeLength ?? 0;
    const stop = Math.min(end, length);
    if (start >= stop) return '';
    return this.withGenome(id, '', async repository => {
      const sequence = await repository.getSequenceWindow(id, start, stop);
      if (sequence.length !== stop - start) throw new Error(`Genome ${id} has an incomplete sequence window.`);
      return sequence;
    });
  }
  getGenes(id: number): ReturnType<PhageRepository['getGenes']> { return this.withGenome(id, [], repository => repository.getGenes(id)); }
  getCodonUsage(id: number): ReturnType<PhageRepository['getCodonUsage']> { return this.withGenome(id, null, repository => repository.getCodonUsage(id)); }
  hasModel(id: number): Promise<boolean> { return this.withGenome(id, false, repository => repository.hasModel(id)); }
  getModelFrames(id: number): Promise<string[] | null> { return this.withGenome(id, null, repository => repository.getModelFrames(id)); }
  searchPhages(query: string): Promise<PhageSummary[]> { return this.withCatalog(repository => repository.searchPhages(query)); }
  getPreference(key: string): Promise<string | null> { return this.withCatalog(repository => repository.getPreference(key)); }
  setPreference(key: string, value: string): Promise<void> { return this.withCatalog(repository => repository.setPreference(key, value)); }
  getBiasVector(id: number): Promise<number[] | null> { return this.withCatalog(repository => repository.getBiasVector?.(id) ?? Promise.resolve(null)); }
  setBiasVector(id: number, vector: number[]): Promise<void> { return this.withCatalog(repository => {
    if (!repository.setBiasVector) throw new Error('The catalog adapter cannot cache bias vectors.');
    return repository.setBiasVector(id, vector);
  }); }
  getCodonVector(id: number): Promise<number[] | null> { return this.withCatalog(repository => repository.getCodonVector?.(id) ?? Promise.resolve(null)); }
  setCodonVector(id: number, vector: number[]): Promise<void> { return this.withCatalog(repository => {
    if (!repository.setCodonVector) throw new Error('The catalog adapter cannot cache codon vectors.');
    return repository.setCodonVector(id, vector);
  }); }
  getAnnotationMeta(key: string): Promise<Record<string, unknown> | null> { return this.withCatalog(repository => repository.getAnnotationMeta?.(key) ?? Promise.resolve(null)); }
  getHostTrnaPools(host?: string): ReturnType<NonNullable<PhageRepository['getHostTrnaPools']>> { return this.withCatalog(repository => repository.getHostTrnaPools?.(host) ?? Promise.resolve([])); }
  getProteinDomains(id: number): ReturnType<NonNullable<PhageRepository['getProteinDomains']>> { return this.withGenome(id, [], repository => repository.getProteinDomains?.(id) ?? Promise.resolve([])); }
  getAmgAnnotations(id: number): ReturnType<NonNullable<PhageRepository['getAmgAnnotations']>> { return this.withGenome(id, [], repository => repository.getAmgAnnotations?.(id) ?? Promise.resolve([])); }
  getDefenseSystems(id: number): ReturnType<NonNullable<PhageRepository['getDefenseSystems']>> { return this.withGenome(id, [], repository => repository.getDefenseSystems?.(id) ?? Promise.resolve([])); }
  getCodonAdaptation(id: number, host?: string): ReturnType<NonNullable<PhageRepository['getCodonAdaptation']>> { return this.withGenome(id, [], repository => repository.getCodonAdaptation?.(id, host) ?? Promise.resolve([])); }
  getFoldEmbeddings(id: number, model?: string): ReturnType<NonNullable<PhageRepository['getFoldEmbeddings']>> { return this.withGenome(id, [], repository => repository.getFoldEmbeddings?.(id, model) ?? Promise.resolve([])); }
  async prefetchAround(index: number, radius: number): Promise<void> {
    this.assertOpen();
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.phages.length) return;
    if (!Number.isSafeInteger(radius) || radius < 0) throw new Error('Invalid prefetch radius.');
    for (let distance = 1; distance <= Math.min(radius, this.phages.length - 1); distance++) {
      const adjacent = [index - distance, index + distance].filter(i => i >= 0 && i < this.phages.length);
      await Promise.all(adjacent.map(i => this.getPhageById(this.phages[i].id)));
    }
  }
  async getLatentSpaceAtlas(options?: { phageId?: number; model?: string }): Promise<LatentSpacePoint[]> {
    this.assertOpen();
    if (options?.phageId !== undefined) return this.withGenome(options.phageId, [], repository => repository.getLatentSpaceAtlas?.(options) ?? Promise.resolve([]));
    const model = options?.model ?? 'facebook/esm2_t6_8M_UR50D';
    const atlas = this.manifest.atlas.find(item => item.model === model);
    if (!atlas) return [];
    if (atlas.pages.reduce((sum, item) => sum + item.bytes, 0) > this.atlasBudget) throw new Error('Global atlas exceeds its byte budget; select a single genome.');
    const result: LatentSpacePoint[] = [];
    const ids = new Set<number>();
    for (const page of atlas.pages) {
      const { data } = await abortable(this.options.store.read(page), this.lifetime.signal);
      this.assertOpen();
      const values: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
      if (!Array.isArray(values) || result.length + values.length > atlas.count) throw new Error('Atlas page count disagrees with the manifest.');
      for (const value of values) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid atlas point.');
        const point = value as LatentSpacePoint;
        if (!['id', 'phageId', 'geneId'].every(key => Number.isSafeInteger(Reflect.get(point, key)) && Reflect.get(point, key) > 0)
          || !Number.isSafeInteger(point.clusterId) || ![point.x, point.y, point.outlierScore].every(Number.isFinite)
          || point.model !== model || !this.summaries.has(point.phageId) || point.phageName !== this.summaries.get(point.phageId)!.name
          || ![point.geneName, point.locusTag, point.product].every(value => value === null || typeof value === 'string') || ids.has(point.id)) {
          throw new Error('Atlas point identity, ownership, model, or coordinates are invalid.');
        }
        ids.add(point.id); result.push(point);
      }
    }
    if (result.length !== atlas.count) throw new Error('Atlas is incomplete; no partial projection will be returned.');
    return result;
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.lifetime.abort();
      this.notify();
      // Leased SQL handles are released by withGenome after their last query settles.
      this.closing = Promise.allSettled([
        this.options.store.close(), this.catalog.close().finally(() => { this.residentBytes -= this.manifest.catalog.bytes; }),
        ...[...this.residents.values()].filter(entry => entry.users === 0).map(entry => this.dispose(entry)),
      ]).then(() => {});
    }
    return this.closing;
  }
}
