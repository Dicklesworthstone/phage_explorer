import { describe, expect, it } from 'bun:test';
import type { PhageFull, GeneInfo } from '../types';
import {
  isTailFiberCandidate,
  calculatePositionEntropy,
  generateFiberHomologColumns,
  detectFiberDomainBoundaries,
  calculateResidueEpitopeMetrics,
  simulateResidueMutation,
  analyzeTailFiberStructure,
  analyzeTailFiberSequence,
  BACTERIAL_SURFACE_RECEPTORS,
} from './tail-fiber-structure';

function createMockPhage(overrides: Partial<PhageFull> = {}): PhageFull {
  return {
    id: 42,
    slug: 'enterobacteria-phage-t4',
    name: 'Enterobacteria phage T4',
    accession: 'NC_000866',
    family: 'Myoviridae',
    host: 'Escherichia coli',
    genomeLength: 168903,
    gcContent: 34.5,
    morphology: 'myovirus',
    lifecycle: 'virulent',
    description: null,
    baltimoreGroup: null,
    genomeType: 'dsDNA',
    pdbIds: [],
    genes: [
      {
        id: 1,
        name: 'gp23',
        locusTag: 'T4_001',
        startPos: 100,
        endPos: 1500,
        strand: '+',
        product: 'major capsid protein',
        type: 'CDS',
      },
      {
        id: 2,
        name: 'gp37',
        locusTag: 'T4_037',
        startPos: 2000,
        endPos: 5060,
        strand: '+',
        product: 'long tail fiber distal subunit',
        domains: ['PF06605'],
        type: 'CDS',
      },
      {
        id: 3,
        name: 'gp38',
        locusTag: 'T4_038',
        startPos: 5100,
        endPos: 5700,
        strand: '+',
        product: 'tail fiber adhesin receptor-binding protein',
        domains: ['PF13885'],
        type: 'CDS',
      },
    ],
    codonUsage: null,
    hasModel: false,
    ...overrides,
  };
}

