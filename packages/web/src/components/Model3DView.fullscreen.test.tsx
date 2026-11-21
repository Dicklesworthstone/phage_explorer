import { afterEach, describe, expect, it } from 'bun:test';
import { usePhageStore } from '@phage-explorer/state';
import { importLocalGenomes } from '@phage-explorer/core';
import type { StructureGenomeResidue } from '../visualization/structure-sequence';
import { applyThreeFullscreenClass, navigateToStructureResidue, THREE_FULLSCREEN_CLASS } from './Model3DView';

describe('3D fullscreen regressions (o5y7)', () => {
  afterEach(() => {
    usePhageStore.getState().reset();
  });

  it('entering fullscreen unpauses and bumps quality (store invariants)', () => {
    usePhageStore.setState({
      model3DFullscreen: false,
      model3DPaused: true,
      model3DQuality: 'medium',
    });

    usePhageStore.getState().toggle3DModelFullscreen();

    const state = usePhageStore.getState();
    expect(state.model3DFullscreen).toBe(true);
    expect(state.model3DPaused).toBe(false);
    expect(state.model3DQuality).toBe('high');
  });

  it('applies the iOS fullscreen shell override class', () => {
    const applied = new Set<string>();
    const fakeRoot = {
      classList: {
        add: (name: string) => applied.add(name),
        remove: (name: string) => applied.delete(name),
      },
    };

    applyThreeFullscreenClass(fakeRoot, true);
    expect(applied.has(THREE_FULLSCREEN_CLASS)).toBe(true);

    applyThreeFullscreenClass(fakeRoot, false);
    expect(applied.has(THREE_FULLSCREEN_CLASS)).toBe(false);
  });

  it('navigates a verified residue in genomic coordinates and refuses a stale same-ID genome', async () => {
    const { phage } = (await importLocalGenomes({ name: 'mapped.gb', text: `LOCUS       MAPPED 33 bp DNA linear
FEATURES             Location/Qualifiers
     CDS             1..33
                     /translation="MACDEFGHIK"
ORIGIN
        1 atggcttgtgatgaatttggtcatattaaataa
//
` })).genomes[0];
    const residue: StructureGenomeResidue = { geneId: phage.genes[0].id, geneLabel: 'mapped CDS',
      proteinPosition: 8, genomePos: 21, genomeSegments: [{ start: 21, end: 24, strand: '+' }],
      matchedResidues: 10, method: 'polymer-sequence-offset' };
    usePhageStore.setState({ currentPhage: phage, viewMode: 'aa', readingFrame: -2, scrollPosition: 0, selectedGeneId: null });
    expect(navigateToStructureResidue(residue, phage)).toBe(true);
    expect(usePhageStore.getState()).toMatchObject({ selectedGeneId: phage.genes[0].id, viewMode: 'dna', scrollPosition: 21 });

    const changed = { ...phage, accession: 'A_DIFFERENT_GENOME_WITH_THE_SAME_ID' };
    usePhageStore.setState({ currentPhage: changed, viewMode: 'aa', scrollPosition: 4, selectedGeneId: null });
    expect(navigateToStructureResidue(residue, phage)).toBe(false);
    expect(navigateToStructureResidue(undefined, changed)).toBe(false);
    expect(navigateToStructureResidue({ ...residue, genomePos: 33 }, changed)).toBe(false);
    expect(usePhageStore.getState()).toMatchObject({ viewMode: 'aa', scrollPosition: 4, selectedGeneId: null });
  });
});
