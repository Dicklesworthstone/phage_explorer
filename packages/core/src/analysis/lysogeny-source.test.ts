import { describe, expect, it } from 'bun:test';
import { deriveLysogenyCircuitParams, findRegulatoryElements, reconstructLysogenyCircuit } from './lysogeny-circuit';
import type { GeneInfo, PhageFull } from '../types';

const or1 = 'TATCACCGCCAGAGGTA'; // Exact lambda OR1 reference, PMID 2949139.
const promoter = 'TTGACA' + 'A'.repeat(17) + 'TATAAT';
const terminator = 'GGGGGAAACCCCCTTTT';

function gene(overrides: Partial<GeneInfo> = {}): GeneInfo {
  return { id: 1, name: null, locusTag: 'test_1', type: 'CDS', startPos: 0, endPos: 9,
    strand: '+', product: 'hypothetical protein', ...overrides };
}
function phage(overrides: Partial<PhageFull> = {}): PhageFull {
  return { id: 1, slug: 'source-test', name: 'Source test', accession: 'LOCAL_SOURCE_TEST',
    family: null, host: null, genomeLength: 80, gcContent: null, morphology: null,
    lifecycle: null, description: null, baltimoreGroup: null, genomeType: 'dsDNA',
    pdbIds: [], genes: [], codonUsage: null, hasModel: false, ...overrides };
}

describe('regulatory candidates from the actual source sequence', () => {
  it('requires biologically supported spacing and retains the exact oriented interval on each strand', () => {
    // Independent inputs: every integer spacer from 0 through 24, including
    // complete short sequences previously excluded by the old 50-base cutoff.
    for (let spacer = 0; spacer <= 24; spacer++) {
      const observed = 'TTGACA' + 'A'.repeat(spacer) + 'TATAAT';
      const found = findRegulatoryElements(observed).promoters;
      const supported = spacer >= 15 && spacer <= 19;
      expect(found.length).toBe(supported ? 1 : 0);
      if (supported) expect(found[0]).toMatchObject({ position: 0, direction: '+', sequence: observed, strength: null });
    }
    // Explicit reverse-complement fixture, not the scanner's complement helper.
    const reversed = 'NNNN' + 'ATTATA' + 'T'.repeat(17) + 'TGTCAA' + 'NN';
    expect(findRegulatoryElements(reversed).promoters).toEqual([{
      name: 'sigma70_candidate_4_-', position: 4, direction: '-', sequence: promoter,
      sigmaFactor: 'sigma70', strength: null,
    }]);
  });

  it('does not fill ambiguity or a mismatched box with an invented consensus', () => {
    expect(findRegulatoryElements('TTGACA' + 'N'.repeat(17) + 'TATAAT').promoters).toEqual([]);
    expect(findRegulatoryElements('TTGACC' + 'A'.repeat(17) + 'TATAAT').promoters).toEqual([]);
  });

  it('recognizes only the exact cited 17-base operator and does not consume arbitrary flanks', () => {
    const exact = findRegulatoryElements(or1 + 'CCCC').operators;
    expect(exact).toHaveLength(1);
    expect(exact[0]).toMatchObject({ position: 0, sequence: or1, direction: '+',
      bindingAffinityCi: null, bindingAffinityCro: null, boundBy: 'unknown' });
    expect(findRegulatoryElements('NNNNTACCTCTGGCGGTGATA').operators[0])
      .toMatchObject({ position: 4, direction: '-', sequence: or1 });
    for (let index = 0; index < or1.length; index++) {
      const changed = or1.slice(0, index) + (or1[index] === 'A' ? 'C' : 'A') + or1.slice(index + 1);
      expect(findRegulatoryElements(changed).operators).toEqual([]);
    }
  });

  it('requires antiparallel stem complementarity before reporting a hairpin/tail candidate', () => {
    expect(findRegulatoryElements(terminator).terminators[0])
      .toMatchObject({ position: 0, direction: '+', sequence: terminator, efficiency: null });
    expect(findRegulatoryElements('NNNNAAAAGGGGGTTTCCCCC').terminators[0])
      .toMatchObject({ position: 4, direction: '-', sequence: terminator, efficiency: null });
    expect(findRegulatoryElements('GGGGGAAAGGGGGTTTT').terminators).toEqual([]);
  });

  it('returns candidates beyond the old per-family caps or fails without partial results', () => {
    const sequence = [Array(20).fill(promoter).join('N'), Array(12).fill(or1).join('N'),
      Array(10).fill(terminator).join('N')].join('N');
    const observed = findRegulatoryElements(sequence);
    expect(observed.promoters).toHaveLength(20);
    expect(observed.operators).toHaveLength(12);
    expect(observed.terminators).toHaveLength(10);
    expect(() => findRegulatoryElements(Array(10001).fill(or1).join('N'))).toThrow(/10,000.*no partial/);
  });

  it('bounds source work and preserves coordinates rather than stripping invalid characters', () => {
    expect(() => findRegulatoryElements('A'.repeat(5_000_001))).toThrow(/5,000,000/);
    for (const bad of [or1 + '-', or1 + ' ', or1 + '\n']) {
      expect(() => findRegulatoryElements(bad)).toThrow(/without gaps or changed coordinates/);
    }
    expect(findRegulatoryElements(or1.toLowerCase()).operators[0].sequence).toBe(or1);
    expect(findRegulatoryElements('')).toEqual({ promoters: [], operators: [], terminators: [] });
  });
});