describe('Tail fiber sequence analysis and illustrative structural model', () => {
  it.each([undefined, '', 'MAEKLL', 'M'.repeat(200)])('does not infer structural quantities from sequence %p by default', sequence => {
    const phage = createMockPhage();
    expect(analyzeTailFiberStructure(phage, phage.genes[1], sequence)).toBeNull();
  });

  it('computes hydropathy directly without replacing short or ambiguous proteins', () => {
    const phage = createMockPhage();
    const known = analyzeTailFiberSequence(phage, phage.genes[1], 'MKR*');
    expect(known?.sequence).toBe('MKR');
    expect(known?.residues.map(r => r.hydropathy)).toEqual([1.9, -3.9, -4.5]);
    expect(known?.meanHydropathy).toBeCloseTo(-6.5 / 3, 12);
    const ambiguous = analyzeTailFiberSequence(phage, phage.genes[1], 'MX');
    expect(ambiguous?.residues[1].hydropathy).toBeNull();
    expect(ambiguous?.meanHydropathy).toBeNull();
    expect(analyzeTailFiberSequence(phage, phage.genes[1], 'M*R')).toBeNull();
    expect(analyzeTailFiberSequence(phage, phage.genes[1], '')).toBeNull();
  });
  describe('Tail fiber detection', () => {
    it('identifies tail fiber genes by name, product, or Pfam domains', () => {
      const g1: GeneInfo = {
        id: 1,
        name: 'gp37',
        locusTag: null,
        startPos: 0,
        endPos: 1000,
        strand: '+',
        product: 'long tail fiber protein',
        type: 'CDS',
      };
      expect(isTailFiberCandidate(g1)).toBe(true);

      const g2: GeneInfo = {
        id: 2,
        name: 'rbp',
        locusTag: null,
        startPos: 0,
        endPos: 1000,
        strand: '+',
        product: 'receptor binding protein',
        type: 'CDS',
      };
      expect(isTailFiberCandidate(g2)).toBe(true);

      const g3: GeneInfo = {
        id: 3,
        name: 'orf12',
        locusTag: null,
        startPos: 0,
        endPos: 1000,
        strand: '+',
        product: 'hypothetical protein',
        domains: ['PF09404'], // Tailspike Pfam
        type: 'CDS',
      };
      expect(isTailFiberCandidate(g3)).toBe(true);

      const nonFiber: GeneInfo = {
        id: 4,
        name: 'polA',
        locusTag: null,
        startPos: 0,
        endPos: 1000,
        strand: '+',
        product: 'DNA polymerase I',
        type: 'CDS',
      };
      expect(isTailFiberCandidate(nonFiber)).toBe(false);
    });
  });

  describe('Shannon entropy per-position variability', () => {
    it('returns 0 for completely conserved columns', () => {
      const col = ['A', 'A', 'A', 'A', 'A', 'A', 'A', 'A'];
      expect(calculatePositionEntropy(col)).toBe(0.0);
    });

    it('returns positive entropy for variable alignment columns', () => {
      const col = ['A', 'A', 'S', 'T', 'N', 'D', 'E', 'K'];
      const entropy = calculatePositionEntropy(col);
      expect(entropy).toBeGreaterThan(1.5);
      expect(entropy).toBeLessThanOrEqual(4.32);
    });

    it('generates homolog columns with low entropy at anchor and high entropy at distal tip', () => {
      const testSeq = 'M'.repeat(40) + 'A'.repeat(80) + 'S'.repeat(60);
      const cols = generateFiberHomologColumns(testSeq);
      expect(cols.length).toBe(testSeq.length);

      const anchorCol = cols[10];
      const rbdCol = cols[160];

      const anchorEntropy = calculatePositionEntropy(anchorCol);
      const rbdEntropy = calculatePositionEntropy(rbdCol);

      expect(rbdEntropy).toBeGreaterThan(anchorEntropy);
    });
  });

  describe('Modular domain boundary detection', () => {
    it('segments fiber sequence into N-anchor, shaft, and distal RBD domains', () => {
      const seqLen = 300;
      // Mock smoothed entropy: low at anchor (<1.0), medium at shaft (1.5), high at RBD (>2.5)
      const smoothedEntropy = [
        ...Array(60).fill(0.6),
        ...Array(140).fill(1.5),
        ...Array(100).fill(2.8),
      ];
      const hydropathy = Array(seqLen).fill(0);

      const domains = detectFiberDomainBoundaries(seqLen, smoothedEntropy, hydropathy);
      expect(domains.length).toBe(3);

      expect(domains[0].type).toBe('n_anchor');
      expect(domains[0].startResidue).toBe(1);
      expect(domains[0].endResidue).toBeGreaterThan(20);

      expect(domains[1].type).toBe('shaft');
      expect(domains[1].startResidue).toBe(domains[0].endResidue + 1);

      expect(domains[2].type).toBe('distal_rbd');
      expect(domains[2].startResidue).toBe(domains[1].endResidue + 1);
      expect(domains[2].endResidue).toBe(seqLen);

      // Distal RBD has highest mean entropy
      expect(domains[2].meanEntropy).toBeGreaterThan(domains[0].meanEntropy);
    });
  });

  describe('Residue biophysical metrics & structural risk', () => {
    it('computes SASA, Delta-Delta-G Ala scan, charges, and risk classifications', () => {
      const testSeq = 'MAEKLLNWAKAGYQYNDWGFV';
      const domains = [
        {
          type: 'n_anchor' as const,
          name: 'N-Anchor',
          startResidue: 1,
          endResidue: 5,
          length: 5,
          meanEntropy: 0.5,
          meanSasa: 20,
          meanDdg: 3.5,
          structuralClass: 'Anchor',
          description: 'Baseplate anchor',
        },
        {
          type: 'shaft' as const,
          name: 'Shaft',
          startResidue: 6,
          endResidue: 12,
          length: 7,
          meanEntropy: 1.2,
          meanSasa: 40,
          meanDdg: 2.0,
          structuralClass: 'Shaft',
          description: 'Shaft repeat',
        },
        {
          type: 'distal_rbd' as const,
          name: 'Distal RBD',
          startResidue: 13,
          endResidue: 21,
          length: 9,
          meanEntropy: 2.9,
          meanSasa: 75,
          meanDdg: 1.0,
          structuralClass: 'RBD',
          description: 'Tip',
        },
      ];
      const entropies = [
        0.2, 0.3, 0.4, 0.2, 0.3,
        1.1, 1.2, 1.3, 1.0, 1.2, 1.4, 1.1,
        2.5, 2.7, 3.1, 2.9, 3.2, 2.8, 3.0, 2.9, 2.8,
      ];

      const metrics = calculateResidueEpitopeMetrics(testSeq, domains, entropies);
      expect(metrics.length).toBe(testSeq.length);

      // Check first residue (Methionine in anchor)
      expect(metrics[0].domain).toBe('n_anchor');
      expect(metrics[0].ddgAlaScan).toBeGreaterThan(2.0);

      // Check Lysine at pos 4 (charged)
      expect(metrics[3].charge).toBe(1.0);

      // Check Aspartate at pos 17 (charged negative)
      expect(metrics[16].charge).toBe(-1.0);

      // Check hypervariable residues in RBD
      const rbdMetrics = metrics.filter((m) => m.domain === 'distal_rbd');
      expect(rbdMetrics.some((m) => m.isHypervariableEpitope)).toBe(true);
    });
  });

  describe('Receptor binding scoring & host range inference', () => {
    it('scores canonical bacterial surface receptors', () => {
      const mockPhage = createMockPhage();
      const analysis = analyzeTailFiberStructure(mockPhage, null, null, { demonstration: true });
      expect(analysis).not.toBeNull();
      expect(analysis?.source).toBe('demonstration');
      expect(analysis?.assumptions).toContain('synthetic model outputs');
      expect(analysis!.receptorScores.length).toBe(BACTERIAL_SURFACE_RECEPTORS.length);

      const topReceptor = analysis!.receptorScores[0];
      expect(topReceptor.affinityScore).toBeGreaterThanOrEqual(10);
      expect(topReceptor.affinityScore).toBeLessThanOrEqual(100);
      expect(topReceptor.compatibilityRank).toBe(1);

      // Predicted hosts list
      expect(analysis!.predictedHosts.length).toBeGreaterThan(0);
      expect(analysis!.predictedHosts[0].confidence).toBeGreaterThan(0);
    });
  });

  describe('In-silico point mutation simulation', () => {
    it('computes stability perturbation and clash risk for core mutations vs surface mutations', () => {
      const mockPhage = createMockPhage();
      const analysis = analyzeTailFiberStructure(mockPhage, null, null, { demonstration: true });
      expect(analysis).not.toBeNull();

      // Simulate a bulky mutation (e.g., Trp) at position 1 (anchor core)
      const res1 = simulateResidueMutation(analysis!, 1, 'W');
      expect(res1.position).toBe(1);
      expect(res1.mutant).toBe('W');
      expect(res1.predictedHostImpact).toBeDefined();

      // Simulate a mutation to basic Arginine in RBD (should alter OmpC / LPS affinity)
      const rbdPos = analysis!.domains.find((d) => d.type === 'distal_rbd')?.startResidue ?? 50;
      const resRbd = simulateResidueMutation(analysis!, rbdPos, 'R');
      expect(resRbd.mutant).toBe('R');
      expect(typeof resRbd.affinityDeltas.ompc).toBe('number');
    });
  });

  describe('Modular chimera engineering suggestions', () => {
    it('retains example chimera scenarios in the explicitly selected demonstration', () => {
      const mockPhage = createMockPhage();
      const analysis = analyzeTailFiberStructure(mockPhage, null, null, { demonstration: true });
      expect(analysis).not.toBeNull();

      expect(analysis!.chimeraSuggestions.length).toBeGreaterThan(0);
      const chimera = analysis!.chimeraSuggestions[0];
      expect(chimera.donorPhage).toBeDefined();
      expect(chimera.donorProtein).toBeDefined();
      expect(chimera.junctionResidue).toBeGreaterThan(0);
      expect(chimera.feasibilityScore).toBeGreaterThan(50);
      expect(chimera.targetReceptor).toBeDefined();
      expect(chimera.predictedHost).toBeDefined();
    });
  });

  describe('Phage without tail fiber gene', () => {
    it('returns null safely when phage contains no tail fiber candidates', () => {
      const nonFiberPhage = createMockPhage({
        genes: [
          {
            id: 99,
            name: 'rep',
            locusTag: 'REP_01',
            startPos: 100,
            endPos: 800,
            strand: '+',
            product: 'replication initiator protein',
            type: 'CDS',
          },
        ],
      });
      const analysis = analyzeTailFiberStructure(nonFiberPhage, null, null, { demonstration: true });
      expect(analysis).toBeNull();
    });
  });
});
