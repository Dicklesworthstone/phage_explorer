import { exportCatalogGenomeSnapshot, exportLocalGenomeBundle, GENOME_IMPORT_LIMITS, validateLocalGenomeInputLimits } from '@phage-explorer/core';
import type { GenomeInput, GenomeImportResult, LocalGenome, PhageFull, PhageSummary } from '@phage-explorer/core';
import type { PhageRepository } from './types';

/** Capture the displayed catalog annotation and complete bases without changing
 * either repository. Publication still uses the normal accession-collision review.
 * Parsing runs in the caller's cancellable worker, as it does for local files.
 * Native repositories without a dataset descriptor retain an unknown version;
 * the snapshot importer still identifies the exact sequence and annotations.
 */
export async function prepareCatalogGenomeSnapshot(
  repository: Pick<PhageRepository, 'getFullGenomeLength' | 'getSequenceWindow'> & {
    getOfflineDataset?: () => { describe(): { contentVersion: string } } | null;
  },
  phage: PhageFull,
  options: {
    signal: AbortSignal;
    isCurrent: () => boolean;
    parse: (input: GenomeInput, signal: AbortSignal) => Promise<GenomeImportResult>;
  }
): Promise<GenomeImportResult> {
  const { signal } = options;
  const check = () => {
    if (signal.aborted) throw new DOMException('Catalog capture cancelled.', 'AbortError');
    if (!options.isCurrent()) throw new Error('The catalog or selected genome changed during capture. Capture the current selection again.');
  };
  check();
  if (phage.localGenome) throw new Error('Choose a catalog genome to capture. This record is already available to local research workflows.');
  // Copy before the first asynchronous read. A later cache/UI mutation must not
  // silently change which annotations travel with the captured bases.
  const captured = structuredClone(phage);
  const version = () => repository.getOfflineDataset?.()?.describe().contentVersion ?? null;
  const contentVersion = version();
  const owned = () => {
    check();
    if (version() !== contentVersion) throw new Error('The catalog version changed during capture. Capture the current dataset again.');
  };
  const wait = <T,>(task: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const cancel = () => reject(new DOMException('Catalog capture cancelled.', 'AbortError'));
    signal.addEventListener('abort', cancel, { once: true });
    void task.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    if (signal.aborted) cancel();
  });
  const length = await wait(repository.getFullGenomeLength(captured.id));
  owned();
  if (!Number.isSafeInteger(length) || length < 1 || length > GENOME_IMPORT_LIMITS.bases) {
    throw new Error('Catalog captures require 1–5,000,000 bases.');
  }
  if (captured.genomeLength !== length) {
    throw new Error('Catalog sequence length differs from the displayed annotation. Reload the catalog before capture.');
  }
  const sequence = await wait(repository.getSequenceWindow(captured.id, 0, length));
  owned();
  if (sequence.length !== length) throw new Error('The complete catalog sequence could not be read. No snapshot was prepared.');
  const input = await wait(exportCatalogGenomeSnapshot(captured, sequence, { contentVersion }));
  owned();
  const result = await wait(options.parse(input, signal));
  owned();
  if (result.genomes.length !== 1 || result.genomes[0].phage.localGenome?.format !== 'catalog-snapshot'
    || result.genomes[0].sequence !== sequence.toUpperCase()) {
    throw new Error('The captured sequence was not preserved by the snapshot importer.');
  }
  return result;
}

/** Validate the complete addition before changing either frontend's session. */
export function mergeLocalGenomes(existing: readonly LocalGenome[], result: GenomeImportResult, catalog: readonly PhageSummary[], allowCollisions: boolean): LocalGenome[] {
  if (!result.genomes.length) throw new Error('No parsed genomes to import');
  const all = [...catalog, ...existing.map(genome => genome.phage)];
  for (const genome of result.genomes) {
    const collision = all.find(phage => phage.accession === genome.phage.accession && phage.localGenome?.contentId !== genome.phage.localGenome?.contentId);
    if (collision && !allowCollisions) throw new Error(`Accession ${genome.phage.accession} already exists. Explicitly allow keeping different records separately to import without replacing it.`);
    const idCollision = all.find(phage => phage.id === genome.phage.id && phage.localGenome?.contentId !== genome.phage.localGenome?.contentId);
    if (idCollision) throw new Error('Identifier collision; no local records were added');
    all.push(genome.phage);
  }
  const next = existing.slice();
  for (const genome of result.genomes) if (!next.some(item => item.phage.id === genome.phage.id)) next.push(genome);
  if (next.length > GENOME_IMPORT_LIMITS.records || next.reduce((sum, genome) => sum + genome.sequence.length, 0) > GENOME_IMPORT_LIMITS.bases) throw new Error('This session supports at most 100 local records and 5,000,000 bases; export and start a new session.');
  const bundle = exportLocalGenomeBundle(next, result.view);
  if (new TextEncoder().encode(bundle).length > GENOME_IMPORT_LIMITS.bytes - 1024) {
    throw new Error('The combined original inputs exceed the 10 MiB portable bundle limit; export this session and start a new one.');
  }
  // Validate the exact originals that export and workflow replay will parse.
  // Deduplicated genomes/mapped genes omit repeated records, source features
  // and unsupported annotations, so their counts cannot establish reimportability.
  validateLocalGenomeInputLimits({ name: 'local-genomes.json', text: bundle });
  return next;
}