describe('annotation hypotheses are separate from observed genomic sites', () => {
  it('never manufactures sites from CI/Cro labels, including when a real sequence has no matches', () => {
    const selected = phage({ genes: [gene({ name: 'cI' }), gene({ id: 2, name: 'cro' })] });
    const annotations = reconstructLysogenyCircuit(selected);
    expect(annotations.architecture).toBe('lambda-like');
    expect(annotations.sequenceStatus).toBe('not-supplied');
    expect(annotations.sequenceLength).toBeNull();
    const scanned = reconstructLysogenyCircuit(selected, 'A'.repeat(80));
    expect(scanned.sequenceStatus).toBe('scanned');
    expect(scanned.sequenceLength).toBe(80);
    for (const circuit of [annotations, scanned]) {
      expect(circuit.promoters).toEqual([]);
      expect(circuit.operators).toEqual([]);
      expect(circuit.terminators).toEqual([]);
      expect(circuit.confidence).toBeNull();
      expect(circuit.summary).toContain('hypothesis');
      expect(circuit.limitations.join(' ')).toMatch(/No match does not exclude/);
    }
    expect(() => reconstructLysogenyCircuit(selected, 'A'.repeat(79))).toThrow(/complete selected genome/);
  });

  it('uses specific CDS role tokens without CIII/CII, Cro/CI or internal/int substring collisions', () => {
    const selected = phage({ genes: [
      gene({ id: 1, name: 'cIII', product: 'CIII protein' }),
      gene({ id: 2, name: 'cro', product: 'Cro repressor' }),
      gene({ id: 3, name: 'paint', product: 'internal virion protein' }),
      gene({ id: 4, name: 'micro', product: 'microbial protein' }),
      gene({ id: 5, name: 'antirepressor', product: 'antirepressor protein' }),
      gene({ id: 6, name: 'ci', type: 'gene' }),
      gene({ id: 7, name: 'generic', domains: ['PF01381', 'PF00589'] }),
    ] });
    const circuit = reconstructLysogenyCircuit(selected);
    expect(circuit.genes.cIII?.id).toBe(1);
    expect(circuit.genes.cro?.id).toBe(2);
    expect(circuit.genes.cII).toBeUndefined();
    expect(circuit.genes.ci).toBeUndefined();
    expect(circuit.genes.integrase).toBeUndefined();
    expect(circuit.architecture).toBe('unknown');
    const explicit = reconstructLysogenyCircuit(phage({ genes: [
      gene({ name: 'cII', product: 'transcriptional activator cII' }),
      gene({ id: 2, name: 'int', product: 'integrase' }),
    ] }));
    expect(explicit.genes.cII?.name).toBe('cII');
    expect(explicit.genes.integrase?.name).toBe('int');
    expect(explicit.architecture).toBe('temperate');
  });

  it('never treats a familiar name, missing genes or a lytic phase as proof of obligate lysis', () => {
    const unknown = phage({ name: 'T4-like isolate', genes: Array.from({ length: 15 }, (_, id) => gene({ id })) });
    for (const selected of [unknown, { ...unknown, lifecycle: 'lytic' }]) {
      expect(reconstructLysogenyCircuit(selected).architecture).toBe('unknown');
      expect(deriveLysogenyCircuitParams(selected)).toEqual({});
    }
    const declared = reconstructLysogenyCircuit({ ...unknown, lifecycle: 'virulent' });
    expect(declared.architecture).toBe('obligately-lytic');
    expect(declared.summary).toContain('Supplied lifecycle metadata');
    const conflict = reconstructLysogenyCircuit({ ...unknown, lifecycle: 'virulent', genes: [gene({ name: 'cI' })] });
    expect(conflict.architecture).toBe('unknown');
    expect(conflict.summary).toContain('conflicts');
  });
});
