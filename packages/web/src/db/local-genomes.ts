import { create } from 'zustand';
import { mergeLocalGenomes } from '@phage-explorer/db-runtime/local-genomes';
import { exportCatalogGenomeSnapshot, GENOME_IMPORT_LIMITS,
  type GenomeInput, type GenomeImportResult, type LocalGenome, type LocalGenomeView,
  type PhageFull, type PhageSummary } from '@phage-explorer/core';
import type { PhageRepository } from './types';

/** Capture the displayed catalog annotation and complete bases without changing
 * either repository. Publication still uses the normal accession-collision review.
 * Parsing runs in the caller's cancellable worker, as it does for local files.
 */
export async function prepareCatalogGenomeSnapshot(
  repository: Pick<PhageRepository, 'getFullGenomeLength' | 'getSequenceWindow' | 'getOfflineDataset'>,
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
    const next = mergeLocalGenomes(get().genomes, result, catalog, allowCollisions);
    const selected = result.genomes.find(genome => genome.phage.localGenome?.contentId === result.view?.contentId) ?? result.genomes[0];
    set({ genomes: next, requestedId: selected.phage.id, requestedView: result.view });
  },
  acknowledgeSelection: id => { if (get().requestedId === id) set({ requestedId: null, requestedView: undefined }); },
}));
