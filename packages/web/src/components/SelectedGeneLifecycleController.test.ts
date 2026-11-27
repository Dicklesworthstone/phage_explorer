import { afterEach, describe, expect, it } from 'bun:test';
import { usePhageStore } from '@phage-explorer/state';
import type { PhageSelectionSnapshot } from '../hooks/PhageSelectionSession';
import { commitExplorerSelection } from './SelectedGeneLifecycleController';

const initial = usePhageStore.getState();
afterEach(() => usePhageStore.setState(initial));

const empty: PhageSelectionSnapshot = { repository: null, selection: null, pendingIndex: null, error: null };
function selected(index: number): PhageSelectionSnapshot {
  return { ...empty, selection: { index, phage: { id: index + 1 } as NonNullable<typeof initial.currentPhage>, sequence: 'ACGT' } };
}

describe('explorer selection publication', () => {
  it('clears a previous gene and coordinate on ordinary source changes even if IDs collide', () => {
    const a = selected(0), b = selected(0);
    commitExplorerSelection(a, empty);
    usePhageStore.setState({ selectedGeneId: 7, scrollPosition: 3 });
    commitExplorerSelection(b, a);
    expect(usePhageStore.getState().currentPhage).toBe(b.selection!.phage);
    expect(usePhageStore.getState().selectedGeneId).toBeNull();
    expect(usePhageStore.getState().scrollPosition).toBe(0);
  });

  it('keeps the verified gene and position when first opening its source', () => {
    commitExplorerSelection(selected(0), empty, { viewMode: 'dna', readingFrame: 0, scrollPosition: 2, selectedGeneId: 7 });
    expect(usePhageStore.getState().selectedGeneId).toBe(7);
    expect(usePhageStore.getState().scrollPosition).toBe(2);
  });

  it('preserves the current view during loading and failed selection attempts', () => {
    const a = selected(0), loading = { ...a, pendingIndex: 1 };
    commitExplorerSelection(a, empty);
    usePhageStore.setState({ selectedGeneId: 7, scrollPosition: 3 });
    commitExplorerSelection(loading, a);
    expect(usePhageStore.getState().selectedGeneId).toBe(7);
    commitExplorerSelection({ ...a, error: { index: 1, message: 'Unavailable' } }, loading);
    expect(usePhageStore.getState().selectedGeneId).toBe(7);
    expect(usePhageStore.getState().scrollPosition).toBe(3);
  });
});
