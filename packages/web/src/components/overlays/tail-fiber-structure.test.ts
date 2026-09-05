import { describe, expect, it } from 'bun:test';
import type { PhageFull } from '@phage-explorer/core';
import {
  analyzeTailFiberTropism,
  analyzeTailFiberStructure,
  simulateResidueMutation,
} from '@phage-explorer/comparison';

function createMockPhage(overrides: Partial<PhageFull> = {}): PhageFull {
  return {
    id: 99,
    slug: 'enterobacteria-phage-lambda',
    name: 'Enterobacteria phage lambda',
    accession: 'NC_001416',
    family: 'Siphoviridae',
    host: 'Escherichia coli',
    genomeLength: 48502,
    gcContent: 49.9,
    morphology: 'siphovirus',
    lifecycle: 'temperate',
    description: null,
    baltimoreGroup: null,
    genomeType: 'dsDNA',
    pdbIds: [],
    genes: [
      {
        id: 1,
        name: 'cI',
        locusTag: 'LAM_01',
        startPos: 100,
        endPos: 700,
        strand: '+',
        product: 'lysogenic repressor protein',
        type: 'CDS',
      },
      {
        id: 2,
        name: 'gpJ',
        locusTag: 'LAM_02',
        startPos: 1500,
        endPos: 4896,
        strand: '+',
        product: 'tail fiber protein gpJ',
        domains: ['PF06605'],
        type: 'CDS',
      },
    ],
    codonUsage: null,
    hasModel: false,
    ...overrides,
  };
}

describe('Illustrative tail fiber model through the comparison API (not browser proof)', () => {
  it('builds the illustrative modular domain architecture after opt-in', () => {
    const phage = createMockPhage();
    const tropism = analyzeTailFiberTropism(phage, '', [], { demonstration: true });

    expect(tropism.structuralAnalysis).toBeDefined();
    expect(tropism.structuralAnalysis).not.toBeNull();

    const struct = tropism.structuralAnalysis!;
    expect(struct.phageId).toBe(99);
    expect(struct.geneName).toBe('gpJ');
    expect(struct.domains.length).toBe(3);

    // Verify domains: N-anchor, shaft, distal RBD
    const anchor = struct.domains.find((d) => d.type === 'n_anchor');
    const shaft = struct.domains.find((d) => d.type === 'shaft');
    const rbd = struct.domains.find((d) => d.type === 'distal_rbd');

    expect(anchor).toBeDefined();
    expect(shaft).toBeDefined();
    expect(rbd).toBeDefined();

    expect(anchor?.startResidue).toBe(1);
    expect(shaft?.startResidue).toBe(anchor!.endResidue + 1);
    expect(rbd?.startResidue).toBe(shaft!.endResidue + 1);
    expect(rbd?.endResidue).toBe(struct.sequenceLength);
  });

  it('evaluates surface receptor affinity and clash scores across canonical targets', () => {
    const phage = createMockPhage();
    const struct = analyzeTailFiberStructure(phage, null, null, { demonstration: true });
    expect(struct).not.toBeNull();

    const receptors = struct!.receptorScores;
    expect(receptors.length).toBe(6);

    const names = receptors.map((r) => r.receptorId);
    expect(names).toContain('lamb');
    expect(names).toContain('ompc');
    expect(names).toContain('lps_core');

    for (const r of receptors) {
      expect(r.affinityScore).toBeGreaterThanOrEqual(10);
      expect(r.affinityScore).toBeLessThanOrEqual(100);
      expect(r.stericClashScore).toBeGreaterThanOrEqual(0);
      expect(r.electrostaticFit).toBeGreaterThanOrEqual(-1.0);
      expect(r.electrostaticFit).toBeLessThanOrEqual(1.0);
    }
  });

  it('calculates the example mutation model outputs', () => {
    const phage = createMockPhage();
    const struct = analyzeTailFiberStructure(phage, null, null, { demonstration: true });
    expect(struct).not.toBeNull();

    // Mutate position 1 (anchor) to bulky Tryptophan
    const mutAnchor = simulateResidueMutation(struct!, 1, 'W');
    expect(mutAnchor.position).toBe(1);
    expect(mutAnchor.mutant).toBe('W');
    expect(mutAnchor.predictedHostImpact).toBeDefined();

    // Mutate distal RBD position to basic Arginine
    const rbdPos = struct!.domains.find((d) => d.type === 'distal_rbd')?.startResidue ?? 50;
    const mutRbd = simulateResidueMutation(struct!, rbdPos, 'R');
    expect(mutRbd.position).toBe(rbdPos);
    expect(mutRbd.mutant).toBe('R');
    expect(mutRbd.affinityDeltas).toBeDefined();
  });

  it('retains example chimera scenarios with illustration labels', () => {
    const phage = createMockPhage();
    const struct = analyzeTailFiberStructure(phage, null, null, { demonstration: true });
    expect(struct?.source).toBe('demonstration');
    expect(struct?.assumptions).toContain('not predictions');
    expect(struct).not.toBeNull();

    const chimeras = struct!.chimeraSuggestions;
    expect(chimeras.length).toBeGreaterThanOrEqual(2);

    for (const c of chimeras) {
      expect(c.donorPhage).toBeDefined();
      expect(c.donorProtein).toBeDefined();
      expect(c.junctionResidue).toBeGreaterThan(0);
      expect(c.feasibilityScore).toBeGreaterThan(0);
      expect(c.feasibilityScore).toBeLessThanOrEqual(100);
      expect(c.targetReceptor).toBeDefined();
      expect(c.predictedHost).toBeDefined();
    }
  });

  it('handles phages without tail fiber candidates safely without error', () => {
    const nonFiberPhage = createMockPhage({
      genes: [
        {
          id: 1,
          name: 'cI',
          locusTag: 'LAM_01',
          startPos: 100,
          endPos: 700,
          strand: '+',
          product: 'lysogenic repressor protein',
          type: 'CDS',
        },
      ],
    });

    const tropism = analyzeTailFiberTropism(nonFiberPhage);
    expect(tropism.hits.length).toBe(0);
    expect(tropism.structuralAnalysis).toBeNull();
  });
});
