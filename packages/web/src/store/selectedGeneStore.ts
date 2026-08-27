import {
  usePhageStore,
  type PhageExplorerStore,
} from '@phage-explorer/state';

declare module '@phage-explorer/state' {
  interface PhageExplorerState {
    selectedGeneId: number | null;
  }

  interface PhageExplorerActions {
    setSelectedGeneId: (geneId: number | null) => void;
    clearSelectedGene: () => void;
  }
}

export interface SelectedGeneState {
  selectedGeneId: number | null;
}

export interface SelectedGeneActions {
  setSelectedGeneId: (geneId: number | null) => void;
  clearSelectedGene: () => void;
}

export type SelectedGeneStore = SelectedGeneState & SelectedGeneActions;

const existingState = usePhageStore.getState();

if (typeof existingState.setSelectedGeneId !== 'function') {
  const originalReset = existingState.reset;

  const setSelectedGeneId = (geneId: number | null): void => {
    if (geneId !== null && (!Number.isSafeInteger(geneId) || geneId < 0)) return;
    usePhageStore.setState({ selectedGeneId: geneId });
  };

  const clearSelectedGene = (): void => {
    usePhageStore.setState({ selectedGeneId: null });
  };

  usePhageStore.setState({
    selectedGeneId: null,
    setSelectedGeneId,
    clearSelectedGene,
    reset: () => {
      originalReset();
      clearSelectedGene();
    },
  } satisfies Partial<PhageExplorerStore>);
}

/**
 * Web-facing alias of the main store after installing selected-gene state.
 * Every surface subscribes to the same Zustand store and update stream.
 */
export const useSelectedGeneStore = usePhageStore;

export default useSelectedGeneStore;
