import { create } from 'zustand';
import { mergeLocalGenomes } from '@phage-explorer/db-runtime/local-genomes';
import type { GenomeImportResult, LocalGenome, LocalGenomeView, PhageSummary } from '@phage-explorer/core';

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
