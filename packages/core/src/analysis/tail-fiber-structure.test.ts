import proteinReferenceSnapshot from '../../../../data/protein-references/lambda-lamb-v1.json';
import { parseProteinReferenceBundle, proteinReferenceContentHash, type ProteinReferenceBundle } from '../protein-reference';
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../analysis-result';
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
  PROTEIN_STRUCTURE_METHOD, PROTEIN_STRUCTURE_LIMITS,
  resolveProteinStructureOptions, createProteinStructureExperiment, replayProteinStructureExperiment,
  proteinStructureResultFromRecord, exportProteinStructureTsv, type ProteinStructureOptions,
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

/** These analytic controls replace coordinates explicitly. They are mathematical
 * fixtures, not biological measurements or newly sourced structures.
 */
async function structureFixture(edit: (reference: ProteinReferenceBundle) => void = () => {}): Promise<ProteinReferenceBundle> {
  const reference = structuredClone(proteinReferenceSnapshot) as ProteinReferenceBundle;
  const chain = reference.chains[0], host = reference.chains[1];
  reference.id = 'synthetic-3-4-5-geometry-control';
  chain.coordinates = [1, 4, 7].map((labelSeqId, index) => ({
    labelSeqId, authSeqId: index === 0 ? -4 : index + 6, insertionCode: index === 0 ? 'A' : '',
    aminoAcid: chain.sequence[labelSeqId - 1], x: index * 3, y: index * 4, z: 0,
  }));
  host.coordinates = [1, 4].map((labelSeqId, index) => ({
    labelSeqId, authSeqId: index + 100, insertionCode: '', aminoAcid: host.sequence[labelSeqId - 1],
    x: index * 100, y: index * 100, z: index === 0 ? 5 : 100,
  }));
  edit(reference);
  const { bundleSha256: _oldHash, ...payload } = reference;
  reference.bundleSha256 = await proteinReferenceContentHash(payload);
  return reference;
}
async function changedStructureReference(edit: (reference: ProteinReferenceBundle) => void): Promise<ProteinReferenceBundle> {
  const reference = structuredClone(proteinReferenceSnapshot) as ProteinReferenceBundle;
  edit(reference);
  const { bundleSha256: _oldHash, ...payload } = reference;
  reference.bundleSha256 = await proteinReferenceContentHash(payload);
  return reference;
}
function renamedProtein(reference: ProteinReferenceBundle, oldId: string, newId: string): void {
  for (const protein of reference.proteins) if (protein.id === oldId) protein.id = newId;
  for (const chain of reference.chains) if (chain.proteinId === oldId) chain.proteinId = newId;
  for (const row of reference.alignment.rows) if (row.proteinId === oldId) row.proteinId = newId;
  for (const embedding of reference.embeddings) if (embedding.proteinId === oldId) embedding.proteinId = newId;
  if (reference.cds.proteinId === oldId) reference.cds.proteinId = newId;
  if (reference.evidence.phageProteinId === oldId) reference.evidence.phageProteinId = newId;
  if (reference.evidence.hostProteinId === oldId) reference.evidence.hostProteinId = newId;
  for (const interaction of reference.domainInteractions) {
    if (interaction.phageProteinId === oldId) interaction.phageProteinId = newId;
    if (interaction.hostProteinId === oldId) interaction.hostProteinId = newId;
  }
}
async function rehashedStructureRecord(record: AnalysisRecord): Promise<AnalysisRecord> {
  return createAnalysisRecord({ method: record.method, seed: record.seed,
    parameters: record.parameters, references: record.references, fields: record.fields,
    inputs: record.inputs.map(({ sha256: _oldHash, ...input }) => input) });
}

