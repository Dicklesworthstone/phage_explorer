import { afterEach, describe, expect, it } from 'bun:test';
import { usePhageStore, useSelectedGeneStore } from './index';

afterEach(() => {
  useSelectedGeneStore.getState().clearSelectedGene();
});

describe('selected gene store extension', () => {
  it('uses the exact same Zustand store as the application state', () => {
    expect(useSelectedGeneStore).toBe(usePhageStore);
  });

  it('publishes gene selection to every main-store subscriber', () => {
    useSelectedGeneStore.getState().setSelectedGeneId(42);
    expect(usePhageStore.getState().selectedGeneId).toBe(42);
  });

  it('clears selection explicitly and during a full reset', () => {
    useSelectedGeneStore.getState().setSelectedGeneId(42);
    useSelectedGeneStore.getState().clearSelectedGene();
    expect(usePhageStore.getState().selectedGeneId).toBeNull();

    useSelectedGeneStore.getState().setSelectedGeneId(7);
    usePhageStore.getState().reset();
    expect(useSelectedGeneStore.getState().selectedGeneId).toBeNull();
  });

  it('ignores invalid gene identifiers', () => {
    useSelectedGeneStore.getState().setSelectedGeneId(11);
    useSelectedGeneStore.getState().setSelectedGeneId(-1);
    useSelectedGeneStore.getState().setSelectedGeneId(1.5);
    expect(useSelectedGeneStore.getState().selectedGeneId).toBe(11);
  });
});
