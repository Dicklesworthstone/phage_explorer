import { create } from 'zustand';

export interface SelectedGeneState {
  selectedGeneId: number | null;
}

export interface SelectedGeneActions {
  setSelectedGeneId: (geneId: number | null) => void;
  clearSelectedGene: () => void;
}

export type SelectedGeneStore = SelectedGeneState & SelectedGeneActions;

export const useSelectedGeneStore = create<SelectedGeneStore>((set) => ({
  selectedGeneId: null,
  setSelectedGeneId: (geneId) => {
    if (geneId !== null && (!Number.isInteger(geneId) || geneId < 0)) return;
    set({ selectedGeneId: geneId });
  },
  clearSelectedGene: () => set({ selectedGeneId: null }),
}));

export default useSelectedGeneStore;
