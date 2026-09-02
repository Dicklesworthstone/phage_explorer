import { usePhageStore } from '@phage-explorer/state';

/**
 * Selected-gene state now lives in the shared store (`@phage-explorer/state`),
 * alongside every other piece of navigation state.
 *
 * It used to live here, installed by declaring a TypeScript module
 * augmentation on `PhageExplorerState` and then patching the fields onto the
 * running store with `usePhageStore.setState(...)`. That worked at runtime but
 * left the shared store's own initial state object failing to satisfy its own
 * augmented interface -- a type error that went unnoticed for as long as it
 * existed, because the root tsconfig excluded `packages/web/**` from
 * `bun run typecheck`.
 *
 * Both surfaces navigate genes, so the state was never web-specific. This file
 * is now just the named alias the web components already import.
 */

export interface SelectedGeneState {
  selectedGeneId: number | null;
}

export interface SelectedGeneActions {
  setSelectedGeneId: (geneId: number | null) => void;
  clearSelectedGene: () => void;
}

export type SelectedGeneStore = SelectedGeneState & SelectedGeneActions;

/**
 * Web-facing alias of the main store. Every surface subscribes to the same
 * Zustand store and update stream.
 */
export const useSelectedGeneStore = usePhageStore;

export default useSelectedGeneStore;