/** Browser-safe composition: private records never write to curated SQLite. */
export function createLocalGenomeRepository<T extends PhageRepository = PhageRepository>(base: T | null, genomes: readonly LocalGenome[]): T {
  const local = new Map(genomes.map(genome => [genome.phage.id, genome]));
  const bias = new Map<number, number[]>();
  const codon = new Map<number, number[]>();
  const listPhages = async () => [...(await base?.listPhages() ?? []), ...genomes.map(genome => genome.phage)];
  const getPhageById = async (id: number): Promise<PhageFull | null> => local.get(id)?.phage ?? (await base?.getPhageById(id) ?? null);
  const handlers: Record<string, unknown> = {
    listPhages,
    getPhageById,
    getPhageByIndex: async (index: number) => {
      const list = await listPhages();
      return Number.isInteger(index) && list[index] ? getPhageById(list[index].id) : null;
    },
    getPhageBySlug: async (slug: string) => genomes.find(genome => genome.phage.slug === slug)?.phage ?? (await base?.getPhageBySlug(slug) ?? null),
    getSequenceWindow: async (id: number, start: number, end: number) => {
      const genome = local.get(id);
      if (!genome) return base?.getSequenceWindow(id, start, end) ?? '';
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) throw new Error('Invalid local sequence interval');
      return genome.sequence.slice(start, end);
    },
    getFullGenomeLength: async (id: number) => local.get(id)?.sequence.length ?? (await base?.getFullGenomeLength(id) ?? 0),
    getGenes: async (id: number) => local.get(id)?.phage.genes ?? (await base?.getGenes(id) ?? []),
    getCodonUsage: async (id: number) => local.has(id) ? null : (await base?.getCodonUsage(id) ?? null),
    hasModel: async (id: number) => local.has(id) ? false : (await base?.hasModel(id) ?? false),
    getModelFrames: async (id: number) => local.has(id) ? null : (await base?.getModelFrames(id) ?? null),
    prefetchAround: async (index: number, radius: number) => {
      const list = await listPhages();
      if (!Number.isInteger(index) || !Number.isFinite(radius)) return;
      const width = Math.min(list.length, Math.max(0, Math.floor(radius)));
      await Promise.allSettled(list.slice(Math.max(0, index - width), index + width + 1).map(phage => getPhageById(phage.id)));
    },
    searchPhages: async (query: string) => (await listPhages()).filter(phage => [phage.name, phage.accession, phage.host, phage.family].some(value => value?.toLowerCase().includes(query.toLowerCase()))),
    getPreference: async (key: string) => base?.getPreference(key) ?? null,
    setPreference: async (key: string, value: string) => { await base?.setPreference(key, value); },
    getBiasVector: async (id: number) => local.has(id) ? bias.get(id) ?? null : (await base?.getBiasVector?.(id) ?? null),
    setBiasVector: async (id: number, vector: number[]) => { if (local.has(id)) bias.set(id, vector); else await base?.setBiasVector?.(id, vector); },
    getCodonVector: async (id: number) => local.has(id) ? codon.get(id) ?? null : (await base?.getCodonVector?.(id) ?? null),
    setCodonVector: async (id: number, vector: number[]) => { if (local.has(id)) codon.set(id, vector); else await base?.setCodonVector?.(id, vector); },
    getLatentSpaceAtlas: async (options?: { phageId?: number; model?: string }) => options?.phageId !== undefined && local.has(options.phageId) ? [] : (await base?.getLatentSpaceAtlas?.(options) ?? []),
    close: async () => { await base?.close(); },
  };
  for (const method of ['getProteinDomains', 'getAmgAnnotations', 'getDefenseSystems', 'getCodonAdaptation', 'getFoldEmbeddings', 'getTropismPredictions']) {
    handlers[method] = async (id: number, ...args: unknown[]) => {
      if (local.has(id) || !base) return [];
      const fn = Reflect.get(base, method);
      return typeof fn === 'function' ? fn.call(base, id, ...args) : [];
    };
  }
  return new Proxy(handlers, {
    get(target, property) {
      if (Object.hasOwn(target, property)) return Reflect.get(target, property);
      const value: unknown = base ? Reflect.get(base, property) : undefined;
      return typeof value === 'function' ? value.bind(base) : value;
    },
  }) as unknown as T;
}
