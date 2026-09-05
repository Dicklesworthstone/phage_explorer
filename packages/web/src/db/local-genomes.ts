import { create } from 'zustand';
import { exportLocalGenomeBundle, GENOME_IMPORT_LIMITS } from '@phage-explorer/core';
import type { GenomeImportResult, LocalGenome, LocalGenomeView, PhageFull, PhageSummary } from '@phage-explorer/core';
import type { PhageRepository } from './types';

interface LocalGenomeState {
  genomes: LocalGenome[];
  requestedId: number | null;
  requestedView?: LocalGenomeView;
  add: (result: GenomeImportResult, allowAccessionCollisions: boolean, catalog: readonly PhageSummary[]) => void;
  acknowledgeSelection: (id: number) => void;
}

/** Session memory only. Export a bundle before reloading to preserve private input. */
export const useLocalGenomes = create<LocalGenomeState>((set, get) => ({
  genomes: [], requestedId: null,
  add: (result, allowCollisions, catalog) => {
    if (!result.genomes.length) throw new Error('No parsed genomes to import');
    const existing = get().genomes;
    const all = [...catalog, ...existing.map(genome => genome.phage)];
    for (const genome of result.genomes) {
      const collision = all.find(phage => phage.accession === genome.phage.accession && phage.localGenome?.contentId !== genome.phage.localGenome?.contentId);
      if (collision && !allowCollisions) throw new Error(`Accession ${genome.phage.accession} already exists. Choose “Keep different records separately” to import without replacing it.`);
      const idCollision = all.find(phage => phage.id === genome.phage.id && phage.localGenome?.contentId !== genome.phage.localGenome?.contentId);
      if (idCollision) throw new Error('Identifier collision; no local records were added');
      all.push(genome.phage);
    }
    const next = existing.slice();
    for (const genome of result.genomes) if (!next.some(item => item.phage.id === genome.phage.id)) next.push(genome);
    if (next.length > 100 || next.reduce((sum, genome) => sum + genome.sequence.length, 0) > 5_000_000) throw new Error('This session supports at most 100 local records and 5,000,000 bases; export and start a new session.');
    if (new TextEncoder().encode(exportLocalGenomeBundle(next, result.view)).length > GENOME_IMPORT_LIMITS.bytes - 1024) {
      throw new Error('The combined original inputs exceed the 10 MiB portable bundle limit; export this session and start a new one.');
    }
    const selected = result.genomes.find(genome => genome.phage.localGenome?.contentId === result.view?.contentId) ?? result.genomes[0];
    set({ genomes: next, requestedId: selected.phage.id, requestedView: result.view });
  },
  acknowledgeSelection: id => { if (get().requestedId === id) set({ requestedId: null, requestedView: undefined }); },
}));

/** Extend read access with private records; curated SQLite is never mutated. */
export function createLocalGenomeRepository(base: PhageRepository | null, genomes: readonly LocalGenome[]): PhageRepository {
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
  }) as unknown as PhageRepository;
}