describe('Mapped reference protein evidence, independent of illustrative structural scores', () => {
  it('retains full real protein coverage and exact alignment columns without synthetic homologs', async () => {
    const experiment = await createProteinStructureExperiment(proteinReferenceSnapshot);
    const { result, record, reference, options } = experiment;
    expect(options).toEqual({ proteinId: 'lambda-j', chainLabelAsymId: 'D', contactScope: 'assembly',
      contactCutoffAngstrom: 8, minSequenceSeparation: 3 });
    expect(result.protein).toEqual({ id: 'lambda-j', accession: 'P03749', length: 1132 });
    expect(result.residues).toHaveLength(1132);
    expect(result.coverage).toEqual({ proteinResidues: 1132, alignmentResidues: 1132, entropyResidues: 1096,
      insufficientAlignmentResidues: 36, coordinateResidues: 420, unmappedResidues: 712, intrachainContacts: 958, interchainContacts: 0 });
    // Independently enumerated raw two-row columns: M/M at column 5,
    // S/K at column 14 and P/gap at column 42. H=0,1,unavailable respectively.
    expect(result.residues[0].alignment).toEqual({ column: 5, observed: 2, total: 2, gaps: 0, entropyBits: 0 });
    expect(result.residues[5].alignment).toEqual({ column: 14, observed: 2, total: 2, gaps: 0, entropyBits: 1 });
    expect(result.residues[33].alignment).toEqual({ column: 42, observed: 1, total: 2, gaps: 1, entropyBits: null });
    expect(result.residues.filter(row => row.alignment?.entropyBits === 0)).toHaveLength(374);
    expect(result.residues.filter(row => row.alignment?.entropyBits === 1)).toHaveLength(722);
    expect(result.residues[711].coordinate).toBeNull();
    expect(result.residues[712].coordinate).toEqual(reference.chains[0].coordinates[0]);
    expect(result.residues[1131].coordinate?.labelSeqId).toBe(420);
    expect(result.contacts[0]).toMatchObject({ kind: 'intrachain', query: { proteinPosition: 713, labelSeqId: 1, authSeqId: 713, labelAsymId: 'D', authAsymId: 'Z' },
      partner: { proteinPosition: 795 } });
    expect(result.contacts[0].distanceAngstrom).toBeCloseTo(5.831259040721811, 12);
    const closest = [...result.contacts].sort((a, b) => a.distanceAngstrom - b.distanceAngstrom)[0];
    expect([closest.query.proteinPosition, closest.partner.proteinPosition]).toEqual([1103, 1110]);
    expect(closest.distanceAngstrom).toBeCloseTo(3.8222645120399497, 12);
    expect(record.method).toEqual(PROTEIN_STRUCTURE_METHOD);
    expect(record.inputs).toHaveLength(1);
    expect(record.inputs[0]).toMatchObject({ id: 'reference', source: 'external', accession: 'P03749', data: reference });
    expect(record.fields.structure.kind).toBe('sequence-score');
    expect(JSON.stringify(result)).not.toMatch(/"sasa"|"ddg"|"affinityScore"|"predictedHosts"/);
  });

  it('computes three-row Shannon entropy from observed counts and excludes gaps from the denominator', async () => {
    const reference = await structureFixture(bundle => {
      const homolog = structuredClone(bundle.proteins[2]);
      homolog.id = 'synthetic-duplicate-homolog-control';
      bundle.proteins.push(homolog);
      bundle.alignment.rows.push({ proteinId: homolog.id, alignedSequence: bundle.alignment.rows[1].alignedSequence });
    });
    const { result } = await createProteinStructureExperiment(reference, { chainLabelAsymId: null });
    // S,K,K gives -(1/3)log2(1/3)-(2/3)log2(2/3); P,gap,gap
    // is still only one observation and must never become a low entropy score.
    expect(result.residues[5].alignment).toMatchObject({ observed: 3, total: 3, gaps: 0 });
    expect(result.residues[5].alignment!.entropyBits).toBeCloseTo(0.9182958340544896, 14);
    expect(result.residues[33].alignment).toEqual({ column: 42, observed: 1, total: 3, gaps: 2, entropyBits: null });
  });

  it('finds the independently checked one retained interchain pair at 15 Angstroms', async () => {
    const { result } = await createProteinStructureExperiment(proteinReferenceSnapshot, { contactCutoffAngstrom: 15 });
    expect(result.coverage.intrachainContacts).toBe(6622);
    const cross = result.contacts.filter(contact => contact.kind === 'interchain');
    expect(cross).toHaveLength(1);
    expect([cross[0].query.proteinPosition, cross[0].partner.proteinPosition]).toEqual([1050, 101]);
    expect(cross[0].distanceAngstrom).toBeCloseTo(14.8488165858428, 12);
    expect(cross[0].partner).toMatchObject({ proteinId: 'shigella-lamb', labelAsymId: 'A', authAsymId: 'A' });
    expect(result.residues.reduce((sum, row) => sum + (row.interchainNeighbors ?? 0), 0)).toBe(1);
  });

  it('uses inclusive 3-4-5 distances, unordered within-chain pairs and distinct source numbering', async () => {
    const fixture = await structureFixture();
    const { result } = await createProteinStructureExperiment(fixture, { contactCutoffAngstrom: 5 });
    expect(result.coverage.coordinateResidues).toBe(3);
    expect(result.coverage.unmappedResidues).toBe(1129);
    expect(result.contacts.map(pair => [pair.kind, pair.query.proteinPosition, pair.partner.proteinPosition, pair.distanceAngstrom])).toEqual([
      ['intrachain', 713, 716, 5], ['interchain', 713, 25, 5], ['intrachain', 716, 719, 5],
    ]);
    expect(result.contacts[0].query).toMatchObject({ labelSeqId: 1, proteinPosition: 713, authSeqId: -4, insertionCode: 'A' });
    expect(result.residues.filter(row => row.coordinate).map(row => [row.intrachainNeighbors, row.interchainNeighbors, row.comparedResidues, row.nearestNonlocalDistanceAngstrom]))
      .toEqual([[1, 1, 4, 5], [2, 0, 4, 5], [1, 0, 4, 5]]);
    expect(result.residues[713].intrachainNeighbors).toBeNull();
    expect(result.residues[713].nearestNonlocalDistanceAngstrom).toBeNull();
    const justBelow = await createProteinStructureExperiment(fixture, { contactCutoffAngstrom: 4.999 });
    expect(justBelow.result.contacts).toHaveLength(0);
    expect(justBelow.result.residues[712].nearestNonlocalDistanceAngstrom).toBe(5);
  });

  it('applies separation only within chains and distinguishes unexamined cross-chain geometry', async () => {
    const fixture = await structureFixture();
    const distant = await createProteinStructureExperiment(fixture, { minSequenceSeparation: 4, contactCutoffAngstrom: 5 });
    expect(distant.result.contacts.map(contact => contact.kind)).toEqual(['interchain']);
    const chainOnly = await createProteinStructureExperiment(fixture, { contactScope: 'chain', contactCutoffAngstrom: 5 });
    expect(chainOnly.result.contacts).toHaveLength(2);
    expect(chainOnly.result.residues.filter(row => row.coordinate).map(row => row.interchainNeighbors)).toEqual([null, null, null]);
    expect(chainOnly.result.residues[712].comparedResidues).toBe(2);
    expect(chainOnly.result.limitations.join(' ')).toContain('does not mean other chains were compared');
    const noneEligible = await createProteinStructureExperiment(fixture, { contactScope: 'chain', minSequenceSeparation: 10000 });
    expect(noneEligible.result.residues[712]).toMatchObject({ comparedResidues: 0, intrachainNeighbors: 0, nearestNonlocalDistanceAngstrom: null });
  });

  it('keeps absent structure and absent alignment unavailable without losing real sequence length', async () => {
    const aligned = await createProteinStructureExperiment(proteinReferenceSnapshot, { chainLabelAsymId: null });
    expect(aligned.result.chain).toBeNull();
    expect(aligned.result.contacts).toEqual([]);
    expect(aligned.result.coverage).toMatchObject({ coordinateResidues: 0, unmappedResidues: 1132, entropyResidues: 1096 });
    expect(aligned.result.residues.every(row => row.coordinate === null && row.intrachainNeighbors === null && row.interchainNeighbors === null)).toBe(true);
    const receptor = await createProteinStructureExperiment(proteinReferenceSnapshot, { proteinId: 'shigella-lamb', contactScope: 'chain' });
    expect(receptor.result.protein.length).toBe(446);
    expect(receptor.result.alignment.targetPresent).toBe(false);
    expect(receptor.result.residues.every(row => row.alignment === null)).toBe(true);
    expect(receptor.result.coverage.entropyResidues).toBe(0);
    const homolog = await createProteinStructureExperiment(proteinReferenceSnapshot, { proteinId: 'secphi27-j' });
    expect(homolog.result.protein.length).toBe(1192);
    expect(homolog.result.chain).toBeNull();
    expect(homolog.result.coverage.coordinateResidues).toBe(0);
  });

  it('requires an explicit chain choice when several structural copies map to one protein', async () => {
    const reference = await changedStructureReference(bundle => {
      bundle.chains.push({ ...structuredClone(bundle.chains[0]), labelAsymId: 'E', authAsymId: 'Y' });
    });
    await expect(createProteinStructureExperiment(reference)).rejects.toThrow('Several mapped chains');
    const experiment = await createProteinStructureExperiment(reference, { chainLabelAsymId: 'E', contactScope: 'chain' });
    expect(experiment.result.chain?.labelAsymId).toBe('E');
    expect(experiment.result.coverage.intrachainContacts).toBe(958);
    await expect(createProteinStructureExperiment(reference, { chainLabelAsymId: 'A' })).rejects.toThrow('selected source protein');
  });

  it('snapshots asynchronous inputs and returns independent extracted records', async () => {
    const reference = await structureFixture(), options: ProteinStructureOptions = { contactCutoffAngstrom: 5 };
    const pending = createProteinStructureExperiment(reference, options);
    reference.chains[0].coordinates[0].x = 900;
    options.contactCutoffAngstrom = 1;
    const experiment = await pending;
    expect(experiment.options.contactCutoffAngstrom).toBe(5);
    expect(experiment.reference.chains[0].coordinates[0].x).toBe(0);
    expect(experiment.result.contacts).toHaveLength(3);
    const extracted = proteinStructureResultFromRecord(experiment.record);
    extracted.residues[0].aminoAcid = 'W';
    expect(proteinStructureResultFromRecord(experiment.record).residues[0].aminoAcid).toBe('M');
  });

  it('replays complete portable records and rejects recalculated checksums over forged evidence', async () => {
    const original = await createProteinStructureExperiment(await structureFixture(), { contactCutoffAngstrom: 5 });
    const serialized = serializeAnalysisRecord(original.record);
    const replayed = await replayProteinStructureExperiment(serialized);
    expect(serializeAnalysisRecord(replayed.record)).toBe(serialized);
    expect(replayed.result).toEqual(original.result);
    const forged = structuredClone(original.record);
    const result = proteinStructureResultFromRecord(forged);
    result.contacts[0].distanceAngstrom = 0.125;
    forged.fields.structure.value = analysisJson(result);
    const validHashes = await rehashedStructureRecord(forged);
    await expect(parseAnalysisRecord(serializeAnalysisRecord(validHashes))).resolves.toBeDefined();
    await expect(replayProteinStructureExperiment(serializeAnalysisRecord(validHashes))).rejects.toThrow('Fresh protein structure');
    const relabeled = structuredClone(original.record);
    relabeled.fields.structure.limitations = ['Unjustified replacement claim.'];
    await expect(replayProteinStructureExperiment(serializeAnalysisRecord(await rehashedStructureRecord(relabeled)))).rejects.toThrow('Fresh protein structure');
    const changedSource = structuredClone(original.record);
    changedSource.inputs[0].source = 'catalog';
    await expect(replayProteinStructureExperiment(serializeAnalysisRecord(await rehashedStructureRecord(changedSource)))).rejects.toThrow('source evidence differs');
  });

  it('requires method, seed and complete effective settings during fresh replay', async () => {
    const original = await createProteinStructureExperiment(await structureFixture());
    const method = structuredClone(original.record);
    method.method.implementation += ' changed';
    await expect(replayProteinStructureExperiment(serializeAnalysisRecord(await rehashedStructureRecord(method)))).rejects.toThrow('contract differs');
    const seed = structuredClone(original.record);
    seed.seed = 1;
    await expect(replayProteinStructureExperiment(serializeAnalysisRecord(await rehashedStructureRecord(seed)))).rejects.toThrow('contract differs');
    const omitted = structuredClone(original.record);
    omitted.parameters = { proteinId: original.options.proteinId };
    await expect(replayProteinStructureExperiment(serializeAnalysisRecord(await rehashedStructureRecord(omitted)))).rejects.toThrow('settings must be explicit');
  });

  it('changes identity for coordinates, source attribution and effective settings even when contacts are unchanged', async () => {
    const initial = await createProteinStructureExperiment(await structureFixture(), { contactCutoffAngstrom: 5 });
    const changedCoordinate = await createProteinStructureExperiment(await structureFixture(reference => { reference.chains[1].coordinates[1].x++; }), { contactCutoffAngstrom: 5 });
    const changedSource = await createProteinStructureExperiment(await structureFixture(reference => { reference.sources[0].version += '-metadata'; }), { contactCutoffAngstrom: 5 });
    const changedOption = await createProteinStructureExperiment(initial.reference, { contactCutoffAngstrom: 5.001 });
    expect(changedCoordinate.result.contacts).toEqual(initial.result.contacts);
    expect(changedSource.result.contacts).toEqual(initial.result.contacts);
    expect(changedOption.result.contacts).toEqual(initial.result.contacts);
    for (const changed of [changedCoordinate, changedSource, changedOption]) expect(changed.record.cacheKey).not.toBe(initial.record.cacheKey);
  });

  it('exports complete residue/contact tables with unavailable cells, distinct numbering and inert text', async () => {
    const reference = await structureFixture(bundle => {
      renamedProtein(bundle, bundle.cds.proteinId, '=synthetic-query');
      bundle.chains[0].authAsymId = '-author-chain';
    });
    const { record, result } = await createProteinStructureExperiment(reference, { contactCutoffAngstrom: 5 });
    const residues = exportProteinStructureTsv(record, 'residues');
    const contacts = exportProteinStructureTsv(record, 'contacts');
    expect(residues).toContain('including negative numbers');
    expect(residues).toContain('source_attribution=');
    expect(residues).not.toContain(reference.proteins[0].sequence);
    const residueRows = residues.split('\n').filter(line => line && !line.startsWith('#'));
    expect(residueRows).toHaveLength(1133);
    const row = residueRows[713].split('\t');
    expect([row[0], row[7], row[8], row[9]]).toEqual(['713', '1', '-4', 'A']);
    expect(residueRows[714].split('\t').slice(7)).toEqual(Array(10).fill(''));
    const contactRows = contacts.split('\n').filter(line => line && !line.startsWith('#'));
    expect(contactRows).toHaveLength(result.contacts.length + 1);
    expect(contactRows[1].split('\t')[1]).toBe("'=synthetic-query");
    expect(contactRows[1].split('\t')[3]).toBe("'-author-chain");
    expect(contactRows[1].split('\t')[6]).toBe('-4');
    expect(() => exportProteinStructureTsv(record, 'unknown' as 'residues')).toThrow('Choose residues or contacts');
  });

  it('refuses invalid, unknown and excessive settings before accepting an experiment', async () => {
    const reference = await parseProteinReferenceBundle(proteinReferenceSnapshot);
    for (const options of [{ contactCutoffAngstrom: 0 }, { contactCutoffAngstrom: NaN }, { contactCutoffAngstrom: 30.01 },
      { minSequenceSeparation: 0 }, { minSequenceSeparation: 1.5 }, { minSequenceSeparation: 10001 },
      { proteinId: 'missing' }, { chainLabelAsymId: 'Z' }, { contactScope: 'other' }, { obsolete: undefined }]) {
      expect(() => resolveProteinStructureOptions(reference, options as ProteinStructureOptions)).toThrow();
      await expect(createProteinStructureExperiment(reference, options as ProteinStructureOptions)).rejects.toThrow();
    }
    await expect(createProteinStructureExperiment(null)).rejects.toThrow('Invalid protein reference');
    await expect(createProteinStructureExperiment({ description: 'x'.repeat(PROTEIN_STRUCTURE_LIMITS.referenceBytes + 1) })).rejects.toThrow('limit');
  });

  it('refuses large results without silently truncating or fabricating an empty contact list', async () => {
    // Independent full distance matrix at 30 A contains 22,403 intrachain and
    // 605 interchain pairs: this deliberately exceeds the 20,000 contact cap.
    await expect(createProteinStructureExperiment(proteinReferenceSnapshot, { contactCutoffAngstrom: 30 })).rejects.toThrow('20,000 contacts');
    const longIds = await changedStructureReference(reference => renamedProtein(reference, reference.cds.proteinId, 'protein-' + 'x'.repeat(8192)));
    await expect(parseProteinReferenceBundle(longIds)).resolves.toBeDefined();
    await expect(createProteinStructureExperiment(longIds)).rejects.toThrow('10240 KiB');
    const overflow = await structureFixture(reference => {
      reference.chains[0].coordinates[0].x = 1e308;
      reference.chains[0].coordinates[1].x = -1e308;
    });
    await expect(createProteinStructureExperiment(overflow)).rejects.toThrow('nonfinite C-alpha');
  });

  it('cancels before work and during asynchronous reference validation', async () => {
    const stopped = new AbortController();
    stopped.abort();
    await expect(createProteinStructureExperiment(proteinReferenceSnapshot, {}, stopped.signal)).rejects.toThrow('cancelled');
    const pending = new AbortController();
    const work = createProteinStructureExperiment(proteinReferenceSnapshot, {}, pending.signal);
    pending.abort();
    await expect(work).rejects.toThrow('cancelled');
    await expect(replayProteinStructureExperiment('{}', stopped.signal)).rejects.toThrow('cancelled');
  });
});
